package com.lastglance.app.glance

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.compose.ui.unit.dp
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
import androidx.compose.ui.unit.sp
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.text.FontStyle
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.lastglance.app.R
import com.lastglance.app.SharedDataStore
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

// GitHub-style contribution heatmap of completion activity, as a Glance widget.
// The grid is drawn as a Canvas bitmap (far cheaper than ~126 composed cells) and
// shown via Image; tapping opens the app to the Soon view through the deep-link
// router. Renders from the snapshot the web app pushes — no DB access.

private const val WEEKS = 26
private const val DAYS = 7

class HeatmapWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val bitmap = renderHeatmap(context)
        val (overdue, soon) = readCounts(context)
        provideContent {
            GlanceTheme {
                Column(
                    modifier = GlanceModifier
                        .fillMaxSize()
                        .background(GlanceTheme.colors.surface)
                        .cornerRadius(16.dp)
                        .padding(12.dp)
                        .clickable(actionStartActivity(openSoonIntent(context))),
                ) {
                    // The grid takes all the space above the footer and centers
                    // within it (no big void dumped at the bottom).
                    Image(
                        provider = ImageProvider(bitmap),
                        contentDescription = null,
                        modifier = GlanceModifier.defaultWeight().fillMaxWidth(),
                        contentScale = ContentScale.Fit,
                    )
                    // Footer: the lastGLANCE wordmark (last + italic green GLANCE,
                    // matching the app) and a live stat.
                    Row(
                        modifier = GlanceModifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "last",
                            style = TextStyle(
                                color = GlanceTheme.colors.onSurface,
                                fontWeight = FontWeight.Bold,
                                fontSize = 24.sp,
                            ),
                        )
                        Text(
                            "GLANCE",
                            style = TextStyle(
                                color = ColorProvider(androidx.compose.ui.graphics.Color(0xFF3DDC84)),
                                fontWeight = FontWeight.Bold,
                                fontStyle = FontStyle.Italic,
                                fontSize = 24.sp,
                            ),
                        )
                        Spacer(modifier = GlanceModifier.defaultWeight())
                        Text(
                            statText(context, overdue, soon),
                            style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 18.sp),
                        )
                    }
                }
            }
        }
    }
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

private fun statText(context: Context, overdue: Int, soon: Int): String = when {
    overdue > 0 && soon > 0 -> "$overdue overdue · $soon soon"
    overdue > 0 -> "$overdue overdue"
    soon > 0 -> "$soon soon"
    else -> context.getString(R.string.widget_all_caught_up)
}

class HeatmapWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = HeatmapWidget()
}

private fun isNight(context: Context): Boolean {
    val mode = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
    return mode == Configuration.UI_MODE_NIGHT_YES
}

private fun readHeatmap(context: Context): JSONObject? {
    val raw = SharedDataStore.readSnapshot(context) ?: return null
    return try {
        JSONObject(raw).optJSONObject("heatmap")
    } catch (e: Exception) {
        null
    }
}

private fun renderHeatmap(context: Context): Bitmap {
    val night = isNight(context)
    val density = context.resources.displayMetrics.density
    val cell = Math.round(11 * density)
    val gap = Math.round(3 * density)
    val pad = Math.round(2 * density)
    val width = pad * 2 + WEEKS * (cell + gap) - gap
    val height = pad * 2 + DAYS * (cell + gap) - gap

    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    val empty = if (night) Color.parseColor("#2d333b") else Color.parseColor("#ebedf0")
    val scale = intArrayOf(
        Color.parseColor("#9be9a8"),
        Color.parseColor("#40c463"),
        Color.parseColor("#30a14e"),
        Color.parseColor("#216e39"),
    )

    val heatmap = readHeatmap(context)
    val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    val cal = Calendar.getInstance()
    cal.set(Calendar.HOUR_OF_DAY, 0)
    cal.set(Calendar.MINUTE, 0)
    cal.set(Calendar.SECOND, 0)
    cal.set(Calendar.MILLISECOND, 0)
    // Back to this week's Sunday, then to the oldest visible week.
    cal.add(Calendar.DAY_OF_YEAR, -(cal.get(Calendar.DAY_OF_WEEK) - 1))
    cal.add(Calendar.DAY_OF_YEAR, -(WEEKS - 1) * 7)

    val radius = cell * 0.22f
    for (col in 0 until WEEKS) {
        for (row in 0 until DAYS) {
            val key = fmt.format(cal.time)
            val count = heatmap?.optInt(key, 0) ?: 0
            paint.color = when {
                count <= 0 -> empty
                count <= 1 -> scale[0]
                count <= 3 -> scale[1]
                count <= 5 -> scale[2]
                else -> scale[3]
            }
            val left = (pad + col * (cell + gap)).toFloat()
            val top = (pad + row * (cell + gap)).toFloat()
            canvas.drawRoundRect(left, top, left + cell, top + cell, radius, radius, paint)
            cal.add(Calendar.DAY_OF_YEAR, 1)
        }
    }
    return bitmap
}
