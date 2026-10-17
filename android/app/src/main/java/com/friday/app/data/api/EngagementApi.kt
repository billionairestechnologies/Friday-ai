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
    /** Each version shows at most once per person (supabase 0062). */
    val version: Int = 1,
)

/** A personal notification: inbox item, or a one-time popup when a benefit was granted. */
data class UserNotification(
    val id: String,
    val kind: String,
    val title: String,
    val body: String,
    val createdAt: String,
    val read: Boolean = false,
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
                        version = o.optInt("version", 1),
                    )
                }.filter { it.id.isNotBlank() }
            }
        }.getOrDefault(emptyList())
    }

    private fun post(path: String, body: JSONObject): JSONObject? {
        val request = Request.Builder().url(ApiClient.BASE_URL + path).post(body.toString().toRequestBody(JSON)).build()
        return ApiClient.authed.newCall(request).execute().use { resp -> if (resp.isSuccessful) JSONObject(resp.body?.string().orEmpty().ifBlank { "{}" }) else null }
    }

    /** Claims the right to show this version now — false if another device or tab already showed it. */
    suspend fun claim(a: Announcement): Boolean = withContext(Dispatchers.IO) {
        runCatching { post("updates/claim", JSONObject().put("id", a.id).put("version", a.version).put("platform", "android"))?.optBoolean("show") == true }.getOrDefault(false)
    }

    /** What the person did with a shown update: "acknowledged", "dismissed" or "clicked". */
    suspend fun act(a: Announcement, state: String) = withContext(Dispatchers.IO) {
        runCatching { post("updates/act", JSONObject().put("id", a.id).put("version", a.version).put("state", state)) }
    }

    private fun notification(o: JSONObject) = UserNotification(
        id = o.optString("id"), kind = o.optString("kind"), title = o.optString("title"), body = o.optString("body"),
        createdAt = o.optString("createdAt"), read = o.optBoolean("read", false),
    )

    /** Benefit popups waiting to be shown once (credits granted, programme approved). */
    suspend fun popups(): List<UserNotification> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "notifications/popups").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use emptyList()
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("popups") ?: return@use emptyList()
                (0 until arr.length()).map { notification(arr.getJSONObject(it)) }
            }
        }.getOrDefault(emptyList())
    }

    suspend fun claimPopup(id: String): Boolean = withContext(Dispatchers.IO) {
        runCatching { post("notifications/$id/claim", JSONObject())?.optBoolean("show") == true }.getOrDefault(false)
    }

    suspend fun acknowledge(id: String) = withContext(Dispatchers.IO) { runCatching { post("notifications/$id/ack", JSONObject()) } }

    /** The inbox: personal notifications (newest first) and the unread count. */
    suspend fun inbox(): Pair<List<UserNotification>, Int> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "notifications?platform=android").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use Pair(emptyList<UserNotification>(), 0)
                val o = JSONObject(resp.body?.string().orEmpty())
                val arr = o.optJSONArray("items") ?: JSONArray()
                Pair((0 until arr.length()).map { notification(arr.getJSONObject(it)) }, o.optInt("unread", 0))
            }
        }.getOrDefault(Pair(emptyList(), 0))
    }

    suspend fun markAllRead() = withContext(Dispatchers.IO) { runCatching { post("notifications/read", JSONObject().put("all", true)) } }

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
