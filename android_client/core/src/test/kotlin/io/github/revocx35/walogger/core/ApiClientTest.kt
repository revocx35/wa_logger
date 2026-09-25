package io.github.revocx35.walogger.core

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class ApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = ApiClient(OkHttpClient(), parseServerUrl(server.url("/").toString())!!)
    }

    @After
    fun tearDown() = server.close()

    private fun json(body: String, code: Int = 200) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    @Test
    fun sendsOriginAndCsrfLikeTheBrowser() = runBlocking {
        server.enqueue(json("""{"hasOwner":true,"authenticated":true,"onboardingComplete":true,"csrfToken":"tok","wa":{"state":"ready","mediaQueue":0,"since":1,"newField":1}}"""))
        server.enqueue(json("""{"ok":true}"""))
        val st = api.state()
        assertEquals(WaState.Ready, st.wa?.state)
        api.csrfToken = st.csrfToken
        api.waRestart()
        val get = server.takeRequest()
        assertEquals("GET", get.method)
        assertEquals(api.origin, get.headers["Origin"])
        assertNull(get.headers["X-CSRF-Token"])
        val post = server.takeRequest()
        assertEquals("POST", post.method)
        assertEquals("tok", post.headers["X-CSRF-Token"])
        assertEquals("http://${server.hostName}:${server.port}", post.headers["Origin"])
        assertTrue(post.headers["Content-Type"]!!.startsWith("application/json"))
        assertEquals("{}", post.body?.utf8())
    }

    @Test
    fun omitsEmptyOptionalFieldsAndEncodesPaths() = runBlocking {
        server.enqueue(json("""{"ok":false,"needTotp":true}"""))
        server.enqueue(json("""{"messages":[{"id":"m1","chatId":"1@c.us","type":"brand_new_type","media":{"status":"weird"}}],"nextBefore":null}"""))
        assertEquals(true, api.login("owner", "pw", null).needTotp)
        assertEquals("""{"username":"owner","password":"pw"}""", server.takeRequest().body?.utf8())
        val page = api.messages("123@g.us", "5_6")
        assertEquals(MessageType.Unknown, page.messages[0].type)
        assertEquals(MediaStatus.None, page.messages[0].media?.status)
        assertEquals("/api/chats/123%40g.us/messages?limit=60&before=5_6", server.takeRequest().target)
    }

    @Test
    fun mapsErrorsAndUnauthorized() = runBlocking {
        var unauthorized = 0
        api.onUnauthorized = { unauthorized++ }
        server.enqueue(json("""{"error":{"code":"rate_limited","message":"Too many attempts.","retryAfter":30}}""", 429))
        server.enqueue(json("""{"error":{"code":"unauthorized","message":"Please log in."}}""", 401))
        server.enqueue(MockResponse.Builder().code(301).addHeader("Location", "https://example.test/").build())
        server.enqueue(MockResponse.Builder().code(200).body("<html>not json</html>").build())
        try { api.chats(); fail() } catch (e: ApiException) {
            assertEquals("rate_limited", e.code)
            assertEquals("Too many attempts. (retry in 30s)", e.userMessage)
        }
        try { api.chats(); fail() } catch (e: ApiException) { assertEquals(401, e.status) }
        assertEquals(1, unauthorized)
        try { api.state(); fail() } catch (e: ApiException) {
            assertEquals(ApiException.REDIRECT, e.code)
            assertTrue(e.message.contains("https://example.test"))
        }
        try { api.state(); fail() } catch (e: ApiException) { assertEquals(ApiException.NOT_WA_LOGGER, e.code) }
    }

    @Test
    fun networkErrorsAreFriendly() = runBlocking {
        val dead = ApiClient(OkHttpClient(), "http://127.0.0.1:1/".toHttpUrl())
        try { dead.state(); fail() } catch (e: ApiException) { assertEquals(ApiException.NETWORK, e.code) }
    }

    @Test
    fun serverUrlParsing() {
        assertEquals("https://wa.example.com/", parseServerUrl("wa.example.com")?.toString())
        assertEquals("http://192.168.68.19/", parseServerUrl(" http://192.168.68.19/login?x=1 ")?.toString())
        assertEquals("https://h:8443/", parseServerUrl("https://h:8443")?.toString())
        assertNull(parseServerUrl("ftp://x"))
        assertNull(parseServerUrl("https://user:pw@x"))
        assertNull(parseServerUrl("a b"))
        assertEquals("https://h:8443", parseServerUrl("https://h:8443")!!.originString())
        assertEquals("http://192.168.68.19", parseServerUrl("http://192.168.68.19")!!.originString())
        assertTrue(isLocalHost("192.168.68.19"))
        assertTrue(isLocalHost("10.1.2.3"))
        assertTrue(isLocalHost("nas.local"))
        assertTrue(!isLocalHost("172.32.0.1"))
        assertTrue(!isLocalHost("wa.example.com"))
        assertTrue(!isLocalHost("8.8.8.8"))
    }

    @Test
    fun parsesServerEvents() {
        val ev = WaJson.decodeFromString(ServerEvent.serializer(), """{"type":"message_update","chatId":"a@c.us","messageId":"m","reason":"deleted"}""")
        assertEquals(ServerEvent.MessageUpdate("a@c.us", "m", "deleted"), ev)
        assertEquals(ServerEvent.SessionRevoked, WaJson.decodeFromString(ServerEvent.serializer(), """{"type":"session_revoked"}"""))
        val sync = WaJson.decodeFromString(ServerEvent.serializer(), """{"type":"sync_progress","sync":null}""")
        assertEquals(ServerEvent.SyncProgressChanged(null), sync)
    }
}
