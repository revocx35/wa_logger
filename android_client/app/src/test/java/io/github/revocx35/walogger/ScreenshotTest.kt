package io.github.revocx35.walogger

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import io.github.revocx35.walogger.core.ChatSummary
import io.github.revocx35.walogger.core.DeletedFeedItem
import io.github.revocx35.walogger.core.Formatter
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.SearchHit
import io.github.revocx35.walogger.core.SearchResponse
import io.github.revocx35.walogger.ui.BottomRail
import io.github.revocx35.walogger.ui.LocalFormatter
import io.github.revocx35.walogger.ui.NoMessageActions
import io.github.revocx35.walogger.ui.SideRail
import io.github.revocx35.walogger.ui.Tab
import io.github.revocx35.walogger.ui.screens.AuthActions
import io.github.revocx35.walogger.ui.screens.ChatFilter
import io.github.revocx35.walogger.ui.screens.ChatListPane
import io.github.revocx35.walogger.ui.screens.ChatListState
import io.github.revocx35.walogger.ui.screens.ChatPane
import io.github.revocx35.walogger.ui.screens.ChatScroll
import io.github.revocx35.walogger.ui.screens.ChatState
import io.github.revocx35.walogger.ui.screens.DeletedScreen
import io.github.revocx35.walogger.ui.screens.DeletedState
import io.github.revocx35.walogger.ui.screens.LoginScreen
import io.github.revocx35.walogger.ui.screens.SearchScreen
import io.github.revocx35.walogger.ui.screens.SetupRecoveryScreen
import io.github.revocx35.walogger.ui.screens.SignupScreen
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaTheme
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.Locale

private class FakeChatList(override val chats: List<ChatSummary>?) : ChatListState {
    override val error: String? = null
    override var query by mutableStateOf("")
    override var filter by mutableStateOf(ChatFilter.All)
}

private class FakeChat(override val chat: ChatSummary?, override val messages: List<Message>, override val highlight: String? = null) : ChatState {
    override val chatId: String = chat?.id ?: "x@c.us"
    override val nextBefore: String? = null
    override val nextAfter: String? = null
    override val loading = false
    override val loadingOlder = false
    override var error: String? = null
    override var searchOpen = false
    override var searchQuery = ""
    override val hits: List<SearchHit>? = null
    override val scroll: SharedFlow<ChatScroll> = MutableSharedFlow()
    override fun loadOlder() = Unit
    override fun loadNewer() = Unit
    override fun jump(messageId: String) = Unit
    override fun runSearch() = Unit
}

private class FakeDeleted(override val items: List<DeletedFeedItem>?) : DeletedState {
    override val next: String? = "more"
    override val error: String? = null
    override val busy = false
    override fun load(more: Boolean) = Unit
}

private val noAuth = AuthActions({ _, _, _ -> }, { _, _, _ -> false }, { _, _, _ -> })

/**
 * Renders the main screens with sample data (JVM, Robolectric native graphics) so the design can be
 * compared with the web UI's screenshots. Record with `./gradlew :app:recordRoborazziDebug`.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w400dp-h860dp-xxhdpi")
class ScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private fun shot(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        compose.setContent {
            WaTheme(dark) {
                CompositionLocalProvider(LocalFormatter provides Formatter(Locale.US, SampleData.zone, use24h = false)) {
                    Box(Modifier.fillMaxSize().background(Wa.colors.bg)) { content() }
                }
            }
        }
        compose.onRoot().captureRoboImage("build/screenshots/$name.png")
    }

    private val aliSummary get() = SampleData.chats.first { it.id == SampleData.ALI }
    private val groupSummary get() = SampleData.chats.first { it.id == SampleData.GROUP }

    @Test
    fun phoneChatList() = shot("phone_chats") {
        Column(Modifier.fillMaxSize()) {
            ChatListPane(FakeChatList(SampleData.chats), null, {}, {}, Modifier.weight(1f).fillMaxWidth())
            BottomRail(Tab.Chats) {}
        }
    }

    @Test
    fun phoneChatListDark() = shot("phone_chats_dark", dark = true) {
        Column(Modifier.fillMaxSize()) {
            ChatListPane(FakeChatList(SampleData.chats), null, {}, {}, Modifier.weight(1f).fillMaxWidth())
            BottomRail(Tab.Chats) {}
        }
    }

    @Test
    fun phoneChat() = shot("phone_chat_ali") {
        ChatPane(FakeChat(aliSummary, SampleData.aliChat), {}, false, NoMessageActions, Modifier.fillMaxSize())
    }

    @Test
    fun phoneChatDark() = shot("phone_chat_ali_dark", dark = true) {
        ChatPane(FakeChat(aliSummary, SampleData.aliChat), {}, false, NoMessageActions, Modifier.fillMaxSize())
    }

    @Test
    fun phoneGroup() = shot("phone_chat_group") {
        ChatPane(FakeChat(groupSummary, SampleData.groupChat, highlight = null), {}, false, NoMessageActions, Modifier.fillMaxSize())
    }

    @Test
    fun phoneDeleted() = shot("phone_deleted") {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) { DeletedScreen(FakeDeleted(SampleData.deleted)) { _, _ -> } }
            BottomRail(Tab.Deleted) {}
        }
    }

    @Test
    fun phoneSearch() = shot("phone_search") {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) { SearchScreen("plan", {}, SearchResponse(SampleData.hits, false), null, false, {}, { _, _ -> }) }
            BottomRail(Tab.Search) {}
        }
    }

    @Test
    fun phoneLogin() = shot("phone_login") { LoginScreen(noAuth, {}, {}) }

    @Test
    fun phoneSignupDark() = shot("phone_signup_dark", dark = true) { SignupScreen(noAuth) {} }

    @Test
    fun phoneRecoveryKey() = shot("phone_recovery_key") { SetupRecoveryScreen("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QR") {} }

    @Config(qualifiers = "w1280dp-h800dp-mdpi")
    @Test
    fun tabletTwoPane() = shot("tablet_two_pane") {
        Row(Modifier.fillMaxSize()) {
            SideRail(Tab.Chats, SampleData.ready, {}, {})
            ChatListPane(FakeChatList(SampleData.chats), SampleData.ALI, {}, {}, Modifier.widthIn(min = 300.dp, max = 440.dp).width(400.dp).fillMaxHeight())
            Box(Modifier.width(1.dp).fillMaxHeight().background(Wa.colors.border))
            ChatPane(FakeChat(aliSummary, SampleData.aliChat), null, true, NoMessageActions, Modifier.weight(1f).fillMaxHeight())
        }
    }
}
