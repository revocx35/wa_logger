package io.github.revocx35.walogger

import io.github.revocx35.walogger.core.MediaInfo
import io.github.revocx35.walogger.core.MediaStatus
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageType
import io.github.revocx35.walogger.ui.MessageSelection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageSelectionTest {
    private fun m(id: String, type: MessageType, ts: Long, status: MediaStatus = MediaStatus.Downloaded) =
        Message(id = id, chatId = "1@c.us", type = type, ts = ts, media = MediaInfo(status = status, url = "/api/media/$id"))

    @Test
    fun onlyDownloadedPhotosAndVideosCanBeSelected() {
        val s = MessageSelection()
        val photo = m("1", MessageType.Image, 30)
        val video = m("2", MessageType.Video, 10)
        s.toggle(m("3", MessageType.Sticker, 1))
        s.toggle(m("4", MessageType.Document, 1))
        s.toggle(m("5", MessageType.Image, 1, MediaStatus.Pending))
        s.toggle(Message(id = "6", chatId = "1@c.us", type = MessageType.Chat))
        assertFalse(s.active)
        s.toggle(photo)
        s.toggle(video)
        assertTrue(s.active)
        assertEquals(listOf("2", "1"), s.messages.map { it.id }) // chat order (oldest first)
        s.toggle(photo)
        assertEquals(1, s.count)
        assertFalse(s.isSelected("1"))
    }

    @Test
    fun selectAllTakesEverySavableItemAndClearEnds() {
        val s = MessageSelection()
        s.selectAll(listOf(m("1", MessageType.Image, 1), m("2", MessageType.Gif, 2), m("3", MessageType.Ptt, 3), m("4", MessageType.Video, 4, MediaStatus.Failed)))
        assertEquals(setOf("1", "2"), s.messages.map { it.id }.toSet())
        s.clear()
        assertFalse(s.active)
    }
}
