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

import com.lastglance.app.glance.HeatmapWidgetReceiver;
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
        refreshGlanceWidget(context, HeatmapWidgetReceiver.class);
        refreshGlanceWidget(context, SingleChoreWidgetReceiver.class);
        refreshGlanceWidget(context, SoonListWidgetReceiver.class);
        // The Add-chore widget is a static action surface — no snapshot refresh
        // needed. Dynamic "top overdue" launcher shortcuts do track the snapshot.
        WidgetShortcuts.refresh(context, json);
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

    // Hand the pending widget body-tap target to the web app, and clear it.
    @PluginMethod
    public void consumeDeepLink(PluginCall call) {
        String value = SharedDataStore.readAndClearPendingDeepLink(getContext());
        JSObject ret = new JSObject();
        ret.put("deepLink", value);
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
