package com.friday.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.friday.app.ui.theme.FridayTheme
import com.razorpay.Checkout
import com.razorpay.PaymentData
import com.razorpay.PaymentResultWithDataListener
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject

sealed class PaymentOutcome {
    data class Success(val paymentId: String, val orderId: String, val signature: String) : PaymentOutcome()
    data class Failure(val message: String) : PaymentOutcome()
}

data class CheckoutRequest(
    val keyId: String,
    val orderId: String,
    val amount: Int,
    val currency: String,
    val email: String?,
    val contact: String?,
)

class MainActivity : ComponentActivity(), PaymentResultWithDataListener {
    private val oauthIntents = MutableStateFlow<Intent?>(null)
    val paymentResults = MutableStateFlow<PaymentOutcome?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Checkout.preload(applicationContext)
        oauthIntents.value = intent?.takeIf { it.data != null }
        setContent {
            FridayTheme {
                FridayApp(oauthIntents = oauthIntents, onStartCheckout = ::startCheckout, paymentResults = paymentResults)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.data != null) oauthIntents.value = intent
    }

    fun startCheckout(request: CheckoutRequest) {
        paymentResults.value = null
        val checkout = Checkout()
        checkout.setKeyID(request.keyId)
        runCatching {
            val options = JSONObject().apply {
                put("name", "Friday")
                put("description", "Friday Premium")
                put("order_id", request.orderId)
                put("currency", request.currency)
                put("amount", request.amount)
                put("theme.color", "#0A84FF")
                val prefill = JSONObject()
                if (!request.email.isNullOrBlank()) prefill.put("email", request.email)
                if (!request.contact.isNullOrBlank()) prefill.put("contact", request.contact)
                if (prefill.length() > 0) put("prefill", prefill)
            }
            checkout.open(this, options)
        }.onFailure {
            paymentResults.value = PaymentOutcome.Failure(it.message ?: "Couldn't open checkout.")
        }
    }

    fun consumePaymentResult() {
        paymentResults.value = null
    }

    override fun onPaymentSuccess(razorpayPaymentId: String?, paymentData: PaymentData?) {
        paymentResults.value = PaymentOutcome.Success(
            paymentId = razorpayPaymentId.orEmpty(),
            orderId = paymentData?.orderId.orEmpty(),
            signature = paymentData?.signature.orEmpty(),
        )
    }

    override fun onPaymentError(code: Int, response: String?, paymentData: PaymentData?) {
        paymentResults.value = PaymentOutcome.Failure(response ?: "Payment failed. Try again.")
    }
}
