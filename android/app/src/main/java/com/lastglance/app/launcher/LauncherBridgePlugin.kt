package com.lastglance.app.launcher

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.lastglance.app.SharedDataStore

/**
 * The JS-callable surface of the GLANCElauncher integration
 * (src/native/launcherBridge.ts, docs/launcher-integration.md):
 *
 *   updateSnapshot()       store the launcher snapshot and notify the provider's observers
 *   drainPendingIntents()  read + clear the launcher write queue
 *
 * The wake for a write that lands while the app runs is the automation
 * transport's INTENT_RECEIVED signal, which [com.lastglance.app.intents.IntentsBridgePlugin]
 * already turns into its `pendingIntent` event; the web bridge drains both
 * queues on it. Registered in MainActivity.
 */
@CapacitorPlugin(name = "LauncherBridge")
class LauncherBridgePlugin : Plugin() {

    override fun load() {
        rendererAlive = true
    }

    override fun handleOnDestroy() {
        rendererAlive = false
    }

    /** The heartbeat ({checkedAt, syncedAt}), merged and announced; see docs/launcher-integration.md "Freshness". */
    @PluginMethod
    fun touchHeartbeat(call: PluginCall) {
        val json = call.getString("json")
        if (json == null) {
            call.reject("missing json")
            return
        }
        SharedDataStore.mergeLauncherHeartbeat(context, json)
        context.contentResolver.notifyChange(LauncherProvider.CONTENT_URI, null)
        call.resolve()
    }

    /** The outcome of a launcher REFRESH ({clientId, outcome, reason?, durationMs}), merged into its log entry. */
    @PluginMethod
    fun recordRefresh(call: PluginCall) {
        val json = call.getString("json")
        if (json == null) {
            call.reject("missing json")
            return
        }
        try {
            val entry = org.json.JSONObject(json)
            val clientId = entry.optString("clientId")
            if (clientId.isNotEmpty()) {
                entry.put("finishedAt", System.currentTimeMillis())
                SharedDataStore.updateLauncherRefresh(context, clientId, entry)
                context.contentResolver.notifyChange(LauncherProvider.CONTENT_URI, null)
            }
        } catch (e: Exception) {
            // A malformed record is the web layer's bug; the log keeps what it had.
        }
        call.resolve()
    }

    @PluginMethod
    fun updateSnapshot(call: PluginCall) {
        val json = call.getString("json")
        if (json == null) {
            call.reject("missing json")
            return
        }
        SharedDataStore.writeLauncherSnapshot(context, json)
        context.contentResolver.notifyChange(LauncherProvider.CONTENT_URI, null)
        call.resolve()
    }

    /**
     * The launcher's queued entries, oldest first. The writes stay queued until
     * [ackIntents] says each is handled, so a page that dies first leaves them for
     * the next (LauncherWriteQueue). A REFRESH taken here is stamped as picked up,
     * so one that then goes unanswered says the page had it (LauncherRefreshTrace).
     */
    @PluginMethod
    fun drainPendingIntents(call: PluginCall) {
        val drained = SharedDataStore.takePendingLauncherIntents(context)
        LauncherRefreshTrace.markPickedUp(context, drained)
        val ret = JSObject()
        ret.put("intents", drained)
        call.resolve(ret)
    }

    /** The launcher writes the page has handled, by clientId (`ids`, a JSON array): off the queue. */
    @PluginMethod
    fun ackIntents(call: PluginCall) {
        SharedDataStore.ackPendingLauncherIntents(context, call.getString("ids") ?: "[]")
        call.resolve()
    }

    companion object {
        /**
         * True while the Capacitor bridge (and so the WebView) is loaded in this
         * process. A static, so a dead process answers false by construction; the
         * launcher receiver routes REFRESH on it.
         */
        @JvmStatic
        @Volatile
        var rendererAlive: Boolean = false
    }
}
