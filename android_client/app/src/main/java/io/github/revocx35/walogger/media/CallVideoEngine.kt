package io.github.revocx35.walogger.media

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import android.util.Size
import android.view.Surface
import io.github.revocx35.walogger.core.VIDEO_H264
import io.github.revocx35.walogger.core.VIDEO_HEADER
import io.github.revocx35.walogger.core.VideoFrameHeader
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit

/**
 * Plays the other side's video: frames (header + H.264 Annex B or VP8) → MediaCodec decoder → [surface]. Decoding
 * starts at a key frame; when it can't continue (no surface yet, decoder error, too far behind) it waits for the next
 * one and calls [needKeyFrame]. Runs on its own thread; [onSize] reports the picture size and rotation for the view.
 */
class RemoteVideoDecoder(
    private val needKeyFrame: () -> Unit,
    private val onSize: (width: Int, height: Int, rotation: Int) -> Unit,
) {
    private val queue = LinkedBlockingDeque<Pair<VideoFrameHeader, ByteArray>>(30)
    @Volatile private var running = true
    @Volatile private var surface: Surface? = null
    @Volatile private var surfaceChanged = false
    private var codec: MediaCodec? = null
    private var codecType = 0
    private var size = Triple(0, 0, -1)
    /** Decoders that failed for a codec (some hardware decoders don't work, e.g. the emulator's): the next is tried. */
    private val failed = mutableMapOf<String, MutableSet<String>>()
    private var codecName: String? = null

    /** Decoders for [mime], hardware first (as the system orders them), skipping ones that failed. */
    private fun decoderFor(mime: String): MediaCodec {
        val skip = failed[mime].orEmpty()
        val names = android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS).codecInfos
            .filter { !it.isEncoder && it.supportedTypes.any { t -> t.equals(mime, ignoreCase = true) } }
            .map { it.name }
        val name = names.firstOrNull { it !in skip } ?: run {
            failed.remove(mime) // all failed once: start over
            names.firstOrNull()
        }
        codecName = name
        return if (name != null) MediaCodec.createByCodecName(name) else MediaCodec.createDecoderByType(mime)
    }
    private val thread = Thread({ loop() }, "call-video-decode").apply { isDaemon = true; start() }

    fun setSurface(s: Surface?) {
        surface = s
        surfaceChanged = true
        if (s != null) needKeyFrame()
    }

    /** A frame from the socket (any thread). */
    fun offer(h: VideoFrameHeader, frame: ByteArray) {
        if (!queue.offerLast(h to frame)) {
            // Behind by more than a second: start over at the next key frame.
            queue.clear()
            needKeyFrame()
        }
    }

    private fun loop() {
        var waitKey = true
        val info = MediaCodec.BufferInfo()
        while (running) {
            val item = try {
                queue.pollFirst(100, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                null
            }
            if (surfaceChanged) {
                surfaceChanged = false
                release()
                waitKey = true
            }
            drain(info)
            val (h, frame) = item ?: continue
            val s = surface ?: continue
            if (waitKey && !h.key) continue
            try {
                if (codec == null || codecType != h.codec) {
                    release()
                    codecType = h.codec
                    val mime = if (h.codec == VIDEO_H264) MediaFormat.MIMETYPE_VIDEO_AVC else MediaFormat.MIMETYPE_VIDEO_VP8
                    val c = decoderFor(mime)
                    c.configure(MediaFormat.createVideoFormat(mime, maxOf(h.width, 16), maxOf(h.height, 16)), s, null, 0)
                    c.start()
                    codec = c
                    if (!h.key) {
                        waitKey = true
                        continue
                    }
                }
                val c = codec!!
                val idx = c.dequeueInputBuffer(20_000)
                if (idx < 0) {
                    waitKey = true // the decoder is stuck behind: drop until a key frame
                    needKeyFrame()
                    continue
                }
                val buf = c.getInputBuffer(idx)!!
                buf.clear()
                buf.put(frame, VIDEO_HEADER, frame.size - VIDEO_HEADER)
                c.queueInputBuffer(idx, 0, frame.size - VIDEO_HEADER, h.timestampMs * 1000, if (h.key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                waitKey = false
                if (size.first != h.width || size.second != h.height || size.third != h.rotation) {
                    size = Triple(h.width, h.height, h.rotation)
                    runCatching { onSize(h.width, h.height, h.rotation) }
                }
                drain(info)
            } catch (_: Exception) {
                val mime = if (codecType == VIDEO_H264) MediaFormat.MIMETYPE_VIDEO_AVC else MediaFormat.MIMETYPE_VIDEO_VP8
                codecName?.let { failed.getOrPut(mime) { mutableSetOf() }.add(it) }
                release()
                waitKey = true
                needKeyFrame()
            }
        }
        release()
    }

    private fun drain(info: MediaCodec.BufferInfo) {
        val c = codec ?: return
        try {
            while (true) {
                val out = c.dequeueOutputBuffer(info, 0)
                if (out < 0) break
                c.releaseOutputBuffer(out, true)
            }
        } catch (_: Exception) {
            /* reset on the next frame */
        }
    }

    private fun release() {
        val c = codec ?: return
        codec = null
        runCatching { c.stop() }
        runCatching { c.release() }
    }

    fun stop() {
        running = false
        thread.interrupt()
        queue.clear()
    }
}

/**
 * The phone's camera for a call: Camera2 (front camera when there is one) → a MediaCodec H.264 encoder (640×480,
 * 24 fps, 900 kbit/s, key frame every 2 s or on request) → [send] (header + Annex B, SPS/PPS repeated in front of each key
 * frame), plus a preview [SurfaceTexture]. The frames go out in the sensor's orientation; the header carries the
 * rotation that makes them upright for a phone held upright. Needs CAMERA.
 */
class CameraEncoder(
    context: Context,
    private val send: (ByteArray) -> Unit,
    private val onError: (String) -> Unit,
    private val onOpened: (front: Boolean) -> Unit = {},
) {
    private val cm = context.getSystemService(CameraManager::class.java)
    private val thread = HandlerThread("call-camera").apply { start() }
    private val handler = Handler(thread.looper)
    private var camera: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var encoder: MediaCodec? = null
    private var encoderSurface: Surface? = null
    private var previewSurface: Surface? = null
    private var preview: SurfaceTexture? = null
    @Volatile private var running = false
    private var config: ByteArray? = null
    private var rotation = 0
    private var size = Size(640, 480)
    private var outThread: Thread? = null
    /** Sessions are rebuilt when the preview comes and goes; callbacks of an older one are ignored. */
    private var sessionGen = 0
    /** Whether the frames come from the front camera (the preview is then shown mirrored). */
    var front = false
        private set

    /** Where the camera preview goes (may arrive after [start]; the session restarts then). */
    fun setPreview(texture: SurfaceTexture?) {
        handler.post {
            preview = texture
            if (running) openSession()
        }
    }

    val previewSize: Size get() = size

    @SuppressLint("MissingPermission")
    fun start() {
        handler.post {
            if (running) return@post
            running = true
            try {
                val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT }
                    ?: cm.cameraIdList.firstOrNull()
                    ?: throw IllegalStateException("no camera")
                val ch = cm.getCameraCharacteristics(id)
                front = ch.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
                val sensor = ch.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
                // A phone held upright: the frame must turn by the sensor's angle (clockwise) to be upright.
                rotation = (sensor / 90) and 3
                val sizes = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)?.getOutputSizes(SurfaceTexture::class.java).orEmpty()
                size = sizes.filter { it.width <= 640 && it.height <= 480 }.maxByOrNull { it.width * it.height } ?: Size(640, 480)
                startEncoder()
                cm.openCamera(id, object : CameraDevice.StateCallback() {
                    override fun onOpened(c: CameraDevice) {
                        if (!running) {
                            c.close()
                            return
                        }
                        camera = c
                        runCatching { onOpened(front) }
                        openSession()
                    }

                    override fun onDisconnected(c: CameraDevice) {
                        c.close()
                        if (camera === c) camera = null
                    }

                    override fun onError(c: CameraDevice, error: Int) {
                        c.close()
                        if (camera === c) camera = null
                        onError("The camera could not be opened.")
                    }
                }, handler)
            } catch (_: Exception) {
                running = false
                onError("The camera could not be opened.")
            }
        }
    }

    private fun encoderFormat(withProfile: Boolean) = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, size.width, size.height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(MediaFormat.KEY_BIT_RATE, 900_000)
        setInteger(MediaFormat.KEY_FRAME_RATE, 24)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
        if (withProfile) {
            setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
            setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31)
        }
    }

    private fun startEncoder() {
        val enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        try {
            enc.configure(encoderFormat(true), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        } catch (_: Exception) {
            // Some encoders reject the profile/level hints: try without them.
            enc.configure(encoderFormat(false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        }
        encoderSurface = enc.createInputSurface()
        enc.start()
        encoder = enc
        config = null
        outThread = Thread({ drainEncoder(enc) }, "call-video-encode").apply { isDaemon = true; start() }
    }

    private fun drainEncoder(enc: MediaCodec) {
        val info = MediaCodec.BufferInfo()
        val t0 = System.nanoTime()
        while (running && encoder === enc) {
            val idx = try {
                enc.dequeueOutputBuffer(info, 100_000)
            } catch (_: Exception) {
                break
            }
            if (idx < 0) continue
            try {
                val buf = enc.getOutputBuffer(idx) ?: continue
                val data = ByteArray(info.size)
                buf.position(info.offset)
                buf.get(data, 0, info.size)
                if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                    config = data // SPS/PPS: sent again in front of every key frame
                } else if (info.size > 0) {
                    val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                    val payload = if (key && config != null) config!! + data else data
                    val h = VideoFrameHeader(VIDEO_H264, key, rotation, size.width, size.height, (System.nanoTime() - t0) / 1_000_000)
                    send(h.frame(payload))
                }
            } catch (_: Exception) {
                /* skip this frame */
            } finally {
                runCatching { enc.releaseOutputBuffer(idx, false) }
            }
        }
    }

    private fun openSession() {
        val cam = camera ?: return
        val encSurface = encoderSurface ?: return
        val gen = ++sessionGen
        runCatching { session?.close() }
        session = null
        previewSurface?.release()
        previewSurface = preview?.let { tex ->
            tex.setDefaultBufferSize(size.width, size.height)
            Surface(tex)
        }
        val targets = listOfNotNull(encSurface, previewSurface)
        try {
            @Suppress("DEPRECATION")
            cam.createCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    if (!running || camera !== cam || gen != sessionGen) {
                        s.close()
                        return
                    }
                    session = s
                    val req = cam.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                        targets.forEach { addTarget(it) }
                        set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, Range(15, 24))
                    }
                    runCatching { s.setRepeatingRequest(req.build(), null, handler) }
                    requestKeyFrame()
                }

                override fun onConfigureFailed(s: CameraCaptureSession) {
                    if (!running || gen != sessionGen) return
                    // Retry once without the preview (its surface may have just gone away); give up after that.
                    if (preview != null) {
                        preview = null
                        openSession()
                    } else {
                        onError("The camera could not be started.")
                    }
                }
            }, handler)
        } catch (_: Exception) {
            if (gen == sessionGen) onError("The camera could not be started.")
        }
    }

    /** The server (WhatsApp's side) needs a key frame. */
    fun requestKeyFrame() {
        runCatching { encoder?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
    }

    fun stop() {
        handler.post {
            running = false
            runCatching { session?.close() }
            session = null
            runCatching { camera?.close() }
            camera = null
            val enc = encoder
            encoder = null
            runCatching { enc?.stop() }
            runCatching { enc?.release() }
            encoderSurface?.release()
            encoderSurface = null
            previewSurface?.release()
            previewSurface = null
            thread.quitSafely()
        }
    }

}
