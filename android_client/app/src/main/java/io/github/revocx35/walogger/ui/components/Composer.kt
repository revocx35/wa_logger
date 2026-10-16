package io.github.revocx35.walogger.ui.components

import android.Manifest
import android.content.ClipData
import android.content.ClipDescription
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageType
import io.github.revocx35.walogger.core.SendMediaKind
import io.github.revocx35.walogger.core.WaText
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.media.VoiceRecorder
import io.github.revocx35.walogger.ui.MessageSelection
import io.github.revocx35.walogger.ui.MessageSender
import io.github.revocx35.walogger.ui.OutgoingFile
import io.github.revocx35.walogger.ui.SEND_MAX_BYTES
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/** One-line description of a message for the reply/edit bar. */
fun previewOf(m: Message): String {
    m.text?.let { return WaText.strip(it).take(120) }
    return when (m.type) {
        MessageType.Image -> "Photo"
        MessageType.Video -> "Video"
        MessageType.Gif -> "GIF"
        MessageType.Ptt -> "Voice message"
        MessageType.Audio -> "Audio"
        MessageType.Document -> "Document"
        MessageType.Sticker -> "Sticker"
        else -> "Message"
    }
}

/** Copies message text, kept out of clipboard previews and keyboard suggestions. */
fun copyMessageText(context: Context, text: String) {
    val clip = ClipData.newPlainText("message", text)
    clip.description.extras = PersistableBundle().apply {
        putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
    }
    context.getSystemService(android.content.ClipboardManager::class.java)?.setPrimaryClip(clip)
    if (Build.VERSION.SDK_INT < 33) android.widget.Toast.makeText(context, "Copied", android.widget.Toast.LENGTH_SHORT).show()
}

private fun describe(context: Context, uri: Uri): OutgoingFile {
    val resolver = context.contentResolver
    var name: String? = null
    var size = -1L
    runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                name = c.getString(0)
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
    }
    return OutgoingFile(uri, name, resolver.getType(uri) ?: "application/octet-stream", size)
}

private fun formatSize(n: Long): String = when {
    n < 0 -> ""
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> "${n / 1024} KB"
    else -> String.format(java.util.Locale.ROOT, "%.1f MB", n / 1024.0 / 1024.0)
}

private val PHOTO_OR_VIDEO = Regex("^(image/(jpeg|png|webp|gif)|video/(mp4|3gpp|quicktime))$")

@Composable
private fun ComposeBar(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, text: String, onClose: () -> Unit, extra: (@Composable () -> Unit)? = null) {
    val c = Wa.colors
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(c.panel).padding(start = 0.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.width(4.dp).heightIn(min = 44.dp).background(c.accent))
        WaIcon(icon, 16.dp, c.text2)
        Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
            Text(title, style = WaType.small.copy(fontWeight = FontWeight.Medium), color = c.accent2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(text, style = WaType.small, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        extra?.invoke()
        IconBtn(WaIcons.close, "Cancel", onClose, size = 32.dp, iconSize = 18.dp)
    }
}

/**
 * Message composer (the web's Composer): text, replies, edits of own messages, one file at a time (the text
 * becomes its caption) and voice notes. What is sent shows up in the chat through the live updates.
 */
@Composable
fun Composer(
    chatId: String,
    sender: MessageSender,
    replyTo: Message?,
    editing: Message?,
    disabledReason: String?,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Wa.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var text by remember(chatId) { mutableStateOf("") }
    var file by remember(chatId) { mutableStateOf<OutgoingFile?>(null) }
    var asDocument by remember(chatId) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember(chatId) { mutableStateOf<String?>(null) }
    val recorder = remember { VoiceRecorder(context.applicationContext) }
    var recording by remember { mutableStateOf(false) }
    var elapsed by remember { mutableLongStateOf(0L) }
    val focus = remember { FocusRequester() }

    LaunchedEffect(editing?.id, replyTo?.id) {
        if (editing != null) text = editing.text ?: ""
        if (editing != null || replyTo != null) runCatching { focus.requestFocus() }
    }
    LaunchedEffect(recording) {
        while (recording) {
            elapsed = (System.currentTimeMillis() - recorder.startedAt) / 1000
            delay(250)
        }
    }
    // Never leave the microphone on when the chat closes.
    DisposableEffect(Unit) { onDispose { recorder.cancel() } }

    val disabled = disabledReason != null || busy

    fun launchSend(block: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            try {
                block()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                busy = false
            }
        }
    }

    fun send() {
        if (disabled) return
        val body = text
        val ed = editing
        val f = file
        when {
            ed != null -> {
                if (body.isBlank() || body == ed.text) {
                    text = ""
                    onDone()
                    return
                }
                launchSend {
                    sender.edit(ed.id, body)
                    text = ""
                    onDone()
                }
            }
            f != null -> launchSend {
                sender.sendFile(chatId, f, if (asDocument) SendMediaKind.Document else SendMediaKind.Auto, body.takeIf { it.isNotBlank() }, replyTo?.id)
                file = null
                asDocument = false
                text = ""
                onDone()
            }
            body.isNotBlank() -> launchSend {
                sender.sendText(chatId, body, replyTo?.id)
                text = ""
                onDone()
            }
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val f = describe(context, uri)
        if (f.size > SEND_MAX_BYTES) {
            error = "The file is too large (64 MB at most)."
            return@rememberLauncherForActivityResult
        }
        error = null
        file = f
        asDocument = !PHOTO_OR_VIDEO.matches(f.mime)
    }

    fun startRecording() {
        error = null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            error = "Voice messages need Android 10 or newer."
            return
        }
        if (recorder.start()) {
            elapsed = 0
            recording = true
        } else {
            error = "Could not start recording."
        }
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording() else error = "Microphone access was refused."
    }

    fun stopRecording(sendIt: Boolean) {
        recording = false
        if (!sendIt) {
            recorder.cancel()
            return
        }
        val rec: File? = recorder.stop()
        if (rec == null) {
            error = "Too short."
            return
        }
        launchSend {
            try {
                sender.sendFile(chatId, OutgoingFile(Uri.fromFile(rec), "voice.ogg", "audio/ogg", rec.length()), SendMediaKind.Voice, null, replyTo?.id)
                onDone()
            } finally {
                rec.delete()
            }
        }
    }

    Column(modifier.fillMaxWidth().background(c.head).navigationBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        when {
            editing != null -> ComposeBar(WaIcons.edit, "Edit message", previewOf(editing), {
                text = ""
                onDone()
            })
            replyTo != null -> ComposeBar(WaIcons.enter, if (replyTo.fromMe) "You" else replyTo.senderName ?: "Reply", previewOf(replyTo), onDone)
        }
        file?.let { f ->
            val photoOrVideo = f.mime.startsWith("image/") || f.mime.startsWith("video/")
            ComposeBar(
                if (f.mime.startsWith("image/")) WaIcons.image else if (f.mime.startsWith("video/")) WaIcons.video else WaIcons.file,
                f.name ?: "File",
                listOf(formatSize(f.size), "the text below becomes the caption").filter { it.isNotEmpty() }.joinToString(" · "),
                { file = null },
            ) {
                if (photoOrVideo) CheckRow(asDocument, { asDocument = it }, "As file", modifier = Modifier.width(110.dp))
            }
        }
        error?.let { Text(it, style = WaType.small, color = c.danger, modifier = Modifier.padding(horizontal = 6.dp)) }
        disabledReason?.let { Text(it, style = WaType.small, color = c.muted, modifier = Modifier.padding(horizontal = 6.dp)) }
        if (recording) {
            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                IconBtn(WaIcons.deleted, "Discard recording", { stopRecording(false) }, tint = c.danger)
                Box(Modifier.size(10.dp).clip(CircleShape).background(c.danger))
                Text(String.format(java.util.Locale.ROOT, "%d:%02d", elapsed / 60, elapsed % 60), style = WaType.base, color = c.text)
                Text("Recording a voice message…", style = WaType.small, color = c.muted, modifier = Modifier.weight(1f), maxLines = 1)
                SendButton("Send voice message") { stopRecording(true) }
            }
        } else {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (editing == null) IconBtn(WaIcons.attach, "Attach a file", { picker.launch("*/*") }, enabled = !disabled)
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    enabled = disabledReason == null,
                    textStyle = WaType.base.copy(color = c.text, fontSize = 15.sp),
                    cursorBrush = SolidColor(c.accent),
                    maxLines = 6,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, capitalization = KeyboardCapitalization.Sentences, autoCorrectEnabled = true),
                    modifier = Modifier
                        .weight(1f)
                        .focusRequester(focus)
                        .heightIn(min = 40.dp)
                        .clip(RoundedCornerShape(20.dp))
                        .background(c.panel)
                        .border(1.dp, c.border, RoundedCornerShape(20.dp))
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    decorationBox = { inner ->
                        Box {
                            if (text.isEmpty()) Text(if (editing != null) "Edit message" else if (file != null) "Add a caption" else "Message", style = WaType.base.copy(fontSize = 15.sp), color = c.muted, maxLines = 1)
                            inner()
                        }
                    },
                )
                when {
                    busy -> Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) { Spinner(20.dp) }
                    text.isNotBlank() || file != null || editing != null -> SendButton(if (editing != null) "Save edit" else "Send", if (editing != null) WaIcons.check else WaIcons.send, !disabled) { send() }
                    else -> IconBtn(WaIcons.mic, "Record a voice message", {
                        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startRecording()
                        else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    }, enabled = !disabled)
                }
            }
        }
    }
}

@Composable
private fun SendButton(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector = WaIcons.send, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Wa.colors
    Box(
        Modifier.size(40.dp).clip(CircleShape).background(c.accent).clickable(enabled = enabled, role = Role.Button, onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { WaIcon(icon, 20.dp, c.accentText, contentDescription = label) }
}

private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")
private const val EDIT_WINDOW_MS = 15 * 60_000L
private const val REVOKE_WINDOW_MS = 2 * 24 * 3600_000L

/** Long-press menu of a message: reactions, reply, copy, edit, delete for everyone, select (photos/videos). */
@Composable
fun MessageMenu(
    msg: Message,
    canSend: Boolean,
    onReply: () -> Unit,
    onEdit: () -> Unit,
    onReact: (String) -> Unit,
    onRevoke: () -> Unit,
    onSelect: (() -> Unit)?,
    onClose: () -> Unit,
) {
    val c = Wa.colors
    val context = LocalContext.current
    var confirmRevoke by remember { mutableStateOf(false) }
    val age = System.currentTimeMillis() - msg.ts
    val mine = msg.reactions.firstOrNull { it.fromMe }?.emoji
    WaDialog(previewOf(msg).ifBlank { "Message" }, onClose) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (canSend) {
                Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    for (e in QUICK_REACTIONS) {
                        Box(
                            Modifier.size(44.dp).clip(CircleShape).background(if (mine == e) c.active else c.panel).clickable(role = Role.Button, onClickLabel = "React $e") {
                                onClose()
                                onReact(if (mine == e) "" else e)
                            },
                            contentAlignment = Alignment.Center,
                        ) { Text(e, fontSize = 22.sp) }
                    }
                }
                MenuItem(WaIcons.enter, "Reply") {
                    onClose()
                    onReply()
                }
            }
            msg.text?.let { t ->
                MenuItem(WaIcons.copy, "Copy text") {
                    onClose()
                    copyMessageText(context, t)
                }
            }
            if (onSelect != null) {
                MenuItem(WaIcons.check, "Select") {
                    onClose()
                    onSelect()
                }
            }
            if (canSend && msg.fromMe && msg.type == MessageType.Chat && age < EDIT_WINDOW_MS) {
                MenuItem(WaIcons.edit, "Edit") {
                    onClose()
                    onEdit()
                }
            }
            if (canSend && msg.fromMe && age < REVOKE_WINDOW_MS) {
                if (confirmRevoke) {
                    MenuItem(WaIcons.deleted, "Yes, delete for everyone", danger = true) {
                        onClose()
                        onRevoke()
                    }
                } else {
                    MenuItem(WaIcons.deleted, "Delete for everyone…", danger = true) { confirmRevoke = true }
                }
            }
        }
    }
}

@Composable
private fun MenuItem(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, danger: Boolean = false, onClick: () -> Unit) {
    val c = Wa.colors
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 8.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        WaIcon(icon, 20.dp, if (danger) c.danger else c.text2)
        Text(label, style = WaType.base, color = if (danger) c.danger else c.text)
    }
}

/** Whether the menu should offer "Select" (photos/videos that can be saved to the gallery). */
fun selectableForMenu(msg: Message): Boolean = MessageSelection.selectable(msg)

/** Start a chat with any number on WhatsApp. */
@Composable
fun NewChatDialog(sender: MessageSender, onOpen: (String) -> Unit, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var phone by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun submit() {
        if (phone.count { it.isDigit() } < 6 || busy) return
        busy = true
        error = null
        scope.launch {
            try {
                val id = sender.newChat(phone)
                onClose()
                onOpen(id)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                busy = false
            }
        }
    }
    WaDialog("New chat", onClose) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            WaTextField(phone, { phone = it }, "Phone number with country code", keyboardType = KeyboardType.Phone, imeAction = androidx.compose.ui.text.input.ImeAction.Go, onIme = { submit() }, placeholder = "+90 555 123 45 67")
            ErrorNote(error)
            WaButton("Open chat", { submit() }, style = BtnStyle.Primary, enabled = phone.count { it.isDigit() } >= 6, busy = busy, block = true)
        }
    }
}
