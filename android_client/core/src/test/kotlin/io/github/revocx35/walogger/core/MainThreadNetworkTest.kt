package io.github.revocx35.walogger.core

import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.FilterInputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/**
 * Android throws NetworkOnMainThreadException when the main thread reads from a socket. The JVM
 * doesn't, so this test recreates the rule: sockets refuse reads on the thread named "main-ui",
 * and the API client is called from that thread like the app's view models do.
 */
class MainThreadNetworkTest {
    private class GuardedSocket : Socket() {
        override fun getInputStream(): InputStream = object : FilterInputStream(super.getInputStream()) {
            private fun check() {
                if (Thread.currentThread().name.startsWith("main-ui")) throw IllegalStateException("NetworkOnMainThread: socket read on the UI thread")
            }
            override fun read(): Int { check(); return super.read() }
            override fun read(b: ByteArray, off: Int, len: Int): Int { check(); return super.read(b, off, len) }
        }
    }

    private val guarded = object : SocketFactory() {
        override fun createSocket() = GuardedSocket()
        override fun createSocket(h: String?, p: Int) = throw UnsupportedOperationException()
        override fun createSocket(h: String?, p: Int, l: InetAddress?, lp: Int) = throw UnsupportedOperationException()
        override fun createSocket(h: InetAddress?, p: Int) = throw UnsupportedOperationException()
        override fun createSocket(h: InetAddress?, p: Int, l: InetAddress?, lp: Int) = throw UnsupportedOperationException()
    }

    @Test
    fun largeResponsesAreNeverReadOnTheCallingUiThread() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            // A large, slowly delivered chat list: the body is still arriving after the headers.
            val chats = (1..400).joinToString(",", "[", "]") { """{"id":"$it@c.us","kind":"user","name":"Chat number $it with a longer name"}""" }
            server.enqueue(MockResponse.Builder().addHeader("Content-Type", "application/json").body(chats).throttleBody(4096, 20, TimeUnit.MILLISECONDS).build())
            val api = ApiClient(OkHttpClient.Builder().socketFactory(guarded).build(), parseServerUrl(server.url("/").toString())!!)
            val ui = Executors.newSingleThreadExecutor { Thread(it, "main-ui") }.asCoroutineDispatcher()
            val list = withContext(ui) { api.chats() }
            assertEquals(400, list.size)
            ui.close()
        }
    }
}
