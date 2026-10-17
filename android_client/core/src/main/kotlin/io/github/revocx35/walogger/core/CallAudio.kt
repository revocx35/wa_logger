package io.github.revocx35.walogger.core

import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit

/** Call audio format (ARCHITECTURE §4 "Calls"): 16 kHz mono signed 16-bit little-endian PCM. */
const val CALL_RATE = 16_000
/** 20 ms frames. */
const val CALL_FRAME = 320

/** Why the call audio connection ended. */
enum class CallAudioEnd { Ended, Replaced, Session, NoCall, Failed }

/**
 * The call audio WebSocket (`/api/calls/audio`: session cookie + same-origin `Origin`, like `/api/vnc`). Binary
 * messages both ways; the server's first message is a text [CallAudioHello]. Callbacks run on OkHttp's thread and
 * must not throw (see CLAUDE.md): they are wrapped here.
 */
class CallAudioSocket(
    private val api: ApiClient,
    private val onPcm: (ByteArray) -> Unit,
    private val onEnd: (CallAudioEnd, String?) -> Unit,
) {
    @Volatile private var socket: WebSocket? = null
    @Volatile private var closedByUs = false
    @Volatile private var finished = false
    @Volatile var callId: String? = null
        private set

    fun start() {
        // OkHttp upgrades http(s) URLs to ws(s); the cookie jar and the Origin interceptor apply as usual.
        val request = Request.Builder().url(api.url("/api/calls/audio")).build()
        val client = api.http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(20, TimeUnit.SECONDS).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val hello = runCatching { WaJson.decodeFromString(CallAudioHello.serializer(), text) }.getOrNull()
                if (hello == null || hello.sampleRate != CALL_RATE || hello.format != "s16le") {
                    webSocket.close(1000, null)
                    finish(CallAudioEnd.Failed, "Unsupported call audio format.")
                } else callId = hello.callId
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (bytes.size % 2 == 0) runCatching { onPcm(bytes.toByteArray()) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                finish(codeToEnd(code), reason.ifBlank { null })
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(codeToEnd(code), reason.ifBlank { null })

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val why = when (response?.code) {
                    401 -> "Please log in again."
                    403 -> "The server refused the connection."
                    null -> mapTransportError(t).message
                    else -> "Connection failed (${response.code})."
                }
                finish(if (response?.code == 401) CallAudioEnd.Session else CallAudioEnd.Failed, why)
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

    /** Queues one frame of the owner's voice; false when the connection is gone or backed up (the frame is dropped). */
    fun send(pcm: ByteArray, length: Int = pcm.size): Boolean {
        val ws = socket ?: return false
        if (ws.queueSize() > 64 * 1024) return false
        return ws.send(pcm.toByteString(0, length))
    }

    fun close() {
        closedByUs = true
        socket?.close(1000, null)
        socket = null
    }
}

/**
 * Playback buffer for the other side's voice: starts (and restarts after running dry) once [prebufferMs] are
 * queued, and drops the oldest audio when more than [maxMs] pile up, so delay never grows. Thread-safe: the socket
 * thread adds, the player thread reads.
 */
class JitterBuffer(prebufferMs: Int = 80, maxMs: Int = 300) {
    private val prebuffer = CALL_RATE * prebufferMs / 1000
    private val max = CALL_RATE * maxMs / 1000
    private val chunks = ArrayDeque<ShortArray>()
    private var queued = 0
    private var head = 0
    private var playing = false

    /** Adds s16le PCM (as received from the socket). */
    @Synchronized
    fun add(pcm: ByteArray) {
        val n = pcm.size / 2
        if (n == 0) return
        val s = ShortArray(n) { i -> ((pcm[2 * i].toInt() and 0xff) or (pcm[2 * i + 1].toInt() shl 8)).toShort() }
        chunks.addLast(s)
        queued += n
        while (queued - head > max && chunks.size > 1) {
            val first = chunks.removeFirst()
            queued -= first.size
            head = 0
        }
    }

    /** Samples waiting to be played. */
    @Synchronized
    fun available(): Int = queued - head

    /** Fills [out] with the next samples, or silence while (pre)buffering. Returns the number of real samples. */
    @Synchronized
    fun read(out: ShortArray): Int {
        if (!playing && queued - head >= prebuffer) playing = true
        var i = 0
        while (playing && i < out.size && chunks.isNotEmpty()) {
            val c = chunks.first()
            val take = minOf(out.size - i, c.size - head)
            System.arraycopy(c, head, out, i, take)
            i += take
            head += take
            if (head == c.size) {
                chunks.removeFirst()
                queued -= c.size
                head = 0
            }
        }
        if (chunks.isEmpty()) {
            playing = false
            queued = 0
            head = 0
        }
        out.fill(0, i, out.size)
        return i
    }

    @Synchronized
    fun clear() {
        chunks.clear()
        queued = 0
        head = 0
        playing = false
    }
}
