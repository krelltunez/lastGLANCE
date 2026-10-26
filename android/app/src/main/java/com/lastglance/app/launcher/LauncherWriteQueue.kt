package com.lastglance.app.launcher

import org.json.JSONArray

/**
 * The launcher's queue ([com.lastglance.app.SharedDataStore.appendPendingLauncherIntent]),
 * taken by the page in two steps so a write survives the page dying before it lands.
 * Pure: tested on the JVM. Ported from dayGLANCE's LauncherWriteQueue.
 *
 * [take] hands the page every entry but keeps the writes; the page removes each with [ack]
 * once its handler has finished (src/hooks/useAndroidIntentBridge.ts, and the headless run).
 * A page that stalls in the background, or is closed (LauncherPageRetire), or killed, before
 * then leaves its writes queued for the next one, which dedupes on the id. A REFRESH is not a
 * write: it is taken off at once, as before, since a re-delivered one would only run a second
 * cycle and its outcome is the native log's (LauncherRefreshTrace stamps the pick-up).
 */
object LauncherWriteQueue {
    /** What the page is given, and what stays queued. */
    data class Taken(val delivered: String, val kept: String)

    @JvmStatic
    fun take(queueJson: String?, refreshAction: String): Taken {
        val arr = parse(queueJson)
        val kept = JSONArray()
        for (i in 0 until arr.length()) {
            val e = arr.optJSONObject(i) ?: continue
            if (e.optString("action") != refreshAction) kept.put(e)
        }
        return Taken(arr.toString(), kept.toString())
    }

    /** [queueJson] without the entries whose clientId is in [idsJson] (a JSON array of strings). */
    @JvmStatic
    fun ack(queueJson: String?, idsJson: String?): String {
        val ids = HashSet<String>()
        val idArr = try { JSONArray(idsJson ?: "[]") } catch (e: Exception) { JSONArray() }
        for (i in 0 until idArr.length()) idArr.optString(i).takeIf { it.isNotEmpty() }?.let { ids += it }
        val arr = parse(queueJson)
        if (ids.isEmpty()) return arr.toString()
        val kept = JSONArray()
        for (i in 0 until arr.length()) {
            val e = arr.optJSONObject(i) ?: continue
            if (e.optString("clientId") !in ids) kept.put(e)
        }
        return kept.toString()
    }

    private fun parse(json: String?): JSONArray =
        try { JSONArray(json ?: "[]") } catch (e: Exception) { JSONArray() }
}
