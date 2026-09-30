package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File

/** Build Mode project endpoints (backend /api/build/:conversationId/…). */
object BuildApi {
    /** GET /api/build/:id/events?after= — the current turn's logged stream frames (id, frame) and
     *  whether it's still running. Null on failure. */
    suspend fun events(conversationId: String, after: Long): Pair<List<Pair<Long, JSONObject>>, Boolean>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "build/$conversationId/events?after=$after").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val obj = JSONObject(resp.body?.string().orEmpty())
                val arr = obj.optJSONArray("events") ?: org.json.JSONArray()
                (0 until arr.length()).map { i -> arr.getJSONObject(i).let { it.optLong("id") to it.getJSONObject("event") } } to obj.optBoolean("running")
            }
        }.getOrNull()
    }

    /** GET /api/build/:id/checkpoints — ids of the user messages that have a restore point. Null on failure. */
    suspend fun checkpoints(conversationId: String): Set<String>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "build/$conversationId/checkpoints").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("checkpoints") ?: return@use emptySet()
                (0 until arr.length()).map { arr.getJSONObject(it).optString("messageId") }.toSet()
            }
        }.getOrNull()
    }

    /** POST /api/build/:id/restore — files back to before that message, conversation rewound. Error or null. */
    suspend fun restore(conversationId: String, messageId: String): String? = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().put("messageId", messageId).toString().toRequestBody("application/json; charset=utf-8".toMediaType())
            val request = Request.Builder().url(ApiClient.BASE_URL + "build/$conversationId/restore").post(body).build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (resp.isSuccessful) null
                else runCatching { JSONObject(resp.body?.string().orEmpty()).optString("error") }.getOrNull().orEmpty().ifBlank { "Couldn't restore (${resp.code})" }
            }
        }.getOrElse { it.message ?: "Couldn't restore — check your connection." }
    }

    /** GET /api/build/:id/approvals — prompts this build is waiting on. Null on failure. */
    suspend fun approvals(conversationId: String): List<com.friday.app.data.BuildApproval>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "build/$conversationId/approvals").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("approvals") ?: return@use emptyList()
                (0 until arr.length()).map { com.friday.app.data.parseBuildApproval(arr.getJSONObject(it)) }
            }
        }.getOrNull()
    }

    /** POST /api/build/:id/approve — decision: allow | deny | allow_all. Returns an error message or null. */
    suspend fun approve(conversationId: String, id: String, decision: String): String? = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().put("id", id).put("decision", decision).toString()
                .toRequestBody("application/json; charset=utf-8".toMediaType())
            val request = Request.Builder().url(ApiClient.BASE_URL + "build/$conversationId/approve").post(body).build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (resp.isSuccessful) null
                else runCatching { JSONObject(resp.body?.string().orEmpty()).optString("error") }.getOrNull().orEmpty().ifBlank { "Couldn't send your answer (${resp.code})" }
            }
        }.getOrElse { it.message ?: "Couldn't send your answer — check your connection." }
    }

    /** GET /api/build/sessions — the Build home + drawer list with live status. Null on failure. */
    suspend fun sessions(): List<com.friday.app.data.BuildSessionSummary>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "build/sessions").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("sessions") ?: return@use emptyList()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    com.friday.app.data.BuildSessionSummary(
                        id = o.optString("id"),
                        title = o.optString("title").ifBlank { "New build" },
                        updatedAt = runCatching { java.time.Instant.parse(o.optString("updatedAt")).toEpochMilli() }.getOrDefault(0L),
                        status = o.optString("status"),
                        activity = o.optString("activity"),
                        repo = o.optString("repo").takeIf { it.isNotBlank() && it != "null" },
                        prUrl = o.optString("prUrl").takeIf { it.isNotBlank() && it != "null" },
                    )
                }
            }
        }.getOrNull()
    }

    sealed class Preview {
        data class Ready(val url: String) : Preview()
        data class Failed(val message: String) : Preview()
    }

    /** Makes sure the sandbox + dev server are alive (restores from snapshot if it expired). */
    suspend fun ensurePreview(conversationId: String): Preview = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url(ApiClient.BASE_URL + "build/$conversationId/preview")
                .post("{}".toRequestBody(null))
                .build()
            // Restoring means reinstalling dependencies — allow a few minutes.
            ApiClient.streaming.newCall(request).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) return@use Preview.Failed(runCatching { JSONObject(body).optString("error") }.getOrNull().orEmpty().ifBlank { "Couldn't start the preview (${resp.code})" })
                val json = JSONObject(body)
                val url = json.optString("url").takeIf { it.isNotBlank() && it != "null" }
                if (url != null) Preview.Ready(url) else Preview.Failed(json.optString("message").ifBlank { "The preview couldn't be started." })
            }
        }.getOrElse { Preview.Failed(it.message ?: "The preview couldn't be started.") }
    }

    /** path → file contents, or null on failure. */
    suspend fun files(conversationId: String): Map<String, String>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "build/$conversationId/files").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val obj = JSONObject(resp.body?.string().orEmpty()).getJSONObject("files")
                obj.keys().asSequence().associateWith { obj.getString(it) }
            }
        }.getOrNull()
    }

    /** Downloads the project zip into [dir]; null on failure. */
    suspend fun downloadZip(conversationId: String, dir: File): File? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "build/$conversationId/download").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                dir.mkdirs()
                File(dir, "friday-project.zip").also { it.writeBytes(resp.body!!.bytes()) }
            }
        }.getOrNull()
    }
}
