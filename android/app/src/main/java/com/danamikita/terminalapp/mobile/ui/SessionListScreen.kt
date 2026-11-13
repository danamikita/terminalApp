@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.danamikita.terminalapp.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.danamikita.terminalapp.mobile.network.AppStateInfo
import com.danamikita.terminalapp.mobile.network.DriverClient
import com.danamikita.terminalapp.mobile.network.FolderInfo
import com.danamikita.terminalapp.mobile.network.SessionInfo
import com.danamikita.terminalapp.mobile.network.UnauthorizedException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@Composable
fun SessionListScreen(
    client: DriverClient,
    label: String,
    onOpenSession: (SessionInfo) -> Unit,
    onBrowseFolder: (FolderInfo) -> Unit,
    onUnauthorized: () -> Unit,
    onCheckForUpdate: () -> Unit,
    checkingForUpdate: Boolean,
    showUpdateButton: Boolean,
) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<AppStateInfo?>(null) }
    var errorText by remember { mutableStateOf<String?>(null) }

    var newSessionFolder by remember { mutableStateOf<FolderInfo?>(null) }
    var commandInput by remember { mutableStateOf("") }
    var creatingSession by remember { mutableStateOf(false) }
    var createError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(client) {
        while (isActive) {
            try {
                state = client.listSessions()
                errorText = null
            } catch (e: UnauthorizedException) {
                onUnauthorized()
                return@LaunchedEffect
            } catch (e: Exception) {
                errorText = e.message
            }
            delay(2000)
        }
    }

    fun openNewSessionDialog(folder: FolderInfo) {
        newSessionFolder = folder
        commandInput = folder.lastCommand?.takeIf { it.isNotBlank() } ?: "claude"
        createError = null
    }

    fun submitNewSession() {
        val folder = newSessionFolder ?: return
        val command = commandInput
        creatingSession = true
        createError = null
        scope.launch {
            try {
                val sessionId = client.createSession(folder.id, command)
                val updated = client.listSessions()
                state = updated
                val session = updated.folders.firstOrNull { it.id == folder.id }
                    ?.sessions?.firstOrNull { it.id == sessionId }
                newSessionFolder = null
                creatingSession = false
                if (session != null) onOpenSession(session)
            } catch (e: UnauthorizedException) {
                onUnauthorized()
            } catch (e: Exception) {
                creatingSession = false
                createError = e.message
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(label) },
                actions = {
                    if (showUpdateButton) {
                        IconButton(onClick = onCheckForUpdate, enabled = !checkingForUpdate) {
                            Text(if (checkingForUpdate) "…" else "⟳")
                        }
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            val folders = state?.folders.orEmpty().filter { !it.archived }
            if (folders.isEmpty() && errorText == null) {
                Text("No folders yet.", modifier = Modifier.padding(16.dp))
            }
            errorText?.let { Text("Error: $it", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) }
            LazyColumn {
                for (folder in folders) {
                    item {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                folder.name.uppercase(),
                                style = MaterialTheme.typography.labelMedium,
                                modifier = Modifier.weight(1f).padding(vertical = 8.dp),
                            )
                            IconButton(onClick = { onBrowseFolder(folder) }) { Text("📁") }
                            IconButton(onClick = { openNewSessionDialog(folder) }) { Text("+") }
                        }
                    }
                    if (folder.sessions.isEmpty()) {
                        item {
                            Text(
                                "No sessions yet.",
                                style = MaterialTheme.typography.bodySmall,
                                color = Color.Gray,
                                modifier = Modifier.padding(start = 16.dp, bottom = 8.dp),
                            )
                        }
                    }
                    items(folder.sessions) { session ->
                        SessionRow(session, onClick = { onOpenSession(session) })
                        Divider()
                    }
                }
            }
        }
    }

    newSessionFolder?.let { folder ->
        AlertDialog(
            onDismissRequest = { if (!creatingSession) newSessionFolder = null },
            title = { Text("New session in ${folder.name}") },
            text = {
                Column {
                    OutlinedTextField(
                        value = commandInput,
                        onValueChange = { commandInput = it },
                        label = { Text("Command") },
                        enabled = !creatingSession,
                    )
                    createError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (creatingSession) CircularProgressIndicator(modifier = Modifier.padding(top = 8.dp))
                }
            },
            confirmButton = {
                TextButton(enabled = !creatingSession, onClick = { submitNewSession() }) { Text("Start") }
            },
            dismissButton = {
                TextButton(enabled = !creatingSession, onClick = { newSessionFolder = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun SessionRow(session: SessionInfo, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val dotColor = when {
            session.status == "exited" -> Color.Gray
            session.activity == "busy" -> Color(0xFF3A9FD9)
            else -> Color(0xFF3C9D3C)
        }
        Box(modifier = Modifier.size(10.dp).background(dotColor, CircleShape))
        Text(session.name, modifier = Modifier.weight(1f))
        session.lastCommand?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = Color.Gray)
        }
        if (session.attention) Text("●", color = Color(0xFFE5A93C))
    }
}
