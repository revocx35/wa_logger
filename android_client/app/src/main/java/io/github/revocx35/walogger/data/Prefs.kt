package io.github.revocx35.walogger.data

import android.content.Context
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Non-secret app settings: the server address, whether plain HTTP was explicitly allowed for it,
 * certificates the owner chose to trust for it, the screenshot protection switch and the auto-save settings.
 * (The session cookie is a secret and lives in [SecureCookieJar] instead.)
 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("wal_prefs", Context.MODE_PRIVATE)

    private val _secureScreen = MutableStateFlow(sp.getBoolean(KEY_SECURE_SCREEN, true))
    /** FLAG_SECURE: no screenshots, screen recording or previews in the app switcher. On by default. */
    val secureScreen: StateFlow<Boolean> = _secureScreen.asStateFlow()

    var serverUrl: String?
        get() = sp.getString(KEY_SERVER, null)
        set(v) = sp.edit().putString(KEY_SERVER, v).apply()

    var allowHttp: Boolean
        get() = sp.getBoolean(KEY_ALLOW_HTTP, false)
        set(v) = sp.edit().putBoolean(KEY_ALLOW_HTTP, v).apply()

    fun setSecureScreen(on: Boolean) {
        sp.edit().putBoolean(KEY_SECURE_SCREEN, on).apply()
        _secureScreen.value = on
    }

    /** DER-encoded certificates trusted (in addition to Android's) for the configured server only. */
    var trustedCerts: List<ByteArray>
        get() = sp.getStringSet(KEY_CERTS, emptySet())!!.mapNotNull { runCatching { Base64.decode(it, Base64.NO_WRAP) }.getOrNull() }
        set(v) = sp.edit().putStringSet(KEY_CERTS, v.map { Base64.encodeToString(it, Base64.NO_WRAP) }.toSet()).apply()

    /* "Save new photos to this phone" (media/AutoSave.kt) */
    var autoSave: Boolean
        get() = sp.getBoolean(KEY_AUTOSAVE, false)
        set(v) = sp.edit().putBoolean(KEY_AUTOSAVE, v).apply()
    var autoSaveVideos: Boolean
        get() = sp.getBoolean(KEY_AUTOSAVE_VIDEOS, false)
        set(v) = sp.edit().putBoolean(KEY_AUTOSAVE_VIDEOS, v).apply()
    var autoSaveStatus: Boolean
        get() = sp.getBoolean(KEY_AUTOSAVE_STATUS, false)
        set(v) = sp.edit().putBoolean(KEY_AUTOSAVE_STATUS, v).apply()
    var autoSaveOnlyDisappearing: Boolean
        get() = sp.getBoolean(KEY_AUTOSAVE_ONLY_DISAPPEARING, false)
        set(v) = sp.edit().putBoolean(KEY_AUTOSAVE_ONLY_DISAPPEARING, v).apply()
    var autoSaveCount: Int
        get() = sp.getInt(KEY_AUTOSAVE_COUNT, 0)
        set(v) = sp.edit().putInt(KEY_AUTOSAVE_COUNT, v).apply()
    var autoSaveLastRun: Long
        get() = sp.getLong(KEY_AUTOSAVE_LAST_RUN, 0)
        set(v) = sp.edit().putLong(KEY_AUTOSAVE_LAST_RUN, v).apply()
    var autoSaveError: String?
        get() = sp.getString(KEY_AUTOSAVE_ERROR, null)
        set(v) = sp.edit().putString(KEY_AUTOSAVE_ERROR, v).apply()

    /** The media-feed position, valid only for the server it was taken from. */
    fun autoSaveCursor(server: String): String? =
        if (sp.getString(KEY_AUTOSAVE_SERVER, null) == server) sp.getString(KEY_AUTOSAVE_CURSOR, null) else null

    fun setAutoSaveCursor(server: String?, cursor: String?) {
        sp.edit().putString(KEY_AUTOSAVE_SERVER, server).putString(KEY_AUTOSAVE_CURSOR, cursor).apply()
    }

    fun clearServer() {
        sp.edit().remove(KEY_SERVER).remove(KEY_ALLOW_HTTP).remove(KEY_CERTS).apply()
    }

    private companion object {
        const val KEY_SERVER = "server_url"
        const val KEY_ALLOW_HTTP = "allow_http"
        const val KEY_CERTS = "trusted_certs"
        const val KEY_SECURE_SCREEN = "secure_screen"
        const val KEY_AUTOSAVE = "autosave"
        const val KEY_AUTOSAVE_VIDEOS = "autosave_videos"
        const val KEY_AUTOSAVE_STATUS = "autosave_status"
        const val KEY_AUTOSAVE_ONLY_DISAPPEARING = "autosave_only_disappearing"
        const val KEY_AUTOSAVE_COUNT = "autosave_count"
        const val KEY_AUTOSAVE_LAST_RUN = "autosave_last_run"
        const val KEY_AUTOSAVE_ERROR = "autosave_error"
        const val KEY_AUTOSAVE_SERVER = "autosave_server"
        const val KEY_AUTOSAVE_CURSOR = "autosave_cursor"
    }
}
