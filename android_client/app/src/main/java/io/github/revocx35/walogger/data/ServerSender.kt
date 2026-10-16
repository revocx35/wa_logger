package io.github.revocx35.walogger.data

import android.content.Context
import io.github.revocx35.walogger.core.ApiClient
import io.github.revocx35.walogger.core.ApiException
import io.github.revocx35.walogger.core.SendMediaKind
import io.github.revocx35.walogger.ui.MessageSender
import io.github.revocx35.walogger.ui.OutgoingFile
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source

/** [MessageSender] through the wa_logger server's send API (ARCHITECTURE §8). */
class ServerSender(private val context: Context, private val api: ApiClient) : MessageSender {
    override suspend fun sendText(chatId: String, text: String, quotedId: String?) {
        api.sendText(chatId, text, quotedId)
    }

    override suspend fun sendFile(chatId: String, file: OutgoingFile, kind: SendMediaKind, caption: String?, quotedId: String?) {
        val resolver = context.applicationContext.contentResolver
        // Streamed from the content URI on OkHttp's thread: the file never sits in memory as a whole.
        val body = object : RequestBody() {
            override fun contentType(): MediaType? = file.mime.toMediaTypeOrNull()
            override fun contentLength(): Long = file.size
            override fun writeTo(sink: BufferedSink) {
                val input = resolver.openInputStream(file.uri) ?: throw java.io.IOException("cannot open the file")
                input.source().use { sink.writeAll(it) }
            }
        }
        val up = api.upload(body, file.name)
        api.sendMedia(chatId, up.uploadId, kind, caption, quotedId)
    }

    override suspend fun react(messageId: String, emoji: String) {
        api.react(messageId, emoji)
    }

    override suspend fun revoke(messageId: String) {
        api.revoke(messageId)
    }

    override suspend fun edit(messageId: String, text: String) {
        api.editMessage(messageId, text)
    }

    override suspend fun markRead(chatId: String) {
        api.markRead(chatId)
    }

    override suspend fun newChat(phone: String): String = api.newChat(phone).chatId

    override suspend fun readReceipts(): Boolean = try {
        api.settings().readReceipts
    } catch (_: ApiException) {
        false
    }
}
