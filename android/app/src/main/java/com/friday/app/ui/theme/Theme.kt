package com.friday.app.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

val ComposerCorner = 28.dp
val BubbleCorner = 20.dp
val CodeCorner = 14.dp
val SheetCorner = 20.dp

private val FridayColorScheme = lightColorScheme(
    primary = FridayStop,
    onPrimary = FridayBg,
    background = FridayBg,
    onBackground = FridayText,
    surface = FridayBg,
    onSurface = FridayText,
    surfaceVariant = FridaySurface,
    onSurfaceVariant = FridayMuted,
    outline = FridayHairline,
    secondary = FridaySearch,
    tertiary = FridayThink,
)

@Composable
fun FridayTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = FridayColorScheme,
        typography = FridayTypography,
        shapes = MaterialTheme.shapes.copy(
            extraLarge = RoundedCornerShape(SheetCorner),
            large = RoundedCornerShape(ComposerCorner),
            medium = RoundedCornerShape(16.dp),
        ),
        content = content,
    )
}
