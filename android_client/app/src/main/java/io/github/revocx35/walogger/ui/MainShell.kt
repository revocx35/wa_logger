package io.github.revocx35.walogger.ui

import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import io.github.revocx35.walogger.core.AppState
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageEdit
import io.github.revocx35.walogger.core.WaState
import io.github.revocx35.walogger.core.WaStatus
import io.github.revocx35.walogger.data.AppGraph
import io.github.revocx35.walogger.data.ServerSession
import io.github.revocx35.walogger.media.MediaOps
import io.github.revocx35.walogger.media.MediaViewer
import io.github.revocx35.walogger.ui.components.WaIcon
import io.github.revocx35.walogger.ui.components.WaStatePill
import io.github.revocx35.walogger.ui.components.WarnBanner
import io.github.revocx35.walogger.ui.screens.ChatListPane
import io.github.revocx35.walogger.ui.screens.ChatListViewModel
import io.github.revocx35.walogger.ui.screens.ChatPane
import io.github.revocx35.walogger.ui.screens.ChatViewModel
import io.github.revocx35.walogger.ui.screens.DeletedScreen
import io.github.revocx35.walogger.ui.screens.DeletedViewModel
import io.github.revocx35.walogger.ui.screens.NoChatSelected
import io.github.revocx35.walogger.ui.screens.SearchScreen
import io.github.revocx35.walogger.ui.screens.SearchViewModel
import io.github.revocx35.walogger.ui.screens.SettingsDeps
import io.github.revocx35.walogger.ui.screens.SettingsScreen
import io.github.revocx35.walogger.ui.screens.WaWebScreen
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable object ChatsRoute
@Serializable data class ChatRoute(val chatId: String, val focus: String? = null)
@Serializable object DeletedRoute
@Serializable data class SearchRoute(val q: String = "")
@Serializable object WaWebRoute
@Serializable object SettingsRoute

enum class Tab(val label: String, val icon: ImageVector) {
    Chats("Chats", WaIcons.chats), Deleted("Deleted", WaIcons.deleted), Search("Search", WaIcons.search), WaWeb("WA Web", WaIcons.monitor), Settings("Settings", WaIcons.settings)
}

private fun tabRoute(t: Tab): Any = when (t) {
    Tab.Chats -> ChatsRoute
    Tab.Deleted -> DeletedRoute
    Tab.Search -> SearchRoute()
    Tab.WaWeb -> WaWebRoute
    Tab.Settings -> SettingsRoute
}

private fun NavHostController.goTab(t: Tab) = navigate(tabRoute(t)) {
    popUpTo(graph.findStartDestination().id) { saveState = true }
    launchSingleTop = true
    restoreState = true
}

@Composable
private fun RailItem(label: String, icon: ImageVector, active: Boolean, compact: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Wa.colors
    Column(
        modifier.width(if (compact) 58.dp else 60.dp).clip(RoundedCornerShape(12.dp)).background(if (active) c.active else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(role = Role.Tab, onClickLabel = label, onClick = onClick).padding(vertical = if (compact) 4.dp else 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        WaIcon(icon, 22.dp, if (active) c.accent else c.text2)
        Text(label, style = WaType.tiny.copy(fontSize = 10.2.sp, lineHeight = 12.sp), color = if (active) c.accent else c.text2, maxLines = 1)
    }
}

/** Media actions for bubbles: viewer, save (system file picker), open with another app, retry, edits. */
@Composable
private fun rememberMediaActions(session: ServerSession, context: Context, onView: (Message) -> Unit): Pair<MessageActions, (Message) -> Unit> {
    val scope = rememberCoroutineScope()
    var pendingSave by remember { mutableStateOf<Message?>(null) }
    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val msg = pendingSave
        pendingSave = null
        if (uri != null && msg != null) scope.launch { MediaOps.saveTo(context, session, msg, uri) }
    }
    val save: (Message) -> Unit = { msg ->
        pendingSave = msg
        saveLauncher.launch(MediaOps.defaultName(msg))
    }
    val actions = remember(session) {
        object : MessageActions {
            override fun openMedia(msg: Message) = onView(msg)
            override fun saveMedia(msg: Message) = save(msg)
            override fun openDocument(msg: Message) {
                scope.launch { MediaOps.open(context, session, msg) }
            }
            override suspend fun retryMedia(messageId: String) {
                session.api.retryMedia(messageId)
            }
            override suspend fun edits(messageId: String): List<MessageEdit> = session.api.edits(messageId)
        }
    }
    return actions to save
}

/**
 * The logged-in app, laid out like the web UI: a menu rail (left on wide screens, bottom on phones,
 * hidden inside a chat) and a two-pane chat list + chat on wide screens.
 */
@Composable
fun MainShell(graph: AppGraph, session: ServerSession, state: AppState, wa: WaStatus?, onLogout: () -> Unit, onChangeServer: () -> Unit) {
    val c = Wa.colors
    val context = LocalContext.current
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val dest = entry?.destination
    val inChat = dest?.hasRoute<ChatRoute>() == true
    val activeTab = when {
        dest == null -> Tab.Chats
        dest.hasRoute<ChatsRoute>() || inChat -> Tab.Chats
        dest.hasRoute<DeletedRoute>() -> Tab.Deleted
        dest.hasRoute<SearchRoute>() -> Tab.Search
        dest.hasRoute<WaWebRoute>() -> Tab.WaWeb
        dest.hasRoute<SettingsRoute>() -> Tab.Settings
        else -> null
    }
    var viewing by remember { mutableStateOf<Message?>(null) }
    val (actions, save) = rememberMediaActions(session, context) { viewing = it }
    val chatList: ChatListViewModel = viewModel(key = "chats:${session.id}") { ChatListViewModel(session) }
    val chatListState = rememberLazyListState()
    val needsAttention = wa?.state == WaState.Disconnected || wa?.state == WaState.Qr

    fun openChat(id: String, focus: String? = null, replace: Boolean = false) {
        nav.navigate(ChatRoute(id, focus)) {
            if (replace) popUpTo<ChatsRoute>()
            launchSingleTop = focus == null
        }
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(c.panel)) {
        val wide = maxWidth >= 900.dp

        val content: @Composable ColumnScope.() -> Unit = {
            if (needsAttention) {
                WarnBanner(Modifier.windowInsetsPadding(WindowInsets.statusBars)) {
                    Text(
                        buildAnnotatedString {
                            append("WhatsApp is ${if (wa.state == WaState.Qr) "not linked" else "disconnected"} — new messages are not being logged. ")
                            withStyle(SpanStyle(color = c.link, textDecoration = TextDecoration.Underline)) { append("Open WA Web") }
                            append(" to relink.")
                        },
                        style = WaType.small,
                        color = c.text,
                        modifier = Modifier.clickable { nav.goTab(Tab.WaWeb) },
                    )
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth().then(if (needsAttention) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)) {
                CompositionLocalProviderActions(actions) {
                    NavHost(nav, startDestination = ChatsRoute, modifier = Modifier.fillMaxSize()) {
                        composable<ChatsRoute> {
                            if (wide) {
                                Row(Modifier.fillMaxSize()) {
                                    ChatListPane(chatList, null, { openChat(it) }, { nav.navigate(SearchRoute(it)) }, Modifier.widthIn(min = 300.dp, max = 440.dp).fillMaxWidth(0.3f).fillMaxHeight(), chatListState)
                                    Box(Modifier.width(1.dp).fillMaxHeight().background(c.border))
                                    NoChatSelected(Modifier.weight(1f).fillMaxHeight())
                                }
                            } else {
                                ChatListPane(chatList, null, { openChat(it) }, { nav.navigate(SearchRoute(it)) }, Modifier.fillMaxSize(), chatListState)
                            }
                        }
                        composable<ChatRoute> { back ->
                            val r = back.toRoute<ChatRoute>()
                            val vm: ChatViewModel = viewModel(key = "chat:${session.id}:${r.chatId}:${r.focus}") { ChatViewModel(session, r.chatId, r.focus) }
                            if (wide) {
                                Row(Modifier.fillMaxSize()) {
                                    ChatListPane(chatList, r.chatId, { openChat(it, replace = true) }, { nav.navigate(SearchRoute(it)) }, Modifier.widthIn(min = 300.dp, max = 440.dp).fillMaxWidth(0.3f).fillMaxHeight(), chatListState)
                                    Box(Modifier.width(1.dp).fillMaxHeight().background(c.border))
                                    ChatPane(vm, null, true, actions, Modifier.weight(1f).fillMaxHeight())
                                }
                            } else {
                                ChatPane(vm, { nav.popBackStack() }, false, actions, Modifier.fillMaxSize())
                            }
                        }
                        composable<DeletedRoute> {
                            val vm: DeletedViewModel = viewModel(key = "deleted:${session.id}") { DeletedViewModel(session) }
                            DeletedScreen(vm) { chatId, messageId -> openChat(chatId, messageId) }
                        }
                        composable<SearchRoute> { back ->
                            val r = back.toRoute<SearchRoute>()
                            val vm: SearchViewModel = viewModel(key = "search:${session.id}:${r.q}") { SearchViewModel(session, r.q) }
                            SearchScreen(vm.query, { vm.query = it }, vm.result, vm.error, vm.busy, vm::run) { chatId, messageId -> openChat(chatId, messageId) }
                        }
                        composable<WaWebRoute> { WaWebScreen(session.api, wa) }
                        composable<SettingsRoute> {
                            SettingsScreen(
                                SettingsDeps(
                                    api = session.api,
                                    graph = graph,
                                    username = state.username,
                                    totpEnabled = state.totpEnabled == true,
                                    wa = wa,
                                    refresh = { graph.controller.refresh().join() },
                                    onChangeServer = onChangeServer,
                                ),
                            )
                        }
                    }
                }
            }
        }

        if (wide) {
            Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.ime.exclude(WindowInsets.navigationBars))) {
                SideRail(activeTab, wa, { nav.goTab(it) }, onLogout)
                Column(Modifier.weight(1f).fillMaxHeight(), content = content)
            }
        } else {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.ime.exclude(WindowInsets.navigationBars))) {
                content()
                if (!inChat) BottomRail(activeTab) { if (it == null) onLogout() else nav.goTab(it) }
            }
        }
    }

    viewing?.let { msg -> MediaViewer(session, msg, onSave = { save(msg) }, onClose = { viewing = null }) }
}

/** The web's `.rail` on wide screens: menu items on top, WhatsApp status and log out at the bottom. */
@Composable
fun SideRail(active: Tab?, wa: WaStatus?, onTab: (Tab) -> Unit, onLogout: () -> Unit) {
    val c = Wa.colors
    Row(Modifier.fillMaxHeight()) {
        Column(
            Modifier.width(72.dp).fillMaxHeight().background(c.rail).statusBarsPadding().navigationBarsPadding().padding(vertical = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (t in Tab.entries) RailItem(t.label, t.icon, active == t, false, { onTab(t) })
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.clip(RoundedCornerShape(12.dp)).clickable { onTab(Tab.WaWeb) }.padding(6.dp)) { WaStatePill(wa, compact = true) }
                RailItem("Log out", WaIcons.logout, false, false, onLogout)
            }
        }
        Box(Modifier.width(1.dp).fillMaxHeight().background(c.border))
    }
}

/** The rail at the bottom on phones (hidden inside a chat). [onTab] gets null for "Log out". */
@Composable
fun BottomRail(active: Tab?, onTab: (Tab?) -> Unit) {
    val c = Wa.colors
    Column {
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.border))
        Row(
            Modifier.fillMaxWidth().background(c.rail).navigationBarsPadding().padding(horizontal = 6.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            for (t in Tab.entries) RailItem(t.label, t.icon, active == t, true, { onTab(t) })
            RailItem("Log out", WaIcons.logout, false, true, { onTab(null) })
        }
    }
}

@Composable
private fun CompositionLocalProviderActions(actions: MessageActions, content: @Composable () -> Unit) =
    androidx.compose.runtime.CompositionLocalProvider(LocalMessageActions provides actions, content = content)
