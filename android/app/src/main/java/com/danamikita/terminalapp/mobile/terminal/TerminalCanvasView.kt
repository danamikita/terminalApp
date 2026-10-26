package com.danamikita.terminalapp.mobile.terminal

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import com.termux.terminal.TerminalEmulator
import com.termux.view.TerminalRenderer

/**
 * Renders a TerminalEmulator's screen buffer via termux-app's TerminalRenderer
 * (Apache-2.0, bundled VT100/ANSI parsing + drawing) without using termux's
 * own TerminalView/TerminalSession, since those require a real local PTY via
 * JNI that this app doesn't have — the emulator here is fed bytes from an SSE
 * stream instead. See android plan for the full reasoning.
 */
class TerminalCanvasView(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private val renderer = TerminalRenderer(42, Typeface.MONOSPACE)

    var emulator: TerminalEmulator? = null
        set(value) {
            field = value
            invalidate()
        }

    val fontWidth: Float get() = renderer.getFontWidth()
    val fontLineSpacing: Int get() = renderer.getFontLineSpacing()

    fun columnsForWidth(widthPx: Int): Int = (widthPx / fontWidth).toInt().coerceAtLeast(1)
    fun rowsForHeight(heightPx: Int): Int = (heightPx / fontLineSpacing).coerceAtLeast(1)

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Color.BLACK)
        emulator?.let { renderer.render(it, canvas, 0, -1, -1, -1, -1) }
    }
}
