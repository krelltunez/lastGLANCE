package com.lastglance.app.glance

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.lastglance.app.R

// Phase 2: the "Soon" list widget — the chores aged into the amber/red zone,
// most-overdue first, each with one-tap Done. Shares the snapshot read, the
// completion callback, and the row styling with the single-chore tile.
private const val MAX_ROWS = 25

class SoonListWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val rows = ChoreSnapshot.pickSoonList(context, MAX_ROWS)
        provideContent {
            GlanceTheme {
                Content(context, rows)
            }
        }
    }

    @Composable
    private fun Content(context: Context, rows: List<ChoreData>) {
        Column(
            modifier = GlanceModifier
                .fillMaxSize()
                .background(GlanceTheme.colors.surface)
                .cornerRadius(16.dp)
                .padding(12.dp),
        ) {
            Text(
                context.getString(R.string.soon_list_widget_title),
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                ),
                modifier = GlanceModifier.padding(bottom = 8.dp),
            )
            if (rows.isEmpty()) {
                Text(
                    context.getString(R.string.widget_all_caught_up),
                    style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp),
                )
            } else {
                LazyColumn {
                    items(rows) { chore -> ChoreListRow(context, chore) }
                }
            }
        }
    }

    @Composable
    private fun ChoreListRow(context: Context, chore: ChoreData) {
        Row(
            modifier = GlanceModifier
                .fillMaxWidth()
                .padding(vertical = 5.dp)
                .clickable(actionStartActivity(openChoreIntent(context, chore.syncId))),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // The icon is tinted to the recency color, so it carries the color cue
            // — no separate bar, to leave room for the name at narrow (2-cell) widths.
            if (chore.iconResId != 0) {
                Image(
                    provider = ImageProvider(chore.iconResId),
                    contentDescription = null,
                    colorFilter = ColorFilter.tint(ColorProvider(Color(chore.colorInt))),
                    modifier = GlanceModifier.size(18.dp),
                )
                Spacer(modifier = GlanceModifier.width(8.dp))
            }
            Column(modifier = GlanceModifier.defaultWeight()) {
                Text(
                    chore.name,
                    maxLines = 1,
                    style = TextStyle(
                        color = GlanceTheme.colors.onSurface,
                        fontWeight = FontWeight.Medium,
                        fontSize = 14.sp,
                    ),
                )
                Text(
                    chore.elapsed,
                    maxLines = 1,
                    style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp),
                )
            }
            Spacer(modifier = GlanceModifier.width(6.dp))
            // Compact check button (instead of a wide "Done" label) so names fit.
            Box(
                modifier = GlanceModifier
                    .size(34.dp)
                    .cornerRadius(10.dp)
                    .background(ColorProvider(Color(0xFF22C55E)))
                    .clickable(
                        actionRunCallback<CompleteChoreCallback>(
                            actionParametersOf(SYNC_ID_KEY to chore.syncId),
                        ),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    provider = ImageProvider(R.drawable.ic_lucide_check),
                    contentDescription = context.getString(R.string.widget_done),
                    colorFilter = ColorFilter.tint(ColorProvider(Color.White)),
                    modifier = GlanceModifier.size(18.dp),
                )
            }
        }
    }
}

class SoonListWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = SoonListWidget()
}
