package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

/** An expert playbook Friday can load (backend services/skills): built-in or the user's own. */
data class Skill(
    val id: String,
    val source: String,
    val name: String,
    val description: String,
    val icon: String,
    val category: String,
    val enabled: Boolean,
)

object SkillsApi {
    /** Null = the request failed. */
    suspend fun list(): Pair<List<String>, List<Skill>>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "skills").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val json = JSONObject(resp.body?.string().orEmpty())
                val cats = json.optJSONArray("categories")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
                val arr = json.optJSONArray("skills") ?: JSONArray()
                val skills = (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    Skill(
                        id = o.optString("id"),
                        source = o.optString("source", "builtin"),
                        name = o.optString("name").ifBlank { "Skill" },
                        description = o.optString("description"),
                        icon = o.optString("icon").ifBlank { "✨" },
                        category = o.optString("category", "Other"),
                        enabled = o.optBoolean("enabled", true),
                    )
                }
                cats to skills
            }
        }.getOrNull()
    }

    suspend fun setEnabled(id: String, enabled: Boolean): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().put("enabled", enabled).toString().toRequestBody("application/json".toMediaTypeOrNull())
            val request = Request.Builder().url(ApiClient.BASE_URL + "skills/" + URLEncoder.encode(id, "UTF-8").replace("+", "%20") + "/enabled").post(body).build()
            ApiClient.authed.newCall(request).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }
}
