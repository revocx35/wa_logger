package io.github.revocx35.walogger.core

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale

class FormatTest {
    private val zone = ZoneId.of("Europe/Istanbul")
    private val f = Formatter(Locale.US, zone, use24h = false)
    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int) = LocalDateTime.of(y, mo, d, h, mi).atZone(zone).toInstant().toEpochMilli()

    @Test
    fun colorsMatchTheWebUi() {
        // Reference values computed with web/src/lib/format.ts#colorFor.
        val expected = mapOf(
            "905551112233@c.us" to 0xFFBA68C8,
            "120363025555555555@g.us" to 0xFF65AADD,
            "Ali Yılmaz" to 0xFFFFB74D,
            "" to 0xFFE17076,
            "x" to 0xFFE17076,
            "status@broadcast" to 0xFF7BC862,
            "Family 👨‍👩‍👧" to 0xFFA695E7,
        )
        for ((id, color) in expected) assertEquals(id, color, colorFor(id))
    }

    @Test
    fun initialsLikeTheWeb() {
        assertEquals("AY", initials("Ali Yılmaz"))
        assertEquals("#", initials("+90 555 111 22 33"))
        assertEquals("#", initials("905551112233"))
        assertEquals("P", initials("~pushname"))
        assertEquals("?", initials("   "))
        assertEquals("ZK", initials("Zeynep Ayşe Kaya"))
    }

    @Test
    fun bytesAndDurations() {
        assertEquals("512 B", formatBytes(512))
        assertEquals("2 KB", formatBytes(2048))
        assertEquals("1.5 MB", formatBytes(1_572_864))
        assertEquals("2.00 GB", formatBytes(2L * 1024 * 1024 * 1024))
        assertEquals("0:07", formatDuration(7.2))
        assertEquals("1:05", formatDuration(65.0))
        assertEquals("1:01:01", formatDuration(3661.0))
        assertEquals("", formatDuration(null))
    }

    @Test
    fun listTimesAndDayLabels() {
        val now = at(2026, 9, 25, 15, 0) // a Friday
        assertEquals("02:50 PM", f.listTime(at(2026, 9, 25, 14, 50), now))
        assertEquals("Yesterday", f.listTime(at(2026, 9, 24, 9, 0), now))
        assertEquals("Monday", f.listTime(at(2026, 9, 21, 9, 0), now))
        assertEquals("9/1/26", f.listTime(at(2026, 9, 1, 9, 0), now))
        assertEquals("Today", f.dayLabel(at(2026, 9, 25, 0, 1), now))
        assertEquals("September 1, 2026", f.dayLabel(at(2026, 9, 1, 9, 0), now))
        assertEquals("", f.listTime(null, now))
        assertEquals("14:50", Formatter(Locale.US, zone, use24h = true).time(at(2026, 9, 25, 14, 50)))
    }
}
