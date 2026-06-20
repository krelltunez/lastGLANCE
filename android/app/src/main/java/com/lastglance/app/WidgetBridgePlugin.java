package com.lastglance.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Receives the denormalized snapshot from the web app and persists it for the
// home-screen widgets to render. Registered in MainActivity.
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    @PluginMethod
    public void updateSnapshot(PluginCall call) {
        String json = call.getString("json");
        if (json == null) {
            call.reject("missing json");
            return;
        }
        SharedDataStore.writeSnapshot(getContext(), json);
        HeatmapWidgetProvider.refreshAll(getContext());
        call.resolve();
    }
}
