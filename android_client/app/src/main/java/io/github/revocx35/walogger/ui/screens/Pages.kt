package io.github.revocx35.walogger.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.revocx35.walogger.core.ChatKind
import io.github.revocx35.walogger.core.DeletedFeedItem
import io.github.revocx35.walogger.core.SearchResponse
import io.github.revocx35.walogger.core.ServerEvent
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.data.ServerSession
import io.github.revocx35.walogger.ui.LocalFormatter
import io.github.revocx35.walogger.ui.components.Avatar
import io.github.revocx35.walogger.ui.components.Badge
import io.github.revocx35.walogger.ui.components.BadgeTone
import io.github.revocx35.walogger.ui.components.BtnStyle
import io.github.revocx35.walogger.ui.components.EmptyState
import io.github.revocx35.walogger.ui.components.ErrorNote
import io.github.revocx35.walogger.ui.components.MessageBubble
import io.github.revocx35.walogger.ui.components.MutedText
import io.github.revocx35.walogger.ui.components.PageHeader
import io.github.revocx35.walogger.ui.components.SearchBox
import io.github.revocx35.walogger.ui.components.Spinner
import io.github.revocx35.walogger.ui.components.WaButton
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.launch

/* ---------------------------------------------------------------- deleted */

interface DeletedState {
    val items: List<DeletedFeedItem>?
    val next: String?
    val error: String?
    val busy: Boolean
    fun load(more: Boolean)
}

class DeletedViewModel(private val session: ServerSession) : ViewModel(), DeletedState {
    override var items by mutableStateOf<List<DeletedFeedItem>?>(null)
        private set
    override var next by mutableStateOf<String?>(null)
        private set
    override var error by mutableStateOf<String?>(null)
        private set
    override var busy by mutableStateOf(false)
        private set

    init {
        load(false)
        viewModelScope.launch {
            session.events.events.collect { if (it is ServerEvent.MessageUpdate && it.reason == "deleted") load(false) }
        }
        viewModelScope.launch { session.events.reopened.collect { load(false) } }
    }

    override fun load(more: Boolean) {
        val before = if (more) next ?: return else null
        busy = true
        viewModelScope.launch {
            try {
                val page = session.api.deleted(before)
                items = if (more) (items ?: emptyList()) + page.items else page.items
                next = page.nextBefore
                error = null
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                busy = false
            }
        }
    }
}

/** Page scaffold like the web's `.page`: scrolling panel with a header. */
@Composable
fun PageColumn(modifier: Modifier = Modifier, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    BoxWithConstraints(modifier.fillMaxSize().background(Wa.colors.panel)) {
        val side = if (maxWidth < 900.dp) 16.dp else minOf(maxWidth * 0.05f, 48.dp)
        LazyColumn(
            Modifier.fillMaxSize().statusBarsPadding(),
            contentPadding = PaddingValues(start = side, end = side, top = if (maxWidth < 900.dp) 16.dp else 24.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}

@Composable
fun DeletedScreen(state: DeletedState, onOpen: (chatId: String, messageId: String) -> Unit) {
    val c = Wa.colors
    val fmt = LocalFormatter.current
    PageColumn {
        item {
            PageHeader(WaIcons.deleted, "Deleted messages", "Everything that was deleted for everyone (or on your devices) after it was logged, newest deletion first.")
        }
        item { ErrorNote(state.error) }
        val items = state.items
        when {
            items == null -> item { Spinner() }
            items.isEmpty() -> item {
                EmptyState(WaIcons.deleted, "Nothing deleted yet") { MutedText("When someone deletes a message you received, the logged copy shows up here.", textAlign = androidx.compose.ui.text.style.TextAlign.Center) }
            }
            else -> {
                items(items, key = { it.message.id }) { (chat, message) ->
                    BoxWithConstraints(Modifier.widthIn(max = 900.dp).fillMaxWidth()) {
                        val maxBubble = maxWidth - 28.dp
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(c.chatBg).padding(horizontal = 14.dp, vertical = 10.dp)) {
                            FlowRow(
                                Modifier.fillMaxWidth().padding(bottom = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                                itemVerticalAlignment = Alignment.CenterVertically,
                            ) {
                                Avatar(chat.id, chat.name, null, chat.kind, 32.dp)
                                Text(chat.name, style = WaType.base.copy(fontWeight = FontWeight.Bold), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                MutedText("deleted ${message.deletedAt?.let { fmt.dateTime(it) } ?: "—"}", style = WaType.small)
                                WaButton("Open in chat", { onOpen(chat.id, message.id) }, tiny = true, style = BtnStyle.Ghost)
                            }
                            MessageBubble(message, chat.kind == ChatKind.Group, showSender = true, highlighted = false, maxBubbleWidth = maxBubble)
                        }
                    }
                }
                if (state.next != null) {
                    item {
                        WaButton("Load more", { state.load(true) }, block = true, busy = state.busy, modifier = Modifier.widthIn(max = 900.dp))
                    }
                }
            }
        }
    }
}

/* ----------------------------------------------------------------- search */

class SearchViewModel(private val session: ServerSession, initial: String) : ViewModel() {
    var query by mutableStateOf(initial)
    var result by mutableStateOf<SearchResponse?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set

    init {
        if (initial.trim().length >= 2) run()
    }

    fun run() {
        val q = query.trim()
        if (q.length < 2) return
        busy = true
        error = null
        viewModelScope.launch {
            try {
                result = session.api.search(q)
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                busy = false
            }
        }
    }
}

@Composable
fun SearchScreen(query: String, onQuery: (String) -> Unit, result: SearchResponse?, error: String?, busy: Boolean, onRun: () -> Unit, onOpen: (chatId: String, messageId: String) -> Unit) {
    val c = Wa.colors
    val fmt = LocalFormatter.current
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (result == null) runCatching { focus.requestFocus() } }
    PageColumn {
        item {
            PageHeader(WaIcons.search, "Search messages", "Searches decrypted text, captions, polls, locations and contact cards across all chats (including deleted messages).")
        }
        item {
            SearchBox(query, onQuery, "At least 2 characters", Modifier.widthIn(max = 900.dp).fillMaxWidth().padding(vertical = 4.dp), onSubmit = onRun, focusRequester = focus) {
                WaButton("Search", onRun, style = BtnStyle.Primary, busy = busy, enabled = query.trim().length >= 2, tiny = true, modifier = Modifier.padding(end = 4.dp))
            }
        }
        item { ErrorNote(error) }
        if (result != null) {
            item {
                MutedText("${result.hits.size} result${if (result.hits.size == 1) "" else "s"}" + if (result.truncated) " (search stopped early — refine your query for more)" else "", style = WaType.small)
            }
            items(result.hits, key = { it.message.id }) { h ->
                Row(
                    Modifier.widthIn(max = 900.dp).fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(c.panel2).clickable { onOpen(h.chat.id, h.message.id) }.padding(horizontal = 12.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Avatar(h.chat.id, h.chat.name, null, h.chat.kind, 36.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(h.chat.name, style = WaType.base.copy(fontWeight = FontWeight.Bold), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            MutedText(fmt.dateTime(h.message.ts), style = WaType.small)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (h.message.deletedAt != null) Badge("deleted", BadgeTone.Red)
                            Text(
                                "${if (h.message.fromMe) "You" else h.message.senderName ?: ""}: ${h.message.text ?: ""}",
                                style = WaType.base,
                                color = c.text2,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun NotFound(onHome: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Wa.colors.panel), contentAlignment = Alignment.Center) {
        EmptyState(WaIcons.warning, "Page not found") { WaButton("Back to chats", onHome) }
    }
}
