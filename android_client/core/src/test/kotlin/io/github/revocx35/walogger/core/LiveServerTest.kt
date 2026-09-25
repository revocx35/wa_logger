package io.github.revocx35.walogger.core

import io.github.revocx35.walogger.core.vnc.Framebuffer
import io.github.revocx35.walogger.core.vnc.Rect
import io.github.revocx35.walogger.core.vnc.RfbListener
import io.github.revocx35.walogger.core.vnc.VncConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * End-to-end check of the client code against a real wa_logger stack (opt-in):
 *   WAL_IT_BASE=https://localhost:28443 WAL_IT_USER=owner WAL_IT_PASSWORD=… [WAL_IT_CA=root.crt]
 *   ./gradlew :core:test --tests '*LiveServerTest*'
 * Expects the sample data from server/src/testutil/seed.ts. Never prints message content.
 */
class LiveServerTest {
    private val base = System.getenv("WAL_IT_BASE").orEmpty()

    private fun client(): OkHttpClient {
        val jar = object : CookieJar {
            val cookies = ArrayList<Cookie>()
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
                for (c in cookies) { this.cookies.removeAll { it.name == c.name }; this.cookies.add(c) }
            }
            override fun loadForRequest(url: HttpUrl) = cookies.filter { it.matches(url) }
        }
        val b = OkHttpClient.Builder().cookieJar(jar)
        System.getenv("WAL_IT_CA")?.takeIf { it.isNotEmpty() }?.let { path ->
            val ca = CertificateFactory.getInstance("X.509").generateCertificate(File(path).inputStream())
            val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("ca", ca) }
            val tm = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }.trustManagers[0] as X509TrustManager
            b.sslSocketFactory(SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }.socketFactory, tm)
        }
        return b.build()
    }

    @Test
    fun fullClientFlow() = runBlocking {
        assumeTrue("set WAL_IT_BASE to run", base.isNotEmpty())
        val api = ApiClient(client(), parseServerUrl(base)!!)

        // Server check + login (the app's flow)
        val before = api.probe()
        assertTrue(before.hasOwner)
        assertTrue(api.login(System.getenv("WAL_IT_USER")!!, System.getenv("WAL_IT_PASSWORD")!!, null).ok)
        val st = api.state()
        assertTrue(st.authenticated)
        api.csrfToken = st.csrfToken

        // CSRF is enforced for non-GET requests (and our Origin header is accepted).
        val token = api.csrfToken
        api.csrfToken = null
        val noCsrf = runCatching { api.waRestart() }.exceptionOrNull() as ApiException
        assertEquals(403, noCsrf.status)
        api.csrfToken = token
        val settings = api.settings()
        assertEquals(settings, api.updateSettings(SettingsPatch(historyPerChat = settings.historyPerChat)))

        // Chats and messages (decrypted by the server for this session)
        val chats = api.chats()
        println("chats: ${chats.size}")
        val ali = chats.first { it.name == "Ali Yılmaz" }
        val group = chats.first { it.kind == ChatKind.Group }
        assertTrue(ali.deletedCount >= 1)
        val page = api.messages(ali.id)
        assertTrue(page.messages.size >= 8)
        val deleted = page.messages.first { it.deletedAt != null }
        assertNotNull(deleted.text) // the logged copy survives the revoke
        val edited = page.messages.first { it.edited }
        assertEquals(1, api.edits(edited.id).size)
        assertEquals(edited.id, api.message(edited.id).id)
        val around = api.messagesAround(ali.id, deleted.id, 4)
        assertTrue(around.messages.any { it.id == deleted.id })
        val quoted = page.messages.first { it.quoted?.id != null }
        assertTrue("quote points at a logged message", page.messages.any { it.id == quoted.quoted!!.id })
        val groupPage = api.messages(group.id)
        assertTrue(groupPage.messages.any { it.type == MessageType.Poll && it.poll != null })
        assertTrue(groupPage.messages.any { it.deletedBy == "admin" })
        assertTrue(api.deleted().items.isNotEmpty())
        assertTrue(api.search("secret").hits.isNotEmpty())

        // Media: authenticated, Range-served, decrypted
        val image = page.messages.first { it.type == MessageType.Image && it.media?.url != null }
        val mediaUrl = api.mediaUrl(image.media!!.url)!!
        api.http.newCall(Request.Builder().url(mediaUrl).header("Range", "bytes=0-7").build()).await().use { res ->
            assertEquals(206, res.code)
            assertTrue(res.body.bytes().contentEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)))
        }

        // Live events
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val events = EventStream(api, scope)
        events.start()
        val first = withTimeout(15_000) { events.events.first() }
        assertTrue(first is ServerEvent.WaStateChanged)
        println("wa state: ${(first as ServerEvent.WaStateChanged).status.state}")
        events.stop()

        // VNC through the app's authenticated WebSocket bridge to the real x11vnc
        val password = api.vncCredentials().password
        val connected = CountDownLatch(1)
        val updated = CountDownLatch(1)
        var shot: Framebuffer? = null
        var closeReason: String? = "open"
        val vnc = VncConnection(api, password, object : RfbListener {
            override fun onConnected(fb: Framebuffer, name: String) {
                println("vnc: ${fb.width}x${fb.height}")
                connected.countDown()
            }
            override fun onUpdate(fb: Framebuffer, dirty: Rect) {
                if (dirty.w * dirty.h > fb.width * fb.height / 4) { shot = fb; updated.countDown() }
            }
        }) { reason, _ -> closeReason = reason }
        vnc.start()
        assertTrue("VNC handshake (reason: $closeReason)", connected.await(20, TimeUnit.SECONDS))
        assertTrue("VNC framebuffer update", updated.await(30, TimeUnit.SECONDS))
        val px = shot!!.pixels
        assertTrue("screen has content", px.distinct().size > 10)
        System.getenv("WAL_IT_VNC_PNG")?.let { out ->
            val img = java.awt.image.BufferedImage(shot!!.width, shot!!.height, java.awt.image.BufferedImage.TYPE_INT_RGB)
            img.setRGB(0, 0, shot!!.width, shot!!.height, px, 0, shot!!.width)
            javax.imageio.ImageIO.write(img, "png", File(out))
        }
        vnc.protocol!!.pointer(10, 10, 0) // input path works without breaking the stream
        Thread.sleep(500)
        vnc.close()
        scope.cancel()

        // Logout ends the session
        api.logout()
        assertFalse(api.state().authenticated)
    }
}
