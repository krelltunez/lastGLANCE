package com.lastglance.app.intents;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.lastglance.app.SharedDataStore;

// The JS-callable surface of the Android/Tasker intents transport, the Capacitor
// equivalent of dayGLANCE's @JavascriptInterface NativeBridge
// (see docs/tasker-intents-architecture.md §4.4 / §8.1).
//
//   getPendingIntent()   read + clear the single pending-intent slot
//   reportIntentResult() emit app.lastglance.RESULT (the handled outcome / QUERY reply)
//   sendNotifyBroadcast()emit app.lastglance.NOTIFY (a chore changed state)
//
// It also owns the "wake the WebView" path: a runtime receiver for the internal
// INTENT_RECEIVED signal, registered for the plugin's whole lifetime
// (load → handleOnDestroy) so background delivery works — registering on
// resume/pause would go deaf exactly when Tasker fires at a backgrounded app.
// On receive it fires the `pendingIntent` event; the web bridge drains in response.
@CapacitorPlugin(name = "IntentsBridge")
public class IntentsBridgePlugin extends Plugin {

    private static final String ACTION_RESULT = "app.lastglance.RESULT";
    private static final String ACTION_NOTIFY = "app.lastglance.NOTIFY";

    private final BroadcastReceiver intentReceivedReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            notifyListeners("pendingIntent", new JSObject());
        }
    };

    @Override
    public void load() {
        ContextCompat.registerReceiver(
            getContext(),
            intentReceivedReceiver,
            new IntentFilter(IntentReceiver.INTENT_RECEIVED),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    protected void handleOnDestroy() {
        try {
            getContext().unregisterReceiver(intentReceivedReceiver);
        } catch (IllegalArgumentException e) {
            // Not registered (e.g. load() never ran) — nothing to do.
        }
    }

    @PluginMethod
    public void getPendingIntent(PluginCall call) {
        String json = SharedDataStore.readAndClearPendingIntent(getContext());
        JSObject ret = new JSObject();
        ret.put("value", json != null ? json : "");
        call.resolve(ret);
    }

    @PluginMethod
    public void reportIntentResult(PluginCall call) {
        String action = call.getString("action");
        String result = call.getString("result");
        Intent intent = new Intent(ACTION_RESULT);
        intent.putExtra("action", action);
        intent.putExtra("result", result);
        getContext().sendBroadcast(intent);
        call.resolve();
    }

    @PluginMethod
    public void sendNotifyBroadcast(PluginCall call) {
        String payload = call.getString("payload");
        Intent intent = new Intent(ACTION_NOTIFY);
        intent.putExtra("payload", payload);
        getContext().sendBroadcast(intent);
        call.resolve();
    }
}
