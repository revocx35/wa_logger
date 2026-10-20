package io.github.revocx35.walogger.data

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.net.toUri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import io.github.revocx35.walogger.MainActivity
import io.github.revocx35.walogger.core.Authentik
import io.github.revocx35.walogger.core.AuthentikPending
import io.github.revocx35.walogger.core.AuthentikTokenStore
import io.github.revocx35.walogger.core.AuthentikTokens
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The authentik sign-in (refresh + access token), written to disk only encrypted with a non-exportable
 * AES-256-GCM key in the Android Keystore, like [SecureCookieJar]. Never throws.
 */
class KeystoreAuthentikStore(context: Context) : AuthentikTokenStore {
    private val file = File(context.noBackupFilesDir, "authentik.bin")

    override fun load(): AuthentikTokens? = runCatching {
        if (!file.exists()) return null
        val data = file.readBytes()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data, 0, 12))
        AuthentikTokens.fromJson(String(cipher.doFinal(data, 12, data.size - 12)))
    }.getOrElse { file.delete(); null }

    override fun save(tokens: AuthentikTokens?) {
        runCatching {
            if (tokens == null) {
                file.delete()
                return
            }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val tmp = File(file.parentFile, "authentik.bin.tmp")
            tmp.writeBytes(cipher.iv + cipher.doFinal(tokens.toJson().toByteArray()))
            tmp.renameTo(file)
        }.onFailure { file.delete() }
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private companion object {
        const val ALIAS = "wal_authentik"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}

/**
 * The browser half of the authentik sign-in: opens authentik's login (a Custom Tab when the browser supports
 * it), waits for authentik to send the browser back to `<applicationId>:/authentik`, which
 * [AuthentikRedirectActivity] hands to [deliver].
 */
object AuthentikSignIn {
    /** The public OAuth client the owner creates in authentik for this app (README "authentik"). */
    const val DEFAULT_CLIENT_ID = "walogger-android"

    private var waiting: CompletableDeferred<Uri>? = null

    fun redirectUri(context: Context): String = "${context.packageName}:/authentik"

    /**
     * Runs the whole sign-in for [site]; [location] is where the server redirected to (from the
     * `AuthentikRequiredException`). Throws an IOException with a user-facing message on failure.
     */
    suspend fun signIn(context: Context, authentik: Authentik, client: OkHttpClient, site: HttpUrl, location: HttpUrl?, clientId: String) {
        val authBase = withContext(Dispatchers.IO) { Authentik.discover(client, site, location) }
        val pending: AuthentikPending = authentik.begin(site, authBase, clientId.trim().ifEmpty { DEFAULT_CLIENT_ID }, redirectUri(context))
        val result = CompletableDeferred<Uri>()
        synchronized(this) {
            waiting?.cancel()
            waiting = result
        }
        open(context, pending.authorizeUrl.toString())
        val uri = try {
            result.await()
        } finally {
            synchronized(this) { if (waiting === result) waiting = null }
        }
        // Only the query (code, state or error) matters; give it an http(s) shape for OkHttp's parser.
        val redirect = "https://callback.invalid/?${uri.encodedQuery ?: ""}".toHttpUrl()
        withContext(Dispatchers.IO) { authentik.complete(pending, redirect) }
    }

    /** Stops waiting (the owner closed the browser without finishing). */
    fun cancel() {
        synchronized(this) { waiting?.cancel(); waiting = null }
    }

    fun deliver(uri: Uri): Boolean = synchronized(this) {
        val w = waiting ?: return false
        w.complete(uri)
        true
    }

    private fun open(context: Context, url: String) {
        val intent = Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE)
        // The Custom Tabs request is only this extra (androidx.browser's CustomTabsIntent does the same).
        intent.putExtras(Bundle().apply { putBinder("android.support.customtabs.extra.SESSION", null) })
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}

/** Receives `<applicationId>:/authentik?code=…&state=…` from the browser and returns to the app. */
class AuthentikRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent?.data
        if (uri != null && uri.scheme == packageName && uri.path == "/authentik") AuthentikSignIn.deliver(uri)
        // MainActivity is singleTask: this also closes the Custom Tab above it.
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }
}
