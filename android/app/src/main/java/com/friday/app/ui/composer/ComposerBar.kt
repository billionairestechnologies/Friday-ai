package com.friday.app.ui.composer

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.Mode
import com.friday.app.data.PendingAttachment
import com.friday.app.data.placeholderFor
import com.friday.app.ui.shell.brandOf
import com.friday.app.ui.theme.ComposerCorner
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridayStop
import com.friday.app.ui.theme.FridayText
import com.friday.app.ui.theme.FridayThink
import kotlinx.coroutines.delay
import androidx.compose.ui.focus.focusRequester
import kotlin.math.sqrt

@Composable
fun ComposerBar(
    draft: String,
    onDraft: (String) -> Unit,
    modes: Set<Mode>,
    onToggleMode: (Mode) -> Unit,
    modelLabel: String,
    modelId: String? = null,
    isGenerating: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onAttach: () -> Unit,
    onVoice: () -> Unit,
    onModel: () -> Unit,
    modifier: Modifier = Modifier,
    onVoiceMessage: (java.io.File) -> Unit = {},
    attachments: List<PendingAttachment> = emptyList(),
    onRemoveAttachment: (String) -> Unit = {},
    focusRequester: androidx.compose.ui.focus.FocusRequester? = null,
) {
    val shape = RoundedCornerShape(ComposerCorner)
    val hasText = draft.trim().isNotEmpty()
    var isRecording by remember { mutableStateOf(false) }
    val ctx = LocalContext.current
    var recorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var audioFile by remember { mutableStateOf<java.io.File?>(null) }

    fun startRecording() {
        val file = java.io.File(ctx.cacheDir, "voice_${System.currentTimeMillis()}.m4a")
        val mr = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder()
        runCatching {
            mr.setAudioSource(MediaRecorder.AudioSource.MIC)
            mr.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            mr.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            mr.setOutputFile(file.absolutePath)
            mr.prepare()
            mr.start()
        }.onSuccess {
            recorder = mr
            audioFile = file
            isRecording = true
        }.onFailure {
            runCatching { mr.release() }
        }
    }

    fun stopRecording() {
        runCatching {
            recorder?.stop()
            recorder?.release()
        }
        recorder = null
        isRecording = false
        audioFile?.let { onVoiceMessage(it) }
        audioFile = null
    }

    fun cancelRecording() {
        runCatching {
            recorder?.stop()
            recorder?.release()
        }
        recorder = null
        isRecording = false
        audioFile?.delete()
        audioFile = null
    }

    val micPermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording()
    }

    fun requestRecording() {
        val granted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (granted) startRecording() else micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    Box(
        modifier
            .fillMaxWidth()
            .shadow(16.dp, shape, ambientColor = Color(0x293C4043), spotColor = Color(0x333C4043))
            .clip(shape)
            .background(FridayBg)
            .border(1.dp, if (isRecording) FridayStop.copy(alpha = 0.5f) else Color(0x1F1F1F1F), shape)
            .padding(bottom = 6.dp),
    ) {
        Column {
            if (attachments.isNotEmpty() && !isRecording) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(start = 12.dp, end = 12.dp, top = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    attachments.forEach { a -> AttachmentChip(a, onRemove = { onRemoveAttachment(a.id) }) }
                }
            }
            if (isRecording) {
                VoiceRecorderRow(recorder = recorder, onCancel = { cancelRecording() }, onConfirm = { stopRecording() })
            } else {
                BasicTextField(
                    value = draft,
                    onValueChange = onDraft,
                    enabled = true,
                    textStyle = TextStyle(
                        color = FridayText,
                        fontSize = 16.sp,
                        lineHeight = 22.sp,
                    ),
                    cursorBrush = SolidColor(FridayStop),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { onSend() }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 44.dp, max = 160.dp)
                        .padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = 4.dp)
                        .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier),
                    decorationBox = { inner ->
                        Box {
                            if (draft.isEmpty()) {
                                Text(
                                    placeholderFor(modes),
                                    color = FridayMuted,
                                    fontSize = 16.sp,
                                )
                            }
                            inner()
                        }
                    },
                )
            }
            AnimatedVisibility(!isRecording, enter = fadeIn(), exit = fadeOut()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        Modifier
                            .weight(1f)
                            .horizontalScroll(rememberScrollState()),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconBtn(Icons.Default.Add, "Attach", FridayMuted, onAttach)
                        ModeChip(Icons.Outlined.Language, "Search", Mode.Search, FridaySearch, modes, onToggleMode)
                        ComposerDivider()
                        ModeChip(Icons.Outlined.Settings, "Think", Mode.Think, FridayThink, modes, onToggleMode)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AnimatedVisibility(!hasText && modes.isEmpty(), enter = expandHorizontally() + fadeIn(), exit = shrinkHorizontally() + fadeOut()) {
                            IconBtn(Icons.Outlined.GraphicEq, "Voice", FridayMuted, onVoice)
                        }
                        Row(
                            Modifier
                                .clip(RoundedCornerShape(20.dp))
                                .clickable(onClick = onModel)
                                .padding(horizontal = 8.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            when (modelId) {
                                com.friday.app.data.AUTO_MODEL_ID -> Icon(Icons.Default.Bolt, null, tint = FridayMuted, modifier = Modifier.size(14.dp))
                                com.friday.app.data.TEAMUP_MODEL_ID -> Icon(Icons.Default.Groups, null, tint = FridayMuted, modifier = Modifier.size(14.dp))
                                else -> {
                                    val brand = brandOf(modelId.orEmpty(), modelLabel)
                                    if (brand.logo != null) {
                                        Icon(
                                            painter = painterResource(brand.logo),
                                            contentDescription = null,
                                            tint = FridayText,
                                            modifier = Modifier.size(14.dp),
                                        )
                                    } else {
                                        Icon(Icons.Outlined.AutoAwesome, null, tint = FridayMuted, modifier = Modifier.size(14.dp))
                                    }
                                }
                            }
AnimatedVisibility(modes.size < 2, enter = expandHorizontally() + fadeIn(), exit = shrinkHorizontally() + fadeOut()) {
                            Text(
                                modelLabel,
                                color = FridayText,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                modifier = Modifier.widthIn(max = 96.dp),
                            )
}
                            Icon(Icons.Default.KeyboardArrowDown, null, tint = FridayMuted, modifier = Modifier.size(16.dp))
                        }
                    }
                    TrailingAction(
                        hasText = hasText,
                        generating = isGenerating && !hasText,
                        onSend = onSend,
                        onStop = onStop,
                        onStartRecording = { requestRecording() },
                    )
                }
            }
        }
    }
}

@Composable
private fun AttachmentChip(attachment: PendingAttachment, onRemove: () -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(12.dp))
            .background(FridaySearch.copy(alpha = 0.5f))
            .padding(start = 8.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            if (attachment.kind == "image") Icons.Default.Image else Icons.AutoMirrored.Filled.InsertDriveFile,
            null,
            tint = FridayMuted,
            modifier = Modifier.size(16.dp),
        )
        Text(
            attachment.name,
            color = FridayText,
            fontSize = 13.sp,
            maxLines = 1,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 120.dp),
        )
        Icon(
            Icons.Default.Close,
            "Remove",
            tint = FridayMuted,
            modifier = Modifier
                .size(18.dp)
                .clip(CircleShape)
                .clickable(onClick = onRemove)
                .padding(2.dp),
        )
    }
}

private const val WAVE_BAR_COUNT = 28

@Composable
private fun VoiceRecorderRow(recorder: MediaRecorder?, onCancel: () -> Unit, onConfirm: () -> Unit) {
    var seconds by remember { mutableIntStateOf(0) }
    // Rolling window of real mic amplitude samples (most recent last) — MediaRecorder.getMaxAmplitude()
    // returns the peak since the last call, so polling it on a short interval gives a genuine,
    // real-time-responsive waveform instead of a decorative random tween.
    val levels = remember { mutableStateListOf(*FloatArray(WAVE_BAR_COUNT) { 0f }.toTypedArray()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            seconds++
        }
    }
    LaunchedEffect(recorder) {
        while (true) {
            delay(70)
            val amp = runCatching { recorder?.maxAmplitude ?: 0 }.getOrDefault(0)
            // MediaRecorder's amplitude range is 0..32767; sqrt gives a more visually even
            // response across quiet speech vs loud peaks than a raw linear scale would.
            val level = sqrt((amp / 32767f).coerceIn(0f, 1f))
            levels.removeAt(0)
            levels.add(level)
        }
    }
    val mins = seconds / 60
    val secs = seconds % 60

    // Single row, edge to edge — cancel (discard) on the left, confirm (transcribe & fill
    // composer) on the right, waveform stretched to fill the space between so it reads as
    // covering the whole composer box, matching the web recorder layout.
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(32.dp)
                .clip(CircleShape)
                .clickable(onClick = onCancel),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Default.Close, "Cancel recording", tint = FridayMuted, modifier = Modifier.size(18.dp))
        }
        val t = rememberInfiniteTransition(label = "rec-dot")
        val a by t.animateFloat(
            0.35f, 1f,
            infiniteRepeatable(tween(650, easing = FastOutSlowInEasing), androidx.compose.animation.core.RepeatMode.Reverse),
            label = "dot-a",
        )
        Box(Modifier.size(7.dp).clip(CircleShape).background(FridayStop.copy(alpha = a)))
        Spacer(Modifier.width(6.dp))
        Text(
            "%02d:%02d".format(mins, secs),
            color = FridayMuted,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.width(10.dp))
        Row(
            Modifier
                .weight(1f)
                .height(28.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            levels.forEachIndexed { i, level -> WaveBar(level = level, key = i) }
        }
        Spacer(Modifier.width(10.dp))
        Box(
            Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(FridayStop)
                .clickable(onClick = onConfirm),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Default.Check, "Confirm recording", tint = FridayBg, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun WaveBar(level: Float, key: Int) {
    val h by animateFloatAsState(
        (0.12f + level * 0.88f).coerceIn(0.12f, 1f),
        tween(90, easing = FastOutSlowInEasing),
        label = "h$key",
    )
    Box(
        Modifier
            .width(3.dp)
            .fillMaxHeightFraction(h)
            .clip(RoundedCornerShape(50))
            .background(FridayMuted.copy(alpha = 0.6f)),
    )
}

private fun Modifier.fillMaxHeightFraction(fraction: Float): Modifier =
    this.then(Modifier.height((28 * fraction).dp))

@Composable
private fun ModeChip(
    icon: ImageVector,
    label: String,
    mode: Mode,
    color: Color,
    active: Set<Mode>,
    onToggle: (Mode) -> Unit,
) {
    val on = mode in active
    val rotation by animateFloatAsState(
        if (on) 360f else 0f,
        spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessLow),
        label = "rot",
    )
    val scale by animateFloatAsState(if (on) 1.1f else 1f, spring(), label = "scale")
    Row(
        Modifier
            .padding(vertical = 2.dp, horizontal = 2.dp)
            .height(32.dp)
            .clip(RoundedCornerShape(50))
            .background(if (on) color.copy(alpha = 0.12f) else Color.Transparent)
            .border(1.dp, if (on) color.copy(alpha = 0.4f) else Color.Transparent, RoundedCornerShape(50))
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { onToggle(mode) }
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            icon,
            label,
            tint = if (on) color else FridayMuted,
            modifier = Modifier
                .size(16.dp)
                .rotate(rotation)
                .scale(scale),
        )
        AnimatedVisibility(on, enter = expandHorizontally() + fadeIn(), exit = shrinkHorizontally() + fadeOut()) {
            Text(label, color = color, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun ComposerDivider() {
    Box(
        Modifier
            .padding(horizontal = 2.dp)
            .size(width = 1.dp, height = 20.dp)
            .background(FridayMuted.copy(alpha = 0.25f)),
    )
}

@Composable
private fun IconBtn(icon: ImageVector, label: String, tint: Color, onClick: () -> Unit) {
    Box(
        Modifier
            .size(36.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun TrailingAction(
    hasText: Boolean,
    generating: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onStartRecording: () -> Unit,
) {
    val bg = when {
        generating -> FridayStop
        hasText -> FridayText
        else -> Color.Transparent
    }
    val fg = when {
        generating || hasText -> FridayBg
        else -> FridayMuted
    }
    Box(
        Modifier
            .padding(start = 4.dp)
            .size(36.dp)
            .clip(CircleShape)
            .background(bg)
            .clickable {
                when {
                    generating -> onStop()
                    hasText -> onSend()
                    else -> onStartRecording()
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = when {
                generating -> Icons.Default.Stop
                hasText -> Icons.AutoMirrored.Outlined.Send
                else -> Icons.Outlined.Mic
            },
            contentDescription = when {
                generating -> "Stop"
                hasText -> "Send"
                else -> "Voice input"
            },
            tint = fg,
            modifier = Modifier.size(if (generating) 16.dp else 18.dp),
        )
    }
}
