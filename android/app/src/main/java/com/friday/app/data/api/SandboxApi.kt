package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

sealed class SandboxResult {
    /** [autoFixed] is purely informational (attempts.length > 1) — the backend's own retry loop
     *  already ran to completion before responding, so there is nothing left for the client to
     *  re-run; use it only to show something like "fixed automatically" in the UI if desired. */
    data class Success(val output: String, val autoFixed: Boolean = false) : SandboxResult()
    data class Error(val message: String) : SandboxResult()
}

/**
 * POST /api/sandbox/run (backend/src/controllers/sandboxController.ts + services/e2bService.ts).
 * Default body also sends `autoFix: true` (the backend's own default, but sent explicitly here)
 * so the response is always an AutoRunResult: `{ok, output, code, attempts: [{code, result:
 * {output, ok}}]}` — there's no separate "error"/"stderr" field, failures land in `output` itself.
 * This call is synchronous and already final: the backend runs its own auto-fix retries before
 * responding, so a client-side "retry" would just needlessly re-execute already-final code.
 */
object SandboxApi {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    suspend fun run(lang: String, code: String): SandboxResult = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().apply {
                put("language", lang)
                put("code", code)
                put("autoFix", true)
            }
            val request = Request.Builder()
                .url(ApiClient.BASE_URL + "sandbox/run")
                .post(body.toString().toRequestBody(JSON))
                .build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val json = runCatching { JSONObject(text) }.getOrNull()
                if (!resp.isSuccessful || json == null) {
                    return@use SandboxResult.Error(json?.optString("error")?.ifBlank { null } ?: "Couldn't run (${resp.code}).")
                }
                val output = json.optString("output")
                val attempts = json.optJSONArray("attempts")
                val autoFixed = (attempts?.length() ?: 1) > 1
                when {
                    json.optBoolean("ok", false) -> SandboxResult.Success(output, autoFixed)
                    else -> SandboxResult.Error(output.ifBlank { "Error (couldn't auto-fix)." })
                }
            }
        }.getOrElse { SandboxResult.Error(it.message ?: "Couldn't reach the sandbox.") }
    }
}
