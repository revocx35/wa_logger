package io.github.revocx35.walogger.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToLong

/** Display formatting, ported from `web/src/lib/format.ts`. */
class Formatter(
    private val locale: Locale = Locale.getDefault(),
    private val zone: ZoneId = ZoneId.systemDefault(),
    use24h: Boolean = true,
) {
    private val time = DateTimeFormatter.ofPattern(if (use24h) "HH:mm" else "hh:mm a", locale)
    private val weekday = DateTimeFormatter.ofPattern("EEEE", locale)
    private val shortDate = DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(locale)
    private val longDate = DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).withLocale(locale)
    private val mediumDate = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale)

    private fun date(ts: Long): LocalDate = Instant.ofEpochMilli(ts).atZone(zone).toLocalDate()

    fun time(ts: Long): String = time.format(Instant.ofEpochMilli(ts).atZone(zone))

    /** Chat-list style: time today, "Yesterday", weekday this week, else date. */
    fun listTime(ts: Long?, now: Long = System.currentTimeMillis()): String {
        if (ts == null || ts == 0L) return ""
        val today = date(now)
        val d = date(ts)
        return when {
            !d.isBefore(today) -> time(ts)
            d == today.minusDays(1) -> "Yesterday"
            !d.isBefore(today.minusDays(6)) -> weekday.format(d)
            else -> shortDate.format(d)
        }
    }

    /** Date separator label inside a chat. */
    fun dayLabel(ts: Long, now: Long = System.currentTimeMillis()): String {
        val today = date(now)
        val d = date(ts)
        return when {
            !d.isBefore(today) -> "Today"
            d == today.minusDays(1) -> "Yesterday"
            !d.isBefore(today.minusDays(6)) -> weekday.format(d)
            else -> longDate.format(d)
        }
    }

    fun dateTime(ts: Long): String = "${mediumDate.format(date(ts))}, ${time(ts)}"

    fun dayKey(ts: Long): Long = date(ts).toEpochDay()
}

fun formatBytes(n: Long?): String {
    if (n == null) return ""
    return when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> "${(n / 1024.0).roundToLong()} KB"
        n < 1024L * 1024 * 1024 -> String.format(Locale.US, "%.1f MB", n / 1024.0 / 1024.0)
        else -> String.format(Locale.US, "%.2f GB", n / 1024.0 / 1024.0 / 1024.0)
    }
}

fun formatDuration(sec: Double?): String {
    if (sec == null) return ""
    val s = max(0L, sec.roundToLong())
    val m = s / 60
    val h = m / 60
    val ss = (s % 60).toString().padStart(2, '0')
    return if (h > 0) "$h:${(m % 60).toString().padStart(2, '0')}:$ss" else "$m:$ss"
}

private val LEADING_MARK = Regex("^[~+]")
private val PHONE_LIKE = Regex("^\\+?[0-9]")
private val WS = Regex("\\s+")

private fun firstCodePoint(s: String): String = if (s.isEmpty()) "" else String(Character.toChars(s.codePointAt(0)))

/** Avatar initials: "#" for phone numbers, first letters of the first and last word otherwise. */
fun initials(name: String): String {
    val clean = name.replace(LEADING_MARK, "").trim()
    if (clean.isEmpty()) return "?"
    if (PHONE_LIKE.containsMatchIn(clean)) return "#"
    val parts = clean.split(WS).filter { it.isNotEmpty() }
    val first = firstCodePoint(parts.firstOrNull() ?: "")
    val second = if (parts.size > 1) firstCodePoint(parts.last()) else ""
    return (first + second).uppercase()
}

/** Same palette and hash as the web UI, so a contact has the same color everywhere. */
val SENDER_COLORS: LongArray = longArrayOf(
    0xFFE17076, 0xFF7BC862, 0xFF65AADD, 0xFFA695E7, 0xFFEE7AAE, 0xFF6EC9CB,
    0xFFFAA774, 0xFF53BDEB, 0xFFFFB74D, 0xFF4DB6AC, 0xFFBA68C8, 0xFFF06292,
)

/** ARGB color for an id (identical to the web's `colorFor`, including 32-bit overflow). */
fun colorFor(id: String): Long {
    var h = 0
    for (ch in id) h = h * 31 + ch.code
    return SENDER_COLORS[(abs(h.toLong()) % SENDER_COLORS.size).toInt()]
}
