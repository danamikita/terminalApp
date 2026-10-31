@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.danamikita.terminalapp.mobile.ui

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.danamikita.terminalapp.mobile.network.DriverClient
import com.danamikita.terminalapp.mobile.network.UnauthorizedException
import com.danamikita.terminalapp.mobile.terminal.NoopTerminalSessionClient
import com.danamikita.terminalapp.mobile.terminal.RemoteTerminalOutput
import com.danamikita.terminalapp.mobile.terminal.TerminalCanvasView
import com.termux.terminal.TerminalEmulator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

// A single placeholder character the soft-keyboard field always resets to
// after each change, so Backspace has something to delete (without it, an
// always-empty field never fires a change event on Backspace, since there's
// nothing there to remove) — this "sentinel" is never itself sent anywhere.
private const val SENTINEL = "⁣"

private fun ctrl(c: Char): String = (c.code and 0x1f).toChar().toString()

@Composable
fun TerminalScreen(
    client: DriverClient,
    sessionId: String,
    sessionName: String,
    onUnauthorized: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val focusRequester = remember { FocusRequester() }
    var terminalView by remember { mutableStateOf<TerminalCanvasView?>(null) }
    var fieldValue by remember { mutableStateOf(TextFieldValue(SENTINEL, TextRange(1))) }
    var lastRawValue by remember { mutableStateOf(SENTINEL) }

    fun sendInput(text: String) {
        if (text.isEmpty()) return
        terminalView?.scrollToBottom()
        scope.launch { runCatching { client.sendInput(sessionId, text) } }
    }

    // A dedicated button rather than hooking into the invisible capture
    // field's paste handling below: Compose's legacy BasicTextField (the
    // TextFieldValue/onValueChange overload used there) doesn't surface
    // keyboard- or clipboard-originated rich content (images) to
    // onValueChange at all -- only the newer TextFieldState-based API wires
    // that up, and migrating would risk the paste-dedup fix just above it.
    // Reading ClipboardManager directly here works today, for any image a
    // user has copied (screenshot, share-to-copy, etc.), regardless of
    // keyboard.
    fun pasteImageFromClipboard() {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = clipboard.primaryClip ?: return
        if (clip.itemCount == 0 || !clip.description.hasMimeType("image/*")) return
        val uri = clip.getItemAt(0).uri ?: return
        val ext = (clip.description.getMimeType(0) ?: "image/png").substringAfter('/', "png")
        scope.launch {
            val bytes = runCatching {
                context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            }.getOrNull() ?: return@launch
            runCatching { client.pasteImage(sessionId, bytes, ext) }
        }
    }

    DisposableEffect(sessionId) {
        var cancelled = false
        var activeCall: okhttp3.Call? = null
        val output = RemoteTerminalOutput(onInput = { data, offset, count ->
            sendInput(String(data, offset, count, Charsets.UTF_8))
        })

        val job = scope.launch(Dispatchers.IO) {
            val view = awaitView(terminalView) { terminalView }
            try {
                val initial = client.getBuffer(sessionId)
                val cols = view.columnsForWidth(view.width)
                val rows = view.rowsForHeight(view.height)
                val emu = TerminalEmulator(output, cols, rows, view.fontWidth.toInt(), view.fontLineSpacing, 2000, NoopTerminalSessionClient())
                emu.append(initial.toByteArray(Charsets.UTF_8), initial.toByteArray(Charsets.UTF_8).size)
                view.post { view.emulator = emu }
                scope.launch { runCatching { client.resize(sessionId, cols, rows) } }

                client.streamSession(
                    sessionId,
                    onCallCreated = { call -> activeCall = call; if (cancelled) call.cancel() },
                ) { chunk ->
                    if (cancelled) return@streamSession
                    val bytes = chunk.toByteArray(Charsets.UTF_8)
                    emu.append(bytes, bytes.size)
                    view.post { view.invalidate() }
                }
            } catch (e: UnauthorizedException) {
                if (!cancelled) scope.launch(Dispatchers.Main) { onUnauthorized() }
            } catch (e: Exception) {
                // stream ended (session exited, network drop, or we cancelled it) — nothing more to do
            }
        }

        onDispose {
            cancelled = true
            activeCall?.cancel()
            job.cancel()
        }
    }

    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
        keyboardController?.show()
    }

    // Physical keyboards (Chromebooks, Bluetooth keyboards) send Tab/Esc/
    // arrows/Ctrl+C/D as real key events rather than IME text composition,
    // so the capture field's text-diffing onValueChange below never sees
    // them -- Tab in particular would otherwise just move Compose focus off
    // the field instead of reaching the remote session. Mirrors the same
    // escape sequences the quick-key buttons send, so hardware and on-screen
    // input agree.
    fun handleHardwareKey(event: KeyEvent): Boolean {
        if (event.type != KeyEventType.KeyDown) return false
        return when {
            event.key == Key.Tab -> { sendInput("\t"); true }
            event.key == Key.Escape -> { sendInput("\u001b"); true }
            event.key == Key.DirectionUp -> { sendInput("\u001b[A"); true }
            event.key == Key.DirectionDown -> { sendInput("\u001b[B"); true }
            event.key == Key.DirectionLeft -> { sendInput("\u001b[D"); true }
            event.key == Key.DirectionRight -> { sendInput("\u001b[C"); true }
            event.isCtrlPressed && event.key == Key.C -> { sendInput(ctrl('C')); true }
            event.isCtrlPressed && event.key == Key.D -> { sendInput(ctrl('D')); true }
            else -> false
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text(sessionName) }) }) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            AndroidView(
                modifier = Modifier.fillMaxSize().weight(1f),
                factory = { context ->
                    TerminalCanvasView(context).also {
                        terminalView = it
                        // The capture field below is invisible (1.dp) and never where the
                        // user actually taps, so a tap here must re-request focus itself to
                        // bring the keyboard back after it's been dismissed (e.g. back
                        // button, or the system hiding it) — focus alone doesn't always
                        // reopen an already-dismissed IME, hence the explicit show() too.
                        // Handled as a tap callback from the view's own gesture detector
                        // (rather than Compose's clickable) since the view also needs to
                        // recognize vertical drags as scrollback, and the two gesture
                        // systems would otherwise compete for the same touch stream.
                        it.onTap = {
                            focusRequester.requestFocus()
                            keyboardController?.show()
                        }
                    }
                },
            )

            // Invisible capture field: keeps the soft keyboard up and turns
            // typed text into bytes sent to the remote session. See SENTINEL
            // above for why it's never really empty.
            BasicTextField(
                value = fieldValue,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
                onValueChange = onChange@{ new ->
                    val old = fieldValue.text
                    when {
                        new.text.length > old.length && new.text.startsWith(old) ->
                            sendInput(new.text.removePrefix(old).replace("\n", "\r"))
                        new.text.length < SENTINEL.length ->
                            sendInput("\u007f") // backspace past the sentinel -> DEL
                        else -> {
                            // After a paste, some IMEs replay the exact same pre-reset value
                            // (sentinel + pasted text) in a second onValueChange before their
                            // native buffer has caught up with our reset below — without this
                            // guard that replay reads as a brand-new paste and gets sent twice.
                            // Scoped to this branch only: applied globally it also caught
                            // consecutive Backspace presses, which legitimately produce the
                            // same post-reset "" value every time, and silently dropped every
                            // one after the first since lastRawValue was never resynced to
                            // SENTINEL alongside the fieldValue reset below.
                            if (new.text == lastRawValue) return@onChange
                            lastRawValue = new.text
                            sendInput(new.text.replace("\n", "\r")) // pasted/replaced content — forward as-is
                        }
                    }
                    fieldValue = TextFieldValue(SENTINEL, TextRange(SENTINEL.length))
                },
                modifier = Modifier.size(1.dp).focusRequester(focusRequester).onPreviewKeyEvent(::handleHardwareKey),
            )

            Row(modifier = Modifier.fillMaxWidth().padding(4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                QuickKeyButton("Esc", modifier = Modifier.weight(1f)) { sendInput("\u001b") }
                QuickKeyButton("Tab", modifier = Modifier.weight(1f)) { sendInput("\t") }
                QuickKeyButton("Ctrl+C", modifier = Modifier.weight(1f)) { sendInput(ctrl('C')) }
                QuickKeyButton("Ctrl+D", modifier = Modifier.weight(1f)) { sendInput(ctrl('D')) }
            }
            Row(modifier = Modifier.fillMaxWidth().padding(4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                QuickKeyButton("↑", modifier = Modifier.weight(1f)) { sendInput("\u001b[A") }
                QuickKeyButton("↓", modifier = Modifier.weight(1f)) { sendInput("\u001b[B") }
                QuickKeyButton("←", modifier = Modifier.weight(1f)) { sendInput("\u001b[D") }
                QuickKeyButton("→", modifier = Modifier.weight(1f)) { sendInput("\u001b[C") }
            }
            Row(modifier = Modifier.fillMaxWidth().padding(4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                QuickKeyButton("Paste Image", modifier = Modifier.weight(1f)) { pasteImageFromClipboard() }
            }
        }
    }
}

@Composable
private fun QuickKeyButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(onClick = onClick, modifier = modifier.height(44.dp)) { Text(label, style = MaterialTheme.typography.labelSmall) }
}

private suspend fun awaitView(initial: TerminalCanvasView?, get: () -> TerminalCanvasView?): TerminalCanvasView {
    var view = initial ?: get()
    while (view == null || view.width == 0) {
        kotlinx.coroutines.delay(16)
        view = get()
    }
    return view
}
