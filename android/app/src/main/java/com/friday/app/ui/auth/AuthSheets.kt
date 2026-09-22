package com.friday.app.ui.auth

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.R
import com.friday.app.data.Sheet
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayHairline
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.delay

private val FridayError = Color(0xFFDC2626)

private val authHeadlinePhrases = listOf("Friday AI", "Let's chat", "Let's invent", "Let's code", "Let's discover")

@Composable
fun AuthSheetBody(
    sheet: Sheet,
    busy: Boolean,
    error: String?,
    onSubmit: (email: String, password: String, name: String, phone: String, birthday: String) -> Unit,
    onGoogleAuth: () -> Unit,
    onGithubAuth: () -> Unit,
    onOpen: (Sheet) -> Unit,
    onClose: () -> Unit,
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var birthday by remember { mutableStateOf("") }
    val isSignup = sheet == Sheet.Signup
    val title = when (sheet) {
        Sheet.Welcome -> "Welcome back"
        Sheet.Signup -> "Create your account"
        else -> "Log in or sign up"
    }
    val sub = when (sheet) {
        Sheet.Welcome -> "Pick up where you left off."
        Sheet.Signup -> "Smarter replies, files, Canvas history, sync across devices."
        else -> "Smarter replies, files, Canvas history, sync across devices."
    }

    Column(Modifier.padding(horizontal = 20.dp, vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Spacer(Modifier.size(36.dp))
            Box(
                Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Close, "Close", tint = FridayMuted)
            }
        }
        Text(title, color = FridayText, fontSize = 22.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(6.dp))
        Text(sub, color = FridayMuted, fontSize = 14.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(18.dp))
        if (isSignup) {
            AuthField(value = name, onChange = { name = it }, placeholder = "Name")
            Spacer(Modifier.height(10.dp))
            AuthField(value = phone, onChange = { phone = it }, placeholder = "Mobile number", keyboardType = KeyboardType.Phone)
            Spacer(Modifier.height(10.dp))
            AuthField(value = birthday, onChange = { birthday = it }, placeholder = "Birthday (YYYY-MM-DD)", keyboardType = KeyboardType.Number)
            Spacer(Modifier.height(10.dp))
        }
        AuthField(value = email, onChange = { email = it }, placeholder = "Email address", keyboardType = KeyboardType.Email)
        Spacer(Modifier.height(10.dp))
        AuthField(value = password, onChange = { password = it }, placeholder = "Password", isPassword = true)
        if (error != null) {
            Spacer(Modifier.height(10.dp))
            Text(error, color = FridayError, fontSize = 13.sp, lineHeight = 18.sp)
        }
        Spacer(Modifier.height(12.dp))
        PillButton(if (busy) "Please wait…" else "Continue", filled = true, enabled = !busy) {
            onSubmit(email.trim(), password, name.trim(), phone.trim(), birthday.trim())
        }
        Spacer(Modifier.height(14.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(1.dp).background(FridayHairline))
            Text("  OR  ", color = FridayMuted, fontSize = 12.sp)
            Box(Modifier.weight(1f).height(1.dp).background(FridayHairline))
        }
        Spacer(Modifier.height(14.dp))
        PillButton("Continue with Google", icon = painterResource(R.drawable.ic_google), enabled = !busy) {
            onGoogleAuth()
        }
        Spacer(Modifier.height(8.dp))
        PillButton("Continue with GitHub", icon = painterResource(R.drawable.ic_github), enabled = !busy) {
            onGithubAuth()
        }
        Spacer(Modifier.height(16.dp))
        Row {
            when (sheet) {
                Sheet.Welcome -> {
                    Text("Don’t have an account? ", color = FridayMuted, fontSize = 13.sp)
                    Text("Sign up", color = FridayText, fontWeight = FontWeight.Medium, fontSize = 13.sp, modifier = Modifier.clickable { onOpen(Sheet.Signup) })
                }
                Sheet.Signup -> {
                    Text("Already have an account? ", color = FridayMuted, fontSize = 13.sp)
                    Text("Log in", color = FridayText, fontWeight = FontWeight.Medium, fontSize = 13.sp, modifier = Modifier.clickable { onOpen(Sheet.Welcome) })
                }
                else -> {
                    Text("Log in", color = FridayText, fontWeight = FontWeight.Medium, fontSize = 13.sp, modifier = Modifier.clickable { onOpen(Sheet.Welcome) })
                    Text("  ·  ", color = FridayMuted)
                    Text("Sign up", color = FridayText, fontWeight = FontWeight.Medium, fontSize = 13.sp, modifier = Modifier.clickable { onOpen(Sheet.Signup) })
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun PillButton(
    label: String,
    filled: Boolean = false,
    icon: Painter? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(48.dp)
            .alpha(if (enabled) 1f else 0.55f)
            .clip(RoundedCornerShape(24.dp))
            .background(if (filled) FridayText else FridayBg)
            .then(if (filled) Modifier else Modifier.border(1.dp, FridayHairline, RoundedCornerShape(24.dp)))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) {
                Image(painter = icon, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
            }
            Text(label, color = if (filled) FridayBg else FridayText, fontWeight = FontWeight.Medium, fontSize = 14.sp)
        }
    }
}

@Composable
private fun AuthField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    isPassword: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(FridaySurface)
            .padding(horizontal = 14.dp, vertical = 14.dp),
    ) {
        if (value.isEmpty()) Text(placeholder, color = FridayMuted, fontSize = 15.sp)
        BasicTextField(
            value = value,
            onValueChange = onChange,
            textStyle = TextStyle(color = FridayText, fontSize = 15.sp),
            cursorBrush = SolidColor(FridayText),
            singleLine = true,
            visualTransformation = if (isPassword) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            keyboardOptions = KeyboardOptions(
                keyboardType = if (isPassword) KeyboardType.Password else keyboardType,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
fun AuthOtpBody(
    email: String,
    busy: Boolean,
    error: String?,
    onVerify: (String) -> Unit,
    onResend: () -> Unit,
    onClose: () -> Unit,
) {
    var code by remember { mutableStateOf("") }
    Column(Modifier.padding(horizontal = 20.dp, vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Spacer(Modifier.size(36.dp))
            Box(
                Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Close, "Close", tint = FridayMuted)
            }
        }
        Text("Check your email", color = FridayText, fontSize = 22.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.height(6.dp))
        Text("We sent a 6-digit code to $email", color = FridayMuted, fontSize = 14.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(18.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(FridaySurface)
                .padding(horizontal = 14.dp, vertical = 14.dp),
        ) {
            if (code.isEmpty()) Text("6-digit code", color = FridayMuted, fontSize = 15.sp)
            BasicTextField(
                value = code,
                onValueChange = { if (it.length <= 6 && it.all(Char::isDigit)) code = it },
                textStyle = TextStyle(color = FridayText, fontSize = 20.sp, letterSpacing = 6.sp, fontWeight = FontWeight.Medium),
                cursorBrush = SolidColor(FridayText),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (error != null) {
            Spacer(Modifier.height(10.dp))
            Text(error, color = FridayError, fontSize = 13.sp, lineHeight = 18.sp)
        }
        Spacer(Modifier.height(12.dp))
        PillButton(if (busy) "Verifying…" else "Verify", filled = true, enabled = !busy && code.length == 6) {
            onVerify(code)
        }
        Spacer(Modifier.height(16.dp))
        Row {
            Text("Didn’t get it? ", color = FridayMuted, fontSize = 13.sp)
            Text("Resend code", color = FridayText, fontWeight = FontWeight.Medium, fontSize = 13.sp, modifier = Modifier.clickable(onClick = onResend))
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
fun AuthAnimatedHeadline(modifier: Modifier = Modifier) {
    var phraseIndex by remember { mutableStateOf(0) }
    var displayed by remember { mutableStateOf("") }
    var typing by remember { mutableStateOf(true) }

    LaunchedEffect(phraseIndex, typing) {
        val target = authHeadlinePhrases[phraseIndex]
        if (typing) {
            for (i in 1..target.length) {
                displayed = target.substring(0, i)
                delay(65)
            }
            delay(1000)
            typing = false
        } else {
            for (i in target.length downTo 0) {
                displayed = target.substring(0, i)
                delay(30)
            }
            delay(250)
            phraseIndex = (phraseIndex + 1) % authHeadlinePhrases.size
            typing = true
        }
    }

    Box(
        modifier
            .fillMaxWidth()
            .background(FridayBg),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                displayed,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                color = FridayText,
                lineHeight = 32.sp,
            )
            Spacer(Modifier.width(4.dp))
            Box(Modifier.size(22.dp).clip(CircleShape).background(FridayText))
        }
    }
}
