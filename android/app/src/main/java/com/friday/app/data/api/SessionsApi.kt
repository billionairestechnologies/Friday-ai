package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** One place this account is signed in: a browser, a phone app, or FridayX (supabase 0068). */
data class DeviceSession(
    val id: String,
    val kind: String,
    val platform: String,
    val client: String,
    val ipPrefix: String?,
    val createdAt: String,
    val lastSeenAt: String?,
    val current: Boolean,
)

/** GET /api/sessions, DELETE /api/sessions/:id?kind=, POST /api/sessions/revoke-others (backend routes/sessions.ts). */
object SessionsApi {
    suspend fun list(): List<DeviceSession>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "sessions").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("sessions") ?: return@use emptyList()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    DeviceSession(
                        id = o.optString("id"), kind = o.optString("kind", "app"), platform = o.optString("platform"),
                        client = o.optString("client"), ipPrefix = o.optString("ipPrefix").ifBlank { null }.takeIf { !o.isNull("ipPrefix") },
                        createdAt = o.optString("createdAt"), lastSeenAt = if (o.isNull("lastSeenAt")) null else o.optString("lastSeenAt"),
                        current = o.optBoolean("current"),
                    )
                }
            }
        }.getOrNull()
    }

    suspend fun signOut(s: DeviceSession): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "sessions/${s.id}?kind=${s.kind}").delete().build()
            ApiClient.authed.newCall(request).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun signOutOthers(): Int? = withContext(Dispatchers.IO) {
        runCatching {
            val body = "{}".toRequestBody("application/json".toMediaType())
            val request = Request.Builder().url(ApiClient.BASE_URL + "sessions/revoke-others").post(body).build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (resp.isSuccessful) JSONObject(resp.body?.string().orEmpty()).optInt("signedOut", 0) else null
            }
        }.getOrNull()
    }
}
