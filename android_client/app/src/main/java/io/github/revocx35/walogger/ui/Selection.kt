package io.github.revocx35.walogger.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import io.github.revocx35.walogger.core.MediaStatus
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageType

/**
 * Multi-select in a chat, like WhatsApp: selection mode is on while anything is selected (tap to toggle).
 * [Mode.Save]: downloaded photos and videos, saved to the gallery together. [Mode.Delete]: any message, deleted from the
 * log (storage control; the server's `POST /api/messages/delete`).
 */
class MessageSelection {
    enum class Mode { Save, Delete }

    private val selected = mutableStateMapOf<String, Message>()

    var mode by mutableStateOf(Mode.Save)
        private set

    val active: Boolean get() = selected.isNotEmpty()
    val count: Int get() = selected.size
    /** Oldest first, so the gallery gets them in chat order. */
    val messages: List<Message> get() = selected.values.sortedBy { it.ts }

    fun isSelected(id: String) = id in selected

    /** Whether [msg] can be selected in the current mode. */
    fun canSelect(msg: Message): Boolean = if (mode == Mode.Delete) deletable(msg) else selectable(msg)

    fun toggle(msg: Message) {
        if (!canSelect(msg)) return
        if (selected.remove(msg.id) == null) selected[msg.id] = msg
    }

    /** Starts selecting in [m] mode with [msg] selected (switching mode drops the earlier selection). */
    fun start(m: Mode, msg: Message) {
        if (mode != m) {
            selected.clear()
            mode = m
        }
        toggle(msg)
    }

    fun selectAll(messages: List<Message>) {
        for (m in messages) if (canSelect(m)) selected[m.id] = m
    }

    fun clear() {
        selected.clear()
        mode = Mode.Save
    }

    companion object {
        /** Media that can be saved to the gallery right now (downloaded photos, videos and GIFs). */
        fun selectable(msg: Message): Boolean {
            val m = msg.media ?: return false
            return m.status == MediaStatus.Downloaded && m.url != null && msg.type in setOf(MessageType.Image, MessageType.Video, MessageType.Gif)
        }

        /** Every logged message can be deleted from the log; system rows and call entries aren't shown as bubbles. */
        fun deletable(msg: Message): Boolean = msg.type != MessageType.System && msg.type != MessageType.CallLog
    }
}

val LocalSelection = staticCompositionLocalOf<MessageSelection?> { null }
