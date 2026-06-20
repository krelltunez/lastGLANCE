package com.lastglance.app;

import android.content.Context;
import android.content.SharedPreferences;

// Single SharedPreferences store shared between the Capacitor bridge (writer)
// and the home-screen widgets (readers). Kept tiny on purpose: the web app is
// the source of truth, this is just the hand-off surface.
public final class SharedDataStore {

    private static final String PREFS = "lastglance_shared";
    private static final String KEY_SNAPSHOT = "snapshot";

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
}
