package com.lastglance.app.launcher

import android.content.Context
import android.webkit.JavascriptInterface
import com.lastglance.app.SecureStore
import com.lastglance.app.SharedDataStore
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * `window.LastGlanceHeadless` for a headless refresh (src/headless/): the
 * ALLOWLIST of what a run may reach, and nothing more. There is no Capacitor
 * bridge in the headless WebView (it needs an Activity), so this stands in for
 * the four plugins the run's sync roads use: the secure store (credentials and
 * sync keys), HTTP (WebDAV and the vault), and the launcher push, plus the
 * launcher's write queue, which the run applies. Keep this
 * list equal to HEADLESS_BRIDGE_METHODS in src/headless/headlessMode.ts.
 *
 * Every call marks the run as started: a page that never calls is not running
 * the headless root ([HeadlessRefreshPolicy.BOOT_MS]).
 */
class HeadlessBridge(
    private val context: Context,
    private val run: LauncherRefreshWorker.Run,
    private val onHttpResult: (json: String) -> Unit,
) {

    // ── The credentials and sync keys (SecureStorePlugin's store) ────────────

    /** `{"value": string | null}`, so an absent entry is unambiguous across the bridge. */
    @JavascriptInterface
    fun secureGet(key: String): String {
        run.markStarted()
        return JSONObject().put("value", SecureStore.get(context, key) ?: JSONObject.NULL).toString()
    }

    @JavascriptInterface
    fun secureSet(key: String, value: String): Boolean {
        run.markStarted()
        return SecureStore.set(context, key, value)
    }

    @JavascriptInterface
    fun secureDelete(key: String) {
        run.markStarted()
        SecureStore.delete(context, key)
    }

    // ── The sync transports ──────────────────────────────────────────────────

    /**
     * Runs on a worker thread and answers `{id, result}` through [onHttpResult],
     * result being `{status, body, headers}` (header names lower-cased) or
     * `{error}`. OkHttp takes every verb, PROPFIND and MKCOL included, as
     * WebDavHttpPlugin does for the app.
     */
    @JavascriptInterface
    fun httpRequestAsync(callId: String, method: String, url: String, headersJson: String, body: String?) {
        run.markStarted()
        executor.execute {
            val result = try {
                val builder = Request.Builder().url(url)
                var contentType: String? = null
                val headers = JSONObject(headersJson)
                for (name in headers.keys()) {
                    val value = headers.optString(name)
                    if (name.equals("content-type", ignoreCase = true)) contentType = value
                    builder.header(name, value)
                }
                // OkHttp refuses these verbs without a body; the vault's fetch can send one bare.
                val requestBody = body?.toRequestBody(contentType?.toMediaTypeOrNull())
                    ?: if (method.uppercase() in BODY_REQUIRED) "".toRequestBody(null) else null
                builder.method(method, requestBody)
                client.newCall(builder.build()).execute().use { response ->
                    val responseHeaders = JSONObject()
                    for (name in response.headers.names()) responseHeaders.put(name.lowercase(), response.header(name))
                    JSONObject()
                        .put("status", response.code)
                        .put("body", response.body?.string() ?: "")
                        .put("headers", responseHeaders)
                }
            } catch (e: Exception) {
                JSONObject().put("error", e.message ?: e.toString())
            }
            onHttpResult(JSONObject().put("id", callId).put("result", result).toString())
        }
    }

    // ── The launcher push ────────────────────────────────────────────────────

    @JavascriptInterface
    fun updateLauncherSnapshot(json: String) {
        run.markStarted()
        SharedDataStore.writeLauncherSnapshot(context, json)
        context.contentResolver.notifyChange(LauncherProvider.CONTENT_URI, null)
    }

    @JavascriptInterface
    fun touchLauncherHeartbeat(json: String) {
        run.markStarted()
        SharedDataStore.mergeLauncherHeartbeat(context, json)
        context.contentResolver.notifyChange(LauncherProvider.CONTENT_URI, null)
    }

    // ── The launcher's write queue (src/headless/headlessRefresh.ts applies it) ──

    /** The queued entries; writes stay queued until [ackLauncherIntents] (LauncherWriteQueue). */
    @JavascriptInterface
    fun takeLauncherIntents(): String {
        run.markStarted()
        return SharedDataStore.takePendingLauncherIntents(context)
    }

    /** The writes the run has handled, by clientId: off the queue. */
    @JavascriptInterface
    fun ackLauncherIntents(idsJson: String) {
        run.markStarted()
        SharedDataStore.ackPendingLauncherIntents(context, idsJson)
    }

    // ── The run's protocol with the worker ───────────────────────────────────

    /** True once the app has opened: the run stops at its next phase boundary (the reverse lock). */
    @JavascriptInterface
    fun headlessShouldAbort(): Boolean {
        run.markStarted()
        return run.abortRequested
    }

    /** The run's outcome ({clientId, outcome, reason?, durationMs}); the worker records it and tears down. */
    @JavascriptInterface
    fun headlessDone(json: String) {
        run.markStarted()
        run.finish(json)
    }

    companion object {
        private val BODY_REQUIRED = setOf("POST", "PUT", "PATCH", "PROPPATCH", "REPORT")
        private val executor: ExecutorService = Executors.newCachedThreadPool()
        // A request must not outlive the run's two-minute cap.
        private val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.SECONDS)
            .build()
    }
}
