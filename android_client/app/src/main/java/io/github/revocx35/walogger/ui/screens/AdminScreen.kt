package io.github.revocx35.walogger.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.revocx35.walogger.core.AdminAuditEntry
import io.github.revocx35.walogger.core.AdminOverview
import io.github.revocx35.walogger.core.AdminUser
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.ResetMode
import io.github.revocx35.walogger.core.ResetOutcome
import io.github.revocx35.walogger.core.UserRole
import io.github.revocx35.walogger.core.UserStatus
import io.github.revocx35.walogger.core.WaStatus
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.ui.LocalFormatter
import io.github.revocx35.walogger.ui.components.Badge
import io.github.revocx35.walogger.ui.components.BadgeTone
import io.github.revocx35.walogger.ui.components.BtnStyle
import io.github.revocx35.walogger.ui.components.Divider
import io.github.revocx35.walogger.ui.components.ErrorNote
import io.github.revocx35.walogger.ui.components.FilterChip
import io.github.revocx35.walogger.ui.components.MutedText
import io.github.revocx35.walogger.ui.components.PageHeader
import io.github.revocx35.walogger.ui.components.SectionCard
import io.github.revocx35.walogger.ui.components.Spinner
import io.github.revocx35.walogger.ui.components.WaButton
import io.github.revocx35.walogger.ui.components.WaDialog
import io.github.revocx35.walogger.ui.components.WaStatePill
import io.github.revocx35.walogger.ui.components.WaTextField
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class AdminDeps(
    val api: ApiClient,
    val username: String?,
    val totpEnabled: Boolean,
)

/** Where the person signs in: the port's own address when the admin gave one, else this host on that port. */
internal fun signInUrl(api: ApiClient, o: AdminOverview, port: Int?): String {
    if (port == null) return o.defaultOrigin ?: api.origin
    o.ports.firstOrNull { it.port == port }?.origin?.let { return it }
    val host = api.baseUrl.host.let { if (it.contains(':')) "[$it]" else it }
    return "${api.baseUrl.scheme}://$host:$port"
}

private val USER_NAME = Regex("[A-Za-z0-9._\\-]{3,32}")

private fun statusOf(u: AdminUser): Pair<String, BadgeTone> = when {
    u.disabled -> "Disabled" to BadgeTone.Red
    u.status == UserStatus.Active -> "Active" to BadgeTone.Green
    u.status == UserStatus.Pending -> "Waiting for first sign-in" to BadgeTone.Gray
    u.status == UserStatus.Reset -> "Password reset" to BadgeTone.Gray
    else -> "Not reachable" to BadgeTone.Red
}

/** The admin's Users page, like the web's `/admin`: users, ports and the admin log. */
@Composable
fun AdminScreen(deps: AdminDeps) {
    var overview by remember { mutableStateOf<AdminOverview?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    val reload: () -> Unit = { tick++ }

    // Loads now, after every change (tick) and every 15 s while the page is open.
    LaunchedEffect(tick) {
        while (true) {
            try {
                overview = deps.api.adminOverview()
                error = null
            } catch (e: Exception) {
                error = e.userMessage()
            }
            delay(15_000)
        }
    }

    var log by remember { mutableStateOf<List<AdminAuditEntry>?>(null) }
    var logError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(tick) {
        try {
            log = deps.api.adminAudit()
            logError = null
        } catch (e: Exception) {
            logError = e.userMessage()
        }
    }
    AdminPage(deps, overview, error, reload, log, logError)
}

/** The page itself (stateless apart from its dialogs), so screenshots can render it with sample data. */
@Composable
fun AdminPage(deps: AdminDeps, overview: AdminOverview?, error: String?, reload: () -> Unit, log: List<AdminAuditEntry>?, logError: String?) {
    BoxWithConstraints(Modifier.fillMaxSize().background(Wa.colors.panel)) {
        val side = if (maxWidth < 900.dp) 16.dp else minOf(maxWidth * 0.05f, 48.dp)
        Column(
            Modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = side, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PageHeader(WaIcons.group, "Users", "Signed in as ${deps.username ?: ""} (admin)")
            ErrorNote(error)
            if (overview == null) {
                if (error == null) Spinner()
            } else {
                UsersSection(deps, overview, reload)
                PortsSection(deps, overview, reload)
                LogSection(log, logError)
            }
        }
    }
}

@Composable
private fun UsersSection(d: AdminDeps, o: AdminOverview, reload: () -> Unit) {
    var adding by remember { mutableStateOf(false) }
    var resetting by remember { mutableStateOf<AdminUser?>(null) }
    var deleting by remember { mutableStateOf<AdminUser?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busyId by remember { mutableStateOf<Int?>(null) }
    val scope = rememberCoroutineScope()

    fun patch(u: AdminUser, block: suspend () -> Unit) {
        busyId = u.id
        error = null
        scope.launch {
            try {
                block()
                reload()
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                busyId = null
            }
        }
    }

    SectionCard("Users") {
        MutedText("Everyone has a WhatsApp of their own, separate encrypted data, separate keys and a separate browser. You see names, status and ports — never messages.", style = WaType.small)
        Column {
            o.users.forEachIndexed { i, u ->
                if (i > 0) Divider()
                UserRow(d, o, u, busy = busyId == u.id,
                    onPort = { port -> patch(u) { d.api.adminSetUserPort(u.id, port) } },
                    onToggle = { patch(u) { d.api.adminSetUserDisabled(u.id, !u.disabled) } },
                    onReset = { resetting = u },
                    onDelete = { deleting = u },
                )
            }
        }
        ErrorNote(error)
        MutedText("Disabling a user ends their sessions and blocks sign-in; their WhatsApp keeps being logged. ${o.users.size} of ${o.maxUsers} users.", style = WaType.small)
        WaButton("Add a user", { adding = true }, style = BtnStyle.Primary, icon = WaIcons.plus, enabled = o.users.size < o.maxUsers)
    }
    if (adding) CreateDialog(d, o, onClose = { adding = false; reload() })
    resetting?.let { ResetDialog(d, o, it, onClose = { resetting = null }, onDone = reload) }
    deleting?.let { DeleteDialog(d, it, onClose = { deleting = null }, onDone = reload) }
}

@Composable
private fun UserRow(d: AdminDeps, o: AdminOverview, u: AdminUser, busy: Boolean, onPort: (Int?) -> Unit, onToggle: () -> Unit, onReset: () -> Unit, onDelete: () -> Unit) {
    val c = Wa.colors
    val fmt = LocalFormatter.current
    val (label, tone) = statusOf(u)
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            Text(u.username, style = WaType.base.copy(fontWeight = FontWeight.SemiBold), color = c.text)
            if (u.role == UserRole.Admin) Badge("admin", BadgeTone.Gray)
            if (u.id == o.currentUserId) MutedText("(you)", style = WaType.small)
            Badge(label, tone)
            u.wa?.let { WaStatePill(WaStatus(state = it)) }
        }
        MutedText(
            (if (u.role == UserRole.Admin) "Port :${o.defaultPort} (default)" else "Signs in at ${signInUrl(d.api, o, u.port)}") +
                " · last sign-in ${u.lastLoginAt?.let { fmt.dateTime(it) } ?: "—"}",
            style = WaType.small,
        )
        if (u.role != UserRole.Admin) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip("Default :${o.defaultPort}", u.port == null) { if (!busy && u.port != null) onPort(null) }
                for (p in o.ports) FilterChip(":${p.port}", u.port == p.port) { if (!busy && u.port != p.port) onPort(p.port) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                WaButton(if (u.disabled) "Enable" else "Disable", onToggle, tiny = true, enabled = !busy, style = BtnStyle.Ghost)
                WaButton("Reset…", onReset, tiny = true, style = BtnStyle.Ghost)
                WaButton("Delete…", onDelete, tiny = true, style = BtnStyle.Danger)
            }
        }
    }
}

@Composable
private fun TempPassword(d: AdminDeps, o: AdminOverview, value: String, who: String, port: Int?) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Give $who this temporary password. It is shown only now.", style = WaType.base, color = Wa.colors.text)
        RecoveryKeyBox(value)
        MutedText(
            "They sign in at ${signInUrl(d.api, o, port)} with their username and this password, and are then asked to choose a password of their own. The temporary password stops working once they have.",
            style = WaType.small,
        )
    }
}

@Composable
private fun CreateDialog(d: AdminDeps, o: AdminOverview, onClose: () -> Unit) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var port by remember { mutableStateOf<Int?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<io.github.revocx35.walogger.core.CreateUserResponse?>(null) }
    val scope = rememberCoroutineScope()
    val res = result
    WaDialog(if (res != null) "User created" else "Add a user", onClose) {
        if (res != null) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                TempPassword(d, o, res.temporaryPassword, res.user.username, res.user.port)
                WaButton("Done", onClose, style = BtnStyle.Primary)
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                WaTextField(username, { username = it }, "Username")
                WaTextField(password, { password = it }, "Temporary password (leave empty to generate one)", mono = true, imeAction = ImeAction.Done)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    MutedText("Port", style = WaType.small)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilterChip("Default :${o.defaultPort}", port == null) { port = null }
                        for (p in o.ports) FilterChip(":${p.port}", port == p.port) { port = p.port }
                    }
                }
                ErrorNote(error)
                WaButton("Create user", {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            result = d.api.adminCreateUser(username.trim(), password.takeIf { it.isNotEmpty() }, port)
                        } catch (e: Exception) {
                            error = e.userMessage()
                        } finally {
                            busy = false
                        }
                    }
                }, style = BtnStyle.Primary, block = true, busy = busy, enabled = USER_NAME.matches(username.trim()) && (password.isEmpty() || password.length >= 12))
            }
        }
    }
}

/** The admin's password (and 2FA code) — asked again for destructive actions. */
@Composable
private fun Reauth(d: AdminDeps, password: String, onPassword: (String) -> Unit, totp: String, onTotp: (String) -> Unit) {
    WaTextField(password, onPassword, "Your admin password", password = true, imeAction = if (d.totpEnabled) ImeAction.Next else ImeAction.Done)
    if (d.totpEnabled) WaTextField(totp, { onTotp(it.filter { ch -> ch.isDigit() || ch == ' ' }.take(7)) }, "Authentication code", keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done)
}

@Composable
private fun ResetDialog(d: AdminDeps, o: AdminOverview, user: AdminUser, onClose: () -> Unit, onDone: () -> Unit) {
    var mode by remember { mutableStateOf(ResetMode.Recovery) }
    var adminPassword by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf("") }
    var custom by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val claimed = user.status == UserStatus.Active || user.status == UserStatus.Reset
    val wipe = claimed && mode == ResetMode.Wipe
    val res = result
    if (res != null) {
        WaDialog("Password reset", onClose) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                TempPassword(d, o, res, user.username, user.port)
                if (claimed && mode == ResetMode.Recovery) MutedText("They also need their recovery key to get back into their existing data.", style = WaType.small)
                WaButton("Done", onClose, style = BtnStyle.Primary)
            }
        }
        return
    }
    WaDialog("Reset ${user.username}", onClose) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (claimed) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilterChip("Keep the data", mode == ResetMode.Recovery) { mode = ResetMode.Recovery }
                        FilterChip("Start over", mode == ResetMode.Wipe) { mode = ResetMode.Wipe }
                    }
                    MutedText(
                        if (mode == ResetMode.Recovery) "Forgot the password — keep the data. They sign in with a temporary password and prove they have their recovery key. Their sessions end now."
                        else "Start over — delete everything. Deletes all their logged messages and media and unlinks their WhatsApp. Use it when they lost the recovery key too.",
                        style = WaType.small,
                    )
                }
            } else {
                MutedText("They have not signed in yet. This gives them a new temporary password.")
            }
            WaTextField(custom, { custom = it }, "New temporary password (leave empty to generate one)", mono = true)
            Reauth(d, adminPassword, { adminPassword = it }, totp) { totp = it }
            ErrorNote(error)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                WaButton(if (wipe) "Delete their data and reset" else "Reset password", {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            result = d.api.adminResetUser(user.id, mode, custom.takeIf { it.isNotEmpty() }, adminPassword, totp.replace(" ", "").takeIf { it.isNotEmpty() }).temporaryPassword
                            onDone()
                        } catch (e: Exception) {
                            error = e.userMessage()
                        } finally {
                            busy = false
                        }
                    }
                }, style = if (wipe) BtnStyle.Danger else BtnStyle.Primary, busy = busy, enabled = adminPassword.isNotEmpty() && (custom.isEmpty() || custom.length >= 12))
                WaButton("Cancel", onClose, style = BtnStyle.Ghost)
            }
        }
    }
}

@Composable
private fun DeleteDialog(d: AdminDeps, user: AdminUser, onClose: () -> Unit, onDone: () -> Unit) {
    var adminPassword by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    WaDialog("Delete ${user.username}", onClose) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(
                "This permanently deletes ${user.username}: every logged message and media file, their keys, and their browser with the linked WhatsApp session. Their WhatsApp is unlinked from the phone. It cannot be undone.",
                style = WaType.base, color = Wa.colors.text,
            )
            Reauth(d, adminPassword, { adminPassword = it }, totp) { totp = it }
            ErrorNote(error)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                WaButton("Delete permanently", {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            d.api.adminDeleteUser(user.id, adminPassword, totp.replace(" ", "").takeIf { it.isNotEmpty() })
                            onDone()
                            onClose()
                        } catch (e: Exception) {
                            error = e.userMessage()
                        } finally {
                            busy = false
                        }
                    }
                }, style = BtnStyle.Danger, busy = busy, enabled = adminPassword.isNotEmpty())
                WaButton("Cancel", onClose, style = BtnStyle.Ghost)
            }
        }
    }
}

@Composable
private fun PortsSection(d: AdminDeps, o: AdminOverview, reload: () -> Unit) {
    val free = o.availablePorts.filter { p -> o.ports.none { it.port == p } }
    var port by remember(free) { mutableStateOf(free.firstOrNull()) }
    var origin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun run(block: suspend () -> Unit, then: () -> Unit = {}) {
        busy = true
        error = null
        scope.launch {
            try {
                block()
                reload()
                then()
            } catch (e: Exception) {
                error = e.userMessage()
            } finally {
                busy = false
            }
        }
    }

    SectionCard("Ports") {
        MutedText(
            "The default port :${o.defaultPort} is yours — the admin account can only sign in there. A user assigned to another port can only sign in there, so you can put your own address behind a login proxy " +
                "(e.g. authentik) and give a friend a separate address without one. Point a reverse-proxy host at each port you open " +
                "(the compose file publishes ${if (o.availablePorts.isEmpty()) "none" else "${o.availablePorts.first()}–${o.availablePorts.last()}"}, set by EXTRA_PORTS).",
            style = WaType.small,
        )
        if (o.ports.isEmpty()) {
            MutedText("No extra port is open yet.")
        } else {
            Column {
                o.ports.forEachIndexed { i, p ->
                    if (i > 0) Divider()
                    PortRow(p.port, p.origin, p.usernames, busy,
                        onSave = { v -> run({ d.api.adminPutPort(p.port, v) }) },
                        onRemove = { run({ d.api.adminDeletePort(p.port) }) },
                    )
                }
            }
        }
        if (free.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (p in free) FilterChip(":$p", port == p) { port = p }
                }
                WaTextField(origin, { origin = it }, null, placeholder = "https://friend.example.com (optional)", keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done)
                WaButton("Open port", { port?.let { p -> run({ d.api.adminPutPort(p, origin.trim().takeIf { it.isNotEmpty() }) }, then = { origin = "" }) } }, busy = busy, enabled = port != null)
            }
        } else {
            MutedText("All published ports are open.", style = WaType.small)
        }
        MutedText("The address is the exact origin the browser uses on that port; it is checked on every request. Leave it empty to accept the address the proxy forwards.", style = WaType.small)
        ErrorNote(error)
    }
}

@Composable
private fun PortRow(port: Int, current: String?, users: List<String>, busy: Boolean, onSave: (String?) -> Unit, onRemove: () -> Unit) {
    var origin by remember(current) { mutableStateOf(current ?: "") }
    val dirty = (current ?: "") != origin.trim()
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(":$port", style = WaType.mono, color = Wa.colors.text)
        MutedText(if (users.isEmpty()) "Nobody uses this port" else "Used by ${users.joinToString(", ")}", style = WaType.small)
        WaTextField(origin, { origin = it }, null, placeholder = "derived from the Host header", keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            WaButton("Save", { onSave(origin.trim().takeIf { it.isNotEmpty() }) }, tiny = true, enabled = !busy && dirty)
            WaButton("Close", onRemove, tiny = true, style = BtnStyle.Ghost, enabled = !busy && users.isEmpty())
        }
    }
}

@Composable
private fun LogSection(rows: List<AdminAuditEntry>?, error: String?) {
    val fmt = LocalFormatter.current
    SectionCard("Admin log") {
        ErrorNote(error)
        val l = rows
        if (l == null) {
            if (error == null) Spinner()
        } else if (l.isEmpty()) {
            MutedText("Nothing yet.")
        } else {
            Column {
                l.forEachIndexed { i, r ->
                    if (i > 0) Divider()
                    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        val bad = Regex("fail|bad|deleted|disabled|reset").containsMatchIn(r.event)
                        Text(r.event, style = WaType.mono, color = if (bad) Wa.colors.danger else Wa.colors.text)
                        MutedText(
                            listOfNotNull(fmt.dateTime(r.ts), r.actor?.let { "by $it" }, r.target?.let { "user $it" }, r.ip, r.detail?.takeIf { it.isNotEmpty() }).joinToString(" · "),
                            style = WaType.tiny,
                        )
                    }
                }
            }
        }
    }
}
