package com.friday.app.data.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** Friday's real pricing tiers, matching the web app's /upgrade page. */
data class PlanTier(
    val id: String,
    val name: String,
    val monthlyPrice: Int,
    val features: List<String>,
    val modelsUnlocked: List<String>,
)

val INDIVIDUAL_TIERS = listOf(
    PlanTier(
        id = "free",
        name = "Free",
        monthlyPrice = 0,
        features = listOf(
            "250,000 tokens/week",
            "50,000 tokens per 5-hour burst",
            "Lightweight models",
            "Chat, Search, Canvas preview",
        ),
        modelsUnlocked = listOf("Claude Sonnet 5", "GPT-5.4 mini", "GPT-5.5", "NVIDIA: Nemotron 3 Super", "Sarvam 105B (chat)", "Z.ai: GLM 5.2 (free)"),
    ),
    PlanTier(
        id = "pro",
        name = "Pro",
        monthlyPrice = 999,
        features = listOf(
            "Everything in Free",
            "2.5M tokens/week (10M/month)",
            "500,000 tokens per 5-hour burst",
            "Flagship models unlocked",
            "Higher concurrency",
        ),
        modelsUnlocked = listOf("Claude Opus 5", "GPT-5.6 Luna", "GPT-5.6 Sol", "GPT-5.6 Terra"),
    ),
    PlanTier(
        id = "premium",
        name = "Premium",
        monthlyPrice = 1999,
        features = listOf(
            "Everything in Pro",
            "6.25M tokens/week (25M/month)",
            "1.2M tokens per 5-hour burst",
            "Reasoning & heavy models unlocked",
            "Highest concurrency",
        ),
        modelsUnlocked = listOf("Claude Fable 5", "Fable 5.1", "GPT-6 astra"),
    ),
)

const val ENTERPRISE_PRICE_PER_SEAT = 2499
val ENTERPRISE_FEATURES = listOf(
    "Org-pooled tokens, no 5-hour lockout",
    "Per-member caps set by your own admin",
    "Every model, priority handling",
    "Centralized billing across your team",
    "Add or remove seats anytime",
)

data class BillingOrder(val id: String, val plan: String, val amountPaise: Int, val status: String, val createdAt: Long)

/** Razorpay key + currency the backend hands out for the checkout SDK. */
data class BillingConfig(val razorpayKeyId: String, val currency: String)

/** A freshly created Razorpay order, ready to hand to the checkout flow. */
data class BillingOrderCreated(val orderId: String, val amount: Int, val currency: String)

/** Real backend billing endpoints (backend/src/routes/billing.ts). There is deliberately no
 * client-side "verify payment" call — Razorpay payment confirmation only happens server-side via
 * the signed webhook (POST /api/billing/razorpay/webhook), which is what actually flips
 * profiles.plan. After Razorpay's checkout reports success, the client can only poll [orders] (or
 * usage/plan) until that order's status flips to "paid" — see FridayViewModel.confirmPayment.
 */
object BillingApi {
    private val JSON = "application/json; charset=utf-8".toMediaType()

    suspend fun config(): BillingConfig? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "billing/config").get().build()
            ApiClient.plain.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val json = JSONObject(resp.body?.string().orEmpty())
                BillingConfig(
                    razorpayKeyId = json.optString("keyId"),
                    currency = json.optString("currency").ifBlank { "INR" },
                )
            }
        }.getOrNull()
    }

    suspend fun orders(): List<BillingOrder> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ApiClient.BASE_URL + "billing/orders").get().build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use emptyList()
                val arr = JSONObject(resp.body?.string().orEmpty()).optJSONArray("orders") ?: JSONArray()
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    BillingOrder(
                        id = o.optString("id"),
                        plan = o.optString("plan"),
                        amountPaise = o.optInt("amountPaise"),
                        status = o.optString("status").ifBlank { "unknown" },
                        createdAt = o.optLong("createdAt", 0L),
                    )
                }
            }
        }.getOrElse { emptyList() }
    }

    /** POST /api/billing/orders — body {planId, billingCycle, seats?, organizationId?}, matching
     * chatController's Zod schema exactly (billing.ts:47-53). Response is {order, checkout:{key,
     * orderId, amount, currency, name, description}} — [BillingOrderCreated] is built from the
     * `checkout` block since that's what the Razorpay SDK actually needs. */
    suspend fun createOrder(planId: String, billingCycle: String, seats: Int? = null, organizationId: String? = null): BillingOrderCreated? = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().apply {
                put("planId", planId)
                put("billingCycle", billingCycle)
                if (seats != null) put("seats", seats)
                if (organizationId != null) put("organizationId", organizationId)
            }
            val request = Request.Builder()
                .url(ApiClient.BASE_URL + "billing/orders")
                .post(body.toString().toRequestBody(JSON))
                .build()
            ApiClient.authed.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val json = JSONObject(resp.body?.string().orEmpty())
                val checkout = json.optJSONObject("checkout") ?: return@use null
                BillingOrderCreated(
                    orderId = checkout.optString("orderId"),
                    amount = checkout.optInt("amount"),
                    currency = checkout.optString("currency").ifBlank { "INR" },
                )
            }
        }.getOrNull()
    }
}
