package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/** One quota window: tokens used / allowed and when it resets (backend services/quota — buckets carry their own resetAt). */
data class UsageBreakdown(val used: Double, val limit: Double, val resetAt: String? = null) {
    /** Clamped both ways like the web: bonus grants/refunds can push a counter below 0 or above the limit. */
    val pct: Int get() = if (limit > 0) (used / limit * 100).roundToInt().coerceIn(0, 100) else 0
}

data class UsageBreakdownEntry(val type: String, val percent: Int)

data class PlanEntitlements(
    val buildMode: Boolean,
    val buildMaxRounds: Int,
    val deepResearchPerDay: Int,
    val documentsPerDay: Int,
    val customSkills: Int,
    val libraryStorageMb: Int,
    val teamUpModels: Int,
    val mcpServers: Int,
    val automations: Int,
    val prioritySupport: Boolean,
)

data class UsageQuota(
    val plan: String,
    val isEnterprise: Boolean,
    val resetAt: Long,
    val weekly: UsageBreakdown?,
    val monthly: UsageBreakdown?,
    val rolling: UsageBreakdown?,
    val orgPool: UsageBreakdown? = null,
    val orgSeats: Int = 0,
    val memberCap: UsageBreakdown? = null,
    val breakdown: List<UsageBreakdownEntry> = emptyList(),
    val rollingBreakdown: List<UsageBreakdownEntry> = emptyList(),
    val monthlyBreakdown: List<UsageBreakdownEntry> = emptyList(),
    val entitlements: PlanEntitlements? = null,
    /** Unspent bonus-credit tokens on top of the month's allowance (supabase 0060). */
    val credits: Double = 0.0,
    /** This period's usage that credits paid for. */
    val creditDrawn: Double = 0.0,
)

/** GET /api/usage/quota — backs both the Settings > Usage pane and the Billing plan/renewal row. */
object UsageApi {
    suspend fun quota(): UsageQuota? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "usage/quota").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val json = JSONObject(resp.body?.string().orEmpty())
                // Newer servers nest the buckets under "status"; older ones put them at the top level.
                val status = json.optJSONObject("status") ?: json
                fun bucket(key: String): UsageBreakdown? {
                    val o = status.optJSONObject(key) ?: json.optJSONObject(key) ?: return null
                    if (!o.has("used") || !o.has("limit")) return null
                    return UsageBreakdown(o.optDouble("used"), o.optDouble("limit"), o.optString("resetAt").ifBlank { null })
                }
                fun entries(key: String): List<UsageBreakdownEntry> {
                    val arr = json.optJSONArray(key) ?: JSONArray()
                    return (0 until arr.length()).map { i -> arr.getJSONObject(i).let { UsageBreakdownEntry(it.optString("type"), it.optDouble("percent").toInt()) } }
                }
                val org = status.optJSONObject("org")
                val e = json.optJSONObject("entitlements")
                val period = status.optJSONObject("period")
                UsageQuota(
                    plan = status.optString("plan").ifBlank { "free" },
                    isEnterprise = status.optBoolean("isEnterprise"),
                    resetAt = 0L,
                    weekly = bucket("weekly"),
                    monthly = bucket("monthly"),
                    rolling = bucket("rolling"),
                    orgPool = bucket("org"),
                    orgSeats = org?.optInt("seatCount") ?: 0,
                    memberCap = bucket("memberCap")?.copy(resetAt = org?.optString("resetAt")?.ifBlank { null }),
                    breakdown = entries("breakdown"),
                    rollingBreakdown = entries("rollingBreakdown"),
                    monthlyBreakdown = entries("monthlyBreakdown"),
                    credits = period?.optDouble("credits", 0.0) ?: 0.0,
                    creditDrawn = period?.optDouble("creditDrawn", 0.0) ?: 0.0,
                    entitlements = e?.let {
                        PlanEntitlements(
                            buildMode = it.optBoolean("buildMode"), buildMaxRounds = it.optInt("buildMaxRounds"),
                            deepResearchPerDay = it.optInt("deepResearchPerDay"), documentsPerDay = it.optInt("documentsPerDay"),
                            customSkills = it.optInt("customSkills"), libraryStorageMb = it.optInt("libraryStorageMb"),
                            teamUpModels = it.optInt("teamUpModels"), mcpServers = it.optInt("mcpServers"),
                            automations = it.optInt("automations"), prioritySupport = it.optBoolean("prioritySupport"),
                        )
                    },
                )
            }
        }.getOrNull()
    }
}
