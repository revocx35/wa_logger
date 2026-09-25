package io.github.revocx35.walogger.ui

import androidx.compose.runtime.staticCompositionLocalOf
import coil3.ImageLoader
import io.github.revocx35.walogger.core.Formatter
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageEdit

/** Where media and avatars come from (the logged-in server session; a fake in screenshot tests). */
interface MediaHost {
    val imageLoader: ImageLoader?

    /** Shared voice-message / audio player (null in previews). */
    val audio: io.github.revocx35.walogger.media.AudioController? get() = null

    /** Absolute URL for a server-relative `/api/media/…` URL, or null. */
    fun url(relative: String?): String?
}

/** What a message bubble can ask the screen to do. */
interface MessageActions {
    fun jump(messageId: String) {}
    fun openMedia(msg: Message) {}
    fun saveMedia(msg: Message) {}
    fun openDocument(msg: Message) {}
    suspend fun retryMedia(messageId: String) {}
    suspend fun edits(messageId: String): List<MessageEdit> = emptyList()
}

object NoMessageActions : MessageActions

val LocalMediaHost = staticCompositionLocalOf<MediaHost?> { null }
val LocalFormatter = staticCompositionLocalOf { Formatter() }
val LocalMessageActions = staticCompositionLocalOf<MessageActions> { NoMessageActions }
