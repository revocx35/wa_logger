package io.github.revocx35.walogger.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit

/**
 * One shared Server-Sent Events connection (`GET /api/events`), like the web's EventHub.
 * Events carry only ids and states (never content). Reconnects with backoff; a 401 stops it.
 * [reopened] fires when the stream comes back after a drop, so screens can reload what they missed.
 */
class EventStream(private val api: ApiClient, private val scope: CoroutineScope) {
    private val _events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 256)
    val events: SharedFlow<ServerEvent> = _events.asSharedFlow()

    private val _reopened = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
    val reopened: SharedFlow<Unit> = _reopened.asSharedFlow()

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    // The server sends a heartbeat every 20 s: a longer silence means the connection is dead.
    private val client = api.http.newBuilder().readTimeout(65, TimeUnit.SECONDS).retryOnConnectionFailure(true).build()

    private var source: EventSource? = null
    private var reconnectJob: Job? = null
    private var running = false
    @Volatile private var generation = 0
    private var failures = 0
    private var everOpened = false

    @Synchronized
    fun start() {
        if (running) return
        running = true
        connect()
    }

    @Synchronized
    fun stop() {
        running = false
        generation++
        reconnectJob?.cancel()
        reconnectJob = null
        source?.cancel()
        source = null
        _connected.value = false
        everOpened = false
        failures = 0
    }

    @Synchronized
    private fun connect() {
        if (!running) return
        val gen = ++generation
        val request = Request.Builder().url(api.url("/api/events")).header("Accept", "text/event-stream").build()
        source = EventSources.createFactory(client).newEventSource(request, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                synchronized(this@EventStream) {
                    if (gen != generation) return
                    failures = 0
                    _connected.value = true
                    if (everOpened) _reopened.tryEmit(Unit)
                    everOpened = true
                }
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                if (gen != generation) return
                val ev = runCatching { WaJson.decodeFromString(ServerEvent.serializer(), data) }.getOrNull() ?: return
                _events.tryEmit(ev)
            }

            override fun onClosed(eventSource: EventSource) = retry(gen, null)

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) = retry(gen, response?.code)
        })
    }

    private fun retry(gen: Int, status: Int?) {
        synchronized(this) {
            if (gen != generation || !running) return
            _connected.value = false
            source = null
            if (status == 401) {
                // Logged out / session gone: the app re-checks /api/state and stops the stream.
                api.onUnauthorized?.invoke()
            }
            failures++
            val wait = (3_000L shl (failures - 1).coerceAtMost(3)).coerceAtMost(30_000L)
            reconnectJob = scope.launch {
                delay(wait)
                connect()
            }
        }
    }
}
