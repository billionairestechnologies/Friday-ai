package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

data class PageSummary(val id: String, val kind: String, val title: String)

data class PageSheet(val name: String, val columns: List<String>, val rows: List<List<String>>)

/** One slide: its title/subtitle and the text lines worth showing on a phone (bullets, quote). */
data class PageSlide(val title: String, val subtitle: String, val lines: List<String>)

/** A page's content in the shape the backend stores (services/pages/pageService.ts): doc = markdown, sheet = sheets, slides = slide specs. */
data class PageDetail(
    val kind: String,
    val title: String,
    val markdown: String,
    val sheets: List<PageSheet>,
    val slides: List<PageSlide>,
)

object PagesApi {
    /** Null = the request failed (so the UI can say so instead of showing an empty list). */
    suspend fun list(): List<PageSummary>? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "pages").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("pages") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    PageSummary(o.optString("id"), o.optString("kind", "doc"), o.optString("title").ifBlank { "Untitled" })
                }
            }
        }.getOrNull()
    }

    suspend fun get(id: String): PageDetail? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "pages/$id").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val page = JSONObject(resp.body?.string().orEmpty()).getJSONObject("page")
                val content = page.optJSONObject("content") ?: JSONObject()
                val sheets = content.optJSONArray("sheets")?.let { arr ->
                    (0 until arr.length()).map { i ->
                        val s = arr.getJSONObject(i)
                        val cols = s.optJSONArray("columns")?.let { c -> (0 until c.length()).map { c.optString(it) } } ?: emptyList()
                        val rows = s.optJSONArray("rows")?.let { r ->
                            (0 until r.length()).map { ri ->
                                val row = r.optJSONArray(ri)
                                if (row == null) emptyList() else (0 until row.length()).map { row.optString(it).takeIf { v -> v != "null" }.orEmpty() }
                            }
                        } ?: emptyList()
                        PageSheet(s.optString("name", "Sheet"), cols, rows)
                    }
                } ?: emptyList()
                val slides = content.optJSONArray("slides")?.let { arr ->
                    (0 until arr.length()).map { i ->
                        val s = arr.getJSONObject(i)
                        val lines = mutableListOf<String>()
                        s.optJSONArray("bullets")?.let { b -> (0 until b.length()).forEach { lines += "• " + b.optString(it) } }
                        s.optString("quote").takeIf { it.isNotBlank() }?.let { lines += "“$it”" }
                        PageSlide(s.optString("title"), s.optString("subtitle"), lines)
                    }
                } ?: emptyList()
                PageDetail(page.optString("kind", "doc"), page.optString("title").ifBlank { "Untitled" }, content.optString("markdown"), sheets, slides)
            }
        }.getOrNull()
    }
}
