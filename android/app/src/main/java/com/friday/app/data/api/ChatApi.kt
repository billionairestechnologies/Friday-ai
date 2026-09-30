package com.friday.app.data.api

import com.friday.app.data.AgentStatus
import com.friday.app.data.BuildStep
import com.friday.app.data.ChatEvent
import com.friday.app.data.Mode
import com.friday.app.data.PendingAttachment
import com.friday.app.data.Source
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/** Real backend chat calls, used once a session exists. Mirrors data/ChatRepository.kt's mock Flow<ChatEvent> shape. */
/**
 * Turns one stream frame into a ChatEvent. Text / reasoning / sources are cumulative (the UI replaces
 * rather than appends), so the parser keeps the running totals. Shared by the live SSE stream and by
 * Build live resume, which replays the same frames from the event log.
 */
class FrameParser {
    private var text = ""
    private var reasoning = ""
    private val sources = mutableListOf<Source>()

    fun parse(json: JSONObject): ChatEvent? = when (json.optString("t")) {
        "status" -> ChatEvent.Status(json.optString("s"))
        "think", "reasoning" -> {
            reasoning += json.optString("c")
            ChatEvent.Reasoning(reasoning)
        }
        "text" -> {
            text += json.optString("c")
            ChatEvent.Token(text)
        }
        "cite" -> {
            sources += Source(title = json.optString("title").ifBlank { json.optString("u") }, url = json.optString("u"))
            ChatEvent.Sources(sources.toList())
        }
        "err" -> {
            text += "\n\n" + json.optString("c", "Something went wrong.")
            ChatEvent.Token(text)
        }
        "agent" -> ChatEvent.Agent(
            AgentStatus(
                slug = json.optString("slug"),
                model = json.optString("model"),
                state = json.optString("state"),
                error = json.optString("error").ifBlank { null },
            ),
        )
        "step" -> ChatEvent.Step(com.friday.app.data.parseBuildStep(json))
        "preview" -> ChatEvent.Preview(json.optString("url"), json.optInt("port"))
        "plan" -> com.friday.app.data.parseBuildPlan(json)?.let { ChatEvent.Plan(it) }
        "suggest_build" -> ChatEvent.SuggestBuild(json.optString("prompt"))
        "approval" -> ChatEvent.Approval(com.friday.app.data.parseBuildApproval(json))
        "meta" -> json.optString("userMessageId").ifBlank { null }?.let { ChatEvent.Meta(it) }
        "build" -> ChatEvent.BuildMeta(
            elapsedMs = json.optLong("elapsedMs").takeIf { it > 0 },
            zipBytes = json.optLong("zipBytes").takeIf { it > 0 },
            zipName = json.optString("zipName").ifBlank { null },
        )
        "ask" -> ChatEvent.Ask(com.friday.app.data.parseBuildAsk(json.optJSONArray("questions")))
        else -> null
    }
}

object ChatApi {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    /** POST /api/chat/conversations — a real conversation id is required before streaming into it.
     *  [mode] "single" needs [modelId]/[providerSlug]; "auto"/"teamup" need neither — the backend
     *  picks/consults models itself for those. */
    suspend fun createConversation(modelId: String? = null, providerSlug: String? = null, mode: String = "single", workspace: String? = null): String? = kotlinx.coroutines.withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().apply {
                put("mode", mode)
                // "build" = a Build workspace session: every message goes to the Build agent.
                if (workspace == "build") put("workspace", "build")
                if (mode == "single") {
                    if (!modelId.isNullOrBlank()) put("modelId", modelId)
                    if (!providerSlug.isNullOrBlank()) put("providerSlug", providerSlug)
                }
            }
            val request = Request.Builder()
                .url(ApiClient.BASE_URL + "chat/conversations")
                .post(body.toString().toRequestBody(JSON))
                .build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val text = resp.body?.string().orEmpty()
                JSONObject(text).optJSONObject("conversation")?.optString("id")?.ifBlank { null }
            }
        }.getOrNull()
    }

    /** PATCH /api/chat/conversations/:id — switches an EXISTING conversation to a different
     *  model/mode so the next reply comes from it, without starting a new conversation (which
     *  would throw away the whole history the backend sends the model as context). */
    suspend fun updateConversation(conversationId: String, modelId: String? = null, providerSlug: String? = null, mode: String = "single"): Boolean = kotlinx.coroutines.withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().apply {
                put("mode", mode)
                if (mode == "single") {
                    if (!modelId.isNullOrBlank()) put("modelId", modelId)
                    if (!providerSlug.isNullOrBlank()) put("providerSlug", providerSlug)
                }
            }
            val request = Request.Builder()
                .url(ApiClient.BASE_URL + "chat/conversations/" + conversationId)
                .patch(body.toString().toRequestBody(JSON))
                .build()
            ApiClient.authed.newCall(request).execute().use { resp -> resp.isSuccessful }
        }.getOrDefault(false)
    }

    /** POST /api/chat/conversations/:id/stop — the backend keeps generating after the client
     *  disconnects, so an explicit Stop has to be sent to it. */
    suspend fun stopMessage(conversationId: String): Boolean = kotlinx.coroutines.withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url(ApiClient.BASE_URL + "chat/conversations/" + conversationId + "/stop")
                .post("{}".toRequestBody(JSON))
                .build()
            ApiClient.authed.newCall(request).execute().use { resp -> resp.isSuccessful }
        }.getOrDefault(false)
    }

    /** POST /api/chat/conversations/:id/messages/stream — text/event-stream, "t"-discriminated JSON frames.
     * [attachments] (max 4, enforced server-side) ride inline in this same request body as base64 data
     * URLs — the backend has no separate upload endpoint for chat attachments. */
    fun streamMessage(conversationId: String, content: String, modes: Set<Mode>, attachments: List<PendingAttachment> = emptyList(), effort: String? = null, permissionMode: String? = null): Flow<ChatEvent> = flow {
        val body = JSONObject().apply {
            put("content", content)
            put("inputMode", "text")
            put("think", Mode.Think in modes)
            put("webSearch", Mode.Search in modes)
            put("canvas", Mode.Canvas in modes)
            put("research", Mode.Research in modes)
            // Build workspace effort picker (low | medium | high) — ignored outside Build sessions.
            if (effort != null) put("effort", effort)
            if (permissionMode != null) put("permissionMode", permissionMode)
            if (attachments.isNotEmpty()) {
                put(
                    "attachments",
                    JSONArray(
                        attachments.take(4).map { a ->
                            JSONObject().apply {
                                put("mime", a.mime)
                                put("dataUrl", a.dataUrl)
                                put("name", a.name)
                                put("size", a.size)
                                put("kind", a.kind)
                            }
                        },
                    ),
                )
            }
        }
        val request = Request.Builder()
            .url(ApiClient.BASE_URL + "chat/conversations/$conversationId/messages/stream")
            .post(body.toString().toRequestBody(JSON))
            .build()
        val call = ApiClient.streaming.newCall(request)
        try {
            call.execute().use { resp ->
                if (!resp.isSuccessful) {
                    emit(ChatEvent.Token("Sorry, something went wrong talking to Friday (${resp.code})."))
                    return@use
                }
                val source = resp.body?.source() ?: return@use
                val parser = FrameParser()
                val block = StringBuilder()
                var done = false
                while (!done && !source.exhausted() && currentCoroutineContext().isActive) {
                    val line = source.readUtf8Line() ?: break
                    if (line.isEmpty()) {
                        if (block.isNotEmpty()) {
                            val payload = block.toString()
                            block.setLength(0)
                            val json = runCatching { JSONObject(payload) }.getOrNull() ?: continue
                            if (json.optString("t") == "done") done = true else parser.parse(json)?.let { emit(it) }
                        }
                    } else if (line.startsWith("data:")) {
                        val payload = line.removePrefix("data:").trimStart()
                        if (block.isNotEmpty()) block.append('\n')
                        block.append(payload)
                    }
                }
            }
        } catch (e: IOException) {
            // The socket dropped locally (network blip, app backgrounded/killed) — the backend
            // keeps generating and persists the full reply regardless (see CLAUDE.md's
            // activeGenerations note). Overwriting whatever text already streamed in with an error
            // string here used to make a perfectly fine in-progress reply look permanently broken
            // the moment the user closed the app; the flag lets the UI refetch the real answer
            // instead once it's back.
            emit(ChatEvent.Disconnected)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            emit(ChatEvent.Token("Something went wrong: ${e.message ?: e.javaClass.simpleName}"))
        } finally {
            emit(ChatEvent.Done)
            call.cancel()
        }
    }.flowOn(Dispatchers.IO)
}
