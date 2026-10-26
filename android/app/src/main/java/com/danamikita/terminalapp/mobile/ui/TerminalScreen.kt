@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.danamikita.terminalapp.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.ui.text.TextRange
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
    val focusRequester = remember { FocusRequester() }
    var terminalView by remember { mutableStateOf<TerminalCanvasView?>(null) }
    var fieldValue by remember { mutableStateOf(TextFieldValue(SENTINEL, TextRange(1))) }

    fun sendInput(text: String) {
        if (text.isEmpty()) return
        scope.launch { runCatching { client.sendInput(sessionId, text) } }
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

    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    Scaffold(topBar = { TopAppBar(title = { Text(sessionName) }) }) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            AndroidView(
                modifier = Modifier.fillMaxSize().weight(1f),
                factory = { context -> TerminalCanvasView(context).also { terminalView = it } },
            )

            // Invisible capture field: keeps the soft keyboard up and turns
            // typed text into bytes sent to the remote session. See SENTINEL
            // above for why it's never really empty.
            BasicTextField(
                value = fieldValue,
                onValueChange = { new ->
                    val old = fieldValue.text
                    when {
                        new.text.length > old.length && new.text.startsWith(old) ->
                            sendInput(new.text.removePrefix(old))
                        new.text.length < SENTINEL.length ->
                            sendInput("") // backspace past the sentinel -> DEL
                        else ->
                            sendInput(new.text) // pasted/replaced content — forward as-is
                    }
                    fieldValue = TextFieldValue(SENTINEL, TextRange(SENTINEL.length))
                },
                modifier = Modifier.size(1.dp).focusRequester(focusRequester),
            )

            Row(modifier = Modifier.fillMaxWidth().padding(4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                QuickKeyButton("Esc", modifier = Modifier.weight(1f)) { sendInput("") }
                QuickKeyButton("Tab", modifier = Modifier.weight(1f)) { sendInput("\t") }
                QuickKeyButton("Ctrl+C", modifier = Modifier.weight(1f)) { sendInput(ctrl('C')) }
                QuickKeyButton("Ctrl+D", modifier = Modifier.weight(1f)) { sendInput(ctrl('D')) }
            }
            Row(modifier = Modifier.fillMaxWidth().padding(4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                QuickKeyButton("↑", modifier = Modifier.weight(1f)) { sendInput("[A") }
                QuickKeyButton("↓", modifier = Modifier.weight(1f)) { sendInput("[B") }
                QuickKeyButton("←", modifier = Modifier.weight(1f)) { sendInput("[D") }
                QuickKeyButton("→", modifier = Modifier.weight(1f)) { sendInput("[C") }
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
