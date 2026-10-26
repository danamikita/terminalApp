package com.danamikita.terminalapp.mobile.terminal

import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient

/**
 * TerminalEmulator only ever calls getTerminalCursorStyle(),
 * onTerminalCursorStateChange(), and the log*() methods on this interface
 * directly (confirmed by reading TerminalEmulator's source) — every method
 * taking a TerminalSession parameter belongs to TerminalSession's own code
 * path, which this app doesn't use, so those are unreachable stubs here.
 */
class NoopTerminalSessionClient : TerminalSessionClient {
    override fun onTextChanged(changedSession: TerminalSession?) {}
    override fun onTitleChanged(changedSession: TerminalSession?) {}
    override fun onSessionFinished(finishedSession: TerminalSession?) {}
    override fun onCopyTextToClipboard(session: TerminalSession?, text: String?) {}
    override fun onPasteTextFromClipboard(session: TerminalSession?) {}
    override fun onBell(session: TerminalSession?) {}
    override fun onColorsChanged(session: TerminalSession?) {}
    override fun onTerminalCursorStateChange(state: Boolean) {}
    override fun getTerminalCursorStyle(): Int? = null

    override fun logError(tag: String?, message: String?) {}
    override fun logWarn(tag: String?, message: String?) {}
    override fun logInfo(tag: String?, message: String?) {}
    override fun logDebug(tag: String?, message: String?) {}
    override fun logVerbose(tag: String?, message: String?) {}
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
    override fun logStackTrace(tag: String?, e: Exception?) {}
}
