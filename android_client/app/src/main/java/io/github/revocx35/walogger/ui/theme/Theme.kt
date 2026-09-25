package io.github.revocx35.walogger.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Design tokens of the web UI (`web/src/styles.css` :root and its dark-mode override), so the app
 * looks the same. Light/dark follows the system, like the web UI.
 */
@Immutable
data class WaColors(
    val bg: Color,
    val panel: Color,
    val panel2: Color,
    val head: Color,
    val rail: Color,
    val chatBg: Color,
    val bubbleIn: Color,
    val bubbleOut: Color,
    val text: Color,
    val text2: Color,
    val muted: Color,
    val border: Color,
    val hover: Color,
    val active: Color,
    val accent: Color,
    val accent2: Color,
    val accentText: Color,
    val link: Color,
    val danger: Color,
    val dangerBg: Color,
    val warn: Color,
    val warnBg: Color,
    val ok: Color,
    val system: Color,
    val quoteBg: Color,
    val tickRead: Color,
    /** Accent used for text on neutral backgrounds (chip label, quote sender): accent-2 light, ok dark. */
    val accentOnPanel: Color,
    val authBanner: Color,
    val avatarIconBg: Color,
    val avatarIconFg: Color,
    val shadow: Color,
    val isDark: Boolean,
)

val LightWaColors = WaColors(
    bg = Color(0xFFF0F2F5),
    panel = Color(0xFFFFFFFF),
    panel2 = Color(0xFFF0F2F5),
    head = Color(0xFFF0F2F5),
    rail = Color(0xFFF0F2F5),
    chatBg = Color(0xFFEFEAE2),
    bubbleIn = Color(0xFFFFFFFF),
    bubbleOut = Color(0xFFD9FDD3),
    text = Color(0xFF111B21),
    text2 = Color(0xFF54656F),
    muted = Color(0xFF667781),
    border = Color(0xFFE9EDEF),
    hover = Color(0xFFF5F6F6),
    active = Color(0xFFF0F2F5),
    accent = Color(0xFF00A884),
    accent2 = Color(0xFF008069),
    accentText = Color(0xFFFFFFFF),
    link = Color(0xFF027EB5),
    danger = Color(0xFFEA0038),
    dangerBg = Color(0xFFFDE8EC),
    warn = Color(0xFFFFB800),
    warnBg = Color(0xFFFFF4D1),
    ok = Color(0xFF06CF9C),
    system = Color(0xEEFFFFFF),
    quoteBg = Color(0x0D000000),
    tickRead = Color(0xFF53BDEB),
    accentOnPanel = Color(0xFF008069),
    authBanner = Color(0xFF00A884),
    avatarIconBg = Color(0xFF6A7175),
    avatarIconFg = Color(0xFFDFE5E7),
    shadow = Color(0x210B141A),
    isDark = false,
)

val DarkWaColors = WaColors(
    bg = Color(0xFF0C1317),
    panel = Color(0xFF111B21),
    panel2 = Color(0xFF202C33),
    head = Color(0xFF202C33),
    rail = Color(0xFF202C33),
    chatBg = Color(0xFF0B141A),
    bubbleIn = Color(0xFF202C33),
    bubbleOut = Color(0xFF005C4B),
    text = Color(0xFFE9EDEF),
    text2 = Color(0xFFAEBAC1),
    muted = Color(0xFF8696A0),
    border = Color(0xFF222D34),
    hover = Color(0xFF202C33),
    active = Color(0xFF2A3942),
    accent = Color(0xFF00A884),
    accent2 = Color(0xFF008069),
    accentText = Color(0xFFFFFFFF),
    link = Color(0xFF53BDEB),
    danger = Color(0xFFF15C6D),
    dangerBg = Color(0xFF3B1D22),
    warn = Color(0xFFFFB800),
    warnBg = Color(0xFF3B3218),
    ok = Color(0xFF06CF9C),
    system = Color(0xEE182229),
    quoteBg = Color(0x33000000),
    tickRead = Color(0xFF53BDEB),
    accentOnPanel = Color(0xFF06CF9C),
    authBanner = Color(0xFF103529),
    avatarIconBg = Color(0xFF3B4A54),
    avatarIconFg = Color(0xFFDFE5E7),
    shadow = Color(0x800B141A),
    isDark = true,
)

val LocalWaColors = staticCompositionLocalOf { LightWaColors }

/** Type scale of the web UI (15px base). */
object WaType {
    val base = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontFamily = FontFamily.SansSerif)
    val bubble = TextStyle(fontSize = 14.5.sp, lineHeight = 20.sp)
    val small = TextStyle(fontSize = 12.75.sp, lineHeight = 17.sp)
    val tiny = TextStyle(fontSize = 11.25.sp, lineHeight = 14.sp)
    val meta = TextStyle(fontSize = 10.5.sp, lineHeight = 13.sp)
    val chatName = TextStyle(fontSize = 15.5.sp, lineHeight = 21.sp)
    val paneTitle = TextStyle(fontSize = 21.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold)
    val pageTitle = TextStyle(fontSize = 22.5.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium)
    val sectionTitle = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium)
    val authTitle = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.Medium)
    val mono = TextStyle(fontFamily = FontFamily.Monospace)
}

object Wa {
    val colors: WaColors
        @Composable get() = LocalWaColors.current
}

@Composable
fun WaTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val c = if (dark) DarkWaColors else LightWaColors
    val scheme = if (dark) {
        darkColorScheme(
            primary = c.accent, onPrimary = c.accentText, secondary = c.accent2, background = c.bg, onBackground = c.text,
            surface = c.panel, onSurface = c.text, surfaceVariant = c.panel2, onSurfaceVariant = c.text2, outline = c.border,
            error = c.danger, surfaceContainerHigh = c.panel, surfaceContainerHighest = c.panel2, surfaceContainer = c.panel,
        )
    } else {
        lightColorScheme(
            primary = c.accent, onPrimary = c.accentText, secondary = c.accent2, background = c.bg, onBackground = c.text,
            surface = c.panel, onSurface = c.text, surfaceVariant = c.panel2, onSurfaceVariant = c.text2, outline = c.border,
            error = c.danger, surfaceContainerHigh = c.panel, surfaceContainerHighest = c.panel2, surfaceContainer = c.panel,
        )
    }
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(
            LocalWaColors provides c,
            androidx.compose.foundation.text.selection.LocalTextSelectionColors provides TextSelectionColors(c.accent, c.accent.copy(alpha = 0.3f)),
            androidx.compose.material3.LocalTextStyle provides WaType.base.copy(color = c.text),
            androidx.compose.material3.LocalContentColor provides c.text,
            content = content,
        )
    }
}
