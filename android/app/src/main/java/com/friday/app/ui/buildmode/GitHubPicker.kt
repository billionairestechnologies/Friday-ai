package com.friday.app.ui.buildmode

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.friday.app.data.api.GitHubApi
import com.friday.app.ui.theme.FridayError
import com.friday.app.ui.theme.FridayHairline
import com.friday.app.ui.theme.FridayMuted
import com.friday.app.ui.theme.FridaySurface
import com.friday.app.ui.theme.FridayText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
private fun Chip(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier.clip(RoundedCornerShape(10.dp)).border(1.dp, FridayHairline, RoundedCornerShape(10.dp)).background(FridaySurface)
            .clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(icon, null, tint = FridayMuted, modifier = Modifier.size(14.dp))
        Text(label, color = FridayText, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Icon(Icons.Default.ExpandMore, null, tint = FridayMuted, modifier = Modifier.size(14.dp))
    }
}

/**
 * Above the Build composer on a new build (like Claude Code's repo + branch chips): "Connect GitHub"
 * if it isn't, otherwise pick one of your repositories (or create one), then the branch to work on
 * (or create one from the current branch).
 */
@Composable
fun GitHubPicker(repo: String?, branch: String?, onChange: (String?, String?) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var connected by remember { mutableStateOf<Boolean?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var repoDialog by remember { mutableStateOf(false) }
    var branchDialog by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { connected = GitHubApi.isConnected() ?: false }

    Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        when (connected) {
            null -> {}
            false -> Chip(Icons.Default.Code, "Connect GitHub to work on a repository") {
                scope.launch {
                    GitHubApi.startUrl()
                        .onSuccess { url -> runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
                        .onFailure { error = it.message }
                }
            }
            true -> {
                Chip(Icons.Default.Code, repo ?: "New project · or pick a repository") { repoDialog = true }
                if (repo != null && branch != null) {
                    Chip(Icons.Default.AccountTree, branch) { branchDialog = true }
                    Icon(Icons.Default.Close, "Don't use a repository", tint = FridayMuted, modifier = Modifier.size(18.dp).clickable { onChange(null, null) })
                }
            }
        }
    }
    error?.let { Text(it, color = FridayError, fontSize = 12.sp, modifier = Modifier.padding(bottom = 4.dp)) }

    if (repoDialog) RepoDialog(onDismiss = { repoDialog = false }, onPick = { r -> onChange(r?.fullName, r?.defaultBranch); repoDialog = false })
    if (branchDialog && repo != null && branch != null) BranchDialog(repo, branch, onDismiss = { branchDialog = false }, onPick = { b -> onChange(repo, b); branchDialog = false })
}

@Composable
private fun RepoDialog(onDismiss: () -> Unit, onPick: (GitHubApi.Repo?) -> Unit) {
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var repos by remember { mutableStateOf<List<GitHubApi.Repo>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var newName by remember { mutableStateOf("") }
    var isPrivate by remember { mutableStateOf(true) }
    var creating by remember { mutableStateOf(false) }
    LaunchedEffect(query) {
        delay(250)
        GitHubApi.repos(query).onSuccess { repos = it; error = null }.onFailure { error = it.message }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Repository") },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
                OutlinedTextField(query, { query = it }, placeholder = { Text("Search your repositories") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("New project (no repository)", color = FridayText, fontSize = 14.sp, modifier = Modifier.fillMaxWidth().clickable { onPick(null) }.padding(vertical = 10.dp))
                error?.let { Text(it, color = FridayError, fontSize = 12.sp) }
                if (repos == null && error == null) Text("Loading your repositories…", color = FridayMuted, fontSize = 12.sp)
                repos?.forEach { r ->
                    Row(Modifier.fillMaxWidth().clickable { onPick(r) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(r.fullName, color = FridayText, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            r.description?.let { Text(it, color = FridayMuted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                        if (r.isPrivate) Icon(Icons.Default.Lock, "Private", tint = FridayMuted, modifier = Modifier.size(14.dp))
                    }
                }
                Spacer(Modifier.size(8.dp))
                Text("Create a new repository", color = FridayMuted, fontSize = 12.sp)
                OutlinedTextField(newName, { newName = it.replace(Regex("[^\\w.-]"), "-") }, placeholder = { Text("new-repository-name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(isPrivate, { isPrivate = it })
                    Text("Private", fontSize = 13.sp)
                    Spacer(Modifier.weight(1f))
                    TextButton(enabled = newName.isNotBlank() && !creating, onClick = {
                        creating = true
                        scope.launch {
                            GitHubApi.createRepo(newName.trim(), isPrivate).onSuccess { onPick(it) }.onFailure { error = it.message }
                            creating = false
                        }
                    }) { Text(if (creating) "Creating…" else "Create") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun BranchDialog(repo: String, current: String, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var branches by remember { mutableStateOf<List<String>?>(null) }
    var query by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(repo) { GitHubApi.branches(repo).onSuccess { branches = it }.onFailure { error = it.message } }
    val name = query.trim()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Branch") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                OutlinedTextField(query, { query = it }, placeholder = { Text("Find or create a branch") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                error?.let { Text(it, color = FridayError, fontSize = 12.sp) }
                if (branches == null && error == null) Text("Loading branches…", color = FridayMuted, fontSize = 12.sp)
                branches?.filter { name.isEmpty() || it.contains(name, ignoreCase = true) }?.forEach { b ->
                    Text(
                        (if (b == current) "✓ " else "") + b, color = FridayText, fontFamily = FontFamily.Monospace, fontSize = 13.sp,
                        modifier = Modifier.fillMaxWidth().clickable { onPick(b) }.padding(vertical = 9.dp),
                    )
                }
                if (name.isNotEmpty() && branches != null && name !in branches!!) {
                    TextButton(enabled = !busy, onClick = {
                        busy = true
                        scope.launch {
                            GitHubApi.createBranch(repo, name, current).onSuccess { onPick(name) }.onFailure { error = it.message }
                            busy = false
                        }
                    }) {
                        Icon(Icons.Default.Add, null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(if (busy) "Creating…" else "Create branch $name from $current")
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
