package io.github.revocx35.walogger.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.WaState
import io.github.revocx35.walogger.core.WaStatus
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.ui.components.BtnStyle
import io.github.revocx35.walogger.ui.components.ConfirmButton
import io.github.revocx35.walogger.ui.components.ErrorNote
import io.github.revocx35.walogger.ui.components.MutedText
import io.github.revocx35.walogger.ui.components.PageHeader
import io.github.revocx35.walogger.ui.components.SwitchRow
import io.github.revocx35.walogger.ui.components.WaButton
import io.github.revocx35.walogger.ui.components.WaIcon
import io.github.revocx35.walogger.ui.components.WaStatePill
import io.github.revocx35.walogger.ui.components.WarnBanner
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import io.github.revocx35.walogger.ui.vnc.VncView
import kotlinx.coroutines.launch

/** The real WhatsApp Web session in the background browser (like the web's WA Web page). */
@Composable
fun WaWebScreen(api: ApiClient, wa: WaStatus?) {
    val c = Wa.colors
    val scope = rememberCoroutineScope()
    val needsLink = wa?.state == WaState.Qr || wa?.state == WaState.Disconnected
    var viewOnly by rememberSaveable { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(needsLink) { if (needsLink) viewOnly = false }
    fun act(block: suspend () -> Unit) {
        error = null
        scope.launch {
            try {
                block()
            } catch (e: Exception) {
                error = e.userMessage()
            }
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize().background(c.panel)) {
        val side = if (maxWidth < 900.dp) 16.dp else minOf(maxWidth * 0.05f, 48.dp)
        Column(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = side, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            PageHeader(
                WaIcons.monitor,
                "WA Web",
                "The real WhatsApp Web session running in the background browser" +
                    (wa?.me?.let { " — linked to ${it.name ?: ""} ${it.phone ?: ""}".trimEnd() } ?: "") + ".",
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                WaStatePill(wa)
                SwitchRow(viewOnly, { viewOnly = it }, "View only")
                WaButton("Restart", { act { api.waRestart() } }, style = BtnStyle.Ghost, icon = WaIcons.refresh)
                ConfirmButton("Unlink", "Unlink this device", { act { api.waLogout() } }, style = BtnStyle.Ghost, enabled = wa?.state == WaState.Ready || wa?.state == WaState.Syncing)
            }
            if (needsLink) {
                WarnBanner(Modifier.clip(RoundedCornerShape(8.dp))) {
                    Text("WhatsApp is not linked. Scan the QR code below with your phone (Linked devices → Link a device).", style = WaType.small, color = c.text)
                }
            }
            ErrorNote(error)
            VncView(api, viewOnly, Modifier.weight(1f).fillMaxWidth().heightIn(min = 300.dp))
            MutedText(
                "Tip: keep “View only” on to avoid accidental taps. The browser only allows WhatsApp domains; downloads and file uploads are disabled.",
                style = WaType.small,
            )
        }
    }
}

private fun steps(): List<androidx.compose.ui.text.AnnotatedString> {
    fun b(vararg parts: Pair<String, Boolean>) = buildAnnotatedString {
        for ((t, bold) in parts) if (bold) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(t) } else append(t)
    }
    return listOf(
        b("Open " to false, "WhatsApp" to true, " on your phone." to false),
        b("Tap " to false, "Menu ⋮" to true, " or " to false, "Settings" to true, " → " to false, "Linked devices" to true, " → " to false, "Link a device" to true, "." to false),
        b("Point your phone at the QR code in the browser view." to false),
        b("On this same phone? Tap " to false, "Log in with phone number instead" to true, " in the browser view, type your number with the keyboard button, then enter the code in WhatsApp → Linked devices → " to false, "Link with phone number" to true, "." to false),
        b("Wait until the status says " to false, "Connected" to true, " or " to false, "Importing history" to true, ", then press " to false, "Complete" to true, "." to false),
    )
}

/** Onboarding step 3 (like the web's SetupLink page): live browser + status + Complete. */
@Composable
fun SetupLinkScreen(api: ApiClient, wa: WaStatus?, onComplete: suspend () -> Unit, onLogout: () -> Unit) {
    val c = Wa.colors
    val scope = rememberCoroutineScope()
    val state = wa?.state ?: WaState.Starting
    val linked = state == WaState.Ready || state == WaState.Syncing
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showSteps by rememberSaveable { mutableStateOf(true) }

    BoxWithConstraints(Modifier.fillMaxSize().background(c.bg)) {
        val wide = maxWidth >= 900.dp
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(if (wide) 20.dp else 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("Link WhatsApp", style = WaType.authTitle, color = c.text)
                    MutedText("This is the real WhatsApp Web running in a private browser on your server. Log in to it exactly like on a computer.", style = WaType.small)
                }
                WaStatePill(wa)
            }
            val stepList = @Composable {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    steps().forEachIndexed { i, s ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("${i + 1}.", style = WaType.base, color = c.text)
                            Text(s, style = WaType.base, color = c.text)
                        }
                    }
                    MutedText("View-once photos/videos are never logged. Everything else you send or receive from now on is saved, encrypted, even if it is later deleted.", style = WaType.small)
                }
            }
            if (wide) {
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    Column(Modifier.width(320.dp).fillMaxHeight().verticalScroll(rememberScrollState())) { stepList() }
                    VncView(api, viewOnly = false, modifier = Modifier.weight(1f).fillMaxHeight())
                }
            } else {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(c.panel).clickable { showSteps = !showSteps }.padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("How to link", style = WaType.base.copy(fontWeight = FontWeight.Medium), color = c.text, modifier = Modifier.weight(1f))
                        WaIcon(WaIcons.chevronDown, 20.dp, c.text2)
                    }
                    if (showSteps) Column(Modifier.padding(top = 8.dp).heightIn(max = 260.dp).verticalScroll(rememberScrollState())) { stepList() }
                }
                VncView(api, viewOnly = false, modifier = Modifier.weight(1f).fillMaxWidth().heightIn(min = 280.dp))
            }
            val detail = listOfNotNull(wa?.detail, wa?.sync?.let { "${it.chatsDone}/${it.chatsTotal} chats" }).joinToString(" · ")
            if (detail.isNotEmpty()) MutedText(detail, style = WaType.small)
            ErrorNote(error)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                WaButton("Restart", {
                    error = null
                    scope.launch { runCatching { api.waRestart() }.onFailure { error = it.userMessage() } }
                }, style = BtnStyle.Ghost, icon = WaIcons.refresh)
                WaButton(if (linked) "Complete" else "Waiting for WhatsApp…", {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            onComplete()
                        } catch (e: Exception) {
                            error = e.userMessage()
                        } finally {
                            busy = false
                        }
                    }
                }, style = BtnStyle.Primary, enabled = linked, busy = busy)
                WaButton("Log out", onLogout, style = BtnStyle.Ghost, icon = WaIcons.logout)
            }
        }
    }
}
