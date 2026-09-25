package io.github.revocx35.walogger.media

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import coil3.compose.AsyncImage
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageType
import io.github.revocx35.walogger.data.ServerSession
import io.github.revocx35.walogger.ui.components.IconBtn
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType

/** Full-screen photo (pinch to zoom) or video/GIF player, like the web's lightbox. */
@OptIn(UnstableApi::class)
@Composable
fun MediaViewer(session: ServerSession, msg: Message, onSave: () -> Unit, onClose: () -> Unit) {
    val url = session.mediaUrl(msg.media?.url) ?: return
    val context = LocalContext.current
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            when (msg.type) {
                MessageType.Video, MessageType.Gif -> {
                    val player = remember {
                        buildPlayer(context, session.api.http).apply {
                            setMediaItem(MediaItem.fromUri(url))
                            repeatMode = if (msg.type == MessageType.Gif) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                            if (msg.type == MessageType.Gif) volume = 0f
                            prepare()
                            playWhenReady = true
                        }
                    }
                    DisposableEffect(player) { onDispose { player.release() } }
                    AndroidView(
                        factory = { ctx -> PlayerView(ctx).apply { this.player = player; setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS) } },
                        modifier = Modifier.fillMaxSize().padding(top = 56.dp),
                    )
                }
                else -> {
                    var scale by remember { mutableFloatStateOf(1f) }
                    var offset by remember { mutableStateOf(Offset.Zero) }
                    AsyncImage(
                        url,
                        contentDescription = msg.text,
                        imageLoader = session.imageLoader,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .fillMaxSize()
                            .pointerInput(Unit) {
                                detectTransformGestures { _, pan, zoom, _ ->
                                    scale = (scale * zoom).coerceIn(1f, 6f)
                                    offset = if (scale == 1f) Offset.Zero else offset + pan
                                }
                            }
                            .pointerInput(Unit) { detectTapGestures(onDoubleTap = { if (scale > 1f) { scale = 1f; offset = Offset.Zero } else scale = 2.5f }) }
                            .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().background(Color(0x99000000)).statusBarsPadding().padding(horizontal = 4.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconBtn(WaIcons.back, "Close", onClose, tint = Color.White)
                Text(
                    msg.media?.filename ?: if (msg.type == MessageType.Image || msg.type == MessageType.Sticker) "Photo" else "Video",
                    color = Color.White,
                    style = WaType.base,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                )
                IconBtn(WaIcons.download, "Save", onSave, tint = Color.White)
            }
        }
    }
}
