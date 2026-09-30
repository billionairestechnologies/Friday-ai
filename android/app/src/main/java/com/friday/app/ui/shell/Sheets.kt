package com.friday.app.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.TravelExplore
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.RocketLaunch
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.R
import com.friday.app.data.ModelId
import com.friday.app.data.api.RemoteModel
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText

private fun modelIcon(id: ModelId): ImageVector = when (id) {
    ModelId.Auto -> Icons.Default.RocketLaunch
    ModelId.Flash -> Icons.Default.Bolt
    ModelId.Pro -> Icons.Default.Psychology
}

@Composable
private fun ModelBrandIcon(modelId: String, displayName: String) {
    Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
        when (modelId) {
            com.friday.app.data.AUTO_MODEL_ID -> Icon(Icons.Default.Bolt, null, tint = FridayText, modifier = Modifier.size(22.dp))
            com.friday.app.data.TEAMUP_MODEL_ID -> Icon(Icons.Default.Groups, null, tint = FridayText, modifier = Modifier.size(22.dp))
            else -> {
                val brand = brandOf(modelId, displayName)
                if (brand.logo != null) {
                    Icon(
                        painter = painterResource(brand.logo),
                        contentDescription = null,
                        tint = FridayText,
                        modifier = Modifier.size(22.dp),
                    )
                } else {
                    Icon(Icons.Default.AutoAwesome, null, tint = FridayText, modifier = Modifier.size(22.dp))
                }
            }
        }
    }
}

/** Real /api/models list when available; falls back to the local mock trio for guests/offline. */
@Composable
fun ModelSheet(
    remoteModels: List<RemoteModel>,
    selectedModelId: String?,
    localSelected: ModelId,
    plan: String?,
    onLocked: () -> Unit,
    onPickRemote: (String) -> Unit,
    onPickLocal: (ModelId) -> Unit,
) {
    Column(Modifier.padding(horizontal = 8.dp, vertical = 8.dp).heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
        if (remoteModels.isNotEmpty()) {
            remoteModels.forEach { m ->
                val isSelected = m.modelId == selectedModelId
                val rank = mapOf("free" to 0, "pro" to 1, "premium" to 2)
                val locked = (rank[plan?.lowercase() ?: "free"] ?: 0) < (rank[m.minTier.lowercase()] ?: 0)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .clickable { if (locked) onLocked() else onPickRemote(m.modelId) }
                        .alpha(if (locked) 0.55f else 1f)
                        .background(if (isSelected) FridaySurface else androidx.compose.ui.graphics.Color.Transparent)
                        .padding(horizontal = 10.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    ModelBrandIcon(m.modelId, m.displayName)
                    Column(Modifier.weight(1f)) {
                        Text(shortModelName(m.displayName), color = FridayText, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        val subtitle = when (m.modelId) {
                            com.friday.app.data.AUTO_MODEL_ID -> "Tries enabled models in order, falls back automatically"
                            com.friday.app.data.TEAMUP_MODEL_ID -> "Asks up to 3 models at once and shows every reply"
                            else -> m.minTier.replaceFirstChar { it.uppercase() } + " tier"
                        }
                        Text(subtitle, color = FridayMuted, fontSize = 12.5.sp)
                    }
                    if (locked) Icon(Icons.Default.Lock, null, tint = FridayMuted, modifier = Modifier.size(18.dp))
                    else if (isSelected) Icon(Icons.Default.Check, null, tint = FridayText, modifier = Modifier.size(20.dp))
                }
            }
        } else {
            ModelId.entries.forEach { id ->
                val isSelected = id == localSelected
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(16.dp))
                        .clickable { onPickLocal(id) }
                        .background(if (isSelected) FridaySurface else androidx.compose.ui.graphics.Color.Transparent)
                        .padding(horizontal = 12.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Icon(modelIcon(id), null, tint = FridayText, modifier = Modifier.size(24.dp))
                    Column(Modifier.weight(1f)) {
                        Text(id.label, color = FridayText, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                        Text(id.hint, color = FridayMuted, fontSize = 13.5.sp)
                    }
                    if (isSelected) Icon(Icons.Default.Check, null, tint = FridayText, modifier = Modifier.size(20.dp))
                }
            }
        }
    }
}

@Composable
fun AttachSheet(
    onCamera: () -> Unit,
    onPhotos: () -> Unit,
    onFiles: () -> Unit,
    onPlugins: () -> Unit,
    /** Deep Research on/off for the next message — same place as the web's "+" menu. */
    researchOn: Boolean = false,
    onToggleResearch: () -> Unit = {},
) {
    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        AttachRow(Icons.Default.CameraAlt, "Camera", onCamera)
        AttachRow(Icons.Default.Photo, "Photos", onPhotos)
        AttachRow(Icons.AutoMirrored.Filled.InsertDriveFile, "Files", onFiles)
        AttachRow(Icons.Default.TravelExplore, "Deep research", onToggleResearch, checked = researchOn)
        AttachRow(Icons.Default.Extension, "Plugins", onPlugins)
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun AttachRow(icon: ImageVector, label: String, onClick: () -> Unit, checked: Boolean = false) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(
            Modifier.size(40.dp).clip(CircleShape).background(FridaySurface),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, null, tint = FridayText, modifier = Modifier.size(20.dp))
        }
        Text(label, color = FridayText, fontSize = 17.sp, modifier = Modifier.weight(1f))
        if (checked) Icon(Icons.Default.Check, "On", tint = com.friday.app.ui.theme.FridayCanvas, modifier = Modifier.size(20.dp))
    }
}

@Composable
fun PluginsSheet(tab: String, onTab: (String) -> Unit) {
    Column(Modifier.padding(20.dp)) {
        Text("Plugins", fontWeight = FontWeight.Medium, fontSize = 18.sp, color = FridayText)
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TabChip("Connectors", tab == "connectors") { onTab("connectors") }
            TabChip("Skills", tab == "skills") { onTab("skills") }
        }
        Spacer(Modifier.height(16.dp))
        if (tab == "connectors") {
            PluginRow("Gmail", "Unread mail as extra context")
            PluginRow("Calendar", "Upcoming events")
            PluginRow("Drive", "Recent files")
            PluginRow("GitHub", "Open pull requests")
        } else {
            PluginRow("Web Search", "Live sources when Search is on")
            PluginRow("Think", "Deeper reasoning steps")
            PluginRow("Canvas", "Workspace for layouts and code")
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun TabChip(label: String, on: Boolean, click: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(if (on) FridayText else FridaySurface)
            .clickable(onClick = click)
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Text(label, color = if (on) androidx.compose.ui.graphics.Color.White else FridayText, fontSize = 13.sp)
    }
}

@Composable
private fun PluginRow(title: String, hint: String) {
    Column(Modifier.padding(vertical = 8.dp)) {
        Text(title, color = FridayText, fontWeight = FontWeight.Medium, fontSize = 15.sp)
        Text(hint, color = FridayMuted, fontSize = 13.sp)
    }
}

