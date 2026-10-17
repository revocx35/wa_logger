package io.github.revocx35.walogger.media

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.CALL_FRAME
import io.github.revocx35.walogger.core.CALL_RATE
import io.github.revocx35.walogger.core.CallAudioEnd
import io.github.revocx35.walogger.core.CallAudioSocket
import io.github.revocx35.walogger.core.JitterBuffer

/**
 * The phone end of a call: microphone (voice-call source, so the platform's echo cancellation applies) → 20 ms
 * frames → [CallAudioSocket] → WhatsApp, and the other side's voice from the socket → [JitterBuffer] → the earpiece
 * or the speaker. Audio runs on two dedicated threads; nothing here touches the main thread. Nothing is recorded.
 * Needs RECORD_AUDIO (the caller checks it before creating the engine).
 */
class CallAudioEngine(
    context: Context,
    private val socket: (onPcm: (ByteArray) -> Unit, onEnd: (CallAudioEnd, String?) -> Unit) -> CallAudioSocket,
    private val onEnd: (CallAudioEnd, String?) -> Unit,
) {
    private val am = context.getSystemService(AudioManager::class.java)
    private val jitter = JitterBuffer()
    @Volatile private var running = false
    @Volatile var muted = false
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var ws: CallAudioSocket? = null
    private var focus: AudioFocusRequest? = null
    private var effects: List<android.media.audiofx.AudioEffect> = emptyList()
    private var previousMode = AudioManager.MODE_NORMAL

    /** Starts audio; false when the microphone or the player could not be opened. */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (running) return true
        val minRec = AudioRecord.getMinBufferSize(CALL_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val minPlay = AudioTrack.getMinBufferSize(CALL_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minRec <= 0 || minPlay <= 0) return false
        val rec = try {
            AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, CALL_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minRec, CALL_FRAME * 2 * 4))
        } catch (_: Exception) {
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        val out = try {
            AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(CALL_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minPlay, CALL_FRAME * 2 * 4))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (_: Exception) {
            rec.release()
            return false
        }
        record = rec
        track = out
        effects = buildList {
            if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.let { it.enabled = true; add(it) }
            if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.let { it.enabled = true; add(it) }
        }
        previousMode = am.mode
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attrs).build().also { am.requestAudioFocus(it) }
        running = true
        ws = socket({ jitter.add(it) }, { why, detail ->
            stop()
            onEnd(why, detail)
        }).also { it.start() }
        try {
            rec.startRecording()
            out.play()
        } catch (_: Exception) {
            stop()
            return false
        }
        Thread({ captureLoop(rec) }, "call-mic").apply { isDaemon = true }.start()
        Thread({ playLoop(out) }, "call-speaker").apply { isDaemon = true }.start()
        return true
    }

    private fun captureLoop(rec: AudioRecord) {
        val buf = ShortArray(CALL_FRAME)
        val bytes = ByteArray(CALL_FRAME * 2)
        while (running) {
            val n = try {
                rec.read(buf, 0, buf.size)
            } catch (_: Exception) {
                -1
            }
            if (n < 0) break
            if (n == 0 || muted) continue
            for (i in 0 until n) {
                val v = buf[i].toInt()
                bytes[2 * i] = (v and 0xff).toByte()
                bytes[2 * i + 1] = (v shr 8).toByte()
            }
            ws?.send(bytes, n * 2)
        }
    }

    private fun playLoop(out: AudioTrack) {
        val buf = ShortArray(CALL_FRAME)
        while (running) {
            jitter.read(buf)
            // Blocking write: paces the loop at real time.
            val w = try {
                out.write(buf, 0, buf.size)
            } catch (_: Exception) {
                -1
            }
            if (w < 0) break
        }
    }

    /** Earpiece (default) or loudspeaker. */
    fun setSpeaker(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 31) {
            if (on) am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { am.setCommunicationDevice(it) }
            else am.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = on
        }
    }

    fun stop() {
        if (!running) return
        running = false
        ws?.close()
        ws = null
        runCatching { record?.stop() }
        record?.release()
        record = null
        runCatching { track?.stop() }
        track?.release()
        track = null
        effects.forEach { runCatching { it.release() } }
        effects = emptyList()
        jitter.clear()
        focus?.let { am.abandonAudioFocusRequest(it) }
        focus = null
        setSpeaker(false)
        am.mode = previousMode
    }

    companion object {
        /** The socket factory used by the app ([CallAudioSocket] over the session's API client). */
        fun sockets(api: ApiClient): (onPcm: (ByteArray) -> Unit, onEnd: (CallAudioEnd, String?) -> Unit) -> CallAudioSocket =
            { onPcm, onEnd -> CallAudioSocket(api, onPcm, onEnd) }
    }
}
