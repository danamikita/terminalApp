@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.danamikita.terminalapp.mobile.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.danamikita.terminalapp.mobile.discovery.DiscoveredInstance
import com.danamikita.terminalapp.mobile.discovery.NsdDiscovery
import com.danamikita.terminalapp.mobile.network.DriverClient
import com.danamikita.terminalapp.mobile.storage.DeviceStore
import com.danamikita.terminalapp.mobile.storage.PairedConnection
import kotlinx.coroutines.launch

@Composable
fun ConnectScreen(
    deviceStore: DeviceStore,
    discovery: NsdDiscovery,
    onConnected: (DriverClient, String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var manualHost by remember { mutableStateOf("") }
    var manualPort by remember { mutableStateOf("47832") }
    var pairingTarget by remember { mutableStateOf<Pair<String, Int>?>(null) }
    var tokenInput by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf(android.os.Build.MODEL) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    val discovered by discovery.instances.collectAsState()
    val paired = remember { mutableStateOf(deviceStore.all()) }

    fun connectWith(host: String, port: Int) {
        val existing = deviceStore.find(host, port)
        if (existing != null) {
            onConnected(DriverClient("http://$host:$port", existing.credential), existing.label)
        } else {
            pairingTarget = host to port
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text("Connect to a computer") }) }) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            Text("Paired", style = MaterialTheme.typography.titleMedium)
            LazyColumn {
                items(paired.value) { conn ->
                    ListItem(
                        headlineContent = { Text(conn.label) },
                        supportingContent = { Text("${conn.host}:${conn.port}") },
                        modifier = Modifier.fillMaxWidth().clickable { connectWith(conn.host, conn.port) },
                    )
                }
            }
            if (paired.value.isEmpty()) Text("None yet.", style = MaterialTheme.typography.bodySmall)

            Divider(modifier = Modifier.padding(vertical = 12.dp))

            Text("Discovered on this network", style = MaterialTheme.typography.titleMedium)
            LazyColumn {
                items(discovered) { instance ->
                    ListItem(
                        headlineContent = { Text(instance.hostname) },
                        supportingContent = { Text("${instance.host}:${instance.port}") },
                        modifier = Modifier.fillMaxWidth().clickable { connectWith(instance.host, instance.port) },
                    )
                }
            }
            if (discovered.isEmpty()) Text("Searching… (or add one manually below)", style = MaterialTheme.typography.bodySmall)

            Divider(modifier = Modifier.padding(vertical = 12.dp))

            Text("Add manually", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = manualHost,
                onValueChange = { manualHost = it },
                label = { Text("Host or IP") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = manualPort,
                onValueChange = { manualPort = it },
                label = { Text("Port") },
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = {
                    val port = manualPort.toIntOrNull()
                    if (manualHost.isNotBlank() && port != null) connectWith(manualHost.trim(), port)
                },
                modifier = Modifier.padding(top = 8.dp),
            ) { Text("Connect") }

            errorText?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }

    pairingTarget?.let { (host, port) ->
        AlertDialog(
            onDismissRequest = { pairingTarget = null },
            title = { Text("Pair with $host:$port") },
            text = {
                Column {
                    Text("Enter the token shown in the desktop app's Web Driver window.")
                    OutlinedTextField(value = tokenInput, onValueChange = { tokenInput = it }, label = { Text("Token") })
                    OutlinedTextField(value = deviceName, onValueChange = { deviceName = it }, label = { Text("This device's name") })
                    if (busy) CircularProgressIndicator(modifier = Modifier.padding(top = 8.dp))
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !busy && tokenInput.isNotBlank(),
                    onClick = {
                        busy = true
                        errorText = null
                        scope.launch {
                            try {
                                val client = DriverClient("http://$host:$port", tokenInput.trim())
                                val result = client.pair(deviceName.trim().ifBlank { "Android device" }, tokenInput.trim())
                                val conn = PairedConnection(host, port, host, result.deviceId, result.deviceSecret)
                                deviceStore.save(conn)
                                paired.value = deviceStore.all()
                                pairingTarget = null
                                onConnected(DriverClient("http://$host:$port", conn.credential), conn.label)
                            } catch (e: Exception) {
                                errorText = "Could not pair: ${e.message}"
                            } finally {
                                busy = false
                            }
                        }
                    },
                ) { Text("Pair") }
            },
            dismissButton = { TextButton(onClick = { pairingTarget = null }) { Text("Cancel") } },
        )
    }
}
