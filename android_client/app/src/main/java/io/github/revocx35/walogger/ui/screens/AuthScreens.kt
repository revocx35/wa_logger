package io.github.revocx35.walogger.ui.screens

import android.content.ClipData
import android.content.ClipDescription
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.ui.components.BtnStyle
import io.github.revocx35.walogger.ui.components.CheckRow
import io.github.revocx35.walogger.ui.components.ErrorNote
import io.github.revocx35.walogger.ui.components.LinkButton
import io.github.revocx35.walogger.ui.components.MutedText
import io.github.revocx35.walogger.ui.components.Note
import io.github.revocx35.walogger.ui.components.WaButton
import io.github.revocx35.walogger.ui.components.WaIcon
import io.github.revocx35.walogger.ui.components.WaTextField
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** `.auth-page`: green banner behind a centered card with the wa_logger brand (like the web). */
@Composable
fun AuthShell(title: String, subtitle: String? = null, wide: Boolean = false, content: @Composable () -> Unit) {
    val c = Wa.colors
    BoxWithConstraints(Modifier.fillMaxSize().background(c.bg)) {
        val compact = maxWidth < 600.dp
        Box(Modifier.fillMaxWidth().height(220.dp).background(c.authBanner))
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).statusBarsPadding().navigationBarsPadding().imePadding()
                .padding(horizontal = if (compact) 12.dp else 16.dp, vertical = if (compact) 24.dp else 64.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier
                    .widthIn(max = if (wide) 620.dp else 440.dp)
                    .fillMaxWidth()
                    .shadow(24.dp, RoundedCornerShape(12.dp), ambientColor = Color(0x3D0B141A), spotColor = Color(0x3D0B141A))
                    .clip(RoundedCornerShape(12.dp))
                    .background(c.panel)
                    .padding(if (compact) 22.dp else 32.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(bottom = 24.dp)) {
                    Box(Modifier.size(40.dp).clip(CircleShape).background(c.accent), contentAlignment = Alignment.Center) {
                        WaIcon(WaIcons.shield, 26.dp, Color.White)
                    }
                    Text("wa_logger", style = WaType.base.copy(fontWeight = FontWeight.SemiBold), color = if (c.isDark) c.ok else c.accent2)
                }
                Text(title, style = WaType.authTitle, color = c.text, modifier = Modifier.padding(bottom = 8.dp))
                if (subtitle != null) MutedText(subtitle)
                Spacer(Modifier.height(16.dp))
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) { content() }
            }
        }
    }
}

@Composable
private fun PasswordHints(password: String, username: String) {
    val c = Wa.colors
    val long = password.codePointCount(0, password.length) >= 12
    val noUser = username.length < 3 || !password.lowercase().contains(username.lowercase())
    Column(Modifier.padding(start = 4.dp)) {
        for ((ok, text) in listOf(long to "At least 12 characters (a passphrase of 4+ words is best)", noUser to "Does not contain your username")) {
            Text("•  $text", style = WaType.small, color = if (ok) (if (c.isDark) c.ok else c.accent2) else c.muted)
        }
    }
}

class AuthActions(
    val signup: suspend (token: String, user: String, password: String) -> Unit,
    val login: suspend (user: String, password: String, totp: String?) -> Boolean, // true = TOTP needed
    val recover: suspend (user: String, key: String, password: String) -> Unit,
)

@Composable
fun SignupScreen(actions: AuthActions, onChangeServer: () -> Unit) {
    var token by rememberSaveable { mutableStateOf("") }
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val submit: () -> Unit = submit@{
        error = null
        if (password != confirm) {
            error = "Passwords do not match."
            return@submit
        }
        busy = true
        scope.launch {
            try {
                actions.signup(token.trim(), username.trim(), password)
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                busy = false
            }
        }
    }
    AuthShell("Create your account", "This instance has no owner yet. Create the single owner account to start logging your WhatsApp.") {
        WaTextField(token, { token = it }, "Setup token", placeholder = "SETUP_TOKEN from your .env file", mono = true)
        WaTextField(username, { username = it }, "Username")
        WaTextField(password, { password = it }, "Password", password = true)
        WaTextField(confirm, { confirm = it }, "Confirm password", password = true, imeAction = ImeAction.Done, onIme = submit)
        PasswordHints(password, username)
        Note("Your logs are encrypted with a key derived from this password. If you lose both the password and the recovery key, the logged data cannot be recovered by anyone.", WaIcons.lock)
        ErrorNote(error)
        WaButton("Create account", submit, style = BtnStyle.Primary, block = true, busy = busy, enabled = token.isNotBlank() && username.length >= 3 && password.length >= 12)
        ServerFooter(onChangeServer)
    }
}

@Composable
fun LoginScreen(actions: AuthActions, onRecover: () -> Unit, onChangeServer: () -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf("") }
    var needTotp by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val submit: () -> Unit = {
        error = null
        busy = true
        scope.launch {
            try {
                if (actions.login(username.trim(), password, if (needTotp) totp.replace(" ", "") else null)) needTotp = true
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                busy = false
            }
        }
    }
    AuthShell("Log in", "Unlock your encrypted WhatsApp log.") {
        WaTextField(username, { username = it }, "Username", enabled = !needTotp)
        WaTextField(password, { password = it }, "Password", password = true, enabled = !needTotp, imeAction = if (needTotp) ImeAction.Next else ImeAction.Done, onIme = { if (!needTotp) submit() })
        if (needTotp) {
            WaTextField(totp, { totp = it.filter { ch -> ch.isDigit() || ch == ' ' }.take(7) }, "Authentication code", keyboardType = KeyboardType.NumberPassword, placeholder = "123456", imeAction = ImeAction.Done, onIme = submit)
        }
        ErrorNote(error)
        WaButton(if (needTotp) "Verify" else "Log in", submit, style = BtnStyle.Primary, block = true, busy = busy, enabled = username.isNotBlank() && password.isNotEmpty())
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            LinkButton("Forgot your password?", onRecover, style = WaType.small)
        }
        ServerFooter(onChangeServer)
    }
}

@Composable
fun RecoverScreen(actions: AuthActions, onBack: () -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val submit: () -> Unit = submit@{
        error = null
        if (password != confirm) {
            error = "Passwords do not match."
            return@submit
        }
        busy = true
        scope.launch {
            try {
                actions.recover(username.trim(), key, password)
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                busy = false
            }
        }
    }
    androidx.activity.compose.BackHandler(onBack = onBack)
    AuthShell("Recover access", "Use the recovery key you saved during signup to set a new password. Two-factor authentication will be turned off.") {
        WaTextField(username, { username = it }, "Username")
        WaTextField(key, { key = it }, "Recovery key", mono = true, singleLine = false, minLines = 3)
        WaTextField(password, { password = it }, "New password", password = true)
        WaTextField(confirm, { confirm = it }, "Confirm new password", password = true, imeAction = ImeAction.Done, onIme = submit)
        PasswordHints(password, username)
        ErrorNote(error)
        WaButton("Reset password", submit, style = BtnStyle.Primary, block = true, busy = busy)
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            LinkButton("Back to login", onBack, style = WaType.small)
        }
    }
}

/** Copies a secret without it showing up in clipboard previews (Android 13+) or keyboard suggestions. */
fun copySensitive(context: android.content.Context, label: String, text: String) {
    val clip = ClipData.newPlainText(label, text)
    clip.description.extras = PersistableBundle().apply {
        putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
    }
    context.getSystemService(android.content.ClipboardManager::class.java)?.setPrimaryClip(clip)
}

@Composable
fun RecoveryKeyBox(recoveryKey: String) {
    val c = Wa.colors
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(2000)
            copied = false
        }
    }
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp).clip(RoundedCornerShape(8.dp)).background(c.panel2).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        androidx.compose.foundation.text.selection.SelectionContainer(Modifier.weight(1f)) {
            Text(recoveryKey, style = WaType.mono.copy(fontSize = 16.sp, letterSpacing = 0.6.sp), color = c.text)
        }
        WaButton(if (copied) "Copied" else "Copy", { copySensitive(context, "Recovery key", recoveryKey); copied = true }, style = BtnStyle.Ghost)
    }
}

@Composable
fun SetupRecoveryScreen(recoveryKey: String?, onContinue: () -> Unit) {
    var ack by remember { mutableStateOf(false) }
    if (recoveryKey == null) {
        AuthShell("Recovery key", "The recovery key is only shown once. You can create a new one any time in Settings → Recovery key.") {
            WaButton("Continue", onContinue, style = BtnStyle.Primary, block = true)
        }
        return
    }
    AuthShell(
        "Save your recovery key",
        "This key is the only way to regain access to your logs if you forget your password. It is shown only once — store it in a password manager or print it.",
        wide = true,
    ) {
        RecoveryKeyBox(recoveryKey)
        CheckRow(ack, { ack = it }, "I have stored my recovery key somewhere safe")
        WaButton("Continue", onContinue, style = BtnStyle.Primary, block = true, enabled = ack)
    }
}

@Composable
fun ServerFooter(onChangeServer: () -> Unit) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        LinkButton("Change server", onChangeServer, style = WaType.small, color = Wa.colors.muted, icon = WaIcons.server)
    }
}

/** Full-screen message when the server can't be reached (like the web's fallback). */
@Composable
fun UnreachableScreen(error: String?, onRetry: () -> Unit, onChangeServer: () -> Unit, onReviewCertificate: (() -> Unit)?, busy: Boolean) {
    val c = Wa.colors
    Column(
        Modifier.fillMaxSize().background(c.bg).statusBarsPadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        WaIcon(WaIcons.warning, 40.dp, c.muted)
        Text("Cannot reach the wa_logger server.", color = c.muted, style = WaType.base, textAlign = TextAlign.Center)
        if (error != null) MutedText(error, style = WaType.small, textAlign = TextAlign.Center)
        if (onReviewCertificate != null) WaButton("Review certificate", onReviewCertificate, style = BtnStyle.Primary)
        WaButton("Retry", onRetry, busy = busy)
        LinkButton("Change server", onChangeServer, style = WaType.small, color = c.muted, icon = WaIcons.server)
    }
}
