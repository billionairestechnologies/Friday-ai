package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File

/** Build Mode project endpoints (backend /api/build/:conversationId/…). */
object BuildApi {
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
