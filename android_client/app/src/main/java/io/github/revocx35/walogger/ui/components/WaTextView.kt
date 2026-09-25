package io.github.revocx35.walogger.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.github.revocx35.walogger.core.LineKind
import io.github.revocx35.walogger.core.Mention
import io.github.revocx35.walogger.core.WaBlock
import io.github.revocx35.walogger.core.WaNode
import io.github.revocx35.walogger.core.WaText
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaColors
import io.github.revocx35.walogger.ui.theme.WaType

private const val META_ID = "meta"

private fun AnnotatedString.Builder.appendNodes(nodes: List<WaNode>, c: WaColors) {
    for (n in nodes) {
        when (n) {
            is WaNode.Text -> append(n.v)
            is WaNode.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { appendNodes(n.c, c) }
            is WaNode.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendNodes(n.c, c) }
            is WaNode.Strike -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { appendNodes(n.c, c) }
            is WaNode.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = c.quoteBg, fontSize = 0.9.em)) { append(n.v) }
            // Only http(s) URLs ever become links (WaText.safeHref); they open in the browser on tap.
            is WaNode.Link -> withLink(LinkAnnotation.Url(n.href, TextLinkStyles(SpanStyle(color = c.link)))) { append(n.v) }
            is WaNode.MentionNode -> withStyle(SpanStyle(color = c.link, fontWeight = FontWeight.Medium)) { append("@${n.name}") }
        }
    }
}

private sealed interface Piece {
    data class Paragraph(val lines: List<WaBlock.Line>) : Piece
    data class Quote(val line: WaBlock.Line) : Piece
    data class Pre(val text: String) : Piece
}

/**
 * Renders WhatsApp-formatted text as styled text (the parse tree from [WaText]); message content is
 * never interpreted as markup. [trailing] reserves room at the end of the last line for the
 * bubble's time/ticks, the way WhatsApp flows the timestamp into the text.
 */
@Composable
fun WaTextView(
    text: String,
    mentions: List<Mention> = emptyList(),
    style: TextStyle = WaType.bubble,
    color: Color = Wa.colors.text,
    trailing: TextUnit = 0.sp,
    modifier: Modifier = Modifier,
) {
    val c = Wa.colors
    val jumbo = remember(text) { WaText.jumboEmoji(text) }
    val pieces = remember(text, mentions) {
        val out = ArrayList<Piece>()
        var para = ArrayList<WaBlock.Line>()
        fun flush() {
            if (para.isNotEmpty()) out.add(Piece.Paragraph(para))
            para = ArrayList()
        }
        for (b in WaText.parse(text, mentions)) {
            when {
                b is WaBlock.Pre -> { flush(); out.add(Piece.Pre(b.v)) }
                b is WaBlock.Line && b.kind == LineKind.Quote -> { flush(); out.add(Piece.Quote(b)) }
                else -> para.add(b as WaBlock.Line)
            }
        }
        flush()
        out
    }
    val base = if (jumbo) style.copy(fontSize = style.fontSize * 2.4f, lineHeight = style.fontSize * 2.9f) else style
    val lastIsText = pieces.lastOrNull() !is Piece.Pre
    val inline = if (trailing.value > 0f && lastIsText) {
        mapOf(META_ID to InlineTextContent(Placeholder(trailing, 12.sp, PlaceholderVerticalAlign.TextBottom)) {})
    } else {
        emptyMap()
    }
    Column(modifier) {
        pieces.forEachIndexed { i, piece ->
            val last = i == pieces.size - 1
            when (piece) {
                is Piece.Pre -> Text(
                    piece.text,
                    style = base.copy(fontFamily = FontFamily.Monospace, fontSize = base.fontSize * 0.92f),
                    color = color,
                    modifier = Modifier.padding(vertical = 2.dp),
                )
                is Piece.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(c.muted))
                    Text(
                        buildAnnotatedString {
                            appendNodes(piece.line.c, c)
                            if (last && inline.isNotEmpty()) appendInlineContent(META_ID, " ")
                        },
                        style = base,
                        color = c.text2,
                        inlineContent = if (last) inline else emptyMap(),
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
                is Piece.Paragraph -> Text(
                    buildAnnotatedString {
                        piece.lines.forEachIndexed { k, line ->
                            if (k > 0) append('\n')
                            when (line.kind) {
                                LineKind.Bullet -> append("• ")
                                LineKind.Number -> append("${line.marker}. ")
                                else -> Unit
                            }
                            appendNodes(line.c, c)
                        }
                        if (last && inline.isNotEmpty()) appendInlineContent(META_ID, " ")
                    },
                    style = base,
                    color = color,
                    inlineContent = if (last) inline else emptyMap(),
                )
            }
        }
    }
}

/** Whether [WaTextView] ends with inline text (not a code block), i.e. can host the trailing time. */
fun endsWithInlineText(text: String): Boolean = WaText.parse(text).lastOrNull() !is WaBlock.Pre
