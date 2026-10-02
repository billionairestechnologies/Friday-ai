package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** The plugin catalog the web shows (frontend/src/lib/plugins.ts) — what exists; whether it is connected, and how to
 *  connect it, comes from the backend (`/connectors`, `/connectors/config`). */
data class PluginItem(val id: String, val name: String, val desc: String, val category: String)

val PLUGIN_CATEGORIES = listOf("Productivity", "Developer tools", "Business & finance", "Design")

val FEATURED_PLUGINS = listOf(
    PluginItem("gmail", "Gmail", "Read and draft mail", "Productivity"),
    PluginItem("calendar", "Google Calendar", "See events and upcoming meetings", "Productivity"),
    PluginItem("drive", "Google Drive", "Search files and docs", "Productivity"),
    PluginItem("notion", "Notion", "Search pages and docs", "Productivity"),
    PluginItem("box", "Box", "Search files and docs", "Productivity"),
    PluginItem("github", "GitHub", "Search repos and pull requests", "Developer tools"),
    PluginItem("supabase", "Supabase", "Query your database and tables", "Developer tools"),
    PluginItem("vercel", "Vercel", "Manage your deploys", "Developer tools"),
    PluginItem("railway", "Railway", "Check deploys and service status", "Developer tools"),
    PluginItem("razorpay", "Razorpay", "Track payments and orders", "Business & finance"),
    PluginItem("finance", "Finance", "Connect financial accounts", "Business & finance"),
    PluginItem("canva", "Canva", "Create and edit designs", "Design"),
)

data class ConnectorField(val key: String, val label: String, val secret: Boolean, val placeholder: String?)
data class ConnectorSpec(val mode: String, val configured: Boolean, val pluginIds: List<String>, val fields: List<ConnectorField>)
data class ConnectorAccount(val id: String, val provider: String, val accountLogin: String?)
data class ConnectorPreviewItem(val title: String, val subtitle: String?)

object PluginsApi {
    private val JSON = "application/json".toMediaTypeOrNull()

    suspend fun config(): Map<String, ConnectorSpec>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "connectors/config").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val all = JSONObject(resp.body?.string().orEmpty()).optJSONObject("connectors") ?: JSONObject()
                all.keys().asSequence().associateWith { key ->
                    val o = all.getJSONObject(key)
                    val fields = o.optJSONArray("fields") ?: JSONArray()
                    val ids = o.optJSONArray("pluginIds") ?: JSONArray()
                    ConnectorSpec(
                        mode = o.optString("mode", "token"),
                        configured = o.optBoolean("configured"),
                        pluginIds = (0 until ids.length()).map { ids.optString(it) },
                        fields = (0 until fields.length()).map { i ->
                            val f = fields.getJSONObject(i)
                            ConnectorField(f.optString("key", "token"), f.optString("label", "Token"), f.optBoolean("secret"), f.optString("placeholder").takeIf { it.isNotBlank() })
                        },
                    )
                }
            }
        }.getOrNull()
    }

    suspend fun accounts(): List<ConnectorAccount>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "connectors").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("accounts") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    ConnectorAccount(o.optString("id"), o.optString("provider"), o.optString("accountLogin").takeIf { it.isNotBlank() && it != "null" })
                }
            }
        }.getOrNull()
    }

    /** GitHub / Google: the authorize URL to open in the browser; the server finishes the link on its callback. */
    suspend fun oauthStart(provider: String): String? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "connectors/$provider/start?returnTo=%2F").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) null else JSONObject(resp.body?.string().orEmpty()).optString("url").ifBlank { null }
            }
        }.getOrNull()
    }

    /** Returns an error message, or null on success. */
    suspend fun connect(provider: String, values: Map<String, String>): String? = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().apply { values.forEach { (k, v) -> if (v.isNotBlank()) put(k, v.trim()) } }
            val request = Request.Builder().url(ApiClient.BASE_URL + "connectors/$provider").post(body.toString().toRequestBody(JSON)).build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (resp.isSuccessful) null
                else runCatching { JSONObject(resp.body?.string().orEmpty()).optString("error") }.getOrNull().orEmpty().ifBlank { "Couldn't connect. Check the details and try again." }
            }
        }.getOrElse { "Couldn't connect. Check your connection." }
    }

    suspend fun disconnect(provider: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "connectors/$provider").delete().build()
            ApiClient.authed.newCall(request).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun preview(provider: String): List<ConnectorPreviewItem> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "connectors/$provider/preview").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use emptyList()
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("items") ?: JSONArray()
                (0 until arr.length()).map { i -> arr.getJSONObject(i).let { ConnectorPreviewItem(it.optString("title"), it.optString("subtitle").takeIf { s -> s.isNotBlank() }) } }
            }
        }.getOrDefault(emptyList())
    }
}
