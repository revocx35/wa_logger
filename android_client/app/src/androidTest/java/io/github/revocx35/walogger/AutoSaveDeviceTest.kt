package io.github.revocx35.walogger

import android.content.ContentUris
import android.content.Context
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkInfo
import androidx.work.WorkManager
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.parseServerUrl
import io.github.revocx35.walogger.data.Diagnostics
import io.github.revocx35.walogger.data.Prefs
import io.github.revocx35.walogger.media.AutoSaver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs the real auto-save path on Android (MediaStore writes, WorkManager scheduling) against a fake server.
 * The JVM tests can't cover these: they only exist on a device.
 */
@RunWith(AndroidJUnit4::class)
class AutoSaveDeviceTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val prefs = Prefs(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient
    private val photo = ByteArray(5000) { (it * 31).toByte() }
    private val downloads = mutableListOf<String>()

    // ts doubles as the saved file name (wa_photo-<ts>.jpg), so it identifies our files in the gallery.
    private val tsPlain = 1_760_000_000_101L
    private val tsDisappearing = 1_760_000_000_202L

    private fun feed(after: String?): String = if (after == null) {
        """{"items":[],"cursor":"0","more":false}"""
    } else if (after == "0") {
        """{"items":[
          {"chat":{"id":"1@c.us","name":"A","kind":"user"},"message":{"id":"m1","chatId":"1@c.us","type":"image","ts":$tsPlain,"media":{"status":"downloaded","url":"/api/media/1","mime":"image/jpeg"}}},
          {"chat":{"id":"2@c.us","name":"B","kind":"user"},"message":{"id":"m2","chatId":"2@c.us","type":"image","ts":$tsDisappearing,"disappearingSec":604800,"media":{"status":"downloaded","url":"/api/media/2","mime":"image/jpeg"}}},
          {"chat":{"id":"2@c.us","name":"B","kind":"user"},"message":{"id":"m3","chatId":"2@c.us","type":"sticker","ts":5,"disappearingSec":604800,"media":{"status":"downloaded","url":"/api/media/3","mime":"image/webp"}}}
        ],"cursor":"3","more":false}"""
    } else {
        """{"items":[],"cursor":"$after","more":false}"""
    }

    @Before
    fun setUp() {
        cleanGallery()
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.url
                return when {
                    url.encodedPath == "/api/media-feed" ->
                        MockResponse.Builder().addHeader("Content-Type", "application/json").body(feed(url.queryParameter("after"))).build()
                    url.encodedPath.startsWith("/api/media/") -> {
                        synchronized(downloads) { downloads += url.encodedPath }
                        MockResponse.Builder().addHeader("Content-Type", "image/jpeg").body(Buffer().write(photo)).build()
                    }
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
        server.start()
        api = ApiClient(OkHttpClient(), parseServerUrl(server.url("/").toString())!!)
    }

    @After
    fun tearDown() {
        runBlocking { AutoSaver(context, prefs, scope, Diagnostics(context)).setEnabled(api, false) }
        prefs.autoSaveOnlyDisappearing = false
        prefs.autoSaveCount = 0
        scope.cancel()
        server.close()
        cleanGallery()
    }

    private fun ourFiles(): Map<String, ByteArray> {
        val out = mutableMapOf<String, ByteArray>()
        val uri = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        context.contentResolver.query(
            uri,
            arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.RELATIVE_PATH),
            "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?",
            arrayOf("Pictures/wa_logger%"),
            null,
        )?.use { c ->
            while (c.moveToNext()) {
                val item = ContentUris.withAppendedId(uri, c.getLong(0))
                out[c.getString(1)] = context.contentResolver.openInputStream(item)!!.use { it.readBytes() }
            }
        }
        return out
    }

    private fun cleanGallery() {
        context.contentResolver.delete(
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
            "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?",
            arrayOf("Pictures/wa_logger%"),
        )
    }

    @Test
    fun savesOnlyDisappearingPhotosWhenAsked() = runBlocking {
        val saver = AutoSaver(context, prefs, scope, Diagnostics(context))
        saver.setEnabled(api, true)
        saver.setOnlyDisappearing(true)
        val work = WorkManager.getInstance(context).getWorkInfosForUniqueWork("autosave").get()
        assertEquals(WorkInfo.State.ENQUEUED, work.single().state)

        assertTrue(saver.run(api))
        assertEquals(listOf("/api/media/2"), synchronized(downloads) { downloads.toList() })
        val files = ourFiles()
        assertEquals(setOf("wa_photo-$tsDisappearing.jpg"), files.keys)
        assertTrue(files.values.single().contentEquals(photo))
        assertEquals(1, saver.state.value.saved)
        assertEquals(null, saver.state.value.error)

        // Nothing new: a second run saves nothing and doesn't download again.
        assertTrue(saver.run(api))
        assertEquals(1, ourFiles().size)
        assertEquals(1, synchronized(downloads) { downloads.size })

        saver.setEnabled(api, false)
        val after = WorkManager.getInstance(context).getWorkInfosForUniqueWork("autosave").get()
        assertTrue(after.all { it.state == WorkInfo.State.CANCELLED })
    }

    @Test
    fun savesEveryPhotoByDefault() = runBlocking {
        val saver = AutoSaver(context, prefs, scope, Diagnostics(context))
        saver.setEnabled(api, true)
        assertTrue(saver.run(api))
        assertEquals(setOf("wa_photo-$tsPlain.jpg", "wa_photo-$tsDisappearing.jpg"), ourFiles().keys)
    }
}
