package io.github.revocx35.walogger.ui

import androidx.compose.runtime.staticCompositionLocalOf
import io.github.revocx35.walogger.core.CallInfo
import io.github.revocx35.walogger.core.CallState
import kotlinx.coroutines.flow.StateFlow

enum class CallAudioState { Off, Live }

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
)

/** Voice calls through the server (ARCHITECTURE §4 "Calls"). RECORD_AUDIO must be granted before start/accept/joinAudio. */
interface CallActions {
    val ui: StateFlow<CallUi>
    fun start(chatId: String, name: String)
    fun accept()
    fun decline()
    fun hangup()
    fun joinAudio()
    fun toggleMute()
    fun toggleSpeaker()
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
        if (c.video) "Incoming video call · answer as voice" else if (c.group) "Incoming group call" else "Incoming voice call"
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
