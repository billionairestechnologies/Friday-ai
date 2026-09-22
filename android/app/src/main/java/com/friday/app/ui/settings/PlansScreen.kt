package com.friday.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.WorkspacePremium
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.CheckoutRequest
import com.friday.app.PaymentOutcome
import com.friday.app.data.api.ENTERPRISE_FEATURES
import com.friday.app.data.api.ENTERPRISE_PRICE_PER_SEAT
import com.friday.app.data.api.INDIVIDUAL_TIERS
import com.friday.app.data.api.PlanTier
import com.friday.app.ui.FridayViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

private val PlanBg = Color(0xFF000000)
private val PlanSurface = Color(0xFF1C1C1E)
private val PlanSurfaceRaised = Color(0xFF232326)
private val PlanText = Color(0xFFFFFFFF)
private val PlanMuted = Color(0xFF98989D)
private val PlanAccent = Color(0xFF0A84FF)
private val PlanHairline = Color(0x1FFFFFFF)

fun isFreePlan(plan: String?): Boolean = plan.isNullOrBlank() || plan.equals("free", ignoreCase = true)

@Composable
fun PlansScreen(
    vm: FridayViewModel,
    onBack: () -> Unit,
    onStartCheckout: (CheckoutRequest) -> Unit,
    paymentResults: MutableStateFlow<PaymentOutcome?>?,
) {
    val ui by vm.state.collectAsState()
    val scope = rememberCoroutineScope()
    var business by remember { mutableStateOf(false) }
    var annual by remember { mutableStateOf(false) }
    var pendingTier by remember { mutableStateOf<String?>(null) }
    var verifying by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var success by remember { mutableStateOf(false) }
    var team by remember { mutableStateOf("") }
    var seats by remember { mutableStateOf(3) }
    val currentPlan = ui.plan?.lowercase()

    val paymentResult = paymentResults?.collectAsState()?.value
    LaunchedEffect(paymentResult) {
        when (val result = paymentResult) {
            is PaymentOutcome.Success -> {
                verifying = true
                pendingTier = null
                vm.confirmPayment(result.orderId) { ok ->
                    verifying = false
                    if (ok) success = true else error = "Payment received but is taking longer than usual to confirm. Check Billing in a minute."
                }
                paymentResults.value = null
            }
            is PaymentOutcome.Failure -> {
                pendingTier = null
                error = result.message
                paymentResults?.value = null
            }
            null -> {}
        }
    }

    fun startPurchase(planId: String, seatCount: Int? = null) {
        pendingTier = planId
        error = null
        scope.launch {
            val (order, config) = vm.createBillingOrder(
                plan = planId,
                interval = if (annual) "annual" else "monthly",
                seats = seatCount,
            )
            pendingTier = null
            if (order == null || config?.razorpayKeyId.isNullOrBlank()) {
                error = "Couldn't start checkout — try again in a moment."
            } else {
                onStartCheckout(
                    CheckoutRequest(
                        keyId = config.razorpayKeyId,
                        orderId = order.orderId,
                        amount = order.amount,
                        currency = order.currency,
                        email = ui.user?.email,
                        contact = ui.user?.phone,
                    ),
                )
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(PlanBg)
            .statusBarsPadding(),
    ) {
        Box(Modifier.fillMaxWidth().padding(16.dp)) {
            Icon(
                Icons.Default.Close,
                "Close",
                tint = PlanText,
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .clip(CircleShape)
                    .background(PlanSurface)
                    .clickable(onClick = onBack)
                    .padding(8.dp),
            )
        }

        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            Text("Friday", color = PlanText, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(4.dp))
            Text("Manage your subscription", color = PlanText, fontSize = 26.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())

            Spacer(Modifier.height(20.dp))
            Row(
                Modifier
                    .align(Alignment.CenterHorizontally)
                    .clip(RoundedCornerShape(50))
                    .background(PlanSurface)
                    .padding(3.dp),
            ) {
                SegmentButton("Individual", !business) { business = false }
                SegmentButton("Business", business) { business = true }
            }

            Spacer(Modifier.height(14.dp))
            Row(
                Modifier.align(Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Annual", color = PlanMuted, fontSize = 14.sp)
                Switch(
                    checked = annual,
                    onCheckedChange = { annual = it },
                    colors = SwitchDefaults.colors(checkedTrackColor = PlanAccent),
                    modifier = Modifier.size(width = 40.dp, height = 24.dp),
                )
                Text("Save 10%", color = PlanMuted, fontSize = 14.sp)
            }

            Spacer(Modifier.height(22.dp))

            if (!business) {
                INDIVIDUAL_TIERS.forEach { tier ->
                    TierCard(
                        tier = tier,
                        annual = annual,
                        isCurrent = currentPlan == tier.id,
                        busy = pendingTier == tier.id,
                        onUpgrade = { startPurchase(tier.id) },
                    )
                    Spacer(Modifier.height(14.dp))
                }
            } else {
                val price = ENTERPRISE_PRICE_PER_SEAT.let { if (annual) (it * 0.9).toInt() else it }
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(20.dp))
                        .background(PlanSurface)
                        .padding(20.dp),
                ) {
                    Text("Enterprise", color = PlanText, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(6.dp))
                    Row(verticalAlignment = Alignment.Bottom) {
                        Text("₹$price", color = PlanText, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                        Text(" /seat/month", color = PlanMuted, fontSize = 13.sp, modifier = Modifier.padding(bottom = 5.dp))
                    }

                    Spacer(Modifier.height(16.dp))
                    Text("Team", color = PlanMuted, fontSize = 12.5.sp)
                    Spacer(Modifier.height(4.dp))
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(PlanSurfaceRaised)
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                    ) {
                        BasicTextField(
                            value = team,
                            onValueChange = { team = it },
                            singleLine = true,
                            textStyle = TextStyle(color = PlanText, fontSize = 15.sp),
                            modifier = Modifier.fillMaxWidth(),
                            decorationBox = { inner ->
                                if (team.isEmpty()) Text("Your team name", color = PlanMuted, fontSize = 15.sp)
                                inner()
                            },
                        )
                    }

                    Spacer(Modifier.height(14.dp))
                    Text("Seats (min 3)", color = PlanMuted, fontSize = 12.5.sp)
                    Spacer(Modifier.height(4.dp))
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(PlanSurfaceRaised),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        SeatStepButton("–") { if (seats > 3) seats-- }
                        Text(
                            "$seats",
                            color = PlanText,
                            fontSize = 15.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.weight(1f),
                        )
                        SeatStepButton("+") { seats++ }
                    }

                    Spacer(Modifier.height(18.dp))
                    val enterpriseCurrent = currentPlan == "enterprise"
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(24.dp))
                            .background(if (enterpriseCurrent) PlanSurfaceRaised else PlanAccent)
                            .clickable(enabled = !enterpriseCurrent && pendingTier != "enterprise" && team.isNotBlank()) {
                                startPurchase("enterprise", seats)
                            }
                            .padding(vertical = 14.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        when {
                            enterpriseCurrent -> Text("Current Plan", color = PlanMuted, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            pendingTier == "enterprise" -> CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp), color = PlanText)
                            else -> Text("Pay ₹${price * seats}", color = PlanText, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }

                    Spacer(Modifier.height(16.dp))
                    ENTERPRISE_FEATURES.forEach { feature ->
                        Row(Modifier.padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Check, null, tint = PlanAccent, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(feature, color = PlanText, fontSize = 13.5.sp)
                        }
                    }
                }
            }

            if (error != null) {
                Spacer(Modifier.height(14.dp))
                Text(error!!, color = Color(0xFFFF6B6B), fontSize = 13.sp)
            }
            if (verifying) {
                Spacer(Modifier.height(14.dp))
                Text("Confirming payment…", color = PlanMuted, fontSize = 13.sp)
            }
            if (success) {
                Spacer(Modifier.height(14.dp))
                Text("Payment confirmed — your plan is updated.", color = Color(0xFF32D74B), fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
            Spacer(Modifier.height(24.dp))
        }
        Spacer(Modifier.navigationBarsPadding())
    }
}

@Composable
private fun SegmentButton(label: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(if (selected) PlanText else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 9.dp),
    ) {
        Text(label, color = if (selected) PlanBg else PlanMuted, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun SeatStepButton(label: String, onClick: () -> Unit) {
    Box(
        Modifier.size(44.dp).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = PlanText, fontSize = 18.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun TierCard(
    tier: PlanTier,
    annual: Boolean,
    isCurrent: Boolean,
    busy: Boolean,
    onUpgrade: () -> Unit,
) {
    val price = if (annual && tier.monthlyPrice > 0) (tier.monthlyPrice * 0.9).toInt() else tier.monthlyPrice
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(PlanSurface)
            .padding(20.dp),
    ) {
        Text(tier.name, color = PlanText, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            Text("₹$price", color = PlanText, fontSize = 30.sp, fontWeight = FontWeight.Bold)
            Text(" /month", color = PlanMuted, fontSize = 13.sp, modifier = Modifier.padding(bottom = 5.dp))
        }

        Spacer(Modifier.height(16.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(24.dp))
                .background(if (isCurrent) PlanSurfaceRaised else PlanAccent)
                .clickable(enabled = !isCurrent && !busy, onClick = onUpgrade)
                .padding(vertical = 14.dp),
            contentAlignment = Alignment.Center,
        ) {
            when {
                isCurrent -> Text("Current Plan", color = PlanMuted, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                busy -> CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp), color = PlanText)
                tier.monthlyPrice == 0 -> Text("Get Started", color = PlanText, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                else -> Text("Upgrade to ${tier.name}", color = PlanText, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        Spacer(Modifier.height(16.dp))
        tier.features.forEach { feature ->
            Row(Modifier.padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Check, null, tint = PlanAccent, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(8.dp))
                Text(feature, color = PlanText, fontSize = 13.5.sp)
            }
        }

        Spacer(Modifier.height(10.dp))
        Box(Modifier.fillMaxWidth().height(1.dp).background(PlanHairline))
        Spacer(Modifier.height(10.dp))
        Text("MODELS UNLOCKED", color = PlanMuted, fontSize = 11.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(8.dp))
        FlowChips(tier.modelsUnlocked)
    }
}

@Composable
private fun FlowChips(items: List<String>) {
    // Simple wrap: chunk into rows that fit roughly, since Compose foundation FlowRow isn't in this BOM.
    var line = mutableListOf<String>()
    val rows = mutableListOf<List<String>>()
    var lineLen = 0
    items.forEach { item ->
        if (lineLen + item.length > 34 && line.isNotEmpty()) {
            rows.add(line)
            line = mutableListOf()
            lineLen = 0
        }
        line.add(item)
        lineLen += item.length + 2
    }
    if (line.isNotEmpty()) rows.add(line)

    Column {
        rows.forEach { row ->
            Row(Modifier.padding(bottom = 6.dp)) {
                row.forEach { label ->
                    Box(
                        Modifier
                            .padding(end = 6.dp)
                            .clip(RoundedCornerShape(50))
                            .background(PlanSurfaceRaised)
                            .padding(horizontal = 10.dp, vertical = 5.dp),
                    ) {
                        Text(label, color = PlanText, fontSize = 11.5.sp)
                    }
                }
            }
        }
    }
}
