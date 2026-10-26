package com.danamikita.terminalapp.mobile.storage

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

data class PairedConnection(
    val host: String,
    val port: Int,
    val label: String,
    val deviceId: String,
    val deviceSecret: String,
    // The mDNS-advertised hostname (e.g. "DESKTOP-I17LQ3O"), when this
    // connection was paired from a discovered instance rather than typed in
    // manually. Used as the stable identity instead of `host`, since a PC's
    // IP can change across restarts/DHCP renewals but its hostname won't —
    // see ConnectScreen's reconnect logic, which re-resolves the live IP
    // for a matching hostname whenever one is currently discovered.
    val hostname: String? = null,
) {
    // Prefer the stable hostname as the dedup/lookup key when known, falling
    // back to host:port for manually-entered connections with no hostname.
    val key: String get() = hostname ?: "$host:$port"
    val credential: String get() = "device.$deviceId.$deviceSecret"
}

/**
 * Persists paired-device credentials on this phone so pairing only has to
 * happen once per desktop instance. Uses EncryptedSharedPreferences since
 * these secrets are equivalent to a password for the desktop's shell
 * sessions — analogous to how the desktop stores its own trusted-device
 * secrets in config.json (see android plan's security notes).
 */
class DeviceStore(context: Context) {
    private val prefs = run {
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context,
            "paired_connections",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private val entriesKey = "entries"

    fun all(): List<PairedConnection> {
        val raw = prefs.getString(entriesKey, null) ?: return emptyList()
        val arr = JSONArray(raw)
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            PairedConnection(
                host = o.getString("host"),
                port = o.getInt("port"),
                label = o.getString("label"),
                deviceId = o.getString("deviceId"),
                deviceSecret = o.getString("deviceSecret"),
                hostname = if (o.has("hostname") && !o.isNull("hostname")) o.getString("hostname") else null,
            )
        }
    }

    fun find(host: String, port: Int): PairedConnection? =
        all().find { it.host == host && it.port == port }

    fun findByHostname(hostname: String): PairedConnection? =
        all().find { it.hostname == hostname }

    fun save(connection: PairedConnection) {
        val others = all().filterNot { it.key == connection.key }
        writeAll(others + connection)
    }

    /** Refreshes the cached host:port for a hostname-identified connection after a fresh mDNS resolve. */
    fun updateAddress(hostname: String, host: String, port: Int) {
        val updated = all().map { if (it.hostname == hostname) it.copy(host = host, port = port) else it }
        writeAll(updated)
    }

    fun remove(host: String, port: Int) {
        writeAll(all().filterNot { it.host == host && it.port == port })
    }

    private fun writeAll(connections: List<PairedConnection>) {
        val arr = JSONArray()
        for (c in connections) {
            val o = JSONObject()
                .put("host", c.host)
                .put("port", c.port)
                .put("label", c.label)
                .put("deviceId", c.deviceId)
                .put("deviceSecret", c.deviceSecret)
            if (c.hostname != null) o.put("hostname", c.hostname)
            arr.put(o)
        }
        prefs.edit().putString(entriesKey, arr.toString()).apply()
    }
}
