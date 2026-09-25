package io.github.revocx35.walogger.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.revocx35.walogger.core.ChatKind
import io.github.revocx35.walogger.core.ChatSummary
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageType
import io.github.revocx35.walogger.core.WaText
import io.github.revocx35.walogger.ui.LocalFormatter
import io.github.revocx35.walogger.ui.LocalMessageActions
import io.github.revocx35.walogger.ui.MessageActions
import io.github.revocx35.walogger.ui.components.Avatar
import io.github.revocx35.walogger.ui.components.Badge
import io.github.revocx35.walogger.ui.components.BadgeTone
import io.github.revocx35.walogger.ui.components.BtnStyle
import io.github.revocx35.walogger.ui.components.EmptyState
import io.github.revocx35.walogger.ui.components.ErrorNote
import io.github.revocx35.walogger.ui.components.FilterChip
import io.github.revocx35.walogger.ui.components.IconBtn
import io.github.revocx35.walogger.ui.components.MessageBubble
import io.github.revocx35.walogger.ui.components.MutedText
import io.github.revocx35.walogger.ui.components.SearchBox
import io.github.revocx35.walogger.ui.components.Spinner
import io.github.revocx35.walogger.ui.components.WaButton
import io.github.revocx35.walogger.ui.components.WaIcon
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/* ------------------------------------------------------------------ chat list */

@Composable
fun ChatListPane(
    state: ChatListState,
    activeId: String?,
    onOpen: (String) -> Unit,
    onSearchMessages: (String) -> Unit,
    modifier: Modifier = Modifier,
    listState: LazyListState = rememberLazyListState(),
) {
    val c = Wa.colors
    val fmt = LocalFormatter.current
    Column(modifier.background(c.panel)) {
        Box(Modifier.fillMaxWidth().statusBarsPadding().height(60.dp).padding(horizontal = 16.dp), contentAlignment = Alignment.CenterStart) {
            Text("Chats", style = WaType.paneTitle, color = c.text)
        }
        SearchBox(
            state.query,
            { state.query = it },
            "Search chats · Enter searches messages",
            Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp).fillMaxWidth(),
            onSubmit = { if (state.query.trim().length >= 2) onSearchMessages(state.query.trim()) },
        )
        FlowRow(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (f in ChatFilter.entries) FilterChip(f.label, state.filter == f) { state.filter = f }
        }
        ErrorNote(state.error, Modifier.padding(horizontal = 12.dp))
        val chats = state.chats
        val visible = state.visible().distinctBy { it.id }
        when {
            chats == null -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { Spinner() }
            visible.isEmpty() -> EmptyState(WaIcons.chats, if (chats.isNotEmpty()) "No matching chats" else "No chats logged yet") {
                if (chats.isEmpty()) MutedText("Chats appear here as soon as WhatsApp is connected and messages arrive.", textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            }
            else -> LazyColumn(Modifier.weight(1f), state = listState) {
                items(visible, key = { it.id }) { chat ->
                    ChatRow(chat, chat.id == activeId, fmt.listTime(chat.lastTs)) { onOpen(chat.id) }
                }
            }
        }
    }
}

@Composable
private fun ChatRow(c: ChatSummary, active: Boolean, time: String, onClick: () -> Unit) {
    val col = Wa.colors
    Row(
        Modifier.fillMaxWidth().height(72.dp).background(if (active) col.active else col.panel).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(c.id, c.name, c.avatarUrl, c.kind)
        Column(Modifier.weight(1f).fillMaxHeight()) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(c.name, style = WaType.chatName, color = col.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(time, style = WaType.tiny, color = col.muted, maxLines = 1)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val last = c.lastMessage
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (last?.deleted == true) WaIcon(WaIcons.ban, 14.dp, col.danger)
                        val preview = if (last == null) {
                            null
                        } else {
                            buildAnnotatedString {
                                val prefix = if (c.kind == ChatKind.Group && last.senderName != null) "${last.senderName}: " else if (last.fromMe) "You: " else null
                                if (prefix != null) withStyle(SpanStyle(fontWeight = FontWeight.Medium)) { append(prefix) }
                                append(last.text?.let { WaText.strip(it) } ?: "")
                            }
                        }
                        if (preview != null) {
                            Text(preview, style = WaType.small.copy(fontSize = 13.2.sp), color = if (last?.deleted == true) col.danger else col.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        } else {
                            Text("No messages logged", style = WaType.small.copy(fontSize = 13.2.sp, fontStyle = androidx.compose.ui.text.font.FontStyle.Italic), color = col.muted, maxLines = 1)
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (c.pinned) WaIcon(WaIcons.pushpin, 14.dp, col.muted, contentDescription = "Pinned")
                        if (c.removed) Badge("removed", BadgeTone.Gray)
                        if (c.deletedCount > 0) Badge("${c.deletedCount}", BadgeTone.Red, WaIcons.ban)
                    }
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(col.border))
        }
    }
}

/** Two-pane placeholder when no chat is selected (wide screens). */
@Composable
fun NoChatSelected(modifier: Modifier = Modifier) {
    val c = Wa.colors
    Column(modifier.background(c.panel2)) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            EmptyState(WaIcons.shield, "wa_logger") {
                MutedText("Select a chat to read its log. Messages deleted for everyone stay visible here and are marked in red.", textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            }
        }
        Box(Modifier.fillMaxWidth().height(6.dp).background(c.accent))
    }
}

/* ------------------------------------------------------------------ chat view */

private sealed interface Row_ {
    val key: String
    data class Day(override val key: String, val label: String) : Row_
    data class Msg(val m: Message, val showSender: Boolean) : Row_ {
        override val key get() = m.id
    }
}

private const val GROUP_GAP_MS = 5 * 60_000L

/** The chat log: header, in-chat search, messages with sticky day separators, read-only footer. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatPane(state: ChatState, onBack: (() -> Unit)?, wide: Boolean, baseActions: MessageActions, modifier: Modifier = Modifier) {
    val c = Wa.colors
    val fmt = LocalFormatter.current
    val chat = state.chat
    val isGroup = chat?.kind == ChatKind.Group || chat?.kind == ChatKind.Status || chat?.kind == ChatKind.Broadcast
    val title = chat?.name ?: "…"
    val listState = rememberLazyListState()
    val actions = remember(baseActions, state) {
        object : MessageActions by baseActions {
            override fun jump(messageId: String) = state.jump(messageId)
        }
    }

    val rows = remember(state.messages) {
        val out = ArrayList<Row_>()
        var lastDay = Long.MIN_VALUE
        var prev: Message? = null
        for (m in state.messages.distinctBy { it.id }) {
            val dk = fmt.dayKey(m.ts)
            if (dk != lastDay) {
                out.add(Row_.Day("d-$dk", fmt.dayLabel(m.ts)))
                lastDay = dk
                prev = null
            }
            val p = prev
            val showSender = p == null || p.senderId != m.senderId || p.fromMe != m.fromMe || m.ts - p.ts > GROUP_GAP_MS || p.type == MessageType.System
            out.add(Row_.Msg(m, showSender))
            prev = m
        }
        out
    }
    val currentRows by rememberUpdatedState(rows)
    // Lazy list index of a row: one leading item ("load older" / beginning of the log).
    fun indexIn(list: List<Row_>, id: String) = list.indexOfFirst { it is Row_.Msg && it.m.id == id }.let { if (it < 0) -1 else it + 1 }
    fun nearBottom(): Boolean {
        val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: return true
        return last >= listState.layoutInfo.totalItemsCount - 3
    }

    LaunchedEffect(state) {
        state.scroll.collect { s ->
            when (s) {
                ChatScroll.Bottom -> {
                    val r = withTimeoutOrNull(5000) { snapshotFlow { currentRows }.first { it.isNotEmpty() } } ?: return@collect
                    withFrameNanos { }
                    listState.scrollToItem(r.size)
                }
                ChatScroll.Appended -> {
                    val follow = nearBottom()
                    withFrameNanos { }
                    if (follow) listState.animateScrollToItem((listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
                }
                is ChatScroll.To -> {
                    val r = withTimeoutOrNull(5000) { snapshotFlow { currentRows }.first { indexIn(it, s.messageId) >= 0 } } ?: return@collect
                    withFrameNanos { }
                    val i = indexIn(r, s.messageId)
                    // Put the message about a third down the screen (scroll to it, then back up a bit).
                    val back = listState.layoutInfo.viewportSize.height / 3f
                    if (s.smooth) {
                        listState.animateScrollToItem(i)
                        listState.animateScrollBy(-back)
                    } else {
                        listState.scrollToItem(i)
                        listState.scrollBy(-back)
                    }
                }
            }
        }
    }
    LaunchedEffect(listState, state) {
        snapshotFlow { listState.firstVisibleItemIndex }.distinctUntilChanged().filter { it < 5 }.collect { if (!state.loading) state.loadOlder() }
    }
    LaunchedEffect(listState, state) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .filter { it >= listState.layoutInfo.totalItemsCount - 5 }
            .collect { if (state.nextAfter != null) state.loadNewer() }
    }

    androidx.compose.runtime.CompositionLocalProvider(LocalMessageActions provides actions) {
        Column(modifier.background(c.chatBg)) {
            Row(
                Modifier.fillMaxWidth().background(c.head).statusBarsPadding().height(60.dp).padding(start = if (onBack != null) 4.dp else 16.dp, end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (onBack != null) IconBtn(WaIcons.back, "Back to chats", onBack)
                Avatar(state.chatId, title, chat?.avatarUrl, chat?.kind, 40.dp)
                Column(Modifier.weight(1f)) {
                    Text(title, style = WaType.chatName, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (chat != null) {
                        val sub = buildString {
                            append("${chat.messageCount} logged")
                            if (chat.deletedCount > 0) append(" · ${chat.deletedCount} deleted preserved")
                            if (chat.removed) append(" · removed from WhatsApp")
                            chat.lastTs?.let { append(" · last ${fmt.listTime(it)}") }
                        }
                        MutedText(sub, style = WaType.small, maxLines = 1)
                    }
                }
                IconBtn(WaIcons.search, "Search in chat", { state.searchOpen = !state.searchOpen }, active = state.searchOpen)
            }
            if (state.searchOpen) {
                val focus = remember { FocusRequester() }
                LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
                Column(Modifier.fillMaxWidth().background(c.panel).padding(top = 8.dp).heightIn(max = 300.dp)) {
                    SearchBox(state.searchQuery, { state.searchQuery = it }, "Search this chat", Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp).fillMaxWidth(), onSubmit = state::runSearch, focusRequester = focus)
                    val hits = state.hits
                    if (hits != null) {
                        LazyColumn {
                            if (hits.isEmpty()) item { MutedText("No results", Modifier.padding(16.dp), style = WaType.small) }
                            items(hits.distinctBy { it.message.id }, key = { it.message.id }) { h ->
                                Column(
                                    Modifier.fillMaxWidth().clickable { state.jump(h.message.id) }.padding(horizontal = 16.dp, vertical = 8.dp),
                                ) {
                                    MutedText(fmt.listTime(h.message.ts), style = WaType.small)
                                    Text(h.message.text ?: "", style = WaType.base, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                Box(Modifier.fillMaxWidth().height(1.dp).background(c.border))
                            }
                        }
                    }
                }
            }
            ErrorNote(state.error, Modifier.padding(horizontal = 16.dp))
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                val maxBubble: Dp = if (wide) minOf(maxWidth * 0.65f, 560.dp) else maxWidth * 0.85f
                val hPad = if (wide) maxWidth * 0.06f else 10.dp
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = hPad, end = hPad, top = 12.dp, bottom = 20.dp),
                ) {
                    item(key = "top") {
                        Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                            when {
                                state.loading -> Spinner()
                                state.nextBefore != null -> if (state.loadingOlder) Spinner(18.dp) else WaButton("Load older", state::loadOlder, tiny = true, style = BtnStyle.Ghost)
                                state.messages.isNotEmpty() -> MutedText("Beginning of the log for this chat", style = WaType.small)
                                else -> MutedText("No messages logged in this chat yet.", Modifier.padding(24.dp))
                            }
                        }
                    }
                    for (r in rows) {
                        when (r) {
                            is Row_.Day -> stickyHeader(key = r.key, contentType = "day") {
                                Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                                    Text(
                                        r.label,
                                        style = WaType.small.copy(fontSize = 12.sp),
                                        color = c.text2,
                                        modifier = Modifier.shadow(1.dp, RoundedCornerShape(8.dp)).clip(RoundedCornerShape(8.dp)).background(c.system).padding(horizontal = 12.dp, vertical = 5.dp),
                                    )
                                }
                            }
                            is Row_.Msg -> item(key = r.key, contentType = "msg") {
                                MessageBubble(r.m, isGroup, r.showSender, state.highlight == r.m.id, maxBubble)
                            }
                        }
                    }
                    if (state.nextAfter != null) {
                        item(key = "newer") {
                            Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                                WaButton("Load newer", state::loadNewer, tiny = true, style = BtnStyle.Ghost)
                            }
                        }
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth().background(c.head).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                WaIcon(WaIcons.lock, 14.dp, c.muted)
                MutedText("Read-only log · messages are stored encrypted on your server", style = WaType.small, maxLines = 2)
            }
        }
    }
}
