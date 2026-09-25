package io.github.revocx35.walogger.ui

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil3.ImageLoader
import io.github.revocx35.walogger.core.ApiException
import io.github.revocx35.walogger.core.Formatter
import io.github.revocx35.walogger.data.AppGraph
import io.github.revocx35.walogger.data.ServerSession
import io.github.revocx35.walogger.media.AudioController
import io.github.revocx35.walogger.ui.components.Spinner
import io.github.revocx35.walogger.ui.screens.AuthActions
import io.github.revocx35.walogger.ui.screens.CertificateDialog
import io.github.revocx35.walogger.ui.screens.LoginScreen
import io.github.revocx35.walogger.ui.screens.RecoverScreen
import io.github.revocx35.walogger.ui.screens.ServerScreen
import io.github.revocx35.walogger.ui.screens.SetupLinkScreen
import io.github.revocx35.walogger.ui.screens.SetupRecoveryScreen
import io.github.revocx35.walogger.ui.screens.SignupScreen
import io.github.revocx35.walogger.ui.screens.UnreachableScreen
import io.github.revocx35.walogger.ui.theme.Wa
import kotlinx.coroutines.launch
import java.security.cert.X509Certificate

private class SessionMediaHost(private val s: ServerSession) : MediaHost {
    override val imageLoader: ImageLoader get() = s.imageLoader
    override val audio: AudioController get() = s.audio
    override fun url(relative: String?): String? = s.mediaUrl(relative)
}

/**
 * Decides which screen the owner belongs on, like the web's route guard (`routeFor`):
 * server → signup → login/recover → recovery key → link WhatsApp → main.
 */
@Composable
fun AppRoot(graph: AppGraph) {
    val ctrl = graph.controller
    val session by ctrl.session.collectAsState()
    val state by ctrl.state.collectAsState()
    val loading by ctrl.loading.collectAsState()
    val error by ctrl.error.collectAsState()
    val wa by ctrl.wa.collectAsState()
    val pendingKey by ctrl.pendingRecoveryKey.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val config = LocalConfiguration.current
    val formatter = remember(config) { Formatter(config.locales[0], java.time.ZoneId.systemDefault(), DateFormat.is24HourFormat(context)) }
    var recoverMode by rememberSaveable { mutableStateOf(false) }
    var reviewCert by remember { mutableStateOf<X509Certificate?>(null) }

    val changeServer: () -> Unit = {
        scope.launch {
            if (ctrl.state.value?.authenticated == true) ctrl.logout()
            ctrl.forgetServer()
        }
    }

    val s = session
    val host = remember(s) { s?.let { SessionMediaHost(it) } }
    CompositionLocalProvider(LocalFormatter provides formatter, LocalMediaHost provides host) {
        val st = state
        when {
            s == null -> ServerScreen(graph) { url, http -> ctrl.setServer(url, http) }
            st == null && loading -> Box(Modifier.fillMaxSize().background(Wa.colors.bg), contentAlignment = Alignment.Center) { Spinner(32.dp) }
            st == null -> UnreachableScreen(
                error?.userMessage,
                onRetry = { ctrl.refresh() },
                onChangeServer = changeServer,
                onReviewCertificate = if (error?.code == ApiException.TLS_UNTRUSTED && graph.trust.lastRejected != null) {
                    { reviewCert = graph.trust.lastRejected?.lastOrNull() }
                } else {
                    null
                },
                busy = loading,
            )
            else -> {
                val auth = remember(s) {
                    AuthActions(
                        signup = { token, user, pw ->
                            val res = s.api.signup(token, user, pw)
                            ctrl.pendingRecoveryKey.value = res.recoveryKey
                            ctrl.refresh().join()
                        },
                        login = { user, pw, totp ->
                            val res = s.api.login(user, pw, totp)
                            if (!res.ok && res.needTotp == true) {
                                true
                            } else {
                                ctrl.refresh().join()
                                false
                            }
                        },
                        recover = { user, key, pw ->
                            val res = s.api.recover(user, key, pw)
                            ctrl.pendingRecoveryKey.value = res.recoveryKey
                            ctrl.refresh().join()
                        },
                    )
                }
                val logout: () -> Unit = { scope.launch { ctrl.logout() } }
                when {
                    !st.hasOwner -> SignupScreen(auth, changeServer)
                    !st.authenticated -> if (recoverMode) RecoverScreen(auth) { recoverMode = false } else LoginScreen(auth, { recoverMode = true }, changeServer)
                    pendingKey != null -> SetupRecoveryScreen(pendingKey) { ctrl.pendingRecoveryKey.value = null; recoverMode = false }
                    !st.onboardingComplete -> SetupLinkScreen(s.api, wa, onComplete = { s.api.completeOnboarding(); ctrl.refresh().join() }, onLogout = logout)
                    else -> MainShell(graph, s, st, wa, onLogout = logout, onChangeServer = changeServer)
                }
            }
        }
    }

    // A crash or "not responding" since the last start: offer the report (stays on the phone unless copied).
    var report by remember { mutableStateOf(graph.diagnostics.unseen()) }
    report?.let {
        io.github.revocx35.walogger.ui.components.ReportDialog(
            "wa_logger stopped unexpectedly",
            "Something went wrong the last time the app ran. The report below contains only technical details (no messages, names or passwords). Copy it and send it to whoever maintains your app.",
            it,
            onClose = { graph.diagnostics.markSeen(); report = null },
        )
    }

    val cert = reviewCert
    val sess = session
    if (cert != null && sess != null) {
        CertificateDialog(sess.baseUrl.host, cert, onTrust = {
            graph.trust.add(cert)
            reviewCert = null
            ctrl.refresh()
        }, onCancel = { reviewCert = null })
    }
}


