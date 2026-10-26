package com.danamikita.terminalapp.mobile.network

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class UnauthorizedException : IOException("bad or missing driver token")

data class PairResult(val deviceId: String, val deviceSecret: String)

/**
 * Talks to one terminalApp desktop instance's web-driver HTTP+SSE API
 * (electron/web-driver.ts). `credential` is either the raw ephemeral token
 * (first-run, shown in the desktop app) or a paired device's persistent
 * "device.<id>.<secret>" value — both ride in the same X-Driver-Token
 * header / ?token= query param, matching the server's verifyCredential().
 */
class DriverClient(
    private val baseUrl: String,
    @Volatile var credential: String,
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // the SSE stream is long-lived
        .build()

    private val jsonMedia = "application/json".toMediaType()

    suspend fun pair(name: String, ephemeralToken: String): PairResult = withContext(Dispatchers.IO) {
        val body = JSONObject().put("name", name).toString().toRequestBody(jsonMedia)
        val req = Request.Builder()
            .url("$baseUrl/pair")
            .header("X-Driver-Token", ephemeralToken)
            .post(body)
            .build()
        val json = executeForBody(req)
        val obj = JSONObject(json)
        PairResult(obj.getString("deviceId"), obj.getString("deviceSecret"))
    }

    suspend fun listSessions(): AppStateInfo = withContext(Dispatchers.IO) {
        parseAppState(executeForBody(authedRequest("/sessions").build()))
    }

    suspend fun getBuffer(sessionId: String): String = withContext(Dispatchers.IO) {
        val json = executeForBody(authedRequest("/session/$sessionId/buffer").build())
        JSONObject(json).optString("data", "")
    }

    suspend fun sendInput(sessionId: String, data: String) = withContext(Dispatchers.IO) {
        val body = JSONObject().put("data", data).toString().toRequestBody(jsonMedia)
        val req = authedRequest("/session/$sessionId/input").post(body).build()
        executeForBody(req)
        Unit
    }

    suspend fun resize(sessionId: String, cols: Int, rows: Int) = withContext(Dispatchers.IO) {
        val body = JSONObject().put("cols", cols).put("rows", rows).toString().toRequestBody(jsonMedia)
        val req = authedRequest("/session/$sessionId/resize").post(body).build()
        executeForBody(req)
        Unit
    }

    /**
     * Opens the SSE stream and calls [onChunk] with each decoded text chunk
     * on the calling (background) thread, blocking until the stream ends.
     * Call this from a background thread/coroutine. Plain coroutine
     * cancellation does NOT interrupt the blocking read underneath — callers
     * that need to stop early must call `.cancel()` on the Call handed to
     * [onCallCreated] (invoked synchronously before the blocking read
     * starts), which is what actually unblocks it.
     */
    fun streamSession(sessionId: String, onCallCreated: (okhttp3.Call) -> Unit = {}, onChunk: (String) -> Unit) {
        val url = "$baseUrl/session/$sessionId/stream?token=${java.net.URLEncoder.encode(credential, "UTF-8")}"
        val call = http.newCall(Request.Builder().url(url).build())
        onCallCreated(call)
        try {
            call.execute().use { resp ->
                if (resp.code == 401) throw UnauthorizedException()
                if (!resp.isSuccessful) throw IOException("stream failed: HTTP ${resp.code}")
                val source = resp.body?.source() ?: return
                while (true) {
                    val line = source.readUtf8Line() ?: break
                    if (!line.startsWith("data: ")) continue // skip SSE comments/keepalives
                    val payload = line.substring("data: ".length)
                    onChunk(decodeJsonStringLiteral(payload))
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            // Call.cancel() surfaces as an IOException from the blocking read —
            // that's the expected/clean way this loop ends when the caller
            // leaves the terminal screen, not necessarily a real failure.
            if (call.isCanceled()) return
            throw e
        }
    }

    private fun authedRequest(path: String): Request.Builder =
        Request.Builder().url("$baseUrl$path").header("X-Driver-Token", credential)

    private fun executeForBody(req: Request): String {
        http.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (resp.code == 401) throw UnauthorizedException()
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}: $body")
            return body
        }
    }

    /** A bare JSON string literal, e.g. the payload after "data: " in an SSE line. */
    private fun decodeJsonStringLiteral(literal: String): String =
        JSONObject("{\"v\":$literal}").getString("v")
}
