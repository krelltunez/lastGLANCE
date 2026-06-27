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

    // Widget body-taps launch this activity with a lastglance:// URI. Stash the
    // target so the web app can route it on foreground (see consumeDeepLink /
    // routeWidgetDeepLink). The web app owns navigation; we just hand off.
    private void captureWidgetDeepLink(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null || !"lastglance".equals(data.getScheme())) return;
        String host = data.getHost();
        if ("chore".equals(host)) {
            String syncId = data.getLastPathSegment();
            if (syncId != null) SharedDataStore.writePendingDeepLink(this, "chore:" + syncId);
        } else if ("filter".equals(host)) {
            SharedDataStore.writePendingDeepLink(this, "filter:soon");
        }
    }
}
