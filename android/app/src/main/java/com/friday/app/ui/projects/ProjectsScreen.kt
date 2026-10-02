package com.friday.app.ui.projects

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.ChatThread
import com.friday.app.data.api.ProjectFile
import com.friday.app.data.api.ProjectSummary
import com.friday.app.data.api.ProjectsApi
import com.friday.app.ui.theme.FridayBg
import com.friday.app.ui.theme.FridayChip
import com.friday.app.ui.theme.FridayError
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Projects: a project keeps its own instructions and a knowledge base of files that every chat inside it can
 * search (web parity: routes/projects.tsx + components/project-files.tsx).
 */
@Composable
fun ProjectsScreen(
    onClose: () -> Unit,
    onNewChat: (projectId: String) -> Unit,
    onOpenChat: (ChatThread) -> Unit,
) {
    var projects by remember { mutableStateOf<List<ProjectSummary>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var open by remember { mutableStateOf<ProjectSummary?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        val list = ProjectsApi.list()
        if (list != null) { projects = list; failed = false } else if (projects == null) failed = true
    }
    LaunchedEffect(Unit) { load() }

    val current = open
    if (current != null) {
        ProjectDetail(
            project = current,
            onBack = { open = null },
            onDeleted = { open = null; scope.launch { load() } },
            onNewChat = onNewChat,
            onOpenChat = onOpenChat,
        )
        return
    }

    Column(Modifier.fillMaxSize().background(FridayBg).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 16.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Projects", color = FridayText, fontSize = 22.sp, fontWeight = FontWeight.Medium)
                Text("Instructions and files every chat in a project can use", color = FridayMuted, fontSize = 13.sp)
            }
            Box(Modifier.size(40.dp).clickable { creating = true }, contentAlignment = Alignment.Center) { Icon(Icons.Default.Add, "New project", tint = FridayText) }
            Box(Modifier.size(40.dp).clickable(onClick = onClose), contentAlignment = Alignment.Center) { Icon(Icons.Default.Close, "Close", tint = FridayText) }
        }
        val list = projects
        when {
            list != null && list.isEmpty() -> Text("No projects yet. Tap + to create one, then add files for Friday to search.", color = FridayMuted, fontSize = 14.sp, modifier = Modifier.padding(20.dp))
            list != null -> Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                list.forEach { p ->
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(FridaySurface).clickable { open = p }.padding(14.dp),
                    ) {
                        Text(p.name, color = FridayText, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                        if (p.description.isNotBlank()) Text(p.description, color = FridayMuted, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            failed -> TextButton(onClick = { scope.launch { load() } }, modifier = Modifier.padding(12.dp)) { Text("Couldn't load projects — tap to retry", color = FridayMuted) }
            else -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(strokeWidth = 2.dp) }
        }
    }

    if (creating) {
        NewProjectDialog(onDismiss = { creating = false }, onCreated = { creating = false; scope.launch { load() } })
    }
}

@Composable
private fun NewProjectDialog(onDismiss: () -> Unit, onCreated: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var instructions by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New project") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true)
                OutlinedTextField(description, { description = it }, label = { Text("What is it? (optional)") }, singleLine = true)
                OutlinedTextField(instructions, { instructions = it }, label = { Text("Instructions for Friday (optional)") }, minLines = 3)
                error?.let { Text(it, color = FridayError, fontSize = 13.sp) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !saving && name.isNotBlank(),
                onClick = {
                    saving = true
                    scope.launch {
                        if (ProjectsApi.create(name.trim(), description.trim(), instructions.trim())) onCreated()
                        else { error = "Couldn't create the project. Try again."; saving = false }
                    }
                },
            ) { Text(if (saving) "Creating…" else "Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private fun size(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1_048_576 -> "${bytes / 1024} KB"
    else -> "%.1f MB".format(bytes / 1_048_576.0)
}

@Composable
private fun ProjectDetail(
    project: ProjectSummary,
    onBack: () -> Unit,
    onDeleted: () -> Unit,
    onNewChat: (String) -> Unit,
    onOpenChat: (ChatThread) -> Unit,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var files by remember { mutableStateOf<List<ProjectFile>?>(null) }
    var chats by remember { mutableStateOf<List<ChatThread>>(emptyList()) }
    var uploading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }

    suspend fun refresh() {
        ProjectsApi.files(project.id)?.let { files = it } ?: run { if (files == null) files = emptyList() }
        chats = ProjectsApi.conversations(project.id)
    }
    LaunchedEffect(project.id) {
        refresh()
        // Files are read in the background: poll while any is still processing.
        while (true) {
            delay(3000)
            if (files?.any { it.status == "processing" } == true) refresh()
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        uploading = true
        error = null
        scope.launch {
            for (uri in uris) ProjectsApi.upload(ctx, project.id, uri)?.let { error = it }
            uploading = false
            refresh()
        }
    }

    Column(Modifier.fillMaxSize().background(FridayBg).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(project.name, color = FridayText, fontSize = 22.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Box(Modifier.size(40.dp).clickable(onClick = onBack), contentAlignment = Alignment.Center) { Icon(Icons.Default.Close, "Back", tint = FridayText) }
        }
        if (project.instructions.isNotBlank()) Text(project.instructions, color = FridayMuted, fontSize = 14.sp)

        Box(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(50)).background(FridayText).clickable { onNewChat(project.id) }.padding(vertical = 12.dp),
            contentAlignment = Alignment.Center,
        ) { Text("New chat in this project", color = FridayBg, fontSize = 14.5.sp, fontWeight = FontWeight.Medium) }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Knowledge files", color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                TextButton(enabled = !uploading, onClick = { picker.launch(arrayOf("*/*")) }) { Text(if (uploading) "Uploading…" else "+ Add files") }
            }
            Text("Friday reads and indexes these; every chat in the project searches them for relevant passages.", color = FridayMuted, fontSize = 12.5.sp)
            error?.let { Text(it, color = FridayError, fontSize = 12.5.sp) }
            val list = files
            if (list == null) CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
            else {
                if (list.isEmpty()) Text("No files yet.", color = FridayMuted, fontSize = 13.5.sp)
                list.forEach { f ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(f.filename, color = FridayText, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                when (f.status) {
                                    "processing" -> "Reading and indexing…"
                                    "error" -> f.error ?: "Couldn't read this file"
                                    else -> "${size(f.sizeBytes)} · ${f.chunkCount} passages${if (f.embedded) "" else " · keyword search"}"
                                },
                                color = if (f.status == "error") FridayError else FridayMuted,
                                fontSize = 11.5.sp,
                            )
                        }
                        if (f.status == "processing") CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                        Box(
                            Modifier.size(36.dp).clickable { scope.launch { ProjectsApi.deleteFile(project.id, f.id); refresh() } },
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Default.Delete, "Remove ${f.filename}", tint = FridayMuted, modifier = Modifier.size(18.dp)) }
                    }
                }
            }
        }

        if (chats.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Chats in this project", color = FridayText, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                chats.forEach { c ->
                    Text(
                        c.title, color = FridayText, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(FridaySurface).clickable { onOpenChat(c) }.padding(12.dp),
                    )
                }
            }
        }

        TextButton(onClick = { confirmDelete = true }) { Text("Delete project", color = FridayError) }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete \"${project.name}\" and its files?") },
            confirmButton = {
                TextButton(onClick = { scope.launch { ProjectsApi.delete(project.id); confirmDelete = false; onDeleted() } }) { Text("Delete", color = FridayError) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}
