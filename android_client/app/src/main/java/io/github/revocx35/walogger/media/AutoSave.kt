package io.github.revocx35.walogger.media

import android.content.Context
import android.os.Build
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.github.revocx35.walogger.WaLoggerApp
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.ApiException
import io.github.revocx35.walogger.core.ChatKind
import io.github.revocx35.walogger.core.MediaFeedItem
import io.github.revocx35.walogger.core.MediaStatus
import io.github.revocx35.walogger.core.MessageType
import io.github.revocx35.walogger.data.Diagnostics
import io.github.revocx35.walogger.data.Prefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Which media the owner wants copied to the phone. Pure, so it is unit-tested. */
object AutoSavePolicy {
    fun wants(item: MediaFeedItem, videos: Boolean, status: Boolean, onlyDisappearing: Boolean = false): Boolean {
        val m = item.message
        val media = m.media ?: return false
        if (media.status != MediaStatus.Downloaded || media.url == null) return false
        if (!status && (m.isStatus || item.chat.kind == ChatKind.Status)) return false
        // WhatsApp itself never saves disappearing-message media to the gallery: this fills exactly that gap.
        if (onlyDisappearing && (m.disappearingSec ?: 0.0) <= 0.0) return false
        return when (m.type) {
            MessageType.Image -> true
            MessageType.Video, MessageType.Gif -> videos
            else -> false
        }
    }

    /** The server's feed cursor is the media id, the last segment of `/api/media/<id>`. */
    fun cursorOf(item: MediaFeedItem): String? = item.message.media?.url?.substringAfterLast('/')?.takeIf { s -> s.isNotEmpty() && s.all(Char::isDigit) }
}

data class AutoSaveState(
    val enabled: Boolean,
    val videos: Boolean,
    val status: Boolean,
    val onlyDisappearing: Boolean,
    val saved: Int,
    val lastRunAt: Long,
    val error: String?,
)

/**
 * "Save new photos to this phone": copies media the server downloaded since the feature was turned on into
 * the shared Pictures/Movies collections (MediaStore, no storage permission needed on Android 10+).
 * Runs right away while the app is open (on `message_update` media events) and about every 15 minutes in the
 * background (WorkManager). Progress is kept per item, so an interrupted run never saves a file twice.
 * The copies leave the encrypted store on purpose; the setting is off by default and says so.
 */
class AutoSaver(private val context: Context, private val prefs: Prefs, private val scope: CoroutineScope, private val diagnostics: Diagnostics) {
    private val mutex = Mutex()
    private val _state = MutableStateFlow(readState())
    val state: StateFlow<AutoSaveState> = _state.asStateFlow()

    private var kickJob: Job? = null
    private var again = false

    private fun readState() = AutoSaveState(prefs.autoSave, prefs.autoSaveVideos, prefs.autoSaveStatus, prefs.autoSaveOnlyDisappearing, prefs.autoSaveCount, prefs.autoSaveLastRun, prefs.autoSaveError)
    private fun publish() {
        _state.value = readState()
    }

    /** Turning it on starts at the server's current end: only media downloaded from now on is saved. */
    suspend fun setEnabled(api: ApiClient, on: Boolean) {
        if (on) {
            check(SUPPORTED) { "Android 10 or newer is needed" }
            val cursor = api.mediaFeed(null).cursor
            prefs.setAutoSaveCursor(api.baseUrl.toString(), cursor)
            prefs.autoSaveError = null
            prefs.autoSave = true
        } else {
            prefs.autoSave = false
            prefs.setAutoSaveCursor(null, null)
        }
        schedule(context, on)
        publish()
    }

    fun setVideos(on: Boolean) {
        prefs.autoSaveVideos = on
        publish()
    }

    fun setStatus(on: Boolean) {
        prefs.autoSaveStatus = on
        publish()
    }

    fun setOnlyDisappearing(on: Boolean) {
        prefs.autoSaveOnlyDisappearing = on
        publish()
    }

    /** Called from the main thread when new media may be available (live event, app opened). */
    fun kick(api: ApiClient) {
        if (!prefs.autoSave) return
        again = true
        if (kickJob?.isActive == true) return
        kickJob = scope.launch {
            while (again) {
                again = false
                delay(1_500)
                run(api)
            }
        }
    }

    /** One pass over the feed. Returns false when it should be retried later (network trouble). */
    suspend fun run(api: ApiClient): Boolean = mutex.withLock {
        if (!prefs.autoSave || !SUPPORTED) return true
        val server = api.baseUrl.toString()
        var ok = true
        try {
            var cursor = prefs.autoSaveCursor(server)
            if (cursor == null) {
                // First run for this server (switched servers): start at its current end.
                prefs.setAutoSaveCursor(server, api.mediaFeed(null).cursor)
                return@withLock true
            }
            var pages = 0
            while (pages++ < MAX_PAGES) {
                val page = api.mediaFeed(cursor, PAGE)
                for (item in page.items) {
                    if (!prefs.autoSave) return@withLock true
                    if (AutoSavePolicy.wants(item, prefs.autoSaveVideos, prefs.autoSaveStatus, prefs.autoSaveOnlyDisappearing)) {
                        try {
                            MediaOps.saveToGallery(context, api, item.message)
                            prefs.autoSaveCount += 1
                        } catch (e: MediaOps.HttpStatusException) {
                            // Gone on the server (wiped/deleted): nothing to save, move on.
                            if (e.code != 404 && e.code != 410) throw e
                        }
                    }
                    AutoSavePolicy.cursorOf(item)?.let { c -> prefs.setAutoSaveCursor(server, c) }
                }
                cursor = page.cursor
                prefs.setAutoSaveCursor(server, page.cursor)
                if (!page.more) break
            }
            prefs.autoSaveError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ok = false
            prefs.autoSaveError = when {
                e is ApiException && e.status == 401 -> "Signed out: open the app and sign in again."
                e is ApiException -> e.userMessage
                e is MediaOps.HttpStatusException -> "The server refused a download (${e.code}). Will retry."
                e is IOException -> "Could not save a file (storage full?). Will retry."
                else -> {
                    diagnostics.recordNonFatal("autosave", e)
                    "Something went wrong. Will retry."
                }
            }
            if (e is ApiException && e.status == 401) ok = true // retrying won't help until the owner signs in
        } finally {
            prefs.autoSaveLastRun = System.currentTimeMillis()
            publish()
        }
        ok
    }

    companion object {
        val SUPPORTED = Build.VERSION.SDK_INT >= 29
        private const val PAGE = 50
        private const val MAX_PAGES = 20
        private const val WORK = "autosave"

        /** The background part: a periodic job (Android runs it about every 15 minutes, later in battery saver). */
        fun schedule(context: Context, on: Boolean) {
            val wm = WorkManager.getInstance(context)
            if (!on) {
                wm.cancelUniqueWork(WORK)
                return
            }
            val req = PeriodicWorkRequestBuilder<AutoSaveWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}

class AutoSaveWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = (applicationContext as WaLoggerApp).graph
        if (!graph.prefs.autoSave) return Result.success()
        // The session for the saved server is opened when the app process starts (AppController).
        val api = withContext(Dispatchers.Main) { graph.controller.session.value?.api } ?: return Result.success()
        return if (graph.autoSave.run(api)) Result.success() else Result.retry()
    }
}
