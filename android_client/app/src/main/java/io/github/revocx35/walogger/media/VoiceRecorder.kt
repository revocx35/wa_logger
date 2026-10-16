package io.github.revocx35.walogger.media

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/**
 * Records a voice message as Ogg/Opus, the format WhatsApp uses (Android 10+). The file lives in the app's
 * private cache and is deleted after sending or discarding.
 */
class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    var startedAt: Long = 0
        private set

    val recording: Boolean get() = recorder != null

    /** Starts recording; false when it couldn't (no microphone, busy, Android < 10). */
    fun start(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || recorder != null) return false
        val dir = File(context.cacheDir, "voice").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // leftovers of an interrupted recording
        val f = File(dir, "voice-${System.currentTimeMillis()}.ogg")
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else MediaRecorder()
        return try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.OGG)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS)
            r.setAudioChannels(1)
            r.setAudioSamplingRate(16_000)
            r.setAudioEncodingBitRate(24_000)
            r.setOutputFile(f)
            r.prepare()
            r.start()
            recorder = r
            file = f
            startedAt = System.currentTimeMillis()
            true
        } catch (_: Exception) {
            r.release()
            f.delete()
            false
        }
    }

    /** Stops and returns the recording, or null when it was too short or failed. */
    fun stop(): File? {
        val r = recorder ?: return null
        val f = file
        recorder = null
        file = null
        val ok = runCatching { r.stop() }.isSuccess
        r.release()
        if (!ok || f == null || System.currentTimeMillis() - startedAt < 1000 || f.length() == 0L) {
            f?.delete()
            return null
        }
        return f
    }

    fun cancel() {
        stop()?.delete()
    }
}
