package io.github.revocx35.walogger.ui.vnc

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.core.vnc.Framebuffer
import io.github.revocx35.walogger.core.vnc.Rect
import io.github.revocx35.walogger.core.vnc.RfbListener
import io.github.revocx35.walogger.core.vnc.RfbMessages
import io.github.revocx35.walogger.core.vnc.VncConnection
import io.github.revocx35.walogger.ui.components.BtnStyle
import io.github.revocx35.walogger.ui.components.IconBtn
import io.github.revocx35.walogger.ui.components.Spinner
import io.github.revocx35.walogger.ui.components.WaButton
import io.github.revocx35.walogger.ui.components.WaIcon
import io.github.revocx35.walogger.ui.components.WaTextField
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlin.math.min
import kotlin.math.roundToInt

sealed interface VncStatus {
    data object Connecting : VncStatus
    data object Connected : VncStatus
    data class Lost(val reason: String?) : VncStatus
    data class Failed(val reason: String) : VncStatus
}

class VncFrame(val bitmap: Bitmap, val version: Long)

/**
 * Keeps one VNC session to the background Chromium: credentials from `/api/vnc/credentials`, the
 * RFB stream over `/api/vnc`, a double-buffered bitmap for drawing, and reconnects after drops.
 */
class VncController(private val api: ApiClient, private val scope: CoroutineScope) {
    private val _status = MutableStateFlow<VncStatus>(VncStatus.Connecting)
    val status: StateFlow<VncStatus> = _status.asStateFlow()
    private val _frame = MutableStateFlow<VncFrame?>(null)
    val frame: StateFlow<VncFrame?> = _frame.asStateFlow()

    private var connection: VncConnection? = null
    private var job: Job? = null
    private var closed = false

    private val bitmaps = arrayOfNulls<Bitmap>(2)
    private val stale = arrayOfNulls<Rect>(2)
    private var front = 0
    private var version = 0L

    private val listener = object : RfbListener {
        override fun onConnected(fb: Framebuffer, name: String) {
            allocate(fb)
            _status.value = VncStatus.Connected
        }

        override fun onResize(fb: Framebuffer) = allocate(fb)

        override fun onUpdate(fb: Framebuffer, dirty: Rect) {
            val back = 1 - front
            val bmp = bitmaps[back] ?: return
            if (bmp.width != fb.width || bmp.height != fb.height) return
            val r = dirty.union(stale[back])
            bmp.setPixels(fb.pixels, r.y * fb.width + r.x, fb.width, r.x, r.y, r.w, r.h)
            stale[back] = null
            stale[front] = dirty.union(stale[front])
            front = back
            _frame.value = VncFrame(bmp, ++version)
        }
    }

    private fun allocate(fb: Framebuffer) {
        for (i in 0..1) {
            bitmaps[i] = Bitmap.createBitmap(fb.width, fb.height, Bitmap.Config.ARGB_8888)
            stale[i] = Rect(0, 0, fb.width, fb.height)
        }
    }

    fun connect() {
        if (closed) return
        job?.cancel()
        connection?.close()
        _status.value = VncStatus.Connecting
        job = scope.launch {
            val password = try {
                api.vncCredentials().password
            } catch (e: Exception) {
                _status.value = VncStatus.Failed(e.userMessage())
                return@launch
            }
            val conn = VncConnection(api, password, listener) { reason, authFailed ->
                scope.launch(Dispatchers.Main) {
                    if (closed || reason == null) return@launch
                    if (authFailed) {
                        _status.value = VncStatus.Failed(reason)
                    } else {
                        _status.value = VncStatus.Lost(reason)
                        delay(3000)
                        if (!closed && _status.value is VncStatus.Lost) connect()
                    }
                }
            }
            connection = conn
            conn.start()
        }
    }

    fun close() {
        closed = true
        job?.cancel()
        connection?.close()
        connection = null
    }

    private val proto get() = connection?.protocol?.takeIf { _status.value == VncStatus.Connected }

    fun click(x: Int, y: Int) = send { proto?.click(x, y) }
    fun scroll(x: Int, y: Int, steps: Int) = send { proto?.scroll(x, y, steps) }
    fun type(text: String) = send { proto?.type(text) }
    fun key(keysym: Int) = send { proto?.key(keysym) }

    // Input goes out in order on one background lane (never on the UI thread).
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val inputLane = Dispatchers.IO.limitedParallelism(1)

    private fun send(block: () -> Unit) {
        scope.launch(inputLane) { runCatching(block) }
    }
}

/**
 * Live view of the background browser (WhatsApp Web). Tap = click, one-finger drag = scroll the
 * page (pan when zoomed in or view-only), pinch = zoom. The keyboard button sends typed text.
 */
@Composable
fun VncView(api: ApiClient, viewOnly: Boolean, modifier: Modifier = Modifier) {
    val scope = remember { CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.Main.immediate) }
    val controller = remember(api) { VncController(api, scope) }
    DisposableEffect(controller) {
        controller.connect()
        onDispose {
            controller.close()
            scope.coroutineContext[Job]?.cancel()
        }
    }
    val status by controller.status.collectAsState()
    val frame by controller.frame.collectAsState()
    var zoom by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    var keyboard by remember { mutableStateOf(false) }
    val slop = LocalViewConfiguration.current.touchSlop

    Column(modifier) {
        BoxWithConstraints(
            Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color.Black),
        ) {
            val boxW = constraints.maxWidth.toFloat()
            val boxH = constraints.maxHeight.toFloat()
            val bmp = frame?.bitmap
            val fbW = bmp?.width ?: 0
            val fbH = bmp?.height ?: 0
            val fit = if (bmp != null) min(boxW / fbW, boxH / fbH) else 1f
            // Read zoom/pan when called (gesture handlers outlive a composition).
            fun scaleNow() = fit * zoom
            fun originNow() = Offset((boxW - fbW * scaleNow()) / 2f, (boxH - fbH * scaleNow()) / 2f) + pan

            fun clampPan(p: Offset, z: Float): Offset {
                if (bmp == null) return Offset.Zero
                val w = bmp.width * fit * z
                val h = bmp.height * fit * z
                val mx = maxOf(0f, (w - boxW) / 2f)
                val my = maxOf(0f, (h - boxH) / 2f)
                return Offset(p.x.coerceIn(-mx, mx), p.y.coerceIn(-my, my))
            }

            fun toRemote(p: Offset): Pair<Int, Int>? {
                val scale = scaleNow()
                if (bmp == null || scale <= 0f) return null
                val origin = originNow()
                val x = ((p.x - origin.x) / scale).roundToInt()
                val y = ((p.y - origin.y) / scale).roundToInt()
                if (x < 0 || y < 0 || x >= fbW || y >= fbH) return null
                return x to y
            }

            Canvas(
                Modifier.fillMaxSize().pointerInput(viewOnly, bmp?.width, bmp?.height, fit) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        var moved = false
                        var multi = false
                        var scrollAcc = 0f
                        var totalDrag = Offset.Zero
                        while (true) {
                            val event = awaitPointerEvent()
                            val pressed = event.changes.filter { it.pressed }
                            if (pressed.isEmpty()) break
                            if (pressed.size >= 2) {
                                multi = true
                                val a = pressed[0]
                                val b = pressed[1]
                                val prevDist = (a.previousPosition - b.previousPosition).getDistance()
                                val dist = (a.position - b.position).getDistance()
                                val newZoom = if (prevDist > 0f) (zoom * dist / prevDist).coerceIn(1f, 5f) else zoom
                                val centroidDelta = ((a.position + b.position) - (a.previousPosition + b.previousPosition)) / 2f
                                pan = clampPan((pan + centroidDelta) * (newZoom / zoom), newZoom)
                                zoom = newZoom
                                event.changes.forEach { it.consume() }
                                continue
                            }
                            val ch = pressed[0]
                            val delta = ch.positionChange()
                            totalDrag += delta
                            if (!moved && totalDrag.getDistance() > slop) moved = true
                            if (moved && !multi) {
                                if (zoom > 1.01f || viewOnly) {
                                    pan = clampPan(pan + delta, zoom)
                                } else {
                                    // Natural scrolling: dragging up scrolls the page down.
                                    scrollAcc -= delta.y
                                    val step = 48f
                                    val steps = (scrollAcc / step).toInt()
                                    if (steps != 0) {
                                        scrollAcc -= steps * step
                                        toRemote(ch.position)?.let { (x, y) -> controller.scroll(x, y, steps) }
                                    }
                                }
                                ch.consume()
                            }
                        }
                        if (!moved && !multi && !viewOnly) toRemote(down.position)?.let { (x, y) -> controller.click(x, y) }
                    }
                },
            ) {
                val f = frame // a new frame object per update → redraw
                if (f != null) {
                    val origin = originNow()
                    drawImage(
                        f.bitmap.asImageBitmap(),
                        dstOffset = IntOffset(origin.x.roundToInt(), origin.y.roundToInt()),
                        dstSize = IntSize((fbW * scaleNow()).roundToInt(), (fbH * scaleNow()).roundToInt()),
                        filterQuality = FilterQuality.Medium,
                    )
                }
            }

            if (status != VncStatus.Connected) {
                Column(
                    Modifier.fillMaxSize().background(Color(0x8C000000)),
                    verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    when (val s = status) {
                        is VncStatus.Connecting -> { Spinner(28.dp); Text("Connecting to the browser…", color = Color(0xFFE9EDEF)) }
                        is VncStatus.Lost -> { Spinner(28.dp); Text("Connection lost, reconnecting…", color = Color(0xFFE9EDEF)) }
                        is VncStatus.Failed -> {
                            WaIcon(WaIcons.warning, 28.dp, Color(0xFFE9EDEF))
                            Text("Could not connect to the browser.", color = Color(0xFFE9EDEF))
                            Text(s.reason, color = Color(0xFFAEBAC1), style = WaType.small)
                            WaButton("Retry", { controller.connect() })
                        }
                        VncStatus.Connected -> Unit
                    }
                }
            }
            if (zoom > 1.01f) {
                Box(Modifier.align(Alignment.TopEnd).padding(6.dp).clip(RoundedCornerShape(20.dp)).background(Color(0x99000000))) {
                    IconBtn(WaIcons.close, "Reset zoom", { zoom = 1f; pan = Offset.Zero }, size = 36.dp, iconSize = 18.dp, tint = Color.White)
                }
            }
        }
        if (!viewOnly) {
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                IconBtn(WaIcons.keyboard, "Keyboard", { keyboard = !keyboard }, active = keyboard)
                IconBtn(WaIcons.zoomIn, "Zoom in", { zoom = (zoom * 1.5f).coerceAtMost(5f) }, size = 40.dp)
                Text("Tap to click · drag to scroll · pinch to zoom", style = WaType.tiny, color = Wa.colors.muted, modifier = Modifier.weight(1f))
            }
            if (keyboard) VncKeyboard(controller)
        }
    }
}

@Composable
private fun VncKeyboard(controller: VncController) {
    var text by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.focusRequester(focus)) {
            WaTextField(
                text,
                { new ->
                    // Send the difference as key presses (typing, deleting, or both).
                    val common = text.commonPrefixWith(new).length
                    repeat(text.length - common) { controller.key(RfbMessages.KEY_BACKSPACE) }
                    if (new.length > common) controller.type(new.substring(common))
                    text = new
                },
                label = null,
                placeholder = "Type here — it is sent to the browser",
                imeAction = ImeAction.Send,
                onIme = { controller.key(RfbMessages.KEY_RETURN); text = "" },
            )
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            WaButton("Enter", { controller.key(RfbMessages.KEY_RETURN); text = "" }, tiny = true, icon = WaIcons.enter)
            WaButton("Backspace", { controller.key(RfbMessages.KEY_BACKSPACE); text = text.dropLast(1) }, tiny = true, icon = WaIcons.backspace)
            WaButton("Tab", { controller.key(RfbMessages.KEY_TAB) }, tiny = true)
            WaButton("Esc", { controller.key(RfbMessages.KEY_ESCAPE) }, tiny = true)
            WaButton("←", { controller.key(RfbMessages.KEY_LEFT) }, tiny = true, style = BtnStyle.Ghost)
            WaButton("→", { controller.key(RfbMessages.KEY_RIGHT) }, tiny = true, style = BtnStyle.Ghost)
            WaButton("↑", { controller.key(RfbMessages.KEY_UP) }, tiny = true, style = BtnStyle.Ghost)
            WaButton("↓", { controller.key(RfbMessages.KEY_DOWN) }, tiny = true, style = BtnStyle.Ghost)
        }
    }
}
