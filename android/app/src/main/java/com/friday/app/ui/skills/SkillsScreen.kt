package com.friday.app.ui.skills

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.api.Skill
import com.friday.app.data.api.SkillsApi
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayChip
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.launch

/**
 * Skills: Friday's built-in expert playbooks plus the user's own — shown in Plugins → Skills (same as web). "Use in chat"
 * pins one to the next message; otherwise Friday loads a matching enabled skill by itself. Creating custom skills is on the web.
 */
@Composable
fun SkillsList(onUse: (Skill) -> Unit) {
    var categories by remember { mutableStateOf<List<String>>(emptyList()) }
    var skills by remember { mutableStateOf<List<Skill>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        val r = SkillsApi.list()
        if (r != null) { categories = r.first; skills = r.second; failed = false } else if (skills == null) failed = true
    }
    LaunchedEffect(Unit) { load() }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(query, { query = it }, placeholder = { Text("Search skills") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp))
        val list = skills
        when {
            list != null -> {
                val q = query.trim().lowercase()
                val visible = list.filter { q.isEmpty() || (it.name + " " + it.description).lowercase().contains(q) }
                Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    categories.forEach { category ->
                        val items = visible.filter { it.category == category }
                        if (items.isNotEmpty()) {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(category, color = FridayMuted, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                                items.forEach { s ->
                                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(FridaySurface).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                            Text(s.icon, fontSize = 20.sp)
                                            Column(Modifier.weight(1f)) {
                                                Text(s.name, color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                                                Text(s.description, color = FridayMuted, fontSize = 12.5.sp)
                                            }
                                            Switch(
                                                checked = s.enabled,
                                                onCheckedChange = { on ->
                                                    skills = skills?.map { if (it.id == s.id) it.copy(enabled = on) else it }
                                                    scope.launch { if (!SkillsApi.setEnabled(s.id, on)) load() }
                                                },
                                            )
                                        }
                                        if (s.enabled) {
                                            Text(
                                                "Use in chat", color = FridayBg, fontSize = 13.sp, fontWeight = FontWeight.Medium,
                                                modifier = Modifier.clip(RoundedCornerShape(50)).background(FridayText).clickable { onUse(s) }.padding(horizontal = 12.dp, vertical = 6.dp),
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            failed -> TextButton(onClick = { scope.launch { load() } }, modifier = Modifier.padding(12.dp)) { Text("Couldn't load skills — tap to retry", color = FridayMuted) }
            else -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(strokeWidth = 2.dp) }
        }
    }
}

/** The pinned skill shown above the composer until the next message is sent. */
@Composable
fun ActiveSkillChip(skill: Skill, onClear: () -> Unit) {
    Row(
        Modifier.clip(RoundedCornerShape(50)).background(FridayChip).padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(skill.icon, fontSize = 13.sp)
        Text("Skill:", color = FridayMuted, fontSize = 12.5.sp)
        Text(skill.name, color = FridayText, fontSize = 12.5.sp)
        Icon(Icons.Default.Close, "Stop using this skill", tint = FridayMuted, modifier = Modifier.size(14.dp).clickable(onClick = onClear))
    }
}
