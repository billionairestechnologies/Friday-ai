package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject

data class UpdateInfo(val version: String, val url: String, val notes: String?)

/** GET /api/app/version?platform=android (backend/src/routes/app.ts) — real endpoint, backed by
 * Railway's FRIDAY_LATEST_VERSION_ANDROID/FRIDAY_DOWNLOAD_ANDROID/FRIDAY_LATEST_NOTES_ANDROID env
 * vars. Any failure or missing/older version is treated as "no update available" rather than
 * surfaced as an error, since this is a best-effort check, not a core feature. */
object UpdateApi {
    suspend fun check(currentVersion: String): UpdateInfo? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "app/version?platform=android").get().build()
            ApiClient.plain.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val json = JSONObject(resp.body?.string().orEmpty())
                val latest = json.optString("latestVersion", json.optString("version"))
                val url = json.optString("url", json.optString("downloadUrl"))
                if (latest.isBlank() || url.isBlank() || !isNewer(latest, currentVersion)) return@use null
                UpdateInfo(version = latest, url = url, notes = json.optString("notes").ifBlank { null })
            }
        }.getOrNull()
    }

    private fun isNewer(remote: String, current: String): Boolean {
        val r = remote.substringBefore("-").split(".").mapNotNull { it.toIntOrNull() }
        val c = current.substringBefore("-").split(".").mapNotNull { it.toIntOrNull() }
        for (i in 0 until maxOf(r.size, c.size)) {
            val rv = r.getOrElse(i) { 0 }
            val cv = c.getOrElse(i) { 0 }
            if (rv != cv) return rv > cv
        }
        return false
    }
}
