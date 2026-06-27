package com.lastglance.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register app-local plugins before the bridge starts.
        registerPlugin(WidgetBridgePlugin.class);
        super.onCreate(savedInstanceState);
        captureWidgetDeepLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        captureWidgetDeepLink(intent);
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
