package io.github.revocx35.walogger.ui.components

import android.Manifest
import io.github.revocx35.walogger.ui.RemoteVideo
import io.github.revocx35.walogger.ui.CameraState
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.fillMaxSize
import android.view.TextureView
import android.view.Surface
import android.graphics.SurfaceTexture
import android.graphics.Matrix
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
 * Runs an action once the microphone (and with `camera`, the camera) may be used; asks for them, and for
 * notifications on Android 13+ so the ongoing-call notification can show. Without the microphone the call can't carry
 * audio, without the camera it goes on without video: a note says so.
 */
@Composable
fun rememberCallPermission(calls: CallActions): (camera: Boolean, action: () -> Unit) -> Unit {
    val context = LocalContext.current
    var pending by remember { androidx.compose.runtime.mutableStateOf<Pair<Boolean, () -> Unit>?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val p = pending
        pending = null
        val mic = result[Manifest.permission.RECORD_AUDIO] ?: (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        val cam = result[Manifest.permission.CAMERA] ?: (context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
        when {
            p == null -> Unit
            !mic -> calls.reportNote("Calls need the microphone. Allow it for wa_logger in the system settings.")
            p.first && !cam -> calls.reportNote("Video needs the camera. Allow it for wa_logger in the system settings.")
            else -> p.second()
        }
    }
    return { camera, action ->
        val perms = buildList {
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) add(Manifest.permission.RECORD_AUDIO)
            if (camera && context.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) add(Manifest.permission.CAMERA)
        }
        if (perms.isEmpty()) {
            action()
        } else {
            pending = camera to action
            val ask = perms + if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()
            launcher.launch(ask.toTypedArray())
        }
    }
}

/** The call UI: the video screen while the call has video (unless minimized), otherwise the floating panel. */
@Composable
fun CallScreen(ui: CallUi, calls: CallActions) {
    val call = ui.call
    val stage = call != null && call.live && call.state != CallState.Incoming && ui.hasVideo && !ui.minimized
    if (stage) VideoStage(ui, calls) else CallPanel(ui, calls)
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
                    MutedText(callStatusText(call, now, showRec = false), style = WaType.small, maxLines = 1)
                }
                when {
                    ringing -> {
                        CallBtn(WaIcons.callEnd, "Decline", c.danger, Color.White, calls::decline, enabled = !ui.busy)
                        if (call.video) CallBtn(WaIcons.video, "Answer with video", c.accent, Color.White, { withMic(true) { calls.accept(true) } }, enabled = !ui.busy)
                        CallBtn(WaIcons.phone, if (call.video) "Answer without video" else "Answer", c.accent, Color.White, { withMic(false) { calls.accept(false) } }, enabled = !ui.busy)
                    }
                    call.state != CallState.Ended -> {
                        if (ui.hasVideo) CallBtn(WaIcons.zoomIn, "Show video", c.active, c.text, { calls.setMinimized(false) })
                        if (call.state == CallState.Active) {
                            CallBtn(WaIcons.record, if (call.recording) "Stop recording" else "Record call", if (call.recording) c.danger else c.active, if (call.recording) Color.White else c.danger, calls::toggleRecording)
                        }
                        if (ui.audio == CallAudioState.Live) {
                            CallBtn(WaIcons.speaker, if (ui.speaker) "Earpiece" else "Speaker", if (ui.speaker) c.text else c.active, if (ui.speaker) c.panel else c.text, calls::toggleSpeaker)
                            CallBtn(if (ui.muted) WaIcons.micOff else WaIcons.mic, if (ui.muted) "Unmute" else "Mute", if (ui.muted) c.text else c.active, if (ui.muted) c.panel else c.text, calls::toggleMute)
                        }
                        CallBtn(WaIcons.callEnd, "Hang up", c.danger, Color.White, calls::hangup)
                    }
                }
            }
            if (call.recording && call.live) {
                Text("● REC · this call is being recorded", style = WaType.small.copy(fontWeight = FontWeight.SemiBold), color = c.danger)
            }
            val needsAudio = !ringing && ui.audio == CallAudioState.Off && (call.state == CallState.Active || call.state == CallState.Connecting)
            if (needsAudio) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MutedText(if (call.audio) "The audio is on another device or window." else "This call has no audio here.", style = WaType.small, modifier = Modifier.weight(1f))
                    WaButton(if (call.audio) "Move audio here" else "Join audio", { withMic(false, calls::joinAudio) }, tiny = true, style = BtnStyle.Primary, icon = WaIcons.mic)
                }
            }
            ui.note?.let { Text(it, style = WaType.small, color = c.danger) }
        }
    }
}

/** Shows the other side's video: a TextureView the decoder renders into, turned upright and fitted. */
@Composable
private fun RemoteVideoView(calls: CallActions, remote: RemoteVideo?, modifier: Modifier) {
    androidx.compose.ui.viewinterop.AndroidView(
        modifier = modifier,
        factory = { ctx ->
            TextureView(ctx).apply {
                // The transform needs the view's size: apply it again whenever the layout changes.
                addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ -> fit(v as TextureView, v.tag as? RemoteVideo) }
                surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                    var surface: Surface? = null
                    override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
                        surface = Surface(st).also { calls.setRemoteSurface(it) }
                    }
                    override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) = fit(this@apply, (tag as? RemoteVideo))
                    override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                        calls.setRemoteSurface(null)
                        surface?.release()
                        surface = null
                        return true
                    }
                    override fun onSurfaceTextureUpdated(st: SurfaceTexture) = Unit
                }
            }
        },
        update = { v ->
            v.tag = remote
            fit(v, remote)
        },
    )
}

/** Maps the decoded frame (stretched over the view by default) to the view: rotated upright, aspect kept, centred. */
private fun fit(v: TextureView, r: RemoteVideo?) {
    val vw = v.width.toFloat()
    val vh = v.height.toFloat()
    if (r == null || vw <= 0f || vh <= 0f || r.width <= 0 || r.height <= 0) return
    val dw = if (r.rotation % 2 == 1) r.height.toFloat() else r.width.toFloat()
    val dh = if (r.rotation % 2 == 1) r.width.toFloat() else r.height.toFloat()
    val s = minOf(vw / dw, vh / dh)
    val m = Matrix()
    m.postScale(r.width / vw, r.height / vh, vw / 2, vh / 2)
    m.postRotate(90f * r.rotation, vw / 2, vh / 2)
    m.postScale(s, s, vw / 2, vh / 2)
    v.setTransform(m)
}

/** The camera preview in a corner (mirrored for the front camera, like a mirror). */
@Composable
private fun PreviewView(calls: CallActions, mirrored: Boolean, modifier: Modifier) {
    androidx.compose.ui.viewinterop.AndroidView(
        modifier = modifier,
        factory = { ctx ->
            TextureView(ctx).apply {
                surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                    override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) = calls.setPreviewTexture(st)
                    override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) = Unit
                    override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                        calls.setPreviewTexture(null)
                        return true
                    }
                    override fun onSurfaceTextureUpdated(st: SurfaceTexture) = Unit
                }
            }
        },
        update = { v -> v.scaleX = if (mirrored) -1f else 1f },
    )
}

/** The video call screen (the web's `.call-stage`): the other side full size, our camera in a corner, the controls. */
@Composable
fun VideoStage(ui: CallUi, calls: CallActions) {
    val call = ui.call ?: return
    val name = call.name ?: call.chatId?.substringBefore('@') ?: "Unknown"
    val withMic = rememberCallPermission(calls)
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(call.state) {
        while (call.state == CallState.Active) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    val dark = Color(0xFF0B141A)
    val light = Color(0xFFE9EDEF)
    val chip = Color(0x29FFFFFF)
    val showRemote = call.peerVideo && ui.remote != null
    Box(Modifier.fillMaxSize().background(dark).semantics { contentDescription = "Video call with $name" }) {
        // Kept while the stage is shown so the decoder keeps its surface; covered by the placeholder when there is no picture.
        RemoteVideoView(calls, ui.remote, Modifier.fillMaxSize())
        if (!showRemote) {
            Column(Modifier.fillMaxSize().background(dark), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Avatar(call.chatId ?: call.id, name, call.avatarUrl, ChatKind.User, 96.dp)
                Text(
                    if (call.peerVideo) "Waiting for video…" else if (call.state == CallState.Active) "Camera off" else callStatusText(call, now),
                    style = WaType.base,
                    color = Color(0xFFAEBAC1),
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }
        Row(Modifier.fillMaxWidth().background(Color(0x66000000)).statusBarsPadding().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(name, style = WaType.chatName.copy(fontWeight = FontWeight.SemiBold), color = light, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(callStatusText(call, now), style = WaType.small, color = light)
            }
            CallBtn(WaIcons.chevronDown, "Minimize", chip, Color.White, { calls.setMinimized(true) })
        }
        if (ui.camera != CameraState.Off) {
            PreviewView(
                calls,
                ui.frontCamera,
                Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = 120.dp).navigationBarsPadding().size(width = 108.dp, height = 144.dp)
                    .clip(RoundedCornerShape(10.dp)).background(Color.Black),
            )
        }
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color(0x80000000)).navigationBarsPadding().padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            ui.note?.let { Text(it, style = WaType.small, color = Color(0xFFF15C6D)) }
            val ours = ui.audio == CallAudioState.Live
            if (!ours && (call.state == CallState.Active || call.state == CallState.Connecting)) {
                WaButton(if (call.audio) "Move the call here" else "Join the call here", { withMic(false, calls::joinAudio) }, tiny = true, style = BtnStyle.Primary, icon = WaIcons.mic)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                val camOff = ui.camera == CameraState.Off
                CallBtn(
                    if (camOff) WaIcons.videoOff else WaIcons.video,
                    if (camOff) "Turn camera on" else "Turn camera off",
                    if (camOff) Color.White else chip,
                    if (camOff) dark else Color.White,
                    { if (camOff) withMic(true, calls::toggleCamera) else calls.toggleCamera() },
                    enabled = ours && ui.camera != CameraState.Starting,
                )
                if (call.state == CallState.Active) {
                    CallBtn(WaIcons.record, if (call.recording) "Stop recording" else "Record call", if (call.recording) Color(0xFFEA0038) else chip, Color.White, calls::toggleRecording)
                }
                if (ours) {
                    CallBtn(WaIcons.speaker, if (ui.speaker) "Earpiece" else "Speaker", if (ui.speaker) Color.White else chip, if (ui.speaker) dark else Color.White, calls::toggleSpeaker)
                    CallBtn(if (ui.muted) WaIcons.micOff else WaIcons.mic, if (ui.muted) "Unmute" else "Mute", if (ui.muted) Color.White else chip, if (ui.muted) dark else Color.White, calls::toggleMute)
                }
                CallBtn(WaIcons.callEnd, "Hang up", Color(0xFFEA0038), Color.White, calls::hangup)
            }
        }
    }
}
