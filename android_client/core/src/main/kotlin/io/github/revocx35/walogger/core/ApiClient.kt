package io.github.revocx35.walogger.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.serializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** An API failure, mirroring the web client's `ApiError` (message is safe to show to the user). */
class ApiException(
    val status: Int,
    val code: String,
    override val message: String,
    val retryAfter: Int? = null,
    cause: Throwable? = null,
) : IOException(message, cause) {
    /** Text for the UI, like the web client's `errorMessage()`. */
    val userMessage: String get() = if (retryAfter != null && retryAfter > 0) "$message (retry in ${retryAfter}s)" else message

    companion object {
        const val NETWORK = "network"
        const val TLS_UNTRUSTED = "tls_untrusted"
        const val TLS = "tls"
        const val REDIRECT = "redirect"
        /** The server sits behind authentik and the app has no valid authentik sign-in ([cause] is [AuthentikRequiredException]). */
        const val AUTHENTIK = "authentik"
        const val NOT_WA_LOGGER = "not_wa_logger"
    }
}

/** UI text for any error thrown by the API layer. */
fun Throwable.userMessage(): String = (this as? ApiException)?.userMessage ?: "Something went wrong."

/**
 * The server's origin as a browser would send it (`scheme://host[:port]`). The server accepts
 * state-changing requests and WebSocket upgrades only with a matching `Origin` header.
 */
fun HttpUrl.originString(): String {
    val defaultPort = HttpUrl.defaultPort(scheme)
    val host = if (host.contains(':')) "[$host]" else host
    return if (port == defaultPort) "$scheme://$host" else "$scheme://$host:$port"
}

/**
 * Normalizes what the user typed as the server address into the site root URL, or null when it is
 * not a usable http(s) URL. A missing scheme means https. wa_logger is always served from `/`.
 */
fun parseServerUrl(input: String): HttpUrl? {
    val raw = input.trim()
    if (raw.isEmpty() || raw.any { it.isWhitespace() }) return null
    val withScheme = if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://").containsMatchIn(raw)) raw else "https://$raw"
    val url = withScheme.toHttpUrlOrNull() ?: return null
    if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
    return url.newBuilder().encodedPath("/").query(null).fragment(null).build()
}

/** Private / local addresses, where plain HTTP on a home network is an accepted setup. */
fun isLocalHost(host: String): Boolean {
    val h = host.lowercase().trim('[', ']')
    if (h == "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa") || h.endsWith(".internal")) return true
    val v4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").matchEntire(h)
    if (v4 != null) {
        val (a, b) = v4.destructured.let { it.component1().toInt() to it.component2().toInt() }
        return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 100 && b in 64..127) || (a == 169 && b == 254)
    }
    if (h.contains(':')) return h == "::1" || h.startsWith("fd") || h.startsWith("fc") || h.startsWith("fe80")
    return false
}

private val JSON_TYPE = "application/json".toMediaType()

suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { runCatching { cancel() } }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, _, _ -> response.close() }
        }
    })
}

/** Maps transport failures to user-facing [ApiException]s. */
fun mapTransportError(e: Throwable): ApiException = when {
    e is ApiException -> e
    e is AuthentikRequiredException -> ApiException(0, ApiException.AUTHENTIK, e.message ?: "Sign in with authentik.", cause = e)
    e.isUntrustedCertificate() -> ApiException(0, ApiException.TLS_UNTRUSTED, "The server's certificate is not trusted.", cause = e)
    e is SSLException -> ApiException(0, ApiException.TLS, "Secure connection failed.", cause = e)
    else -> ApiException(0, ApiException.NETWORK, "Cannot reach the server. Check your connection.", cause = e)
}

private fun Throwable.isUntrustedCertificate(): Boolean {
    var t: Throwable? = this
    while (t != null) {
        if (t is CertPathValidatorException || t is CertificateException || t is SSLPeerUnverifiedException) return true
        if (t is SSLHandshakeException && t.message?.contains("Trust anchor", ignoreCase = true) == true) return true
        t = t.cause
    }
    return false
}

/**
 * HTTP client for the wa_logger API (see ARCHITECTURE.md §8). Mirrors `web/src/api/client.ts`:
 * JSON bodies, `X-CSRF-Token` on every non-GET request, and the browser-equivalent `Origin` header
 * that the server requires for state-changing requests. Redirects are never followed.
 */
class ApiClient(baseClient: OkHttpClient, val baseUrl: HttpUrl) {
    val origin: String = baseUrl.originString()

    /** Session-bound CSRF token from `GET /api/state` (memory only). */
    @Volatile var csrfToken: String? = null

    /** Called on 401 `unauthorized` (session expired or revoked). */
    @Volatile var onUnauthorized: (() -> Unit)? = null

    /** The client used for everything that talks to this server (images, video, events, VNC). */
    val http: OkHttpClient = baseClient.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .addInterceptor { chain ->
            val req = chain.request()
            // Only ever attach our headers to requests for our own server.
            if (req.url.scheme == baseUrl.scheme && req.url.host == baseUrl.host && req.url.port == baseUrl.port) {
                chain.proceed(req.newBuilder().header("Origin", origin).build())
            } else {
                chain.proceed(req)
            }
        }
        .build()

    fun url(path: String): HttpUrl = baseUrl.resolve(path) ?: throw IllegalArgumentException("bad path")

    /** Absolute URL for a server-relative media URL such as `/api/media/12`; null for anything else. */
    fun mediaUrl(relative: String?): String? {
        if (relative == null || !relative.startsWith("/api/")) return null
        return url(relative).toString()
    }

    suspend fun <T> request(method: String, path: String, body: Any?, bodySerializer: KSerializer<Any>?, out: KSerializer<T>): T {
        val builder = Request.Builder().url(url(path)).header("Accept", "application/json").header("Cache-Control", "no-store")
        if (method == "GET") {
            builder.get()
        } else {
            val json = if (body != null && bodySerializer != null) WaJson.encodeToString(bodySerializer, body) else "{}"
            builder.method(method, json.toRequestBody(JSON_TYPE))
            csrfToken?.let { builder.header("X-CSRF-Token", it) }
        }
        // Everything that touches the socket (sending, reading the body) and the JSON decoding runs on the
        // IO dispatcher: callers are usually on Android's main thread, where network reads are forbidden
        // (NetworkOnMainThreadException) and slow ones would freeze the UI.
        return withContext(Dispatchers.IO) {
            val response = try {
                http.newCall(builder.build()).await()
            } catch (e: IOException) {
                throw mapTransportError(e)
            }
            response.use { res ->
                val text = try {
                    res.body.string()
                } catch (e: IOException) {
                    throw mapTransportError(e)
                }
                if (!res.isSuccessful) {
                    if (res.isRedirect) {
                        throw ApiException(res.code, ApiException.REDIRECT, "The server redirected the request (to ${res.header("Location")?.toHttpUrlOrNull()?.originString() ?: "another address"}). Use that address instead.")
                    }
                    val err = runCatching { WaJson.decodeFromString(ApiErrorBody.serializer(), text).error }.getOrNull()
                    if (res.code == 401 && err?.code == "unauthorized") onUnauthorized?.invoke()
                    throw ApiException(res.code, err?.code ?: "http_error", err?.message?.takeIf { it.isNotBlank() } ?: "Request failed (${res.code}).", err?.retryAfter)
                }
                try {
                    WaJson.decodeFromString(out, text.ifEmpty { "null" })
                } catch (e: Exception) {
                    throw ApiException(res.code, ApiException.NOT_WA_LOGGER, "Unexpected response from the server. Is this a wa_logger server?", cause = e)
                }
            }
        }
    }

    private suspend inline fun <reified T> get(path: String): T = request("GET", path, null, null, serializer<T>())

    @Suppress("UNCHECKED_CAST")
    private suspend inline fun <reified B : Any, reified T> send(method: String, path: String, body: B?): T =
        request(method, path, body, serializer<B>() as KSerializer<Any>, serializer<T>())

    private suspend inline fun <reified T> post(path: String): T = send<ForceRequest, T>("POST", path, null)

    // URLEncoder.encode(String, Charset) needs Android 13; the charset-name overload works everywhere.
    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    /* ------------------------------------------------------------ endpoints */

    suspend fun state(): AppState = get("/api/state")

    /** `GET /api/state`, additionally checking that the answer really comes from a wa_logger server. */
    suspend fun probe(): AppState {
        val obj = request("GET", "/api/state", null, null, kotlinx.serialization.json.JsonObject.serializer())
        if (obj["hasOwner"] !is JsonPrimitive || obj["authenticated"] !is JsonPrimitive) {
            throw ApiException(200, ApiException.NOT_WA_LOGGER, "Unexpected response from the server. Is this a wa_logger server?")
        }
        return WaJson.decodeFromJsonElement(AppState.serializer(), obj)
    }

    suspend fun signup(setupToken: String, username: String, password: String): SignupResponse =
        send("POST", "/api/auth/signup", SignupRequest(setupToken, username, password))

    suspend fun login(username: String, password: String, totp: String?): LoginResponse =
        send("POST", "/api/auth/login", LoginRequest(username, password, totp?.takeIf { it.isNotEmpty() }))

    /** Finishes a sign-in with an admin-issued temporary password: the user picks their own and gets a recovery key. */
    suspend fun claim(username: String, password: String, newPassword: String, recoveryKey: String?): ClaimResponse =
        send("POST", "/api/auth/claim", ClaimRequest(username, password, newPassword, recoveryKey?.takeIf { it.isNotBlank() }))

    suspend fun logout(): OkResponse = post("/api/auth/logout")
    suspend fun logoutAll(): OkResponse = post("/api/auth/logout-all")

    suspend fun recover(username: String, recoveryKey: String, newPassword: String): RecoverResponse =
        send("POST", "/api/auth/recover", RecoverRequest(username, recoveryKey, newPassword))

    suspend fun changePassword(currentPassword: String, newPassword: String): OkResponse =
        send("POST", "/api/auth/password", ChangePasswordRequest(currentPassword, newPassword))

    suspend fun sessions(): List<SessionInfo> = get("/api/auth/sessions")
    suspend fun revokeSession(id: String): OkResponse = request("DELETE", "/api/auth/sessions/${enc(id)}", null, null, OkResponse.serializer())
    suspend fun totpSetup(): TotpSetupResponse = post("/api/auth/totp/setup")
    suspend fun totpEnable(code: String, password: String): OkResponse = send("POST", "/api/auth/totp/enable", TotpEnableRequest(code, password))
    suspend fun totpDisable(password: String, code: String): OkResponse = send("POST", "/api/auth/totp/disable", TotpDisableRequest(password, code))
    suspend fun rotateRecoveryKey(password: String, totp: String?): RotateRecoveryKeyResponse =
        send("POST", "/api/auth/recovery-key/rotate", RotateRecoveryKeyRequest(password, totp?.takeIf { it.isNotEmpty() }))

    /* ---------------------------------------------------- user management (admin) */
    // The server wants explicit JSON nulls here ("default port", "no fixed origin"), which WaJson would drop, so these bodies are built by hand.

    @Suppress("UNCHECKED_CAST")
    private suspend inline fun <reified T> sendJson(method: String, path: String, build: JsonObjectBuilder.() -> Unit): T =
        request(method, path, buildJsonObject(build), JsonObject.serializer() as KSerializer<Any>, serializer<T>())

    suspend fun adminOverview(): AdminOverview = get("/api/admin/overview")

    suspend fun adminCreateUser(username: String, password: String?, port: Int?): CreateUserResponse = sendJson("POST", "/api/admin/users") {
        put("username", JsonPrimitive(username))
        if (!password.isNullOrEmpty()) put("password", JsonPrimitive(password))
        put("port", port?.let { JsonPrimitive(it) } ?: JsonNull)
    }

    suspend fun adminSetUserPort(id: Int, port: Int?): AdminUser = sendJson("PATCH", "/api/admin/users/$id") {
        put("port", port?.let { JsonPrimitive(it) } ?: JsonNull)
    }

    suspend fun adminSetUserDisabled(id: Int, disabled: Boolean): AdminUser = sendJson("PATCH", "/api/admin/users/$id") {
        put("disabled", JsonPrimitive(disabled))
    }

    suspend fun adminResetUser(id: Int, mode: ResetMode, customPassword: String?, adminPassword: String, totp: String?): ResetUserResponse =
        sendJson("POST", "/api/admin/users/$id/reset") {
            put("mode", JsonPrimitive(if (mode == ResetMode.Wipe) "wipe" else "recovery"))
            if (!customPassword.isNullOrEmpty()) put("password", JsonPrimitive(customPassword))
            put("adminPassword", JsonPrimitive(adminPassword))
            if (!totp.isNullOrEmpty()) put("totp", JsonPrimitive(totp))
        }

    suspend fun adminDeleteUser(id: Int, adminPassword: String, totp: String?): OkResponse = sendJson("POST", "/api/admin/users/$id/delete") {
        put("adminPassword", JsonPrimitive(adminPassword))
        if (!totp.isNullOrEmpty()) put("totp", JsonPrimitive(totp))
    }

    suspend fun adminBlocking(id: Int): AdminBlocking = get("/api/admin/users/$id/blocking")

    /** Replaces the user's whole block list. */
    suspend fun adminSetBlocking(id: Int, phones: Collection<String>): BlockingSaved = sendJson("PUT", "/api/admin/users/$id/blocking") {
        put("phones", JsonArray(phones.map { JsonPrimitive(it) }))
    }

    suspend fun adminPutPort(port: Int, origin: String?): OkResponse = sendJson("PUT", "/api/admin/ports/$port") {
        put("origin", origin?.let { JsonPrimitive(it) } ?: JsonNull)
    }

    suspend fun adminDeletePort(port: Int): OkResponse = request("DELETE", "/api/admin/ports/$port", null, null, OkResponse.serializer())

    suspend fun adminAudit(limit: Int = 100): List<AdminAuditEntry> =
        request("GET", "/api/admin/audit?limit=$limit", null, null, ListSerializer(AdminAuditEntry.serializer()))

    suspend fun waStatus(): WaStatus = get("/api/wa/status")
    suspend fun waRestart(): OkResponse = post("/api/wa/restart")
    suspend fun waLogout(): OkResponse = post("/api/wa/logout")
    suspend fun completeOnboarding(force: Boolean = false): OkResponse =
        send("POST", "/api/onboarding/complete", ForceRequest(if (force) true else null))
    suspend fun vncCredentials(): VncCredentials = get("/api/vnc/credentials")

    suspend fun chats(): List<ChatSummary> = request("GET", "/api/chats", null, null, ListSerializer(ChatSummary.serializer()))

    suspend fun messages(chatId: String, before: String? = null, limit: Int = 60): MessagePage =
        get("/api/chats/${enc(chatId)}/messages?limit=$limit" + (before?.let { "&before=${enc(it)}" } ?: ""))

    suspend fun messagesAfter(chatId: String, after: String, limit: Int = 100): MessagePage =
        get("/api/chats/${enc(chatId)}/messages/after?after=${enc(after)}&limit=$limit")

    suspend fun messagesAround(chatId: String, messageId: String, limit: Int = 60): MessagePage =
        get("/api/chats/${enc(chatId)}/messages/around/${enc(messageId)}?limit=$limit")

    suspend fun message(messageId: String): Message = get("/api/messages/${enc(messageId)}")
    suspend fun edits(messageId: String): List<MessageEdit> =
        request("GET", "/api/messages/${enc(messageId)}/edits", null, null, ListSerializer(MessageEdit.serializer()))
    suspend fun retryMedia(messageId: String): OkResponse = post("/api/messages/${enc(messageId)}/media/retry")

    suspend fun deleted(before: String? = null): DeletedFeedPage =
        get("/api/deleted?limit=50" + (before?.let { "&before=${enc(it)}" } ?: ""))

    /** Media downloaded after [after] (a cursor from an earlier page); without one, only the current cursor. */
    suspend fun mediaFeed(after: String?, limit: Int = 50): MediaFeedPage =
        get("/api/media-feed?limit=$limit" + (after?.let { "&after=${enc(it)}" } ?: ""))

    suspend fun search(q: String, chatId: String? = null): SearchResponse =
        get("/api/search?q=${enc(q)}" + (chatId?.let { "&chatId=${enc(it)}" } ?: ""))

    /* -------------------------------------------------------------- sending */

    suspend fun sendText(chatId: String, text: String, quotedId: String?): SendResult =
        send("POST", "/api/chats/${enc(chatId)}/send", SendTextRequest(text, quotedId))

    /**
     * Uploads a file for [sendMedia] as a raw body (the only non-JSON request). The name goes in a header,
     * never in the URL. [body] is streamed (e.g. from a content URI) and should report its length.
     */
    suspend fun upload(body: RequestBody, filename: String?): UploadResponse {
        val builder = Request.Builder().url(url("/api/uploads")).header("Accept", "application/json").post(body)
        csrfToken?.let { builder.header("X-CSRF-Token", it) }
        body.contentType()?.let { builder.header("X-File-Type", "${it.type}/${it.subtype}") }
        filename?.let { builder.header("X-Filename", enc(it)) }
        return withContext(Dispatchers.IO) {
            val response = try {
                http.newCall(builder.build()).await()
            } catch (e: IOException) {
                throw mapTransportError(e)
            }
            response.use { res ->
                val text = try {
                    res.body.string()
                } catch (e: IOException) {
                    throw mapTransportError(e)
                }
                if (!res.isSuccessful) {
                    if (res.code == 413) throw ApiException(413, "too_large", "The file is too large (64 MB at most).")
                    val err = runCatching { WaJson.decodeFromString(ApiErrorBody.serializer(), text).error }.getOrNull()
                    if (res.code == 401 && err?.code == "unauthorized") onUnauthorized?.invoke()
                    throw ApiException(res.code, err?.code ?: "http_error", err?.message?.takeIf { it.isNotBlank() } ?: "Upload failed (${res.code}).", err?.retryAfter)
                }
                try {
                    WaJson.decodeFromString(UploadResponse.serializer(), text)
                } catch (e: Exception) {
                    throw ApiException(res.code, ApiException.NOT_WA_LOGGER, "Unexpected response from the server.", cause = e)
                }
            }
        }
    }

    suspend fun sendMedia(chatId: String, uploadId: String, kind: SendMediaKind, caption: String?, quotedId: String?): SendResult =
        send("POST", "/api/chats/${enc(chatId)}/send-media", SendMediaRequest(uploadId, kind, caption?.takeIf { it.isNotBlank() }, quotedId))

    suspend fun react(messageId: String, emoji: String): OkResponse = send("POST", "/api/messages/${enc(messageId)}/react", ReactRequest(emoji))
    suspend fun revoke(messageId: String): OkResponse = post("/api/messages/${enc(messageId)}/revoke")
    suspend fun editMessage(messageId: String, text: String): OkResponse = send("POST", "/api/messages/${enc(messageId)}/edit", EditRequest(text))
    suspend fun markRead(chatId: String): OkResponse = post("/api/chats/${enc(chatId)}/read")
    suspend fun newChat(phone: String): NewChatResponse = send("POST", "/api/chats/new", NewChatRequest(phone))

    /* ---------------------------------------------------------------- calls */

    suspend fun currentCall(): CurrentCall = get("/api/calls/current")
    suspend fun startCall(chatId: String, video: Boolean = false): CallInfo =
        send("POST", "/api/chats/${enc(chatId)}/call", CallVideoFlag(if (video) true else null))
    suspend fun acceptCall(callId: String, video: Boolean = false): CallInfo =
        send("POST", "/api/calls/${enc(callId)}/accept", CallVideoFlag(if (video) true else null))
    suspend fun setCallVideo(callId: String, on: Boolean): CallInfo = send("POST", "/api/calls/${enc(callId)}/video", CallVideoRequest(on))
    suspend fun rejectCall(callId: String): OkResponse = post("/api/calls/${enc(callId)}/reject")
    suspend fun hangupCall(callId: String): OkResponse = post("/api/calls/${enc(callId)}/hangup")

    suspend fun setCallRecording(callId: String, on: Boolean): CallInfo = send("POST", "/api/calls/${enc(callId)}/recording", CallRecordingRequest(on))
    suspend fun callRecordings(before: Int? = null): CallRecordingPage = get("/api/call-recordings?limit=30" + (before?.let { "&before=$it" } ?: ""))
    suspend fun deleteCallRecording(id: Int): OkResponse = request("DELETE", "/api/call-recordings/$id", null, null, OkResponse.serializer())

    suspend fun settings(): Settings = get("/api/settings")
    suspend fun updateSettings(patch: SettingsPatch): Settings = send("PUT", "/api/settings", patch)
    suspend fun audit(before: Long? = null): List<AuditEntry> =
        request("GET", "/api/audit?limit=100" + (before?.let { "&before=$it" } ?: ""), null, null, ListSerializer(AuditEntry.serializer()))
    suspend fun wipe(password: String, totp: String?): OkResponse =
        send("POST", "/api/data/wipe", WipeRequest(password, totp?.takeIf { it.isNotEmpty() }))
}
