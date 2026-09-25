package io.github.revocx35.walogger.core

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.text.BreakIterator

/*
 * WhatsApp text formatting → a node tree, ported 1:1 from `web/src/lib/waText.tsx` (keep them in
 * sync). The UI turns nodes into styled text, never into markup. Supported: *bold* _italic_
 * ~strike~ `code` ```block```, "> " quotes, "- " / "* " / "1. " lists, http(s) links, @mentions.
 * String indexing is by UTF-16 code unit, exactly like the JavaScript original.
 */

sealed interface WaNode {
    data class Text(val v: String) : WaNode
    data class Bold(val c: List<WaNode>) : WaNode
    data class Italic(val c: List<WaNode>) : WaNode
    data class Strike(val c: List<WaNode>) : WaNode
    data class Code(val v: String) : WaNode
    data class Link(val href: String, val v: String) : WaNode
    data class MentionNode(val id: String, val name: String) : WaNode
}

enum class LineKind { P, Quote, Bullet, Number }

sealed interface WaBlock {
    data class Pre(val v: String) : WaBlock
    data class Line(val kind: LineKind, val c: List<WaNode>, val marker: String? = null) : WaBlock
}

object WaText {
    /** Beyond this length a message is shown without inline formatting (keeps rendering cheap). */
    const val MAX_FORMAT_CHARS = 20_000

    // JavaScript's \s (Unicode whitespace), used where the original regexes use \s.
    private const val JS_SPACE = "\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"

    // JS: /\b(?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/gi  (\b is ASCII in non-unicode JS regexes)
    private val URL_RE = Regex(
        "(?<![A-Za-z0-9_])(?:https?://|www\\.)[^$JS_SPACE<>\"'`]+[^$JS_SPACE<>\"'`.,;:!?)\\]}]",
        RegexOption.IGNORE_CASE,
    )
    private val MENTION_RE = Regex("@([0-9]{5,20})")
    private val CODE_BLOCK_RE = Regex("```([\\s\\S]+?)```")
    private val BULLET_RE = Regex("^[-*][ \\t]")
    private val NUMBER_RE = Regex("^([0-9]{1,3})\\.[ \\t]")

    private fun isSpace(ch: Char?): Boolean = ch == null || isJsSpace(ch.code)

    private fun isJsSpace(cp: Int): Boolean = when (cp) {
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true
        in 0x2000..0x200A -> true
        else -> false
    }

    private fun isWordChar(ch: Char?): Boolean {
        if (ch == null) return false
        return when (Character.getType(ch).toByte()) {
            Character.UPPERCASE_LETTER, Character.LOWERCASE_LETTER, Character.TITLECASE_LETTER,
            Character.MODIFIER_LETTER, Character.OTHER_LETTER, Character.DECIMAL_DIGIT_NUMBER,
            Character.LETTER_NUMBER, Character.OTHER_NUMBER -> true
            else -> false
        }
    }

    private fun markerKind(ch: Char): Char? = if (ch == '*' || ch == '_' || ch == '~' || ch == '`') ch else null

    /** Only http(s) links, normalized; anything else (javascript:, data:, …) is never linked. */
    fun safeHref(raw: String): String? {
        val href = if (raw.length >= 4 && raw.regionMatches(0, "www.", 0, 4, ignoreCase = true)) "https://$raw" else raw
        val url = href.toHttpUrlOrNull() ?: return null
        if (url.scheme != "https" && url.scheme != "http") return null
        return url.toString()
    }

    private fun withMentions(text: String, mentions: List<Mention>): List<WaNode> {
        if (mentions.isEmpty() || !text.contains('@')) return if (text.isNotEmpty()) listOf(WaNode.Text(text)) else emptyList()
        val out = ArrayList<WaNode>()
        var last = 0
        for (m in MENTION_RE.findAll(text)) {
            val digits = m.groupValues[1]
            val mention = mentions.firstOrNull { it.id.startsWith("$digits@") } ?: continue
            val idx = m.range.first
            if (idx > last) out.add(WaNode.Text(text.substring(last, idx)))
            out.add(WaNode.MentionNode(mention.id, mention.name ?: "+$digits"))
            last = m.range.last + 1
        }
        if (last < text.length) out.add(WaNode.Text(text.substring(last)))
        return out
    }

    /**
     * Formatting markers (no URLs inside `text`). O(n log n): valid closing positions per marker are
     * precomputed once and each opener finds its closer by binary search.
     */
    private fun parseMarkers(text: String, mentions: List<Mention>, depth: Int = 0): List<WaNode> {
        if (text.length > MAX_FORMAT_CHARS) return withMentions(text, mentions)
        val closers = HashMap<Char, MutableList<Int>>()
        for (j in 1 until text.length) {
            val ch = text[j]
            if (markerKind(ch) == null) continue
            if (!isSpace(text[j - 1]) && !isWordChar(text.getOrNull(j + 1))) closers.getOrPut(ch) { ArrayList() }.add(j)
        }
        fun nextCloser(ch: Char, after: Int): Int {
            val list = closers[ch] ?: return -1
            var lo = 0
            var hi = list.size
            while (lo < hi) {
                val mid = (lo + hi) ushr 1
                if (list[mid] <= after) lo = mid + 1 else hi = mid
            }
            return if (lo < list.size) list[lo] else -1
        }

        val out = ArrayList<WaNode>()
        val buf = StringBuilder()
        fun flush() {
            if (buf.isNotEmpty()) out.addAll(withMentions(buf.toString(), mentions))
            buf.setLength(0)
        }
        var i = 0
        while (i < text.length) {
            val ch = text[i]
            val kind = markerKind(ch)
            if (kind != null && depth < 4 && !isWordChar(text.getOrNull(i - 1)) && !isSpace(text.getOrNull(i + 1)) && text.getOrNull(i + 1) != ch) {
                val close = nextCloser(ch, i + 1)
                if (close > i + 1) {
                    flush()
                    val inner = text.substring(i + 1, close)
                    out.add(
                        when (kind) {
                            '`' -> WaNode.Code(inner)
                            '*' -> WaNode.Bold(parseMarkers(inner, mentions, depth + 1))
                            '_' -> WaNode.Italic(parseMarkers(inner, mentions, depth + 1))
                            else -> WaNode.Strike(parseMarkers(inner, mentions, depth + 1))
                        },
                    )
                    i = close + 1
                    continue
                }
            }
            buf.append(ch)
            i++
        }
        flush()
        return out
    }

    fun parseInline(text: String, mentions: List<Mention> = emptyList()): List<WaNode> {
        val out = ArrayList<WaNode>()
        var last = 0
        for (m in URL_RE.findAll(text)) {
            val idx = m.range.first
            val href = safeHref(m.value) ?: continue
            if (idx > last) out.addAll(parseMarkers(text.substring(last, idx), mentions))
            out.add(WaNode.Link(href, m.value))
            last = m.range.last + 1
        }
        if (last < text.length) out.addAll(parseMarkers(text.substring(last), mentions))
        return out
    }

    /** JavaScript `String.split` with one capture group: separators' captures are kept at odd indexes. */
    private fun splitCodeBlocks(text: String): List<String> {
        val parts = ArrayList<String>()
        var last = 0
        for (m in CODE_BLOCK_RE.findAll(text)) {
            parts.add(text.substring(last, m.range.first))
            parts.add(m.groupValues[1])
            last = m.range.last + 1
        }
        parts.add(text.substring(last))
        return parts
    }

    fun parse(text: String, mentions: List<Mention> = emptyList()): List<WaBlock> {
        val blocks = ArrayList<WaBlock>()
        val parts = splitCodeBlocks(text)
        parts.forEachIndexed { idx, part ->
            if (idx % 2 == 1) {
                blocks.add(WaBlock.Pre(part.removePrefix("\n")))
                return@forEachIndexed
            }
            if (part.isEmpty()) return@forEachIndexed
            val lines = part.split('\n').toMutableList()
            // A code block eats the newline boundaries around it.
            if (idx > 0 && lines.first() == "") lines.removeAt(0)
            if (idx < parts.size - 1 && lines.isNotEmpty() && lines.last() == "") lines.removeAt(lines.size - 1)
            for (line in lines) {
                if (line.startsWith(">")) {
                    blocks.add(WaBlock.Line(LineKind.Quote, parseInline(line.substring(if (line.getOrNull(1) == ' ') 2 else 1), mentions)))
                    continue
                }
                val bullet = BULLET_RE.find(line)
                if (bullet != null) {
                    blocks.add(WaBlock.Line(LineKind.Bullet, parseInline(line.substring(bullet.value.length).trimStart(), mentions)))
                    continue
                }
                val number = NUMBER_RE.find(line)
                if (number != null) {
                    blocks.add(WaBlock.Line(LineKind.Number, parseInline(line.substring(number.value.length).trimStart(), mentions), number.groupValues[1]))
                    continue
                }
                blocks.add(WaBlock.Line(LineKind.P, parseInline(line, mentions)))
            }
        }
        return blocks
    }

    fun flatten(nodes: List<WaNode>): String = buildString {
        for (n in nodes) {
            when (n) {
                is WaNode.Text -> append(n.v)
                is WaNode.Code -> append(n.v)
                is WaNode.Link -> append(n.v)
                is WaNode.MentionNode -> append('@').append(n.name)
                is WaNode.Bold -> append(flatten(n.c))
                is WaNode.Italic -> append(flatten(n.c))
                is WaNode.Strike -> append(flatten(n.c))
            }
        }
    }

    private val MULTI_SPACE = Regex("[$JS_SPACE]+")

    /** Plain one-line text without WhatsApp formatting markers (for previews and quotes). */
    fun strip(text: String): String =
        parse(text).joinToString(" ") { b -> if (b is WaBlock.Pre) b.v.trim() else flatten((b as WaBlock.Line).c) }
            .replace(MULTI_SPACE, " ")
            .trim()

    /** 1–3 emoji and nothing else: shown large, like WhatsApp. */
    fun jumboEmoji(text: String): Boolean {
        if (text.isEmpty()) return false
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            val ok = isExtendedPictographic(cp) || cp in 0x1F3FB..0x1F3FF || cp in 0x1F1E6..0x1F1FF ||
                cp == 0x200D || cp == 0xFE0F || isJsSpace(cp) || cp in 0xE0020..0xE007F
            if (!ok) return false
            i += Character.charCount(cp)
        }
        val trimmed = text.trim()
        val it = BreakIterator.getCharacterInstance()
        it.setText(trimmed)
        var count = 0
        while (it.next() != BreakIterator.DONE) {
            count++
            if (count > 3) return false
        }
        return count in 1..3
    }

    private val PICTOGRAPHIC_RANGES = intArrayOf(
        0x00A9, 0x00A9, 0x00AE, 0x00AE, 0x203C, 0x203C, 0x2049, 0x2049, 0x2122, 0x2122, 0x2139, 0x2139,
        0x2194, 0x2199, 0x21A9, 0x21AA, 0x231A, 0x231B, 0x2328, 0x2328, 0x2388, 0x2388, 0x23CF, 0x23CF,
        0x23E9, 0x23F3, 0x23F8, 0x23FA, 0x24C2, 0x24C2, 0x25AA, 0x25AB, 0x25B6, 0x25B6, 0x25C0, 0x25C0,
        0x25FB, 0x25FE, 0x2600, 0x2605, 0x2607, 0x2612, 0x2614, 0x2685, 0x2690, 0x2705, 0x2708, 0x2712,
        0x2714, 0x2714, 0x2716, 0x2716, 0x271D, 0x271D, 0x2721, 0x2721, 0x2728, 0x2728, 0x2733, 0x2734,
        0x2744, 0x2744, 0x2747, 0x2747, 0x274C, 0x274C, 0x274E, 0x274E, 0x2753, 0x2755, 0x2757, 0x2757,
        0x2763, 0x2767, 0x2795, 0x2797, 0x27A1, 0x27A1, 0x27B0, 0x27B0, 0x27BF, 0x27BF, 0x2934, 0x2935,
        0x2B05, 0x2B07, 0x2B1B, 0x2B1C, 0x2B50, 0x2B50, 0x2B55, 0x2B55, 0x3030, 0x3030, 0x303D, 0x303D,
        0x3297, 0x3297, 0x3299, 0x3299, 0x1F000, 0x1F0FF, 0x1F10D, 0x1F10F, 0x1F12F, 0x1F12F,
        0x1F16C, 0x1F171, 0x1F17E, 0x1F17F, 0x1F18E, 0x1F18E, 0x1F191, 0x1F19A, 0x1F1AD, 0x1F1E5,
        0x1F201, 0x1F20F, 0x1F21A, 0x1F21A, 0x1F22F, 0x1F22F, 0x1F232, 0x1F23A, 0x1F23C, 0x1F23F,
        0x1F249, 0x1F3FA, 0x1F400, 0x1F53D, 0x1F546, 0x1F64F, 0x1F680, 0x1F6FF, 0x1F774, 0x1F77F,
        0x1F7D5, 0x1F7FF, 0x1F80C, 0x1F80F, 0x1F848, 0x1F84F, 0x1F85A, 0x1F85F, 0x1F888, 0x1F88F,
        0x1F8AE, 0x1F8FF, 0x1F90C, 0x1F93A, 0x1F93C, 0x1F945, 0x1F947, 0x1FAFF, 0x1FC00, 0x1FFFD,
    )

    /** Unicode `Extended_Pictographic` (emoji-data.txt), without relying on the platform regex engine. */
    fun isExtendedPictographic(cp: Int): Boolean {
        if (cp < 0xA9) return false
        var k = 0
        while (k < PICTOGRAPHIC_RANGES.size) {
            if (cp < PICTOGRAPHIC_RANGES[k]) return false
            if (cp <= PICTOGRAPHIC_RANGES[k + 1]) return true
            k += 2
        }
        return false
    }
}
