package com.lastglance.app.launcher

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The snapshot-to-rows mapping the LauncherProvider serves, over the JSON the web layer pushes. */
class LauncherSnapshotRowsTest {

    private val snapshot = """
        {"version":1,"updatedAt":1760000000000,"timezone":"America/Denver","today":"2026-10-19",
         "chores":[{"id":"c1","name":"Vacuum","category":"Kitchen","targetCadenceDays":7,"lastDoneAt":"2026-10-15T12:00:00.000Z","clientId":null},
                   {"id":"c2","name":"Mow","category":"Garden","targetCadenceDays":null,"lastDoneAt":null,"clientId":"w-1"}],
         "people":[{"id":"p1","name":"Ana","circle":"Family","dates":[{"id":"d1","kind":"birthday","month":11,"day":2}]}],
         "handledWrites":[{"clientId":"w-1","action":"create","entityId":"c2"}],
         "completionsByDay":{"2026-10-18":2,"2026-10-19":1}}
    """.trimIndent()

    @Test
    fun `an array collection is one row per object, keyed by its id`() {
        val chores = LauncherSnapshotRows.rows(snapshot, "chores")!!
        assertEquals(listOf("c1", "c2"), chores.map { it.id })
        assertTrue(JSONObject(chores[0].json).isNull("clientId"))
        assertEquals("w-1", JSONObject(chores[1].json).getString("clientId"))
        val people = LauncherSnapshotRows.rows(snapshot, "people")!!
        assertEquals("Family", JSONObject(people.single().json).getString("circle"))
        assertEquals(11, JSONObject(people.single().json).getJSONArray("dates").getJSONObject(0).getInt("month"))
    }

    @Test
    fun `meta is a single row with the snapshot's stamp and ledger`() {
        val meta = JSONObject(LauncherSnapshotRows.rows(snapshot, "meta")!!.single().json)
        assertEquals(1, meta.getInt("version"))
        assertEquals(1760000000000L, meta.getLong("updatedAt"))
        assertEquals("2026-10-19", meta.getString("today"))
        assertEquals("c2", meta.getJSONArray("handledWrites").getJSONObject(0).getString("entityId"))
        assertTrue(!meta.has("chores"))
        // The heatmap's counts ride the meta row, so a launcher from before them reads on unharmed.
        assertEquals(2, meta.getJSONObject("completionsByDay").getInt("2026-10-18"))
    }

    @Test
    fun `meta carries the heartbeat, the refresh log and liveness, even without a snapshot`() {
        val hb = """{"checkedAt":1760000100000,"syncedAt":"2026-10-19T08:00:00.000Z"}"""
        val log = """[{"clientId":"r1","requestedAt":1,"outcome":"deferred","liveness":"dead","reason":"process not running"}]"""
        val meta = JSONObject(LauncherSnapshotRows.rows(snapshot, "meta", hb, log, false, headlessRunning = true)!!.single().json)
        assertEquals(1760000000000L, meta.getLong("updatedAt"))
        assertEquals(1760000100000L, meta.getLong("checkedAt"))
        assertEquals("2026-10-19T08:00:00.000Z", meta.getString("syncedAt"))
        assertTrue(!meta.getBoolean("rendererAlive"))
        assertTrue(meta.getBoolean("headlessRunning"))
        assertEquals("deferred", meta.getJSONArray("refreshLog").getJSONObject(0).getString("outcome"))
        val bare = JSONObject(LauncherSnapshotRows.rows(null, "meta", hb, null, null)!!.single().json)
        assertEquals(1760000100000L, bare.getLong("checkedAt"))
        assertTrue(!bare.has("headlessRunning"))
        assertEquals(0, LauncherSnapshotRows.rows(null, "meta", null, null, null)!!.size)
    }

    @Test
    fun `an unknown collection is null, no snapshot or bad JSON is empty`() {
        assertNull(LauncherSnapshotRows.rows(snapshot, "tasks"))
        assertEquals(0, LauncherSnapshotRows.rows(null, "chores")!!.size)
        assertEquals(0, LauncherSnapshotRows.rows("not json", "people")!!.size)
        assertEquals(0, LauncherSnapshotRows.rows("""{"version":1}""", "chores")!!.size)
    }
}
