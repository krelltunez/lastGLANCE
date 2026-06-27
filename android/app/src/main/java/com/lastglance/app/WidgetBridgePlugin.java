package com.lastglance.app;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.lastglance.app.glance.SingleChoreWidgetReceiver;
import com.lastglance.app.glance.SoonListWidgetReceiver;

// Receives the denormalized snapshot from the web app and persists it for the
// home-screen widgets to render, and hands back completions logged from widgets.
// Registered in MainActivity.
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    @PluginMethod
    public void updateSnapshot(PluginCall call) {
        String json = call.getString("json");
        if (json == null) {
            call.reject("missing json");
            return;
        }
        Context context = getContext();
        SharedDataStore.writeSnapshot(context, json);
        HeatmapWidgetProvider.refreshAll(context);
        refreshGlanceWidget(context, SingleChoreWidgetReceiver.class);
        refreshGlanceWidget(context, SoonListWidgetReceiver.class);
        call.resolve();
    }

    // Hand the queued widget completions to the web app (which replays them into
    // the DB) and clear the queue.
    @PluginMethod
    public void drainPendingCompletions(PluginCall call) {
        String json = SharedDataStore.readAndClearPendingCompletions(getContext());
        JSObject ret = new JSObject();
        ret.put("completions", json);
        call.resolve(ret);
    }

    // Nudge a Glance widget to recompose from the freshly written snapshot.
    private static void refreshGlanceWidget(Context context, Class<?> receiver) {
        ComponentName component = new ComponentName(context, receiver);
        int[] ids = AppWidgetManager.getInstance(context).getAppWidgetIds(component);
        if (ids == null || ids.length == 0) return;
        Intent intent = new Intent(context, receiver);
        intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
        context.sendBroadcast(intent);
    }
}
