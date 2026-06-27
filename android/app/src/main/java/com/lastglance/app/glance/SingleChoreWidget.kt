package com.lastglance.app.glance

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionStartActivity
import androidx.datastore.preferences.core.Preferences
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.currentState
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.GlanceTheme
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.lastglance.app.MainActivity
import com.lastglance.app.R
import com.lastglance.app.SharedDataStore
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

// Phase 2: an interactive Glance widget showing the chore most in need of
// attention, with one-tap "Done". The widget renders from the SharedPreferences
// snapshot the web app pushes (never the DB). A tap optimistically updates that
// snapshot and queues the completion for the app to replay into the DB on next
// foreground (see SharedDataStore + drainWidgetCompletions on the web side).

internal val SYNC_ID_KEY = ActionParameters.Key<String>("choreSyncId")

// Explicit intents that launch the app to a specific chore / the Soon view. The
// unique data URI also keeps each widget element's PendingIntent distinct
// (filterEquals ignores extras), so rows don't collide onto one target.
internal fun openChoreIntent(context: Context, syncId: String): Intent =
    Intent(context, MainActivity::class.java)
        .setAction(Intent.ACTION_VIEW)
        .setData(Uri.parse("lastglance://chore/$syncId"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

internal fun openSoonIntent(context: Context): Intent =
    Intent(context, MainActivity::class.java)
        .setAction(Intent.ACTION_VIEW)
        .setData(Uri.parse("lastglance://filter/soon"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

// Opens the app straight into the new-chore form (Add-chore widget / shortcut).
internal fun openAddIntent(context: Context): Intent =
    Intent(context, MainActivity::class.java)
        .setAction(Intent.ACTION_VIEW)
        .setData(Uri.parse("lastglance://action/add"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

internal data class ChoreData(
    val syncId: String,
    val name: String,
    val elapsed: String,
    val colorInt: Int,
    val iconResId: Int, // ic_lucide_* drawable, or 0 when the chore has no icon
)

internal object ChoreSnapshot {
    // The chore with the highest elapsed/target ratio (most overdue, or closest
    // to due). Null when nothing has a cadence + a completion yet.
    fun pickMostOverdue(context: Context): ChoreData? {
        val raw = SharedDataStore.readSnapshot(context) ?: return null
        return try {
            val chores = JSONObject(raw).optJSONArray("chores") ?: return null
            var best: JSONObject? = null
            var bestRatio = -1.0
            for (i in 0 until chores.length()) {
                val ch = chores.getJSONObject(i)
                if (ch.isNull("ratio")) continue
                val r = ch.optDouble("ratio", -1.0)
                if (r > bestRatio) {
                    bestRatio = r
                    best = ch
                }
            }
            best?.let { toChoreData(context, it) }
        } catch (e: Exception) {
            null
        }
    }

    // The specific chore chosen for a configured single-chore tile. Null if it's
    // gone from the snapshot (e.g. deleted) — the widget then shows empty.
    fun pickBySyncId(context: Context, syncId: String): ChoreData? {
        val raw = SharedDataStore.readSnapshot(context) ?: return null
        return try {
            val chores = JSONObject(raw).optJSONArray("chores") ?: return null
            for (i in 0 until chores.length()) {
                val ch = chores.getJSONObject(i)
                if (ch.optString("syncId") == syncId) return toChoreData(context, ch)
            }
            null
        } catch (e: Exception) {
            null
        }
    }

    private fun toChoreData(context: Context, ch: JSONObject): ChoreData {
        // Like ChoreRow: recency color when there's a cadence + completion, else a
        // neutral slate (chores chosen for a tile may have no cadence yet).
        val color = if (ch.isNull("color")) "#94a3b8" else ch.optString("color", "#94a3b8")
        return ChoreData(
            syncId = ch.optString("syncId"),
            name = ch.optString("name"),
            elapsed = elapsedLabel(ch),
            colorInt = parseColor(color),
            iconResId = resolveIcon(context, ch.optString("icon", null)),
        )
    }

    // Chores aged into the amber/red zone (state soon or overdue), most-overdue
    // first, capped at `limit`. Powers the Soon list widget.
    fun pickSoonList(context: Context, limit: Int): List<ChoreData> {
        val raw = SharedDataStore.readSnapshot(context) ?: return emptyList()
        return try {
            val chores = JSONObject(raw).optJSONArray("chores") ?: return emptyList()
            val rows = ArrayList<Pair<Double, ChoreData>>()
            for (i in 0 until chores.length()) {
                val ch = chores.getJSONObject(i)
                val state = ch.optString("state")
                if (state != "soon" && state != "overdue") continue
                val ratio = if (ch.isNull("ratio")) 0.0 else ch.optDouble("ratio", 0.0)
                rows.add(ratio to toChoreData(context, ch))
            }
            rows.sortByDescending { it.first }
            rows.take(limit).map { it.second }
        } catch (e: Exception) {
            emptyList()
        }
    }

    // chore.icon is the Lucide PascalCase name (e.g. "AlarmClock"); resolve it to
    // ic_lucide_alarm_clock using the SAME transform the generator used, so the
    // names always line up. 0 when the chore has no icon or it's missing.
    private fun resolveIcon(context: Context, pascal: String?): Int {
        if (pascal.isNullOrEmpty()) return 0
        return context.resources.getIdentifier(lucideResName(pascal), "drawable", context.packageName)
    }

    private fun lucideResName(pascal: String): String {
        val sb = StringBuilder("ic_lucide_")
        for (i in pascal.indices) {
            val ch = pascal[i]
            if (ch in 'A'..'Z' && i > 0) sb.append('_')
            sb.append(ch.lowercaseChar())
        }
        return sb.toString()
    }

    private fun elapsedLabel(chore: JSONObject): String {
        if (chore.isNull("elapsedDays")) return "never"
        val d = chore.optDouble("elapsedDays", 0.0)
        if (d < 1) return "today"
        val days = Math.round(d)
        return "${days}d ago"
    }

    private fun parseColor(hex: String): Int {
        return try {
            android.graphics.Color.parseColor(hex)
        } catch (e: Exception) {
            android.graphics.Color.parseColor("#22c55e")
        }
    }
}

object CompletionStore {
    // Record a widget completion: queue it (idempotent sync_id minted here) and
    // optimistically fold it into the snapshot so the widget reflects it
    // instantly, before the app ever runs.
    fun complete(context: Context, choreSyncId: String) {
        val syncId = UUID.randomUUID().toString()
        val completedAt = isoNowUtc()
        SharedDataStore.appendPendingCompletion(context, choreSyncId, syncId, completedAt)

        val raw = SharedDataStore.readSnapshot(context) ?: return
        try {
            val root = JSONObject(raw)
            val chores = root.optJSONArray("chores")
            if (chores != null) {
                for (i in 0 until chores.length()) {
                    val ch = chores.getJSONObject(i)
                    if (ch.optString("syncId") == choreSyncId) {
                        ch.put("lastCompletedAt", completedAt)
                        ch.put("elapsedDays", 0)
                        ch.put("ratio", 0)
                        ch.put("color", "#22c55e")
                        ch.put("state", "fresh")
                        break
                    }
                }
                var overdue = 0
                var soon = 0
                for (i in 0 until chores.length()) {
                    when (chores.getJSONObject(i).optString("state")) {
                        "overdue" -> overdue++
                        "soon" -> soon++
                    }
                }
                val counts = root.optJSONObject("counts") ?: JSONObject()
                counts.put("overdue", overdue)
                counts.put("soon", soon)
                root.put("counts", counts)
            }
            val heatmap = root.optJSONObject("heatmap") ?: JSONObject()
            val today = localDay()
            heatmap.put(today, heatmap.optInt(today, 0) + 1)
            root.put("heatmap", heatmap)

            SharedDataStore.writeSnapshot(context, root.toString())
        } catch (e: Exception) {
            // Best-effort; the completion is already queued for the DB replay.
        }
    }

    private fun isoNowUtc(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }

    // Local-day key, matching the web snapshot's dayjs().format('YYYY-MM-DD').
    private fun localDay(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
}

class CompleteChoreCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val syncId = parameters[SYNC_ID_KEY] ?: return
        CompletionStore.complete(context, syncId)
        // Refresh every widget kind so the tile and the list both reflect it.
        SingleChoreWidget().updateAll(context)
        SoonListWidget().updateAll(context)
    }
}

class SingleChoreWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            // A per-widget configured chore (set in SingleChoreConfigActivity, stored
            // in this widget's Glance state) wins; else fall back to most-overdue.
            val configured = currentState<Preferences>()[CHORE_PREF_KEY]
            val chore = if (configured != null) ChoreSnapshot.pickBySyncId(context, configured)
                else ChoreSnapshot.pickMostOverdue(context)
            GlanceTheme {
                Content(context, chore)
            }
        }
    }

    @Composable
    private fun Content(context: Context, chore: ChoreData?) {
        Row(
            modifier = GlanceModifier
                .fillMaxSize()
                .background(GlanceTheme.colors.surface)
                .cornerRadius(16.dp)
                .padding(12.dp)
                .clickable(
                    actionStartActivity(
                        if (chore != null) openChoreIntent(context, chore.syncId)
                        else openSoonIntent(context),
                    ),
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (chore == null) {
                Column(modifier = GlanceModifier.defaultWeight()) {
                    Text(
                        context.getString(R.string.app_name),
                        style = TextStyle(
                            color = GlanceTheme.colors.onSurface,
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp,
                        ),
                    )
                    Text(
                        context.getString(R.string.widget_all_caught_up),
                        style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp),
                    )
                }
            } else {
                // Recency color bar (always), then the chore's icon next to it,
                // tinted to the same recency color like ChoreRow.
                Spacer(
                    modifier = GlanceModifier
                        .width(6.dp)
                        .height(36.dp)
                        .cornerRadius(3.dp)
                        .background(ColorProvider(Color(chore.colorInt))),
                )
                Spacer(modifier = GlanceModifier.width(10.dp))
                if (chore.iconResId != 0) {
                    Image(
                        provider = ImageProvider(chore.iconResId),
                        contentDescription = null,
                        colorFilter = ColorFilter.tint(ColorProvider(Color(chore.colorInt))),
                        modifier = GlanceModifier.size(22.dp),
                    )
                    Spacer(modifier = GlanceModifier.width(10.dp))
                }
                Column(modifier = GlanceModifier.defaultWeight()) {
                    Text(
                        chore.name,
                        maxLines = 1,
                        style = TextStyle(
                            color = GlanceTheme.colors.onSurface,
                            fontWeight = FontWeight.Bold,
                            fontSize = 15.sp,
                        ),
                    )
                    Text(
                        chore.elapsed,
                        style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp),
                    )
                }
                Spacer(modifier = GlanceModifier.width(8.dp))
                Text(
                    context.getString(R.string.widget_done),
                    style = TextStyle(
                        color = ColorProvider(Color.White),
                        fontWeight = FontWeight.Medium,
                        fontSize = 13.sp,
                    ),
                    modifier = GlanceModifier
                        .background(ColorProvider(Color(0xFF22C55E)))
                        .cornerRadius(8.dp)
                        .padding(horizontal = 12.dp, vertical = 6.dp)
                        .clickable(
                            actionRunCallback<CompleteChoreCallback>(
                                actionParametersOf(SYNC_ID_KEY to chore.syncId),
                            ),
                        ),
                )
            }
        }
    }
}

class SingleChoreWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = SingleChoreWidget()
}
