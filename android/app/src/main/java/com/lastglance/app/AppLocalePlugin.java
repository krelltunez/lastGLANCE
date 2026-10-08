package com.lastglance.app;

import android.app.LocaleManager;
import android.content.Context;
import android.os.Build;
import android.os.LocaleList;

import androidx.annotation.ChecksSdkIntAtLeast;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Keeps the in-app language and Android's per-app language (Android 13+,
// Settings > Apps > lastGLANCE > Language) the same choice (issue #327).
//
// The web UI picks its language itself, but everything native (widget text, the
// widget picker, launcher shortcuts, quick-settings tiles) is resolved by Android
// from the app's locale. Without this, picking Polish in the app left all of
// those following the phone's language instead.
//
// Below Android 13 there is no per-app locale the system honours outside an
// activity, so every method reports unsupported and changes nothing: the native
// surfaces keep following the system language, as before.
//
// Registered in MainActivity, which also reports changes made from system
// Settings (see MainActivity.onConfigurationChanged).
@CapacitorPlugin(name = "AppLocale")
public class AppLocalePlugin extends Plugin {

    @ChecksSdkIntAtLeast(api = Build.VERSION_CODES.TIRAMISU)
    static boolean isSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU;
    }

    // The app's own language as a BCP-47 tag, or null when it follows the system.
    static String currentTag(Context context) {
        if (!isSupported()) return null;
        LocaleList list = context.getSystemService(LocaleManager.class).getApplicationLocales();
        return list.isEmpty() ? null : list.get(0).toLanguageTag();
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", isSupported());
        ret.put("tag", currentTag(getContext()));
        call.resolve(ret);
    }

    // Setting the locale is a configuration change, which MainActivity handles in
    // place (configChanges includes locale), so the WebView is not reloaded. The
    // widgets and shortcuts re-render from MainActivity once the new locale is
    // in effect.
    @PluginMethod
    public void set(PluginCall call) {
        if (isSupported()) {
            String tag = call.getString("tag");
            LocaleList list = (tag == null || tag.isEmpty())
                ? LocaleList.getEmptyLocaleList()
                : LocaleList.forLanguageTags(tag);
            getContext().getSystemService(LocaleManager.class).setApplicationLocales(list);
        }
        call.resolve();
    }

    // Tell the web UI the app language changed outside it (system Settings).
    void notifyChanged(String tag) {
        JSObject data = new JSObject();
        data.put("tag", tag);
        notifyListeners("changed", data);
    }
}
