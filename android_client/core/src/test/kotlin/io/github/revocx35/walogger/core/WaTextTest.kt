package io.github.revocx35.walogger.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ported from web/src/lib/waText.test.tsx — both implementations must agree. */
class WaTextTest {
    private fun t(v: String) = WaNode.Text(v)

    @Test
    fun parsesBoldItalicStrikeCodeAndNesting() {
        assertEquals(listOf(WaNode.Bold(listOf(t("bold")))), WaText.parseInline("*bold*"))
        assertEquals(listOf(t("a "), WaNode.Italic(listOf(t("it"))), t(" b")), WaText.parseInline("a _it_ b"))
        assertEquals(WaNode.Strike(listOf(t("gone"))), WaText.parseInline("~gone~")[0])
        assertEquals(WaNode.Code("x = *y*"), WaText.parseInline("`x = *y*`")[0])
        assertEquals(
            WaNode.Bold(listOf(t("bold "), WaNode.Italic(listOf(t("and italic"))))),
            WaText.parseInline("*bold _and italic_*")[0],
        )
    }

    @Test
    fun doesNotFormatInsideWordsOrWithSpacesNextToMarkers() {
        assertEquals(listOf(t("snake_case_name")), WaText.parseInline("snake_case_name"))
        assertEquals(listOf(t("2 * 3 * 4")), WaText.parseInline("2 * 3 * 4"))
        assertEquals(listOf(t("* not bold*")), WaText.parseInline("* not bold*"))
        assertEquals(listOf(t("**")), WaText.parseInline("**"))
    }

    @Test
    fun linksHttpUrlsWithoutBreakingUnderscores() {
        assertEquals(
            listOf(t("see "), WaNode.Link("https://example.com/a_b_c?x=1", "https://example.com/a_b_c?x=1"), t(". ok")),
            WaText.parseInline("see https://example.com/a_b_c?x=1. ok"),
        )
        val www = WaText.parseInline("www.example.org")[0] as WaNode.Link
        assertEquals("https://www.example.org/", www.href)
    }

    @Test
    fun resolvesMentions() {
        assertEquals(
            listOf(t("hi "), WaNode.MentionNode("905551112233@c.us", "Ali"), t("!")),
            WaText.parseInline("hi @905551112233!", listOf(Mention("905551112233@c.us", "Ali"))),
        )
        assertEquals(
            listOf(t("hi "), WaNode.MentionNode("905551112233@c.us", "+905551112233")),
            WaText.parseInline("hi @905551112233", listOf(Mention("905551112233@c.us", null))),
        )
    }

    @Test
    fun handlesCodeBlocksQuotesAndLists() {
        val blocks = WaText.parse("> quoted\n- item\n1. first\n```\nconst a = *1*;\n```\nend")
        assertEquals(
            listOf("quote", "bullet", "number", "pre", "p"),
            blocks.map { if (it is WaBlock.Pre) "pre" else (it as WaBlock.Line).kind.name.lowercase() },
        )
        assertEquals(WaBlock.Pre("const a = *1*;\n"), blocks[3])
        assertEquals("1", (blocks[2] as WaBlock.Line).marker)
    }

    @Test
    fun neverLinksDangerousSchemes() {
        assertNull(WaText.safeHref("javascript:alert(1)"))
        assertNull(WaText.safeHref("data:text/html,<script>alert(1)</script>"))
        assertFalse(WaText.parseInline("javascript:alert(1)").any { it is WaNode.Link })
        assertFalse(WaText.parseInline("data:text/html,<script>alert(1)</script>").any { it is WaNode.Link })
        val link = WaText.parseInline("https://ok.example/\"onmouseover=\"alert(1)").filterIsInstance<WaNode.Link>().single()
        assertEquals("https://ok.example/", link.href)
    }

    @Test
    fun markupIsJustText() {
        val nodes = WaText.parseInline("<img src=x onerror=alert(1)> *<b>x</b>*")
        assertEquals(t("<img src=x onerror=alert(1)> "), nodes[0])
        assertEquals(WaNode.Bold(listOf(t("<b>x</b>"))), nodes[1])
    }

    @Test
    fun detectsJumboEmoji() {
        assertTrue(WaText.jumboEmoji("😂"))
        assertTrue(WaText.jumboEmoji("👍🏽👍🏽"))
        assertTrue(WaText.jumboEmoji("❤️"))
        assertFalse(WaText.jumboEmoji("😂😂😂😂"))
        assertFalse(WaText.jumboEmoji("ok 😂"))
        assertFalse(WaText.jumboEmoji("123"))
        assertFalse(WaText.jumboEmoji("   "))
    }

    @Test
    fun stripsFormattingForPreviews() {
        assertEquals("Hi there x", WaText.strip("*Hi* _there_ ~x~"))
        assertEquals("const a = 1; quoted item", WaText.strip("```\nconst a = 1;\n```\n> quoted\n- item"))
    }

    @Test
    fun hugeInputStaysFast() {
        val evil = "*a ".repeat(60_000) + "_".repeat(50_000)
        val started = System.nanoTime()
        WaText.parse(evil)
        WaText.parse("*".repeat(19_999))
        assertTrue("parser too slow", System.nanoTime() - started < 3_000_000_000L)
    }
}
