package com.friday.app.ui.auth

import android.provider.Settings
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.R
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayText

private val LandingCard = Color(0xFF0D0D0D)
private val LandingPill = Color(0xFF2A2A2A)

@Composable
fun AuthLandingPage(
    onGoogleAuth: () -> Unit,
    onGithubAuth: () -> Unit,
    onOpenForm: () -> Unit,
    onClose: () -> Unit,
) {
    val ctx = LocalContext.current
    val reduce = remember {
        Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { visible = true }
    val entrance by animateFloatAsState(
        if (visible) 1f else 0f,
        tween(if (reduce) 0 else 420, easing = FastOutSlowInEasing),
        label = "authLandingEntrance",
    )

    Column(
        Modifier
            .fillMaxSize()
            .background(FridayBg)
            .alpha(entrance)
            .offset(y = ((1f - entrance) * 56).dp),
    ) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().padding(16.dp),
            horizontalArrangement = Arrangement.End,
        ) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(FridayBg)
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Close, "Close", tint = FridayText)
            }
        }
        AuthAnimatedHeadline(Modifier.weight(1f))

        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = 40.dp, topEnd = 40.dp))
                .background(LandingCard)
                .navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 20.dp),
        ) {
            LandingPillButton(
                label = "Continue with GitHub",
                background = Color.White,
                textColor = Color.Black,
                icon = painterResource(R.drawable.ic_github),
            ) { onGithubAuth() }
            Spacer(Modifier.height(12.dp))
            LandingPillButton(
                label = "Continue with Google",
                background = LandingPill,
                textColor = Color.White,
                icon = painterResource(R.drawable.ic_google),
            ) { onGoogleAuth() }
            Spacer(Modifier.height(12.dp))
            LandingPillButton(
                label = "Log in or sign up",
                background = LandingPill,
                textColor = Color.White,
            ) { onOpenForm() }
        }
    }
}

@Composable
private fun LandingPillButton(
    label: String,
    background: Color,
    textColor: Color,
    icon: Painter? = null,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(RoundedCornerShape(26.dp))
            .background(background)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) {
                Image(painter = icon, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
            }
            Text(label, color = textColor, fontWeight = FontWeight.Medium, fontSize = 15.sp)
        }
    }
}
