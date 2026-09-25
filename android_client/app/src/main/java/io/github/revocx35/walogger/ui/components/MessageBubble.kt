package io.github.revocx35.walogger.ui.components

import android.content.ClipData
import android.content.ClipDescription
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageEdit
import io.github.revocx35.walogger.core.MessageType
import io.github.revocx35.walogger.core.WaText
import io.github.revocx35.walogger.core.colorFor
import io.github.revocx35.walogger.core.formatDuration
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.ui.LocalFormatter
import io.github.revocx35.walogger.ui.LocalMessageActions
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType

private val QUOTE_LABEL = mapOf(
    MessageType.Image to "📷 Photo",
    MessageType.Video to "🎥 Video",
    MessageType.Gif to "GIF",
    MessageType.Audio to "🎵 Audio",
    MessageType.Ptt to "🎤 Voice message",
    MessageType.Document to "📄 Document",
    MessageType.Sticker to "Sticker",
    MessageType.Location to "📍 Location",
    MessageType.Vcard to "👤 Contact",
    MessageType.Poll to "📊 Poll",
)

@Composable
private fun Ticks(ack: Int?) {
    val c = Wa.colors
    when {
        ack == null || ack < 0 -> Unit
        ack == 0 -> WaIcon(WaIcons.clock, 14.dp, c.muted, contentDescription = "Pending")
        ack == 1 -> WaIcon(WaIcons.check, 16.dp, c.muted, contentDescription = "Sent")
        else -> WaIcon(WaIcons.checks, 16.dp, if (ack >= 3) c.tickRead else c.muted, contentDescription = if (ack >= 3) "Read" else "Delivered")
    }
}

/** Centered pill for system messages and call logs. */
@Composable
fun SystemPill(text: String, modifier: Modifier = Modifier) {
    val c = Wa.colors
    Box(modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = WaType.small.copy(fontSize = 12.sp),
            color = c.text2,
            textAlign = TextAlign.Center,
            modifier = Modifier.shadow(1.dp, RoundedCornerShape(8.dp)).clip(RoundedCornerShape(8.dp)).background(c.system).padding(horizontal = 12.dp, vertical = 5.dp),
        )
    }
}

@Composable
private fun EditHistoryDialog(msg: Message, onClose: () -> Unit) {
    val actions = LocalMessageActions.current
    val fmt = LocalFormatter.current
    val c = Wa.colors
    var edits by remember { mutableStateOf<List<MessageEdit>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(msg.id) {
        try {
            edits = actions.edits(msg.id)
        } catch (e: Exception) {
            error = e.userMessage()
        }
    }
    WaDialog("Edit history", onClose) {
        ErrorNote(error)
        if (edits == null && error == null) Spinner()
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val all = (edits ?: emptyList()).map { "Earlier version · captured ${fmt.dateTime(it.capturedAt)}" to it.body } +
                listOf(("Current version" + (msg.editedAt?.let { " · edited ${fmt.dateTime(it)}" } ?: "")) to msg.text)
            all.forEachIndexed { i, (label, body) ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    MutedText("${i + 1}. $label", style = WaType.small)
                    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(c.panel2).padding(8.dp)) {
                        if (body != null) WaTextView(body, if (i == all.size - 1) msg.mentions else emptyList()) else Text("(no text)", color = c.muted, fontStyle = FontStyle.Italic)
                    }
                }
            }
        }
        if (edits?.isEmpty() == true) {
            MutedText("The previous text was not captured (the edit happened before this message was logged).", Modifier.padding(top = 12.dp), style = WaType.small)
        }
    }
}

@Composable
private fun ReactionsDialog(msg: Message, onClose: () -> Unit) {
    WaDialog("Reactions", onClose) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (r in msg.reactions) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(r.emoji, style = WaType.base.copy(fontSize = 22.sp))
                    Text(r.senderName ?: r.senderId, style = WaType.base)
                }
            }
        }
    }
}

@Composable
private fun Special(msg: Message) {
    val c = Wa.colors
    val uri = androidx.compose.ui.platform.LocalUriHandler.current
    val loc = msg.location
    if (loc != null) {
        val osm = "https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}#map=16/${loc.latitude}/${loc.longitude}"
        Row(
            Modifier.padding(bottom = 4.dp).clip(RoundedCornerShape(6.dp)).background(c.quoteBg).clickable(onClickLabel = "Open map") { runCatching { uri.openUri(osm) } }.padding(10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            WaIcon(WaIcons.pin, 28.dp, c.text)
            Column {
                Text(loc.name ?: if (msg.type == MessageType.LiveLocation) "Live location" else "Location", style = WaType.bubble.copy(fontWeight = FontWeight.Bold), color = c.text)
                if (loc.address != null) MutedText(loc.address!!, style = WaType.small)
                MutedText("%.5f, %.5f · open map".format(java.util.Locale.US, loc.latitude, loc.longitude), style = WaType.small)
            }
        }
        return
    }
    val vcards = msg.vcards
    if (!vcards.isNullOrEmpty()) {
        Column(Modifier.padding(bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (v in vcards) {
                var open by remember { mutableStateOf(false) }
                Column(Modifier.clip(RoundedCornerShape(6.dp)).background(c.quoteBg).clickable { open = !open }.padding(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        WaIcon(WaIcons.user, 22.dp, c.text)
                        Text(v.displayName ?: "Contact", style = WaType.bubble, color = c.text)
                    }
                    if (open) Text(v.vcard, style = WaType.small.merge(WaType.mono), color = c.text, modifier = Modifier.padding(top = 6.dp))
                }
            }
        }
        return
    }
    val poll = msg.poll
    if (poll != null) {
        Column(Modifier.widthIn(min = 240.dp).padding(bottom = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                WaIcon(WaIcons.poll, 18.dp, c.text)
                Text(poll.question, style = WaType.bubble.copy(fontWeight = FontWeight.Bold), color = c.text)
            }
            Column(Modifier.padding(vertical = 8.dp)) {
                for (o in poll.options) {
                    Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.width(16.dp).height(16.dp).border(2.dp, c.muted, androidx.compose.foundation.shape.CircleShape))
                        Text(o.name, style = WaType.bubble, color = c.text)
                    }
                }
            }
            MutedText(if (poll.multiSelect) "Select one or more" else "Select one", style = WaType.small)
        }
    }
}

/**
 * Lays out bubble content with the time/ticks row at its bottom-right corner: text flows around it
 * (via [WaTextView]'s trailing space); other content ends with a line for it.
 */
@Composable
private fun WithMeta(meta: @Composable () -> Unit, content: @Composable (metaWidth: Dp) -> Unit) {
    val density = LocalDensity.current
    SubcomposeLayout { constraints ->
        val metaPlaceable = subcompose("meta", meta).map { it.measure(Constraints()) }
        val mw = metaPlaceable.maxOfOrNull { it.width } ?: 0
        val mh = metaPlaceable.maxOfOrNull { it.height } ?: 0
        val contentPlaceable = subcompose("content") { content(with(density) { mw.toDp() }) }.map { it.measure(constraints.copy(minWidth = 0)) }
        val cw = maxOf(contentPlaceable.maxOfOrNull { it.width } ?: 0, mw).coerceAtMost(constraints.maxWidth)
        val ch = contentPlaceable.sumOf { it.height }
        val h = maxOf(ch, mh)
        layout(cw, h) {
            var y = 0
            contentPlaceable.forEach { it.place(0, y); y += it.height }
            metaPlaceable.forEach { it.place(cw - mw, h - mh) }
        }
    }
}

/**
 * One logged message, like the web's MessageBubble: deleted/edited/forwarded/quoted states, sender
 * names in groups, media, locations, contacts, polls, reactions and delivery ticks.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessageBubble(msg: Message, isGroup: Boolean, showSender: Boolean, highlighted: Boolean, maxBubbleWidth: Dp, modifier: Modifier = Modifier) {
    val c = Wa.colors
    val fmt = LocalFormatter.current
    val actions = LocalMessageActions.current

    if (msg.type == MessageType.System || msg.type == MessageType.CallLog) {
        val text = if (msg.type == MessageType.CallLog) {
            val call = msg.call
            buildString {
                append(if (call?.video == true) "📹 Video" else "📞 Voice")
                append(" call")
                call?.outcome?.let { append(" · ").append(it) }
                call?.durationSec?.takeIf { it > 0 }?.let { append(" · ").append(formatDuration(it)) }
            }
        } else {
            msg.text ?: "System message"
        }
        SystemPill("$text · ${fmt.time(msg.ts)}", modifier)
        return
    }

    var showEdits by remember { mutableStateOf(false) }
    var showReactions by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val deleted = msg.deletedAt != null
    val neverCaptured = msg.type == MessageType.Revoked
    val sticker = msg.type == MessageType.Sticker && msg.media?.url != null
    val shape = RoundedCornerShape(7.5.dp)
    val bubbleBg = when {
        sticker -> Color.Transparent
        msg.fromMe -> c.bubbleOut
        else -> c.bubbleIn
    }
    val innerMax = maxBubbleWidth - 17.dp

    Column(
        modifier.fillMaxWidth().padding(vertical = 1.dp),
        horizontalAlignment = if (msg.fromMe) Alignment.End else Alignment.Start,
    ) {
        Box(
            Modifier
                .widthIn(max = maxBubbleWidth)
                .then(if (sticker) Modifier else Modifier.shadow(1.dp, shape, ambientColor = c.shadow, spotColor = c.shadow))
                .then(
                    when {
                        highlighted -> Modifier.border(3.dp, c.warn, shape)
                        deleted -> Modifier.border(2.dp, c.danger, shape)
                        else -> Modifier
                    },
                )
                .clip(shape)
                .background(bubbleBg)
                .combinedClickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = {},
                    onLongClickLabel = "Copy text",
                    onLongClick = {
                        val text = msg.text ?: return@combinedClickable
                        val clip = ClipData.newPlainText("message", text)
                        // Keep message text out of clipboard previews and keyboard suggestions.
                        clip.description.extras = PersistableBundle().apply {
                            putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
                        }
                        context.getSystemService(android.content.ClipboardManager::class.java)?.setPrimaryClip(clip)
                        if (Build.VERSION.SDK_INT < 33) android.widget.Toast.makeText(context, "Copied", android.widget.Toast.LENGTH_SHORT).show()
                    },
                )
                .padding(start = 9.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        ) {
            WithMeta(
                meta = {
                    Row(Modifier.padding(start = 10.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (msg.edited) {
                            LinkButton(
                                "Edited" + if (msg.editCount > 1) " ×${msg.editCount}" else "",
                                { showEdits = true },
                                style = WaType.meta,
                                color = c.muted,
                                icon = WaIcons.edit,
                            )
                        }
                        Text(fmt.time(msg.ts), style = WaType.meta, color = c.muted)
                        if (msg.fromMe) Ticks(msg.ack)
                    }
                },
            ) { metaWidth ->
                val trailing = with(LocalDensity.current) { (metaWidth + 4.dp).toSp() }
                Column {
                    if (deleted) {
                        val at = msg.deletedAt!!
                        val sameDay = fmt.dayKey(at) == fmt.dayKey(msg.ts)
                        Row(Modifier.padding(bottom = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            WaIcon(WaIcons.ban, 14.dp, c.danger)
                            Text(
                                (if (msg.deletedBy == "admin") "Deleted by a group admin" else "Deleted for everyone") + " · " +
                                    (if (sameDay) fmt.time(at) else fmt.dateTime(at)) + if (neverCaptured) "" else " · logged copy",
                                style = WaType.tiny.copy(fontSize = 11.7.sp, fontWeight = FontWeight.SemiBold),
                                color = c.danger,
                            )
                        }
                    } else if (msg.deletedForMeAt != null) {
                        Row(Modifier.padding(bottom = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            WaIcon(WaIcons.ban, 14.dp, c.muted)
                            Text("Deleted on your devices · logged copy", style = WaType.tiny.copy(fontSize = 11.7.sp, fontWeight = FontWeight.SemiBold), color = c.muted)
                        }
                    }
                    if (isGroup && !msg.fromMe && showSender) {
                        Text(
                            msg.senderName ?: "Unknown",
                            style = WaType.small.copy(fontWeight = FontWeight.SemiBold),
                            color = Color(colorFor(msg.senderId ?: msg.senderName ?: "")),
                            modifier = Modifier.padding(bottom = 2.dp),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (msg.isStatus) MutedText("Status update", style = WaType.small)
                    if (msg.forwarded) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            WaIcon(WaIcons.forward, 14.dp, c.muted)
                            Text("Forwarded", style = WaType.tiny.copy(fontSize = 11.7.sp, fontStyle = FontStyle.Italic), color = c.muted)
                        }
                    }
                    val quoted = msg.quoted
                    if (quoted != null) {
                        Row(
                            Modifier
                                .padding(top = 2.dp, bottom = 5.dp)
                                .widthIn(max = innerMax)
                                .height(IntrinsicSize.Min)
                                .clip(RoundedCornerShape(6.dp))
                                .background(c.quoteBg)
                                .clickable(enabled = quoted.id != null, onClickLabel = "Jump to quoted message") { quoted.id?.let(actions::jump) },
                        ) {
                            Box(Modifier.width(4.dp).fillMaxHeight().background(c.accent))
                            Column(Modifier.padding(horizontal = 8.dp, vertical = 5.dp)) {
                                Text(
                                    if (quoted.fromMe) "You" else quoted.senderName ?: "Unknown",
                                    style = WaType.tiny.copy(fontSize = 12.sp, fontWeight = FontWeight.SemiBold),
                                    color = c.accentOnPanel,
                                    maxLines = 1,
                                )
                                Text(
                                    quoted.text?.let { WaText.strip(it) } ?: QUOTE_LABEL[quoted.type] ?: "Message",
                                    style = WaType.small,
                                    color = c.text2,
                                    maxLines = 3,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                    var endsWithText = false
                    when {
                        neverCaptured -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            WaIcon(WaIcons.ban, 14.dp, c.muted)
                            Text("This message was deleted before it could be logged.", style = WaType.bubble.copy(fontStyle = FontStyle.Italic), color = c.muted)
                        }
                        msg.type == MessageType.Ciphertext -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            WaIcon(WaIcons.clock, 14.dp, c.muted)
                            Text("Waiting for this message…", style = WaType.bubble.copy(fontStyle = FontStyle.Italic), color = c.muted)
                        }
                        else -> {
                            MessageMedia(msg, innerMax)
                            Special(msg)
                            val text = msg.text
                            if (text != null && msg.type != MessageType.Poll) {
                                endsWithText = remember(text) { endsWithInlineText(text) }
                                WaTextView(text, msg.mentions, trailing = if (endsWithText) trailing else 0.sp)
                            }
                            if (msg.type == MessageType.Unknown && text == null) {
                                Text("Unsupported message type", style = WaType.small.copy(fontStyle = FontStyle.Italic), color = c.muted)
                            }
                        }
                    }
                    // Room for the time row when it can't flow into the last line of text.
                    if (!endsWithText) Spacer(Modifier.height(16.dp))
                }
            }
        }
        if (msg.reactions.isNotEmpty()) {
            val emojis = msg.reactions.map { it.emoji }.distinct().take(4).joinToString("")
            Text(
                emojis + if (msg.reactions.size > 1) " ${msg.reactions.size}" else "",
                style = WaType.small,
                color = c.text,
                modifier = Modifier
                    .offset(y = (-4).dp)
                    .padding(horizontal = 8.dp)
                    .shadow(1.dp, RoundedCornerShape(12.dp))
                    .clip(RoundedCornerShape(12.dp))
                    .background(c.panel)
                    .clickable(onClickLabel = "Show reactions") { showReactions = true }
                    .padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
    if (showEdits) EditHistoryDialog(msg) { showEdits = false }
    if (showReactions) ReactionsDialog(msg) { showReactions = false }
}
