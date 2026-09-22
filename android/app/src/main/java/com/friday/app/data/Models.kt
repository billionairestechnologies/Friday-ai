package com.friday.app.data

enum class Mode { Search, Think, Canvas }

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
    val attachments: List<PendingAttachment> = emptyList(),
    /** Modes active on the composer when this message was sent — an assistant message only shows
     *  its full Thought Trail card when Think/Search/Canvas was actually toggled on; a plain reply
     *  (no mode) goes straight from the brief loading pill to the answer, one line, no trail. */
    val modesUsed: Set<Mode> = emptySet(),
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
    data object Done : ChatEvent()
}

fun placeholderFor(modes: Set<Mode>): String = when {
    Mode.Canvas in modes -> "Create on canvas…"
    Mode.Think in modes -> "Think deeply…"
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
