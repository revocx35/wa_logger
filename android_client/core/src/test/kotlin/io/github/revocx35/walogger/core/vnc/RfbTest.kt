package io.github.revocx35.walogger.core.vnc

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.Deflater
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

/** A tiny ZRLE encoder for tests: one zlib stream across rectangles, sync-flushed per rectangle. */
private class ZrleEncoder {
    private val deflater = Deflater()

    fun rect(tiles: ByteArray): ByteArray {
        deflater.setInput(tiles)
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        while (true) {
            val n = deflater.deflate(buf, 0, buf.size, Deflater.SYNC_FLUSH)
            out.write(buf, 0, n)
            if (n < buf.size) break
        }
        return out.toByteArray()
    }
}

private fun cpixel(argb: Int) = byteArrayOf(argb.toByte(), (argb shr 8).toByte(), (argb shr 16).toByte())
private const val RED = 0xFFFF0000.toInt()
private const val GREEN = 0xFF00FF00.toInt()
private const val BLUE = 0xFF0000FF.toInt()
private const val GRAY = 0xFF808080.toInt()

class ZrleDecoderTest {
    @Test
    fun decodesAllSubencodings() {
        val fb = Framebuffer(80, 70) // 2×2 tiles: 64×64, 16×64, 64×6, 16×6
        val dec = ZrleDecoder()
        val enc = ZrleEncoder()
        val t = ByteArrayOutputStream()
        // tile (0,0) 64×64: solid red
        t.write(1); t.write(cpixel(RED))
        // tile (64,0) 16×64: packed palette of 2 (1 bit), alternating columns green/blue
        t.write(2); t.write(cpixel(GREEN)); t.write(cpixel(BLUE))
        repeat(64) { t.write(0b01010101); t.write(0b01010101) }
        // tile (0,64) 64×6: plain RLE: 100 gray, rest green (284)
        t.write(128); t.write(cpixel(GRAY)); t.write(99); t.write(cpixel(GREEN)); t.write(255); t.write(28)
        // tile (64,64) 16×6: palette RLE: [red, blue]; 10 red (run), 1 blue (single), 85 red (run)
        t.write(130); t.write(cpixel(RED)); t.write(cpixel(BLUE))
        t.write(0x80); t.write(9); t.write(1); t.write(0x80); t.write(84)
        dec.decode(enc.rect(t.toByteArray()), 0, 0, 80, 70, fb)

        val px = fb.pixels
        assertEquals(RED, px[0])
        assertEquals(RED, px[63 * 80 + 63])
        assertEquals(GREEN, px[64])
        assertEquals(BLUE, px[65])
        assertEquals(BLUE, px[63 * 80 + 79])
        assertEquals(GRAY, px[64 * 80 + 0])
        assertEquals(GRAY, px[64 * 80 + 63]) // 64th pixel of the tile
        assertEquals(GRAY, px[65 * 80 + 35]) // 100th pixel
        assertEquals(GREEN, px[65 * 80 + 36])
        assertEquals(GREEN, px[69 * 80 + 63])
        assertEquals(RED, px[64 * 80 + 64 + 9])
        assertEquals(BLUE, px[64 * 80 + 64 + 10])
        assertEquals(RED, px[69 * 80 + 79])

        // The zlib stream continues across rectangles: a raw 2×1 tile.
        val t2 = ByteArrayOutputStream()
        t2.write(0); t2.write(cpixel(BLUE)); t2.write(cpixel(GREEN))
        dec.decode(enc.rect(t2.toByteArray()), 10, 5, 2, 1, fb)
        assertEquals(BLUE, px[5 * 80 + 10])
        assertEquals(GREEN, px[5 * 80 + 11])
        assertEquals(RED, px[5 * 80 + 12])
    }
}

/** A scripted RFB 3.8 server on the other end of a [ByteFeed]. */
class RfbProtocolTest {
    @Test
    fun handshakeAuthUpdatesAndInput() {
        val toClient = ByteFeed()
        val fromClient = java.util.concurrent.LinkedBlockingQueue<ByteArray>()
        val challenge = ByteArray(16) { it.toByte() }
        val connected = CountDownLatch(1)
        val updated = CountDownLatch(2)
        var lastDirty: Rect? = null
        val proto = RfbProtocol("secret-vnc-pw", toClient, { fromClient.put(it) }, object : RfbListener {
            override fun onConnected(fb: Framebuffer, name: String) {
                assertEquals("chromium", name)
                connected.countDown()
            }

            override fun onUpdate(fb: Framebuffer, dirty: Rect) {
                lastDirty = dirty
                updated.countDown()
            }
        })
        val thread = Thread { runCatching { proto.run() } }.apply { start() }

        toClient.feed("RFB 003.008\n".toByteArray())
        assertEquals("RFB 003.008\n", String(fromClient.poll(2, TimeUnit.SECONDS)!!))
        toClient.feed(byteArrayOf(2, 1, 2)) // two security types: None, VNC auth
        assertArrayEquals(byteArrayOf(2), fromClient.poll(2, TimeUnit.SECONDS))
        toClient.feed(challenge)
        val response = fromClient.poll(2, TimeUnit.SECONDS)!!
        // Independent check of the VNC DES key rule: bits of every key byte reversed.
        val key = "secret-v".toByteArray().map { (Integer.reverse(it.toInt() and 0xFF) ushr 24).toByte() }.toByteArray()
        val expected = Cipher.getInstance("DES/ECB/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "DES")) }.doFinal(challenge)
        assertArrayEquals(expected, response)
        toClient.feed(byteArrayOf(0, 0, 0, 0)) // SecurityResult OK
        assertArrayEquals(byteArrayOf(1), fromClient.poll(2, TimeUnit.SECONDS)) // ClientInit shared
        // ServerInit 4×2, name "chromium"
        toClient.feed(byteArrayOf(0, 4, 0, 2) + ByteArray(16) + byteArrayOf(0, 0, 0, 8) + "chromium".toByteArray())
        assertEquals(0, fromClient.poll(2, TimeUnit.SECONDS)!![0].toInt()) // SetPixelFormat
        assertEquals(2, fromClient.poll(2, TimeUnit.SECONDS)!![0].toInt()) // SetEncodings
        assertArrayEquals(RfbMessages.updateRequest(false, 0, 0, 4, 2), fromClient.poll(2, TimeUnit.SECONDS))
        assertTrue(connected.await(2, TimeUnit.SECONDS))

        // FramebufferUpdate: raw 2×1 at (1,1) + CopyRect of it to (0,0)
        val raw = byteArrayOf(0, 0, 0, 1, 0, 1, 0, 1, 0, 2, 0, 1, 0, 0, 0, 0) +
            byteArrayOf(0x33, 0x22, 0x11, 0, 0x66, 0x55, 0x44, 0)
        toClient.feed(raw)
        assertArrayEquals(RfbMessages.updateRequest(true, 0, 0, 4, 2), fromClient.poll(2, TimeUnit.SECONDS))
        toClient.feed(byteArrayOf(0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1))
        assertArrayEquals(RfbMessages.updateRequest(true, 0, 0, 4, 2), fromClient.poll(2, TimeUnit.SECONDS))
        assertTrue(updated.await(2, TimeUnit.SECONDS))
        val px = proto.framebuffer!!.pixels
        assertEquals(0xFF112233.toInt(), px[1 * 4 + 1])
        assertEquals(0xFF445566.toInt(), px[1 * 4 + 2])
        assertEquals(0xFF112233.toInt(), px[0])
        assertEquals(0xFF445566.toInt(), px[1])
        assertEquals(Rect(0, 0, 2, 1), lastDirty)

        // Server cut text is skipped (never kept), bell ignored.
        toClient.feed(byteArrayOf(3, 0, 0, 0, 0, 0, 0, 3) + "abc".toByteArray() + byteArrayOf(2))

        // Input
        proto.click(2, 1)
        assertArrayEquals(RfbMessages.pointer(0, 2, 1), fromClient.poll(2, TimeUnit.SECONDS))
        assertArrayEquals(RfbMessages.pointer(1, 2, 1), fromClient.poll(2, TimeUnit.SECONDS))
        assertArrayEquals(RfbMessages.pointer(0, 2, 1), fromClient.poll(2, TimeUnit.SECONDS))
        proto.type("Aş")
        assertArrayEquals(RfbMessages.key('A'.code, true), fromClient.poll(2, TimeUnit.SECONDS))
        assertArrayEquals(RfbMessages.key('A'.code, false), fromClient.poll(2, TimeUnit.SECONDS))
        assertArrayEquals(RfbMessages.key(0x0100015F, true), fromClient.poll(2, TimeUnit.SECONDS))

        toClient.close()
        thread.join(2000)
        assertTrue(!thread.isAlive)
    }

    @Test
    fun authFailureIsReported() {
        val toClient = ByteFeed()
        val proto = RfbProtocol("pw", toClient, {}, object : RfbListener {})
        toClient.feed("RFB 003.008\n".toByteArray())
        toClient.feed(byteArrayOf(1, 2) + ByteArray(16) + byteArrayOf(0, 0, 0, 1, 0, 0, 0, 4) + "nope".toByteArray())
        val e = runCatching { proto.run() }.exceptionOrNull()
        assertTrue(e is RfbException && e.authFailed && e.message!!.contains("nope"))
    }
}

class DesTest {
    @Test
    fun matchesTheJdkImplementation() {
        val rnd = java.util.Random(42)
        repeat(200) {
            val key = ByteArray(8).also(rnd::nextBytes)
            val data = ByteArray(16).also(rnd::nextBytes)
            val jdk = Cipher.getInstance("DES/ECB/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "DES")) }.doFinal(data)
            assertArrayEquals(jdk, Des.encryptEcb(key, data))
        }
        // FIPS 81 / classic test vector: key 133457799BBCDFF1, plaintext 0123456789ABCDEF → 85E813540F0AB405
        val key = byteArrayOf(0x13, 0x34, 0x57, 0x79, 0x9B.toByte(), 0xBC.toByte(), 0xDF.toByte(), 0xF1.toByte())
        val pt = byteArrayOf(0x01, 0x23, 0x45, 0x67, 0x89.toByte(), 0xAB.toByte(), 0xCD.toByte(), 0xEF.toByte())
        assertArrayEquals(byteArrayOf(0x85.toByte(), 0xE8.toByte(), 0x13, 0x54, 0x0F, 0x0A, 0xB4.toByte(), 0x05), Des.encryptEcb(key, pt))
    }
}
