package com.lastglance.app.intents;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.lastglance.app.SharedDataStore;

import org.json.JSONObject;

// The broadcast entry point for the Android/Tasker intents transport. Because it
// is declared in the manifest, Android instantiates it EVEN IF the app process
// is dead — so a Tasker CREATE/COMPLETE/OPEN/QUERY broadcast is captured whether
// the app is foregrounded, backgrounded, or killed.
//
// It stores the intent to a persistent slot (drained by the web app via the
// IntentsBridge plugin on next run) and, if a MainActivity is alive, wakes it
// with an internal package-scoped broadcast so the WebView drains immediately.
//
// See docs/tasker-intents-architecture.md §4.2.
public class IntentReceiver extends BroadcastReceiver {

    // Internal, package-scoped signal that a new intent has landed. MainActivity
    // registers a runtime receiver for this to poke the WebView while running.
    public static final String INTENT_RECEIVED = "com.lastglance.app.INTENT_RECEIVED";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        // User opt-in gate (off by default): this receiver is exported to every
        // installed app, so while the toggle is off, drop the intent without
        // storing or waking anything.
        if (!SharedDataStore.isAutomationIntentsEnabled(context)) return;

        // Re-serialize the payload through JSONObject rather than trusting the raw
        // extra: a crafted `payload` string can't inject structure this way.
        JSONObject payloadObj;
        try {
            String raw = intent.getStringExtra("payload");
            payloadObj = (raw != null) ? new JSONObject(raw) : new JSONObject();
        } catch (Exception e) {
            payloadObj = new JSONObject();
        }

        try {
            String pending = new JSONObject()
                .put("action", action)
                .put("payload", payloadObj)
                .toString();
            SharedDataStore.writePendingIntent(context, pending);
        } catch (Exception e) {
            return;
        }

        // Wake a running MainActivity (no-op if the app is killed — the slot is
        // drained on next launch). Package-scoped so no other app receives it.
        Intent wake = new Intent(INTENT_RECEIVED);
        wake.setPackage(context.getPackageName());
        context.sendBroadcast(wake);
    }
}
