package com.friday.app.data.api

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.friday.app.data.ChatThread
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

data class ProjectSummary(val id: String, val name: String, val description: String, val instructions: String)

/** A file in a project's knowledge base (backend services/knowledge): status is processing | ready | error. */
data class ProjectFile(
    val id: String,
    val filename: String,
    val sizeBytes: Long,
    val status: String,
    val error: String?,
    val chunkCount: Int,
    val embedded: Boolean,
)

/** Projects: instructions plus a knowledge base of files every chat inside the project can search. */
object ProjectsApi {
    private val JSON = "application/json".toMediaTypeOrNull()

    private fun parse(o: JSONObject) = ProjectSummary(
        id = o.optString("id"),
        name = o.optString("name").ifBlank { "Project" },
        description = o.optString("description").takeIf { it != "null" }.orEmpty(),
        instructions = o.optString("instructions").takeIf { it != "null" }.orEmpty(),
    )

    /** Null = the request failed (so the UI can say so instead of showing an empty list). */
    suspend fun list(): List<ProjectSummary>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "projects").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("projects") ?: JSONArray()
                (0 until arr.length()).map { parse(arr.getJSONObject(it)) }
            }
        }.getOrNull()
    }

    suspend fun create(name: String, description: String, instructions: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().put("name", name).put("description", description).put("instructions", instructions).put("mode", "work")
            val request = Request.Builder().url(ApiClient.BASE_URL + "projects").post(body.toString().toRequestBody(JSON)).build()
            ApiClient.authed.newCall(request).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun delete(id: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "projects/$id").delete().build()
            ApiClient.authed.newCall(request).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun files(projectId: String): List<ProjectFile>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "projects/$projectId/files").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("files") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    ProjectFile(
                        id = o.optString("id"),
                        filename = o.optString("filename").ifBlank { "file" },
                        sizeBytes = o.optLong("size_bytes"),
                        status = o.optString("status", "processing"),
                        error = o.optString("error").takeIf { it.isNotBlank() && it != "null" },
                        chunkCount = o.optInt("chunk_count"),
                        embedded = o.optBoolean("embedded"),
                    )
                }
            }
        }.getOrNull()
    }

    /** POST /projects/:id/files (multipart, field "files") — the server reads and indexes it in the background.
     *  Returns an error message, or null on success. */
    suspend fun upload(ctx: Context, projectId: String, uri: Uri): String? = withContext(Dispatchers.IO) {
        runCatching {
            val resolver = ctx.contentResolver
            val name = resolver.query(uri, null, null, null, null)?.use { c ->
                val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (i >= 0 && c.moveToFirst()) c.getString(i) else null
            } ?: "file"
            val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching "Couldn't read $name."
            val mime = resolver.getType(uri) ?: "application/octet-stream"
            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("files", name, bytes.toRequestBody(mime.toMediaTypeOrNull()))
                .build()
            val request = Request.Builder().url(ApiClient.BASE_URL + "projects/$projectId/files").post(body).build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (resp.isSuccessful) null
                else runCatching { JSONObject(resp.body?.string().orEmpty()).optString("error") }.getOrNull().orEmpty().ifBlank { "Upload failed." }
            }
        }.getOrElse { "Couldn't upload that file." }
    }

    suspend fun deleteFile(projectId: String, fileId: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "projects/$projectId/files/$fileId").delete().build()
            ApiClient.authed.newCall(request).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    /** The project's own chats (kept out of the main chat list). */
    suspend fun conversations(projectId: String): List<ChatThread> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "projects/$projectId/conversations").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use emptyList()
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("conversations") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    ChatThread(
                        id = o.optString("id"),
                        title = o.optString("title").ifBlank { "New chat" },
                        updatedAt = runCatching { java.time.Instant.parse(o.optString("updated_at")).toEpochMilli() }.getOrDefault(System.currentTimeMillis()),
                        workspace = o.optString("workspace").ifBlank { null },
                        hasBuild = o.optBoolean("has_build", false),
                    )
                }
            }
        }.getOrDefault(emptyList())
    }
}
