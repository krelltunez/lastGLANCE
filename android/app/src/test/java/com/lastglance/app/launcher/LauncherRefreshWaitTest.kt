package com.lastglance.app.launcher

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** When the awake hold may end: once the web layer has recorded an outcome for the request. */
class LauncherRefreshWaitTest {
    private fun entry(json: String) = JSONObject(json)

    @Test
    fun `a request still queued is waited on`() {
        assertFalse(LauncherRefreshWait.answered(entry("""{"clientId":"c1","outcome":"queued","liveness":"alive"}""")))
        assertFalse(LauncherRefreshWait.answered(entry("""{"clientId":"c1","outcome":"queued","finishedAt":null}""")))
    }

    @Test
    fun `an outcome or a finish stamp ends the wait`() {
        assertTrue(LauncherRefreshWait.answered(entry("""{"clientId":"c1","outcome":"ran","durationMs":240,"finishedAt":1}""")))
        assertTrue(LauncherRefreshWait.answered(entry("""{"clientId":"c1","outcome":"failed","reason":"vault: offline"}""")))
        assertTrue(LauncherRefreshWait.answered(entry("""{"clientId":"c1","outcome":"queued","finishedAt":1792644336246}""")))
    }

    @Test
    fun `a request no longer in the log is nothing to wait for`() {
        assertTrue(LauncherRefreshWait.answered(null))
    }

    @Test
    fun `a hold that ran out on a waiting request marks it unanswered, with how late the hold began`() {
        val patch = LauncherRefreshWait.unansweredPatch(
            JSONObject("""{"clientId":"c1","outcome":"queued","requestedAt":1000}"""), heldFrom = 4_000, now = 64_000,
        )!!
        assertEquals("unanswered", patch.getString("outcome"))
        assertEquals("the wake never reached the app while it was held awake for 60 s (the hold began 3 s after the request)", patch.getString("reason"))
        assertEquals(64_000L, patch.getLong("finishedAt"))
        assertTrue(LauncherRefreshWait.answered(JSONObject(patch.toString())))
    }

    @Test
    fun `an answer that landed before the hold ran out is never overwritten`() {
        assertNull(LauncherRefreshWait.unansweredPatch(JSONObject("""{"clientId":"c1","outcome":"ran","requestedAt":1000}"""), 4_000, 64_000))
        assertNull(LauncherRefreshWait.unansweredPatch(JSONObject("""{"clientId":"c1","outcome":"failed","reason":"x"}"""), 4_000, 64_000))
    }

    @Test
    fun `an unanswered request says how far it got`() {
        val woken = LauncherRefreshWait.unansweredPatch(
            JSONObject("""{"clientId":"c1","outcome":"queued","requestedAt":1000,"wokenAt":1400}"""), heldFrom = 1_000, now = 61_000,
        )!!
        assertEquals("the app was woken 0 s after the request, but the page never took it while held awake for 60 s (the hold began 0 s after the request)", woken.getString("reason"))
        val taken = LauncherRefreshWait.unansweredPatch(
            JSONObject("""{"clientId":"c1","outcome":"queued","requestedAt":1000,"wokenAt":1400,"pickedUpAt":3600}"""), heldFrom = 1_000, now = 61_000,
        )!!
        assertEquals("the page took the request 3 s after it was sent, but had not finished when the hold ended after 60 s (the hold began 0 s after the request)", taken.getString("reason"))
    }

    @Test
    fun `a stamp is written once, and never on an answered request`() {
        val waiting = JSONObject("""{"clientId":"c1","outcome":"queued","requestedAt":1000}""")
        assertEquals(2_000L, LauncherRefreshWait.stampPatch(waiting, LauncherRefreshWait.WOKEN_AT, 2_000)!!.getLong("wokenAt"))
        assertNull(LauncherRefreshWait.stampPatch(JSONObject("""{"clientId":"c1","outcome":"queued","wokenAt":1500}"""), LauncherRefreshWait.WOKEN_AT, 2_000))
        assertNull(LauncherRefreshWait.stampPatch(JSONObject("""{"clientId":"c1","outcome":"ran","finishedAt":1}"""), LauncherRefreshWait.PICKED_UP_AT, 2_000))
    }

    @Test
    fun `only the REFRESH requests in a drained queue are picked out`() {
        val drained = """[{"action":"R","clientId":"r1"},{"action":"C","clientId":"w1"},{"action":"R","clientId":""},{"action":"R","clientId":"r2"}]"""
        assertEquals(listOf("r1", "r2"), LauncherRefreshWait.refreshIds(drained, "R"))
        assertEquals(emptyList<String>(), LauncherRefreshWait.refreshIds("not json", "R"))
    }

    @Test
    fun `a page is closed only after two minutes in the background`() {
        assertFalse(LauncherRefreshWait.mayRetire(stoppedAt = 0, now = 10_000_000))
        assertFalse(LauncherRefreshWait.mayRetire(stoppedAt = 9_900_000, now = 10_000_000))
        assertTrue(LauncherRefreshWait.mayRetire(stoppedAt = 10_000_000 - 120_000, now = 10_000_000))
    }

    @Test
    fun `only an ok from the page lets it close`() {
        assertTrue(LauncherRefreshWait.pageReady("\"ok\""))
        assertFalse(LauncherRefreshWait.pageReady("\"error\""))
        assertFalse(LauncherRefreshWait.pageReady("null"))
        assertFalse(LauncherRefreshWait.pageReady(null))
    }

    @Test
    fun `a closed page is noted on the unanswered entry and a headless run follows`() {
        val unanswered = JSONObject("""{"clientId":"c1","outcome":"unanswered","reason":"the app was woken 0 s after the request"}""")
        assertEquals("the app was woken 0 s after the request; the app closed the unresponsive page, and a headless refresh follows",
            LauncherRefreshWait.retiredPatch(unanswered).getString("reason"))
        assertEquals("the app was woken 0 s after the request; the page was left open: it did not close",
            LauncherRefreshWait.keptPatch(unanswered, "it did not close").getString("reason"))
        val next = LauncherRefreshWait.headlessEntry("c1", 5_000)
        assertEquals("c1-headless", next.getString("clientId"))
        assertEquals("scheduled", next.getString("outcome"))
        assertEquals("dead", next.getString("liveness"))
    }
}
