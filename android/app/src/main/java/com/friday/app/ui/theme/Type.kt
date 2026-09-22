package com.friday.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val FridaySans = FontFamily.SansSerif

val FridayTypography = Typography(
    displayLarge = TextStyle(
        fontFamily = FridaySans,
        fontWeight = FontWeight.Medium,
        fontSize = 32.sp,
        lineHeight = 40.sp,
        letterSpacing = (-0.5).sp,
        color = FridayText,
    ),
    titleLarge = TextStyle(
        fontFamily = FridaySans,
        fontWeight = FontWeight.Medium,
        fontSize = 17.sp,
        letterSpacing = (-0.2).sp,
        color = FridayText,
    ),
    bodyLarge = TextStyle(
        fontFamily = FridaySans,
        fontWeight = FontWeight.Normal,
        fontSize = 15.5.sp,
        lineHeight = 24.sp,
        letterSpacing = (-0.2).sp,
        color = FridayText,
    ),
    bodyMedium = TextStyle(
        fontFamily = FridaySans,
        fontWeight = FontWeight.Normal,
        fontSize = 13.5.sp,
        lineHeight = 20.sp,
        color = FridayText,
    ),
    labelMedium = TextStyle(
        fontFamily = FridaySans,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        color = FridayText,
    ),
    labelSmall = TextStyle(
        fontFamily = FridaySans,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        letterSpacing = 0.6.sp,
        color = FridayMuted,
    ),
)
