package io.github.revocx35.walogger.ui.screens

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import io.github.revocx35.walogger.BuildConfig
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.AuditEntry
import io.github.revocx35.walogger.core.SessionInfo
import io.github.revocx35.walogger.core.Settings
import io.github.revocx35.walogger.core.SettingsPatch
import io.github.revocx35.walogger.core.TotpSetupResponse
import io.github.revocx35.walogger.core.WaStatus
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.data.AppGraph
import io.github.revocx35.walogger.data.ServerTrust
import io.github.revocx35.walogger.ui.LocalFormatter
import io.github.revocx35.walogger.ui.components.Badge
import io.github.revocx35.walogger.ui.components.BadgeTone
import io.github.revocx35.walogger.ui.components.BtnStyle
import io.github.revocx35.walogger.ui.components.CheckRow
import io.github.revocx35.walogger.ui.components.ConfirmButton
import io.github.revocx35.walogger.ui.components.Divider
import io.github.revocx35.walogger.ui.components.ErrorNote
import io.github.revocx35.walogger.ui.components.FilterChip
import io.github.revocx35.walogger.ui.components.MutedText
import io.github.revocx35.walogger.ui.components.OkNote
import io.github.revocx35.walogger.ui.components.PageHeader
import io.github.revocx35.walogger.ui.components.SectionCard
import io.github.revocx35.walogger.ui.components.Spinner
import io.github.revocx35.walogger.ui.components.SwitchRow
import io.github.revocx35.walogger.ui.components.WaButton
import io.github.revocx35.walogger.ui.components.WaStatePill
import io.github.revocx35.walogger.ui.components.WaTextField
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** busy / error / ok for one form, like the web's useAsync(). */
private class AsyncOp(private val scope: CoroutineScope) {
    var busy by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var ok by mutableStateOf<String?>(null)

    fun run(success: String? = null, then: () -> Unit = {}, block: suspend () -> Unit) {
        busy = true
        error = null
        ok = null
        scope.launch {
            try {
                block()
                ok = success
                then()
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                busy = false
            }
        }
    }
}

@Composable
private fun rememberOp(): AsyncOp {
    val scope = rememberCoroutineScope()
    return remember { AsyncOp(scope) }
}

class SettingsDeps(
    val api: ApiClient,
    val graph: AppGraph?,
    val username: String?,
    val totpEnabled: Boolean,
    val wa: WaStatus?,
    val refresh: suspend () -> Unit,
    val onChangeServer: () -> Unit,
)

@Composable
fun SettingsScreen(deps: SettingsDeps) {
    val scroll = rememberScrollState()
    val scope = rememberCoroutineScope()
    val positions = remember { mutableStateMapOf<String, Int>() }
    val toc = listOf("password" to "Password", "2fa" to "2FA", "recovery" to "Recovery key", "sessions" to "Sessions", "logging" to "Logging", "whatsapp" to "WhatsApp", "audit" to "Security log", "danger" to "Danger zone", "app" to "App")
    fun Modifier.anchor(id: String) = onGloballyPositioned { positions[id] = it.positionInParent().y.toInt() }

    BoxWithConstraints(Modifier.fillMaxSize().background(Wa.colors.panel)) {
        val side = if (maxWidth < 900.dp) 16.dp else minOf(maxWidth * 0.05f, 48.dp)
        Column(
            Modifier.fillMaxSize().statusBarsPadding().verticalScroll(scroll).padding(horizontal = side, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PageHeader(WaIcons.settings, "Settings", "Signed in as ${deps.username ?: ""}")
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((id, label) in toc) FilterChip(label, false) { scope.launch { positions[id]?.let { scroll.animateScrollTo(it) } } }
            }
            Column(Modifier.anchor("password")) { PasswordSection(deps) }
            Column(Modifier.anchor("2fa")) { TotpSection(deps) }
            Column(Modifier.anchor("recovery")) { RecoverySection(deps) }
            Column(Modifier.anchor("sessions")) { SessionsSection(deps) }
            Column(Modifier.anchor("logging")) { LoggingSection(deps) }
            Column(Modifier.anchor("whatsapp")) { WhatsAppSection(deps) }
            Column(Modifier.anchor("audit")) { AuditSection(deps) }
            Column(Modifier.anchor("danger")) { DangerSection(deps) }
            Column(Modifier.anchor("app")) { AppSection(deps) }
        }
    }
}

@Composable
private fun PasswordSection(d: SettingsDeps) {
    var cur by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    val op = rememberOp()
    SectionCard("Password") {
        Column(Modifier.widthIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            WaTextField(cur, { cur = it }, "Current password", password = true)
            WaTextField(next, { next = it }, "New password", password = true)
            WaTextField(confirm, { confirm = it }, "Confirm new password", password = true, imeAction = ImeAction.Done)
            if (next.isNotEmpty() && confirm.isNotEmpty() && next != confirm) ErrorNote("Passwords do not match.")
            ErrorNote(op.error)
            OkNote(op.ok)
            WaButton("Change password", {
                if (next == confirm) op.run("Password changed. Other sessions were logged out.", then = { cur = ""; next = ""; confirm = "" }) { d.api.changePassword(cur, next) }
            }, style = BtnStyle.Primary, busy = op.busy, enabled = cur.isNotEmpty() && next.length >= 12)
        }
    }
}

private fun qrBitmap(text: String, size: Int = 440): Bitmap {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 1))
    val pixels = IntArray(size * size) { i -> if (matrix.get(i % size, i / size)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt() }
    return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
}

@Composable
private fun TotpSection(d: SettingsDeps) {
    val context = LocalContext.current
    var setup by remember { mutableStateOf<TotpSetupResponse?>(null) }
    var code by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val op = rememberOp()
    SectionCard("Two-factor authentication (TOTP)") {
        MutedText("Require a 6-digit code from an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password…) at login.")
        OkNote(op.ok)
        val s = setup
        when {
            d.totpEnabled -> Column(Modifier.widthIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                OkNote("Two-factor authentication is enabled.", WaIcons.shield)
                WaTextField(password, { password = it }, "Password", password = true)
                WaTextField(code, { code = it.filter(Char::isDigit).take(6) }, "Current code", keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done)
                ErrorNote(op.error)
                WaButton("Disable 2FA", {
                    op.run("Two-factor authentication disabled.", then = { password = ""; code = "" }) {
                        d.api.totpDisable(password, code.trim())
                        d.refresh()
                    }
                }, style = BtnStyle.Danger, busy = op.busy)
            }
            s != null -> Column(Modifier.widthIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                val qr = remember(s.otpauthUrl) { qrBitmap(s.otpauthUrl).asImageBitmap() }
                Image(qr, "Scan this QR code with your authenticator app", Modifier.size(220.dp).clip(RoundedCornerShape(8.dp)).background(androidx.compose.ui.graphics.Color.White).padding(8.dp))
                WaButton("Open in authenticator app", {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(s.otpauthUrl))) }
                        .onFailure { op.error = "No authenticator app on this phone handles otpauth:// links. Enter the secret manually." }
                }, style = BtnStyle.Ghost, icon = WaIcons.openNew)
                MutedText("Or enter this secret manually:", style = WaType.small)
                androidx.compose.foundation.text.selection.SelectionContainer { Text(s.secret, style = WaType.mono, color = Wa.colors.text) }
                WaTextField(code, { code = it.filter(Char::isDigit).take(6) }, "Code from the app", keyboardType = KeyboardType.NumberPassword)
                WaTextField(password, { password = it }, "Your password", password = true, imeAction = ImeAction.Done)
                ErrorNote(op.error)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    WaButton("Verify & enable", {
                        op.run("Two-factor authentication enabled.", then = { setup = null; code = ""; password = "" }) {
                            d.api.totpEnable(code.trim(), password)
                            d.refresh()
                        }
                    }, style = BtnStyle.Primary, busy = op.busy)
                    WaButton("Cancel", { setup = null }, style = BtnStyle.Ghost)
                }
            }
            else -> {
                ErrorNote(op.error)
                WaButton("Enable 2FA", { op.run { setup = d.api.totpSetup() } }, busy = op.busy)
            }
        }
    }
}

@Composable
private fun TotpField(d: SettingsDeps, value: String, onChange: (String) -> Unit) {
    if (!d.totpEnabled) return
    WaTextField(value, { onChange(it.filter(Char::isDigit).take(6)) }, "Authentication code", keyboardType = KeyboardType.NumberPassword)
}

@Composable
private fun RecoverySection(d: SettingsDeps) {
    var password by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf("") }
    var key by remember { mutableStateOf<String?>(null) }
    val op = rememberOp()
    SectionCard("Recovery key") {
        MutedText("Creates a new recovery key and invalidates the old one. Store the new key safely — it is shown only once.")
        val k = key
        if (k != null) {
            RecoveryKeyBox(k)
            WaButton("I have saved it", { key = null })
        } else {
            Column(Modifier.widthIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                WaTextField(password, { password = it }, "Password", password = true)
                TotpField(d, totp) { totp = it }
                ErrorNote(op.error)
                WaButton("Generate new recovery key", {
                    op.run(then = { password = ""; totp = "" }) { key = d.api.rotateRecoveryKey(password, totp.trim()).recoveryKey }
                }, busy = op.busy, enabled = password.isNotEmpty())
            }
        }
    }
}

@Composable
private fun SessionsSection(d: SettingsDeps) {
    val fmt = LocalFormatter.current
    val c = Wa.colors
    var list by remember { mutableStateOf<List<SessionInfo>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val op = rememberOp()
    LaunchedEffect(reload) { list = runCatching { d.api.sessions() }.getOrDefault(emptyList()) }
    SectionCard("Sessions") {
        ErrorNote(op.error)
        val l = list
        if (l == null) {
            Spinner()
        } else {
            Column {
                l.forEachIndexed { i, s ->
                    if (i > 0) Divider()
                    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (s.current) Badge("this device", BadgeTone.Green)
                                Text(s.userAgent ?: "Unknown", style = WaType.small, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                            MutedText("${s.ip ?: "—"} · last active ${fmt.dateTime(s.lastSeenAt)} · expires ${fmt.dateTime(s.expiresAt)}", style = WaType.tiny)
                        }
                        WaButton("Revoke", {
                            op.run {
                                d.api.revokeSession(s.id)
                                if (s.current) d.refresh() else reload++
                            }
                        }, tiny = true, style = BtnStyle.Ghost)
                    }
                }
            }
        }
        ConfirmButton("Log out everywhere", "Log out all sessions", { op.run { d.api.logoutAll(); d.refresh() } })
    }
}

@Composable
private fun NumberSetting(label: String, value: Int, range: IntRange, onSave: (Int) -> Unit) {
    var text by remember(value) { mutableStateOf(value.toString()) }
    fun commit() {
        val n = text.toIntOrNull()?.coerceIn(range)
        if (n != null && n != value) onSave(n) else text = value.toString()
    }
    Column(Modifier.onFocusChanged { if (!it.hasFocus) commit() }) {
        WaTextField(text, { text = it.filter(Char::isDigit).take(5) }, label, keyboardType = KeyboardType.Number, imeAction = ImeAction.Done, onIme = ::commit)
    }
}

@Composable
private fun LoggingSection(d: SettingsDeps) {
    var s by remember { mutableStateOf<Settings?>(null) }
    val op = rememberOp()
    LaunchedEffect(Unit) { s = runCatching { d.api.settings() }.getOrNull() }
    val cur = s
    SectionCard("Logging") {
        if (cur == null) {
            Spinner()
            return@SectionCard
        }
        fun save(p: SettingsPatch) = op.run("Saved.") { s = d.api.updateSettings(p) }
        CheckRow(cur.logStatus, { save(SettingsPatch(logStatus = it)) }, "Log status updates (stories) of your contacts")
        CheckRow(cur.downloadHistoryMedia, { save(SettingsPatch(downloadHistoryMedia = it)) }, "Download media of imported history (not only new messages)")
        Column(Modifier.widthIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            NumberSetting("Maximum media size to download (MB)", cur.mediaMaxMb, 1..2000) { save(SettingsPatch(mediaMaxMb = it)) }
            NumberSetting("Messages to import per chat on first link", cur.historyPerChat, 0..5000) { save(SettingsPatch(historyPerChat = it)) }
        }
        MutedText("View-once photos and videos are never logged.", style = WaType.small)
        ErrorNote(op.error)
        OkNote(op.ok)
    }
}

@Composable
private fun WhatsAppSection(d: SettingsDeps) {
    val op = rememberOp()
    val wa = d.wa
    SectionCard("WhatsApp connection") {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            WaStatePill(wa)
            if (wa?.detail != null) MutedText(wa.detail!!, style = WaType.small)
            wa?.me?.let { Text("Linked: ${it.name ?: ""} ${it.phone ?: ""}".trimEnd(), style = WaType.small, color = Wa.colors.text) }
            MutedText("Media queue: ${wa?.mediaQueue ?: 0}", style = WaType.small)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            WaButton("Restart WhatsApp Web", { op.run("Restarting…") { d.api.waRestart() } }, icon = WaIcons.refresh, busy = op.busy)
            ConfirmButton("Unlink this device from WhatsApp", "Unlink device", { op.run("Device unlinked.") { d.api.waLogout() } })
        }
        ErrorNote(op.error)
        OkNote(op.ok)
    }
}

@Composable
private fun AuditSection(d: SettingsDeps) {
    val fmt = LocalFormatter.current
    val c = Wa.colors
    var rows by remember { mutableStateOf<List<AuditEntry>?>(null) }
    LaunchedEffect(Unit) { rows = runCatching { d.api.audit() }.getOrDefault(emptyList()) }
    SectionCard("Security log") {
        val r = rows
        if (r == null) {
            Spinner()
        } else {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                r.forEachIndexed { i, e ->
                    if (i > 0) Divider()
                    val warn = Regex("fail|wipe|revoked|logout").containsMatchIn(e.event)
                    Column(Modifier.padding(vertical = 6.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(e.event, style = WaType.small.merge(WaType.mono), color = if (warn) c.danger else c.text)
                            MutedText(e.ip ?: "—", style = WaType.tiny.merge(WaType.mono))
                        }
                        MutedText(fmt.dateTime(e.ts) + (e.detail?.let { " · $it" } ?: ""), style = WaType.tiny)
                    }
                }
            }
        }
    }
}

@Composable
private fun DangerSection(d: SettingsDeps) {
    var password by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf("") }
    var armed by remember { mutableStateOf(false) }
    val op = rememberOp()
    SectionCard("Danger zone", danger = true) {
        MutedText("Permanently deletes every logged message, edit, reaction and media file. Your account and WhatsApp link stay; logging continues for new messages.")
        Column(Modifier.widthIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            WaTextField(password, { password = it }, "Password", password = true)
            TotpField(d, totp) { totp = it }
            ErrorNote(op.error)
            OkNote(op.ok)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                WaButton(if (armed) "Tap again to wipe everything" else "Wipe all logged data", {
                    if (!armed) {
                        armed = true
                    } else {
                        op.run("All logged messages and media were deleted.", then = { password = ""; totp = ""; armed = false }) { d.api.wipe(password, totp.trim()) }
                    }
                }, style = BtnStyle.Danger, busy = op.busy, enabled = password.isNotEmpty())
                if (armed) WaButton("Cancel", { armed = false }, style = BtnStyle.Ghost)
            }
        }
    }
}

/** Native-only: which server this app talks to, certificates trusted for it, screen protection. */
@Composable
private fun AppSection(d: SettingsDeps) {
    val c = Wa.colors
    val graph = d.graph
    val context = LocalContext.current
    var certs by remember { mutableStateOf(graph?.trust?.trusted() ?: emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    val secure = graph?.prefs?.secureScreen?.collectAsState()?.value ?: true
    val importCa = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null || graph == null) return@rememberLauncherForActivityResult
        val cert = runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()?.let { ServerTrust.parseCertificate(it) }
        if (cert == null) error = "That file is not a certificate (PEM or DER)." else { graph.trust.add(cert); certs = graph.trust.trusted(); error = null }
    }
    SectionCard("App") {
        Text("Server: ${d.api.baseUrl.toString().removeSuffix("/")}", style = WaType.base, color = c.text)
        if (!d.api.baseUrl.isHttps) MutedText("Unencrypted HTTP connection — only use it inside your own network.", style = WaType.small)
        WaButton("Change server", d.onChangeServer, style = BtnStyle.Ghost, icon = WaIcons.server)
        SwitchRow(secure, { graph?.prefs?.setSecureScreen(it) }, "Block screenshots and hide the app in the recent-apps preview")
        Text("Trusted certificates", style = WaType.base.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium), color = c.text)
        if (certs.isEmpty()) MutedText("None — only certificates Android trusts are accepted.", style = WaType.small)
        for (cert in certs) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(ServerTrust.commonName(cert), style = WaType.small, color = c.text)
                    MutedText(ServerTrust.sha256(cert).take(47) + "…", style = WaType.tiny.merge(WaType.mono))
                }
                WaButton("Remove", { graph?.trust?.remove(cert); certs = graph?.trust?.trusted() ?: emptyList() }, tiny = true, style = BtnStyle.Ghost)
            }
        }
        WaButton("Import a CA certificate…", { importCa.launch(arrayOf("*/*")) }, style = BtnStyle.Ghost, icon = WaIcons.shield)
        ErrorNote(error)
        MutedText("wa_logger for Android ${BuildConfig.VERSION_NAME}", style = WaType.small)
    }
}
