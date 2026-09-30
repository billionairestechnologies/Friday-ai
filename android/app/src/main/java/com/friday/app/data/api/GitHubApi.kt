package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** GitHub for the Build composer's repo / branch picker (backend /api/connectors/github/…). */
object GitHubApi {
    data class Repo(val fullName: String, val isPrivate: Boolean, val defaultBranch: String, val description: String?)

    private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

    private fun errorOf(body: String, code: Int, fallback: String) =
        runCatching { JSONObject(body).optString("error") }.getOrNull().orEmpty().ifBlank { "$fallback ($code)" }

    private fun parseRepo(o: JSONObject) = Repo(
        fullName = o.optString("fullName"),
        isPrivate = o.optBoolean("private"),
        defaultBranch = o.optString("defaultBranch").ifBlank { "main" },
        description = o.optString("description").takeIf { it.isNotBlank() && it != "null" },
    )

    /** Null on failure. */
    suspend fun isConnected(): Boolean? = withContext(Dispatchers.IO) {
        runCatching {
            ApiClient.authed.newCall(Request.Builder().url(ApiClient.BASE_URL + "connectors").get().build()).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("accounts") ?: return@use false
                (0 until arr.length()).any { arr.getJSONObject(it).optString("provider") == "github" }
            }
        }.getOrNull()
    }

    /** The GitHub authorize URL to open in the browser. */
    suspend fun startUrl(): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            ApiClient.authed.newCall(Request.Builder().url(ApiClient.BASE_URL + "connectors/github/start").get().build()).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw Exception(errorOf(body, resp.code, "Couldn't start connecting GitHub"))
                JSONObject(body).optString("url")
            }
        }
    }

    suspend fun repos(query: String): Result<List<Repo>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = ApiClient.BASE_URL + "connectors/github/repos?mine=1&q=" + java.net.URLEncoder.encode(query, "UTF-8")
            ApiClient.authed.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw Exception(errorOf(body, resp.code, "Couldn't load your repositories"))
                val arr = JSONObject(body).optJSONArray("repositories") ?: org.json.JSONArray()
                (0 until arr.length()).map { parseRepo(arr.getJSONObject(it)) }
            }
        }
    }

    suspend fun branches(repo: String): Result<List<String>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = ApiClient.BASE_URL + "connectors/github/branches?repo=" + java.net.URLEncoder.encode(repo, "UTF-8")
            ApiClient.authed.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw Exception(errorOf(body, resp.code, "Couldn't load branches"))
                val arr = JSONObject(body).optJSONArray("branches") ?: org.json.JSONArray()
                (0 until arr.length()).map { arr.getString(it) }
            }
        }
    }

    suspend fun createRepo(name: String, isPrivate: Boolean): Result<Repo> = withContext(Dispatchers.IO) {
        runCatching {
            val payload = JSONObject().put("name", name).put("private", isPrivate).toString().toRequestBody(JSON_TYPE)
            ApiClient.authed.newCall(Request.Builder().url(ApiClient.BASE_URL + "connectors/github/repos").post(payload).build()).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw Exception(errorOf(body, resp.code, "Couldn't create the repository"))
                parseRepo(JSONObject(body).getJSONObject("repository"))
            }
        }
    }

    suspend fun createBranch(repo: String, branch: String, from: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val payload = JSONObject().put("repo", repo).put("branch", branch).put("from", from).toString().toRequestBody(JSON_TYPE)
            ApiClient.authed.newCall(Request.Builder().url(ApiClient.BASE_URL + "connectors/github/branches").post(payload).build()).execute().use { resp ->
                if (!resp.isSuccessful) throw Exception(errorOf(resp.body?.string().orEmpty(), resp.code, "Couldn't create the branch"))
            }
        }
    }
}
