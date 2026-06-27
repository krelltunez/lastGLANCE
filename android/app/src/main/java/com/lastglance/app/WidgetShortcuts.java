package com.lastglance.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.net.Uri;

import androidx.appcompat.content.res.AppCompatResources;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.DrawableCompat;
import androidx.core.graphics.drawable.IconCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

// Pushes "top overdue chores" as dynamic launcher shortcuts from the same
// snapshot the widgets read. Each shortcut deep-links to that chore's log modal
// via lastglance://chore/<syncId>, mirroring a widget tap. Refreshed whenever the
// web app updates the snapshot. The "Me" filter is respected for free — the
// snapshot is already filtered upstream (see src/native/snapshot.ts).
final class WidgetShortcuts {
    private static final int MAX = 3;

    static void refresh(Context context, String json) {
        try {
            List<ShortcutInfoCompat> shortcuts = build(context, json);
            // Replace the whole dynamic set so stale chores drop off.
            ShortcutManagerCompat.removeAllDynamicShortcuts(context);
            if (!shortcuts.isEmpty()) {
                ShortcutManagerCompat.addDynamicShortcuts(context, shortcuts);
            }
        } catch (Exception ignored) {
            // Best-effort; shortcuts are a convenience, never critical.
        }
    }

    private static List<ShortcutInfoCompat> build(Context context, String json) throws Exception {
        List<ShortcutInfoCompat> out = new ArrayList<>();
        JSONArray chores = new JSONObject(json).optJSONArray("chores");
        if (chores == null) return out;

        // Soon/overdue chores, most-overdue (highest ratio) first.
        List<JSONObject> ranked = new ArrayList<>();
        for (int i = 0; i < chores.length(); i++) {
            JSONObject ch = chores.getJSONObject(i);
            String state = ch.optString("state");
            if ("soon".equals(state) || "overdue".equals(state)) ranked.add(ch);
        }
        Collections.sort(ranked, new Comparator<JSONObject>() {
            @Override public int compare(JSONObject a, JSONObject b) {
                return Double.compare(b.optDouble("ratio", 0), a.optDouble("ratio", 0));
            }
        });

        int rank = 0;
        for (JSONObject ch : ranked) {
            if (rank >= MAX) break;
            String syncId = ch.optString("syncId");
            String name = ch.optString("name");
            if (syncId.isEmpty() || name.isEmpty()) continue;
            Intent intent = new Intent(context, MainActivity.class)
                    .setAction(Intent.ACTION_VIEW)
                    .setData(Uri.parse("lastglance://chore/" + syncId));
            ShortcutInfoCompat.Builder b = new ShortcutInfoCompat.Builder(context, "chore_" + syncId)
                    .setShortLabel(name)
                    .setLongLabel(name)
                    .setRank(rank)
                    .setIntent(intent);
            IconCompat icon = choreIcon(context, ch);
            if (icon != null) b.setIcon(icon);
            out.add(b.build());
            rank++;
        }
        return out;
    }

    // The chore's Lucide icon, tinted to its recency color (like the widgets),
    // rendered to a bitmap so the launcher shows the color. Null → launcher uses
    // the app's default badge.
    private static IconCompat choreIcon(Context context, JSONObject ch) {
        try {
            String pascal = ch.optString("icon", null);
            if (pascal == null || pascal.isEmpty()) return null;
            int resId = context.getResources().getIdentifier(
                    lucideResName(pascal), "drawable", context.getPackageName());
            if (resId == 0) return null;
            Drawable d = AppCompatResources.getDrawable(context, resId);
            if (d == null) return null;
            d = DrawableCompat.wrap(d.mutate());
            String hex = ch.isNull("color") ? "#94a3b8" : ch.optString("color", "#94a3b8");
            DrawableCompat.setTint(d, parseColor(hex));
            int size = Math.round(48 * context.getResources().getDisplayMetrics().density);
            int pad = Math.round(size * 0.18f);
            Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bmp);
            d.setBounds(pad, pad, size - pad, size - pad);
            d.draw(canvas);
            return IconCompat.createWithBitmap(bmp);
        } catch (Exception e) {
            return null;
        }
    }

    // PascalCase Lucide name → ic_lucide_snake_case, identical to the widget side.
    private static String lucideResName(String pascal) {
        StringBuilder sb = new StringBuilder("ic_lucide_");
        for (int i = 0; i < pascal.length(); i++) {
            char c = pascal.charAt(i);
            if (c >= 'A' && c <= 'Z' && i > 0) sb.append('_');
            sb.append(Character.toLowerCase(c));
        }
        return sb.toString();
    }

    private static int parseColor(String hex) {
        try {
            return Color.parseColor(hex);
        } catch (Exception e) {
            return Color.parseColor("#22c55e");
        }
    }
}
