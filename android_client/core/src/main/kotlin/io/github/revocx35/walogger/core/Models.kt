package io.github.revocx35.walogger.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/*
 * Kotlin mirror of the server↔client contract in `shared/api.d.ts`. Keep both in sync.
 * Timestamps are Unix epoch milliseconds. Unknown enum values fall back to a default
 * (see [WaJson]) so a newer server never crashes an older app.
 */

val WaJson: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = false
}

@Serializable
data class ApiErrorBody(val error: ApiErrorDetail? = null)

@Serializable
data class ApiErrorDetail(val code: String = "http_error", val message: String = "", val retryAfter: Int? = null)

/* ------------------------------------------------------------------ state */

@Serializable
enum class WaState {
    @SerialName("idle") Idle,
    @SerialName("starting") Starting,
    @SerialName("qr") Qr,
    @SerialName("authenticating") Authenticating,
    @SerialName("syncing") Syncing,
    @SerialName("ready") Ready,
    @SerialName("disconnected") Disconnected,
    @SerialName("error") Error,
}

@Serializable
data class WaMe(val id: String, val name: String? = null, val phone: String? = null)

@Serializable
data class SyncProgress(val phase: String = "history", val chatsDone: Int = 0, val chatsTotal: Int = 0)

@Serializable
data class WaStatus(
    val state: WaState = WaState.Idle,
    val detail: String? = null,
    val me: WaMe? = null,
    val sync: SyncProgress? = null,
    val mediaQueue: Int = 0,
    val since: Long = 0,
)

@Serializable
data class AppState(
    val hasOwner: Boolean = false,
    val authenticated: Boolean = false,
    val onboardingComplete: Boolean = false,
    val csrfToken: String? = null,
    val username: String? = null,
    val totpEnabled: Boolean? = null,
    val wa: WaStatus? = null,
)

/* -------------------------------------------------------------------- auth */

@Serializable data class SignupRequest(val setupToken: String, val username: String, val password: String)
@Serializable data class SignupResponse(val recoveryKey: String)
@Serializable data class LoginRequest(val username: String, val password: String, val totp: String? = null)
@Serializable data class LoginResponse(val ok: Boolean = false, val needTotp: Boolean? = null)
@Serializable data class RecoverRequest(val username: String, val recoveryKey: String, val newPassword: String)
@Serializable data class RecoverResponse(val recoveryKey: String)
@Serializable data class ChangePasswordRequest(val currentPassword: String, val newPassword: String)

@Serializable
data class SessionInfo(
    val id: String,
    val current: Boolean = false,
    val createdAt: Long = 0,
    val lastSeenAt: Long = 0,
    val expiresAt: Long = 0,
    val ip: String? = null,
    val userAgent: String? = null,
)

@Serializable data class TotpSetupResponse(val secret: String, val otpauthUrl: String)
@Serializable data class TotpEnableRequest(val code: String, val password: String)
@Serializable data class TotpDisableRequest(val password: String, val code: String)
@Serializable data class RotateRecoveryKeyRequest(val password: String, val totp: String? = null)
@Serializable data class RotateRecoveryKeyResponse(val recoveryKey: String)
@Serializable data class VncCredentials(val password: String)
@Serializable data class OkResponse(val ok: Boolean = true)
@Serializable data class ForceRequest(val force: Boolean? = null)

/* -------------------------------------------------------------- chats etc. */

@Serializable
enum class ChatKind {
    @SerialName("user") User,
    @SerialName("group") Group,
    @SerialName("broadcast") Broadcast,
    @SerialName("status") Status,
    @SerialName("newsletter") Newsletter,
}

@Serializable
data class ChatSummary(
    val id: String,
    val kind: ChatKind = ChatKind.User,
    val name: String = "",
    val avatarUrl: String? = null,
    val lastTs: Long? = null,
    val lastMessage: MessagePreview? = null,
    val archived: Boolean = false,
    val pinned: Boolean = false,
    val muted: Boolean = false,
    val removed: Boolean = false,
    val messageCount: Int = 0,
    val deletedCount: Int = 0,
)

@Serializable
data class MessagePreview(
    val id: String,
    val type: MessageType = MessageType.Unknown,
    val fromMe: Boolean = false,
    val senderName: String? = null,
    val text: String? = null,
    val deleted: Boolean = false,
    val ts: Long = 0,
)

@Serializable
enum class MessageType {
    @SerialName("chat") Chat,
    @SerialName("image") Image,
    @SerialName("video") Video,
    @SerialName("gif") Gif,
    @SerialName("audio") Audio,
    @SerialName("ptt") Ptt,
    @SerialName("document") Document,
    @SerialName("sticker") Sticker,
    @SerialName("location") Location,
    @SerialName("live_location") LiveLocation,
    @SerialName("vcard") Vcard,
    @SerialName("multi_vcard") MultiVcard,
    @SerialName("poll") Poll,
    @SerialName("call_log") CallLog,
    @SerialName("system") System,
    @SerialName("revoked") Revoked,
    @SerialName("ciphertext") Ciphertext,
    @SerialName("view_once") ViewOnce,
    @SerialName("unknown") Unknown,
}

@Serializable
enum class MediaStatus {
    @SerialName("none") None,
    @SerialName("pending") Pending,
    @SerialName("downloaded") Downloaded,
    @SerialName("failed") Failed,
    @SerialName("too_large") TooLarge,
    @SerialName("skipped") Skipped,
    @SerialName("view_once") ViewOnce,
    @SerialName("unavailable") Unavailable,
}

@Serializable
data class MediaInfo(
    val status: MediaStatus = MediaStatus.None,
    val url: String? = null,
    val mime: String? = null,
    val filename: String? = null,
    val size: Long? = null,
    val width: Int? = null,
    val height: Int? = null,
    val durationSec: Double? = null,
    val thumbDataUrl: String? = null,
)

@Serializable
data class QuotedSnapshot(
    val id: String? = null,
    val senderName: String? = null,
    val fromMe: Boolean = false,
    val type: MessageType = MessageType.Unknown,
    val text: String? = null,
)

@Serializable data class Reaction(val senderId: String, val senderName: String? = null, val emoji: String, val ts: Long = 0)

@Serializable
data class LocationInfo(
    val latitude: Double,
    val longitude: Double,
    val name: String? = null,
    val address: String? = null,
    val url: String? = null,
)

@Serializable data class VcardInfo(val displayName: String? = null, val vcard: String = "")
@Serializable data class PollOption(val name: String, val votes: Int? = null)
@Serializable data class PollInfo(val question: String = "", val options: List<PollOption> = emptyList(), val multiSelect: Boolean = false)
@Serializable data class CallLogInfo(val video: Boolean = false, val outcome: String? = null, val durationSec: Double? = null)
@Serializable data class Mention(val id: String, val name: String? = null)

@Serializable
data class Message(
    val id: String,
    val chatId: String,
    val senderId: String? = null,
    val senderName: String? = null,
    val fromMe: Boolean = false,
    val ts: Long = 0,
    val type: MessageType = MessageType.Unknown,
    val text: String? = null,
    val media: MediaInfo? = null,
    val quoted: QuotedSnapshot? = null,
    val location: LocationInfo? = null,
    val vcards: List<VcardInfo>? = null,
    val poll: PollInfo? = null,
    val call: CallLogInfo? = null,
    val mentions: List<Mention> = emptyList(),
    val forwarded: Boolean = false,
    val isStatus: Boolean = false,
    val ack: Int? = null,
    val reactions: List<Reaction> = emptyList(),
    val edited: Boolean = false,
    val editedAt: Long? = null,
    val editCount: Int = 0,
    val deletedAt: Long? = null,
    val deletedBy: String? = null,
    val deletedForMeAt: Long? = null,
    val source: String = "live",
    val capturedAt: Long = 0,
)

@Serializable
data class MessagePage(val messages: List<Message> = emptyList(), val nextBefore: String? = null, val nextAfter: String? = null)

@Serializable data class MessageEdit(val body: String? = null, val capturedAt: Long = 0)

@Serializable data class ChatRef(val id: String, val name: String = "", val kind: ChatKind = ChatKind.User)
@Serializable data class DeletedFeedItem(val chat: ChatRef, val message: Message)
@Serializable data class DeletedFeedPage(val items: List<DeletedFeedItem> = emptyList(), val nextBefore: String? = null)
@Serializable data class SearchHit(val chat: ChatRef, val message: Message)
@Serializable data class SearchResponse(val hits: List<SearchHit> = emptyList(), val truncated: Boolean = false)

/* ------------------------------------------------------------------ events */

@Serializable
sealed class ServerEvent {
    @Serializable @SerialName("wa_state")
    data class WaStateChanged(val status: WaStatus) : ServerEvent()

    @Serializable @SerialName("message")
    data class NewMessage(val chatId: String, val messageId: String) : ServerEvent()

    @Serializable @SerialName("message_update")
    data class MessageUpdate(val chatId: String, val messageId: String, val reason: String = "") : ServerEvent()

    @Serializable @SerialName("chat_update")
    data class ChatUpdate(val chatId: String) : ServerEvent()

    @Serializable @SerialName("sync_progress")
    data class SyncProgressChanged(val sync: SyncProgress? = null) : ServerEvent()

    @Serializable @SerialName("session_revoked")
    data object SessionRevoked : ServerEvent()
}

/* ---------------------------------------------------------------- settings */

@Serializable
data class Settings(
    val logStatus: Boolean = true,
    val downloadHistoryMedia: Boolean = true,
    val mediaMaxMb: Int = 100,
    val historyPerChat: Int = 200,
)

@Serializable
data class SettingsPatch(
    val logStatus: Boolean? = null,
    val downloadHistoryMedia: Boolean? = null,
    val mediaMaxMb: Int? = null,
    val historyPerChat: Int? = null,
)

@Serializable data class AuditEntry(val id: Long, val ts: Long = 0, val event: String = "", val ip: String? = null, val detail: String? = null)
@Serializable data class WipeRequest(val password: String, val totp: String? = null)
