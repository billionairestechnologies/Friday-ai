package com.friday.app.ui.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.audiofx.Visualizer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.friday.app.data.api.VoiceApi
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridayStop
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The three visual/behavioral phases of voice mode, mirroring the web app's voice-mode.tsx
 * (which additionally has an "intro" voice-picker phase — that's assumed to be handled by the
 * caller before this composable is even shown, since voice selection isn't specific to the
 * full-screen voice UI itself).
 */
enum class VoicePhase { Listening, Thinking, Responding }

/**
 * Full-screen animated voice mode overlay. Reuses a single [ParticleSphere] across all three
 * phases, feeding it live microphone amplitude/FFT while [VoicePhase.Listening], an idle/ambient
 * signal while [VoicePhase.Thinking], and the TTS playback's own amplitude/FFT while
 * [VoicePhase.Responding] — matching the web app's particle-sphere.tsx + voice-mode.tsx behavior.
 *
 * ### How to mount this
 * This composable is meant to be conditionally placed into composition by the caller (e.g. inside
 * an `if (voiceModeOpen) { VoiceModeScreen(...) }`) rather than driven by an `open: Boolean`
 * parameter — entering composition starts a fresh listening session, and leaving composition (or
 * calling [onClose]) tears down all mic/playback resources.
 *
 * ### Permission contract (IMPORTANT for the caller)
 * This composable requests `RECORD_AUDIO` itself, the same way `ComposerBar.kt` already does,
 * via `rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission())`. That API
 * requires the hosting `Activity` to be a `ComponentActivity` (already true everywhere else in
 * this app that uses the same pattern) — **no extra plumbing is required from the caller**: no
 * permission result needs to be fed back in, no permission state needs to be passed in. If the
 * permission is denied, an inline error is shown ("Microphone permission is needed for voice
 * mode") instead of failing silently. `AndroidManifest.xml` already declares `RECORD_AUDIO`.
 *
 * ### Backend calls used
 * - [VoiceApi.transcribe] once the user stops/silence-triggers, to turn the recorded utterance
 *   into text before calling [onSubmitTranscript].
 * - [VoiceApi.speak] once a full reply is known (i.e. once [isReplying] transitions to `false`
 *   with non-empty [replyText]) — there is no streaming TTS on this backend, so this is called
 *   exactly once per reply, matching the web app's behavior.
 *
 * @param voiceId selected TTS voice id, nullable. Also seeds the sphere's color via
 *   [hueForVoice].
 * @param replyText current/streaming assistant reply text; empty until one exists for this turn.
 * @param isReplying true once a reply is streaming/complete for the submitted turn — together
 *   with [replyText] this drives the Thinking -> Responding transition and the TTS trigger.
 * @param onSubmitTranscript called with the final transcript once the user stops (manually or via
 *   ~1.3s silence auto-detection). The caller is expected to send this as a normal chat message
 *   and then start updating [replyText]/[isReplying] for the resulting turn.
 * @param onClose called when the user cancels/closes voice mode. The caller should stop
 *   composing this screen in response (tearing down is otherwise already handled internally).
 */
@Composable
fun VoiceModeScreen(
    voiceId: String?,
    replyText: String,
    isReplying: Boolean,
    onSubmitTranscript: (String) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var phase by remember { mutableStateOf(VoicePhase.Listening) }
    var micGranted by remember { mutableStateOf(hasRecordAudioPermission(context)) }
    var caption by remember { mutableStateOf("") }
    var errorText by remember { mutableStateOf<String?>(null) }
    var spokenForText by remember { mutableStateOf<String?>(null) }
    var autoSubmitted by remember { mutableStateOf(false) }

    val level = remember { mutableFloatStateOf(0f) }
    var bands by remember { mutableStateOf(FloatArray(0)) }
    val hue = remember(voiceId) { hueForVoice(voiceId) }

    val micController = remember {
        MicCaptureController(onLevel = { l, b -> level.floatValue = l; bands = b })
    }
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }
    var playbackAnalyzer by remember { mutableStateOf<PlaybackAnalyzer?>(null) }

    fun teardownAudio() {
        micController.cancel()
        playbackAnalyzer?.release()
        playbackAnalyzer = null
        mediaPlayer?.let { runCatching { it.stop() }; runCatching { it.release() } }
        mediaPlayer = null
        level.floatValue = 0f
        bands = FloatArray(0)
    }

    fun handleClose() {
        teardownAudio()
        onClose()
    }

    fun submitNow() {
        if (phase != VoicePhase.Listening || autoSubmitted) return
        autoSubmitted = true
        val file = micController.stop(context)
        level.floatValue = 0f
        bands = FloatArray(0)
        errorText = null
        phase = VoicePhase.Thinking
        scope.launch {
            val transcript = file?.let { VoiceApi.transcribe(it) }?.trim()
            if (transcript.isNullOrEmpty()) {
                errorText = "Didn't catch anything — try again"
                phase = VoicePhase.Listening
            } else {
                caption = transcript
                onSubmitTranscript(transcript)
            }
        }
    }

    fun interruptAndListen() {
        teardownAudio()
        errorText = null
        caption = ""
        autoSubmitted = false
        phase = VoicePhase.Listening
    }

    // Request mic permission once, on entry.
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        micGranted = granted
        if (!granted) errorText = "Microphone permission is needed for voice mode"
    }
    LaunchedEffect(Unit) {
        if (!micGranted) permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    // (Re)start the mic every time we enter Listening while permission is held.
    LaunchedEffect(phase, micGranted) {
        if (phase == VoicePhase.Listening && micGranted) {
            autoSubmitted = false
            val started = micController.start(context)
            if (!started) errorText = "Couldn't access the microphone"
        }
    }

    // Silence-triggered auto-submit: once speech has been heard, ~1.3s of quiet after it submits
    // automatically — a manual "Stop and send" tap always works too (see submitNow()).
    LaunchedEffect(phase) {
        if (phase != VoicePhase.Listening) return@LaunchedEffect
        while (true) {
            delay(120)
            val last = micController.lastSpeechAtMillis()
            if (!autoSubmitted && last > 0L && System.currentTimeMillis() - last > 1300L) {
                submitNow()
                break
            }
        }
    }

    // As soon as any reply text exists, move off "Thinking" so the caption can start showing it.
    LaunchedEffect(replyText) {
        if (replyText.isNotBlank() && phase == VoicePhase.Thinking) {
            phase = VoicePhase.Responding
        }
    }

    // Once the reply has fully finished streaming, synthesize and play it exactly once.
    LaunchedEffect(isReplying, replyText) {
        if (isReplying || replyText.isBlank() || spokenForText == replyText) return@LaunchedEffect
        spokenForText = replyText
        if (phase != VoicePhase.Responding) phase = VoicePhase.Responding
        errorText = null
        val bytes = VoiceApi.speak(replyText, voiceId.orEmpty())
        if (bytes == null || bytes.isEmpty()) {
            errorText = "Couldn't play that reply out loud — it's in the chat as text."
            return@LaunchedEffect
        }
        val file = File(context.cacheDir, "voice_mode_tts_${System.currentTimeMillis()}.audio")
        withContext(Dispatchers.IO) { runCatching { file.writeBytes(bytes) } }
        runCatching {
            val player = MediaPlayer()
            mediaPlayer = player
            player.setDataSource(file.absolutePath)
            player.setOnPreparedListener { mp ->
                val analyzer = PlaybackAnalyzer(onLevel = { l, b -> level.floatValue = l; bands = b })
                analyzer.attach(mp.audioSessionId)
                playbackAnalyzer = analyzer
                mp.start()
            }
            player.setOnCompletionListener {
                playbackAnalyzer?.release()
                playbackAnalyzer = null
                mediaPlayer?.let { runCatching { it.release() } }
                mediaPlayer = null
                level.floatValue = 0f
                bands = FloatArray(0)
                // A voice agent that hangs up after every reply isn't a conversation — loop back
                // into listening, same as the web app.
                caption = ""
                autoSubmitted = false
                phase = VoicePhase.Listening
            }
            player.setOnErrorListener { _, _, _ ->
                errorText = "Couldn't play that reply out loud — it's in the chat as text."
                true
            }
            player.prepareAsync()
        }.onFailure {
            errorText = "Couldn't play that reply out loud — it's in the chat as text."
        }
    }

    DisposableEffect(Unit) {
        onDispose { teardownAudio() }
    }

    VoiceModeContent(
        phase = phase,
        caption = caption,
        replyText = replyText,
        errorText = errorText,
        level = level.floatValue,
        bands = bands,
        hue = hue,
        onClose = ::handleClose,
        onStopAndSend = ::submitNow,
        onInterruptAndListen = ::interruptAndListen,
        onDismissError = {
            errorText = null
            caption = ""
            autoSubmitted = false
            phase = VoicePhase.Listening
        },
        modifier = modifier,
    )
}

@Composable
private fun VoiceModeContent(
    phase: VoicePhase,
    caption: String,
    replyText: String,
    errorText: String?,
    level: Float,
    bands: FloatArray,
    hue: Int,
    onClose: () -> Unit,
    onStopAndSend: () -> Unit,
    onInterruptAndListen: () -> Unit,
    onDismissError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize().background(FridayBg)) {
        Row(
            Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.End,
        ) {
            CircleButton(
                icon = Icons.Filled.Close,
                contentDescription = "Close voice mode",
                onClick = onClose,
                size = 36.dp,
            )
        }

        Column(
            Modifier.fillMaxSize().padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            val displayText = when (phase) {
                VoicePhase.Listening -> caption.ifBlank { "Say something…" }
                VoicePhase.Thinking -> "Thinking…"
                VoicePhase.Responding -> replyText.ifBlank { "Thinking…" }
            }
            Text(
                displayText,
                textAlign = TextAlign.Center,
                fontSize = 22.sp,
                color = FridayText,
                modifier = Modifier.padding(bottom = 32.dp),
            )

            val screenWidth = LocalConfiguration.current.screenWidthDp.dp
            val sphereSize = minOf(280.dp, screenWidth * 0.7f)
            Box(Modifier.size(sphereSize)) {
                ParticleSphere(
                    level = level,
                    bands = bands,
                    hue = hue,
                    active = phase != VoicePhase.Thinking,
                )
            }

            Spacer(Modifier.height(24.dp))

            if (phase == VoicePhase.Thinking && errorText == null) {
                CircularProgressIndicator(color = FridayMuted, modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            }

            errorText?.let { msg ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(msg, color = FridayStop, fontSize = 14.sp, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(10.dp))
                    Box(
                        Modifier
                            .border(1.dp, FridayMuted.copy(alpha = 0.4f), CircleShape)
                            .clickable(onClick = onDismissError)
                            .padding(horizontal = 18.dp, vertical = 8.dp),
                    ) {
                        Text("Try again", color = FridayText, fontSize = 14.sp)
                    }
                }
            }
        }

        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 40.dp),
            horizontalArrangement = Arrangement.spacedBy(24.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircleButton(
                icon = Icons.Filled.Close,
                contentDescription = "Cancel",
                onClick = onClose,
                size = 56.dp,
                borderColor = FridayMuted.copy(alpha = 0.4f),
            )
            when (phase) {
                VoicePhase.Listening -> CircleButton(
                    icon = if (level > 0.08f) Icons.Filled.Mic else Icons.Filled.MicOff,
                    contentDescription = "Stop and send",
                    onClick = onStopAndSend,
                    size = 64.dp,
                    background = FridayStop,
                    tint = FridayBg,
                )
                VoicePhase.Responding -> if (replyText.isNotBlank()) {
                    CircleButton(
                        icon = Icons.Filled.Mic,
                        contentDescription = "Interrupt and ask something new",
                        onClick = onInterruptAndListen,
                        size = 64.dp,
                        background = FridayStop,
                        tint = FridayBg,
                    )
                }
                VoicePhase.Thinking -> Unit
            }
        }
    }
}

@Composable
private fun CircleButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    size: Dp = 48.dp,
    background: Color = Color.Transparent,
    tint: Color = FridayMuted,
    borderColor: Color? = null,
) {
    Box(
        Modifier
            .size(size)
            .clip(CircleShape)
            .background(background)
            .let { if (borderColor != null) it.border(1.dp, borderColor, CircleShape) else it }
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription, tint = tint)
    }
}

private fun hasRecordAudioPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

/**
 * Captures live microphone audio via [AudioRecord] (chosen over attaching an
 * `android.media.audiofx.Visualizer` to a `MediaRecorder` session — that needs
 * `MediaRecorder.getAudioSessionId()`, only available from API 28, while this app's `minSdk` is
 * 26; `Visualizer`-on-capture-session behavior is also inconsistent across OEMs since it's really
 * designed for tapping *playback* mixes, not input). Runs a small in-house radix-2 FFT (see
 * [fft] below) over each ~32ms window to produce a coarse per-band breakdown alongside an overall
 * level, and separately accumulates the whole utterance so it can be written out as a WAV file
 * for [VoiceApi.transcribe] once the user stops.
 */
private class MicCaptureController(private val onLevel: (Float, FloatArray) -> Unit) {
    private val sampleRate = 16_000
    private val windowSize = 512 // power of two, required by the FFT
    private val bandCount = 24
    private val speechLevelThreshold = 0.08f

    private var audioRecord: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var recording = false
    private val lastSpeechAtMs = AtomicLong(0L)
    private val recordedSamples = ArrayList<Short>(sampleRate * 8)

    fun lastSpeechAtMillis(): Long = lastSpeechAtMs.get()

    @Suppress("MissingPermission")
    fun start(context: Context): Boolean {
        if (!hasRecordAudioPermission(context)) return false
        if (recording) return true
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuf <= 0) return false
        val bufSize = maxOf(minBuf, windowSize * 4)
        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufSize,
            )
        } catch (_: SecurityException) {
            return false
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            runCatching { record.release() }
            return false
        }

        synchronized(recordedSamples) { recordedSamples.clear() }
        lastSpeechAtMs.set(0L)
        audioRecord = record
        recording = true
        try {
            record.startRecording()
        } catch (_: Exception) {
            recording = false
            runCatching { record.release() }
            audioRecord = null
            return false
        }

        thread = Thread {
            val buffer = ShortArray(windowSize)
            val real = FloatArray(windowSize)
            val imag = FloatArray(windowSize)
            while (recording) {
                val read = record.read(buffer, 0, windowSize)
                if (read <= 0) continue
                synchronized(recordedSamples) {
                    for (i in 0 until read) recordedSamples.add(buffer[i])
                }

                var sumAbs = 0.0
                for (i in 0 until read) {
                    real[i] = buffer[i] / 32768f
                    imag[i] = 0f
                    sumAbs += abs(buffer[i].toInt())
                }
                for (i in read until windowSize) {
                    real[i] = 0f
                    imag[i] = 0f
                }
                fft(real, imag)

                val newBands = FloatArray(bandCount)
                val usable = windowSize / 2
                for (i in 1 until usable) {
                    val mag = sqrt(real[i] * real[i] + imag[i] * imag[i])
                    val idx = ((i - 1) * bandCount / (usable - 1)).coerceIn(0, bandCount - 1)
                    val scaled = (mag * 6f).coerceIn(0f, 1f)
                    if (scaled > newBands[idx]) newBands[idx] = scaled
                }

                val level = ((sumAbs / read) / 32768.0 * 7.0).toFloat().coerceIn(0f, 1f)
                if (level > speechLevelThreshold) lastSpeechAtMs.set(System.currentTimeMillis())
                onLevel(level, newBands)
            }
        }.also { it.isDaemon = true; it.start() }
        return true
    }

    /** Stops capture and returns a WAV [File] of the whole recorded utterance, or null. */
    fun stop(context: Context): File? {
        recording = false
        runCatching { thread?.join(500) }
        thread = null
        val record = audioRecord
        audioRecord = null
        runCatching { record?.stop() }
        runCatching { record?.release() }

        val samples: ShortArray = synchronized(recordedSamples) {
            val arr = recordedSamples.toShortArray()
            recordedSamples.clear()
            arr
        }
        if (samples.isEmpty()) return null
        val file = File(context.cacheDir, "voice_mode_${System.currentTimeMillis()}.wav")
        return runCatching { writeWavFile(file, samples, sampleRate); file }.getOrNull()
    }

    /** Tears down without producing a file — used on cancel/close/barge-in. */
    fun cancel() {
        recording = false
        runCatching { audioRecord?.stop() }
        runCatching { audioRecord?.release() }
        audioRecord = null
        thread = null
        synchronized(recordedSamples) { recordedSamples.clear() }
        lastSpeechAtMs.set(0L)
    }
}

/**
 * Wraps an `android.media.audiofx.Visualizer` attached to a playback session (a [MediaPlayer]'s
 * `audioSessionId`) for TTS-reactive visuals — the same normalized (level, bands) callback shape
 * as [MicCaptureController] so [ParticleSphere] doesn't care which source is feeding it.
 */
private class PlaybackAnalyzer(private val onLevel: (Float, FloatArray) -> Unit) {
    private var visualizer: Visualizer? = null
    private val bandCount = 24

    fun attach(audioSessionId: Int) {
        runCatching {
            val viz = Visualizer(audioSessionId)
            val range = Visualizer.getCaptureSizeRange()
            viz.setCaptureSize(range[1])
            viz.setDataCaptureListener(
                object : Visualizer.OnDataCaptureListener {
                    override fun onWaveFormDataCapture(visualizer: Visualizer?, waveform: ByteArray?, samplingRate: Int) {
                        // Not used — FFT capture below already yields both a level and bands.
                    }

                    override fun onFftDataCapture(visualizer: Visualizer?, fft: ByteArray?, samplingRate: Int) {
                        if (fft == null) return
                        val usable = (fft.size / 2) - 1
                        if (usable <= 0) return
                        val newBands = FloatArray(bandCount)
                        for (i in 0 until usable) {
                            val re = fft[2 * i].toInt()
                            val im = if (2 * i + 1 < fft.size) fft[2 * i + 1].toInt() else 0
                            val mag = (sqrt((re * re + im * im).toFloat()) / 90f).coerceIn(0f, 1f)
                            val idx = (i * bandCount / usable).coerceIn(0, bandCount - 1)
                            if (mag > newBands[idx]) newBands[idx] = mag
                        }
                        var sum = 0f
                        for (b in newBands) sum += b
                        val level = (sum / bandCount).coerceIn(0f, 1f)
                        onLevel(level, newBands)
                    }
                },
                // ~20Hz update rate (in milliHertz, per the Visualizer API), capped to what the
                // device actually supports.
                minOf(20_000, Visualizer.getMaxCaptureRate()),
                false,
                true,
            )
            viz.enabled = true
            visualizer = viz
        }
    }

    fun release() {
        runCatching { visualizer?.enabled = false }
        runCatching { visualizer?.release() }
        visualizer = null
    }
}

/** Writes 16-bit mono PCM [samples] out as a standard 44-byte-header WAV [file]. */
private fun writeWavFile(file: File, samples: ShortArray, sampleRate: Int) {
    val byteRate = sampleRate * 2
    val dataSize = samples.size * 2
    FileOutputStream(file).use { out ->
        val header = ByteArray(44)
        fun writeStr(offset: Int, s: String) {
            s.forEachIndexed { i, c -> header[offset + i] = c.code.toByte() }
        }
        fun writeInt32(offset: Int, v: Int) {
            header[offset] = (v and 0xff).toByte()
            header[offset + 1] = ((v shr 8) and 0xff).toByte()
            header[offset + 2] = ((v shr 16) and 0xff).toByte()
            header[offset + 3] = ((v shr 24) and 0xff).toByte()
        }
        fun writeInt16(offset: Int, v: Int) {
            header[offset] = (v and 0xff).toByte()
            header[offset + 1] = ((v shr 8) and 0xff).toByte()
        }
        writeStr(0, "RIFF")
        writeInt32(4, 36 + dataSize)
        writeStr(8, "WAVE")
        writeStr(12, "fmt ")
        writeInt32(16, 16)
        writeInt16(20, 1) // PCM
        writeInt16(22, 1) // mono
        writeInt32(24, sampleRate)
        writeInt32(28, byteRate)
        writeInt16(32, 2) // block align
        writeInt16(34, 16) // bits per sample
        writeStr(36, "data")
        writeInt32(40, dataSize)
        out.write(header)

        val bytes = ByteArray(dataSize)
        for (i in samples.indices) {
            val s = samples[i].toInt()
            bytes[i * 2] = (s and 0xff).toByte()
            bytes[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
        }
        out.write(bytes)
    }
}

/**
 * A minimal in-place iterative radix-2 Cooley-Tukey FFT. [real]/[imag] must be the same
 * power-of-two length; results are written back in place (not normalized).
 */
private fun fft(real: FloatArray, imag: FloatArray) {
    val n = real.size
    if (n <= 1) return

    var j = 0
    for (i in 1 until n) {
        var bit = n shr 1
        while (bit > 0 && (j and bit) != 0) {
            j = j xor bit
            bit = bit shr 1
        }
        j = j or bit
        if (i < j) {
            val tr = real[i]; real[i] = real[j]; real[j] = tr
            val ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
        }
    }

    var len = 2
    while (len <= n) {
        val ang = -2.0 * Math.PI / len
        val wr = cos(ang).toFloat()
        val wi = sin(ang).toFloat()
        var start = 0
        while (start < n) {
            var curWr = 1f
            var curWi = 0f
            val half = len / 2
            for (k in 0 until half) {
                val evenIdx = start + k
                val oddIdx = evenIdx + half
                val evenR = real[evenIdx]; val evenI = imag[evenIdx]
                val oddR = real[oddIdx] * curWr - imag[oddIdx] * curWi
                val oddI = real[oddIdx] * curWi + imag[oddIdx] * curWr
                real[evenIdx] = evenR + oddR
                imag[evenIdx] = evenI + oddI
                real[oddIdx] = evenR - oddR
                imag[oddIdx] = evenI - oddI
                val nextWr = curWr * wr - curWi * wi
                val nextWi = curWr * wi + curWi * wr
                curWr = nextWr
                curWi = nextWi
            }
            start += len
        }
        len = len shl 1
    }
}
