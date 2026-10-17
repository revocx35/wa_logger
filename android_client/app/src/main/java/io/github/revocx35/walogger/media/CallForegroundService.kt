package io.github.revocx35.walogger.media

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.github.revocx35.walogger.MainActivity
import io.github.revocx35.walogger.R
import io.github.revocx35.walogger.WaLoggerApp

/**
 * Keeps a call going while the app is in the background: Android stops microphone access for background apps
 * unless a foreground service of type "microphone" runs. Shows an ongoing notification with "Hang up". The audio
 * itself lives in [CallAudioEngine]; this service only holds the process in the foreground.
 */
class CallForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_HANGUP) {
            (application as WaLoggerApp).graph.controller.session.value?.calls?.hangup()
            return START_NOT_STICKY
        }
        val name = intent?.getStringExtra(EXTRA_NAME)
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification(name),
                if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
            )
        } catch (_: Exception) {
            // Not allowed right now (e.g. started from the background): the call still works while the app is open.
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun notification(name: String?): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Ongoing calls", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        val hangup = PendingIntent.getService(this, 1, Intent(this, CallForegroundService::class.java).setAction(ACTION_HANGUP), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle(name ?: "WhatsApp call")
            .setContentText("Call in progress")
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(open)
            .addAction(0, "Hang up", hangup)
            // The name is a contact: hide it on the lock screen.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_call).setContentTitle("Call in progress").build())
            .build()
    }

    companion object {
        private const val CHANNEL = "calls"
        private const val NOTIFICATION_ID = 41
        private const val ACTION_HANGUP = "io.github.revocx35.walogger.HANGUP"
        private const val EXTRA_NAME = "name"

        fun start(context: Context, name: String?) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, CallForegroundService::class.java).putExtra(EXTRA_NAME, name)) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, CallForegroundService::class.java)) }
        }
    }
}
