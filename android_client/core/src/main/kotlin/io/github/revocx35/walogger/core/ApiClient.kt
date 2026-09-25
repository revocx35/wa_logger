package io.github.revocx35.walogger.core

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.serializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
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
            return try {
                WaJson.decodeFromString(out, text.ifEmpty { "null" })
            } catch (e: Exception) {
                throw ApiException(res.code, ApiException.NOT_WA_LOGGER, "Unexpected response from the server. Is this a wa_logger server?", cause = e)
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
        if (obj["hasOwner"] !is kotlinx.serialization.json.JsonPrimitive || obj["authenticated"] !is kotlinx.serialization.json.JsonPrimitive) {
            throw ApiException(200, ApiException.NOT_WA_LOGGER, "Unexpected response from the server. Is this a wa_logger server?")
        }
        return WaJson.decodeFromJsonElement(AppState.serializer(), obj)
    }

    suspend fun signup(setupToken: String, username: String, password: String): SignupResponse =
        send("POST", "/api/auth/signup", SignupRequest(setupToken, username, password))

    suspend fun login(username: String, password: String, totp: String?): LoginResponse =
        send("POST", "/api/auth/login", LoginRequest(username, password, totp?.takeIf { it.isNotEmpty() }))

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

    suspend fun search(q: String, chatId: String? = null): SearchResponse =
        get("/api/search?q=${enc(q)}" + (chatId?.let { "&chatId=${enc(it)}" } ?: ""))

    suspend fun settings(): Settings = get("/api/settings")
    suspend fun updateSettings(patch: SettingsPatch): Settings = send("PUT", "/api/settings", patch)
    suspend fun audit(before: Long? = null): List<AuditEntry> =
        request("GET", "/api/audit?limit=100" + (before?.let { "&before=$it" } ?: ""), null, null, ListSerializer(AuditEntry.serializer()))
    suspend fun wipe(password: String, totp: String?): OkResponse =
        send("POST", "/api/data/wipe", WipeRequest(password, totp?.takeIf { it.isNotEmpty() }))
}
