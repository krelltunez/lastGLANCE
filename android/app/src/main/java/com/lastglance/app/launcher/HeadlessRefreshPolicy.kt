package com.lastglance.app.launcher

import org.json.JSONObject

/**
 * What a scheduled headless refresh does when its worker finally runs. Pure,
 * so the decision is testable without WorkManager or a WebView; the worker is
 * wiring around it (docs/launcher-integration.md, "Freshness"). Ported from
 * dayGLANCE's policy of the same name.
 */
object HeadlessRefreshPolicy {
    /** Two headless runs are never closer than this: a WebView boot costs seconds and tens of MB. */
    const val MIN_INTERVAL_MS = 10 * 60_000L
    /**
     * A run that has not reported by then is torn down and logged `failed`. Two
     * minutes, as dayGLANCE's (an alive cycle there measured 75 s on a real
     * account): a cycle plus the WebView boot.
     */
    const val CAP_MS = 120_000L
    /**
     * A page that has not called the bridge by then is not running the headless
     * root. The app registers its PWA service worker in the native build too,
     * and the headless WebView shares the app's origin, so the worker serves
     * the bundle it cached; right after an update that can be the previous one,
     * which renders App instead. It is torn down rather than left to the cap.
     * The first bridge call (the secure-config hydration) comes within a
     * second or two of the load.
     */
    const val BOOT_MS = 20_000L

    sealed class Decision {
        /** The renderer is alive by now: queue the REFRESH for it instead (it reports `ran`/`failed`). */
        object HandToLive : Decision()
        /** A headless run finished too recently; the launcher shows the honest age. */
        data class Throttled(val sinceLastMs: Long) : Decision()
        /** Boot the headless WebView. */
        object Run : Decision()
    }

    /**
     * Whether a launcher write that reached a dead app starts a headless run to apply it:
     * not while one is queued or running (it applies the queue too), nor inside the floor
     * (the launcher re-sends a write it has not seen land, and a later send starts the run).
     */
    fun runForWrite(runInFlight: Boolean, lastRunAt: Long, now: Long): Boolean =
        !runInFlight && decide(rendererAlive = false, lastRunAt = lastRunAt, now = now) is Decision.Run

    fun decide(rendererAlive: Boolean, lastRunAt: Long, now: Long): Decision {
        if (rendererAlive) return Decision.HandToLive
        val since = now - lastRunAt
        if (lastRunAt > 0 && since in 0 until MIN_INTERVAL_MS) return Decision.Throttled(since)
        return Decision.Run
    }

    /** The log entry's reason for a throttled run. */
    fun throttledReason(sinceLastMs: Long): String =
        "a headless run finished ${sinceLastMs / 1000} s ago (floor ${MIN_INTERVAL_MS / 60_000} min)"

    /**
     * The log-entry patch for the web layer's report ({clientId, outcome,
     * reason?, durationMs}). The reason always comes from the report, null when
     * it gives none: the entry still carries the receiver's "headless run
     * scheduled", which would otherwise read as the reason a run that ran had.
     */
    fun reportPatch(json: String, now: Long): JSONObject {
        val report = try { JSONObject(json) } catch (e: Exception) { JSONObject().put("outcome", "failed").put("reason", "unreadable report") }
        val patch = JSONObject()
            .put("outcome", report.optString("outcome").ifEmpty { "failed" })
            .put("reason", report.opt("reason")?.takeUnless { it == JSONObject.NULL } ?: JSONObject.NULL)
            .put("finishedAt", now)
        if (report.has("durationMs")) patch.put("durationMs", report.get("durationMs"))
        return patch
    }

    /** The outcome the worker records when the web layer did not report one itself. */
    fun unreportedOutcome(aborted: Boolean, timedOut: Boolean, rendererGone: Boolean, started: Boolean = true): Pair<String, String> = when {
        aborted -> "aborted" to "app opened"
        !started -> "failed" to "the page did not start a headless run within ${BOOT_MS / 1000} s (an older cached bundle?)"
        timedOut -> "failed" to "timed out after ${CAP_MS / 1000} s"
        rendererGone -> "failed" to "the WebView renderer died"
        else -> "failed" to "the run ended without reporting"
    }
}
