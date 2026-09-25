package io.github.revocx35.walogger.ui.components

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import io.github.revocx35.walogger.core.ChatKind
import io.github.revocx35.walogger.core.colorFor
import io.github.revocx35.walogger.core.initials
import io.github.revocx35.walogger.ui.LocalMediaHost
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType

/** Profile picture, or the web UI's fallbacks: group icon, status ring, colored initials. */
@Composable
fun Avatar(id: String, name: String, url: String?, kind: ChatKind? = null, size: Dp = 49.dp, modifier: Modifier = Modifier) {
    val c = Wa.colors
    val host = LocalMediaHost.current
    val abs = remember(url, host) { host?.url(url) }
    var failed by remember(abs) { mutableStateOf(false) }
    val base = modifier.size(size).clip(CircleShape)
    val loader = host?.imageLoader
    if (abs != null && loader != null && !failed) {
        AsyncImage(
            model = abs,
            contentDescription = null,
            imageLoader = loader,
            contentScale = ContentScale.Crop,
            modifier = base.background(c.panel2),
            onError = { failed = true },
        )
        return
    }
    when (kind) {
        ChatKind.Group, ChatKind.Broadcast -> Box(base.background(c.avatarIconBg), contentAlignment = Alignment.Center) {
            WaIcon(WaIcons.group, size * 0.55f, c.avatarIconFg)
        }
        ChatKind.Status -> Box(
            modifier.size(size).border(2.dp, c.accent, CircleShape).clip(CircleShape).background(c.avatarIconBg),
            contentAlignment = Alignment.Center,
        ) {
            WaIcon(WaIcons.refresh, size * 0.5f, c.avatarIconFg)
        }
        else -> Box(base.background(Color(colorFor(id))), contentAlignment = Alignment.Center) {
            val fontSize = with(LocalDensity.current) { (size * 0.38f).toSp() }
            Text(initials(name), color = Color.White, style = WaType.base.copy(fontSize = fontSize, lineHeight = fontSize, fontWeight = FontWeight.SemiBold), maxLines = 1)
        }
    }
}

private val DATA_URL = Regex("^data:image/(jpeg|png|webp);base64,")

/** Decodes a small inline `data:image/…;base64,` thumbnail (as provided by WhatsApp). */
@Composable
fun rememberDataUrlBitmap(dataUrl: String?): ImageBitmap? = remember(dataUrl) {
    if (dataUrl == null) return@remember null
    val m = DATA_URL.find(dataUrl) ?: return@remember null
    runCatching {
        val bytes = Base64.decode(dataUrl.substring(m.range.last + 1), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    }.getOrNull()
}

@Composable
fun DataUrlImage(dataUrl: String?, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop) {
    val bmp = rememberDataUrlBitmap(dataUrl) ?: return
    Image(bmp, contentDescription = null, modifier = modifier, contentScale = contentScale)
}
