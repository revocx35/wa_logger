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
import io.github.revocx35.walogger.core.CallVideoSocket
import io.github.revocx35.walogger.core.CallState
import io.github.revocx35.walogger.core.EventStream
import io.github.revocx35.walogger.core.ServerEvent
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.media.CallAudioEngine
import io.github.revocx35.walogger.media.CallForegroundService
import io.github.revocx35.walogger.media.CameraEncoder
import io.github.revocx35.walogger.media.RemoteVideoDecoder
import io.github.revocx35.walogger.ui.CallActions
import io.github.revocx35.walogger.ui.CallAudioState
import io.github.revocx35.walogger.ui.CallUi
import io.github.revocx35.walogger.ui.CameraState
import io.github.revocx35.walogger.ui.RemoteVideo
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
    // Video: the socket, the other side's decoder, our camera, and the views they draw into.
    private var videoSocket: CallVideoSocket? = null
    private var decoder: RemoteVideoDecoder? = null
    private var camera: CameraEncoder? = null
    private var remoteSurface: android.view.Surface? = null
    private var previewTexture: android.graphics.SurfaceTexture? = null

    /** True while a call goes on (keeps the event stream running in the background). */
    val busy: Boolean get() = _ui.value.call?.live == true || engine != null || videoSocket != null

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
            stopVideo()
            onIdle?.invoke()
            if (endedJob == null) {
                val id = c.id
                endedJob = scope.launch {
                    delay(ENDED_SHOW_MS)
                    _ui.update { u -> if (u.call?.id == id && u.call.state == CallState.Ended) u.copy(call = null, note = null, minimized = false) else u }
                    endedJob = null
                }
            }
        } else if (c != null) {
            endedJob?.cancel()
            endedJob = null
            // The other side switched video on (or it is a video call): show it once our audio runs here.
            val live = c.state == CallState.Active || c.state == CallState.Connecting
            if (live && c.peerVideo && engine != null && videoSocket == null) beginVideo(false)
        }
    }

    /* --------------------------------------------------------------------------------------- actions */

    override fun start(chatId: String, name: String, video: Boolean) {
        if (_ui.value.call?.live == true || _ui.value.busy) return
        hangupPending = false
        _ui.update {
            it.copy(
                note = null,
                busy = true,
                call = CallInfo(id = "", direction = "outgoing", state = CallState.Calling, video = video, selfVideo = video, chatId = chatId, name = name, startedAt = System.currentTimeMillis()),
                minimized = false,
            )
        }
        scope.launch {
            try {
                val c = api.startCall(chatId, video)
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
                if (video) beginVideo(true)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _ui.update { it.copy(call = null, note = e.userMessage()) }
            } finally {
                _ui.update { it.copy(busy = false) }
                after()
            }
        }
    }

    override fun accept(video: Boolean) {
        val c = _ui.value.call ?: return
        if (_ui.value.busy) return
        _ui.update { it.copy(note = null, busy = true, minimized = false) }
        stopTones()
        scope.launch {
            try {
                api.acceptCall(c.id, video)
                startAudio()
                // A video call shows the other side even when answered without the camera.
                if (video || c.video) beginVideo(video)
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
        stopVideo()
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
        val c = _ui.value.call
        if (c != null && (c.video || c.peerVideo)) beginVideo(false)
    }

    /* ----------------------------------------------------------------------------------------- video */

    override fun toggleCamera() {
        val c = _ui.value.call ?: return
        if (c.id.isEmpty()) return
        val on = _ui.value.camera == CameraState.Off
        if (on) beginVideo(true) else stopCamera()
        scope.launch {
            try {
                val r = api.setCallVideo(c.id, on)
                _ui.update { u -> if (u.call?.id == r.id) u.copy(call = u.call.copy(selfVideo = r.selfVideo, video = r.video)) else u }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _ui.update { it.copy(note = e.userMessage()) }
                if (on) stopCamera()
            }
        }
    }

    override fun toggleRecording() {
        val c = _ui.value.call ?: return
        if (c.id.isEmpty() || c.state != CallState.Active) return
        val on = !c.recording
        _ui.update { u -> if (u.call?.id == c.id) u.copy(call = u.call.copy(recording = on)) else u }
        scope.launch {
            try {
                val r = api.setCallRecording(c.id, on)
                _ui.update { u -> if (u.call?.id == r.id) u.copy(call = u.call.copy(recording = r.recording)) else u }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _ui.update { u -> u.copy(note = e.userMessage(), call = if (u.call?.id == c.id) u.call.copy(recording = !on) else u.call) }
            }
        }
    }

    override fun setMinimized(minimized: Boolean) {
        _ui.update { it.copy(minimized = minimized) }
    }

    override fun setRemoteSurface(surface: android.view.Surface?) {
        remoteSurface = surface
        decoder?.setSurface(surface)
    }

    override fun setPreviewTexture(texture: android.graphics.SurfaceTexture?) {
        previewTexture = texture
        camera?.setPreview(texture)
    }

    /** The video connection (and, with [withCamera], the camera) for the current call. */
    private fun beginVideo(withCamera: Boolean) {
        if (videoSocket == null) {
            val dec = RemoteVideoDecoder(
                needKeyFrame = { videoSocket?.requestKeyFrame() },
                onSize = { w, h, r -> _ui.update { it.copy(remote = RemoteVideo(w, h, r)) } },
            )
            decoder = dec
            dec.setSurface(remoteSurface)
            val sock = CallVideoSocket(
                api,
                onFrame = { h, frame -> dec.offer(h, frame) },
                onKeyFrameWanted = { camera?.requestKeyFrame() },
                onEnd = { why, detail -> scope.launch { onVideoEnd(why, detail) } },
            )
            videoSocket = sock
            sock.start()
            _ui.update { it.copy(videoLive = true) }
        }
        if (withCamera && camera == null) startCamera()
    }

    private fun startCamera() {
        val enc = CameraEncoder(
            context,
            send = { videoSocket?.send(it) },
            onError = { msg ->
                scope.launch {
                    stopCamera()
                    _ui.update { it.copy(note = msg) }
                }
            },
            onOpened = { front -> _ui.update { it.copy(frontCamera = front) } },
        )
        camera = enc
        enc.setPreview(previewTexture)
        enc.start()
        _ui.update { it.copy(camera = CameraState.On) }
        if (engine != null) CallForegroundService.start(context, _ui.value.call?.name, camera = true)
    }

    private fun stopCamera() {
        val enc = camera ?: return
        camera = null
        enc.stop()
        _ui.update { it.copy(camera = CameraState.Off) }
        if (engine != null) CallForegroundService.start(context, _ui.value.call?.name, camera = false)
    }

    private fun onVideoEnd(why: CallAudioEnd, detail: String?) {
        stopVideo()
        _ui.update {
            it.copy(
                note = when (why) {
                    CallAudioEnd.Replaced -> "The call video moved to another device or window."
                    CallAudioEnd.Failed -> detail ?: "The video connection was lost."
                    else -> it.note
                },
            )
        }
    }

    private fun stopVideo() {
        stopCamera()
        videoSocket?.close()
        videoSocket = null
        decoder?.stop()
        decoder = null
        _ui.update { it.copy(videoLive = false, remote = null) }
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
        CallForegroundService.start(context, _ui.value.call?.name, camera = camera != null)
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
        stopVideo()
        endedJob?.cancel()
    }
}
