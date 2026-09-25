package io.github.revocx35.walogger.media

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.core.content.FileProvider
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

    private suspend fun download(session: ServerSession, msg: Message, out: OutputStream) {
        val url = session.mediaUrl(msg.media?.url) ?: throw IOException("no media")
        val req = Request.Builder().url("$url?download=1").build()
        val res = try {
            session.api.http.newCall(req).await()
        } catch (e: IOException) {
            throw mapTransportError(e)
        }
        res.use {
            if (!it.isSuccessful) throw IOException("HTTP ${it.code}")
            withContext(Dispatchers.IO) { it.body.byteStream().use { input -> input.copyTo(out) } }
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

    /** Deletes temporary copies from earlier "Open" actions. */
    fun cleanup(context: Context) {
        File(context.cacheDir, OPEN_DIR).deleteRecursively()
    }
}
