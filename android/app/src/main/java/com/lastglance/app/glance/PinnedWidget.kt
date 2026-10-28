package com.lastglance.app.glance

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Column
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.lastglance.app.R

// The Pinned list widget: the chores pinned in the app, in the app's Pinned
// order (most overdue first), each with one-tap Done. Built like
// SoonListWidget, with the category ahead of the elapsed text as in the app's
// Pinned row, since pins come from every category.
private const val MAX_ROWS = 25

class PinnedWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val rows = ChoreSnapshot.pickPinnedList(context, MAX_ROWS)
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
                context.getString(R.string.pinned_widget_title),
                style = TextStyle(
                    color = GlanceTheme.colors.onSurfaceVariant,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                ),
                modifier = GlanceModifier.padding(bottom = 8.dp),
            )
            if (rows.isEmpty()) {
                Text(
                    context.getString(R.string.widget_no_pinned),
                    style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp),
                )
            } else {
                LazyColumn {
                    items(rows) { chore ->
                        val subtitle = listOfNotNull(chore.categoryName, chore.elapsed).joinToString(" · ")
                        ChoreListRow(context, chore, subtitle)
                    }
                }
            }
        }
    }
}

class PinnedWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PinnedWidget()
}
