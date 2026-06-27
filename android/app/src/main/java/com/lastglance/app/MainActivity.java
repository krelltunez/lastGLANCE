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
        captureSharedText(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        captureWidgetDeepLink(intent);
        captureSharedText(intent);
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
