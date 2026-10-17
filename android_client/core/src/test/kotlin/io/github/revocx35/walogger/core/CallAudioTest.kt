package io.github.revocx35.walogger.core

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class CallAudioTest {
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

    private fun pcm(vararg samples: Int): ByteArray = ByteArray(samples.size * 2).also { b ->
        samples.forEachIndexed { i, v ->
            b[2 * i] = (v and 0xff).toByte()
            b[2 * i + 1] = (v shr 8).toByte()
        }
    }

    @Test
    fun jitterBufferPrebuffersPlaysAndDropsBacklog() {
        val jb = JitterBuffer(prebufferMs = 40, maxMs = 100)
        val out = ShortArray(CALL_FRAME)
        jb.add(pcm(*IntArray(CALL_FRAME) { 1000 })) // 20 ms < 40 ms prebuffer
        assertEquals(0, jb.read(out))
        assertTrue(out.all { it == 0.toShort() })
        jb.add(pcm(*IntArray(CALL_FRAME) { -2 }))
        assertEquals(CALL_FRAME, jb.read(out))
        assertTrue(out.all { it == 1000.toShort() })
        assertEquals(CALL_FRAME, jb.read(out))
        assertTrue(out.all { it == (-2).toShort() })
        // ran dry: silence until the next prebuffer
        jb.add(pcm(*IntArray(CALL_FRAME) { 5 }))
        assertEquals(0, jb.read(out))
        // a 200 ms burst keeps at most 100 ms (+ one chunk)
        repeat(10) { jb.add(pcm(*IntArray(CALL_FRAME) { 7 })) }
        assertTrue(jb.available() <= CALL_RATE / 10 + CALL_FRAME)
        // partial reads across chunk boundaries
        val small = ShortArray(100)
        assertEquals(100, jb.read(small))
    }

    @Test
    fun decodesCallEventsAndCurrentCall() {
        val ev = WaJson.decodeFromString(ServerEvent.serializer(), """{"type":"call","call":{"id":"C1","direction":"incoming","state":"incoming","video":false,"group":false,"chatId":"1@c.us","startedAt":5,"connectedAt":null,"endedAt":null,"endReason":null,"audio":false,"newField":1}}""")
        val call = (ev as ServerEvent.CallChanged).call
        assertEquals(CallState.Incoming, call.state)
        assertTrue(call.incoming && call.live)
        // unknown states from a newer server don't crash
        val cur = WaJson.decodeFromString(CurrentCall.serializer(), """{"call":{"id":"C2","direction":"outgoing","state":"onhold","name":"Ali"},"available":true}""")
        assertEquals(CallState.Ended, cur.call!!.state)
        assertEquals("Ali", cur.call!!.name)
    }

    @Test
    fun callEndpointsSendCsrfAndEmptyBodies() = runBlocking {
        api.csrfToken = "tok"
        server.enqueue(MockResponse.Builder().addHeader("Content-Type", "application/json").body("""{"id":"OUT1","direction":"outgoing","state":"calling"}""").build())
        server.enqueue(MockResponse.Builder().addHeader("Content-Type", "application/json").body("""{"ok":true}""").build())
        assertEquals(CallState.Calling, api.startCall("1@c.us").state)
        val start = server.takeRequest()
        assertEquals("/api/chats/1%40c.us/call", start.target)
        assertEquals("tok", start.headers["X-CSRF-Token"])
        assertEquals("{}", start.body?.utf8())
        api.hangupCall("OUT1")
        assertEquals("/api/calls/OUT1/hangup", server.takeRequest().target)
    }

    @Test
    fun audioSocketCarriesPcmBothWaysAndReportsTheEnd() {
        val received = CopyOnWriteArrayList<ByteString>()
        val serverSide = CountDownLatch(1)
        var peer: WebSocket? = null
        server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    peer = webSocket
                    webSocket.send("""{"type":"hello","sampleRate":16000,"channels":1,"format":"s16le","callId":"C1"}""")
                    webSocket.send(pcm(1, 2, 3).toByteString())
                    serverSide.countDown()
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    received.add(bytes)
                }
            }).build(),
        )
        val got = CopyOnWriteArrayList<ByteArray>()
        val ended = CountDownLatch(1)
        var why: CallAudioEnd? = null
        val socket = CallAudioSocket(api, { got.add(it) }, { w, _ ->
            why = w
            ended.countDown()
        })
        socket.start()
        assertTrue(serverSide.await(5, TimeUnit.SECONDS))
        val req = server.takeRequest()
        assertEquals("/api/calls/audio", req.target)
        assertEquals(api.origin, req.headers["Origin"])
        val deadline = System.currentTimeMillis() + 5000
        while (got.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertArrayEquals(pcm(1, 2, 3), got.single())
        assertEquals("C1", socket.callId)
        assertTrue(socket.send(pcm(9, 9)))
        while (received.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals(pcm(9, 9).toByteString(), received.single())
        peer!!.close(4000, "Replaced by another connection")
        assertTrue(ended.await(5, TimeUnit.SECONDS))
        assertEquals(CallAudioEnd.Replaced, why)
    }

    @Test
    fun videoHeaderRoundTrip() {
        val h = VideoFrameHeader(VIDEO_H264, key = true, rotation = 3, width = 640, height = 480, timestampMs = 0x1_2345_6789L)
        val f = h.frame(byteArrayOf(0, 0, 0, 1, 0x65))
        assertEquals(17, f.size)
        assertEquals(listOf(1, 1, 3, 0, 0x80, 2, 0xe0, 1), f.take(8).map { it.toInt() and 0xff })
        // the timestamp wraps at 32 bits
        assertEquals(h.copy(timestampMs = 0x2345_6789L), VideoFrameHeader.parse(f))
        assertEquals(null, VideoFrameHeader.parse(ByteArray(12)))
        assertEquals(null, VideoFrameHeader.parse(byteArrayOf(9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)))
    }

    @Test
    fun videoSocketCarriesFramesAndKeyFrameRequests() {
        val received = CopyOnWriteArrayList<Any>()
        val open = CountDownLatch(1)
        var peer: WebSocket? = null
        server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    peer = webSocket
                    webSocket.send("""{"type":"hello","callId":"C1","codecs":["h264","vp8"]}""")
                    webSocket.send("""{"type":"keyframe"}""")
                    webSocket.send(VideoFrameHeader(VIDEO_VP8, true, 1, 320, 240, 5).frame(byteArrayOf(7)).toByteString())
                    webSocket.send(byteArrayOf(3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1).toByteString()) // unknown codec: dropped
                    open.countDown()
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    received.add(text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    received.add(bytes)
                }
            }).build(),
        )
        val frames = CopyOnWriteArrayList<VideoFrameHeader>()
        var keyWanted = 0
        val ended = CountDownLatch(1)
        val sock = CallVideoSocket(api, { h, _ -> frames.add(h) }, { keyWanted++ }, { _, _ -> ended.countDown() })
        sock.start()
        assertTrue(open.await(5, TimeUnit.SECONDS))
        assertEquals("/api/calls/video", server.takeRequest().target)
        val deadline = System.currentTimeMillis() + 5000
        while ((frames.isEmpty() || keyWanted == 0) && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals(listOf(VideoFrameHeader(VIDEO_VP8, true, 1, 320, 240, 5)), frames.toList())
        assertEquals(1, keyWanted)
        sock.requestKeyFrame()
        assertTrue(sock.send(VideoFrameHeader(VIDEO_H264, false, 0, 640, 480, 9).frame(byteArrayOf(1, 2))))
        while (received.size < 2 && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals("""{"type":"keyframe"}""", received[0])
        assertEquals(14, (received[1] as ByteString).size)
        peer!!.close(1000, "Call ended")
        assertTrue(ended.await(5, TimeUnit.SECONDS))
    }
}
