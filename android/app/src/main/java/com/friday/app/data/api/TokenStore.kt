package com.friday.app.data.api

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Encrypted at-rest storage for the backend session. Falls back to plain prefs if keystore setup fails. */
class TokenStore(context: Context) {
    private val prefs: SharedPreferences = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "friday_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        context.getSharedPreferences("friday_secure_fallback", Context.MODE_PRIVATE)
    }

    var accessToken: String?
        get() = prefs.getString(KEY_ACCESS, null)
        set(value) = prefs.edit().putString(KEY_ACCESS, value).apply()

    var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH, null)
        set(value) = prefs.edit().putString(KEY_REFRESH, value).apply()

    var userName: String?
        get() = prefs.getString(KEY_NAME, null)
        set(value) = prefs.edit().putString(KEY_NAME, value).apply()

    var userEmail: String?
        get() = prefs.getString(KEY_EMAIL, null)
        set(value) = prefs.edit().putString(KEY_EMAIL, value).apply()

    /** Chosen TTS voice for Voice Mode / spoken replies — persisted locally since the backend has
     *  no per-user "default voice" field to save it to. */
    var voiceId: String?
        get() = prefs.getString(KEY_VOICE_ID, null)
        set(value) = prefs.edit().putString(KEY_VOICE_ID, value).apply()

    var voiceName: String?
        get() = prefs.getString(KEY_VOICE_NAME, null)
        set(value) = prefs.edit().putString(KEY_VOICE_NAME, value).apply()

    fun hasSession(): Boolean = !accessToken.isNullOrBlank() && !refreshToken.isNullOrBlank()

    fun saveSession(accessToken: String, refreshToken: String) {
        this.accessToken = accessToken
        this.refreshToken = refreshToken
    }

    /** Clears the session only — [voiceId]/[voiceName] are a device-level preference (mirrors the
     *  web app's own persisted store, which doesn't wipe it on logout either) and survive this. */
    fun clear() {
        prefs.edit().remove(KEY_ACCESS).remove(KEY_REFRESH).remove(KEY_NAME).remove(KEY_EMAIL).apply()
    }

    companion object {
        private const val KEY_ACCESS = "access_token"
        private const val KEY_REFRESH = "refresh_token"
        private const val KEY_NAME = "user_name"
        private const val KEY_EMAIL = "user_email"
        private const val KEY_VOICE_ID = "voice_id"
        private const val KEY_VOICE_NAME = "voice_name"
    }
}
