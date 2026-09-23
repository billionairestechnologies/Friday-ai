package com.friday.app.ui.chat

import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import android.net.Uri
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.compose.AsyncImagePainter
import coil.request.ImageRequest
import com.friday.app.data.ChatMessage
import com.friday.app.data.Mode
import com.friday.app.data.Role
import com.friday.app.data.Source
import com.friday.app.ui.canvas.detectArtifact
import com.friday.app.ui.theme.BubbleCorner
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridayStop
import com.friday.app.ui.theme.FridaySuccess
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayHairline
import com.friday.app.ui.theme.FridayText
import com.friday.app.ui.theme.FridayThink
import kotlinx.coroutines.delay

@Composable
fun ChatThread(messages: List<ChatMessage>, modifier: Modifier = Modifier) {
    val list = rememberLazyListState()
    // Whether the last item is the (or nearly the) last one visible — used to gate auto-scroll
    // during streaming so it doesn't fight a user who scrolled up to read earlier messages. Every
    // streamed token used to re-run animateScrollToItem unconditionally, yanking the list back to
    // the bottom out from under a manual scroll (reported live as a "glitch" that "comes back to
    // top" — really back to bottom — on its own).
    val isNearBottom by remember {
        derivedStateOf {
            val info = list.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull() ?: return@derivedStateOf true
            val totalCount = info.totalItemsCount
            last.index >= totalCount - 1 && (last.offset + last.size) <= info.viewportEndOffset + 200
        }
    }
    // A brand-new message (sent or received) always scrolls to it regardless of prior position —
    // matches every chat app's "jump to the thing that just happened" behavior.
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) list.animateScrollToItem(messages.lastIndex)
    }
    // Continued streaming into the same message only keeps auto-scrolling while the user is
    // already at the bottom; once they've scrolled away, it leaves them alone.
    LaunchedEffect(messages.lastOrNull()?.content) {
        if (messages.isNotEmpty() && isNearBottom) list.animateScrollToItem(messages.lastIndex)
    }
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        state = list,
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        items(messages, key = { it.id }) { msg ->
            if (msg.role == Role.User) UserBubble(msg.content) else AssistantBlock(msg)
        }
    }
}

@Composable
private fun UserBubble(text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Text(
            text,
            color = FridayText,
            fontSize = 15.5.sp,
            lineHeight = 22.sp,
            modifier = Modifier
                .widthIn(max = 320.dp)
                .clip(RoundedCornerShape(BubbleCorner))
                .background(FridaySurface)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun AssistantBlock(msg: ChatMessage) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // Bare pill for as long as there's no actual reply text yet. Gating this on msg.status
        // used to hide it the instant the backend's generic "thinking" status frame landed (it
        // sends one on every reply, mode or no mode — see trailModeActive below) even though the
        // model hadn't started streaming text yet, leaving a blank 1-2s gap between the pill
        // disappearing and the reply showing up. Content arriving is the only thing that should
        // replace this pill.
        val nothingHasArrivedYet = msg.isStreaming && msg.content.isEmpty()
        // The backend emits a generic "thinking" status frame on every reply, mode or no mode —
        // without gating on the composer's actual modes, a plain "hii" got the full multi-step
        // Thought Trail card same as a real Think/Search turn. Now the card only shows when
        // Think/Search/Canvas was actually toggled on for THIS message; a plain reply goes
        // straight from the brief loading pill to the one-line answer. And since the mode is
        // already known at send time (it's a composer toggle, not something the backend tells us
        // later), the card shows immediately with the right "Thinking"/"Searching" header from the
        // very first frame instead of waiting for a status event to arrive first.
        val trailModeActive = Mode.Think in msg.modesUsed || Mode.Search in msg.modesUsed || Mode.Canvas in msg.modesUsed
        if (msg.agents.isNotEmpty()) {
            AgentsRow(msg)
        } else if (trailModeActive) {
            ThoughtCard(msg)
        }
        val generatingImage = msg.status == "generating_image" && nothingHasArrivedYet
        // Cross-fades the pill out as the first bit of content fades in, instead of the pill
        // vanishing and the text popping in on separate frames.
        AnimatedVisibility(visible = !trailModeActive && msg.agents.isEmpty() && nothingHasArrivedYet && !generatingImage, enter = fadeIn(tween(180)), exit = fadeOut(tween(180))) {
            ThinkingPill()
        }
        AnimatedVisibility(visible = generatingImage, enter = fadeIn(tween(180)), exit = fadeOut(tween(180))) {
            GeneratingImagePill()
        }
        AnimatedVisibility(visible = msg.content.isNotEmpty(), enter = fadeIn(tween(220)), exit = fadeOut(tween(0))) {
            MarkdownBody(msg.content)
        }
        if (msg.content.isNotEmpty() && !msg.isStreaming) {
            MessageActions(msg.content)
        }
    }
}

@Composable
private fun MessageActions(text: String) {
    val clipboard = LocalClipboardManager.current
    val ctx = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1200)
            copied = false
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(
            Modifier
                .size(32.dp)
                .clip(CircleShape)
                .clickable {
                    clipboard.setText(AnnotatedString(text))
                    copied = true
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (copied) Icons.Default.Check else Icons.Default.ContentCopy,
                if (copied) "Copied" else "Copy response",
                tint = FridayMuted,
                modifier = Modifier.size(16.dp),
            )
        }
        Box(
            Modifier
                .size(32.dp)
                .clip(CircleShape)
                .clickable { shareReplyAsFile(ctx, text) },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Default.Download,
                "Download response",
                tint = FridayMuted,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

/** Saves the reply as a .md file and hands it to the OS share sheet — matches web's "Download
 *  response" action (saveFile("friday-reply.md", ...) in message-thread.tsx), previously Android
 *  only had Copy for a full reply (CanvasPanel.kt already had this exact FileProvider/ACTION_SEND
 *  pattern for canvas artifacts and chat export; this reuses the same approach). */
private fun shareReplyAsFile(ctx: android.content.Context, text: String) {
    val uri = runCatching {
        val dir = File(ctx.cacheDir, "replies").apply { mkdirs() }
        val file = File(dir, "friday-reply.md")
        file.writeText(text)
        FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
    }.getOrNull() ?: return
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/markdown"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    runCatching { ctx.startActivity(Intent.createChooser(intent, "Save reply").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/** Shown the instant a message starts streaming, before any status/reasoning/content has arrived. */
@Composable
private fun ThinkingPill() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        ThreeDotBounce(FridayThink)
        RotatingLabel(ThinkingLines.plain, FridayText, active = true, shimmer = false)
    }
}

/** Small, flat "Creating your image" indicator with a simulated completion percentage — matches
 *  web's chain-of-thought-live.tsx generatingImage branch. Image generation is one blocking
 *  server call with no real progress to report, so this fakes a decelerating climb the same way
 *  (and the same way most "AI is generating..." UIs, including the reference product, do). */
@Composable
private fun GeneratingImagePill() {
    val pct = rememberSimulatedProgress(ceiling = 92)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CircularProgressIndicator(strokeWidth = 2.dp, color = FridayThink, modifier = Modifier.size(14.dp))
        Text("Creating your image", color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        Text("$pct%", color = FridayMuted, fontSize = 15.sp)
    }
}

/** Fakes a decelerating climb toward (but never reaching) `ceiling` while composed, resetting to
 *  0 on each recomposition of the caller (a fresh generation) — see GeneratingImagePill. */
@Composable
private fun rememberSimulatedProgress(ceiling: Int): Int {
    var pct by remember { mutableStateOf(0f) }
    LaunchedEffect(Unit) {
        while (pct < ceiling) {
            delay(220)
            val remaining = ceiling - pct
            pct = (pct + maxOf(0.5f, remaining * 0.08f)).coerceAtMost(ceiling.toFloat())
        }
    }
    return pct.toInt()
}

/** Three-dot typing/bounce indicator — sits to the left of the rotating label in the thinking pill. */
@Composable
private fun ThreeDotBounce(color: Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        repeat(3) { i ->
            val t = rememberInfiniteTransition(label = "bounce$i")
            val y by t.animateFloat(
                0f, -5f,
                infiniteRepeatable(
                    tween(420, delayMillis = i * 120, easing = FastOutSlowInEasing),
                    RepeatMode.Reverse,
                ),
                label = "y$i",
            )
            Box(
                Modifier
                    .size(6.dp)
                    .offset(y = y.dp)
                    .clip(CircleShape)
                    .background(color),
            )
        }
    }
}

/**
 * Team Up's multi-model consult card — matches the web app's chain-of-thought-live.tsx exactly:
 * a collapsible header ("Consulting the team" / "Team of N consulted"), an "Understanding the
 * question" step, one named row per model consulted (its own brand mark + spinner/check/error),
 * and a "Synthesizing the final answer" step once every model has replied.
 */
@Composable
private fun AgentsRow(msg: ChatMessage) {
    val agents = msg.agents
    val finished = !msg.isStreaming
    val synthesizing = msg.status == "synthesizing"
    val headerLabel = if (finished) "Team of ${agents.size} consulted" else "Consulting the team"
    var userExpanded by remember(msg.id) { mutableStateOf<Boolean?>(null) }
    val expanded = userExpanded ?: true
    val chevronRotation by animateFloatAsState(if (expanded) 180f else 0f, label = "chevron-agents")

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(FridaySurface)
            .clickable { userExpanded = !expanded }
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (finished) {
                Icon(Icons.Default.Check, null, tint = FridaySuccess, modifier = Modifier.size(15.dp))
            } else {
                CircularProgressIndicator(strokeWidth = 2.dp, color = FridayThink, modifier = Modifier.size(13.dp))
            }
            Box(Modifier.weight(1f)) {
                if (finished) {
                    Text(headerLabel, color = FridayThink, fontSize = 13.5.sp, fontWeight = FontWeight.Medium)
                } else {
                    ShimmerText(headerLabel, FridayThink)
                }
            }
            Icon(
                Icons.Default.KeyboardArrowDown,
                null,
                tint = FridayMuted,
                modifier = Modifier.size(18.dp).rotate(chevronRotation),
            )
        }
        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(tween(300)) + fadeIn(tween(300)),
            exit = shrinkVertically(tween(300)) + fadeOut(tween(300)),
        ) {
            Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                TrailStep("Understanding the question", caption = "Read the prompt and any attachments")
                agents.forEach { agent -> AgentStepRow(agent) }
                if (agents.size > 1) {
                    val synthesized = finished || msg.content.isNotEmpty()
                    TrailStep(
                        title = if (synthesizing || !synthesized) "Synthesizing the final answer" else "Synthesized the final answer",
                        muted = !synthesizing && !synthesized,
                        spinning = synthesizing,
                    )
                }
            }
        }
    }
}

@Composable
private fun AgentStepRow(agent: com.friday.app.data.AgentStatus) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when (agent.state) {
                "start" -> CircularProgressIndicator(strokeWidth = 2.dp, color = FridayThink, modifier = Modifier.size(12.dp))
                "error" -> Icon(Icons.Default.Close, "Failed", tint = FridayStop, modifier = Modifier.size(13.dp))
                else -> Icon(Icons.Default.Check, null, tint = FridaySuccess, modifier = Modifier.size(13.dp))
            }
            val brand = com.friday.app.ui.shell.brandOf(agent.model, agent.model)
            if (brand.logo != null) {
                Icon(
                    painter = painterResource(brand.logo),
                    contentDescription = null,
                    tint = Color.Unspecified,
                    modifier = Modifier.size(14.dp),
                )
            }
            Text(
                agent.model,
                color = if (agent.state == "error") FridayStop else FridayText,
                fontSize = 13.5.sp,
                fontWeight = FontWeight.Medium,
            )
        }
        if (agent.state == "error") {
            Text(agent.error ?: "Failed to respond", color = FridayMuted, fontSize = 12.sp)
        }
    }
}

/**
 * Unified Thought Trail card — used for both the mock/guest demo and the real backend, styled to
 * mirror the web app: a purple phase header ("Searching"/"Thinking"/"Writing"), an "Understanding
 * the question" step, any further steps (dimmed once superseded, black once finished), a "Found N
 * sources" step with links, and a live active-step line with a rotating pill underneath. Search
 * results collapse to "Searched N sources" once done; plain thinking stays expanded to show the
 * full trail, matching the web app's behavior.
 */
@Composable
private fun ThoughtCard(msg: ChatMessage) {
    val artifact = remember(msg.content) { detectArtifact(msg.content) }
    val writingCode = msg.isStreaming && artifact != null && !artifact.complete
    val finished = !msg.isStreaming
    // Before the backend's first status frame arrives, fall back to the composer's own Search
    // toggle so the header reads "Searching" from the very first frame instead of a generic
    // "Thinking" that then jumps to "Searching" a moment later.
    val searching = msg.status == "searching" || msg.thinkingLabel?.contains("Searching", ignoreCase = true) == true ||
        (Mode.Search in msg.modesUsed && msg.status == null)
    val hasSources = msg.sources.isNotEmpty()

    val activePhrases = when {
        writingCode -> ThinkingLines.activeCanvas
        searching -> ThinkingLines.activeSearch
        else -> ThinkingLines.activeThink
    }
    val pillPhrases = when {
        writingCode -> ThinkingLines.pillCanvas
        searching -> ThinkingLines.pillSearch
        else -> ThinkingLines.pillThink
    }

    val headerLabel = when {
        finished && hasSources -> "Searched ${msg.sources.size} source${if (msg.sources.size == 1) "" else "s"}"
        finished -> "Thought"
        writingCode -> "Writing"
        searching -> "Searching"
        else -> "Thinking"
    }
    // Search results collapse by default once done; plain thinking stays open, like the web app.
    var userExpanded by remember(msg.id) { mutableStateOf<Boolean?>(null) }
    val expanded = userExpanded ?: (!finished || !hasSources)
    val chevronRotation by animateFloatAsState(if (expanded) 180f else 0f, label = "chevron")

    Column(
        Modifier
            .fillMaxWidth()
            .clickable { userExpanded = !expanded }
            .padding(vertical = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (finished) {
                Icon(Icons.Default.Check, null, tint = FridaySuccess, modifier = Modifier.size(15.dp))
            } else {
                CircularProgressIndicator(strokeWidth = 2.dp, color = FridayThink, modifier = Modifier.size(13.dp))
            }
            Box(Modifier.weight(1f)) {
                if (finished) {
                    Text(headerLabel, color = FridayText, fontSize = 13.5.sp, fontWeight = FontWeight.Medium)
                } else {
                    ShimmerText(headerLabel, FridayText)
                }
            }
            Icon(
                Icons.Default.KeyboardArrowDown,
                null,
                tint = FridayMuted,
                modifier = Modifier.size(18.dp).rotate(chevronRotation),
            )
        }
        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(tween(300)) + fadeIn(tween(300)),
            exit = shrinkVertically(tween(300)) + fadeOut(tween(300)),
        ) {
            Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                TrailStep("Understanding the question", caption = "Read the prompt and any attachments")

                // Mock/guest demo steps beyond the first ("Understanding the question" is steps[0]).
                val extraSteps = msg.thinkingSteps.drop(1)
                extraSteps.forEachIndexed { i, step ->
                    val isLast = i == extraSteps.lastIndex
                    TrailStep(
                        title = step,
                        muted = !finished && !isLast,
                        spinning = !finished && isLast && msg.reasoning.isBlank(),
                    )
                }

                if (msg.reasoning.isNotBlank()) {
                    TrailStep(title = "Reasoned through it") {
                        Text(msg.reasoning, color = FridayMuted, fontSize = 12.5.sp, lineHeight = 18.sp)
                    }
                }

                if (hasSources) {
                    TrailStep("Found ${msg.sources.size} source${if (msg.sources.size == 1) "" else "s"}") {
                        SourceLinksRow(msg.sources)
                    }
                }

                if (!finished) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            CircularProgressIndicator(strokeWidth = 2.dp, color = FridayThink, modifier = Modifier.size(12.dp))
                            RotatingLabel(activePhrases, FridayText, active = true)
                        }
                        ThinkingPillChip(pillPhrases)
                    }
                }
            }
        }
    }
}

/** One row of the expanded reasoning trail: an optional bold title, a muted caption, and/or custom content. */
@Composable
private fun TrailStep(
    title: String?,
    caption: String? = null,
    muted: Boolean = false,
    spinning: Boolean = false,
    content: (@Composable () -> Unit)? = null,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (title != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (spinning) CircularProgressIndicator(strokeWidth = 2.dp, color = FridayThink, modifier = Modifier.size(12.dp))
                Text(
                    title,
                    color = if (muted) FridayMuted else FridayText,
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
        if (caption != null) Text(caption, color = FridayMuted, fontSize = 12.sp)
        content?.invoke()
    }
}

/** Small rounded pill with a bouncing-dot trio and an italic rotating phrase, sitting under the active step. */
@Composable
private fun ThinkingPillChip(phrases: List<String>) {
    Row(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(FridayMuted.copy(alpha = 0.10f))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ThreeDotBounce(FridayMuted)
        RotatingLabel(phrases, FridayMuted, active = true, fontSize = 12.sp, italic = true)
    }
}

/** Rotating text label — cross-fades between phrases every ~2.6s while [active]; shimmers while streaming. */
@Composable
private fun RotatingLabel(
    phrases: List<String>,
    color: Color,
    active: Boolean,
    shimmer: Boolean = false,
    fontSize: androidx.compose.ui.unit.TextUnit = 13.5.sp,
    italic: Boolean = false,
) {
    var index by remember(phrases) { mutableIntStateOf(0) }
    LaunchedEffect(active, phrases) {
        if (!active) return@LaunchedEffect
        while (true) {
            delay(2600)
            index = (index + 1) % phrases.size
        }
    }
    AnimatedContent(
        targetState = phrases.getOrElse(index) { phrases.first() },
        transitionSpec = {
            (fadeIn(tween(220)) + slideInVertically(tween(220)) { h -> h / 3 }) togetherWith
                (fadeOut(tween(180)) + slideOutVertically(tween(180)) { h -> -h / 3 })
        },
        label = "thinking-label",
    ) { text ->
        if (shimmer) {
            ShimmerText(text, color)
        } else {
            Text(
                text,
                color = color,
                fontSize = fontSize,
                fontWeight = FontWeight.Medium,
                fontStyle = if (italic) androidx.compose.ui.text.font.FontStyle.Italic else androidx.compose.ui.text.font.FontStyle.Normal,
            )
        }
    }
}

/** Animated gradient sweep across the label text to signal active streaming, ~1.8s loop. */
@Composable
private fun ShimmerText(text: String, baseColor: Color) {
    val t = rememberInfiniteTransition(label = "shimmer-text")
    val shift by t.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(1800, easing = LinearEasing), RepeatMode.Restart),
        label = "shift",
    )
    val brush = Brush.linearGradient(
        colors = listOf(baseColor.copy(alpha = 0.45f), baseColor, baseColor.copy(alpha = 0.45f)),
        start = Offset(shift * 500f - 250f, 0f),
        end = Offset(shift * 500f + 250f, 0f),
    )
    Text(text, style = TextStyle(brush = brush, fontSize = 13.5.sp, fontWeight = FontWeight.Medium))
}

/** Wrapped row of clickable, underlined source links — each opens in the browser. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun SourceLinksRow(sources: List<Source>) {
    val ctx = LocalContext.current
    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.Start)) {
        sources.forEach { s ->
            Text(
                s.title.ifBlank { s.url },
                color = FridaySearch,
                fontSize = 12.5.sp,
                textDecoration = TextDecoration.Underline,
                modifier = Modifier.clickable {
                    runCatching {
                        ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(s.url)))
                    }
                },
            )
        }
    }
}

@Composable
fun MarkdownBody(text: String) {
    val parts = splitMarkdown(text)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        parts.forEach { part ->
            when (part) {
                is Md.Code -> CodeBlock(part.lang, part.body)
                is Md.Text -> MarkdownText(part.value)
                is Md.Image -> GeneratedImage(part.url, part.alt)
            }
        }
    }
}

/** Fades a generated image in once it's actually loaded, with a pulsing placeholder while it
 *  fetches — matches web's FadeInImage (lib/chat/markdown.tsx) instead of the image just popping
 *  in the instant Coil resolves it. */
@Composable
private fun GeneratedImage(url: String, alt: String) {
    var loaded by remember(url) { mutableStateOf(false) }
    val alpha by animateFloatAsState(if (loaded) 1f else 0f, animationSpec = tween(400), label = "imageFadeIn")
    val pulse = rememberInfiniteTransition(label = "imagePulse")
    val pulseAlpha by pulse.animateFloat(
        initialValue = 0.06f,
        targetValue = 0.14f,
        animationSpec = infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse),
        label = "imagePulseAlpha",
    )
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp)),
    ) {
        if (!loaded) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(220.dp)
                    .background(FridayText.copy(alpha = pulseAlpha)),
            )
        }
        AsyncImage(
            model = ImageRequest.Builder(LocalContext.current).data(url).crossfade(false).build(),
            contentDescription = alt,
            modifier = Modifier.fillMaxWidth().alpha(alpha),
            onState = { state -> loaded = state is AsyncImagePainter.State.Success },
        )
    }
}

/** Renders a plain-text block's lines as paragraphs and bulleted/numbered lists, with inline
 *  **bold** — previously this just dumped the raw string into one Text, so a model's structured
 *  reply ("**Summary**\n- point one\n- point two") showed up as literal asterisks and dashes
 *  instead of actual formatting. Headings (`# `..`###### `) render as a bold paragraph — replies
 *  are nudged toward bold section titles over headers (see FORMAT_SYSTEM_PROMPT on the backend),
 *  but a model that uses `#` anyway should still render sensibly rather than showing the dashes. */
@Composable
private fun MarkdownText(text: String) {
    val lines = remember(text) { parseMarkdownLines(text) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        lines.forEach { line ->
            when (line) {
                is MdLine.Bullet -> {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            line.ordinal?.let { "$it." } ?: "•",
                            color = FridayText,
                            fontSize = 15.5.sp,
                            lineHeight = 24.sp,
                        )
                        Text(
                            annotatedFromBold(line.text),
                            color = FridayText,
                            fontSize = 15.5.sp,
                            lineHeight = 24.sp,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                is MdLine.Para -> Text(annotatedFromBold(line.text), color = FridayText, fontSize = 15.5.sp, lineHeight = 24.sp)
                is MdLine.Table -> MarkdownTable(line.headers, line.rows)
            }
        }
    }
}

/** GFM-style table — matches web's react-markdown table rendering (a horizontally-scrollable
 *  bordered grid) rather than the raw `| a | b |` pipe text this used to fall through to. */
@Composable
private fun MarkdownTable(headers: List<String>, rows: List<List<String>>) {
    val colCount = headers.size
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .border(1.dp, FridayHairline, RoundedCornerShape(12.dp)),
    ) {
        Column(Modifier.horizontalScroll(rememberScrollState())) {
            Row(Modifier.background(FridaySurface)) {
                headers.forEach { cell ->
                    Text(
                        cell,
                        color = FridayText,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.widthIn(min = 96.dp).padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
            }
            HorizontalDivider(color = FridayHairline)
            rows.forEachIndexed { rowIndex, row ->
                Row {
                    for (c in 0 until colCount) {
                        Text(
                            row.getOrElse(c) { "" },
                            color = FridayText,
                            fontSize = 13.sp,
                            modifier = Modifier.widthIn(min = 96.dp).padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
                if (rowIndex != rows.lastIndex) HorizontalDivider(color = FridayHairline)
            }
        }
    }
}

private sealed class MdLine {
    data class Para(val text: String) : MdLine()
    data class Bullet(val text: String, val ordinal: String? = null) : MdLine()
    data class Table(val headers: List<String>, val rows: List<List<String>>) : MdLine()
}

private val headingLineRegex = Regex("^#{1,6}\\s+(.*)$")
private val bulletLineRegex = Regex("^[-*•]\\s+(.*)$")
private val numberedLineRegex = Regex("^(\\d+)[.)]\\s+(.*)$")
private val boldRegex = Regex("\\*\\*(.+?)\\*\\*")

// GFM table syntax: a header row, a `|---|---|` separator row, then N data rows, all pipe-
// delimited. Previously not recognized at all — a ledger/comparison reply's table (which the
// backend's FORMAT_SYSTEM_PROMPT now actively asks for when data is tabular) rendered as raw
// `| Col | Col |` pipe text, unlike web's react-markdown+remark-gfm which already handles it.
private val tableRowRegex = Regex("^\\|(.+)\\|$")
private val tableSeparatorRegex = Regex("^\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?$")

private fun splitTableCells(line: String): List<String> =
    line.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

private fun parseMarkdownLines(text: String): List<MdLine> {
    val out = mutableListOf<MdLine>()
    val para = StringBuilder()
    fun flushPara() {
        if (para.isNotBlank()) out += MdLine.Para(para.toString().trim())
        para.clear()
    }
    val rawLines = text.split("\n")
    var i = 0
    while (i < rawLines.size) {
        val line = rawLines[i].trim()
        val heading = headingLineRegex.find(line)
        val bullet = bulletLineRegex.find(line)
        val numbered = numberedLineRegex.find(line)
        val isTableHeader = tableRowRegex.matches(line) &&
            i + 1 < rawLines.size && tableSeparatorRegex.matches(rawLines[i + 1].trim())
        when {
            isTableHeader -> {
                flushPara()
                val headers = splitTableCells(line)
                val rows = mutableListOf<List<String>>()
                i += 2 // skip header + separator
                while (i < rawLines.size && tableRowRegex.matches(rawLines[i].trim())) {
                    rows += splitTableCells(rawLines[i].trim())
                    i++
                }
                out += MdLine.Table(headers, rows)
                continue
            }
            line.isEmpty() -> flushPara()
            heading != null -> {
                flushPara()
                out += MdLine.Para("**${heading.groupValues[1]}**")
            }
            bullet != null -> {
                flushPara()
                out += MdLine.Bullet(bullet.groupValues[1])
            }
            numbered != null -> {
                flushPara()
                out += MdLine.Bullet(numbered.groupValues[2], ordinal = numbered.groupValues[1])
            }
            else -> {
                if (para.isNotEmpty()) para.append(" ")
                para.append(line)
            }
        }
        i++
    }
    flushPara()
    return out.ifEmpty { listOf(MdLine.Para(text)) }
}

private fun annotatedFromBold(text: String): AnnotatedString = buildAnnotatedString {
    var last = 0
    for (m in boldRegex.findAll(text)) {
        if (m.range.first > last) append(text.substring(last, m.range.first))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(m.groupValues[1]) }
        last = m.range.last + 1
    }
    if (last < text.length) append(text.substring(last))
}

sealed class Md {
    data class Text(val value: String) : Md()
    data class Code(val lang: String, val body: String) : Md()
    data class Image(val alt: String, val url: String) : Md()
}

// Was matched (and split off) by nothing at all — a generated image's `![prompt](url)` reply
// (see the backend's ScaleMax image-generation feature) fell straight through to MarkdownText's
// plain-paragraph path and rendered as literal `![prompt](https://...)` text, since there was no
// image concept anywhere in this parser and no image-loading library (Coil) in the project.
private val imageLineRegex = Regex("!\\[([^\\]]*)\\]\\((https?://[^)\\s]+)\\)")

fun splitMarkdown(src: String): List<Md> {
    val out = mutableListOf<Md>()
    // Alternation, so a fenced code block and a markdown image are both recognized as their own
    // top-level block in document order, same as web's react-markdown treats both as block-level.
    val regex = Regex("```([a-zA-Z0-9_+-]*)\\n([\\s\\S]*?)```|" + imageLineRegex.pattern)
    var last = 0
    for (m in regex.findAll(src)) {
        if (m.range.first > last) out += Md.Text(src.substring(last, m.range.first).trim())
        if (m.groupValues[1].isNotEmpty() || m.value.startsWith("```")) {
            out += Md.Code(m.groupValues[1].ifBlank { "code" }, m.groupValues[2].trimEnd())
        } else {
            out += Md.Image(m.groupValues[3], m.groupValues[4])
        }
        last = m.range.last + 1
    }
    if (last < src.length) {
        val rest = src.substring(last).trim()
        if (rest.isNotEmpty()) out += Md.Text(rest)
    }
    return out.ifEmpty { listOf(Md.Text(src)) }
}
