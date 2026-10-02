package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

data class RemoteModel(
    val modelId: String,
    val displayName: String,
    val minTier: String,
    val providerSlug: String,
    /** Offered in the Build workspace's picker (frontier coding models only). */
    val build: Boolean = false,
)

/** GET /api/models — public, no auth required. */
object ModelsApi {
    suspend fun list(): List<RemoteModel> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "models").get().build()
            ApiClient.plain.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use emptyList()
                val text = resp.body?.string().orEmpty()
                val arr = JSONObject(text).optJSONArray("models") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    RemoteModel(
                        modelId = o.optString("model_id"),
                        displayName = o.optString("display_name", o.optString("model_id")),
                        minTier = o.optString("min_tier", "free"),
                        providerSlug = o.optJSONObject("providers")?.optString("slug").orEmpty(),
                        build = o.optBoolean("build", false),
                    )
                }
            }
        }.getOrElse { emptyList() }
    }
}
