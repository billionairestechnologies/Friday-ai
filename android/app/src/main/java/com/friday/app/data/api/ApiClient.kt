package com.friday.app.data.api

import com.friday.app.BuildConfig
import com.friday.app.data.realtime.SupabaseRealtime
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.util.concurrent.TimeUnit

/** Wires OkHttp against Friday's real backend (BuildConfig.API_BASE_URL). */
object ApiClient {
    val BASE_URL: String = BuildConfig.API_BASE_URL

    lateinit var tokenStore: TokenStore
        private set

    private var initialized = false

    fun init(tokenStore: TokenStore) {
        if (initialized) return
        this.tokenStore = tokenStore
        initialized = true
    }

    /** No auth header, no refresh-retry — used for signup/login/otp/refresh themselves. */
    val plain: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val authInterceptor = Interceptor { chain ->
        val token = if (::tokenStore.isInitialized) tokenStore.accessToken else null
        val request = if (!token.isNullOrBlank()) {
            chain.request().newBuilder().addHeader("Authorization", "Bearer $token").build()
        } else {
            chain.request()
        }
        chain.proceed(request)
    }

    private val refreshLock = Any()

    // Supabase refresh tokens are single-use. OkHttp calls this per failed request, so a burst of
    // requests that all 401 together (e.g. several rapid deletes right as the access token
    // expires) would otherwise each try to redeem the same refresh token concurrently — only the
    // first succeeds, and every other one used to return null here and fail its request outright.
    // Serialize refreshes, and once inside the lock check whether a sibling call already refreshed
    // the token (in which case we just retry with it) before spending the single-use token again.
    private val authenticator = Authenticator { _, response ->
        if (!::tokenStore.isInitialized || responseCount(response) >= 2) return@Authenticator null
        synchronized(refreshLock) {
            val failedToken = response.request.header("Authorization")?.removePrefix("Bearer ")
            val currentToken = tokenStore.accessToken
            if (!currentToken.isNullOrBlank() && currentToken != failedToken) {
                return@Authenticator response.request.newBuilder()
                    .header("Authorization", "Bearer $currentToken")
                    .build()
            }
            val refreshToken = tokenStore.refreshToken ?: return@Authenticator null
            val refreshed = AuthApi.refreshBlocking(refreshToken) ?: return@Authenticator null
            tokenStore.saveSession(refreshed.first, refreshed.second)
            SupabaseRealtime.updateAuth(refreshed.first)
            response.request.newBuilder()
                .header("Authorization", "Bearer ${refreshed.first}")
                .build()
        }
    }

    private fun responseCount(response: Response): Int {
        var count = 1
        var prior = response.priorResponse
        while (prior != null) {
            count++
            prior = prior.priorResponse
        }
        return count
    }

    /** Attaches the bearer token and auto-refreshes on 401. */
    val authed: OkHttpClient = plain.newBuilder()
        .addInterceptor(authInterceptor)
        .authenticator(authenticator)
        .build()

    /** Same as [authed] but with an unbounded read timeout for SSE. */
    val streaming: OkHttpClient = authed.newBuilder()
        .readTimeout(0, TimeUnit.SECONDS)
        .build()
}
