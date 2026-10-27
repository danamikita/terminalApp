package com.danamikita.terminalapp.mobile.update

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException

data class UpdateInfo(val versionName: String, val downloadUrl: String, val assetName: String)

private const val RELEASES_URL = "https://api.github.com/repos/danamikita/terminalApp/releases/latest"

/**
 * This app isn't distributed through the Play Store -- it's a sideloaded
 * APK attached to GitHub releases (see .github/workflows/release.yml, which
 * uploads "FoldersRemote-vX.Y.Z.apk" alongside the desktop installer for
 * every pushed "vX.Y.Z" tag). Nothing updates it automatically, so this
 * checks the latest release on launch and offers to download + install it
 * when it's newer than the running build.
 */
class UpdateChecker(private val http: OkHttpClient = OkHttpClient()) {
    suspend fun checkForUpdate(currentVersionName: String): UpdateInfo? = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(RELEASES_URL)
            .header("Accept", "application/vnd.github+json")
            .build()
        val body = runCatching {
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext null
                resp.body?.string()
            }
        }.getOrNull() ?: return@withContext null

        val json = JSONObject(body)
        val remoteVersion = json.optString("tag_name").removePrefix("v")
        if (remoteVersion.isBlank() || !isNewer(remoteVersion, currentVersionName)) return@withContext null

        val assets = json.optJSONArray("assets") ?: return@withContext null
        for (i in 0 until assets.length()) {
            val asset = assets.getJSONObject(i)
            val name = asset.optString("name")
            if (name.startsWith("FoldersRemote-") && name.endsWith(".apk")) {
                return@withContext UpdateInfo(remoteVersion, asset.optString("browser_download_url"), name)
            }
        }
        null
    }

    /** Compares dotted version strings (e.g. "1.6.11" vs "1.6.9") numerically per segment, not lexically. */
    private fun isNewer(remote: String, current: String): Boolean {
        val r = remote.split(".").map { it.toIntOrNull() ?: 0 }
        val c = current.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(r.size, c.size)) {
            val rv = r.getOrElse(i) { 0 }
            val cv = c.getOrElse(i) { 0 }
            if (rv != cv) return rv > cv
        }
        return false
    }

    suspend fun downloadApk(context: Context, info: UpdateInfo): File = withContext(Dispatchers.IO) {
        val dest = File(context.cacheDir, info.assetName)
        val req = Request.Builder().url(info.downloadUrl).build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("download failed: HTTP ${resp.code}")
            val body = resp.body ?: throw IOException("empty response body")
            body.byteStream().use { input -> dest.outputStream().use { output -> input.copyTo(output) } }
        }
        dest
    }

    fun installApk(context: Context, file: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
