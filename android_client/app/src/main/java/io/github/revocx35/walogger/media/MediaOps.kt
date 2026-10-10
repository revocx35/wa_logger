package io.github.revocx35.walogger.media

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import androidx.core.content.FileProvider
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageType
import io.github.revocx35.walogger.core.await
import io.github.revocx35.walogger.core.mapTransportError
import io.github.revocx35.walogger.data.ServerSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.UUID

/**
 * Saving and opening media. Downloads always go through the authenticated client; "Open" writes a
 * temporary copy into the app's private cache (shared read-only with the chosen viewer app through
 * a content:// grant) and those copies are deleted the next time the app starts.
 */
object MediaOps {
    private const val OPEN_DIR = "open"

    fun defaultName(msg: Message): String {
        val m = msg.media
        m?.filename?.let { safeName(it) }?.takeIf { it.isNotBlank() }?.let { return it }
        val ext = when {
            m?.mime?.startsWith("image/jpeg") == true -> "jpg"
            m?.mime?.startsWith("image/png") == true -> "png"
            m?.mime?.startsWith("image/webp") == true -> "webp"
            m?.mime?.startsWith("video/mp4") == true -> "mp4"
            m?.mime?.startsWith("audio/ogg") == true -> "ogg"
            m?.mime?.startsWith("audio/mpeg") == true -> "mp3"
            m?.mime?.startsWith("audio/mp4") == true -> "m4a"
            else -> m?.mime?.substringAfter('/')?.substringBefore(';')?.takeIf { it.length in 1..5 } ?: "bin"
        }
        val kind = when (msg.type) {
            MessageType.Image -> "photo"
            MessageType.Video, MessageType.Gif -> "video"
            MessageType.Ptt -> "voice"
            MessageType.Audio -> "audio"
            MessageType.Sticker -> "sticker"
            else -> "document"
        }
        return "wa_$kind-${msg.ts}.$ext"
    }

    private fun safeName(name: String): String = name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\u0000-\\u001f\\u007f\"*:<>?|]"), "_").take(150)

    /** The server answered with an error status (e.g. 404 after a data wipe). */
    class HttpStatusException(val code: Int) : IOException("HTTP $code")

    private suspend fun download(session: ServerSession, msg: Message, out: OutputStream) = download(session.api, msg, out)

    suspend fun download(api: ApiClient, msg: Message, out: OutputStream) {
        val url = api.mediaUrl(msg.media?.url) ?: throw IOException("no media")
        val req = Request.Builder().url("$url?download=1").build()
        withContext(Dispatchers.IO) {
            val res = try {
                api.http.newCall(req).await()
            } catch (e: IOException) {
                throw mapTransportError(e)
            }
            res.use {
                if (!it.isSuccessful) throw HttpStatusException(it.code)
                it.body.byteStream().use { input -> input.copyTo(out) }
            }
        }
    }

    suspend fun saveTo(context: Context, session: ServerSession, msg: Message, uri: Uri) {
        try {
            withContext(Dispatchers.IO) {
                context.contentResolver.openOutputStream(uri, "w")?.use { out -> download(session, msg, out) } ?: throw IOException("cannot write")
            }
            Toast.makeText(context, "Saved", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            runCatching { android.provider.DocumentsContract.deleteDocument(context.contentResolver, uri) }
            Toast.makeText(context, "Could not save the file.", Toast.LENGTH_LONG).show()
        }
    }

    suspend fun open(context: Context, session: ServerSession, msg: Message) {
        val file = try {
            withContext(Dispatchers.IO) {
                val dir = File(context.cacheDir, "$OPEN_DIR/${UUID.randomUUID()}").apply { mkdirs() }
                File(dir, defaultName(msg)).also { f -> f.outputStream().use { download(session, msg, it) } }
            }
        } catch (e: Exception) {
            Toast.makeText(context, "Could not download the file.", Toast.LENGTH_LONG).show()
            return
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        val mime = msg.media?.mime?.substringBefore(';')?.takeIf { it.contains('/') } ?: "application/octet-stream"
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            context.startActivity(Intent.createChooser(intent, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(context, "No app on this phone can open this file. Use Save instead.", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Saves a photo/video/GIF into the shared gallery: photos to Pictures/wa_logger, the rest to Movies/wa_logger
     * (MediaStore, no storage permission). Android 10+ only; blocking I/O runs on [Dispatchers.IO].
     */
    suspend fun saveToGallery(context: Context, api: ApiClient, msg: Message) {
        if (Build.VERSION.SDK_INT < 29) throw IOException("needs Android 10")
        withContext(Dispatchers.IO) {
            val video = msg.type != MessageType.Image
            val collection = if (video) {
                MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            }
            val mime = msg.media?.mime?.substringBefore(';')?.trim()?.takeIf { it.startsWith(if (video) "video/" else "image/") }
                ?: if (video) "video/mp4" else "image/jpeg"
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, defaultName(msg))
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, (if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/wa_logger")
                put(MediaStore.MediaColumns.DATE_TAKEN, msg.ts)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(collection, values) ?: throw IOException("cannot create file")
            try {
                resolver.openOutputStream(uri, "w")?.use { out -> download(api, msg, out) } ?: throw IOException("cannot write")
                resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            } catch (e: Throwable) {
                runCatching { resolver.delete(uri, null, null) }
                throw e
            }
        }
    }

    /** "Save selected": saves one after another, then reports the result. Never throws. */
    suspend fun saveAllToGallery(context: Context, api: ApiClient, messages: List<Message>) {
        if (Build.VERSION.SDK_INT < 29) {
            Toast.makeText(context, "Saving several files at once needs Android 10 or newer.", Toast.LENGTH_LONG).show()
            return
        }
        Toast.makeText(context, "Saving ${messages.size} to the gallery…", Toast.LENGTH_SHORT).show()
        var failed = 0
        for (m in messages) {
            try {
                saveToGallery(context, api, m)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                failed++
            }
        }
        val ok = messages.size - failed
        val text = if (failed == 0) "Saved $ok to the gallery (wa_logger album)." else "Saved $ok of ${messages.size}; $failed could not be saved."
        Toast.makeText(context, text, Toast.LENGTH_LONG).show()
    }

    /** Deletes temporary copies from earlier "Open" actions. */
    fun cleanup(context: Context) {
        File(context.cacheDir, OPEN_DIR).deleteRecursively()
    }
}
