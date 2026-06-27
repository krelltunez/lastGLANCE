package com.lastglance.app.tiles

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.lastglance.app.R
import com.lastglance.app.SharedDataStore
import com.lastglance.app.glance.openAddIntent
import com.lastglance.app.glance.openSoonIntent
import org.json.JSONObject

// Quick Settings tiles. Both just launch the app through the shared lastglance://
// router — the same targets as the shortcuts and widgets — collapsing the shade.
// The Soon tile additionally shows a live "N overdue · N soon" subtitle read from
// the snapshot. No new routing: openAddIntent / openSoonIntent are reused.

private fun TileService.launchAndCollapse(intent: Intent) {
    if (Build.VERSION.SDK_INT >= 34) {
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, flags))
    } else {
        @Suppress("DEPRECATION")
        startActivityAndCollapse(intent)
    }
}

class AddChoreTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            state = Tile.STATE_INACTIVE
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        // If the device is locked, defer the launch until after unlock.
        if (isLocked) unlockAndRun { launchAndCollapse(openAddIntent(this)) }
        else launchAndCollapse(openAddIntent(this))
    }
}

class SoonTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        val (overdue, soon) = readCounts(this)
        // "Active" (highlighted) when something actually needs attention.
        tile.state = if (overdue > 0 || soon > 0) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        if (Build.VERSION.SDK_INT >= 29) {
            tile.subtitle = subtitle(this, overdue, soon)
        }
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        if (isLocked) unlockAndRun { launchAndCollapse(openSoonIntent(this)) }
        else launchAndCollapse(openSoonIntent(this))
    }
}

private fun subtitle(context: Context, overdue: Int, soon: Int): String = when {
    overdue > 0 && soon > 0 -> "$overdue overdue · $soon soon"
    overdue > 0 -> "$overdue overdue"
    soon > 0 -> "$soon soon"
    else -> context.getString(R.string.widget_all_caught_up)
}

private fun readCounts(context: Context): Pair<Int, Int> {
    val raw = SharedDataStore.readSnapshot(context) ?: return 0 to 0
    return try {
        val counts = JSONObject(raw).optJSONObject("counts") ?: return 0 to 0
        counts.optInt("overdue", 0) to counts.optInt("soon", 0)
    } catch (e: Exception) {
        0 to 0
    }
}
