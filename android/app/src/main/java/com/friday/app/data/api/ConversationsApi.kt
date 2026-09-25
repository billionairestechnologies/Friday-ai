package com.friday.app.data.api

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
                    )
                }
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
                    ChatMessage(
                        id = o.optString("id").ifBlank { "m-$i" },
                        role = role,
                        content = o.optString("content"),
                        sources = sources,
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
