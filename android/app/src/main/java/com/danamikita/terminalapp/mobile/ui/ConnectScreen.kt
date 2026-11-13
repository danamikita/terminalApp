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
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.danamikita.terminalapp.mobile.discovery.NsdDiscovery
import com.danamikita.terminalapp.mobile.network.DriverClient
import com.danamikita.terminalapp.mobile.network.PairingDeniedException
import com.danamikita.terminalapp.mobile.storage.DeviceStore
import com.danamikita.terminalapp.mobile.storage.PairedConnection
import kotlinx.coroutines.launch

private data class PairingTarget(val host: String, val port: Int, val hostname: String?)

// Tracks one in-flight no-token /pair-request. Held in a class (not a plain
// Call var) so a stale response arriving after the user hit Cancel or
// "Enter token instead" can tell it's stale by identity and drop itself,
// rather than overwriting whatever the UI moved on to.
private class PendingPairingRequest(val target: PairingTarget) {
    @Volatile var call: okhttp3.Call? = null
}

@Composable
fun ConnectScreen(
    deviceStore: DeviceStore,
    discovery: NsdDiscovery,
    onConnected: (DriverClient, String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var manualHost by remember { mutableStateOf("") }
    var manualPort by remember { mutableStateOf("47832") }
    var pairingTarget by remember { mutableStateOf<PairingTarget?>(null) }
    var tokenInput by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf(android.os.Build.MODEL) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    var pendingRequest by remember { mutableStateOf<PendingPairingRequest?>(null) }

    val discovered by discovery.instances.collectAsState()
    val paired = remember { mutableStateOf(deviceStore.all()) }

    // Discovered-on-LAN devices skip straight to the no-token approval flow
    // (startPairingRequest) — mDNS discovery means the desktop is live right
    // now and will actually see the dialog. A manually-typed host/port is
    // typically used for cases discovery can't reach (Tailscale, a different
    // subnet), where a request could sit unseen for a while, so that path
    // keeps asking for the token shown in the desktop's Web Driver window.
    fun startPairingRequest(target: PairingTarget) {
        errorText = null
        val reqState = PendingPairingRequest(target)
        pendingRequest = reqState
        scope.launch {
            try {
                val client = DriverClient("http://${target.host}:${target.port}", "")
                val result = client.requestPairing(deviceName.trim().ifBlank { "Android device" }) { call ->
                    reqState.call = call
                }
                if (pendingRequest !== reqState) return@launch // cancelled / superseded while this was in flight
                val label = target.hostname ?: target.host
                val conn = PairedConnection(
                    target.host,
                    target.port,
                    label,
                    result.deviceId,
                    result.deviceSecret,
                    hostname = target.hostname,
                )
                deviceStore.save(conn)
                paired.value = deviceStore.all()
                pendingRequest = null
                onConnected(DriverClient("http://${target.host}:${target.port}", conn.credential), conn.label)
            } catch (e: PairingDeniedException) {
                if (pendingRequest === reqState) {
                    errorText = "Pairing request was denied on ${target.hostname ?: target.host}."
                    pendingRequest = null
                }
            } catch (e: Exception) {
                if (pendingRequest === reqState) {
                    errorText = "Could not pair: ${e.message}"
                    pendingRequest = null
                }
            }
        }
    }

    // A PC's IP can change across restarts/DHCP renewals, but its mDNS
    // hostname doesn't — so a paired connection with a known hostname that's
    // currently live-discovered reconnects via the fresh address (and
    // refreshes the cached one for next time), instead of trusting a
    // possibly-stale stored IP.
    fun connectWith(host: String, port: Int, hostname: String?, viaDiscovery: Boolean) {
        val existing = hostname?.let { deviceStore.findByHostname(it) } ?: deviceStore.find(host, port)
        if (existing != null) {
            if (hostname != null && (existing.host != host || existing.port != port)) {
                deviceStore.updateAddress(hostname, host, port)
            }
            onConnected(DriverClient("http://$host:$port", existing.credential), existing.label)
            return
        }
        val target = PairingTarget(host, port, hostname)
        if (viaDiscovery) startPairingRequest(target) else pairingTarget = target
    }

    Scaffold(topBar = { TopAppBar(title = { Text("Connect to a computer") }) }) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            Text("Paired", style = MaterialTheme.typography.titleMedium)
            LazyColumn {
                items(paired.value) { conn ->
                    // Prefer a live-discovered address over the cached one when this
                    // paired connection's hostname is currently visible on the network.
                    val live = conn.hostname?.let { hn -> discovered.find { it.hostname == hn } }
                    val host = live?.host ?: conn.host
                    val port = live?.port ?: conn.port
                    ListItem(
                        headlineContent = { Text(conn.label) },
                        supportingContent = { Text("$host:$port") },
                        modifier = Modifier.fillMaxWidth().clickable { connectWith(host, port, conn.hostname, viaDiscovery = false) },
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
                        modifier = Modifier.fillMaxWidth()
                            .clickable { connectWith(instance.host, instance.port, instance.hostname, viaDiscovery = true) },
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
                    if (manualHost.isNotBlank() && port != null) connectWith(manualHost.trim(), port, hostname = null, viaDiscovery = false)
                },
                modifier = Modifier.padding(top = 8.dp),
            ) { Text("Connect") }

            errorText?.let { Text(it, color = MaterialTheme.colorScheme.error) }

            Divider(modifier = Modifier.padding(vertical = 12.dp))
            val context = LocalContext.current
            Text(
                "Need the desktop app? Get it from GitHub",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.clickable {
                    context.startActivity(
                        Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/danamikita/terminalApp/releases/latest"))
                    )
                },
            )
        }
    }

    pairingTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { pairingTarget = null },
            title = { Text("Pair with ${target.host}:${target.port}") },
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
                                val client = DriverClient("http://${target.host}:${target.port}", tokenInput.trim())
                                val result = client.pair(deviceName.trim().ifBlank { "Android device" }, tokenInput.trim())
                                val label = target.hostname ?: target.host
                                val conn = PairedConnection(
                                    target.host,
                                    target.port,
                                    label,
                                    result.deviceId,
                                    result.deviceSecret,
                                    hostname = target.hostname,
                                )
                                deviceStore.save(conn)
                                paired.value = deviceStore.all()
                                pairingTarget = null
                                onConnected(DriverClient("http://${target.host}:${target.port}", conn.credential), conn.label)
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

    pendingRequest?.let { request ->
        val target = request.target
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Connecting to ${target.hostname ?: target.host}") },
            text = {
                Column {
                    Text("Waiting for approval on that computer — look for a \"wants to connect\" popup there.")
                    CircularProgressIndicator(modifier = Modifier.padding(top = 12.dp))
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    request.call?.cancel()
                    pendingRequest = null
                    pairingTarget = target
                }) { Text("Enter token instead") }
            },
            dismissButton = {
                TextButton(onClick = {
                    request.call?.cancel()
                    pendingRequest = null
                }) { Text("Cancel") }
            },
        )
    }
}
