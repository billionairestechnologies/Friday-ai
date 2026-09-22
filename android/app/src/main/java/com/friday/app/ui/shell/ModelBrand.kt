package com.friday.app.ui.shell

import com.friday.app.R

/** Which vendor a real /api/models entry belongs to, so pickers can show its brand mark. */
enum class ModelBrand(val logo: Int?) {
    Anthropic(R.drawable.ic_anthropic),
    OpenAi(R.drawable.ic_openai),
    Nvidia(R.drawable.ic_nvidia),
    Other(null),
}

fun brandOf(modelId: String, displayName: String): ModelBrand {
    val key = (modelId + " " + displayName).lowercase()
    return when {
        "claude" in key -> ModelBrand.Anthropic
        "gpt" in key -> ModelBrand.OpenAi
        "nemotron" in key || "nvidia" in key -> ModelBrand.Nvidia
        else -> ModelBrand.Other
    }
}
