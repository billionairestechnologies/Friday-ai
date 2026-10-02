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
    /** File steps: which file, and the change itself (code for a new file, "- "/"+ " lines for an edit). */
    val path: String? = null,
    val code: String? = null,
    val added: Int? = null,
    val removed: Int? = null,
    /** kind "agent": a Build / Deep Research sub-agent — its job, its own live actions and its report. */
    val agent: SubAgentInfo? = null,
)

/** A parallel helper the agent handed work to (backend projectBuild/subagents.ts): kind is explore | research. */
data class SubAgentInfo(
    val title: String,
    val kind: String,
    val actions: List<SubAgentAction> = emptyList(),
    val report: String? = null,
)

data class SubAgentAction(val id: String, val label: String, val state: String)

/** A step from the stream or a saved message — shared so both keep the file-change fields. */
fun parseBuildStep(st: org.json.JSONObject): BuildStep = BuildStep(
    id = st.optString("id"),
    kind = st.optString("kind"),
    label = st.optString("label"),
    state = st.optString("state"),
    detail = st.optString("detail").ifBlank { null },
    path = st.optString("path").ifBlank { null },
    code = st.optString("code").ifBlank { null },
    added = if (st.has("added")) st.optInt("added") else null,
    removed = if (st.has("removed")) st.optInt("removed") else null,
    agent = st.optJSONObject("agent")?.let { a ->
        val arr = a.optJSONArray("actions")
        SubAgentInfo(
            title = a.optString("title"),
            kind = a.optString("kind", "explore"),
            actions = (0 until (arr?.length() ?: 0)).map { i ->
                val o = arr!!.getJSONObject(i)
                SubAgentAction(o.optString("id"), o.optString("label"), o.optString("state", "running"))
            },
            report = a.optString("report").ifBlank { null },
        )
    },
)

/** A Build permission prompt (backend projectBuild/approvals.ts). kind: file | command | connector | pr;
 *  state: pending | allowed | denied. [always] = asks even in Full auto. */
data class BuildApproval(
    val id: String,
    val kind: String,
    val title: String,
    val detail: String?,
    val always: Boolean,
    val state: String,
)

fun parseBuildApproval(o: org.json.JSONObject, defaultState: String = "pending") = BuildApproval(
    id = o.optString("id"),
    kind = o.optString("kind"),
    title = o.optString("title"),
    detail = o.optString("detail").ifBlank { null },
    always = o.optBoolean("always", false),
    state = o.optString("state").ifBlank { defaultState },
)

/** One row of the Build home / drawer (backend GET /api/build/sessions). status: running |
 *  needs_input | done | error | idle. */
data class BuildSessionSummary(
    val id: String,
    val title: String,
    val updatedAt: Long,
    val status: String,
    val activity: String,
    val repo: String?,
    val prUrl: String?,
)

/** One line of the Build Mode plan — todo | doing | done. */
data class BuildPlanItem(val text: String, val state: String)

/** Architecture + todo checklist Build Mode drafts before coding, updated live as items finish.
 *  [summary] = plain-language "what I'll build"; [status] = the approval round: "pending" (waiting
 *  for approve / changes), "approved", "revised" (replaced by a newer plan); null on older plans. */
data class BuildPlan(
    val architecture: String,
    val items: List<BuildPlanItem>,
    val summary: String? = null,
    val status: String? = null,
)

/** The server stores a plan message as this line + the plan text; the thread shows only the card. */
const val PLAN_MARKER = "Here's the plan. Approve it to start building, or tell me what to change."
/** The Approve button sends exactly this (backend plan.ts keys off it). */
const val PLAN_APPROVE_TEXT = "Approved — build it as planned."

fun parseBuildPlan(po: org.json.JSONObject?): BuildPlan? {
    if (po == null) return null
    val arr = po.optJSONArray("items") ?: org.json.JSONArray()
    return BuildPlan(
        architecture = po.optString("architecture"),
        items = (0 until arr.length()).map { k -> arr.getJSONObject(k).let { BuildPlanItem(it.optString("text"), it.optString("state")) } },
        summary = po.optString("summary").ifBlank { null },
        status = po.optString("status").ifBlank { null },
    )
}

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
    /** Normal chat answered a build request — shows "Open in Build" carrying this prompt. */
    val suggestBuildPrompt: String? = null,
)

enum class Role { User, Assistant }

data class ChatThread(
    val id: String,
    val title: String,
    val messages: List<ChatMessage> = emptyList(),
    val updatedAt: Long = System.currentTimeMillis(),
    /** "build" = a Build workspace session (listed under Build, every message goes to the Build agent). */
    val workspace: String? = null,
    /** Build Mode made a project in this chat (from before Build moved to its own tab) — also listed under Build. */
    val hasBuild: Boolean = false,
) {
    val isBuild: Boolean get() = workspace == "build" || hasBuild
}

data class FridayUser(
    val name: String,
    val email: String,
    val phone: String? = null,
    val birthday: String? = null,
    val instructions: String? = null,
    // The Privacy Policy/Terms version this account last agreed to — see PolicyConsentDialog.
    val policyVersion: String? = null,
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
    /** Normal chat got a build request: offer "Open in Build" (from {"t":"suggest_build",...}). */
    data class SuggestBuild(val prompt: String) : ChatEvent()
    /** Build permission prompt: pending until the user answers (from {"t":"approval",...}). */
    data class Approval(val approval: BuildApproval) : ChatEvent()
    /** The saved user message's real id (sent first) — Build restore points key off it. */
    data class Meta(val userMessageId: String) : ChatEvent()
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
