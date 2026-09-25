package io.github.revocx35.walogger.ui.components

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import io.github.revocx35.walogger.core.MediaStatus
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageType
import io.github.revocx35.walogger.core.formatBytes
import io.github.revocx35.walogger.core.formatDuration
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.ui.LocalMediaHost
import io.github.revocx35.walogger.ui.LocalMessageActions
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.launch

private val RETRYABLE = setOf(MediaStatus.Failed, MediaStatus.TooLarge, MediaStatus.Skipped, MediaStatus.Unavailable)

private fun statusText(s: MediaStatus): String = when (s) {
    MediaStatus.Pending -> "Downloading…"
    MediaStatus.Failed -> "Download failed"
    MediaStatus.TooLarge -> "Larger than the size limit — not downloaded"
    MediaStatus.Skipped -> "History media not downloaded"
    MediaStatus.Unavailable -> "No longer available on WhatsApp"
    MediaStatus.ViewOnce -> "View-once media is not logged"
    else -> ""
}

fun mediaLabel(msg: Message): String = when (msg.type) {
    MessageType.Image -> "Photo"
    MessageType.Video, MessageType.Gif -> "Video"
    MessageType.Ptt -> "Voice message"
    MessageType.Audio -> "Audio"
    MessageType.Sticker -> "Sticker"
    else -> msg.media?.filename ?: "Document"
}

private fun Modifier.dashedBorder(color: Color) = drawBehind {
    drawRoundRect(color, style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 6f))), cornerRadius = CornerRadius(6.dp.toPx()))
}

@Composable
private fun MediaPlaceholder(msg: Message) {
    val c = Wa.colors
    val media = msg.media!!
    val actions = LocalMessageActions.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    Column(Modifier.widthIn(min = 240.dp).padding(bottom = 4.dp)) {
        if (media.thumbDataUrl != null) {
            val dim = ColorFilter.colorMatrix(ColorMatrix().apply { setToScale(0.8f, 0.8f, 0.8f, 1f) })
            val bmp = rememberDataUrlBitmap(media.thumbDataUrl)
            if (bmp != null) {
                androidx.compose.foundation.Image(
                    bmp, null,
                    modifier = Modifier.widthIn(max = 330.dp).fillMaxWidth().aspectRatio(bmp.width.toFloat() / bmp.height.coerceAtLeast(1)).clip(RoundedCornerShape(6.dp))
                        .then(if (Build.VERSION.SDK_INT >= 31) Modifier.blur(3.dp) else Modifier),
                    contentScale = ContentScale.Crop,
                    colorFilter = dim,
                )
            }
        }
        FlowRow(
            Modifier.padding(horizontal = 2.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            if (media.status == MediaStatus.Pending) Spinner(18.dp) else WaIcon(if (media.status == MediaStatus.ViewOnce) WaIcons.eye else WaIcons.warning, 18.dp, c.text2)
            val parts = listOfNotNull(mediaLabel(msg), statusText(media.status).ifEmpty { null }, media.size?.let { formatBytes(it) })
            Text(parts.joinToString(" · "), style = WaType.small, color = c.text2)
            if (media.status in RETRYABLE && msg.deletedAt == null) {
                WaButton("Retry", {
                    busy = true
                    err = null
                    scope.launch {
                        try {
                            actions.retryMedia(msg.id)
                        } catch (e: Exception) {
                            err = e.userMessage()
                        } finally {
                            busy = false
                        }
                    }
                }, tiny = true, busy = busy)
            }
        }
        if (err != null) Text(err!!, style = WaType.small, color = c.danger)
    }
}

/** Photo, video, voice note, sticker or document of a message, like the web's MessageMedia. */
@Composable
fun MessageMedia(msg: Message, maxWidth: Dp) {
    val m = msg.media ?: return
    val c = Wa.colors
    val host = LocalMediaHost.current
    val actions = LocalMessageActions.current

    if (msg.type == MessageType.ViewOnce || m.status == MediaStatus.ViewOnce) {
        Row(
            Modifier.padding(bottom = 4.dp).dashedBorder(c.muted).padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            WaIcon(WaIcons.eye, 18.dp, c.text2)
            Text("View-once media · not logged by design", style = WaType.small, color = c.text2)
        }
        return
    }
    val url = host?.url(m.url)
    if (m.url == null) {
        MediaPlaceholder(msg)
        return
    }
    val width = minOf(330.dp, maxWidth)
    val w = m.width ?: 0.0
    val h = m.height ?: 0.0
    val aspect = if (w > 0 && h > 0) (w / h).toFloat() else null
    when (msg.type) {
        MessageType.Image -> {
            val shape = RoundedCornerShape(6.dp)
            Box(
                Modifier.padding(bottom = 4.dp).width(width).then(if (aspect != null) Modifier.aspectRatio(aspect.coerceIn(width.value / 420f, 3f)) else Modifier.heightIn(min = 180.dp))
                    .clip(shape).background(c.quoteBg)
                    .clickable(role = Role.Image, onClickLabel = "Open photo") { actions.openMedia(msg) },
            ) {
                if (url != null && host.imageLoader != null) {
                    AsyncImage(url, contentDescription = msg.text, imageLoader = host.imageLoader!!, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                } else {
                    DataUrlImage(m.thumbDataUrl, Modifier.fillMaxSize())
                }
            }
        }
        MessageType.Sticker -> {
            if (url != null && host.imageLoader != null) {
                AsyncImage(url, contentDescription = "Sticker", imageLoader = host.imageLoader!!, contentScale = ContentScale.Fit, modifier = Modifier.size(160.dp).clickable { actions.openMedia(msg) })
            } else {
                Box(Modifier.size(160.dp))
            }
        }
        MessageType.Video, MessageType.Gif -> {
            Column(Modifier.padding(bottom = 4.dp)) {
                Box(
                    Modifier.width(width).aspectRatio((aspect ?: (16f / 9f)).coerceIn(width.value / 420f, 3f)).clip(RoundedCornerShape(6.dp)).background(Color.Black)
                        .clickable(role = Role.Button, onClickLabel = "Play video") { actions.openMedia(msg) },
                    contentAlignment = Alignment.Center,
                ) {
                    DataUrlImage(m.thumbDataUrl, Modifier.fillMaxSize())
                    Box(Modifier.size(52.dp).clip(CircleShape).background(Color(0x99000000)), contentAlignment = Alignment.Center) {
                        WaIcon(WaIcons.play, 32.dp, Color.White)
                    }
                    if (msg.type == MessageType.Gif) {
                        Text("GIF", style = WaType.small, color = Color.White, modifier = Modifier.align(Alignment.BottomStart).padding(8.dp).clip(RoundedCornerShape(4.dp)).background(Color(0x66000000)).padding(horizontal = 6.dp, vertical = 1.dp))
                    }
                }
                val meta = listOfNotNull(formatDuration(m.durationSec).ifEmpty { null }, m.size?.let { formatBytes(it) }).joinToString(" · ")
                if (meta.isNotEmpty()) MutedText(meta, Modifier.padding(top = 4.dp), style = WaType.small)
            }
        }
        MessageType.Audio, MessageType.Ptt -> AudioRow(msg, url)
        else -> {
            Row(
                Modifier.padding(bottom = 4.dp).widthIn(min = 240.dp, max = maxWidth).clip(RoundedCornerShape(6.dp)).background(c.quoteBg)
                    .clickable(role = Role.Button, onClickLabel = "Open document") { actions.openDocument(msg) }
                    .padding(10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                WaIcon(WaIcons.file, 30.dp, c.text2)
                Column(Modifier.weight(1f)) {
                    Text(m.filename ?: "Document", style = WaType.bubble, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val type = (m.mime ?: "").substringAfterLast('/').uppercase()
                    MutedText(listOf(type, m.size?.let { formatBytes(it) } ?: "").filter { it.isNotEmpty() }.joinToString(" · "), style = WaType.small)
                }
                IconBtn(WaIcons.download, "Save", { actions.saveMedia(msg) }, size = 36.dp, iconSize = 20.dp)
            }
        }
    }
}

@Composable
private fun AudioRow(msg: Message, url: String?) {
    val c = Wa.colors
    val audio = LocalMediaHost.current?.audio
    val state = audio?.state?.collectAsState()?.value
    val my = state?.takeIf { it.id == msg.id }
    val mine = my != null
    val playing = my?.playing == true
    val total = if (my != null && my.durationMs > 0) my.durationMs else ((msg.media?.durationSec ?: 0.0) * 1000).toLong()
    val pos = my?.positionMs ?: 0L
    Row(
        Modifier.padding(bottom = 4.dp).widthIn(min = 240.dp, max = 330.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        WaIcon(if (msg.type == MessageType.Ptt) WaIcons.mic else WaIcons.file, 20.dp, c.text2)
        IconBtn(
            if (playing) WaIcons.pause else WaIcons.play,
            if (playing) "Pause" else "Play",
            { if (url != null) audio?.toggle(msg.id, url) },
            size = 36.dp,
            iconSize = 26.dp,
            tint = c.text2,
            enabled = url != null && audio != null,
        )
        Column(Modifier.weight(1f)) {
            Slider(
                value = if (total > 0) (pos.toFloat() / total).coerceIn(0f, 1f) else 0f,
                onValueChange = { f -> audio?.seek(msg.id, f) },
                enabled = mine,
                colors = SliderDefaults.colors(thumbColor = c.accent, activeTrackColor = c.accent, inactiveTrackColor = c.muted.copy(alpha = 0.35f), disabledThumbColor = c.muted, disabledInactiveTrackColor = c.muted.copy(alpha = 0.35f)),
                modifier = Modifier.heightIn(max = 28.dp),
            )
            MutedText(
                if (mine && (playing || pos > 0)) "${formatDuration(pos / 1000.0)} / ${formatDuration(total / 1000.0)}" else formatDuration(total / 1000.0),
                style = WaType.tiny,
            )
        }
    }
}
