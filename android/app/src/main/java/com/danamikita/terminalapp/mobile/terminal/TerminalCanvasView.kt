package com.danamikita.terminalapp.mobile.terminal

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import com.termux.terminal.TerminalEmulator
import com.termux.view.TerminalRenderer
import kotlin.math.roundToInt

/**
 * Renders a TerminalEmulator's screen buffer via termux-app's TerminalRenderer
 * (Apache-2.0, bundled VT100/ANSI parsing + drawing) without using termux's
 * own TerminalView/TerminalSession, since those require a real local PTY via
 * JNI that this app doesn't have — the emulator here is fed bytes from an SSE
 * stream instead. See android plan for the full reasoning.
 */
class TerminalCanvasView(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private val renderer = TerminalRenderer(42, Typeface.MONOSPACE)

    // 0 = live/bottom; more negative = further back into scrollback.
    private var topRow = 0

    var onTap: (() -> Unit)? = null

    private val gestureDetector = GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean = true

            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
                val maxBack = -(emulator?.screen?.activeTranscriptRows ?: 0)
                topRow = (topRow + (distanceY / fontLineSpacing).roundToInt()).coerceIn(maxBack, 0)
                invalidate()
                return true
            }

            override fun onSingleTapUp(e: MotionEvent): Boolean {
                onTap?.invoke()
                return true
            }
        },
    )

    var emulator: TerminalEmulator? = null
        set(value) {
            field = value
            invalidate()
        }

    val fontWidth: Float get() = renderer.getFontWidth()
    val fontLineSpacing: Int get() = renderer.getFontLineSpacing()

    fun columnsForWidth(widthPx: Int): Int = (widthPx / fontWidth).toInt().coerceAtLeast(1)
    fun rowsForHeight(heightPx: Int): Int = (heightPx / fontLineSpacing).coerceAtLeast(1)

    // Called when the user sends input, so typing while scrolled back jumps
    // back to the live output like a normal terminal.
    fun scrollToBottom() {
        if (topRow != 0) {
            topRow = 0
            invalidate()
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean = gestureDetector.onTouchEvent(event)

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Color.BLACK)
        emulator?.let { renderer.render(it, canvas, topRow, -1, -1, -1, -1) }
    }
}
