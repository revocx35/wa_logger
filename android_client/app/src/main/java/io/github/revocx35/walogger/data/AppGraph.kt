package io.github.revocx35.walogger.data

import android.content.Context
import android.os.Build
import coil3.ImageLoader
import coil3.gif.AnimatedImageDecoder
import coil3.gif.GifDecoder
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import io.github.revocx35.walogger.BuildConfig
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.EventStream
import io.github.revocx35.walogger.core.parseServerUrl
import io.github.revocx35.walogger.core.userMessage
import io.github.revocx35.walogger.media.AudioController
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.Dispatchers
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import java.util.UUID
import java.util.concurrent.TimeUnit

/** App-wide singletons (created once in [io.github.revocx35.walogger.WaLoggerApp]). */
class AppGraph(val context: Context, val diagnostics: Diagnostics) {
    val prefs = Prefs(context)
    val cookies = SecureCookieJar(context)
    val trust = ServerTrust(prefs)
    /** Background work must never take the app down: record unexpected failures instead. */
    val errors = CoroutineExceptionHandler { ctx, e -> diagnostics.recordNonFatal(ctx[CoroutineName]?.name ?: "app", e) }
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + errors)

    private val userAgent = "wa_logger-android/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; ${Build.MANUFACTURER} ${Build.MODEL})"

    val baseClient: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(cookies)
        .sslSocketFactory(trust.socketFactory, trust)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .addNetworkInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("User-Agent", userAgent).build()) }
        .build()

    val controller = AppController(this)

    fun savedServer(): HttpUrl? = prefs.serverUrl?.let { parseServerUrl(it) }
}

/**
 * Everything bound to one server: API client, live events, image loader. Replaced when the owner
 * switches servers. Media is never written to a disk cache (memory cache only), so nothing
 * decrypted outlives the process except files the owner explicitly saves or opens.
 */
class ServerSession(graph: AppGraph, val baseUrl: HttpUrl) {
    val id: String = UUID.randomUUID().toString()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + graph.errors)
    val api = ApiClient(graph.baseClient, baseUrl)
    val events = EventStream(api, scope)

    val imageLoader: ImageLoader = ImageLoader.Builder(graph.context)
        .components {
            add(OkHttpNetworkFetcherFactory(callFactory = { api.http }))
            if (Build.VERSION.SDK_INT >= 28) add(AnimatedImageDecoder.Factory()) else add(GifDecoder.Factory())
        }
        .memoryCache { MemoryCache.Builder().maxSizePercent(graph.context, 0.2).build() }
        .diskCache(null)
        .build()

    private var audioUsed = false

    /** Shared player for voice messages (created on first use). */
    val audio: AudioController by lazy {
        audioUsed = true
        AudioController(graph.context, api.http, scope)
    }

    private val diagnostics = graph.diagnostics

    /** UI text for a failed operation; unexpected (non-API) failures also go into the crash report. */
    fun fail(where: String, e: Throwable): String {
        if (e !is io.github.revocx35.walogger.core.ApiException && e !is kotlinx.coroutines.CancellationException) diagnostics.recordNonFatal(where, e)
        return e.userMessage()
    }

    /** Absolute URL for a server-relative `/api/media/…` URL. */
    fun mediaUrl(relative: String?): String? = api.mediaUrl(relative)

    fun close() {
        events.stop()
        if (audioUsed) audio.release()
        imageLoader.memoryCache?.clear()
        imageLoader.shutdown()
        scope.cancel()
    }
}
