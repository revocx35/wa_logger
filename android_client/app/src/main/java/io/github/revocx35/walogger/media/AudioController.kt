package io.github.revocx35.walogger.media

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Call

/** Streams (Range requests, no cache) through the authenticated server client. */
@OptIn(UnstableApi::class)
fun buildPlayer(context: Context, http: Call.Factory): ExoPlayer =
    ExoPlayer.Builder(context)
        .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(http)))
        .build()

data class AudioState(val id: String? = null, val playing: Boolean = false, val positionMs: Long = 0, val durationMs: Long = 0, val loading: Boolean = false)

/** One shared player for voice messages and audio files, so only one plays at a time. */
class AudioController(private val context: Context, private val http: Call.Factory, private val scope: CoroutineScope) {
    private var player: ExoPlayer? = null
    private var ticker: Job? = null
    private val _state = MutableStateFlow(AudioState())
    val state: StateFlow<AudioState> = _state.asStateFlow()

    private fun player(): ExoPlayer = player ?: buildPlayer(context, http).also { p ->
        player = p
        p.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) = publish()
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) {
                    p.pause()
                    p.seekTo(0)
                }
                publish()
            }
        })
    }

    private fun publish() {
        val p = player ?: return
        val d = p.duration.takeIf { it != C.TIME_UNSET } ?: 0L
        _state.value = _state.value.copy(playing = p.isPlaying, positionMs = p.currentPosition, durationMs = d, loading = p.playbackState == Player.STATE_BUFFERING)
    }

    fun toggle(id: String, url: String) {
        val p = player()
        if (_state.value.id == id) {
            if (p.isPlaying) p.pause() else p.play()
        } else {
            p.setMediaItem(MediaItem.fromUri(url))
            p.prepare()
            p.play()
            _state.value = AudioState(id = id, loading = true)
        }
        ticker?.cancel()
        ticker = scope.launch {
            while (isActive) {
                publish()
                delay(250)
            }
        }
    }

    fun seek(id: String, fraction: Float) {
        val p = player ?: return
        if (_state.value.id != id || p.duration <= 0) return
        p.seekTo((p.duration * fraction).toLong())
        publish()
    }

    fun pause() = player?.pause()

    fun release() {
        ticker?.cancel()
        player?.release()
        player = null
        _state.value = AudioState()
    }
}
