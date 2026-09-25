package io.github.revocx35.walogger.core.vnc

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.zip.DataFormatException
import java.util.zip.Inflater

/*
 * Minimal RFB 3.3/3.7/3.8 client (RFC 6143) for viewing and driving the background Chromium's
 * x11vnc through the app's authenticated WebSocket bridge. Supports VNC authentication and the
 * Raw, CopyRect and ZRLE encodings plus the DesktopSize/LastRect pseudo-encodings — enough for
 * x11vnc. The WebSocket carries raw TCP bytes, so messages are parsed from a byte stream.
 */

/** 32-bit ARGB framebuffer written by the protocol thread. */
class Framebuffer(width: Int, height: Int) {
    var width: Int = width
        private set
    var height: Int = height
        private set
    var pixels: IntArray = IntArray(width * height)
        private set

    fun resize(w: Int, h: Int) {
        width = w
        height = h
        pixels = IntArray(w * h)
    }
}

data class Rect(val x: Int, val y: Int, val w: Int, val h: Int) {
    fun union(o: Rect?): Rect {
        if (o == null) return this
        val l = minOf(x, o.x)
        val t = minOf(y, o.y)
        return Rect(l, t, maxOf(x + w, o.x + o.w) - l, maxOf(y + h, o.y + o.h) - t)
    }
}

class RfbException(message: String, val authFailed: Boolean = false) : IOException(message)

/** An InputStream fed with chunks from another thread (the WebSocket), blocking until data arrives. */
class ByteFeed : InputStream() {
    private val queue = LinkedBlockingQueue<ByteArray>()
    private var current: ByteArray? = null
    private var pos = 0
    @Volatile private var closed = false

    fun feed(bytes: ByteArray) {
        if (bytes.isNotEmpty()) queue.put(bytes)
    }

    override fun close() {
        closed = true
        queue.put(EOF)
    }

    private fun ensure(): Boolean {
        while (current == null || pos >= current!!.size) {
            if (closed && queue.isEmpty()) return false
            val next = try {
                queue.take()
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                throw IOException("interrupted")
            }
            if (next === EOF) {
                queue.put(EOF)
                return false
            }
            current = next
            pos = 0
        }
        return true
    }

    override fun read(): Int {
        if (!ensure()) return -1
        return current!![pos++].toInt() and 0xFF
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (len == 0) return 0
        if (!ensure()) return -1
        val cur = current!!
        val n = minOf(len, cur.size - pos)
        System.arraycopy(cur, pos, b, off, n)
        pos += n
        return n
    }

    private companion object {
        val EOF = ByteArray(0)
    }
}

/** Big-endian reads over a stream. */
internal class RfbReader(private val input: InputStream) {
    fun fully(buf: ByteArray, off: Int = 0, len: Int = buf.size) {
        var done = 0
        while (done < len) {
            val n = input.read(buf, off + done, len - done)
            if (n < 0) throw EOFException("connection closed")
            done += n
        }
    }

    fun bytes(n: Int): ByteArray = ByteArray(n).also { fully(it) }
    fun u8(): Int = input.read().also { if (it < 0) throw EOFException("connection closed") }
    fun u16(): Int = (u8() shl 8) or u8()
    fun s32(): Int = (u8() shl 24) or (u8() shl 16) or (u8() shl 8) or u8()
    fun u32(): Long = s32().toLong() and 0xFFFFFFFFL
    fun skip(n: Long) {
        var left = n
        val scratch = ByteArray(8192)
        while (left > 0) {
            val chunk = minOf(left, scratch.size.toLong()).toInt()
            fully(scratch, 0, chunk)
            left -= chunk
        }
    }
}

object RfbMessages {
    const val ENC_RAW = 0
    const val ENC_COPYRECT = 1
    const val ENC_ZRLE = 16
    const val ENC_DESKTOP_SIZE = -223
    const val ENC_LAST_RECT = -224

    /** 32 bpp, depth 24, little-endian, true colour 0x00RRGGBB: wire bytes are B, G, R, pad. */
    fun setPixelFormat(): ByteArray = byteArrayOf(
        0, 0, 0, 0,
        32, 24, 0, 1,
        0, 255.toByte(), 0, 255.toByte(), 0, 255.toByte(),
        16, 8, 0,
        0, 0, 0,
    )

    fun setEncodings(encodings: IntArray): ByteArray {
        val out = ByteArray(4 + 4 * encodings.size)
        out[0] = 2
        out[2] = (encodings.size shr 8).toByte()
        out[3] = encodings.size.toByte()
        encodings.forEachIndexed { i, e -> putS32(out, 4 + i * 4, e) }
        return out
    }

    fun updateRequest(incremental: Boolean, x: Int, y: Int, w: Int, h: Int): ByteArray =
        byteArrayOf(3, if (incremental) 1 else 0, (x shr 8).toByte(), x.toByte(), (y shr 8).toByte(), y.toByte(), (w shr 8).toByte(), w.toByte(), (h shr 8).toByte(), h.toByte())

    fun key(keysym: Int, down: Boolean): ByteArray {
        val out = ByteArray(8)
        out[0] = 4
        out[1] = if (down) 1 else 0
        putS32(out, 4, keysym)
        return out
    }

    fun pointer(mask: Int, x: Int, y: Int): ByteArray =
        byteArrayOf(5, mask.toByte(), (x shr 8).toByte(), x.toByte(), (y shr 8).toByte(), y.toByte())

    private fun putS32(b: ByteArray, off: Int, v: Int) {
        b[off] = (v ushr 24).toByte()
        b[off + 1] = (v ushr 16).toByte()
        b[off + 2] = (v ushr 8).toByte()
        b[off + 3] = v.toByte()
    }

    /** VNC authentication: DES-encrypt the challenge with the password as key (bits of each byte mirrored). */
    fun vncAuthResponse(password: String, challenge: ByteArray): ByteArray {
        val key = ByteArray(8)
        val pw = password.toByteArray(Charsets.ISO_8859_1)
        for (i in 0 until minOf(8, pw.size)) key[i] = (Integer.reverse(pw[i].toInt() and 0xFF) ushr 24).toByte()
        return Des.encryptEcb(key, challenge)
    }

    /** X11 keysym for a typed character. */
    fun keysymFor(cp: Int): Int = when {
        cp == '\n'.code || cp == '\r'.code -> KEY_RETURN
        cp == '\t'.code -> KEY_TAB
        cp in 0x20..0x7E || cp in 0xA0..0xFF -> cp
        else -> 0x01000000 or cp
    }

    const val KEY_BACKSPACE = 0xFF08
    const val KEY_TAB = 0xFF09
    const val KEY_RETURN = 0xFF0D
    const val KEY_ESCAPE = 0xFF1B
    const val KEY_LEFT = 0xFF51
    const val KEY_UP = 0xFF52
    const val KEY_RIGHT = 0xFF53
    const val KEY_DOWN = 0xFF54
    const val KEY_DELETE = 0xFFFF
}

/**
 * ZRLE (RFC 6143 §7.7.6). One zlib stream spans the whole connection, so the decoder (and its
 * Inflater) lives as long as the connection. Assumes the pixel format from [RfbMessages.setPixelFormat],
 * for which a CPIXEL is 3 bytes: B, G, R.
 */
class ZrleDecoder {
    private val inflater = Inflater()
    private var out = ByteArray(64 * 64 * 4 * 2)
    private var outLen = 0
    private var outPos = 0
    private val palette = IntArray(128)
    private val tile = IntArray(64 * 64)

    fun decode(compressed: ByteArray, x: Int, y: Int, w: Int, h: Int, fb: Framebuffer) {
        inflater.setInput(compressed)
        outLen = 0
        outPos = 0
        var ty = y
        while (ty < y + h) {
            val th = minOf(64, y + h - ty)
            var tx = x
            while (tx < x + w) {
                val tw = minOf(64, x + w - tx)
                decodeTile(tw, th)
                blit(fb, tx, ty, tw, th)
                tx += 64
            }
            ty += 64
        }
        // Drain whatever else this rectangle's data produces (nothing, for a well-formed stream).
        val scratch = ByteArray(1024)
        try {
            while (!inflater.needsInput() && !inflater.finished()) {
                if (inflater.inflate(scratch) == 0) break
            }
        } catch (e: DataFormatException) {
            throw RfbException("Corrupt ZRLE data")
        }
    }

    fun end() = inflater.end()

    private fun more() {
        if (outPos < outLen) {
            System.arraycopy(out, outPos, out, 0, outLen - outPos)
            outLen -= outPos
        } else {
            outLen = 0
        }
        outPos = 0
        if (outLen == out.size) out = out.copyOf(out.size * 2)
        val n = try {
            inflater.inflate(out, outLen, out.size - outLen)
        } catch (e: DataFormatException) {
            throw RfbException("Corrupt ZRLE data")
        }
        if (n == 0 && (inflater.needsInput() || inflater.finished())) throw RfbException("Truncated ZRLE data")
        outLen += n
    }

    private fun u8(): Int {
        while (outPos >= outLen) more()
        return out[outPos++].toInt() and 0xFF
    }

    private fun cpixel(): Int {
        while (outLen - outPos < 3) more()
        val b = out[outPos].toInt() and 0xFF
        val g = out[outPos + 1].toInt() and 0xFF
        val r = out[outPos + 2].toInt() and 0xFF
        outPos += 3
        return (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }

    private fun runLength(): Int {
        var len = 1
        var b: Int
        do {
            b = u8()
            len += b
        } while (b == 255)
        return len
    }

    private fun decodeTile(tw: Int, th: Int) {
        val total = tw * th
        val sub = u8()
        when {
            sub == 0 -> for (i in 0 until total) tile[i] = cpixel()
            sub == 1 -> tile.fill(cpixel(), 0, total)
            sub in 2..16 -> {
                for (i in 0 until sub) palette[i] = cpixel()
                val bits = if (sub == 2) 1 else if (sub <= 4) 2 else 4
                val mask = (1 shl bits) - 1
                var i = 0
                for (row in 0 until th) {
                    var shift = 8
                    var byte = 0
                    for (col in 0 until tw) {
                        if (shift == 8) {
                            byte = u8()
                            shift = 0
                        }
                        shift += bits
                        val idx = (byte shr (8 - shift)) and mask
                        tile[i++] = palette[idx.coerceAtMost(sub - 1)]
                    }
                }
            }
            sub == 128 -> {
                var i = 0
                while (i < total) {
                    val px = cpixel()
                    val len = runLength()
                    if (i + len > total) throw RfbException("Bad ZRLE run")
                    tile.fill(px, i, i + len)
                    i += len
                }
            }
            sub >= 130 -> {
                val size = sub - 128
                for (k in 0 until size) palette[k] = cpixel()
                var i = 0
                while (i < total) {
                    val idx = u8()
                    val len = if (idx and 0x80 != 0) runLength() else 1
                    val p = idx and 0x7F
                    if (p >= size || i + len > total) throw RfbException("Bad ZRLE palette run")
                    tile.fill(palette[p], i, i + len)
                    i += len
                }
            }
            else -> throw RfbException("Unsupported ZRLE subencoding $sub")
        }
    }

    private fun blit(fb: Framebuffer, tx: Int, ty: Int, tw: Int, th: Int) {
        val px = fb.pixels
        val stride = fb.width
        for (row in 0 until th) {
            val dy = ty + row
            if (dy >= fb.height) break
            val n = minOf(tw, stride - tx)
            if (n <= 0) break
            System.arraycopy(tile, row * tw, px, dy * stride + tx, n)
        }
    }
}

interface RfbListener {
    /** Handshake done; the framebuffer has its initial size. */
    fun onConnected(fb: Framebuffer, name: String) {}

    /** A complete framebuffer update was applied (called on the protocol thread). */
    fun onUpdate(fb: Framebuffer, dirty: Rect) {}

    /** The remote screen size changed (the framebuffer was reallocated). */
    fun onResize(fb: Framebuffer) {}
}

/**
 * The RFB protocol state machine. [run] blocks (call it on a dedicated thread) until the stream ends
 * or an error occurs. Input methods may be called from any thread.
 */
class RfbProtocol(
    private val password: String,
    private val input: InputStream,
    private val send: (ByteArray) -> Unit,
    private val listener: RfbListener,
) {
    private val r = RfbReader(input)
    private val zrle = ZrleDecoder()
    @Volatile var framebuffer: Framebuffer? = null
        private set
    @Volatile private var buttons = 0

    fun run() {
        try {
            handshake()
            loop()
        } finally {
            zrle.end()
        }
    }

    private fun handshake() {
        val version = String(r.bytes(12), Charsets.US_ASCII)
        val m = Regex("^RFB (\\d{3})\\.(\\d{3})\n$").matchEntire(version) ?: throw RfbException("Not a VNC server")
        val major = m.groupValues[1].toInt()
        val minor = m.groupValues[2].toInt()
        val use = when {
            major > 3 || minor >= 8 -> 8
            minor == 7 -> 7
            else -> 3
        }
        send("RFB 003.00$use\n".toByteArray(Charsets.US_ASCII))

        val security: Int
        if (use >= 7) {
            val n = r.u8()
            if (n == 0) throw RfbException("VNC server refused the connection: ${reason()}")
            val types = r.bytes(n).map { it.toInt() and 0xFF }
            security = when {
                2 in types -> 2
                1 in types -> 1
                else -> throw RfbException("No supported VNC security type")
            }
            send(byteArrayOf(security.toByte()))
        } else {
            security = r.s32()
            if (security == 0) throw RfbException("VNC server refused the connection: ${reason()}")
            if (security != 1 && security != 2) throw RfbException("No supported VNC security type")
        }
        if (security == 2) {
            val challenge = r.bytes(16)
            send(RfbMessages.vncAuthResponse(password, challenge))
        }
        if (security == 2 || use == 8) {
            val result = r.s32()
            if (result != 0) {
                val why = if (use == 8) runCatching { reason() }.getOrDefault("") else ""
                throw RfbException("VNC authentication failed${if (why.isNotBlank()) ": $why" else ""}", authFailed = true)
            }
        }
        send(byteArrayOf(1)) // ClientInit: shared session (the app's own watchdog shares the display)
        val w = r.u16()
        val h = r.u16()
        r.bytes(16) // server pixel format — replaced by ours below
        val name = String(r.bytes(r.u32().coerceAtMost(4096).toInt()), Charsets.UTF_8)
        val fb = Framebuffer(w, h)
        framebuffer = fb
        send(RfbMessages.setPixelFormat())
        send(
            RfbMessages.setEncodings(
                intArrayOf(RfbMessages.ENC_ZRLE, RfbMessages.ENC_COPYRECT, RfbMessages.ENC_RAW, RfbMessages.ENC_DESKTOP_SIZE, RfbMessages.ENC_LAST_RECT),
            ),
        )
        send(RfbMessages.updateRequest(false, 0, 0, w, h))
        listener.onConnected(fb, name)
    }

    private fun reason(): String = String(r.bytes(r.u32().coerceAtMost(4096).toInt()), Charsets.UTF_8)

    private fun loop() {
        while (true) {
            when (val type = r.u8()) {
                0 -> framebufferUpdate()
                1 -> { // SetColourMapEntries (not used with true colour)
                    r.u8()
                    r.u16()
                    r.skip(r.u16() * 6L)
                }
                2 -> Unit // Bell
                3 -> { // ServerCutText: the remote clipboard is never read or kept
                    r.bytes(3)
                    r.skip(r.u32())
                }
                else -> throw RfbException("Unsupported VNC message $type")
            }
        }
    }

    private fun framebufferUpdate() {
        r.u8()
        val count = r.u16()
        val fb = framebuffer!!
        var dirty: Rect? = null
        var resized = false
        var i = 0
        while (count == 0xFFFF || i < count) {
            i++
            val x = r.u16()
            val y = r.u16()
            val w = r.u16()
            val h = r.u16()
            when (val enc = r.s32()) {
                RfbMessages.ENC_RAW -> {
                    readRaw(fb, x, y, w, h)
                    dirty = Rect(x, y, w, h).union(dirty)
                }
                RfbMessages.ENC_COPYRECT -> {
                    val sx = r.u16()
                    val sy = r.u16()
                    copyRect(fb, sx, sy, x, y, w, h)
                    dirty = Rect(x, y, w, h).union(dirty)
                }
                RfbMessages.ENC_ZRLE -> {
                    val len = r.u32()
                    if (len > 64L * 1024 * 1024) throw RfbException("ZRLE rectangle too large")
                    zrle.decode(r.bytes(len.toInt()), x, y, w, h, fb)
                    dirty = Rect(x, y, w, h).union(dirty)
                }
                RfbMessages.ENC_DESKTOP_SIZE -> {
                    fb.resize(w, h)
                    resized = true
                    dirty = Rect(0, 0, w, h)
                }
                RfbMessages.ENC_LAST_RECT -> break
                else -> throw RfbException("Unsupported VNC encoding $enc")
            }
        }
        if (resized) listener.onResize(fb)
        val d = dirty?.let { clip(it, fb) }
        if (d != null && d.w > 0 && d.h > 0) listener.onUpdate(fb, d)
        send(RfbMessages.updateRequest(true, 0, 0, fb.width, fb.height))
    }

    private fun clip(rect: Rect, fb: Framebuffer): Rect {
        val x = rect.x.coerceIn(0, fb.width)
        val y = rect.y.coerceIn(0, fb.height)
        return Rect(x, y, (rect.x + rect.w).coerceAtMost(fb.width) - x, (rect.y + rect.h).coerceAtMost(fb.height) - y)
    }

    private fun readRaw(fb: Framebuffer, x: Int, y: Int, w: Int, h: Int) {
        val row = ByteArray(w * 4)
        val px = fb.pixels
        for (j in 0 until h) {
            r.fully(row)
            val dy = y + j
            if (dy >= fb.height) continue
            var o = 0
            val base = dy * fb.width
            for (k in 0 until w) {
                val dx = x + k
                if (dx < fb.width) {
                    px[base + dx] = (0xFF shl 24) or ((row[o + 2].toInt() and 0xFF) shl 16) or ((row[o + 1].toInt() and 0xFF) shl 8) or (row[o].toInt() and 0xFF)
                }
                o += 4
            }
        }
    }

    private fun copyRect(fb: Framebuffer, sx: Int, sy: Int, dx: Int, dy: Int, w: Int, h: Int) {
        val px = fb.pixels
        val stride = fb.width
        if (sx + w > fb.width || sy + h > fb.height || dx + w > fb.width || dy + h > fb.height) return
        val tmp = IntArray(w * h)
        for (j in 0 until h) System.arraycopy(px, (sy + j) * stride + sx, tmp, j * w, w)
        for (j in 0 until h) System.arraycopy(tmp, j * w, px, (dy + j) * stride + dx, w)
    }

    /* ------------------------------------------------------------- input */

    fun pointer(x: Int, y: Int, mask: Int) {
        val fb = framebuffer ?: return
        buttons = mask
        send(RfbMessages.pointer(mask, x.coerceIn(0, fb.width - 1), y.coerceIn(0, fb.height - 1)))
    }

    /** Left click (press + release) at a framebuffer position. */
    fun click(x: Int, y: Int) {
        pointer(x, y, 0)
        pointer(x, y, 1)
        pointer(x, y, 0)
    }

    /** Mouse wheel: negative = up. */
    fun scroll(x: Int, y: Int, steps: Int) {
        val button = if (steps < 0) 8 else 16
        repeat(kotlin.math.abs(steps).coerceAtMost(20)) {
            pointer(x, y, button)
            pointer(x, y, 0)
        }
    }

    fun key(keysym: Int) {
        send(RfbMessages.key(keysym, true))
        send(RfbMessages.key(keysym, false))
    }

    fun type(text: String) {
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            key(RfbMessages.keysymFor(cp))
            i += Character.charCount(cp)
        }
    }
}
