package com.friday.app.ui.voice

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * A single point on the unit sphere, in object space (before rotation/projection).
 */
private data class SpherePoint(val x: Float, val y: Float, val z: Float)

/**
 * Evenly spreads [count] points across a unit sphere using the Fibonacci-sphere construction —
 * this gives a natural, non-clumped particle field (no pole-crowding the way a naive lat/long
 * grid would produce). Mirrors the algorithm used by the web app's particle-sphere.tsx.
 */
private fun fibonacciSphere(count: Int): List<SpherePoint> {
    if (count <= 1) return listOf(SpherePoint(0f, 1f, 0f))
    val points = ArrayList<SpherePoint>(count)
    val golden = (PI * (3.0 - sqrt(5.0))).toFloat()
    for (i in 0 until count) {
        val y = 1f - (i / (count - 1).toFloat()) * 2f
        val radius = sqrt((1f - y * y).coerceAtLeast(0f))
        val theta = golden * i
        points.add(SpherePoint(cos(theta) * radius, y, sin(theta) * radius))
    }
    return points
}

/**
 * Deterministic hash of a voice id into a hue (0-359) so each voice reads as a consistent color
 * across the app (voice picker, voice mode, etc). Doesn't need to match the web app's hash
 * bit-for-bit — only needs to be stable per id.
 */
fun hueForVoice(voiceId: String?): Int {
    if (voiceId.isNullOrEmpty()) return 205
    var hash = 0
    for (c in voiceId) hash = (hash * 31 + c.code) and 0x7FFFFFFF
    return hash % 360
}

/** Converts an HSL color (h in degrees 0-360, s/l/alpha in 0f..1f) to a Compose [Color]. */
private fun hslToColor(h: Float, s: Float, l: Float, alpha: Float): Color {
    val hh = ((h % 360f) + 360f) % 360f
    val c = (1f - kotlin.math.abs(2f * l - 1f)) * s
    val x = c * (1f - kotlin.math.abs((hh / 60f) % 2f - 1f))
    val m = l - c / 2f
    val (r1, g1, b1) = when {
        hh < 60f -> Triple(c, x, 0f)
        hh < 120f -> Triple(x, c, 0f)
        hh < 180f -> Triple(0f, c, x)
        hh < 240f -> Triple(0f, x, c)
        hh < 300f -> Triple(x, 0f, c)
        else -> Triple(c, 0f, x)
    }
    return Color(
        red = (r1 + m).coerceIn(0f, 1f),
        green = (g1 + m).coerceIn(0f, 1f),
        blue = (b1 + m).coerceIn(0f, 1f),
        alpha = alpha.coerceIn(0f, 1f),
    )
}

/**
 * A small, self-contained audio-reactive particle sphere, colored per [hue]. Always rotates and
 * stays visibly colorful at rest (not just while [active]) — jitter and radius growth kick in
 * only with real audio, same as the web app's particle-sphere.tsx.
 *
 * Feed it a continuously-updating [level] (overall loudness, 0f..1f) and [bands] (a coarse
 * per-frequency-bin breakdown, values 0f..1f) every frame from whatever audio source is live
 * (microphone while listening, TTS playback while responding, or a constant 0f / empty array at
 * idle/thinking). This composable does its own internal smoothing and rotation animation — it
 * does not read or manage any audio APIs itself.
 *
 * @param level overall loudness for the current instant, 0f (silence) to 1f (loud).
 * @param bands coarse per-band magnitudes, 0f..1f each. Any size is fine; an empty array is
 *   treated as "no audio-reactive jitter this frame" (only the ambient pulse/rotation continue).
 * @param hue color hue in degrees (0-359). Use [hueForVoice] to derive one from a voice id.
 * @param active whether this sphere is currently reacting to *real* audio (listening/responding)
 *   vs. idle/thinking — active spheres render more saturated.
 * @param pointCount number of particles; lower for small/inline spheres to keep them cheap.
 */
@Composable
fun ParticleSphere(
    level: Float,
    bands: FloatArray,
    hue: Int,
    active: Boolean,
    modifier: Modifier = Modifier,
    pointCount: Int = 900,
) {
    val points = remember(pointCount) { fibonacciSphere(pointCount) }
    val rotation = remember { mutableFloatStateOf(Random.nextFloat() * (2f * PI).toFloat()) }
    val smoothedLevel = remember { mutableFloatStateOf(0f) }
    val smoothedBands = remember { mutableStateOf(FloatArray(0)) }

    // rememberUpdatedState so the long-lived animation loop below always sees the latest
    // level/bands/hue/active without needing to restart (and without triggering recomposition
    // storms — these are read directly inside the draw phase, not observed as Compose state).
    val levelState = rememberUpdatedState(level)
    val bandsState = rememberUpdatedState(bands)
    val hueState = rememberUpdatedState(hue)
    val activeState = rememberUpdatedState(active)

    // Drives the continuous rotation + level smoothing every display frame, exactly like the
    // web version's requestAnimationFrame loop. Reading rotation.value / smoothedLevel.value
    // inside Canvas's draw scope (below) is what triggers a redraw each time these change,
    // without needing a full recomposition of this composable.
    //
    // The raw level/bands arrive from the mic/TTS analyzer roughly every ~30ms in unsmoothed,
    // spiky bursts (a single loud sample window immediately followed by a quiet one), which is
    // what made the sphere previously feel like it was snapping between big/small rather than
    // breathing. A single symmetric lerp still tracks those spikes almost immediately in both
    // directions, so this uses a fast attack (grows promptly, stays responsive) but a much slower
    // decay (shrinks gradually) — the same trick real VU meters use — plus per-band smoothing so
    // individual particle jitter doesn't flicker frame to frame either.
    LaunchedEffect(Unit) {
        var lastNanos = 0L
        while (true) {
            val nanos = withFrameNanos { it }
            if (lastNanos != 0L) {
                val rawLevel = levelState.value.coerceIn(0f, 1f)
                val levelCoef = if (rawLevel > smoothedLevel.value) 0.22f else 0.07f
                smoothedLevel.value += (rawLevel - smoothedLevel.value) * levelCoef
                rotation.value += 0.0022f + smoothedLevel.value * 0.006f

                val rawBands = bandsState.value
                if (rawBands.isNotEmpty()) {
                    var sb = smoothedBands.value
                    if (sb.size != rawBands.size) sb = FloatArray(rawBands.size)
                    for (i in rawBands.indices) {
                        val target = rawBands[i]
                        val coef = if (target > sb[i]) 0.30f else 0.09f
                        sb[i] += (target - sb[i]) * coef
                    }
                    smoothedBands.value = sb
                }
            }
            lastNanos = nanos
        }
    }

    Canvas(modifier = modifier.fillMaxSize()) {
        drawSphere(
            points = points,
            rotation = rotation.value,
            level = smoothedLevel.value,
            bands = smoothedBands.value,
            hue = hueState.value,
            active = activeState.value,
        )
    }
}

private fun DrawScope.drawSphere(
    points: List<SpherePoint>,
    rotation: Float,
    level: Float,
    bands: FloatArray,
    hue: Int,
    active: Boolean,
) {
    val w = size.width
    val h = size.height
    val cx = w / 2f
    val cy = h / 2f
    val baseRadius = min(w, h) * 0.24f
    // Sqrt curve so quieter speech still visibly grows the sphere (raw level tends to sit low),
    // with a larger multiplier so loud speech makes the size change unmistakable, not subtle.
    val boostedLevel = sqrt(level.coerceIn(0f, 1f))
    val radius = baseRadius * (1f + boostedLevel * 1.1f)

    val cosR = cos(rotation)
    val sinR = sin(rotation)
    val bandCount = bands.size
    // Subtle hue/saturation lift with loudness — makes the sphere read as actually *responding*
    // in color as speech gets bigger/smaller, not just scaling a single flat color.
    val liveHue = hue.toFloat() + boostedLevel * 16f
    val sat = ((if (active) 0.76f else 0.45f) + boostedLevel * 0.18f).coerceAtMost(1f)

    for (i in points.indices) {
        val p = points[i]
        // Rotate around the Y axis.
        val x = p.x * cosR - p.z * sinR
        val z = p.x * sinR + p.z * cosR
        val y = p.y

        val jitter = if (bandCount > 0) (bands[i % bandCount].coerceIn(0f, 1f)) * 0.26f else 0f
        val r = radius * (1f + jitter)

        val perspective = 1f / (1.7f - z * 0.5f)
        val px = cx + x * r * perspective
        val py = cy + y * r * perspective
        val dotSize = kotlin.math.max(0.6f, 1.6f * perspective) * (1f + boostedLevel * 1.1f)

        val depth = (z + 1f) / 2f
        val alpha = (0.22f + depth * 0.55f + boostedLevel * 0.25f).coerceAtMost(1f)
        val light = if (active) 0.52f + depth * 0.15f else 0.52f + depth * 0.20f

        val color = hslToColor(liveHue, sat, light, alpha)
        // Soft glow: a larger, dim halo under the crisp core dot reads as smooth/rounded instead
        // of a hard little pixel — a cheap stand-in for a real blur filter that's fine to run per
        // particle at this point count.
        drawCircle(color = color.copy(alpha = alpha * 0.28f), radius = dotSize * 2.2f, center = Offset(px, py))
        drawCircle(color = color, radius = dotSize, center = Offset(px, py))
    }
}
