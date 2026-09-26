package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

data class MemoryItem(val id: String, val content: String)

data class McpServer(val id: String, val name: String, val url: String, val hasAuth: Boolean, val enabled: Boolean)

data class Automation(
    val id: String,
    val title: String,
    val prompt: String,
    val frequency: String,
    val timeOfDay: String,
    val weekday: Int?,
    val timezone: String,
    val research: Boolean,
    val enabled: Boolean,
    val conversationId: String?,
    val lastStatus: String?,
    val lastError: String?,
)

data class SearchHit(val conversationId: String, val title: String, val role: String, val snippet: String)

/** Result of a mutating call: null error = success. Keeps the server's message so the UI can show it. */
data class ApiResult<T>(val value: T?, val error: String?)

/**
 * Memory, MCP servers, Automations, chat search and share links — the agent-platform endpoints
 * (GET/POST/DELETE /api/memory, /api/mcp, /api/automations, /api/chat/search, /api/chat/conversations/:id/share).
 */
object AgentApi {
    private val JSON = "application/json".toMediaType()

    private fun errorOf(body: String, code: Int): String =
        runCatching { JSONObject(body).optString("error").ifBlank { null } }.getOrNull() ?: "Request failed ($code)"

    private suspend fun call(request: Request): Pair<Int, String> = withContext(Dispatchers.IO) {
        ApiClient.authed.newCall(request).execute().use { it.code to it.body?.string().orEmpty() }
    }

    private suspend inline fun <T> safe(crossinline block: suspend () -> ApiResult<T>): ApiResult<T> =
        try { block() } catch (e: Exception) { ApiResult(null, e.message ?: "Network error") }

    private fun req(path: String) = Request.Builder().url(ApiClient.BASE_URL + path)

    // ---- Memory ----
    suspend fun memories(): ApiResult<List<MemoryItem>> = safe {
        val (code, body) = call(req("memory").get().build())
        if (code !in 200..299) return@safe ApiResult(null, errorOf(body, code))
        val arr = JSONObject(body).optJSONArray("memories") ?: JSONArray()
        ApiResult((0 until arr.length()).map { arr.getJSONObject(it).let { o -> MemoryItem(o.optString("id"), o.optString("content")) } }, null)
    }

    suspend fun addMemory(content: String): ApiResult<Boolean> = safe {
        val (code, body) = call(req("memory").post(JSONObject().put("content", content).toString().toRequestBody(JSON)).build())
        if (code in 200..299) ApiResult(true, null) else ApiResult(null, errorOf(body, code))
    }

    suspend fun deleteMemory(id: String): ApiResult<Boolean> = safe {
        val (code, body) = call(req("memory/$id").delete().build())
        if (code in 200..299) ApiResult(true, null) else ApiResult(null, errorOf(body, code))
    }

    suspend fun clearMemories(): ApiResult<Boolean> = safe {
        val (code, body) = call(req("memory").delete().build())
        if (code in 200..299) ApiResult(true, null) else ApiResult(null, errorOf(body, code))
    }

    // ---- MCP servers ----
    private fun parseServer(o: JSONObject) = McpServer(o.optString("id"), o.optString("name"), o.optString("url"), o.optBoolean("hasAuth"), o.optBoolean("enabled", true))

    suspend fun mcpServers(): ApiResult<List<McpServer>> = safe {
        val (code, body) = call(req("mcp").get().build())
        if (code !in 200..299) return@safe ApiResult(null, errorOf(body, code))
        val arr = JSONObject(body).optJSONArray("servers") ?: JSONArray()
        ApiResult((0 until arr.length()).map { parseServer(arr.getJSONObject(it)) }, null)
    }

    /** Returns the tool names the server exposes (the backend verifies the connection before saving). */
    suspend fun addMcpServer(name: String, url: String, authorization: String): ApiResult<List<String>> = safe {
        val json = JSONObject().put("name", name).put("url", url)
        if (authorization.isNotBlank()) json.put("authorization", authorization)
        val (code, body) = call(req("mcp").post(json.toString().toRequestBody(JSON)).build())
        if (code !in 200..299) return@safe ApiResult(null, errorOf(body, code))
        val tools = JSONObject(body).optJSONArray("tools") ?: JSONArray()
        ApiResult((0 until tools.length()).map { tools.optString(it) }, null)
    }

    suspend fun setMcpEnabled(id: String, enabled: Boolean): ApiResult<Boolean> = safe {
        val (code, body) = call(req("mcp/$id").patch(JSONObject().put("enabled", enabled).toString().toRequestBody(JSON)).build())
        if (code in 200..299) ApiResult(true, null) else ApiResult(null, errorOf(body, code))
    }

    suspend fun deleteMcpServer(id: String): ApiResult<Boolean> = safe {
        val (code, body) = call(req("mcp/$id").delete().build())
        if (code in 200..299) ApiResult(true, null) else ApiResult(null, errorOf(body, code))
    }

    // ---- Automations ----
    private fun parseAutomation(o: JSONObject) = Automation(
        id = o.optString("id"),
        title = o.optString("title"),
        prompt = o.optString("prompt"),
        frequency = o.optString("frequency"),
        timeOfDay = o.optString("timeOfDay", "09:00"),
        weekday = if (o.isNull("weekday")) null else o.optInt("weekday"),
        timezone = o.optString("timezone", "UTC"),
        research = o.optBoolean("research"),
        enabled = o.optBoolean("enabled", true),
        conversationId = o.optString("conversationId").takeIf { it.isNotBlank() && it != "null" },
        lastStatus = o.optString("lastStatus").takeIf { it.isNotBlank() && it != "null" },
        lastError = o.optString("lastError").takeIf { it.isNotBlank() && it != "null" },
    )

    suspend fun automations(): ApiResult<List<Automation>> = safe {
        val (code, body) = call(req("automations").get().build())
        if (code !in 200..299) return@safe ApiResult(null, errorOf(body, code))
        val arr = JSONObject(body).optJSONArray("automations") ?: JSONArray()
        ApiResult((0 until arr.length()).map { parseAutomation(arr.getJSONObject(it)) }, null)
    }

    suspend fun createAutomation(
        title: String, prompt: String, frequency: String, timeOfDay: String, weekday: Int?, timezone: String, research: Boolean,
    ): ApiResult<Boolean> = safe {
        val json = JSONObject()
            .put("title", title).put("prompt", prompt).put("frequency", frequency)
            .put("timeOfDay", timeOfDay).put("timezone", timezone).put("research", research)
        if (frequency == "weekly" && weekday != null) json.put("weekday", weekday)
        val (code, body) = call(req("automations").post(json.toString().toRequestBody(JSON)).build())
        if (code in 200..299) ApiResult(true, null) else ApiResult(null, errorOf(body, code))
    }

    suspend fun setAutomationEnabled(id: String, enabled: Boolean): ApiResult<Boolean> = safe {
        val (code, body) = call(req("automations/$id").patch(JSONObject().put("enabled", enabled).toString().toRequestBody(JSON)).build())
        if (code in 200..299) ApiResult(true, null) else ApiResult(null, errorOf(body, code))
    }

    suspend fun runAutomation(id: String): ApiResult<Boolean> = safe {
        val (code, body) = call(req("automations/$id/run").post("{}".toRequestBody(JSON)).build())
        if (code in 200..299) ApiResult(true, null) else ApiResult(null, errorOf(body, code))
    }

    suspend fun deleteAutomation(id: String): ApiResult<Boolean> = safe {
        val (code, body) = call(req("automations/$id").delete().build())
        if (code in 200..299) ApiResult(true, null) else ApiResult(null, errorOf(body, code))
    }

    // ---- Search + share ----
    suspend fun search(query: String): ApiResult<List<SearchHit>> = safe {
        val (code, body) = call(req("chat/search?q=" + URLEncoder.encode(query, "UTF-8")).get().build())
        if (code !in 200..299) return@safe ApiResult(null, errorOf(body, code))
        val arr = JSONObject(body).optJSONArray("results") ?: JSONArray()
        ApiResult(
            (0 until arr.length()).map {
                val o = arr.getJSONObject(it)
                SearchHit(o.optString("conversationId"), o.optString("title"), o.optString("role"), o.optString("snippet"))
            },
            null,
        )
    }

    /** Returns the public share URL (same host the web app serves /share/:token from). */
    suspend fun shareConversation(conversationId: String): ApiResult<String> = safe {
        val (code, body) = call(req("chat/conversations/$conversationId/share").post("{}".toRequestBody(JSON)).build())
        if (code !in 200..299) return@safe ApiResult(null, errorOf(body, code))
        val token = JSONObject(body).optString("token")
        ApiResult(ApiClient.BASE_URL.removeSuffix("/").removeSuffix("/api") + "/share/" + token, null)
    }

    suspend fun unshareConversation(conversationId: String): ApiResult<Boolean> = safe {
        val (code, body) = call(req("chat/conversations/$conversationId/share").delete().build())
        if (code in 200..299) ApiResult(true, null) else ApiResult(null, errorOf(body, code))
    }
}
