package io.github.revocx35.walogger.data

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.CallAudioEnd
import io.github.revocx35.walogger.core.CallInfo
import io.github.revocx35.walogger.core.CallState
import io.github.revocx35.walogger.core.EventStream
import io.github.revocx35.walogger.core.ServerEvent
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.media.CallAudioEngine
import io.github.revocx35.walogger.media.CallForegroundService
import io.github.revocx35.walogger.ui.CallActions
import io.github.revocx35.walogger.ui.CallAudioState
import io.github.revocx35.walogger.ui.CallUi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** How long an ended call stays on screen. */
private const val ENDED_SHOW_MS = 4000L

/**
 * Voice calls for one server session, like the web's CallProvider: follows the current call (SSE `call` events and
 * `GET /api/calls/current`), rings for incoming calls while the app is open, and runs the phone end of the audio
 * ([CallAudioEngine]) with a foreground service while audio flows, so the call survives switching apps.
 * The caller makes sure RECORD_AUDIO is granted before [start], [accept] and [joinAudio].
 */
class CallController(
    private val context: Context,
    private val api: ApiClient,
    events: EventStream,
    private val scope: CoroutineScope,
) : CallActions {
    private val _ui = MutableStateFlow(CallUi())
    override val ui: StateFlow<CallUi> = _ui.asStateFlow()

    private var engine: CallAudioEngine? = null
    private var endedJob: Job? = null
    private var ringtone: Ringtone? = null
    private var ringback: ToneGenerator? = null
    private var ringing: String? = null
    /** Hang up was pressed before the server answered the start request. */
    private var hangupPending = false

    /** True while a call goes on (keeps the event stream running in the background). */
    val busy: Boolean get() = _ui.value.call?.live == true || engine != null

    /** Called when a call is over (the event stream may stop again if the app is in the background). */
    var onIdle: (() -> Unit)? = null

    init {
        scope.launch {
            events.events.collect { ev ->
                when (ev) {
                    is ServerEvent.CallChanged -> onEvent(ev.call)
                    is ServerEvent.WaStateChanged -> refresh()
                    else -> Unit
                }
            }
        }
        scope.launch { events.connected.collect { if (it) refresh() } }
    }

    fun refresh() {
        scope.launch {
            try {
                val r = api.currentCall()
                _ui.update { u ->
                    val keep = u.call?.takeIf { it.state == CallState.Ended && r.call == null }
                    u.copy(call = r.call ?: keep, available = r.available)
                }
                after()
            } catch (_: Exception) {
                /* keep what we have */
            }
        }
    }

    private fun onEvent(next: CallInfo) {
        val prev = _ui.value.call
        _ui.update { it.copy(call = if (prev != null && prev.id == next.id) next.copy(name = prev.name, avatarUrl = prev.avatarUrl) else next) }
        // SSE carries no names: fetch them for a call we haven't seen yet.
        if (prev?.id != next.id) refresh()
        after()
    }

    /** Ringing, ringback and the end of a call. */
    private fun after() {
        val c = _ui.value.call
        val ringKey = when {
            c == null -> null
            c.incoming && c.state == CallState.Incoming -> "ring:${c.id}"
            !c.incoming && c.state == CallState.Ringing -> "back:${c.id}"
            else -> null
        }
        if (ringKey != ringing) {
            stopTones()
            ringing = ringKey
            if (ringKey?.startsWith("ring:") == true) startRingtone() else if (ringKey != null) startRingback()
        }
        if (c?.state == CallState.Ended) {
            stopAudio()
            onIdle?.invoke()
            if (endedJob == null) {
                val id = c.id
                endedJob = scope.launch {
                    delay(ENDED_SHOW_MS)
                    _ui.update { u -> if (u.call?.id == id && u.call.state == CallState.Ended) u.copy(call = null, note = null) else u }
                    endedJob = null
                }
            }
        } else if (c != null) {
            endedJob?.cancel()
            endedJob = null
        }
    }

    /* --------------------------------------------------------------------------------------- actions */

    override fun start(chatId: String, name: String) {
        if (_ui.value.call?.live == true || _ui.value.busy) return
        hangupPending = false
        _ui.update {
            it.copy(
                note = null,
                busy = true,
                call = CallInfo(id = "", direction = "outgoing", state = CallState.Calling, chatId = chatId, name = name, startedAt = System.currentTimeMillis()),
            )
        }
        scope.launch {
            try {
                val c = api.startCall(chatId)
                if (hangupPending) {
                    hangupPending = false
                    runCatching { api.hangupCall(c.id) }
                    return@launch
                }
                _ui.update { u ->
                    val prev = u.call
                    u.copy(call = if (prev != null && prev.id == c.id && prev.state != c.state) prev.copy(name = c.name, avatarUrl = c.avatarUrl) else c)
                }
                startAudio()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _ui.update { it.copy(call = null, note = e.userMessage()) }
            } finally {
                _ui.update { it.copy(busy = false) }
                after()
            }
        }
    }

    override fun accept() {
        val c = _ui.value.call ?: return
        if (_ui.value.busy) return
        _ui.update { it.copy(note = null, busy = true) }
        stopTones()
        scope.launch {
            try {
                api.acceptCall(c.id)
                startAudio()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _ui.update { it.copy(note = e.userMessage()) }
            } finally {
                _ui.update { it.copy(busy = false) }
            }
        }
    }

    override fun decline() {
        val c = _ui.value.call ?: return
        if (_ui.value.busy) return
        _ui.update { it.copy(busy = true) }
        stopTones()
        scope.launch {
            try {
                api.rejectCall(c.id)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _ui.update { it.copy(note = e.userMessage()) }
            } finally {
                _ui.update { it.copy(busy = false) }
            }
        }
    }

    override fun hangup() {
        val c = _ui.value.call ?: return
        stopAudio()
        if (c.id.isEmpty()) {
            hangupPending = true
            _ui.update { it.copy(call = c.copy(state = CallState.Ended, endedAt = System.currentTimeMillis(), endReason = "canceled")) }
            after()
            return
        }
        scope.launch {
            try {
                api.hangupCall(c.id)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _ui.update { it.copy(note = e.userMessage()) }
            }
        }
    }

    override fun joinAudio() {
        _ui.update { it.copy(note = null) }
        startAudio()
    }

    override fun toggleMute() {
        val e = engine ?: return
        e.muted = !e.muted
        _ui.update { it.copy(muted = e.muted) }
    }

    override fun toggleSpeaker() {
        val on = !_ui.value.speaker
        engine?.setSpeaker(on)
        _ui.update { it.copy(speaker = on) }
    }

    override fun dismissNote() {
        _ui.update { it.copy(note = null) }
    }

    override fun reportNote(note: String) {
        _ui.update { it.copy(note = note) }
    }

    /* ----------------------------------------------------------------------------------------- audio */

    private fun startAudio() {
        if (engine != null) return
        val e = CallAudioEngine(context, CallAudioEngine.sockets(api)) { why, detail ->
            scope.launch { onAudioEnd(why, detail) }
        }
        if (!e.start()) {
            _ui.update { it.copy(note = "The microphone could not be opened.") }
            return
        }
        engine = e
        if (_ui.value.speaker) e.setSpeaker(true)
        _ui.update { it.copy(audio = CallAudioState.Live, muted = false) }
        CallForegroundService.start(context, _ui.value.call?.name)
    }

    private fun onAudioEnd(why: CallAudioEnd, detail: String?) {
        engine = null
        CallForegroundService.stop(context)
        _ui.update {
            it.copy(
                audio = CallAudioState.Off,
                muted = false,
                note = when (why) {
                    CallAudioEnd.Replaced -> "The call audio moved to another device or window."
                    CallAudioEnd.Session -> "Your session ended."
                    CallAudioEnd.Failed -> detail ?: "The call audio connection was lost."
                    else -> it.note
                },
            )
        }
        refresh()
    }

    private fun stopAudio() {
        val e = engine ?: return
        engine = null
        e.stop()
        CallForegroundService.stop(context)
        _ui.update { it.copy(audio = CallAudioState.Off, muted = false, speaker = false) }
    }

    /* ----------------------------------------------------------------------------------------- tones */

    private fun startRingtone() {
        runCatching {
            val uri = RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE) ?: return@runCatching
            ringtone = RingtoneManager.getRingtone(context, uri)?.apply {
                audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build()
                if (Build.VERSION.SDK_INT >= 28) isLooping = true
                play()
            }
        }
        runCatching {
            val v = context.getSystemService(Vibrator::class.java)
            if (v?.hasVibrator() == true) v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 1200), 0))
        }
    }

    private fun startRingback() {
        runCatching { ringback = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 60).apply { startTone(ToneGenerator.TONE_SUP_RINGTONE) } }
    }

    private fun stopTones() {
        runCatching { ringtone?.stop() }
        ringtone = null
        runCatching { context.getSystemService(Vibrator::class.java)?.cancel() }
        runCatching {
            ringback?.stopTone()
            ringback?.release()
        }
        ringback = null
        ringing = null
    }

    fun close() {
        stopTones()
        stopAudio()
        endedJob?.cancel()
    }
}
