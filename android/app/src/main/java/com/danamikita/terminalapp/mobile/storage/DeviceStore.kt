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
) {
    val key: String get() = "$host:$port"
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
            )
        }
    }

    fun find(host: String, port: Int): PairedConnection? =
        all().find { it.host == host && it.port == port }

    fun save(connection: PairedConnection) {
        val others = all().filterNot { it.key == connection.key }
        val arr = JSONArray()
        for (c in others + connection) {
            arr.put(
                JSONObject()
                    .put("host", c.host)
                    .put("port", c.port)
                    .put("label", c.label)
                    .put("deviceId", c.deviceId)
                    .put("deviceSecret", c.deviceSecret),
            )
        }
        prefs.edit().putString(entriesKey, arr.toString()).apply()
    }

    fun remove(host: String, port: Int) {
        val remaining = all().filterNot { it.host == host && it.port == port }
        val arr = JSONArray()
        for (c in remaining) {
            arr.put(
                JSONObject()
                    .put("host", c.host)
                    .put("port", c.port)
                    .put("label", c.label)
                    .put("deviceId", c.deviceId)
                    .put("deviceSecret", c.deviceSecret),
            )
        }
        prefs.edit().putString(entriesKey, arr.toString()).apply()
    }
}
