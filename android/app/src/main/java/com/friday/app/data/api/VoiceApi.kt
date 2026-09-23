package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class VoiceOption(val id: String, val name: String)

/** Real backend voice endpoints. */
object VoiceApi {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    /** GET /api/voice/voices — the list to populate the Settings > Voice picker. */
    suspend fun voices(): List<VoiceOption> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "voice/voices").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use emptyList()
                val text = resp.body?.string().orEmpty()
                val arr = JSONObject(text).optJSONArray("voices") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    val id = o.optString("voiceId").ifBlank { o.optString("id") }
                    VoiceOption(id = id, name = o.optString("name").ifBlank { id })
                }
            }
        }.getOrElse { emptyList() }
    }

    /** POST /api/voice/speak — synthesizes a short preview clip for the given voice; returns raw audio bytes.
     *  [voiceId] is omitted entirely when blank (no voice picked in Settings yet) rather than sent as
     *  an empty string — the backend's schema requires a non-empty string *if the field is present*,
     *  so a blank value was always rejected with a 400, silently killing voice-mode TTS for anyone
     *  who hadn't explicitly chosen a voice. */
    suspend fun speak(text: String, voiceId: String): ByteArray? = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().apply {
                put("text", text)
                if (voiceId.isNotBlank()) {
                    put("voice", voiceId)
                    put("voiceId", voiceId)
                }
            }
            val request = Request.Builder()
                .url(ApiClient.BASE_URL + "voice/speak")
                .post(body.toString().toRequestBody(JSON))
                .build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                resp.body?.bytes()
            }
        }.getOrNull()
    }
    /** POST /api/voice/transcribe — multipart audio upload, returns recognized text. */
    suspend fun transcribe(file: File): String? = withContext(Dispatchers.IO) {
        runCatching {
            // The composer's push-to-talk records .m4a (AAC) but voice mode's MicCaptureController
            // writes a .wav file — mislabeling the wav upload as audio/mp4 made the backend's
            // transcriber silently fail on every voice-mode turn, so this has to match the actual
            // container instead of hardcoding one.
            val mime = when (file.extension.lowercase()) {
                "wav" -> "audio/wav"
                "m4a", "mp4" -> "audio/mp4"
                "3gp" -> "audio/3gpp"
                else -> "audio/mp4"
            }
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("audio", file.name, file.asRequestBody(mime.toMediaType()))
                .build()
            val request = Request.Builder()
                .url(ApiClient.BASE_URL + "voice/transcribe")
                .post(body)
                .build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val text = resp.body?.string().orEmpty()
                JSONObject(text).optString("text").ifBlank { null }
            }
        }.getOrNull()
    }
}
