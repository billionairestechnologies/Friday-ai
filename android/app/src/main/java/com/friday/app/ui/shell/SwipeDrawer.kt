package com.friday.app.ui.shell

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.clickable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.foundation.layout.offset
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

/** Open/closed state for [SwipeDrawer]; `open()`/`close()` animate exactly like a finished swipe. */
@Stable
class SwipeDrawerState internal constructor(initiallyOpen: Boolean) {
    var isOpen by mutableStateOf(initiallyOpen)
        internal set
    internal var request by mutableStateOf<Boolean?>(null)

    fun open() { request = true }
    fun close() { request = false }
}

@Composable
fun rememberSwipeDrawerState(initiallyOpen: Boolean = false) = remember { SwipeDrawerState(initiallyOpen) }

/**
 * A WhatsApp-style side drawer: the panel tracks the finger 1:1 and, on release, a stiff
 * critically-damped spring finishes the motion — a quarter of the width (or any quick fling)
 * is enough to commit. Material's ModalNavigationDrawer needs a much longer drag and animates
 * slower, which is what made swiping feel sluggish.
 */
@Composable
fun SwipeDrawer(
    state: SwipeDrawerState,
    gesturesEnabled: Boolean,
    drawerContent: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val widthPx = constraints.maxWidth.toFloat()
        val offset = remember(widthPx) { Animatable(if (state.isOpen) 0f else -widthPx) }
        var startedOpen by remember { mutableStateOf(false) }
        val settle = spring<Float>(dampingRatio = 0.9f, stiffness = 650f)

        fun settleTo(open: Boolean, velocity: Float = 0f) {
            state.isOpen = open
            scope.launch { offset.animateTo(if (open) 0f else -widthPx, settle, initialVelocity = velocity) }
        }

        LaunchedEffect(state.request, widthPx) {
            state.request?.let { settleTo(it) }
            state.request = null
        }

        val dragState = rememberDraggableState { delta ->
            scope.launch { offset.snapTo((offset.value + delta).coerceIn(-widthPx, 0f)) }
        }

        Box(
            Modifier
                .fillMaxSize()
                .draggable(
                    state = dragState,
                    orientation = Orientation.Horizontal,
                    enabled = gesturesEnabled,
                    onDragStarted = { startedOpen = state.isOpen },
                    onDragStopped = { velocity ->
                        val revealed = (offset.value + widthPx) / widthPx // 0 closed .. 1 open
                        val open = when {
                            abs(velocity) > 500f -> velocity > 0
                            startedOpen -> revealed > 0.75f
                            else -> revealed > 0.25f
                        }
                        settleTo(open, velocity)
                    },
                ),
        ) {
            content()
            if (offset.value > -widthPx + 1f) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .offset { IntOffset(offset.value.roundToInt(), 0) }
                        // Swallow taps so nothing behind the panel is triggered while it's visible.
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
                ) { drawerContent() }
            }
        }
    }
}
