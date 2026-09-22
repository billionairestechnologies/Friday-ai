package com.friday.app.ui.chat

/** Rotating phrase pools for the Thought Trail card, one active/pill pair per mode. */
object ThinkingLines {
    /** Rotates as the bold "current step" line while a phase is active. */
    val activeThink = listOf("Consulting my inner monologue…", "Turning this over a few times…", "Untangling this properly…", "Reasoning through it…")
    val activeSearch = listOf("Digging through the results…", "Cross-checking sources…", "Piecing it together…")
    val activeCanvas = listOf("Writing the code…", "Putting it together…", "Sketching it out…")

    /** Rotates as the small italic pill beneath the active step. */
    val pillThink = listOf("Connecting the dots…", "Working through the angles…", "Mapping the pieces…")
    val pillSearch = listOf("Chasing down the latest on this…", "Scanning for the details…", "Lining up the sources…")
    val pillCanvas = listOf("Shaping the layout…", "Refining the structure…")

    // Kept as aliases for the bare pre-content thinking pill (ThinkingPill / mock thinkingLabel).
    val plain = activeThink
    val search = activeSearch
    val canvas = activeCanvas
}
