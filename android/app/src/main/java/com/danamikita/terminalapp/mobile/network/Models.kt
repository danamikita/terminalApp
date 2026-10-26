package com.danamikita.terminalapp.mobile.network

import org.json.JSONArray
import org.json.JSONObject

data class SessionInfo(
    val id: String,
    val folderId: String,
    val name: String,
    val command: String,
    val lastCommand: String?,
    val status: String, // "running" | "exited"
    val activity: String, // "idle" | "busy"
    val attention: Boolean,
)

data class FolderInfo(
    val id: String,
    val name: String,
    val path: String,
    val lastCommand: String?,
    val sessions: List<SessionInfo>,
)

data class AppStateInfo(
    val folders: List<FolderInfo>,
)

fun parseAppState(json: String): AppStateInfo {
    val obj = JSONObject(json)
    val folders = obj.optJSONArray("folders").orEmpty().map { f ->
        val sessions = f.optJSONArray("sessions").orEmpty().map { s ->
            SessionInfo(
                id = s.getString("id"),
                folderId = s.getString("folderId"),
                name = s.getString("name"),
                command = s.getString("command"),
                lastCommand = s.optStringOrNull("lastCommand"),
                status = s.getString("status"),
                activity = s.getString("activity"),
                attention = s.optBoolean("attention", false),
            )
        }
        FolderInfo(
            id = f.getString("id"),
            name = f.getString("name"),
            path = f.getString("path"),
            lastCommand = f.optStringOrNull("lastCommand"),
            sessions = sessions,
        )
    }
    return AppStateInfo(folders = folders)
}

private fun JSONArray?.orEmpty(): List<JSONObject> {
    if (this == null) return emptyList()
    return (0 until length()).map { getJSONObject(it) }
}

private fun JSONObject.optStringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) getString(key) else null
