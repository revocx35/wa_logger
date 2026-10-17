package io.github.revocx35.walogger.ui

import androidx.compose.runtime.staticCompositionLocalOf
import io.github.revocx35.walogger.core.CallInfo
import io.github.revocx35.walogger.core.CallState
import kotlinx.coroutines.flow.StateFlow

enum class CallAudioState { Off, Live }
enum class CameraState { Off, Starting, On }

/** The other side's picture: frame size and the quarter turns (clockwise) that make it upright. */
data class RemoteVideo(val width: Int, val height: Int, val rotation: Int)

/** What the call panel shows (see [io.github.revocx35.walogger.data.CallController]). */
data class CallUi(
    val call: CallInfo? = null,
    /** Calls can be placed (WhatsApp connected, call code installed on the server). */
    val available: Boolean = false,
    val audio: CallAudioState = CallAudioState.Off,
    val muted: Boolean = false,
    val speaker: Boolean = false,
    /** A message about the last action or the audio. */
    val note: String? = null,
    /** A request to the server is in flight. */
    val busy: Boolean = false,
    /** This phone is connected to the call video; our camera; the other side's picture once frames arrive. */
    val videoLive: Boolean = false,
    val camera: CameraState = CameraState.Off,
    val frontCamera: Boolean = false,
    val remote: RemoteVideo? = null,
    /** The video screen is minimized to the panel. */
    val minimized: Boolean = false,
) {
    /** The call has video on either side (or our camera is starting): show the video screen. */
    val hasVideo: Boolean get() = call?.let { it.video || it.peerVideo || it.selfVideo } == true || camera != CameraState.Off
}

/** Voice calls through the server (ARCHITECTURE §4 "Calls"). RECORD_AUDIO must be granted before start/accept/joinAudio. */
interface CallActions {
    val ui: StateFlow<CallUi>
    fun start(chatId: String, name: String, video: Boolean)
    fun accept(video: Boolean)
    fun decline()
    fun hangup()
    fun joinAudio()
    fun toggleMute()
    fun toggleSpeaker()
    fun toggleCamera()
    fun setMinimized(minimized: Boolean)
    /** Where the other side's video is drawn / the camera preview goes (null when the view is gone). */
    fun setRemoteSurface(surface: android.view.Surface?)
    fun setPreviewTexture(texture: android.graphics.SurfaceTexture?)
    fun dismissNote()
    fun reportNote(note: String)
}

/** Null where calls aren't available (screenshot tests, previews). */
val LocalCalls = staticCompositionLocalOf<CallActions?> { null }

/** "1:05" / "1:02:03" like the web's formatDuration. */
fun formatCallDuration(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

private val END_TEXT = mapOf(
    "completed" to "Call ended",
    "declined" to "Declined",
    "busy" to "Busy",
    "missed" to "Missed call",
    "unavailable" to "Unavailable",
    "canceled" to "Canceled",
    "elsewhere" to "Answered on another device",
    "failed" to "Call failed",
)

/** The status line of the call panel (same texts as the web). */
fun callStatusText(c: CallInfo, now: Long): String = when (c.state) {
    CallState.Incoming ->
        if (c.video) "Incoming video call" else if (c.group) "Incoming group call" else "Incoming voice call"
    CallState.Calling -> "Calling…"
    CallState.Ringing -> "Ringing…"
    CallState.Connecting -> "Connecting…"
    CallState.Active -> formatCallDuration(now - (c.connectedAt ?: now))
    CallState.Ended -> {
        val text = END_TEXT[c.endReason ?: "completed"] ?: "Call ended"
        val (a, b) = c.connectedAt to c.endedAt
        if (a != null && b != null) "$text · ${formatCallDuration(b - a)}" else text
    }
}
