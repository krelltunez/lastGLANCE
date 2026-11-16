package com.lastglance.app.launcher

import org.json.JSONArray
import org.json.JSONObject

/**
 * The launcher snapshot (src/native/launcherSnapshot.ts) as the rows the
 * [LauncherProvider] serves: one cursor per collection, each row the
 * collection's JSON object and its id. Pure over the JSON text so the mapping
 * is unit-tested on the JVM; the provider only adds the Android plumbing.
 *
 * Collections: `chores` and `people` (arrays of objects with an `id`) and
 * `meta` (one row: version, updatedAt, timezone, today, handledWrites, and
 * completionsByDay, the last year of completions a day for the heatmap).
 */
object LauncherSnapshotRows {

    const val AUTHORITY = "com.lastglance.app.launcher"

    val COLLECTIONS: Set<String> = setOf("chores", "people", "meta")

    /** The cursor's columns: a row number, the row's id, and the row as JSON. */
    val COLUMNS = arrayOf("_id", "id", "json")

    data class Row(val id: String, val json: String)

    /**
     * The rows of [collection] in [snapshotJson], or null for an unknown collection.
     * `meta` also carries the heartbeat ([heartbeatJson]: checkedAt, syncedAt), the
     * refresh log, the renderer's liveness and whether a headless refresh is
     * running, as of this read. A heartbeat without a snapshot still yields a
     * meta row.
     */
    fun rows(snapshotJson: String?, collection: String, heartbeatJson: String? = null, refreshLogJson: String? = null, rendererAlive: Boolean? = null, headlessRunning: Boolean? = null): List<Row>? {
        if (collection !in COLLECTIONS) return null
        if (collection == "meta") {
            val meta = JSONObject()
            val root = snapshotJson?.let { try { JSONObject(it) } catch (e: Exception) { null } }
            if (root != null) {
                for (key in listOf("version", "updatedAt", "timezone", "today", "handledWrites", "completionsByDay")) {
                    if (root.has(key)) meta.put(key, root.get(key))
                }
            }
            heartbeatJson?.let { try { JSONObject(it) } catch (e: Exception) { null } }?.let { hb ->
                for (key in hb.keys()) meta.put(key, hb.get(key))
            }
            refreshLogJson?.let { try { JSONArray(it) } catch (e: Exception) { null } }?.let { meta.put("refreshLog", it) }
            rendererAlive?.let { meta.put("rendererAlive", it) }
            headlessRunning?.let { meta.put("headlessRunning", it) }
            return if (root == null && heartbeatJson == null) emptyList() else listOf(Row("meta", meta.toString()))
        }
        if (snapshotJson.isNullOrEmpty()) return emptyList()
        val root = try { JSONObject(snapshotJson) } catch (e: Exception) { return emptyList() }
        return when (collection) {
            else -> {
                val arr: JSONArray = root.optJSONArray(collection) ?: return emptyList()
                val out = ArrayList<Row>(arr.length())
                for (i in 0 until arr.length()) {
                    val obj = arr.optJSONObject(i) ?: continue
                    out.add(Row(obj.optString("id", i.toString()), obj.toString()))
                }
                out
            }
        }
    }
}
