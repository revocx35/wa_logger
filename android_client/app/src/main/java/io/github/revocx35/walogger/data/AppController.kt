package io.github.revocx35.walogger.data

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import io.github.revocx35.walogger.core.ApiException
import io.github.revocx35.walogger.core.AppState
import io.github.revocx35.walogger.core.ServerEvent
import io.github.revocx35.walogger.core.WaStatus
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

/**
 * App-level state, like the web's AppStateProvider: the server's `/api/state`, the live WhatsApp
 * status, and the one-time recovery key after signup/recovery (memory only, never persisted).
 * The live event stream runs only while the app is in the foreground and the owner is logged in.
 */
class AppController(private val graph: AppGraph) {
    private val _session = MutableStateFlow<ServerSession?>(null)
    val session: StateFlow<ServerSession?> = _session.asStateFlow()

    private val _state = MutableStateFlow<AppState?>(null)
    val state: StateFlow<AppState?> = _state.asStateFlow()

    private val _loading = MutableStateFlow(true)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    /** Why the last `/api/state` failed (shown on the "cannot reach" screen). */
    private val _error = MutableStateFlow<ApiException?>(null)
    val error: StateFlow<ApiException?> = _error.asStateFlow()

    private val _wa = MutableStateFlow<WaStatus?>(null)
    val wa: StateFlow<WaStatus?> = _wa.asStateFlow()

    val pendingRecoveryKey = MutableStateFlow<String?>(null)

    /** The address shown again on the server screen after "Change server". */
    var previousServerUrl: String? = null
        private set

    private var inflight: Job? = null
    private var eventsJob: Job? = null
    private var foreground = false

    init {
        graph.savedServer()?.let { open(it) } ?: run { _loading.value = false }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                foreground = true
                syncEvents()
                if (_session.value != null) refresh()
            }

            override fun onStop(owner: LifecycleOwner) {
                foreground = false
                syncEvents()
            }
        })
    }

    /** The live stream runs only while the app is visible and the owner is logged in. */
    private fun syncEvents() {
        val s = _session.value ?: return
        if (foreground && _state.value?.authenticated == true) s.events.start() else s.events.stop()
    }

    private fun open(url: HttpUrl) {
        inflight?.cancel()
        inflight = null
        _session.value?.close()
        graph.trust.serverHost = url.host
        val s = ServerSession(graph, url)
        s.api.onUnauthorized = { graph.scope.launch { refresh() } }
        _session.value = s
        _state.value = null
        _wa.value = null
        _error.value = null
        eventsJob?.cancel()
        eventsJob = graph.scope.launch {
            s.events.events.collect { ev ->
                when (ev) {
                    is ServerEvent.WaStateChanged -> _wa.value = ev.status
                    is ServerEvent.SyncProgressChanged -> _wa.value = _wa.value?.copy(sync = ev.sync)
                    is ServerEvent.SessionRevoked -> refresh()
                    else -> Unit
                }
            }
        }
        refresh()
    }

    /** Switch to (or first set up) a server. Cookies of the previous server are dropped. */
    fun setServer(url: HttpUrl, allowHttp: Boolean) {
        if (graph.prefs.serverUrl != url.toString()) {
            graph.cookies.clear()
            if (graph.savedServer()?.host != url.host) graph.prefs.trustedCerts = emptyList()
        }
        graph.prefs.serverUrl = url.toString()
        graph.prefs.allowHttp = allowHttp
        graph.trust.reload()
        open(url)
    }

    /** Back to the server screen; forgets the address, trusted certificates and the session cookie. */
    fun forgetServer() {
        previousServerUrl = graph.prefs.serverUrl
        _session.value?.close()
        _session.value = null
        graph.cookies.clear()
        graph.prefs.clearServer()
        graph.trust.reload()
        graph.trust.serverHost = null
        _state.value = null
        _wa.value = null
        _error.value = null
        _loading.value = false
        pendingRecoveryKey.value = null
    }

    fun refresh(): Job {
        inflight?.let { if (it.isActive) return it }
        val s = _session.value ?: return Job().apply { complete() }
        _loading.value = true
        val job = graph.scope.launch {
            try {
                val st = s.api.state()
                if (_session.value !== s) return@launch
                s.api.csrfToken = st.csrfToken
                _state.value = st
                _error.value = null
                st.wa?.let { _wa.value = it }
                syncEvents()
                if (!st.authenticated) graph.cookies.clear()
            } catch (e: ApiException) {
                if (_session.value === s) {
                    _error.value = e
                    // Keep showing the last known state on transient errors once logged in.
                    if (_state.value?.authenticated != true) _state.value = null
                }
            } finally {
                if (_session.value === s) _loading.value = false
            }
        }
        inflight = job
        return job
    }

    suspend fun logout() {
        val s = _session.value ?: return
        runCatching { s.api.logout() }
        s.events.stop()
        graph.cookies.clear()
        refresh().join()
    }
}
