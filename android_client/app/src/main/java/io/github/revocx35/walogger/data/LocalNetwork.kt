package io.github.revocx35.walogger.data

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.core.content.ContextCompat

/**
 * Android 17 (API 37) blocks connections to private addresses (192.168.x.x, 10.x, …) for apps targeting it unless
 * the owner grants "Local network" access. Most wa_logger servers live on the home network, so the app asks for it
 * when connecting there and on the "cannot reach" screen. Older Android versions don't have the permission.
 */
object LocalNetwork {
    const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    private const val API = 37

    /** True when this Android version restricts local network access and the permission isn't granted. */
    fun missing(context: Context): Boolean =
        Build.VERSION.SDK_INT >= API && ContextCompat.checkSelfPermission(context, PERMISSION) != PackageManager.PERMISSION_GRANTED

    // Android 17 shows this permission as "Nearby devices".
    const val HELP = "wa_logger needs local network access (the \"Nearby devices\" permission) to reach a server on your " +
        "home network. Allow it, or turn it on in Android Settings → Apps → wa_logger → Permissions."
}

/** Launcher that asks for local network access; [onResult] gets whether it was granted. */
@Composable
fun rememberLocalNetworkRequest(onResult: (Boolean) -> Unit): () -> Unit {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission(), onResult)
    return { launcher.launch(LocalNetwork.PERMISSION) }
}
