package com.lastglance.app.glance

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.ListView
import com.lastglance.app.R
import com.lastglance.app.SharedDataStore
import org.json.JSONObject

// Configuration screen shown when a single-chore tile is placed: pick which chore
// it tracks (or "automatic" = most overdue). Plain Activity + ListView so it needs
// no Compose-UI dependencies. Choices come from the snapshot the web app pushes.
class SingleChoreConfigActivity : Activity() {

    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // If the user backs out, the host cancels placement.
        setResult(RESULT_CANCELED)

        appWidgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }

        // First row is the automatic option (syncId null); the rest are chores.
        val labels = ArrayList<String>()
        val syncIds = ArrayList<String?>()
        labels.add(getString(R.string.widget_config_auto))
        syncIds.add(null)
        for ((syncId, name) in readChores(this)) {
            labels.add(name)
            syncIds.add(syncId)
        }

        val list = ListView(this)
        list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, labels)
        list.setOnItemClickListener { _, _, position, _ ->
            SharedDataStore.writeWidgetChore(this, appWidgetId, syncIds[position])
            kickWidget()
            setResult(
                RESULT_OK,
                Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId),
            )
            finish()
        }
        setContentView(list)
    }

    private fun kickWidget() {
        val intent = Intent(this, SingleChoreWidgetReceiver::class.java)
            .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, intArrayOf(appWidgetId))
        sendBroadcast(intent)
    }

    private fun readChores(context: Context): List<Pair<String, String>> {
        val raw = SharedDataStore.readSnapshot(context) ?: return emptyList()
        return try {
            val arr = JSONObject(raw).optJSONArray("chores") ?: return emptyList()
            val out = ArrayList<Pair<String, String>>()
            for (i in 0 until arr.length()) {
                val ch = arr.getJSONObject(i)
                out.add(ch.optString("syncId") to ch.optString("name"))
            }
            out.sortBy { it.second.lowercase() }
            out
        } catch (e: Exception) {
            emptyList()
        }
    }
}
