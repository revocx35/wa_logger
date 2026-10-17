package io.github.revocx35.walogger.core

import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit

/** Video codecs of the frame header (shared/api.d.ts `WS /api/calls/video`). */
const val VIDEO_H264 = 1
const val VIDEO_VP8 = 2
const val VIDEO_HEADER = 12

/**
 * The 12-byte little-endian header in front of every video frame: codec, flags (bit 0: key frame), rotation (quarter
 * turns clockwise to show it upright), 0, width, height, timestamp (ms).
 */
data class VideoFrameHeader(val codec: Int, val key: Boolean, val rotation: Int, val width: Int, val height: Int, val timestampMs: Long) {
    fun write(into: ByteArray) {
        into[0] = codec.toByte()
        into[1] = if (key) 1 else 0
        into[2] = (rotation and 3).toByte()
        into[3] = 0
        putShort(into, 4, width)
        putShort(into, 6, height)
        val t = timestampMs and 0xffffffffL
        for (i in 0 until 4) into[8 + i] = (t shr (8 * i)).toByte()
    }

    /** Header + [data] as one message. */
    fun frame(data: ByteArray, offset: Int = 0, length: Int = data.size): ByteArray {
        val out = ByteArray(VIDEO_HEADER + length)
        write(out)
        System.arraycopy(data, offset, out, VIDEO_HEADER, length)
        return out
    }

    companion object {
        private fun putShort(b: ByteArray, at: Int, v: Int) {
            b[at] = (v and 0xff).toByte()
            b[at + 1] = ((v shr 8) and 0xff).toByte()
        }

        private fun u8(b: ByteArray, i: Int) = b[i].toInt() and 0xff

        /** The header of a received frame, or null when it isn't a valid one. */
        fun parse(b: ByteArray): VideoFrameHeader? {
            if (b.size <= VIDEO_HEADER) return null
            val codec = u8(b, 0)
            if (codec != VIDEO_H264 && codec != VIDEO_VP8) return null
            val ts = (0 until 4).fold(0L) { acc, i -> acc or (u8(b, 8 + i).toLong() shl (8 * i)) }
            return VideoFrameHeader(codec, (u8(b, 1) and 1) == 1, u8(b, 2) and 3, u8(b, 4) or (u8(b, 5) shl 8), u8(b, 6) or (u8(b, 7) shl 8), ts)
        }
    }
}

/**
 * The call video WebSocket (`/api/calls/video`, same auth as the audio socket). Binary messages are frames with a
 * [VideoFrameHeader]; text messages are the hello and `{type:'keyframe'}` (the server wants a key frame from our
 * encoder). [requestKeyFrame] asks for one of the other side's video. Callbacks run on OkHttp's thread and never throw.
 */
class CallVideoSocket(
    private val api: ApiClient,
    private val onFrame: (VideoFrameHeader, ByteArray) -> Unit,
    private val onKeyFrameWanted: () -> Unit,
    private val onEnd: (CallAudioEnd, String?) -> Unit,
) {
    @Volatile private var socket: WebSocket? = null
    @Volatile private var closedByUs = false
    @Volatile private var finished = false

    fun start() {
        val request = Request.Builder().url(api.url("/api/calls/video")).build()
        val client = api.http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(20, TimeUnit.SECONDS).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.contains("\"keyframe\"")) runCatching { onKeyFrameWanted() }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val b = bytes.toByteArray()
                val h = VideoFrameHeader.parse(b) ?: return
                runCatching { onFrame(h, b) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                finish(codeToEnd(code), reason.ifBlank { null })
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(codeToEnd(code), reason.ifBlank { null })

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                finish(if (response?.code == 401) CallAudioEnd.Session else CallAudioEnd.Failed, if (response == null) mapTransportError(t).message else "Video connection failed (${response.code}).")
            }
        })
    }

    private fun codeToEnd(code: Int) = when (code) {
        1000 -> CallAudioEnd.Ended
        4000 -> CallAudioEnd.Replaced
        4001 -> CallAudioEnd.Session
        4004 -> CallAudioEnd.NoCall
        else -> CallAudioEnd.Failed
    }

    private fun finish(why: CallAudioEnd, detail: String?) {
        synchronized(this) {
            if (finished) return
            finished = true
        }
        if (!closedByUs) runCatching { onEnd(why, detail) }
    }

    /** Sends one frame (header + data); false when the connection is gone or backed up (the frame is dropped). */
    fun send(frame: ByteArray): Boolean {
        val ws = socket ?: return false
        if (ws.queueSize() > 1024 * 1024) return false
        return ws.send(frame.toByteString())
    }

    /** Asks for a key frame of the other side's video. */
    fun requestKeyFrame() {
        socket?.send("""{"type":"keyframe"}""")
    }

    fun close() {
        closedByUs = true
        socket?.close(1000, null)
        socket = null
    }
}
