package com.lastglance.app;

import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

import com.glanceapps.billing.BillingBridgePlugin;

import com.lastglance.app.intents.IntentReceiver;
import com.lastglance.app.intents.IntentsBridgePlugin;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    // The app language last seen, so a configuration change that is not a
    // language change (rotation, dark mode) does not rebuild every widget.
    private String lastLocaleTag;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register app-local plugins before the bridge starts.
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(IntentsBridgePlugin.class);
        registerPlugin(BillingBridgePlugin.class);
        registerPlugin(WebDavHttpPlugin.class);
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(com.lastglance.app.sse.VaultSsePlugin.class);
        registerPlugin(AppLocalePlugin.class);
        registerPlugin(com.lastglance.app.directaccess.DirectAccessPlugin.class);
        super.onCreate(savedInstanceState);
        lastLocaleTag = getResources().getConfiguration().getLocales().get(0).toLanguageTag();
        // Cold start via a widget tap, a share, or a Tasker Activity intent: the
        // web app drains the slots on mount, so just store them here (no wake
        // needed — nothing is listening yet). A non-null savedInstanceState means
        // the system is rebuilding an activity it killed and is replaying the
        // intent that rooted the task, not delivering a new one.
        captureLaunchIntent(getIntent(), savedInstanceState != null, false);
    }

    // configChanges includes locale, so a language change lands here instead of
    // recreating the activity and reloading the WebView. That covers both ways
    // the app language changes on Android 13+: the in-app picker (through
    // AppLocalePlugin.set) and Settings > Apps > lastGLANCE > Language. Either
    // way the widgets and shortcuts are rebuilt in the new language, and the web
    // UI is told, so a choice made in Settings shows up without a restart.
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        String tag = newConfig.getLocales().get(0).toLanguageTag();
        if (tag.equals(lastLocaleTag)) return;
        lastLocaleTag = tag;
        WidgetBridgePlugin.refreshAll(this);
        // Only an explicit app language is passed on. A null tag means the app
        // follows the system (or this is Android 12 or older, where a system
        // language change lands here too); the web UI's own choice stands then.
        String appTag = AppLocalePlugin.currentTag(this);
        if (appTag == null || getBridge() == null) return;
        PluginHandle handle = getBridge().getPlugin("AppLocale");
        if (handle != null && handle.getInstance() instanceof AppLocalePlugin) {
            ((AppLocalePlugin) handle.getInstance()).notifyChanged(appTag);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Warm Activity intent (app already running): store it AND wake the
        // WebView. Never a restore, but a resume from recents can still redeliver
        // the task's root intent here, which LaunchIntentGuard filters out.
        captureLaunchIntent(intent, false, true);
    }

    // Single entry point for every inbound Activity intent, so the sticky-intent
    // guard cannot be bypassed by one capture path forgetting to ask. See
    // LaunchIntentGuard for why reading an intent is not consuming it.
    private void captureLaunchIntent(Intent intent, boolean isRestoredInstance, boolean wake) {
        if (intent == null) return;
        if (!LaunchIntentGuard.shouldCapture(intent.getFlags(), isRestoredInstance)) return;
        captureWidgetDeepLink(intent);
        captureSharedText(intent);
        captureTaskerIntent(intent, wake);
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

        // User opt-in gate (off by default), mirroring IntentReceiver: while the
        // automation-intents toggle is off, an Activity-target intent may still
        // launch the app (that can't be prevented) but its payload is dropped.
        if (!SharedDataStore.isAutomationIntentsEnabled(this)) return;

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
