package com.lastglance.app.launcher

import org.json.JSONArray
import org.json.JSONObject

/** When a live renderer has answered a REFRESH. Pure, tested on the JVM. */
object LauncherRefreshWait {

    /**
     * True once the entry has an outcome the web layer recorded: anything but
     * queued, or a finish stamp. A missing entry (pruned from the log, or never
     * written) is nothing to wait for.
     */
    fun answered(entry: JSONObject?): Boolean {
        if (entry == null) return true
        if (entry.has("finishedAt") && !entry.isNull("finishedAt")) return true
        return entry.optString("outcome") != "queued"
    }

    /**
     * What [LauncherAwakeWorker] writes when its hold ran out with the entry
     * still waiting: `unanswered`, with how late the hold began, so a request
     * the web layer never took is not left reading `queued` forever, and a
     * job Android held back shows as one. Null once answered.
     */
    fun unansweredPatch(entry: JSONObject, heldFrom: Long, now: Long): JSONObject? {
        if (answered(entry)) return null
        val requestedAt = entry.optLong("requestedAt", heldFrom)
        val lateSec = seconds(heldFrom - requestedAt)
        val heldSec = seconds(now - heldFrom)
        val began = "(the hold began $lateSec s after the request)"
        // Which step it stopped at, from the stamps the app left on the way (see [stampPatch]).
        val reason = when {
            entry.has(PICKED_UP_AT) ->
                "the page took the request ${seconds(entry.optLong(PICKED_UP_AT) - requestedAt)} s after it was sent, but had not finished when the hold ended after $heldSec s $began"
            entry.has(WOKEN_AT) ->
                "the app was woken ${seconds(entry.optLong(WOKEN_AT) - requestedAt)} s after the request, but the page never took it while held awake for $heldSec s $began"
            else ->
                "the wake never reached the app while it was held awake for $heldSec s $began"
        }
        return JSONObject()
            .put("outcome", "unanswered")
            .put("reason", reason)
            .put("holdStartedAt", heldFrom)
            .put("finishedAt", now)
    }

    /** When the app's wake receiver ran for a waiting request (IntentsBridgePlugin's INTENT_RECEIVED). */
    const val WOKEN_AT = "wokenAt"

    /** When the page drained the request from the launcher queue (LauncherBridgePlugin.drainPendingIntents). */
    const val PICKED_UP_AT = "pickedUpAt"

    /**
     * The stamp [key] at [now] for an entry still waiting, once: the first wake
     * or pickup is the one that says how far a request got. Null once answered
     * or already stamped.
     */
    fun stampPatch(entry: JSONObject, key: String, now: Long): JSONObject? =
        if (answered(entry) || entry.has(key)) null else JSONObject().put(key, now)

    /** The client ids of the [refreshAction] requests in a drained launcher queue (a JSON array of {action, clientId}). */
    fun refreshIds(drainedJson: String, refreshAction: String): List<String> {
        val arr = try { JSONArray(drainedJson) } catch (e: Exception) { return emptyList() }
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            o.optString("clientId").takeIf { o.optString("action") == refreshAction && it.isNotEmpty() }
        }
    }

    // A live page that stops answering in the background is closed, as a swipe
    // from Recents would, and the refresh goes to the headless path, which works
    // (docs/launcher-integration.md, "Freshness"): a backgrounded WebView can stop
    // running timers and network replies for hours while still running a script
    // handed to it directly. LauncherPageRetire does it; these are its rules.

    /** How long the app must have been in the background: a page stalls about a minute after it is left, and every save has long landed. */
    const val RETIRE_MIN_BACKGROUND_MS = 120_000L

    /** Only an app in the background (stopped since [stoppedAt], 0 while on screen) for at least [RETIRE_MIN_BACKGROUND_MS]. */
    fun mayRetire(stoppedAt: Long, now: Long): Boolean = stoppedAt > 0 && now - stoppedAt >= RETIRE_MIN_BACKGROUND_MS

    /** The page's answer to the retire check, as evaluateJavascript returns it: only `ok` lets it close. */
    fun pageReady(checkResult: String?): Boolean = checkResult == "\"ok\""

    /** On the unanswered entry: the page was closed, and the refresh follows headlessly. */
    fun retiredPatch(entry: JSONObject): JSONObject =
        JSONObject().put("reason", entry.optString("reason") + "; the app closed the unresponsive page, and a headless refresh follows").put("pageClosed", true)

    /** On the unanswered entry: the page was left open, and why. */
    fun keptPatch(entry: JSONObject, why: String): JSONObject =
        JSONObject().put("reason", entry.optString("reason") + "; the page was left open: $why")

    /** The headless run that follows a closed page, as the receiver logs one for a dead process. */
    fun headlessEntry(clientId: String, now: Long): JSONObject = JSONObject()
        .put("clientId", "$clientId-headless")
        .put("requestedAt", now)
        .put("liveness", "dead")
        .put("outcome", "scheduled")
        .put("reason", "the app's page had stopped answering, so the app closed it: headless run scheduled")

    private fun seconds(ms: Long): Long = (ms.coerceAtLeast(0) + 500) / 1000
}
