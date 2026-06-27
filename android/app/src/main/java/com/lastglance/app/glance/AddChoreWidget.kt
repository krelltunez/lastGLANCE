package com.lastglance.app.glance

import android.content.Context
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.lastglance.app.R

// A small one-tap "Add chore" launcher: opens the app straight into the new-chore
// form (for the active category) via the shared lastglance://action/add deep link.
// No snapshot needed — it's a pure action surface, so nothing to refresh.
private val ADD_GREEN = Color(0xFF22C55E)

class AddChoreWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            GlanceTheme {
                Box(
                    modifier = GlanceModifier
                        .fillMaxSize()
                        .background(GlanceTheme.colors.surface)
                        .cornerRadius(16.dp)
                        .padding(horizontal = 12.dp, vertical = 8.dp)
                        .clickable(actionStartActivity(openAddIntent(context))),
                    contentAlignment = Alignment.Center,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Image(
                            provider = ImageProvider(R.drawable.ic_lucide_circle_plus),
                            contentDescription = null,
                            colorFilter = ColorFilter.tint(ColorProvider(ADD_GREEN)),
                            modifier = GlanceModifier.size(22.dp),
                        )
                        Spacer(modifier = GlanceModifier.width(8.dp))
                        Text(
                            context.getString(R.string.widget_add_chore),
                            style = TextStyle(
                                color = GlanceTheme.colors.onSurface,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp,
                            ),
                        )
                    }
                }
            }
        }
    }
}

class AddChoreWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = AddChoreWidget()
}
