package com.lastglance.app.launcher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a scheduled headless refresh does once its worker runs (LauncherRefreshWorker). */
class HeadlessRefreshPolicyTest {
    private val now = 1_760_000_000_000L

    @Test
    fun `a renderer that came up while the job waited takes the refresh`() {
        assertEquals(HeadlessRefreshPolicy.Decision.HandToLive, HeadlessRefreshPolicy.decide(rendererAlive = true, lastRunAt = 0L, now = now))
        // Even when a headless run is also due.
        assertEquals(HeadlessRefreshPolicy.Decision.HandToLive, HeadlessRefreshPolicy.decide(true, now - 60 * 60_000L, now))
    }

    @Test
    fun `a run inside the ten-minute floor is throttled with the age`() {
        val d = HeadlessRefreshPolicy.decide(rendererAlive = false, lastRunAt = now - 4 * 60_000L, now = now)
        assertTrue(d is HeadlessRefreshPolicy.Decision.Throttled)
        assertEquals(4 * 60_000L, (d as HeadlessRefreshPolicy.Decision.Throttled).sinceLastMs)
        assertEquals("a headless run finished 240 s ago (floor 10 min)", HeadlessRefreshPolicy.throttledReason(d.sinceLastMs))
    }

    @Test
    fun `the first run, one past the floor, and one after a clock set back all run`() {
        assertEquals(HeadlessRefreshPolicy.Decision.Run, HeadlessRefreshPolicy.decide(false, 0L, now))
        assertEquals(HeadlessRefreshPolicy.Decision.Run, HeadlessRefreshPolicy.decide(false, now - HeadlessRefreshPolicy.MIN_INTERVAL_MS, now))
        // A last-run stamp in the future (the clock moved) must not block forever.
        assertEquals(HeadlessRefreshPolicy.Decision.Run, HeadlessRefreshPolicy.decide(false, now + 60_000L, now))
    }

    @Test
    fun `a report replaces the scheduling reason, with none when it gives none`() {
        val ran = HeadlessRefreshPolicy.reportPatch("""{"clientId":"c1","outcome":"ran","durationMs":348}""", now)
        assertEquals("ran", ran.getString("outcome"))
        assertTrue(ran.has("reason") && ran.isNull("reason"))
        assertEquals(348, ran.getInt("durationMs"))
        assertEquals(now, ran.getLong("finishedAt"))
        val failed = HeadlessRefreshPolicy.reportPatch("""{"clientId":"c1","outcome":"failed","reason":"file: offline","durationMs":9}""", now)
        assertEquals("file: offline", failed.getString("reason"))
        val garbled = HeadlessRefreshPolicy.reportPatch("not json", now)
        assertEquals("failed", garbled.getString("outcome"))
        assertEquals("unreadable report", garbled.getString("reason"))
    }

    @Test
    fun `an unreported run is named by what stopped it, abort first`() {
        assertEquals("aborted" to "app opened", HeadlessRefreshPolicy.unreportedOutcome(aborted = true, timedOut = true, rendererGone = true))
        assertEquals("failed" to "timed out after 120 s", HeadlessRefreshPolicy.unreportedOutcome(false, true, false))
        assertEquals("failed" to "the WebView renderer died", HeadlessRefreshPolicy.unreportedOutcome(false, false, true))
        assertEquals("failed" to "the run ended without reporting", HeadlessRefreshPolicy.unreportedOutcome(false, false, false))
        // A page that never called the bridge is a stale bundle, whatever else happened after.
        assertEquals(
            "failed" to "the page did not start a headless run within 20 s (an older cached bundle?)",
            HeadlessRefreshPolicy.unreportedOutcome(aborted = false, timedOut = true, rendererGone = false, started = false),
        )
        assertEquals("aborted" to "app opened", HeadlessRefreshPolicy.unreportedOutcome(true, false, false, started = false))
    }

    @Test
    fun `a write at a dead app starts a run, unless one is in flight or the floor holds`() {
        val now = 10_000_000L
        assertEquals(true, HeadlessRefreshPolicy.runForWrite(runInFlight = false, lastRunAt = 0, now = now))
        assertEquals(true, HeadlessRefreshPolicy.runForWrite(runInFlight = false, lastRunAt = now - HeadlessRefreshPolicy.MIN_INTERVAL_MS, now = now))
        assertEquals(false, HeadlessRefreshPolicy.runForWrite(runInFlight = true, lastRunAt = 0, now = now))
        assertEquals(false, HeadlessRefreshPolicy.runForWrite(runInFlight = false, lastRunAt = now - 60_000, now = now))
    }
}
