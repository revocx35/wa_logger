package io.github.revocx35.walogger.ui.screens

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.revocx35.walogger.core.ChatKind
import io.github.revocx35.walogger.core.ChatSummary
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.SearchHit
import io.github.revocx35.walogger.core.ServerEvent
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.data.ServerSession
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import java.text.Normalizer

enum class ChatFilter(val label: String) { All("All"), Groups("Groups"), Deleted("Has deleted"), Archived("Archived") }

private val MARKS = Regex("\\p{M}+")
fun normalizeForSearch(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFKD).replace(MARKS, "").lowercase()

/** What the chat list UI needs (implemented by [ChatListViewModel]; faked in screenshot tests). */
interface ChatListState {
    val chats: List<ChatSummary>?
    val error: String?
    var query: String
    var filter: ChatFilter

    fun visible(): List<ChatSummary> {
        val list = chats ?: return emptyList()
        val q = normalizeForSearch(query.trim())
        return list.filter { c ->
            // Like WhatsApp: archived chats only show under "Archived" (the deleted filter shows everything).
            when (filter) {
                ChatFilter.Archived -> if (!c.archived) return@filter false
                ChatFilter.Deleted -> Unit
                else -> if (c.archived) return@filter false
            }
            if (filter == ChatFilter.Groups && c.kind != ChatKind.Group) return@filter false
            if (filter == ChatFilter.Deleted && c.deletedCount == 0) return@filter false
            if (q.isNotEmpty() && !normalizeForSearch(c.name).contains(q)) return@filter false
            true
        }
    }
}

/** Chat list (like the web's ChatList): filters, name search and debounced live reloads. */
class ChatListViewModel(private val session: ServerSession) : ViewModel(), ChatListState {
    override var chats by mutableStateOf<List<ChatSummary>?>(null)
        private set
    override var error by mutableStateOf<String?>(null)
        private set
    override var query by mutableStateOf("")
    override var filter by mutableStateOf(ChatFilter.All)
    private var debounce: Job? = null

    init {
        load()
        viewModelScope.launch {
            session.events.events.collect { ev ->
                if (ev is ServerEvent.NewMessage || ev is ServerEvent.ChatUpdate || (ev is ServerEvent.MessageUpdate && ev.reason == "deleted")) {
                    debounce?.cancel()
                    debounce = viewModelScope.launch {
                        delay(600)
                        load()
                    }
                }
            }
        }
        viewModelScope.launch { session.events.reopened.collect { load() } }
    }

    fun load() {
        viewModelScope.launch {
            try {
                chats = session.api.chats()
                error = null
            } catch (e: Exception) {
                error = session.fail(javaClass.simpleName, e)
            }
        }
    }
}

sealed interface ChatScroll {
    data object Bottom : ChatScroll
    data class To(val messageId: String, val smooth: Boolean) : ChatScroll
    /** A live message arrived at the end: follow it if the list is at the bottom. */
    data object Appended : ChatScroll
}

/** What the chat UI needs (implemented by [ChatViewModel]; faked in screenshot tests). */
interface ChatState {
    val chatId: String
    val chat: ChatSummary?
    val messages: List<Message>
    val nextBefore: String?
    val nextAfter: String?
    val loading: Boolean
    val loadingOlder: Boolean
    var error: String?
    val highlight: String?
    var searchOpen: Boolean
    var searchQuery: String
    val hits: List<SearchHit>?
    val scroll: SharedFlow<ChatScroll>
    fun loadOlder()
    fun loadNewer()
    fun jump(messageId: String)
    fun runSearch()
}

/** One chat's log (like the web's ChatView): paging both ways, jump to a message, live updates, in-chat search. */
class ChatViewModel(private val session: ServerSession, override val chatId: String, focusId: String?) : ViewModel(), ChatState {
    override var chat by mutableStateOf<ChatSummary?>(null)
        private set
    override var messages by mutableStateOf<List<Message>>(emptyList())
        private set
    override var nextBefore by mutableStateOf<String?>(null)
        private set
    override var nextAfter by mutableStateOf<String?>(null)
        private set
    override var loading by mutableStateOf(true)
        private set
    override var loadingOlder by mutableStateOf(false)
        private set
    override var error by mutableStateOf<String?>(null)
    override var highlight by mutableStateOf<String?>(null)
        private set

    override var searchOpen by mutableStateOf(false)
    override var searchQuery by mutableStateOf("")
    override var hits by mutableStateOf<List<SearchHit>?>(null)
        private set

    private val _scroll = MutableSharedFlow<ChatScroll>(extraBufferCapacity = 8)
    override val scroll: SharedFlow<ChatScroll> = _scroll

    private var loadingNewer = false
    private var highlightJob: Job? = null

    init {
        loadChatInfo()
        loadInitial(focusId)
        viewModelScope.launch {
            session.events.events.collect { ev ->
                when {
                    (ev is ServerEvent.NewMessage && ev.chatId == chatId) -> {
                        if (nextAfter != null) return@collect // viewing older history; loads when scrolling down
                        fetchAndUpsert(ev.messageId, appended = true)
                        loadChatInfo()
                    }
                    (ev is ServerEvent.MessageUpdate && ev.chatId == chatId) -> {
                        fetchAndUpsert(ev.messageId, appended = false)
                        if (ev.reason == "deleted") loadChatInfo()
                    }
                    (ev is ServerEvent.ChatUpdate && ev.chatId == chatId) -> loadChatInfo()
                }
            }
        }
        viewModelScope.launch { session.events.reopened.collect { if (nextAfter == null) catchUp() } }
    }

    private fun sortMessages(list: List<Message>) = list.sortedWith(compareBy<Message>({ it.ts }, { it.capturedAt }))

    private fun loadChatInfo() {
        viewModelScope.launch {
            runCatching { session.api.chats() }.onSuccess { all -> chat = all.firstOrNull { it.id == chatId } }
        }
    }

    private fun loadInitial(focusId: String?) {
        viewModelScope.launch {
            loading = true
            error = null
            try {
                val page = if (focusId != null) session.api.messagesAround(chatId, focusId) else session.api.messages(chatId)
                messages = page.messages
                nextBefore = page.nextBefore
                nextAfter = page.nextAfter
                if (focusId != null && page.messages.any { it.id == focusId }) {
                    flash(focusId)
                    _scroll.tryEmit(ChatScroll.To(focusId, smooth = false))
                } else {
                    _scroll.tryEmit(ChatScroll.Bottom)
                }
            } catch (e: Exception) {
                error = session.fail(javaClass.simpleName, e)
            } finally {
                loading = false
            }
        }
    }

    /** After the live stream reconnects: pick up whatever arrived meanwhile. */
    private fun catchUp() {
        viewModelScope.launch {
            runCatching { session.api.messages(chatId) }.onSuccess { page ->
                val known = messages.associateBy { it.id }
                val merged = messages.toMutableList()
                var added = false
                for (m in page.messages) {
                    val i = merged.indexOfFirst { it.id == m.id }
                    if (i >= 0) merged[i] = m else { merged.add(m); added = true }
                }
                messages = sortMessages(merged)
                if (added && known.isNotEmpty()) _scroll.tryEmit(ChatScroll.Appended)
            }
            loadChatInfo()
        }
    }

    private fun fetchAndUpsert(id: String, appended: Boolean) {
        viewModelScope.launch {
            runCatching { session.api.message(id) }.onSuccess { m ->
                val i = messages.indexOfFirst { it.id == m.id }
                messages = if (i >= 0) messages.toMutableList().also { it[i] = m } else sortMessages(messages + m)
                if (appended && i < 0) _scroll.tryEmit(ChatScroll.Appended)
            }
        }
    }

    override fun loadOlder() {
        val cursor = nextBefore ?: return
        if (loadingOlder || loading) return
        loadingOlder = true
        viewModelScope.launch {
            try {
                val page = session.api.messages(chatId, cursor)
                val known = messages.mapTo(HashSet()) { it.id }
                messages = sortMessages(page.messages.filter { it.id !in known } + messages)
                nextBefore = page.nextBefore
            } catch (e: Exception) {
                error = session.fail(javaClass.simpleName, e)
            } finally {
                loadingOlder = false
            }
        }
    }

    override fun loadNewer() {
        val cursor = nextAfter ?: return
        if (loadingNewer || loading) return
        loadingNewer = true
        viewModelScope.launch {
            try {
                val page = session.api.messagesAfter(chatId, cursor, 60)
                val known = messages.mapTo(HashSet()) { it.id }
                messages = sortMessages(messages + page.messages.filter { it.id !in known })
                nextAfter = page.nextAfter
            } catch (e: Exception) {
                error = session.fail(javaClass.simpleName, e)
            } finally {
                loadingNewer = false
            }
        }
    }

    private fun flash(id: String) {
        highlight = id
        highlightJob?.cancel()
        highlightJob = viewModelScope.launch {
            delay(2500)
            highlight = null
        }
    }

    /** Scroll to a (quoted / searched) message, loading the page around it when it isn't loaded. */
    override fun jump(messageId: String) {
        if (messages.any { it.id == messageId }) {
            flash(messageId)
            _scroll.tryEmit(ChatScroll.To(messageId, smooth = true))
        } else {
            loadInitial(messageId)
        }
    }

    override fun runSearch() {
        val q = searchQuery.trim()
        if (q.length < 2) return
        viewModelScope.launch {
            try {
                hits = session.api.search(q, chatId).hits
            } catch (e: Exception) {
                error = session.fail(javaClass.simpleName, e)
            }
        }
    }
}
