package com.friday.app.data

enum class Mode { Search, Think, Canvas, Research }

/** Sentinel remote-model ids for the two non-single conversation modes — mirrors the web app's
 *  AUTO_MODEL_ID/TEAMUP_MODEL_ID (exactly (frontend/src/lib/chat/models.ts), so both surfaces
 *  agree on what these mean when they show up as a "modelId". */
const val AUTO_MODEL_ID = "mode:auto"
const val TEAMUP_MODEL_ID = "mode:teamup"

/** One model's progress within a Team Up turn — mirrors the backend's {"t":"agent",...} frame. */
data class AgentStatus(
    val slug: String,
    val model: String,
    val state: String, // "start" | "done" | "error"
    val error: String? = null,
)

enum class ModelId(val label: String, val hint: String) {
    Auto("Auto", "Picks the best model for the task"),
    Flash("Friday Flash", "Fast everyday answers"),
    Pro("Friday Pro", "Deeper reasoning and code"),
}

enum class Sheet {
    None, Auth, Welcome, Signup, Model, Attach, Plugins
}

enum class AuthStep { Form, Otp }

data class Source(
    val title: String,
    val url: String,
    val snippet: String = "",
)

/** A file staged in the composer, or already attached to a sent message. Mirrors the backend's
 * message_attachments contract exactly: {mime, dataUrl, name, size, kind} — [dataUrl] is a full
 * `data:<mime>;base64,<...>` string, sent inline in the chat-stream request body (there is no
 * separate upload endpoint; see ChatApi.streamMessage). */
data class PendingAttachment(
    val id: String,
    val name: String,
    val mime: String,
    val size: Long,
    val kind: String,
    val dataUrl: String,
)

/** One thing Build Mode did — "Ran command · Install dependencies", "Wrote src/App.jsx". */
data class BuildStep(
    val id: String,
    val kind: String, // write | run | start | read
    val label: String,
    val state: String, // running | ok | error
    val detail: String? = null,
)

/** One line of the Build Mode plan — todo | doing | done. */
data class BuildPlanItem(val text: String, val state: String)

/** Architecture + todo checklist Build Mode drafts before coding, updated live as items finish. */
data class BuildPlan(val architecture: String, val items: List<BuildPlanItem>)

data class BuildAskOption(val label: String, val description: String, val recommended: Boolean)
data class BuildAskQuestion(val id: String, val question: String, val options: List<BuildAskOption>)

fun parseBuildAsk(arr: org.json.JSONArray?): List<BuildAskQuestion> {
    if (arr == null) return emptyList()
    return (0 until arr.length()).mapNotNull { i ->
        val q = arr.optJSONObject(i) ?: return@mapNotNull null
        val oa = q.optJSONArray("options")
        val opts = if (oa == null) emptyList() else (0 until oa.length()).mapNotNull { k ->
            val o = oa.optJSONObject(k) ?: return@mapNotNull null
            BuildAskOption(o.optString("label"), o.optString("description"), o.optBoolean("recommended", false))
        }
        BuildAskQuestion(q.optString("id").ifBlank { "q${i + 1}" }, q.optString("question"), opts)
    }
}

/** What Build Mode did for a message: its steps plus the live preview it produced (if any). */
data class BuildInfo(
    val plan: BuildPlan? = null,
    val ask: List<BuildAskQuestion> = emptyList(),
    val steps: List<BuildStep> = emptyList(),
    val previewUrl: String? = null,
    val port: Int? = null,
    val elapsedMs: Long? = null,
    val zipBytes: Long? = null,
    val zipName: String? = null,
)

data class ChatMessage(
    val id: String,
    val role: Role,
    val content: String = "",
    val thinkingSteps: List<String> = emptyList(),
    val thinkingLabel: String? = null,
    /** Real backend phase from {"t":"status","s":...} frames, e.g. "thinking" / "searching". Null for the mock path. */
    val status: String? = null,
    val sources: List<Source> = emptyList(),
    /** Accumulated chain-of-thought text from {"t":"think"} frames, if the backend sends any. */
    val reasoning: String = "",
    val canvasHtml: String? = null,
    val isStreaming: Boolean = false,
    /** The local stream dropped mid-reply (network blip, app backgrounded/killed) rather than a
     *  clean server "done" — the content here may be incomplete or stale. Cleared by whatever
     *  refetches the real, server-persisted reply (see FridayViewModel.onAppForegrounded/openChat). */
    val disconnected: Boolean = false,
    val attachments: List<PendingAttachment> = emptyList(),
    /** Modes active on the composer when this message was sent — an assistant message only shows
     *  its full Thought Trail card when Think/Search/Canvas was actually toggled on; a plain reply
     *  (no mode) goes straight from the brief loading pill to the answer, one line, no trail. */
    val modesUsed: Set<Mode> = emptySet(),
    /** Populated only for a Team Up turn, from {"t":"agent",...} frames — one entry per model
     *  consulted, upserted by (slug, model) as its state changes. */
    val agents: List<AgentStatus> = emptyList(),
    val build: BuildInfo? = null,
)

enum class Role { User, Assistant }

data class ChatThread(
    val id: String,
    val title: String,
    val messages: List<ChatMessage> = emptyList(),
    val updatedAt: Long = System.currentTimeMillis(),
)

data class FridayUser(
    val name: String,
    val email: String,
    val phone: String? = null,
    val birthday: String? = null,
    val instructions: String? = null,
)

sealed class ChatEvent {
    data class Thinking(val label: String, val steps: List<String>) : ChatEvent()
    /** Real backend phase update, e.g. "thinking" / "searching" (from {"t":"status","s":...}). */
    data class Status(val phase: String) : ChatEvent()
    data class Sources(val items: List<Source>) : ChatEvent()
    /** Accumulated chain-of-thought text, from {"t":"think"} frames (if the backend sends any). */
    data class Reasoning(val text: String) : ChatEvent()
    data class Token(val text: String) : ChatEvent()
    data class CanvasUpdate(val html: String) : ChatEvent()
    /** One model's progress within a Team Up turn, from {"t":"agent",...} frames. */
    data class Agent(val status: AgentStatus) : ChatEvent()
    /** Build Mode step, upserted by id as it goes running → ok/error (from {"t":"step",...}). */
    data class Step(val step: BuildStep) : ChatEvent()
    /** Build Mode started a server and it is reachable (from {"t":"preview",...}). */
    data class Preview(val url: String, val port: Int) : ChatEvent()
    /** End-of-build summary: how long it took and the project zip's size/name (from {"t":"build",...}). */
    data class Plan(val plan: BuildPlan) : ChatEvent()
    data class BuildMeta(val elapsedMs: Long?, val zipBytes: Long?, val zipName: String?) : ChatEvent()
    data class Ask(val questions: List<BuildAskQuestion>) : ChatEvent()
    /** The local socket dropped (network blip, app backgrounded/killed mid-stream) — NOT a
     *  server-side failure. The backend keeps generating and persists the full reply regardless
     *  (see activeGenerations.ts), so this must never overwrite whatever text already streamed in;
     *  it just flags the message so a later refetch (open/foreground) replaces it with the truth. */
    data object Disconnected : ChatEvent()
    data object Done : ChatEvent()
}

fun placeholderFor(modes: Set<Mode>): String = when {
    Mode.Canvas in modes -> "Create on canvas…"
    Mode.Think in modes -> "Think deeply…"
    Mode.Research in modes -> "What should I research?"
    Mode.Search in modes -> "Search the web…"
    else -> "What do you want to know?"
}

fun nameFromEmail(email: String): String {
    val local = email.substringBefore("@").ifBlank { "You" }
    return local
        .replace(Regex("[._-]+"), " ")
        .split(" ")
        .filter { it.isNotBlank() }
        .joinToString(" ") { part ->
            part.replaceFirstChar { it.uppercase() }
        }
        .ifBlank { "You" }
}

fun titleFrom(text: String): String {
    val t = text.replace(Regex("\\s+"), " ").trim()
    return if (t.length > 42) t.take(42) + "…" else t.ifBlank { "New chat" }
}

interface ChatServing {
    fun send(prompt: String, modes: Set<Mode>): kotlinx.coroutines.flow.Flow<ChatEvent>
}
