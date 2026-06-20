package com.lastglance.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.net.Uri;
import android.util.DisplayMetrics;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;

// GitHub-style contribution heatmap of completion activity. Renders a Canvas
// bitmap from the snapshot the web app pushed via WidgetBridge; no database
// access happens here. Tapping opens the app to the "Soon" view.
public class HeatmapWidgetProvider extends AppWidgetProvider {

    private static final int WEEKS = 18;
    private static final int DAYS = 7;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        RemoteViews views = buildViews(context);
        for (int id : appWidgetIds) {
            manager.updateAppWidget(id, views);
        }
    }

    // Re-render every placed instance. Called by WidgetBridgePlugin on each
    // snapshot push.
    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, HeatmapWidgetProvider.class);
        int[] ids = manager.getAppWidgetIds(component);
        if (ids == null || ids.length == 0) return;
        RemoteViews views = buildViews(context);
        for (int id : ids) {
            manager.updateAppWidget(id, views);
        }
    }

    private static RemoteViews buildViews(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_heatmap);
        views.setImageViewBitmap(R.id.widget_heatmap_image, renderHeatmap(context));

        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("lastglance://filter/soon"));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(context, 0, intent, flags);
        views.setOnClickPendingIntent(R.id.widget_heatmap_root, pending);
        return views;
    }

    private static boolean isNight(Context context) {
        int mode = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    private static Bitmap renderHeatmap(Context context) {
        boolean night = isNight(context);
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        float density = metrics.density;
        int cell = Math.round(11 * density);
        int gap = Math.round(3 * density);
        int pad = Math.round(2 * density);

        int width = pad * 2 + WEEKS * (cell + gap) - gap;
        int height = pad * 2 + DAYS * (cell + gap) - gap;

        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        int empty = night ? Color.parseColor("#2d333b") : Color.parseColor("#ebedf0");
        int[] scale = new int[] {
            Color.parseColor("#9be9a8"),
            Color.parseColor("#40c463"),
            Color.parseColor("#30a14e"),
            Color.parseColor("#216e39"),
        };

        JSONObject heatmap = readHeatmap(context);

        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        // Back up to this week's Sunday, then to the oldest visible week.
        cal.add(Calendar.DAY_OF_YEAR, -(cal.get(Calendar.DAY_OF_WEEK) - 1));
        cal.add(Calendar.DAY_OF_YEAR, -(WEEKS - 1) * 7);

        float radius = cell * 0.22f;
        for (int col = 0; col < WEEKS; col++) {
            for (int row = 0; row < DAYS; row++) {
                String key = fmt.format(cal.getTime());
                int count = heatmap != null ? heatmap.optInt(key, 0) : 0;
                int color;
                if (count <= 0) color = empty;
                else if (count <= 1) color = scale[0];
                else if (count <= 3) color = scale[1];
                else if (count <= 5) color = scale[2];
                else color = scale[3];
                paint.setColor(color);
                float left = pad + col * (cell + gap);
                float top = pad + row * (cell + gap);
                canvas.drawRoundRect(left, top, left + cell, top + cell, radius, radius, paint);
                cal.add(Calendar.DAY_OF_YEAR, 1);
            }
        }
        return bitmap;
    }

    private static JSONObject readHeatmap(Context context) {
        try {
            String json = SharedDataStore.readSnapshot(context);
            if (json == null) return null;
            return new JSONObject(json).optJSONObject("heatmap");
        } catch (Exception e) {
            return null;
        }
    }
}
