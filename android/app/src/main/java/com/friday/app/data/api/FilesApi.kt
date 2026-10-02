package com.friday.app.data.api

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File

object FilesApi {
    /** GET /files/:id/download — files are private to their owner, so this goes through the authenticated API.
     *  Saves into the cache and opens the share sheet. Returns an error message, or null on success. */
    suspend fun downloadAndShare(ctx: Context, id: String, filename: String): String? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "files/$id/download").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (resp.code == 404) return@use "This file was deleted from your Library"
                if (!resp.isSuccessful) return@use "Download failed (${resp.code})"
                val bytes = resp.body?.bytes() ?: return@use "Download failed"
                val dir = File(ctx.cacheDir, "downloads").apply { mkdirs() }
                val file = File(dir, filename.replace(Regex("[^\\w.-]+"), "_")).apply { writeBytes(bytes) }
                val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
                val mime = ctx.contentResolver.getType(uri) ?: "application/octet-stream"
                withContext(Dispatchers.Main) {
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        type = mime
                        putExtra(Intent.EXTRA_STREAM, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    ctx.startActivity(Intent.createChooser(intent, "Save file").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                null
            }
        }.getOrElse { "Download failed. Check your connection and try again." }
    }
}
