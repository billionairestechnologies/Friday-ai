package com.friday.app.data.api

import com.friday.app.data.AgentStatus
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
object ChatApi {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    /** POST /api/chat/conversations — a real conversation id is required before streaming into it.
     *  [mode] "single" needs [modelId]/[providerSlug]; "auto"/"teamup" need neither — the backend
     *  picks/consults models itself for those. */
    suspend fun createConversation(modelId: String? = null, providerSlug: String? = null, mode: String = "single"): String? = kotlinx.coroutines.withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().apply {
                put("mode", mode)
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
    fun streamMessage(conversationId: String, content: String, modes: Set<Mode>, attachments: List<PendingAttachment> = emptyList()): Flow<ChatEvent> = flow {
        val body = JSONObject().apply {
            put("content", content)
            put("inputMode", "text")
            put("think", Mode.Think in modes)
            put("webSearch", Mode.Search in modes)
            put("canvas", Mode.Canvas in modes)
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
                var text = ""
                var reasoning = ""
                val sources = mutableListOf<Source>()
                val block = StringBuilder()
                var done = false
                while (!done && !source.exhausted() && currentCoroutineContext().isActive) {
                    val line = source.readUtf8Line() ?: break
                    if (line.isEmpty()) {
                        if (block.isNotEmpty()) {
                            val payload = block.toString()
                            block.setLength(0)
                            val json = runCatching { JSONObject(payload) }.getOrNull()
                            when (json?.optString("t")) {
                                "status" -> emit(ChatEvent.Status(json.optString("s")))
                                "think", "reasoning" -> {
                                    reasoning += json.optString("c")
                                    emit(ChatEvent.Reasoning(reasoning))
                                }
                                "text" -> {
                                    text += json.optString("c")
                                    emit(ChatEvent.Token(text))
                                }
                                "cite" -> {
                                    sources += Source(
                                        title = json.optString("title").ifBlank { json.optString("u") },
                                        url = json.optString("u"),
                                    )
                                    emit(ChatEvent.Sources(sources.toList()))
                                }
                                "err" -> {
                                    text += "\n\n" + json.optString("c", "Something went wrong.")
                                    emit(ChatEvent.Token(text))
                                }
                                "agent" -> emit(
                                    ChatEvent.Agent(
                                        AgentStatus(
                                            slug = json.optString("slug"),
                                            model = json.optString("model"),
                                            state = json.optString("state"),
                                            error = json.optString("error").ifBlank { null },
                                        ),
                                    ),
                                )
                                "done" -> done = true
                            }
                        }
                    } else if (line.startsWith("data:")) {
                        val payload = line.removePrefix("data:").trimStart()
                        if (block.isNotEmpty()) block.append('\n')
                        block.append(payload)
                    }
                }
            }
        } catch (e: IOException) {
            emit(ChatEvent.Token("Connection lost: ${e.message ?: "network error"}"))
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
