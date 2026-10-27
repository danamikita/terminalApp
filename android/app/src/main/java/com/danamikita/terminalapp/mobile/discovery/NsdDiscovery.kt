package com.danamikita.terminalapp.mobile.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

private const val SERVICE_TYPE = "_terminalapp._tcp."
private const val TAG = "NsdDiscovery"

data class DiscoveredInstance(
    val hostname: String,
    val host: String,
    val port: Int,
)

/**
 * Browses for terminalApp desktop instances advertised via mDNS
 * (electron/web-driver.ts publishes `_terminalapp._tcp` with a `hostname`
 * TXT attribute — no secrets on the wire, see android plan). NSD resolution
 * is known to be flaky on some OEM/Android version combos, so this is
 * always offered alongside manual host:port entry, never as the only path.
 */
class NsdDiscovery(context: Context) {
    private val nsdManager = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val found = linkedMapOf<String, DiscoveredInstance>()

    private val _instances = MutableStateFlow<List<DiscoveredInstance>>(emptyList())
    val instances: StateFlow<List<DiscoveredInstance>> = _instances

    private var discoveryListener: NsdManager.DiscoveryListener? = null

    fun start() {
        if (discoveryListener != null) return
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "start discovery failed: $errorCode")
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onDiscoveryStopped(serviceType: String) {}

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                nsdManager.resolveService(serviceInfo, freshResolveListener())
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                found.remove(serviceInfo.serviceName)
                publish()
            }
        }
        discoveryListener = listener
        nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    fun stop() {
        val listener = discoveryListener ?: return
        discoveryListener = null
        try {
            nsdManager.stopServiceDiscovery(listener)
        } catch (e: IllegalArgumentException) {
            // already stopped/not registered — fine
        }
    }

    private fun freshResolveListener(): NsdManager.ResolveListener =
        object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "resolve failed for ${serviceInfo.serviceName}: $errorCode")
            }

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                val hostname = runCatching {
                    serviceInfo.attributes["hostname"]?.toString(Charsets.UTF_8)
                }.getOrNull() ?: serviceInfo.serviceName
                // Prefer the TXT-advertised IP over serviceInfo.host: the
                // desktop publishes an A record for every non-internal
                // interface (Docker/WSL/Hyper-V included), and NsdServiceInfo
                // only ever exposes one of them -- not necessarily the real
                // LAN address. See the comment above bonjour.publish() in
                // electron/web-driver.ts.
                val txtIp = runCatching {
                    serviceInfo.attributes["ip"]?.toString(Charsets.UTF_8)?.takeIf { it.isNotBlank() }
                }.getOrNull()
                val address = txtIp ?: serviceInfo.host?.hostAddress ?: return
                found[serviceInfo.serviceName] = DiscoveredInstance(hostname, address, serviceInfo.port)
                publish()
            }
        }

    private fun publish() {
        _instances.value = found.values.toList()
    }
}
