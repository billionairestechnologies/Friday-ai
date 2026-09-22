package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject

data class UsageBreakdown(val used: Int, val limit: Int)

data class UsageQuota(
    val plan: String,
    val resetAt: Long,
    val weekly: UsageBreakdown?,
    val monthly: UsageBreakdown?,
    val rolling: UsageBreakdown?,
)

/** GET /api/usage/quota — backs both the Settings > Usage bars and the Billing plan/renewal row. */
object UsageApi {
    suspend fun quota(): UsageQuota? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "usage/quota").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val text = resp.body?.string().orEmpty()
                val json = JSONObject(text)
                val status = json.optJSONObject("status") ?: json
                fun breakdown(key: String): UsageBreakdown? {
                    val o = json.optJSONObject(key) ?: status.optJSONObject(key) ?: return null
                    return UsageBreakdown(used = o.optInt("used"), limit = o.optInt("limit"))
                }
                UsageQuota(
                    plan = status.optString("plan").ifBlank { "Free" },
                    resetAt = status.optLong("resetAt", status.optLong("reset_at", 0L)),
                    weekly = breakdown("weekly"),
                    monthly = breakdown("monthly"),
                    rolling = breakdown("rolling"),
                )
            }
        }.getOrNull()
    }
}
