package com.friday.app.ui.shell

import com.friday.app.R

/** Which vendor a real /api/models entry belongs to, so pickers can show its brand mark. */
enum class ModelBrand(val logo: Int?) {
    Anthropic(R.drawable.ic_anthropic),
    OpenAi(R.drawable.ic_openai),
    Nvidia(R.drawable.ic_nvidia),
    Glm(R.drawable.ic_glm),
    Sarvam(R.drawable.ic_sarvam),
    Other(null),
}

// The brand mark already conveys the vendor, so repeating it in text is just noise — "Claude
// Sonnet 5" reads as "Sonnet 5" next to the Anthropic logo, matching how the composer/model-sheet
// want names shown per explicit user request.
private val modelNameBrandPrefixes = listOf("Claude ", "Z.ai: ", "NVIDIA: ")

fun shortModelName(displayName: String): String {
    for (prefix in modelNameBrandPrefixes) {
        if (displayName.startsWith(prefix)) return displayName.removePrefix(prefix).removeSuffix(" (chat)")
    }
    return displayName.removeSuffix(" (chat)")
}

fun brandOf(modelId: String, displayName: String): ModelBrand {
    val key = (modelId + " " + displayName).lowercase()
    return when {
        // "fable-5.1"/"Fable 5.1" has no "claude" in its id or display name (unlike "claude-fable-5"),
        // but it's the same ScaleMax-routed Claude codename family — see the catalog's provider
        // display_name "ScaleMax (Claude)" for every fable/sonnet/opus/gpt-* entry.
        "claude" in key || "fable" in key -> ModelBrand.Anthropic
        "gpt" in key -> ModelBrand.OpenAi
        "nemotron" in key || "nvidia" in key -> ModelBrand.Nvidia
        "glm" in key || "z-ai" in key -> ModelBrand.Glm
        "sarvam" in key -> ModelBrand.Sarvam
        else -> ModelBrand.Other
    }
}
