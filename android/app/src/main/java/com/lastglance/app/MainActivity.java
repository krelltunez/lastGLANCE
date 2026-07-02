package com.lastglance.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import com.lastglance.app.intents.IntentReceiver;
import com.lastglance.app.intents.IntentsBridgePlugin;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register app-local plugins before the bridge starts.
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(IntentsBridgePlugin.class);
        super.onCreate(savedInstanceState);
        captureWidgetDeepLink(getIntent());
        captureSharedText(getIntent());
        // Cold start via a Tasker Activity intent: the web app drains the slot on
        // mount, so just store it here (no wake needed — nothing is listening yet).
        captureTaskerIntent(getIntent(), false);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        captureWidgetDeepLink(intent);
        captureSharedText(intent);
        // Warm Activity intent (app already running): store it AND wake the WebView.
        captureTaskerIntent(intent, true);
    }

    // Capture an Activity-target Tasker intent (app.lastglance.*). The manifest
    // <receiver> handles the broadcast path (background/killed); this handles the
    // Activity path a sender uses to foreground/cold-start the app. Stores the
    // intent in the same {action, payload} shape IntentReceiver uses so the web
    // drain is uniform. When `wake` is true, poke a running WebView via the same
    // internal INTENT_RECEIVED signal the broadcast path uses.
    private void captureTaskerIntent(Intent intent, boolean wake) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null || !action.startsWith("app.lastglance.")) return;
        if (!action.equals("app.lastglance.CREATE")
            && !action.equals("app.lastglance.COMPLETE")
            && !action.equals("app.lastglance.OPEN")
            && !action.equals("app.lastglance.QUERY")) {
            return;
        }

        JSONObject payloadObj;
        try {
            String raw = intent.getStringExtra("payload");
            payloadObj = (raw != null) ? new JSONObject(raw) : new JSONObject();
        } catch (Exception e) {
            payloadObj = new JSONObject();
        }
        try {
            String pending = new JSONObject().put("action", action).put("payload", payloadObj).toString();
            SharedDataStore.writePendingIntent(this, pending);
        } catch (Exception e) {
            return;
        }

        if (wake) {
            Intent poke = new Intent(IntentReceiver.INTENT_RECEIVED);
            poke.setPackage(getPackageName());
            sendBroadcast(poke);
        }
    }

    // A share from another app (ACTION_SEND, text/plain) seeds a new chore. Prefer
    // the subject (often a page title) over the raw text/URL for the chore name;
    // the web app opens the new-chore form pre-filled on foreground.
    private void captureSharedText(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return;
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String name = (subject != null && !subject.trim().isEmpty()) ? subject : text;
        if (name != null && !name.trim().isEmpty()) {
            SharedDataStore.writePendingSharedChore(this, name.trim());
        }
    }

    // Widget body-taps and launcher shortcuts launch this activity with a
    // lastglance:// URI (and, for static shortcuts, an "lglink" extra fallback in
    // case the URI is dropped). Stash the target so the web app can route it on
    // foreground (see consumeDeepLink / routeWidgetDeepLink). The web app owns
    // navigation; we just hand off.
    private void captureWidgetDeepLink(Intent intent) {
        if (intent == null) return;
        String link = null;
        Uri data = intent.getData();
        if (data != null && "lastglance".equals(data.getScheme())) {
            link = linkFromUri(data);
        }
        if (link == null) {
            link = intent.getStringExtra("lglink"); // already in internal token form
        }
        if (link != null) SharedDataStore.writePendingDeepLink(this, link);
    }

    // Map a lastglance:// URI to the internal pending-deep-link token the web app
    // consumes. Returns null for anything unrecognized.
    private String linkFromUri(Uri data) {
        String host = data.getHost();
        if ("chore".equals(host)) {
            String syncId = data.getLastPathSegment();
            return syncId != null ? "chore:" + syncId : null;
        } else if ("filter".equals(host)) {
            return "filter:soon";
        } else if ("action".equals(host)) {
            String action = data.getLastPathSegment();
            if ("search".equals(action)) return "action:search";
            if ("add".equals(action)) return "action:add";
        }
        return null;
    }
}
