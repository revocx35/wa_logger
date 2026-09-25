package io.github.revocx35.walogger.core.vnc

import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.mapTransportError
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit

/**
 * One VNC session over the server's authenticated WebSocket bridge (`/api/vnc`, session cookie +
 * same-origin `Origin` header). Runs the RFB protocol on its own thread; [onClosed] reports why it
 * ended (null = closed by us).
 */
class VncConnection(
    private val api: ApiClient,
    private val password: String,
    private val listener: RfbListener,
    private val onClosed: (reason: String?, authFailed: Boolean) -> Unit,
) {
    private val feed = ByteFeed()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var closedByUs = false
    @Volatile private var finished = false
    @Volatile var protocol: RfbProtocol? = null
        private set

    fun start() {
        // OkHttp upgrades http(s) URLs to ws(s); the cookie jar and Origin interceptor apply as usual.
        val request = Request.Builder().url(api.url("/api/vnc")).build()
        val client = api.http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(25, TimeUnit.SECONDS).build()
        val proto = RfbProtocol(password, feed, { bytes -> socket?.send(bytes.toByteString()) }, listener)
        protocol = proto
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = feed.feed(bytes.toByteArray())

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                feed.close()
                finish(if (code == 4001) "Session ended" else reason.ifBlank { "Connection closed" }, false)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                feed.close()
                finish(reason.ifBlank { "Connection closed" }, false)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                feed.close()
                val why = when (response?.code) {
                    401 -> "Please log in again."
                    403 -> "The server refused the connection."
                    null -> mapTransportError(t).message
                    else -> "Connection failed (${response.code})."
                }
                finish(why, false)
            }
        })
        Thread({
            try {
                proto.run()
                finish("Connection closed", false)
            } catch (e: RfbException) {
                finish(e.message, e.authFailed)
            } catch (e: Exception) {
                finish(if (closedByUs) null else "Connection lost", false)
            } finally {
                socket?.cancel()
            }
        }, "vnc-rfb").apply { isDaemon = true }.start()
    }

    private fun finish(reason: String?, authFailed: Boolean) {
        synchronized(this) {
            if (finished) return
            finished = true
        }
        onClosed(if (closedByUs) null else reason, authFailed)
    }

    fun close() {
        closedByUs = true
        socket?.close(1000, null)
        feed.close()
    }
}
