package io.github.revocx35.walogger

import android.app.Application
import io.github.revocx35.walogger.data.AppGraph
import io.github.revocx35.walogger.data.Diagnostics
import io.github.revocx35.walogger.media.MediaOps

class WaLoggerApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        val diagnostics = Diagnostics(this).also { it.install() }
        MediaOps.cleanup(this)
        graph = AppGraph(this, diagnostics)
    }
}
