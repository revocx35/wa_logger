package io.github.revocx35.walogger.ui.screens

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import io.github.revocx35.walogger.core.CallRecording
import io.github.revocx35.walogger.core.CallRecordingStatus
import io.github.revocx35.walogger.core.ChatKind
import io.github.revocx35.walogger.core.ServerEvent
import io.github.revocx35.walogger.core.formatBytes
import io.github.revocx35.walogger.core.formatDuration
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.data.ServerSession
import io.github.revocx35.walogger.media.buildPlayer
import io.github.revocx35.walogger.ui.LocalFormatter
import io.github.revocx35.walogger.ui.components.Avatar
import io.github.revocx35.walogger.ui.components.BtnStyle
import io.github.revocx35.walogger.ui.components.ConfirmButton
import io.github.revocx35.walogger.ui.components.Divider
import io.github.revocx35.walogger.ui.components.EmptyState
import io.github.revocx35.walogger.ui.components.ErrorNote
import io.github.revocx35.walogger.ui.components.IconBtn
import io.github.revocx35.walogger.ui.components.MutedText
import io.github.revocx35.walogger.ui.components.PageHeader
import io.github.revocx35.walogger.ui.components.Spinner
import io.github.revocx35.walogger.ui.components.WaButton
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.launch

/** The "Calls" tab: recorded calls, newest first (the web's `/calls`). */
@Composable
fun RecordingsScreen(session: ServerSession, onOpenChat: (String) -> Unit) {
    var items by remember { mutableStateOf<List<CallRecording>?>(null) }
    var next by remember { mutableStateOf<Int?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var playing by remember { mutableStateOf<CallRecording?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load(before: Int?) {
        busy = true
        try {
            val page = session.api.callRecordings(before)
            items = if (before != null) items.orEmpty() + page.items else page.items
            next = page.nextBefore
            error = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            error = e.userMessage()
        } finally {
            busy = false
        }
    }

    LaunchedEffect(Unit) { load(null) }
    LaunchedEffect(Unit) {
        session.events.events.collect { if (it is ServerEvent.CallRecordingChanged) load(null) }
    }
    // Same as after a dropped event stream: refresh what was missed.
    LaunchedEffect(Unit) { session.events.reopened.collect { load(null) } }

    BoxWithConstraints(Modifier.fillMaxSize().background(Wa.colors.panel)) {
        val side = if (maxWidth < 900.dp) 16.dp else minOf(maxWidth * 0.05f, 48.dp)
        Column(
            Modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = side, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PageHeader(
                WaIcons.phone,
                "Call recordings",
                "Calls you recorded with the record button during a call, or automatically (Settings → Logging). The files are encrypted like everything else here. Check that the other person knows: recording a call without consent is not allowed everywhere.",
            )
            ErrorNote(error)
            val list = items
            when {
                list == null -> if (error == null) Spinner()
                list.isEmpty() -> EmptyState(WaIcons.phone, "No recordings yet") {
                    Text("Press the record button during a call, or turn on “Record calls automatically” in Settings.", style = WaType.base)
                }
                else -> Column {
                    list.forEachIndexed { i, r ->
                        if (i > 0) Divider()
                        RecordingRow(r, onPlay = { playing = r }, onOpenChat = onOpenChat) {
                            scope.launch {
                                try {
                                    session.api.deleteCallRecording(r.id)
                                    items = items?.filterNot { it.id == r.id }
                                } catch (e: Exception) {
                                    if (e is kotlinx.coroutines.CancellationException) throw e
                                    error = e.userMessage()
                                }
                            }
                        }
                    }
                    next?.let { n -> WaButton("Load more", { scope.launch { load(n) } }, busy = busy, modifier = Modifier.padding(top = 8.dp)) }
                }
            }
        }
    }
    playing?.let { RecordingPlayer(session, it) { playing = null } }
}

@Composable
private fun RecordingRow(r: CallRecording, onPlay: () -> Unit, onOpenChat: (String) -> Unit, onDelete: () -> Unit) {
    val c = Wa.colors
    val fmt = LocalFormatter.current
    val name = r.name ?: "Unknown"
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Avatar(r.chatId ?: r.id.toString(), name, r.avatarUrl, ChatKind.User, 40.dp)
            Column(Modifier.weight(1f)) {
                Text(name, style = WaType.chatName.copy(fontWeight = FontWeight.SemiBold), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                MutedText(
                    (if (r.direction == "incoming") "Incoming " else "Outgoing ") + (if (r.video) "video " else "") + "call · " + fmt.dateTime(r.startedAt) +
                        (r.durationMs?.let { " · " + formatDuration(it / 1000.0) } ?: "") + (r.size?.let { " · " + formatBytes(it) } ?: "") + (if (r.auto) " · automatic" else ""),
                    style = WaType.small,
                )
            }
        }
        when (r.status) {
            CallRecordingStatus.Recording -> Text("● Recording now…", style = WaType.small.copy(fontWeight = FontWeight.SemiBold), color = c.danger)
            CallRecordingStatus.Processing -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Spinner(14.dp)
                MutedText("Saving the recording…", style = WaType.small)
            }
            CallRecordingStatus.Failed -> ErrorNote("This recording could not be saved.")
            CallRecordingStatus.Ready -> Unit
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (r.status == CallRecordingStatus.Ready && r.url != null) WaButton("Play", onPlay, tiny = true, style = BtnStyle.Primary, icon = WaIcons.play)
            r.chatId?.let { WaButton("Open chat", { onOpenChat(it) }, tiny = true, style = BtnStyle.Ghost) }
            if (r.status != CallRecordingStatus.Recording && r.status != CallRecordingStatus.Processing) ConfirmButton("Delete", "Delete recording", onDelete, style = BtnStyle.Ghost)
        }
    }
}

/** Plays a recording (audio or video) full screen with the system player controls; streams through the server client. */
@OptIn(UnstableApi::class)
@Composable
private fun RecordingPlayer(session: ServerSession, r: CallRecording, onClose: () -> Unit) {
    val url = session.mediaUrl(r.url) ?: return
    val context = LocalContext.current
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            val player = remember {
                buildPlayer(context, session.api.http).apply {
                    setMediaItem(MediaItem.fromUri(url))
                    prepare()
                    playWhenReady = true
                }
            }
            DisposableEffect(player) { onDispose { player.release() } }
            AndroidView(
                factory = { ctx -> PlayerView(ctx).apply { this.player = player; setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS); controllerShowTimeoutMs = 0 } },
                modifier = Modifier.fillMaxSize().padding(top = 56.dp),
            )
            Row(Modifier.fillMaxWidth().background(Color(0x99000000)).statusBarsPadding().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconBtn(WaIcons.back, "Close", onClose, tint = Color.White)
                Text(r.name ?: "Call recording", color = Color.White, style = WaType.base, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 8.dp))
            }
        }
    }
}
