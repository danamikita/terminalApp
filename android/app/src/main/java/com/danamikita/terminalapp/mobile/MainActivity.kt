package com.danamikita.terminalapp.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.danamikita.terminalapp.mobile.discovery.NsdDiscovery
import com.danamikita.terminalapp.mobile.network.DriverClient
import com.danamikita.terminalapp.mobile.storage.DeviceStore
import com.danamikita.terminalapp.mobile.ui.ConnectScreen
import com.danamikita.terminalapp.mobile.ui.SessionListScreen
import com.danamikita.terminalapp.mobile.ui.TerminalScreen
import com.danamikita.terminalapp.mobile.update.UpdateChecker
import com.danamikita.terminalapp.mobile.update.UpdateInfo
import kotlinx.coroutines.launch
import java.net.URLDecoder
import java.net.URLEncoder

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val deviceStore = DeviceStore(applicationContext)
        val discovery = NsdDiscovery(applicationContext)

        setContent {
            DisposableEffect(Unit) {
                discovery.start()
                onDispose { discovery.stop() }
            }

            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val context = LocalContext.current
                    val scope = rememberCoroutineScope()
                    val updateChecker = remember { UpdateChecker() }
                    var updateInfo by remember { mutableStateOf<UpdateInfo?>(null) }
                    var updating by remember { mutableStateOf(false) }
                    var updateError by remember { mutableStateOf<String?>(null) }

                    LaunchedEffect(Unit) {
                        updateInfo = updateChecker.checkForUpdate(BuildConfig.VERSION_NAME)
                    }

                    updateInfo?.let { info ->
                        AlertDialog(
                            onDismissRequest = { if (!updating) updateInfo = null },
                            title = { Text("Update available: v${info.versionName}") },
                            text = {
                                when {
                                    updating -> CircularProgressIndicator()
                                    updateError != null -> Text("Download failed: $updateError")
                                    else -> Text("You're on v${BuildConfig.VERSION_NAME}. Download and install the new version?")
                                }
                            },
                            confirmButton = {
                                TextButton(
                                    enabled = !updating,
                                    onClick = {
                                        updating = true
                                        updateError = null
                                        scope.launch {
                                            runCatching {
                                                val file = updateChecker.downloadApk(context, info)
                                                updateChecker.installApk(context, file)
                                            }.onSuccess {
                                                updateInfo = null
                                            }.onFailure { e ->
                                                updateError = e.message ?: "unknown error"
                                            }
                                            updating = false
                                        }
                                    },
                                ) { Text("Update") }
                            },
                            dismissButton = {
                                TextButton(enabled = !updating, onClick = { updateInfo = null }) { Text("Later") }
                            },
                        )
                    }

                    val navController = rememberNavController()
                    var activeClient by remember { mutableStateOf<DriverClient?>(null) }
                    var activeLabel by remember { mutableStateOf("") }
                    var activeSessionName by remember { mutableStateOf("") }

                    NavHost(navController = navController, startDestination = "connect") {
                        composable("connect") {
                            ConnectScreen(
                                deviceStore = deviceStore,
                                discovery = discovery,
                                onConnected = { client, label ->
                                    activeClient = client
                                    activeLabel = label
                                    navController.navigate("sessions")
                                },
                            )
                        }
                        composable("sessions") {
                            val client = activeClient
                            if (client == null) {
                                navController.popBackStack("connect", inclusive = false)
                            } else {
                                SessionListScreen(
                                    client = client,
                                    label = activeLabel,
                                    onOpenSession = { session ->
                                        activeSessionName = session.name
                                        val encodedId = URLEncoder.encode(session.id, "UTF-8")
                                        navController.navigate("terminal/$encodedId")
                                    },
                                    onUnauthorized = {
                                        activeClient = null
                                        navController.popBackStack("connect", inclusive = false)
                                    },
                                )
                            }
                        }
                        composable(
                            "terminal/{sessionId}",
                            arguments = listOf(navArgument("sessionId") { type = NavType.StringType }),
                        ) { backStackEntry ->
                            val client = activeClient
                            val encodedId = backStackEntry.arguments?.getString("sessionId").orEmpty()
                            val sessionId = URLDecoder.decode(encodedId, "UTF-8")
                            if (client == null) {
                                navController.popBackStack("connect", inclusive = false)
                            } else {
                                TerminalScreen(
                                    client = client,
                                    sessionId = sessionId,
                                    sessionName = activeSessionName,
                                    onUnauthorized = {
                                        activeClient = null
                                        navController.popBackStack("connect", inclusive = false)
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
