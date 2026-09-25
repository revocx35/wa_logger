package io.github.revocx35.walogger.data

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import io.github.revocx35.walogger.BuildConfig
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Local crash and "app not responding" reports, so the owner can copy one and send it to whoever
 * fixes the app. Nothing is uploaded anywhere. Reports hold only technical data: stack frames,
 * exception types and sanitized messages (JSON snippets are cut off, so no message content).
 */
class Diagnostics(private val context: Context) {
    private val dir = File(context.filesDir, "diagnostics").apply { mkdirs() }
    private val prefs = context.getSharedPreferences("wal_diagnostics", Context.MODE_PRIVATE)

    fun install() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { write("crash", "Crash on thread \"${thread.name}\"\n\n" + describe(error)) }
            previous?.uncaughtException(thread, error)
        }
        runCatching { collectAnrs() }
    }

    /** A failure that was caught (the app kept running) but should not have happened. */
    fun recordNonFatal(where: String, error: Throwable) {
        runCatching { write("error", "Handled error in $where\n\n" + describe(error)) }
    }

    /** Reports written since the owner last looked at them, newest first (null if none). */
    fun unseen(): String? {
        val seen = prefs.getLong("seen", 0L)
        val files = reports().filter { it.lastModified() > seen && !it.name.startsWith("error") }
        return if (files.isEmpty()) null else files.joinToString("\n\n") { it.readText() }
    }

    fun all(): String? = reports().takeIf { it.isNotEmpty() }?.joinToString("\n\n") { it.readText() }

    fun markSeen() = prefs.edit().putLong("seen", System.currentTimeMillis()).apply()

    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
        markSeen()
    }

    private fun reports(): List<File> = (dir.listFiles()?.toList() ?: emptyList()).sortedByDescending { it.lastModified() }

    private fun header(kind: String): String {
        val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.US).format(Date())
        return "=== wa_logger ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}, ${BuildConfig.BUILD_TYPE}) · $kind · $time\n" +
            "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) · ${Build.MANUFACTURER} ${Build.MODEL}\n"
    }

    private fun write(kind: String, body: String) {
        val text = header(kind) + body.take(20_000)
        File(dir, "$kind-${System.currentTimeMillis()}.txt").writeText(text)
        // Keep only the latest few reports.
        reports().drop(8).forEach { it.delete() }
    }

    /** Android keeps the main-thread stack of recent ANRs; pick up new ones at startup. */
    private fun collectAnrs() {
        if (Build.VERSION.SDK_INT < 30) return
        val am = context.getSystemService(ActivityManager::class.java) ?: return
        val last = prefs.getLong("anrTs", 0L)
        val infos = am.getHistoricalProcessExitReasons(context.packageName, 0, 5)
        var newest = last
        for (info in infos) {
            if (info.timestamp <= last) continue
            newest = maxOf(newest, info.timestamp)
            if (info.reason != ApplicationExitInfo.REASON_ANR) continue
            val trace = runCatching { info.traceInputStream?.bufferedReader()?.use { it.readText() } }.getOrNull()
            write("anr", "App not responding (${info.description ?: "no description"})\n\n" + (trace?.let(::mainThread) ?: "(no trace available)"))
        }
        prefs.edit().putLong("anrTs", newest).apply()
    }

    private fun mainThread(trace: String): String {
        val lines = trace.lines()
        val start = lines.indexOfFirst { it.startsWith("\"main\"") }
        if (start < 0) return lines.take(60).joinToString("\n")
        val out = ArrayList<String>()
        for (i in start until lines.size) {
            if (i > start && lines[i].isBlank()) break
            out.add(lines[i])
            if (out.size > 80) break
        }
        return out.joinToString("\n")
    }

    companion object {
        /** Exception chain with frames; messages are shortened and JSON input excerpts removed. */
        fun describe(error: Throwable): String = buildString {
            var e: Throwable? = error
            var depth = 0
            while (e != null && depth < 4) {
                if (depth > 0) append("Caused by: ")
                append(e.javaClass.name)
                sanitize(e.message)?.let { append(": ").append(it) }
                append('\n')
                for (f in e.stackTrace.take(if (depth == 0) 40 else 15)) append("    at ").append(f).append('\n')
                e = e.cause
                depth++
            }
        }

        private fun sanitize(message: String?): String? {
            if (message.isNullOrBlank()) return null
            return message.substringBefore("JSON input:").substringBefore("\n").trim().take(300)
        }
    }
}
