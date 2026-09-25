package io.github.revocx35.walogger.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.ApiException
import io.github.revocx35.walogger.core.isLocalHost
import io.github.revocx35.walogger.core.parseServerUrl
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.data.AppGraph
import io.github.revocx35.walogger.data.ServerTrust
import io.github.revocx35.walogger.ui.components.BtnStyle
import io.github.revocx35.walogger.ui.components.CheckRow
import io.github.revocx35.walogger.ui.components.ErrorNote
import io.github.revocx35.walogger.ui.components.LinkButton
import io.github.revocx35.walogger.ui.components.MutedText
import io.github.revocx35.walogger.ui.components.Note
import io.github.revocx35.walogger.ui.components.WaButton
import io.github.revocx35.walogger.ui.components.WaDialog
import io.github.revocx35.walogger.ui.components.WaTextField
import io.github.revocx35.walogger.ui.theme.Wa
import io.github.revocx35.walogger.ui.theme.WaIcons
import io.github.revocx35.walogger.ui.theme.WaType
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import java.security.cert.X509Certificate
import java.text.DateFormat
import java.util.Date

/** Shows a certificate the owner is asked to trust (first use), with its SHA-256 fingerprint. */
@Composable
fun CertificateDialog(host: String, cert: X509Certificate, onTrust: () -> Unit, onCancel: () -> Unit) {
    val c = Wa.colors
    WaDialog("Untrusted certificate", onCancel) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                "Android does not trust the certificate of $host. This is normal for a server that uses its own certificate authority " +
                    "(for example Caddy's internal CA when you open the server by IP address).",
                style = WaType.base,
                color = c.text,
            )
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(c.panel2).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Issued to: ${ServerTrust.commonName(cert)}", style = WaType.small, color = c.text)
                Text("Issued by: ${Regex("(?:^|,)CN=([^,]*)").find(cert.issuerX500Principal.name)?.groupValues?.get(1) ?: cert.issuerX500Principal.name}", style = WaType.small, color = c.text)
                Text("Valid until: ${DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(cert.notAfter.time))}", style = WaType.small, color = c.text)
                Text("SHA-256 fingerprint", style = WaType.small.copy(fontWeight = FontWeight.SemiBold), color = c.text, modifier = Modifier.padding(top = 6.dp))
                Text(ServerTrust.sha256(cert), style = WaType.small.merge(WaType.mono), color = c.text)
            }
            MutedText(
                "Only trust it if the fingerprint matches your server. Check it on the server with:\n" +
                    "docker compose exec caddy sh -c \"openssl x509 -noout -fingerprint -sha256 -in /data/caddy/pki/authorities/local/intermediate.crt\"\n" +
                    "Caddy renews its intermediate certificate every few days; to avoid confirming again, import Caddy's root.crt instead (Settings → App).",
                style = WaType.small,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                WaButton("Trust this certificate", onTrust, style = BtnStyle.Primary)
                WaButton("Cancel", onCancel, style = BtnStyle.Ghost)
            }
        }
    }
}

/**
 * First screen: where is the wa_logger server? Probes `/api/state` before saving, handles
 * HTTP→HTTPS redirects, untrusted certificates (trust on first use or an imported CA) and makes
 * plain HTTP to a public address an explicit choice.
 */
@Composable
fun ServerScreen(graph: AppGraph, onConnected: (HttpUrl, Boolean) -> Unit) {
    val c = Wa.colors
    val context = LocalContext.current
    var address by rememberSaveable { mutableStateOf(graph.prefs.serverUrl ?: graph.controller.previousServerUrl?.removeSuffix("/") ?: "") }
    var allowHttp by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var reviewCert by remember { mutableStateOf<Pair<HttpUrl, X509Certificate>?>(null) }
    val scope = rememberCoroutineScope()
    val url = parseServerUrl(address)
    val insecure = url != null && !url.isHttps
    val publicHttp = url != null && !url.isHttps && !isLocalHost(url.host)

    fun probe(target: HttpUrl) {
        busy = true
        error = null
        graph.trust.serverHost = target.host
        scope.launch {
            try {
                ApiClient(graph.baseClient, target).probe()
                onConnected(target, insecure)
            } catch (e: ApiException) {
                val rejected = graph.trust.lastRejected
                if (e.code == ApiException.TLS_UNTRUSTED && rejected != null && rejected.isNotEmpty()) {
                    reviewCert = target to rejected.last()
                } else if (e.code == ApiException.NETWORK && target.isHttps && isLocalHost(target.host)) {
                    error = "${e.userMessage} If your server runs in HTTP mode (setup.sh --http-only), use http://${target.host}${if (target.port != 443) ":${target.port}" else ""} instead."
                } else {
                    error = e.userMessage
                }
            } finally {
                busy = false
            }
        }
    }

    val importCa = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
        val cert = bytes?.let { ServerTrust.parseCertificate(it) }
        if (cert == null) {
            error = "That file is not a certificate (PEM or DER)."
        } else {
            graph.trust.add(cert)
            error = null
            url?.let { probe(it) }
        }
    }

    AuthShell("Connect to your server", "Enter the address of your wa_logger server — the same address you open in the browser.") {
        WaTextField(
            address,
            { address = it.trim(); error = null },
            "Server address",
            placeholder = "https://wa.example.com",
            keyboardType = KeyboardType.Uri,
            imeAction = ImeAction.Go,
            onIme = { if (url != null && (!publicHttp || allowHttp)) probe(url) },
        )
        if (address.isNotEmpty() && url == null) ErrorNote("Enter an address like wa.example.com, https://wa.example.com or http://192.168.1.50.")
        if (insecure && !publicHttp) {
            Note("This connection is not encrypted (HTTP). That is only OK inside your own network — use your HTTPS address anywhere else.", WaIcons.warning)
        }
        if (publicHttp) {
            Note("Plain HTTP to a public address: your password and messages would travel unencrypted. Use the HTTPS address of your reverse proxy.", WaIcons.warning)
            CheckRow(allowHttp, { allowHttp = it }, "I understand — connect over HTTP anyway")
        }
        ErrorNote(error)
        WaButton("Connect", { url?.let { probe(it) } }, style = BtnStyle.Primary, block = true, busy = busy, enabled = url != null && (!publicHttp || allowHttp))
        LinkButton("Import a CA certificate…", { importCa.launch(arrayOf("*/*")) }, style = WaType.small, color = c.muted, icon = WaIcons.shield)
    }

    reviewCert?.let { (target, cert) ->
        CertificateDialog(target.host, cert, onTrust = {
            graph.trust.add(cert)
            reviewCert = null
            probe(target)
        }, onCancel = { reviewCert = null; error = "The server's certificate is not trusted." })
    }
}
