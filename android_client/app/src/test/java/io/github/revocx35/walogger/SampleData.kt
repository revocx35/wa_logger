package io.github.revocx35.walogger

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.util.Base64
import io.github.revocx35.walogger.core.CallLogInfo
import io.github.revocx35.walogger.core.ChatKind
import io.github.revocx35.walogger.core.ChatRef
import io.github.revocx35.walogger.core.ChatSummary
import io.github.revocx35.walogger.core.DeletedFeedItem
import io.github.revocx35.walogger.core.LocationInfo
import io.github.revocx35.walogger.core.MediaInfo
import io.github.revocx35.walogger.core.MediaStatus
import io.github.revocx35.walogger.core.Mention
import io.github.revocx35.walogger.core.Message
import io.github.revocx35.walogger.core.MessagePreview
import io.github.revocx35.walogger.core.MessageType
import io.github.revocx35.walogger.core.PollInfo
import io.github.revocx35.walogger.core.PollOption
import io.github.revocx35.walogger.core.QuotedSnapshot
import io.github.revocx35.walogger.core.Reaction
import io.github.revocx35.walogger.core.SearchHit
import io.github.revocx35.walogger.core.VcardInfo
import io.github.revocx35.walogger.core.WaMe
import io.github.revocx35.walogger.core.WaState
import io.github.revocx35.walogger.core.WaStatus
import java.io.ByteArrayOutputStream
import java.time.LocalDateTime
import java.time.ZoneId

/** The same conversations as `server/src/testutil/seed.ts`, as API DTOs. */
object SampleData {
    const val ALI = "905551112233@c.us"
    const val ZEYNEP = "905554445566@c.us"
    const val MERT = "905557778899@c.us"
    const val GROUP = "120363025555555555@g.us"

    val zone: ZoneId = ZoneId.of("Europe/Istanbul")
    val now: Long = LocalDateTime.of(2026, 9, 25, 15, 0).atZone(zone).toInstant().toEpochMilli()
    private const val H = 3_600_000L
    private const val D = 24 * H

    private fun checker(w: Int, h: Int, color: Int): String {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val p = Paint()
        for (y in 0 until h step 16) for (x in 0 until w step 16) {
            p.color = if (((x / 16) + (y / 16)) % 2 == 0) color else (color and 0x00FFFFFF) or (0xCC shl 24)
            c.drawRect(x.toFloat(), y.toFloat(), (x + 16).toFloat(), (y + 16).toFloat(), p)
        }
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 80, out)
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    private var n = 0
    private fun m(chat: String, from: String?, ts: Long, type: MessageType = MessageType.Chat, text: String? = null, build: Message.() -> Message = { this }): Message {
        val fromMe = from == null
        val names = mapOf(ALI to "Ali Yılmaz", ZEYNEP to "Zeynep Kaya", MERT to "Mert Demir")
        return Message(
            id = "m${++n}", chatId = chat, senderId = from ?: "905550000001@c.us", senderName = from?.let { names[it] }, fromMe = fromMe,
            ts = ts, type = type, text = text, ack = if (fromMe) 3 else null, capturedAt = ts,
        ).build()
    }

    val aliChat: List<Message> by lazy {
        val t0 = now - 3 * D - 3 * H
        val q = m(ALI, null, t0 + 60_000, text = "Yes! _Looking forward to it_ — see https://example.com/plan_v2 for the plan")
        listOf(
            m(ALI, ALI, t0, text = "Hey! Are we still on for *Saturday*? 🎉"),
            q,
            m(ALI, ALI, t0 + 120_000, text = "Perfect 👍") { copy(quoted = QuotedSnapshot(q.id, null, true, MessageType.Chat, q.text)) },
            m(ALI, ALI, t0 + 180_000, text = "Actually I told Zeynep your secret 🙈 (oops)") { copy(deletedAt = t0 + 180_000, deletedBy = "sender") },
            m(ALI, ALI, now - D, text = "Meet at 8pm instead") { copy(edited = true, editCount = 1, editedAt = now - D) },
            m(ALI, ALI, now - D + 400_000, MessageType.Image, "The venue 📍") {
                copy(media = MediaInfo(MediaStatus.Downloaded, "/api/media/1", "image/png", null, 40_000, 640.0, 400.0, null, checker(160, 100, 0xFF00A884.toInt())))
            },
            m(ALI, ALI, now - D + 1_400_000, MessageType.Location) { copy(location = LocationInfo(41.0082, 28.9784, "Sultanahmet Square", "Istanbul")) },
            m(ALI, null, now - D + 2_400_000, MessageType.Ptt) { copy(media = MediaInfo(MediaStatus.Failed, null, "audio/ogg", null, 24_000, null, null, 12.0, null)) },
            m(ALI, ALI, now - H, MessageType.ViewOnce) { copy(media = MediaInfo(MediaStatus.ViewOnce)) },
            m(ALI, null, now - H / 2, text = "```\nconst plan = \"done\";\n```\n> quoted line\n- first\n- second") {
                copy(reactions = listOf(Reaction(ALI, "Ali Yılmaz", "❤️", now - H / 2)))
            },
        )
    }

    val groupChat: List<Message> by lazy {
        val g0 = now - 2 * D - 2 * H
        listOf(
            m(GROUP, MERT, g0 - 1_000_000, MessageType.System, "Mert Demir created group “Family 👨‍👩‍👧”"),
            m(GROUP, ZEYNEP, g0, text = "Who is bringing dessert? 🍰"),
            m(GROUP, MERT, g0 + 30_000, text = "Me! @905554445566 you bring drinks") { copy(mentions = listOf(Mention(ZEYNEP, "Zeynep Kaya"))) },
            m(GROUP, MERT, g0 + 60_000, MessageType.Poll, "Dinner time?") { copy(poll = PollInfo("Dinner time?", listOf(PollOption("19:00"), PollOption("20:00"), PollOption("21:00")), false)) },
            m(GROUP, ZEYNEP, g0 + 90_000, MessageType.Document) { copy(media = MediaInfo(MediaStatus.Downloaded, "/api/media/2", "text/plain", "shopping-list.txt", 17, null, null, null, null)) },
            m(GROUP, ZEYNEP, g0 + 120_000, MessageType.Vcard) { copy(vcards = listOf(VcardInfo("Baker Shop", "BEGIN:VCARD\nFN:Baker Shop\nEND:VCARD"))) },
            m(GROUP, MERT, g0 + 150_000, MessageType.Image, "Embarrassing photo") {
                copy(forwarded = true, deletedAt = g0 + 150_000, deletedBy = "admin", media = MediaInfo(MediaStatus.Downloaded, "/api/media/3", "image/png", null, 30_000, 400.0, 400.0, null, checker(100, 100, 0xFFEA0038.toInt())))
            },
            m(GROUP, null, g0 + 200_000, text = "See you all 👋"),
            m(GROUP, MERT, g0 + 240_000, MessageType.CallLog) { copy(call = CallLogInfo(video = true, outcome = "missed")) },
            m(GROUP, ZEYNEP, g0 + 260_000, MessageType.Revoked) { copy(deletedAt = g0 + 260_000, deletedBy = "sender") },
        )
    }

    val chats: List<ChatSummary> by lazy {
        listOf(
            ChatSummary(GROUP, ChatKind.Group, "Family 👨‍👩‍👧", null, now - 2 * D, MessagePreview("x", MessageType.Revoked, false, "Zeynep Kaya", "Deleted message", true, now - 2 * D), pinned = true, messageCount = 11, deletedCount = 2),
            ChatSummary(ZEYNEP, ChatKind.User, "Zeynep Kaya", null, now - 60_000, MessagePreview("y", MessageType.Sticker, false, "Zeynep Kaya", "Sticker", false, now - 60_000), messageCount = 121),
            ChatSummary(ALI, ChatKind.User, "Ali Yılmaz", null, now - H / 2, MessagePreview("z", MessageType.Chat, true, null, "```\nconst plan = \"done\";\n```\n> quoted line", false, now - H / 2), messageCount = 10, deletedCount = 1),
            ChatSummary("status@broadcast", ChatKind.Status, "Status updates", null, now - 2 * H, MessagePreview("s", MessageType.Chat, false, "Mert Demir", "At the beach 🏖️", false, now - 2 * H), messageCount = 1),
            ChatSummary("905559990000@c.us", ChatKind.User, "+90 555 999 00 00", null, now - 9 * D, MessagePreview("o", MessageType.Chat, false, null, "Your order has shipped", false, now - 9 * D), removed = true, messageCount = 3),
        )
    }

    val deleted: List<DeletedFeedItem> by lazy {
        listOf(
            DeletedFeedItem(ChatRef(GROUP, "Family 👨‍👩‍👧", ChatKind.Group), groupChat[6]),
            DeletedFeedItem(ChatRef(ALI, "Ali Yılmaz", ChatKind.User), aliChat[3]),
        )
    }

    val hits: List<SearchHit> by lazy {
        listOf(SearchHit(ChatRef(ALI, "Ali Yılmaz", ChatKind.User), aliChat[1]), SearchHit(ChatRef(ALI, "Ali Yılmaz", ChatKind.User), aliChat[3]))
    }

    val ready = WaStatus(WaState.Ready, "Connected", WaMe("905550000001@c.us", "Me", "+90 555 000 00 01"), null, 0, now)
}
