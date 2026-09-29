package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** A product update published from the Team Console — shown once per user (backend records views). */
data class Announcement(
    val id: String,
    val title: String,
    val body: String,
    val imageUrl: String?,
    val ctaLabel: String?,
    val ctaUrl: String?,
    val kind: String,
)

/**
 * GET /api/updates/pending?platform=android and POST /api/updates/seen (backend
 * routes/engagement.ts). Best-effort like UpdateApi: any failure means "nothing to show", never an
 * error — a What's New popup must never get in the way of using the app.
 */
object EngagementApi {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    private fun JSONObject.str(key: String): String? = optString(key).takeIf { it.isNotBlank() && it != "null" }

    suspend fun pending(): List<Announcement> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "updates/pending?platform=android").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use emptyList()
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("updates") ?: return@use emptyList()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    Announcement(
                        id = o.optString("id"),
                        title = o.optString("title"),
                        body = o.optString("body"),
                        imageUrl = o.str("imageUrl"),
                        ctaLabel = o.str("ctaLabel"),
                        ctaUrl = o.str("ctaUrl"),
                        kind = o.optString("kind", "feature"),
                    )
                }.filter { it.id.isNotBlank() }
            }
        }.getOrDefault(emptyList())
    }

    suspend fun markSeen(ids: List<String>, clickedId: String?) = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().apply {
                put("ids", JSONArray(ids))
                if (clickedId != null) put("clickedId", clickedId)
            }
            val request = Request.Builder().url(ApiClient.BASE_URL + "updates/seen").post(body.toString().toRequestBody(JSON)).build()
            ApiClient.authed.newCall(request).execute().close()
        }
    }
}
