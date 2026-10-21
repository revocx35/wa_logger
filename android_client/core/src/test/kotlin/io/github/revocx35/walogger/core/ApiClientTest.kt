package io.github.revocx35.walogger.core

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
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
    fun sendsMessagesAndUploadsRawFiles() = runBlocking {
        api.csrfToken = "tok"
        server.enqueue(json("""{"id":"true_1@c.us_X"}"""))
        server.enqueue(json("""{"uploadId":"0123456789abcdef0123456789abcdef","size":3}"""))
        server.enqueue(json("""{"id":null}"""))
        server.enqueue(json("""{"ok":true}"""))
        server.enqueue(json("""{"chatId":"905551234567@c.us"}"""))
        assertEquals("true_1@c.us_X", api.sendText("1@c.us", "Merhaba\nikinci", "false_1@c.us_Q").id)
        val text = server.takeRequest()
        assertEquals("/api/chats/1%40c.us/send", text.target)
        assertEquals("tok", text.headers["X-CSRF-Token"])
        assertEquals("""{"text":"Merhaba\nikinci","quotedId":"false_1@c.us_Q"}""", text.body?.utf8())

        val up = api.upload(byteArrayOf(1, 2, 3).toRequestBody("image/jpeg".toMediaType()), "tatil fotoğrafı.jpg")
        assertEquals("0123456789abcdef0123456789abcdef", up.uploadId)
        val raw = server.takeRequest()
        assertEquals("/api/uploads", raw.target)
        assertEquals("tok", raw.headers["X-CSRF-Token"])
        assertEquals("image/jpeg", raw.headers["X-File-Type"])
        assertEquals("tatil%20fotoğrafı.jpg".replace("ğ", "%C4%9F").replace("ı", "%C4%B1"), raw.headers["X-Filename"])
        assertEquals(3, raw.body?.size?.toInt())
        assertEquals(api.origin, raw.headers["Origin"])

        api.sendMedia("1@c.us", up.uploadId, SendMediaKind.Voice, " ", null)
        assertEquals("""{"uploadId":"0123456789abcdef0123456789abcdef","kind":"voice"}""", server.takeRequest().body?.utf8())
        api.react("m 1", "")
        val react = server.takeRequest()
        assertEquals("/api/messages/m%201/react", react.target)
        assertEquals("""{"emoji":""}""", react.body?.utf8())
        assertEquals("905551234567@c.us", api.newChat("+90 555").chatId)
    }

    @Test
    fun mapsUploadErrors() = runBlocking {
        server.enqueue(json("", 413))
        server.enqueue(json("""{"error":{"code":"conflict","message":"Too many files waiting to be sent."}}""", 409))
        for (expected in listOf("too_large" to "The file is too large (64 MB at most).", "conflict" to "Too many files waiting to be sent.")) {
            try {
                api.upload(byteArrayOf(1).toRequestBody(null), null)
                fail("expected an error")
            } catch (e: ApiException) {
                assertEquals(expected, e.code to e.message)
            }
        }
    }

    @Test
    fun readsTheMediaFeed() = runBlocking {
        server.enqueue(json("""{"items":[],"cursor":"41","more":false}"""))
        server.enqueue(json("""{"items":[{"chat":{"id":"1@c.us","name":"A","kind":"user"},"message":{"id":"m1","chatId":"1@c.us","type":"image","ts":5,"media":{"status":"downloaded","url":"/api/media/42","mime":"image/jpeg"}}}],"cursor":"42","more":true}"""))
        assertEquals("41", api.mediaFeed(null).cursor)
        assertEquals("/api/media-feed?limit=50", server.takeRequest().target)
        val page = api.mediaFeed("41", 10)
        assertEquals("/api/media-feed?limit=10&after=41", server.takeRequest().target)
        assertEquals("/api/media/42", page.items.single().message.media?.url)
        assertEquals(true, page.more)
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

    @Test
    fun claimsATemporaryPasswordAndParsesTheLoginHint() = runBlocking {
        api.csrfToken = "tok"
        server.enqueue(json("""{"ok":false,"mustChangePassword":true,"needRecoveryKey":true}"""))
        server.enqueue(json("""{"recoveryKey":"AAAA-BBBB"}"""))
        val login = api.login("ali", "temp-password-123", null)
        assertEquals(true, login.mustChangePassword)
        assertEquals(true, login.needRecoveryKey)
        server.takeRequest()
        assertEquals("AAAA-BBBB", api.claim("ali", "temp-password-123", "my own passphrase", "KEY").recoveryKey)
        val req = server.takeRequest()
        assertEquals("/api/auth/claim", req.target)
        assertEquals("""{"username":"ali","password":"temp-password-123","newPassword":"my own passphrase","recoveryKey":"KEY"}""", req.body?.utf8())
    }

    @Test
    fun adminCallsSendExplicitNullsAndParseTheOverview() = runBlocking {
        api.csrfToken = "tok"
        server.enqueue(json("""{"currentUserId":1,"users":[{"id":1,"username":"owner","role":"admin","disabled":false,"port":null,"createdAt":1,"lastLoginAt":2,"status":"active","wa":"ready"},{"id":2,"username":"ali","role":"user","disabled":true,"port":8443,"createdAt":1,"lastLoginAt":null,"status":"pending","wa":null}],"defaultPort":443,"defaultOrigin":null,"ports":[{"port":8443,"origin":null,"usernames":["ali"]}],"availablePorts":[8443,8444],"maxUsers":10}"""))
        server.enqueue(json("""{"user":{"id":3,"username":"bo","role":"user","disabled":false,"port":null,"createdAt":1,"lastLoginAt":null,"status":"pending","wa":null},"temporaryPassword":"abcde-fghjk-mnpqr-stuvw"}"""))
        server.enqueue(json("""{"id":2,"username":"ali","role":"user","disabled":false,"port":null,"createdAt":1,"lastLoginAt":null,"status":"pending","wa":null}"""))
        server.enqueue(json("""{"ok":true}"""))
        server.enqueue(json("""{"temporaryPassword":"x-y","mode":"wipe"}"""))
        val o = api.adminOverview()
        assertEquals(WaState.Ready, o.users[0].wa)
        assertEquals(UserRole.Admin, o.users[0].role)
        assertEquals(UserStatus.Pending, o.users[1].status)
        assertTrue(o.users[1].disabled)
        assertEquals(listOf(8443, 8444), o.availablePorts)
        assertEquals(listOf("ali"), o.ports[0].usernames)
        assertEquals("/api/admin/overview", server.takeRequest().target)

        val created = api.adminCreateUser("bo", null, null)
        assertEquals("abcde-fghjk-mnpqr-stuvw", created.temporaryPassword)
        val post = server.takeRequest()
        assertEquals("""{"username":"bo","port":null}""", post.body?.utf8())
        assertEquals("tok", post.headers["X-CSRF-Token"])

        api.adminSetUserPort(2, null)
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertEquals("/api/admin/users/2", patch.target)
        assertEquals("""{"port":null}""", patch.body?.utf8())

        api.adminPutPort(8444, null)
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("""{"origin":null}""", put.body?.utf8())

        val reset = api.adminResetUser(2, ResetMode.Wipe, null, "admin-pass", "123456")
        assertEquals(ResetOutcome.Wipe, reset.mode)
        assertEquals("""{"mode":"wipe","adminPassword":"admin-pass","totp":"123456"}""", server.takeRequest().body?.utf8())
    }

    @Test
    fun adminBlockedContactsAreListedAndSavedAsAWholeList() = runBlocking {
        api.csrfToken = "tok"
        server.enqueue(json("""{"contacts":[{"phone":"905559990001","label":"Ahmet Reis","blocked":true},{"phone":"905551112233","label":null,"blocked":false}]}"""))
        server.enqueue(json("""{"ok":true,"count":1}"""))
        val list = api.adminBlocking(2)
        assertEquals("/api/admin/users/2/blocking", server.takeRequest().target)
        assertEquals(listOf("905559990001"), list.contacts.filter { it.blocked }.map { it.phone })
        assertEquals(null, list.contacts[1].label)
        assertEquals(1, api.adminSetBlocking(2, listOf("905559990001")).count)
        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("""{"phones":["905559990001"]}""", put.body?.utf8())
    }

    @Test
    fun recordsCallsAndListsRecordings() = runBlocking {
        api.csrfToken = "tok"
        server.enqueue(json("""{"id":"C1","direction":"incoming","state":"active","recording":true}"""))
        server.enqueue(json("""{"items":[{"id":7,"chatId":"905551112233@c.us","name":"Ali","direction":"outgoing","video":true,"auto":true,"startedAt":5,"durationMs":65000,"status":"ready","url":"/api/media/12","size":1000},{"id":8,"status":"processing"}],"nextBefore":8}"""))
        server.enqueue(json("""{"ok":true}"""))
        val call = api.setCallRecording("C1", true)
        assertTrue(call.recording)
        val post = server.takeRequest()
        assertEquals("/api/calls/C1/recording", post.target)
        assertEquals("""{"on":true}""", post.body?.utf8())
        assertEquals("tok", post.headers["X-CSRF-Token"])

        val page = api.callRecordings(before = 20)
        assertEquals("/api/call-recordings?limit=30&before=20", server.takeRequest().target)
        assertEquals(8, page.nextBefore)
        assertEquals(CallRecordingStatus.Ready, page.items[0].status)
        assertEquals("/api/media/12", page.items[0].url)
        assertTrue(page.items[0].video && page.items[0].auto)
        assertEquals(CallRecordingStatus.Processing, page.items[1].status)

        api.deleteCallRecording(7)
        val del = server.takeRequest()
        assertEquals("DELETE", del.method)
        assertEquals("/api/call-recordings/7", del.target)
    }

    @Test
    fun parsesTheRecordingEventAndSetting() {
        val ev = WaJson.decodeFromString(ServerEvent.serializer(), """{"type":"call_recording","id":3,"status":"ready"}""")
        assertEquals(ServerEvent.CallRecordingChanged(3, "ready"), ev)
        assertEquals(true, WaJson.decodeFromString(Settings.serializer(), """{"recordCalls":true}""").recordCalls)
        assertEquals("""{"recordCalls":true}""", WaJson.encodeToString(SettingsPatch.serializer(), SettingsPatch(recordCalls = true)))
    }
}
