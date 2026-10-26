package com.danamikita.terminalapp.mobile.terminal

import com.termux.terminal.TerminalOutput

/**
 * Bridges TerminalEmulator's output callback to wherever this app actually
 * sends input (an HTTP POST to /session/:id/input) — unlike termux-app's own
 * TerminalSession, there's no local PTY on the other end of `write()`.
 */
class RemoteTerminalOutput(
    private val onInput: (ByteArray, Int, Int) -> Unit,
    private val onBellRinging: () -> Unit = {},
) : TerminalOutput() {
    override fun write(data: ByteArray, offset: Int, count: Int) {
        onInput(data, offset, count)
    }

    override fun titleChanged(oldTitle: String?, newTitle: String?) {}

    override fun onCopyTextToClipboard(text: String?) {}

    override fun onPasteTextFromClipboard() {}

    override fun onBell() {
        onBellRinging()
    }

    override fun onColorsChanged() {}
}
