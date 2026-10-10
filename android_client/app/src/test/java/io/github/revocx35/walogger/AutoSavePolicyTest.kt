package io.github.revocx35.walogger

import io.github.revocx35.walogger.core.ChatKind
import io.github.revocx35.walogger.core.ChatRef
import io.github.revocx35.walogger.core.MediaFeedItem
import io.github.revocx35.walogger.core.MediaInfo
import io.github.revocx35.walogger.core.MediaStatus
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessageType
import io.github.revocx35.walogger.media.AutoSavePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AutoSavePolicyTest {
    private fun item(type: MessageType, kind: ChatKind = ChatKind.User, isStatus: Boolean = false, status: MediaStatus = MediaStatus.Downloaded, url: String? = "/api/media/7") =
        MediaFeedItem(
            ChatRef("1@c.us", "A", kind),
            Message(id = "m", chatId = "1@c.us", type = type, isStatus = isStatus, media = MediaInfo(status = status, url = url, mime = "image/jpeg")),
        )

    @Test
    fun savesPhotosOnlyByDefault() {
        assertTrue(AutoSavePolicy.wants(item(MessageType.Image), videos = false, status = false))
        assertTrue(AutoSavePolicy.wants(item(MessageType.Image, ChatKind.Group), videos = false, status = false))
        for (t in listOf(MessageType.Video, MessageType.Gif, MessageType.Sticker, MessageType.Document, MessageType.Ptt, MessageType.Audio)) {
            assertFalse(t.name, AutoSavePolicy.wants(item(t), videos = false, status = false))
        }
        assertTrue(AutoSavePolicy.wants(item(MessageType.Video), videos = true, status = false))
        assertTrue(AutoSavePolicy.wants(item(MessageType.Gif), videos = true, status = false))
        assertFalse(AutoSavePolicy.wants(item(MessageType.Sticker), videos = true, status = true))
    }

    @Test
    fun skipsStatusUnlessAskedAndAnythingNotDownloaded() {
        assertFalse(AutoSavePolicy.wants(item(MessageType.Image, ChatKind.Status), videos = false, status = false))
        assertFalse(AutoSavePolicy.wants(item(MessageType.Image, isStatus = true), videos = false, status = false))
        assertTrue(AutoSavePolicy.wants(item(MessageType.Image, ChatKind.Status, isStatus = true), videos = false, status = true))
        assertFalse(AutoSavePolicy.wants(item(MessageType.Image, status = MediaStatus.Failed), videos = true, status = true))
        assertFalse(AutoSavePolicy.wants(item(MessageType.Image, url = null), videos = true, status = true))
    }

    @Test
    fun cursorIsTheMediaId() {
        assertEquals("7", AutoSavePolicy.cursorOf(item(MessageType.Image)))
        assertNull(AutoSavePolicy.cursorOf(item(MessageType.Image, url = "/api/media/x")))
        assertNull(AutoSavePolicy.cursorOf(item(MessageType.Image, url = null)))
    }
}
