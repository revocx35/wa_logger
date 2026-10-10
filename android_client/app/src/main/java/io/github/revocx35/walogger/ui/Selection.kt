package io.github.revocx35.walogger.ui

import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.staticCompositionLocalOf
import io.github.revocx35.walogger.core.MediaStatus
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageType

/**
 * Multi-select of downloaded photos and videos in a chat (long-press to start, tap to toggle), saved to the
 * gallery together. Selection mode is on while anything is selected, like WhatsApp.
 */
class MessageSelection {
    private val selected = mutableStateMapOf<String, Message>()

    val active: Boolean get() = selected.isNotEmpty()
    val count: Int get() = selected.size
    /** Oldest first, so the gallery gets them in chat order. */
    val messages: List<Message> get() = selected.values.sortedBy { it.ts }

    fun isSelected(id: String) = id in selected

    fun toggle(msg: Message) {
        if (!selectable(msg)) return
        if (selected.remove(msg.id) == null) selected[msg.id] = msg
    }

    fun selectAll(messages: List<Message>) {
        for (m in messages) if (selectable(m)) selected[m.id] = m
    }

    fun clear() = selected.clear()

    companion object {
        /** Media that can be saved to the gallery right now (downloaded photos, videos and GIFs). */
        fun selectable(msg: Message): Boolean {
            val m = msg.media ?: return false
            return m.status == MediaStatus.Downloaded && m.url != null && msg.type in setOf(MessageType.Image, MessageType.Video, MessageType.Gif)
        }
    }
}

val LocalSelection = staticCompositionLocalOf<MessageSelection?> { null }
