@file:OptIn(
    androidx.compose.material3.ExperimentalMaterial3Api::class,
    androidx.compose.foundation.ExperimentalFoundationApi::class,
)

package com.danamikita.terminalapp.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.danamikita.terminalapp.mobile.network.DirEntry
import com.danamikita.terminalapp.mobile.network.DriverClient
import com.danamikita.terminalapp.mobile.network.UnauthorizedException
import kotlinx.coroutines.launch

// Browsing/viewing is read-only -- no create/rename/delete/edit. See the
// android plan's git-actions note for why remote writes are a separate,
// more deliberate decision than browsing is. Running a script is not a
// filesystem write though, so long-pressing a recognized script file to
// launch it in a new session (mirroring the desktop app's right-click menu)
// is in scope here.
private data class ScriptRunner(val shell: String? = null, val build: (String) -> String)

private val SCRIPT_RUNNERS: Map<String, ScriptRunner> = mapOf(
    ".ps1" to ScriptRunner(shell = "powershell") { p -> "& \"$p\"" },
    ".bat" to ScriptRunner(shell = "cmd") { p -> "\"$p\"" },
    ".cmd" to ScriptRunner(shell = "cmd") { p -> "\"$p\"" },
    ".sh" to ScriptRunner(shell = "bash") { p -> "\"$p\"" },
    ".py" to ScriptRunner { p -> "python \"$p\"" },
    ".js" to ScriptRunner { p -> "node \"$p\"" },
    ".mjs" to ScriptRunner { p -> "node \"$p\"" },
    ".cjs" to ScriptRunner { p -> "node \"$p\"" },
    ".rb" to ScriptRunner { p -> "ruby \"$p\"" },
    ".pl" to ScriptRunner { p -> "perl \"$p\"" },
)

private fun scriptRunnerFor(name: String): ScriptRunner? {
    val dot = name.lastIndexOf('.')
    if (dot == -1) return null
    return SCRIPT_RUNNERS[name.substring(dot).lowercase()]
}

@Composable
fun FileBrowserScreen(
    client: DriverClient,
    folderId: String,
    folderName: String,
    onUnauthorized: () -> Unit,
    onRunScript: (sessionId: String, label: String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var relPath by remember { mutableStateOf("") }
    var entries by remember { mutableStateOf<List<DirEntry>>(emptyList()) }
    var fileContent by remember { mutableStateOf<String?>(null) }
    var viewingFileName by remember { mutableStateOf<String?>(null) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    LaunchedEffect(relPath) {
        loading = true
        errorText = null
        try {
            entries = client.listFolderDir(folderId, relPath)
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: Exception) {
            errorText = e.message
        }
        loading = false
    }

    fun openFile(name: String) {
        val path = if (relPath.isEmpty()) name else "$relPath/$name"
        scope.launch {
            loading = true
            errorText = null
            try {
                fileContent = client.readFolderFile(folderId, path)
                viewingFileName = name
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                errorText = e.message
            }
            loading = false
        }
    }

    var scriptToRun by remember { mutableStateOf<Pair<String, ScriptRunner>?>(null) }
    var runningScript by remember { mutableStateOf(false) }
    var runError by remember { mutableStateOf<String?>(null) }

    fun confirmRunScript() {
        val (path, runner) = scriptToRun ?: return
        runningScript = true
        runError = null
        scope.launch {
            try {
                val sessionId = client.createSession(folderId, runner.build(path), runner.shell)
                scriptToRun = null
                runningScript = false
                onRunScript(sessionId, path.substringAfterLast('/'))
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                runningScript = false
                runError = e.message
            }
        }
    }

    // Consumed here only while there's somewhere to go back TO within the
    // browser (a file view, or a non-root directory); otherwise disabled so
    // the press falls through to the nav controller and pops this screen.
    BackHandler(enabled = fileContent != null || relPath.isNotEmpty()) {
        if (fileContent != null) {
            fileContent = null
            viewingFileName = null
        } else {
            relPath = relPath.substringBeforeLast('/', "")
        }
    }

    val title = when {
        viewingFileName != null -> viewingFileName
        relPath.isEmpty() -> folderName
        else -> "$folderName/$relPath"
    }

    Scaffold(topBar = { TopAppBar(title = { Text(title.orEmpty()) }) }) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            errorText?.let { Text("Error: $it", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) }
            val content = fileContent
            when {
                content != null -> {
                    Box(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
                        SelectionContainer {
                            Text(content, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                loading && entries.isEmpty() -> {
                    CircularProgressIndicator(modifier = Modifier.padding(16.dp))
                }
                else -> {
                    LazyColumn {
                        items(entries) { entry ->
                            val runner = if (entry.isDirectory) null else scriptRunnerFor(entry.name)
                            DirEntryRow(
                                entry,
                                isScript = runner != null,
                                onClick = {
                                    if (entry.isDirectory) {
                                        relPath = if (relPath.isEmpty()) entry.name else "$relPath/${entry.name}"
                                    } else {
                                        openFile(entry.name)
                                    }
                                },
                                onLongClick = runner?.let {
                                    {
                                        val path = if (relPath.isEmpty()) entry.name else "$relPath/${entry.name}"
                                        scriptToRun = path to it
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }

    scriptToRun?.let { (path, _) ->
        AlertDialog(
            onDismissRequest = { if (!runningScript) scriptToRun = null },
            title = { Text("Run script") },
            text = {
                Column {
                    Text("Run $path in a new session?")
                    runError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (runningScript) CircularProgressIndicator(modifier = Modifier.padding(top = 8.dp))
                }
            },
            confirmButton = {
                TextButton(enabled = !runningScript, onClick = { confirmRunScript() }) { Text("Run") }
            },
            dismissButton = {
                TextButton(enabled = !runningScript, onClick = { scriptToRun = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun DirEntryRow(
    entry: DirEntry,
    isScript: Boolean,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)?,
) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(if (entry.isDirectory) "📁" else "📄")
        Text(entry.name, modifier = Modifier.weight(1f))
        if (isScript) Text("▶", color = MaterialTheme.colorScheme.primary)
    }
    Divider()
}
