package com.lastglance.app.launcher

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test

/** The launcher queue is taken in two steps, so a write outlives a page that dies before saving it. */
class LauncherWriteQueueTest {
    private val refresh = "com.lastglance.app.launcher.REFRESH"
    private val create = "com.lastglance.app.launcher.CREATE"
    private val complete = "com.lastglance.app.launcher.COMPLETE"
    private val queue = """[{"action":"$create","clientId":"w1","payload":{"title":"Dentist"}},
        {"action":"$refresh","clientId":"r1"},{"action":"$complete","clientId":"w2","payload":{"task_id":"t1"}}]"""

    private fun ids(json: String) = JSONArray(json).let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("clientId") } }

    @Test
    fun `taking hands the page every entry but keeps the writes queued`() {
        val taken = LauncherWriteQueue.take(queue, refresh)
        assertEquals(listOf("w1", "r1", "w2"), ids(taken.delivered))
        assertEquals(listOf("w1", "w2"), ids(taken.kept))
        // Taking again (a second page, after the first died) still delivers the writes.
        assertEquals(listOf("w1", "w2"), ids(LauncherWriteQueue.take(taken.kept, refresh).delivered))
    }

    @Test
    fun `an ack removes only the writes it names`() {
        val kept = LauncherWriteQueue.take(queue, refresh).kept
        assertEquals(listOf("w2"), ids(LauncherWriteQueue.ack(kept, """["w1"]""")))
        assertEquals(emptyList<String>(), ids(LauncherWriteQueue.ack(kept, """["w1","w2","unknown"]""")))
        // A write appended after the page took the queue is not lost by its ack.
        val appended = JSONArray(kept).put(org.json.JSONObject().put("action", create).put("clientId", "w3")).toString()
        assertEquals(listOf("w3"), ids(LauncherWriteQueue.ack(appended, """["w1","w2"]""")))
    }

    @Test
    fun `nothing queued, or anything unreadable, is an empty queue`() {
        assertEquals("[]", LauncherWriteQueue.take(null, refresh).delivered)
        assertEquals("[]", LauncherWriteQueue.take("not json", refresh).kept)
        assertEquals(listOf("w1", "r1", "w2"), ids(LauncherWriteQueue.ack(queue, "not json")))
        assertEquals("[]", LauncherWriteQueue.ack(null, """["w1"]"""))
    }
}
