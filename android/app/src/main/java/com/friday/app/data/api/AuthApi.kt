package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

data class FridaySession(val accessToken: String, val refreshToken: String)

data class FridayAuthUser(
    val id: String,
    val email: String,
    val name: String,
    val phone: String?,
    val birthday: String?,
    val instructions: String?,
    val role: String,
)

data class AuthSuccess(val user: FridayAuthUser, val session: FridaySession)

sealed class AuthResult<out T> {
    data class Success<T>(val value: T) : AuthResult<T>()
    data class Failure(val message: String) : AuthResult<Nothing>()
}

data class OtpRequired(val email: String)

object AuthApi {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    private fun post(client: OkHttpClient, path: String, body: JSONObject): JSONObject {
        val request = Request.Builder()
            .url(ApiClient.BASE_URL + path)
            .post(body.toString().toRequestBody(JSON))
            .build()
        client.newCall(request).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val json = if (text.isNotBlank()) runCatching { JSONObject(text) }.getOrDefault(JSONObject()) else JSONObject()
            if (!resp.isSuccessful) {
                val message = json.optString("error", json.optString("message", "Request failed (${resp.code})"))
                throw IOException(message)
            }
            return json
        }
    }

    private fun get(client: OkHttpClient, path: String): JSONObject {
        val request = Request.Builder().url(ApiClient.BASE_URL + path).get().build()
        client.newCall(request).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val json = if (text.isNotBlank()) runCatching { JSONObject(text) }.getOrDefault(JSONObject()) else JSONObject()
            if (!resp.isSuccessful) {
                val message = json.optString("error", json.optString("message", "Request failed (${resp.code})"))
                throw IOException(message)
            }
            return json
        }
    }

    private fun patch(client: OkHttpClient, path: String, body: JSONObject): JSONObject {
        val request = Request.Builder()
            .url(ApiClient.BASE_URL + path)
            .patch(body.toString().toRequestBody(JSON))
            .build()
        client.newCall(request).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val json = if (text.isNotBlank()) runCatching { JSONObject(text) }.getOrDefault(JSONObject()) else JSONObject()
            if (!resp.isSuccessful) {
                val message = json.optString("error", json.optString("message", "Request failed (${resp.code})"))
                throw IOException(message)
            }
            return json
        }
    }

    suspend fun signup(name: String, email: String, password: String, phone: String, birthday: String): AuthResult<OtpRequired> = runOtpCall {
        post(
            ApiClient.plain,
            "auth/signup",
            JSONObject().apply {
                put("name", name)
                put("email", email)
                put("password", password)
                put("phone", phone)
                put("birthday", birthday)
            },
        )
    }

    suspend fun login(email: String, password: String): AuthResult<OtpRequired> = runOtpCall {
        post(
            ApiClient.plain,
            "auth/login",
            JSONObject().apply {
                put("email", email)
                put("password", password)
            },
        )
    }

    suspend fun resendOtp(email: String): AuthResult<OtpRequired> = runOtpCall {
        post(ApiClient.plain, "auth/resend-otp", JSONObject().apply { put("email", email) })
    }

    suspend fun verifyOtp(email: String, code: String): AuthResult<AuthSuccess> = withContext(Dispatchers.IO) {
        try {
            val json = post(
                ApiClient.plain,
                "auth/verify-otp",
                JSONObject().apply {
                    put("email", email)
                    put("code", code)
                    put("otp", code)
                },
            )
            AuthResult.Success(parseAuthSuccess(json))
        } catch (e: Exception) {
            AuthResult.Failure(e.message ?: "That code didn't work. Try again.")
        }
    }

    suspend fun me(): AuthResult<FridayAuthUser> = withContext(Dispatchers.IO) {
        try {
            val json = get(ApiClient.authed, "auth/me")
            AuthResult.Success(parseUser(json.optJSONObject("user") ?: json))
        } catch (e: Exception) {
            AuthResult.Failure(e.message ?: "Failed to load profile")
        }
    }

    suspend fun logout(): Unit = withContext(Dispatchers.IO) {
        runCatching { post(ApiClient.authed, "auth/logout", JSONObject()) }
        Unit
    }

    /** PATCH /api/auth/profile — updates phone/birthday/custom instructions (name/email are managed by the auth provider). */
    suspend fun updateProfile(phone: String, birthday: String, instructions: String? = null): AuthResult<FridayAuthUser> = withContext(Dispatchers.IO) {
        try {
            val json = patch(
                ApiClient.authed,
                "auth/profile",
                JSONObject().apply {
                    put("phone", phone)
                    put("birthday", birthday)
                    if (instructions != null) {
                        put("instructions", instructions)
                        put("customInstructions", instructions)
                    }
                },
            )
            AuthResult.Success(parseUser(json.optJSONObject("user") ?: json))
        } catch (e: Exception) {
            AuthResult.Failure(e.message ?: "Couldn't update your profile.")
        }
    }

    /** GET /api/auth/export — raw JSON dump of the account's chat data, for the user to save/share. */
    suspend fun exportData(): String? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "auth/export").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                resp.body?.string()
            }
        }.getOrNull()
    }

    /** DELETE /api/auth/account — permanent; caller is responsible for confirming with the user first. */
    suspend fun deleteAccount(): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "auth/account").delete().build()
            ApiClient.authed.newCall(request).execute().use { it.isSuccessful }
        }.getOrElse { false }
    }

    suspend fun googleStartUrl(): String? = withContext(Dispatchers.IO) {
        runCatching { get(ApiClient.plain, "auth/google/start?returnTo=/mobile-auth-bridge").optString("url").ifBlank { null } }.getOrNull()
    }

    suspend fun githubStartUrl(): String? = withContext(Dispatchers.IO) {
        runCatching { get(ApiClient.plain, "auth/github/start?returnTo=/mobile-auth-bridge").optString("url").ifBlank { null } }.getOrNull()
    }

    /** Synchronous by design — called from OkHttp's Authenticator thread, never from a coroutine. */
    fun refreshBlocking(refreshToken: String): Pair<String, String>? = try {
        val json = post(
            ApiClient.plain,
            "auth/refresh",
            JSONObject().apply {
                put("refreshToken", refreshToken)
                put("refresh_token", refreshToken)
            },
        )
        val session = json.optJSONObject("session") ?: json
        val access = session.optString("access_token", session.optString("accessToken", ""))
        val refresh = session.optString("refresh_token", session.optString("refreshToken", refreshToken))
        if (access.isBlank()) null else access to refresh
    } catch (e: Exception) {
        null
    }

    private suspend fun runOtpCall(block: () -> JSONObject): AuthResult<OtpRequired> = withContext(Dispatchers.IO) {
        try {
            val json = block()
            AuthResult.Success(OtpRequired(json.optString("email")))
        } catch (e: Exception) {
            AuthResult.Failure(e.message ?: "Something went wrong")
        }
    }

    private fun parseAuthSuccess(json: JSONObject): AuthSuccess {
        val session = json.optJSONObject("session") ?: JSONObject()
        val userObj = json.optJSONObject("user") ?: JSONObject()
        return AuthSuccess(
            user = parseUser(userObj),
            session = FridaySession(
                accessToken = session.optString("access_token", session.optString("accessToken")),
                refreshToken = session.optString("refresh_token", session.optString("refreshToken")),
            ),
        )
    }

    private fun parseUser(json: JSONObject): FridayAuthUser = FridayAuthUser(
        id = json.optString("id"),
        email = json.optString("email"),
        name = json.optString("name"),
        phone = json.optString("phone").ifBlank { null },
        birthday = json.optString("birthday").ifBlank { null },
        instructions = json.optString("instructions", json.optString("customInstructions")).ifBlank { null },
        role = json.optString("role", "user"),
    )
}
