package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject

/** One auto-saved code block / page / image from a chat reply (backend GET /api/library). */
data class LibraryItem(
    val id: String,
    val title: String,
    val kind: String,
    val lang: String?,
    val category: String,
    val createdAt: String,
    /** Short preview in lists; the full body (or the image URL) after [LibraryApi.get]. */
    val content: String,
)

object LibraryApi {
    private fun parse(o: JSONObject, content: String) = LibraryItem(
        id = o.optString("id"),
        title = o.optString("title"),
        kind = o.optString("kind"),
        lang = o.optString("lang").takeIf { it.isNotBlank() && it != "null" },
        category = o.optString("category"),
        createdAt = o.optString("created_at"),
        content = content,
    )

    /** Null = the request failed (so the UI can say so instead of showing an empty library). */
    suspend fun list(): List<LibraryItem>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "library").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("items") ?: return@use emptyList()
                (0 until arr.length()).map { i -> arr.getJSONObject(i).let { parse(it, it.optString("preview")) } }
            }
        }.getOrNull()
    }

    suspend fun get(id: String): LibraryItem? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "library/$id").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val o = JSONObject(resp.body?.string().orEmpty()).getJSONObject("item")
                parse(o, o.optString("content"))
            }
        }.getOrNull()
    }

    suspend fun delete(id: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "library/$id").delete().build()
            ApiClient.authed.newCall(request).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }
}
