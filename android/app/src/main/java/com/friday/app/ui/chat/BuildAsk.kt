package com.friday.app.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.BuildAskQuestion
import com.friday.app.ui.theme.FridayChip
import com.friday.app.ui.theme.FridayHairline
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySearch
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText

private const val OTHER = -1

/** Read-only list of the questions Build Mode asked, shown in the chat thread. */
@Composable
fun AskCard(questions: List<BuildAskQuestion>) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(FridaySurface).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("Questions before building", color = FridayMuted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        questions.forEachIndexed { i, q ->
            Text("${i + 1}. ${q.question}", color = FridayText, fontSize = 14.sp)
        }
    }
}

/** Panel above the composer that walks through the questions one at a time. */
@Composable
fun AskPanel(questions: List<BuildAskQuestion>, onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    var index by remember(questions) { mutableStateOf(0) }
    val picked = remember(questions) { mutableStateMapOf<Int, Int>() }
    val other = remember(questions) { mutableStateMapOf<Int, String>() }
    val q = questions[index.coerceIn(0, questions.lastIndex)]
    val sel = picked[index]
    val answerFor = { i: Int ->
        val s = picked[i]
        when {
            s == null -> null
            s == OTHER -> other[i]?.trim()?.takeIf { it.isNotEmpty() }
            else -> questions[i].options.getOrNull(s)?.label
        }
    }
    val canNext = answerFor(index) != null
    val last = index == questions.lastIndex

    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(FridaySurface)
            .border(BorderStroke(1.dp, FridayHairline), RoundedCornerShape(20.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("${index + 1} of ${questions.size}", color = FridayMuted, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text("Skip", color = FridayMuted, fontSize = 12.sp, modifier = Modifier.clickable { onDismiss() })
            Spacer(Modifier.width(8.dp))
            Icon(Icons.Default.Close, "Dismiss questions", tint = FridayMuted, modifier = Modifier.size(18.dp).clickable { onDismiss() })
        }
        Text(q.question, color = FridayText, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Column(
            Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            q.options.forEachIndexed { oi, o ->
                val on = sel == oi
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(if (on) FridayChip else androidx.compose.ui.graphics.Color.Transparent)
                        .border(BorderStroke(if (on) 1.5.dp else 1.dp, if (on) FridaySearch else FridayHairline), RoundedCornerShape(12.dp))
                        .clickable { picked[index] = oi }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(o.label, color = FridayText, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f, fill = false))
                        if (oi == 0 || o.recommended) {
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "Recommended", color = FridaySearch, fontSize = 11.sp,
                                modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(FridayChip).padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                    if (o.description.isNotBlank()) Text(o.description, color = FridayMuted, fontSize = 12.5.sp)
                }
            }
            val otherOn = sel == OTHER
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (otherOn) FridayChip else androidx.compose.ui.graphics.Color.Transparent)
                    .border(BorderStroke(if (otherOn) 1.5.dp else 1.dp, if (otherOn) FridaySearch else FridayHairline), RoundedCornerShape(12.dp))
                    .clickable { picked[index] = OTHER }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
                Text("Other", color = FridayText, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
                if (otherOn) {
                    OutlinedTextField(
                        value = other[index].orEmpty(),
                        onValueChange = { other[index] = it },
                        placeholder = { Text("Type your answer") },
                        modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                    )
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            if (index > 0) {
                Text("Back", color = FridayMuted, fontSize = 14.sp, modifier = Modifier.clickable { index -= 1 }.padding(12.dp))
            }
            Text(
                if (last) "Submit" else "Next",
                color = androidx.compose.ui.graphics.Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier
                    .clip(RoundedCornerShape(20.dp))
                    .background(if (canNext) FridayText else FridayMuted.copy(alpha = 0.4f))
                    .clickable(enabled = canNext) {
                        if (!last) index += 1 else {
                            val text = buildString {
                                append("My answers to your questions:")
                                questions.forEachIndexed { i, qq -> append("\n- ").append(qq.question).append(": ").append(answerFor(i) ?: "(no answer)") }
                            }
                            onSubmit(text)
                        }
                    }
                    .padding(horizontal = 18.dp, vertical = 9.dp),
            )
        }
    }
}
