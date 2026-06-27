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

// Builds ALL app (long-press) shortcuts as DYNAMIC shortcuts, so their order is
// fully under our control. A launcher groups/sorts static (manifest) and dynamic
// shortcuts separately, so a mixed priority — fixed entries interleaved with
// data-driven ones — is only deterministic when every entry is dynamic and ranked.
// Rebuilt from the snapshot on every update (see WidgetBridgePlugin).
//
// Priority (rank 0 = highest, shown first):
//   0      Add chore        -> lastglance://action/add
//   1      Search           -> lastglance://action/search
//   2..N   top overdue      -> lastglance://chore/<syncId>  (icon tinted to recency)
//   last   Soon             -> lastglance://filter/soon
//
// Trimmed to getMaxShortcutCountPerActivity() when the device allows fewer; the
// list is in priority order, so trimming drops the lowest-priority tail first
// (Soon, then the least-overdue chores) — matching intent.
final class WidgetShortcuts {
    private static final int MAX_OVERDUE = 3;

    static void refresh(Context context, String json) {
        try {
            List<ShortcutInfoCompat> list = build(context, json);
            int max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context);
            if (max > 0 && list.size() > max) {
                // Keep the highest-priority prefix; ranks stay contiguous (0..max-1).
                list = new ArrayList<>(list.subList(0, max));
            }
            ShortcutManagerCompat.removeAllDynamicShortcuts(context);
            if (!list.isEmpty()) ShortcutManagerCompat.addDynamicShortcuts(context, list);
        } catch (Exception ignored) {
            // Best-effort; shortcuts are a convenience, never critical.
        }
    }

    private static List<ShortcutInfoCompat> build(Context context, String json) throws Exception {
        List<ShortcutInfoCompat> out = new ArrayList<>();
        int[] rank = {0};

        // Fixed, top of the list (always present, even with no chores).
        out.add(fixed(context, "add",
                context.getString(R.string.shortcut_add_short),
                context.getString(R.string.shortcut_add_long),
                "lastglance://action/add", R.drawable.ic_shortcut_add, rank));
        out.add(fixed(context, "search",
                context.getString(R.string.shortcut_search_short),
                context.getString(R.string.shortcut_search_long),
                "lastglance://action/search", R.drawable.ic_shortcut_search, rank));

        // Data-driven middle: top overdue/soon chores, most-overdue first.
        JSONArray chores = new JSONObject(json).optJSONArray("chores");
        if (chores != null) {
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
            int count = 0;
            for (JSONObject ch : ranked) {
                if (count >= MAX_OVERDUE) break;
                String syncId = ch.optString("syncId");
                String name = ch.optString("name");
                if (syncId.isEmpty() || name.isEmpty()) continue;
                ShortcutInfoCompat.Builder b = new ShortcutInfoCompat.Builder(context, "chore_" + syncId)
                        .setShortLabel(name)
                        .setLongLabel(name)
                        .setRank(rank[0]++)
                        .setIntent(viewIntent(context, "lastglance://chore/" + syncId));
                IconCompat icon = choreIcon(context, ch);
                if (icon != null) b.setIcon(icon);
                out.add(b.build());
                count++;
            }
        }

        // Fixed, bottom (lowest priority).
        out.add(fixed(context, "soon",
                context.getString(R.string.shortcut_soon_short),
                context.getString(R.string.shortcut_soon_long),
                "lastglance://filter/soon", R.drawable.ic_shortcut_soon, rank));

        return out;
    }

    private static ShortcutInfoCompat fixed(Context context, String id, String shortLabel,
                                            String longLabel, String uri, int iconRes, int[] rank) {
        return new ShortcutInfoCompat.Builder(context, id)
                .setShortLabel(shortLabel)
                .setLongLabel(longLabel)
                .setRank(rank[0]++)
                .setIcon(IconCompat.createWithResource(context, iconRes))
                .setIntent(viewIntent(context, uri))
                .build();
    }

    private static Intent viewIntent(Context context, String uri) {
        return new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse(uri));
    }

    // The chore's Lucide icon, tinted to its recency color (like the widgets),
    // rendered to a bitmap so the launcher shows the color. Null → default badge.
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
