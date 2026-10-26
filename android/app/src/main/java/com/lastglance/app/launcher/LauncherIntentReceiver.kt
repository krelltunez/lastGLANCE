package com.lastglance.app.launcher

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.lastglance.app.SharedDataStore
import com.lastglance.app.intents.IntentReceiver
import org.json.JSONObject

/**
 * The GLANCElauncher's write entry point (docs/launcher-integration.md), beside
 * the automation [IntentReceiver] and sharing its `{action, payload}` envelope
 * and wake broadcast, with two differences:
 *
 *  - It sits behind `com.lastglance.permission.LAUNCHER` in the manifest and
 *    does NOT consult the "Automation intents" toggle: that switch gates the
 *    public, any-app transport and stays as it is.
 *  - Every write carries a `clientId` extra and lands in its own QUEUE
 *    ([SharedDataStore.appendPendingLauncherIntent]), not the automation
 *    transport's single-depth slot. The web layer drains the queue in order
 *    (src/intents/launcherWrites.ts) and dedupes on the id, so a re-sent
 *    write is harmless.
 *
 * Actions: `com.lastglance.app.launcher.CREATE`, `.COMPLETE`, `.LOG_INTERACTION` and `.REFRESH` (not a write: see [refresh]).
 */
class LauncherIntentReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in ACTIONS) return
        val clientId = intent.getStringExtra("clientId")?.takeIf { it.isNotBlank() }
        if (clientId == null) {
            Log.w(TAG, "Dropped $action: no clientId")
            return
        }
        if (action == ACTION_REFRESH) {
            refresh(context, clientId)
            return
        }
        // Re-serialise through JSONObject so a crafted payload cannot inject structure.
        val payload = try {
            intent.getStringExtra("payload")?.let { JSONObject(it) } ?: JSONObject()
        } catch (e: Exception) {
            JSONObject()
        }
        val entry = JSONObject()
            .put("action", action)
            .put("payload", payload)
            .put("clientId", clientId)
            .put("receivedAt", System.currentTimeMillis())
        SharedDataStore.appendPendingLauncherIntent(context, entry.toString())

        // Wake a running app so the WebView drains at once (IntentsBridgePlugin
        // turns this into its pendingIntent event). Package-scoped, like the
        // automation wake.
        context.sendBroadcast(Intent(IntentReceiver.INTENT_RECEIVED).setPackage(context.packageName))
        // With no renderer, a headless run applies it (src/headless/headlessRefresh.ts)
        // rather than leaving it until the app is opened.
        if (!LauncherBridgePlugin.rendererAlive) runHeadlessForWrite(context, clientId)
    }

    /**
     * Schedules a headless run for a write that reached a dead app, logged like a
     * REFRESH under `<clientId>-write` so the launcher's diagnostics show it. Not
     * when a run is already queued, scheduled or running (it applies the queue
     * too), nor inside the ten-minute floor: the launcher re-sends a write it has
     * not seen land, so a later send schedules the run once the floor allows.
     */
    private fun runHeadlessForWrite(context: Context, clientId: String) {
        val now = System.currentTimeMillis()
        val last = SharedDataStore.lastLauncherRefresh(context)
        val inFlight = LauncherRefreshWorker.running ||
            (last != null && last.optString("outcome") in IN_FLIGHT && !last.has("finishedAt") && now - last.optLong("requestedAt") < INFLIGHT_MS)
        if (!HeadlessRefreshPolicy.runForWrite(inFlight, SharedDataStore.launcherHeadlessLastRunAt(context), now)) return
        val runId = "$clientId-write"
        // Logged before the run is scheduled: the worker patches this entry.
        SharedDataStore.appendLauncherRefresh(context, JSONObject().put("clientId", runId).put("requestedAt", now).put("liveness", "dead")
            .put("outcome", "scheduled").put("reason", "a launcher write reached the app while it was closed: headless run scheduled"))
        try {
            LauncherRefreshWorker.schedule(context, runId)
        } catch (e: Exception) {
            Log.w(TAG, "Could not schedule a headless run for a write", e)
            SharedDataStore.updateLauncherRefresh(context, runId, JSONObject().put("outcome", "deferred")
                .put("reason", "a launcher write reached the app while it was closed, and no headless run could be scheduled: ${e.message}"))
        }
        context.contentResolver.notifyChange(LauncherProvider.CONTENT_URI, null)
    }

    /**
     * REFRESH, routed by liveness (docs/launcher-integration.md, "Freshness").
     * Alive: queued and woken, with [LauncherAwakeWorker] holding the app awake
     * so a frozen renderer runs it; the web layer runs every sync road and
     * re-pushes, reporting `ran` or `failed` into the log entry. Dead:
     * [LauncherRefreshWorker] is scheduled to run the same roads headlessly and
     * the entry reads `scheduled` until it reports; only a failed enqueue is
     * `deferred`. A second request inside [INFLIGHT_MS] of one still queued or
     * scheduled is `coalesced`.
     */
    private fun refresh(context: Context, clientId: String) {
        if (SharedDataStore.launcherRefreshSeen(context, clientId)) return
        val now = System.currentTimeMillis()
        val alive = LauncherBridgePlugin.rendererAlive
        val last = SharedDataStore.lastLauncherRefresh(context)
        val entry = JSONObject().put("clientId", clientId).put("requestedAt", now).put("liveness", if (alive) "alive" else "dead")
        val inFlight = last != null && last.optString("outcome") in IN_FLIGHT && !last.has("finishedAt") && now - last.optLong("requestedAt") < INFLIGHT_MS
        when {
            inFlight -> entry.put("outcome", "coalesced").put("reason", "a refresh is in flight")
            !alive -> {
                try {
                    LauncherRefreshWorker.schedule(context, clientId)
                    entry.put("outcome", "scheduled").put("reason", "process not running: headless run scheduled")
                } catch (e: Exception) {
                    Log.w(TAG, "Could not schedule a headless refresh", e)
                    entry.put("outcome", "deferred").put("reason", "process not running, and no headless run could be scheduled: ${e.message}")
                }
            }
            else -> {
                entry.put("outcome", "queued")
                SharedDataStore.appendPendingLauncherIntent(
                    context,
                    JSONObject().put("action", ACTION_REFRESH).put("payload", JSONObject()).put("clientId", clientId).put("receivedAt", now).toString(),
                )
            }
        }
        SharedDataStore.appendLauncherRefresh(context, entry)
        context.contentResolver.notifyChange(LauncherProvider.CONTENT_URI, null)
        if (entry.optString("outcome") == "queued") {
            // Hold the app awake until the web layer answers: a backgrounded app is
            // frozen soon after it goes idle, and the wake below would sit unread.
            // After the log entry, which the hold polls for its outcome.
            LauncherAwakeWorker.schedule(context, clientId)
            context.sendBroadcast(Intent(IntentReceiver.INTENT_RECEIVED).setPackage(context.packageName))
        }
    }

    companion object {
        private const val TAG = "LauncherIntents"
        /** A queued or scheduled refresh older than this with no outcome is treated as lost, not in flight. */
        private const val INFLIGHT_MS = 60_000L
        private val IN_FLIGHT = setOf("queued", "scheduled")
        const val ACTION_CREATE = "com.lastglance.app.launcher.CREATE"
        const val ACTION_COMPLETE = "com.lastglance.app.launcher.COMPLETE"
        const val ACTION_LOG_INTERACTION = "com.lastglance.app.launcher.LOG_INTERACTION"
        const val ACTION_REFRESH = "com.lastglance.app.launcher.REFRESH"
        val ACTIONS = setOf(ACTION_CREATE, ACTION_COMPLETE, ACTION_LOG_INTERACTION, ACTION_REFRESH)
    }
}
