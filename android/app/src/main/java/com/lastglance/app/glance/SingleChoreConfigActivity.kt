package com.lastglance.app.glance

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import androidx.appcompat.app.AppCompatActivity
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import com.lastglance.app.R
import com.lastglance.app.SharedDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

// The per-widget chosen chore, stored in the widget's own Glance state (keyed by
// glanceId) — the canonical Glance mechanism. SingleChoreWidget reads it via
// currentState.
internal val CHORE_PREF_KEY = stringPreferencesKey("chore")

// Configuration screen shown when a single-chore tile is placed: pick which chore
// it tracks (or "automatic" = most overdue), with a search box for large lists.
// Plain Activity + ListView (no Compose-UI deps); shown as a dialog. Choices come
// from the snapshot the web app pushes.
class SingleChoreConfigActivity : AppCompatActivity() {

    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    // (syncId, label); the first entry is the "automatic" option with a null syncId.
    private val all = ArrayList<Pair<String?, String>>()
    private val shown = ArrayList<Pair<String?, String>>()
    private lateinit var adapter: ArrayAdapter<String>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED) // backing out cancels placement
        setTitle(R.string.widget_config_title)

        appWidgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }

        all.add(null to getString(R.string.widget_config_auto))
        shown.addAll(all)

        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
        }
        val search = EditText(this).apply {
            hint = getString(R.string.widget_config_search)
            setSingleLine()
        }
        val list = ListView(this)
        adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, shown.map { it.second }.toMutableList())
        list.adapter = adapter
        root.addView(
            search,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
        )
        root.addView(
            list,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT),
        )
        setContentView(root)

        search.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) { applyFilter(s?.toString().orEmpty()) }
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        })

        list.setOnItemClickListener { _, _, position, _ ->
            choose(shown[position].first)
        }

        // Read the snapshot off the main thread: it's a disk read (SharedPreferences)
        // plus a JSON parse, which shouldn't run on the UI thread in onCreate
        // (StrictMode flags it). The dialog shows the "automatic" option first, then
        // fills in the chores once loaded.
        MainScope().launch {
            val items = withContext(Dispatchers.IO) { readChores(this@SingleChoreConfigActivity) }
            all.clear()
            all.add(null to getString(R.string.widget_config_auto))
            for ((syncId, name) in items) all.add(syncId to name)
            applyFilter(search.text?.toString().orEmpty())
        }
    }

    private fun applyFilter(query: String) {
        val q = query.trim().lowercase()
        shown.clear()
        shown.add(all[0]) // keep the automatic option pinned at the top
        for (i in 1 until all.size) {
            if (q.isEmpty() || all[i].second.lowercase().contains(q)) shown.add(all[i])
        }
        adapter.clear()
        adapter.addAll(shown.map { it.second })
        adapter.notifyDataSetChanged()
    }

    private fun choose(syncId: String?) {
        MainScope().launch {
            val glanceId = GlanceAppWidgetManager(this@SingleChoreConfigActivity).getGlanceIdBy(appWidgetId)
            updateAppWidgetState(this@SingleChoreConfigActivity, glanceId) { prefs ->
                if (syncId == null) prefs.remove(CHORE_PREF_KEY) else prefs[CHORE_PREF_KEY] = syncId
            }
            SingleChoreWidget().update(this@SingleChoreConfigActivity, glanceId)
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
            finish()
        }
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
