package com.friday.app.data.api

import com.friday.app.data.BuildInfo
import com.friday.app.data.BuildStep
import com.friday.app.data.ChatMessage
import com.friday.app.data.ChatThread
import com.friday.app.data.Role
import com.friday.app.data.Source
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

/** Real backend conversation sync, used once a session exists. */
object ConversationsApi {

    /** GET /api/chat/conversations — the drawer's recent-chats list. */
    /** Null means the request failed (keep the current list); an empty list means genuinely no chats. */
    suspend fun list(): List<ChatThread>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "chat/conversations").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val text = resp.body?.string().orEmpty()
                val arr = JSONObject(text).optJSONArray("conversations") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    ChatThread(
                        id = o.optString("id"),
                        title = o.optString("title").ifBlank { "New chat" },
                        messages = emptyList(),
                        updatedAt = runCatching { java.time.Instant.parse(o.optString("updated_at")).toEpochMilli() }
                            .getOrDefault(System.currentTimeMillis()),
                        workspace = o.optString("workspace").ifBlank { null },
                        hasBuild = o.optBoolean("has_build", false),
                    )
                }
            }
        }.getOrNull()
    }

    /** GET /api/chat/conversations/:id/live?after= — the current (or last) turn's logged stream frames and whether it is
     *  still running, so any device can follow a reply that was started elsewhere or before the app was closed. Null on failure. */
    suspend fun live(conversationId: String, after: Long): Pair<List<Pair<Long, JSONObject>>, Boolean>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "chat/conversations/$conversationId/live?after=$after").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val obj = JSONObject(resp.body?.string().orEmpty())
                val arr = obj.optJSONArray("events") ?: JSONArray()
                (0 until arr.length()).map { i -> arr.getJSONObject(i).let { it.optLong("id") to it.getJSONObject("event") } } to obj.optBoolean("running")
            }
        }.getOrNull()
    }

    /** GET /api/chat/conversations/:id/messages — fetched lazily when a synced thread is opened. */
    suspend fun messages(conversationId: String): List<ChatMessage> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url(ApiClient.BASE_URL + "chat/conversations/$conversationId/messages")
                .get()
                .build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use emptyList()
                val text = resp.body?.string().orEmpty()
                val arr = JSONObject(text).optJSONArray("messages") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    val role = if (o.optString("role") == "user") Role.User else Role.Assistant
                    val citeArr = o.optJSONArray("sources") ?: JSONArray()
                    val sources = (0 until citeArr.length()).map { j ->
                        val c = citeArr.getJSONObject(j)
                        Source(title = c.optString("title").ifBlank { c.optString("u") }, url = c.optString("u"))
                    }
                    val buildObj = o.optJSONObject("build")
                    val build = buildObj?.let { b ->
                        val stepArr = b.optJSONArray("steps") ?: JSONArray()
                        BuildInfo(
                            plan = com.friday.app.data.parseBuildPlan(b.optJSONObject("plan")),
                            ask = com.friday.app.data.parseBuildAsk(b.optJSONArray("ask")),
                            steps = (0 until stepArr.length()).map { k ->
                                val st = stepArr.getJSONObject(k)
                                com.friday.app.data.parseBuildStep(st)
                            },
                            previewUrl = b.optString("previewUrl").ifBlank { null },
                            port = b.optInt("port").takeIf { it > 0 },
                            elapsedMs = b.optLong("elapsedMs").takeIf { it > 0 },
                            zipBytes = b.optLong("zipBytes").takeIf { it > 0 },
                            zipName = b.optString("zipName").ifBlank { null },
                        )
                    }
                    // A turn the server rejected before generating anything (e.g. the plan/tier
                    // gate) is persisted with empty content and the message in `error` instead —
                    // the live stream already folds this into content as it arrives (ChatApi.kt's
                    // "err" handling), so a reload does the same instead of showing a blank bubble.
                    val errorText = o.optString("error").ifBlank { null }
                    val rawContent = o.optString("content")
                    ChatMessage(
                        id = o.optString("id").ifBlank { "m-$i" },
                        role = role,
                        content = if (errorText == null) rawContent else if (rawContent.isBlank()) errorText else "$rawContent\n\n$errorText",
                        sources = sources,
                        files = com.friday.app.data.parseGeneratedFiles(o.optJSONArray("files")),
                        // A suggestion-only build object (no steps/plan/ask) isn't a Build turn.
                        build = build?.takeUnless { it.steps.isEmpty() && it.plan == null && it.ask.isEmpty() && it.previewUrl == null && it.zipBytes == null },
                        suggestBuildPrompt = buildObj?.optJSONObject("suggestBuild")?.optString("prompt")?.ifBlank { null },
                    )
                }
            }
        }.getOrElse { emptyList() }
    }

    /** DELETE /api/chat/conversations/:id */
    suspend fun delete(conversationId: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url(ApiClient.BASE_URL + "chat/conversations/$conversationId")
                .delete()
                .build()
            ApiClient.authed.newCall(request).execute().use { it.isSuccessful }
        }.getOrElse { false }
    }

    /** DELETE /api/chat/conversations — wipes the whole synced history, used by Settings > Data Controls. */
    suspend fun clearAll(): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "chat/conversations").delete().build()
            ApiClient.authed.newCall(request).execute().use { it.isSuccessful }
        }.getOrElse { false }
    }
}
