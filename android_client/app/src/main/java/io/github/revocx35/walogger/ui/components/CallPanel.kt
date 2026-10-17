package io.github.revocx35.walogger.ui.components

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.revocx35.walogger.core.ChatKind
import io.github.revocx35.walogger.core.CallState
import io.github.revocx35.walogger.ui.CallActions
import io.github.revocx35.walogger.ui.CallAudioState
import io.github.revocx35.walogger.ui.CallUi
import io.github.revocx35.walogger.ui.callStatusText
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.delay

/**
 * Runs [action] once the microphone may be used (asks for RECORD_AUDIO, and for notifications on Android 13+ so the
 * ongoing-call notification can show). Without the microphone the call can't carry audio: a note says so.
 */
@Composable
fun rememberCallPermission(calls: CallActions): (action: () -> Unit) -> Unit {
    val context = LocalContext.current
    var pending by remember { androidx.compose.runtime.mutableStateOf<(() -> Unit)?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val action = pending
        pending = null
        if (result[Manifest.permission.RECORD_AUDIO] == true) action?.invoke()
        else calls.reportNote("Calls need the microphone. Allow it for wa_logger in the system settings.")
    }
    return { action ->
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            action()
        } else {
            pending = action
            val perms = buildList {
                add(Manifest.permission.RECORD_AUDIO)
                if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
            }
            launcher.launch(perms.toTypedArray())
        }
    }
}

/** A round call button (`.call-btn`). */
@Composable
private fun CallBtn(icon: ImageVector, label: String, bg: Color, fg: Color, onClick: () -> Unit, enabled: Boolean = true) {
    Box(
        Modifier.size(48.dp).clip(CircleShape).background(bg).alpha(if (enabled) 1f else 0.6f)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = label, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { WaIcon(icon, 24.dp, fg) }
}

/** The floating call panel (the web's `.call-panel`), shown above everything while there is a call or a note. */
@Composable
fun CallPanel(ui: CallUi, calls: CallActions, modifier: Modifier = Modifier) {
    val c = Wa.colors
    val call = ui.call
    if (call == null && ui.note == null) return
    val withMic = rememberCallPermission(calls)
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(call?.state) {
        while (call?.state == CallState.Active) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    val ringing = call?.state == CallState.Incoming
    val shape = RoundedCornerShape(12.dp)
    Box(modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = 440.dp).fillMaxWidth().shadow(8.dp, shape).clip(shape).background(c.panel)
                .border(1.dp, if (ringing) c.accent else c.border, shape).padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (call == null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    WaIcon(WaIcons.warning, 20.dp, c.warn)
                    Text(ui.note ?: "", style = WaType.small, color = c.text, modifier = Modifier.weight(1f))
                    IconBtn(WaIcons.close, "Dismiss", calls::dismissNote, size = 32.dp, iconSize = 18.dp)
                }
                return@Column
            }
            val name = call.name ?: call.chatId?.substringBefore('@') ?: "Unknown"
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Avatar(call.chatId ?: call.id, name, call.avatarUrl, if (call.group) ChatKind.Group else ChatKind.User, 44.dp)
                Column(Modifier.weight(1f)) {
                    Text(name, style = WaType.chatName.copy(fontWeight = FontWeight.SemiBold), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    MutedText(callStatusText(call, now), style = WaType.small, maxLines = 1)
                }
                when {
                    ringing -> {
                        CallBtn(WaIcons.callEnd, "Decline", c.danger, Color.White, calls::decline, enabled = !ui.busy)
                        CallBtn(WaIcons.phone, "Answer", c.accent, Color.White, { withMic(calls::accept) }, enabled = !ui.busy)
                    }
                    call.state != CallState.Ended -> {
                        if (ui.audio == CallAudioState.Live) {
                            CallBtn(WaIcons.speaker, if (ui.speaker) "Earpiece" else "Speaker", if (ui.speaker) c.text else c.active, if (ui.speaker) c.panel else c.text, calls::toggleSpeaker)
                            CallBtn(if (ui.muted) WaIcons.micOff else WaIcons.mic, if (ui.muted) "Unmute" else "Mute", if (ui.muted) c.text else c.active, if (ui.muted) c.panel else c.text, calls::toggleMute)
                        }
                        CallBtn(WaIcons.callEnd, "Hang up", c.danger, Color.White, calls::hangup)
                    }
                }
            }
            val needsAudio = !ringing && ui.audio == CallAudioState.Off && (call.state == CallState.Active || call.state == CallState.Connecting)
            if (needsAudio) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MutedText(if (call.audio) "The audio is on another device or window." else "This call has no audio here.", style = WaType.small, modifier = Modifier.weight(1f))
                    WaButton(if (call.audio) "Move audio here" else "Join audio", { withMic(calls::joinAudio) }, tiny = true, style = BtnStyle.Primary, icon = WaIcons.mic)
                }
            }
            ui.note?.let { Text(it, style = WaType.small, color = c.danger) }
        }
    }
}
