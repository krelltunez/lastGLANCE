package com.lastglance.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

// Single SharedPreferences store shared between the Capacitor bridge (writer)
// and the home-screen widgets (readers). Kept tiny on purpose: the web app is
// the source of truth, this is just the hand-off surface.
public final class SharedDataStore {

    private static final String PREFS = "lastglance_shared";
    private static final String KEY_SNAPSHOT = "snapshot";
    // Completions logged from a widget tap, awaiting drain into the DB by the
    // web app on next foreground (a widget can't write IndexedDB itself).
    private static final String KEY_PENDING = "pending_completions";
    // A widget body-tap target ("chore:<syncId>" or "filter:soon") captured by
    // MainActivity, consumed by the web app on foreground.
    private static final String KEY_DEEPLINK = "pending_deeplink";

    private SharedDataStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void writeSnapshot(Context context, String json) {
        prefs(context).edit().putString(KEY_SNAPSHOT, json).apply();
    }

    public static String readSnapshot(Context context) {
        return prefs(context).getString(KEY_SNAPSHOT, null);
    }

    // Append a completion to the durable queue. The web app mints nothing here;
    // the caller supplies the sync_id so the later DB replay is idempotent.
    public static void appendPendingCompletion(Context context, String choreSyncId, String syncId, String completedAt) {
        try {
            JSONArray arr = new JSONArray(prefs(context).getString(KEY_PENDING, "[]"));
            JSONObject o = new JSONObject();
            o.put("choreSyncId", choreSyncId);
            o.put("syncId", syncId);
            o.put("completedAt", completedAt);
            arr.put(o);
            prefs(context).edit().putString(KEY_PENDING, arr.toString()).apply();
        } catch (Exception e) {
            // Best-effort; a dropped queue entry just means that tap isn't
            // persisted to the DB (the optimistic snapshot still updated).
        }
    }

    // Return the queued completions as a JSON array string and clear the queue.
    public static String readAndClearPendingCompletions(Context context) {
        String raw = prefs(context).getString(KEY_PENDING, "[]");
        prefs(context).edit().remove(KEY_PENDING).apply();
        return raw;
    }

    public static void writePendingDeepLink(Context context, String value) {
        prefs(context).edit().putString(KEY_DEEPLINK, value).apply();
    }

    public static String readAndClearPendingDeepLink(Context context) {
        String value = prefs(context).getString(KEY_DEEPLINK, null);
        if (value != null) prefs(context).edit().remove(KEY_DEEPLINK).apply();
        return value;
    }
}
