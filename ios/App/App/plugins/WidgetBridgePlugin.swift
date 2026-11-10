import Foundation
import Capacitor
import UIKit
import WidgetKit

// iOS counterpart of WidgetBridgePlugin.java. Receives the denormalized snapshot
// from the web app, persists it in the App Group for the widget extensions to
// render from, and hands back anything the extensions queued while the WebView
// was not running.
//
// The JS interface is fixed by src/native/widgetBridge.ts and must stay
// byte-identical to the Android plugin's, so widgetBridge.ts needs no per-platform
// branching: updateSnapshot / drainPendingCompletions / consumeDeepLink /
// consumeSharedChore / systemWeekStart / systemClock.
//
// Registration: app-local plugins are NOT auto-discovered on iOS (Capacitor 5+
// removed runtime scanning); this plugin is registered explicitly in
// BridgeViewController.capacitorDidLoad(), alongside VaultSsePlugin — the same
// pattern lifeGLANCE uses in its MainViewController.
@objc(WidgetBridgePlugin)
public class WidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "WidgetBridgePlugin"
    public let jsName = "WidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "updateSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drainPendingCompletions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeDeepLink", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeSharedChore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "systemWeekStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "systemClock", returnType: CAPPluginReturnPromise),
    ]

    // The system's first day of the week, 0 = Sunday … 6 = Saturday, for
    // Automatic week start in the web UI (issue #362). Calendar.current carries
    // the device region and any first-day override from Settings, which the
    // WebView's language tag may not.
    @objc func systemWeekStart(_ call: CAPPluginCall) {
        call.resolve(["weekStart": (Calendar.current.firstWeekday - 1 + 7) % 7])
    }

    // Whether the device shows a 24-hour clock (Settings > General > Date &
    // Time), for Automatic time format in the web UI. Locale.current carries
    // the 24-Hour Time switch; the "j" template resolves to the hour field the
    // user's clock uses, and only a 12-hour clock adds the "a" day period.
    @objc func systemClock(_ call: CAPPluginCall) {
        let pattern = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: Locale.current) ?? ""
        call.resolve(["hour24": !pattern.contains("a")])
    }

    @objc func updateSnapshot(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else {
            call.reject("missing json")
            return
        }
        // A missing App Group is the one failure worth surfacing: everything else
        // in this plugin degrades to "no data", which is indistinguishable from a
        // fresh install. widgetBridge.ts swallows the rejection, so this only ever
        // shows up in native logs — which is exactly where it is useful.
        guard SharedDataStore.isAvailable else {
            call.reject("app group \(SharedDataStore.suiteName) unavailable")
            return
        }
        SharedDataStore.writeSnapshot(json)
        // Unlike Android, there is no per-widget broadcast to target: WidgetKit
        // reloads every placed timeline for this app. Cheap, because our providers
        // only read a JSON blob out of UserDefaults.
        WidgetCenter.shared.reloadAllTimelines()
        refreshShortcuts(json: json)
        call.resolve()
    }

    // Rebuild the home-screen quick actions from the snapshot — the analogue of
    // WidgetShortcuts.refresh on Android, with the same priority order: Add,
    // Search, then the most-overdue chores. iOS shows at most four, so the
    // data-driven tail is two chores (Android trims to the launcher's max the
    // same way, lowest priority first).
    //
    // Each item's `type` is the internal deep-link token itself; AppDelegate's
    // performActionFor validates and stores it verbatim. Parsed with
    // JSONSerialization rather than a model on purpose — this file lives in the
    // app target and has no reason to grow a dependency on the widget target's
    // snapshot model for two fields.
    private func refreshShortcuts(json: String) {
        var items: [UIApplicationShortcutItem] = [
            UIApplicationShortcutItem(
                type: "action:add",
                localizedTitle: "Add chore",
                localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(type: .add),
                userInfo: nil
            ),
            UIApplicationShortcutItem(
                type: "action:search",
                localizedTitle: "Search",
                localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(type: .search),
                userInfo: nil
            ),
        ]

        if let root = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
           let chores = root["chores"] as? [[String: Any]] {
            let ranked = chores
                .filter { ($0["state"] as? String) == "overdue" || ($0["state"] as? String) == "soon" }
                .sorted {
                    (($0["ratio"] as? Double) ?? 0) > (($1["ratio"] as? Double) ?? 0)
                }
                .prefix(2)
            for chore in ranked {
                guard let syncId = chore["syncId"] as? String,
                      let name = chore["name"] as? String, !name.isEmpty else { continue }
                items.append(UIApplicationShortcutItem(
                    type: "chore:\(syncId)",
                    localizedTitle: name,
                    localizedSubtitle: elapsedSubtitle(chore),
                    // An SF Symbol, NOT UIApplicationShortcutIcon(type: .task):
                    // that legacy enum case rendered as "?" on current iOS
                    // (verified on device), while .add/.search still map to real
                    // glyphs. A clock is on-brand for "when did you last...".
                    // Android shows each chore's own tinted Lucide icon here; iOS
                    // cannot — shortcut icons accept only system symbols or
                    // asset-catalog names, never runtime-rendered images, so the
                    // Lucide pipeline cannot reach quick actions.
                    icon: UIApplicationShortcutIcon(systemImageName: "clock"),
                    userInfo: nil
                ))
            }
        }

        DispatchQueue.main.async {
            UIApplication.shared.shortcutItems = items
        }
    }

    // "today" / "yesterday" / "Nd ago" for a shortcut's subtitle — the same
    // wording as the widget rows' elapsed label, and the same calendar-day
    // semantics (a chore done last night reads "yesterday" this morning). A
    // deliberate small duplication of ChoreSnapshot.elapsedLabel: that lives in
    // the widget target, and this file has already chosen not to depend on the
    // widget target's model for a couple of fields.
    private func elapsedSubtitle(_ chore: [String: Any]) -> String? {
        guard let iso = chore["lastCompletedAt"] as? String else { return nil }
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        fmt.timeZone = TimeZone(identifier: "UTC")
        guard let then = fmt.date(from: iso) else { return nil }
        let calendar = Calendar.current
        let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: then),
            to: calendar.startOfDay(for: Date())
        ).day ?? 0
        switch days {
        case ...0: return "today"
        case 1: return "yesterday"
        default: return "\(days)d ago"
        }
    }

    @objc func drainPendingCompletions(_ call: CAPPluginCall) {
        call.resolve(["completions": SharedDataStore.readAndClearPendingCompletions()])
    }

    @objc func consumeDeepLink(_ call: CAPPluginCall) {
        // NSNull rather than nil: Capacitor drops nil values from the result
        // dictionary, and widgetBridge.ts reads `res?.deepLink ?? null`, so an
        // absent key and an explicit null both land on null. Explicit is clearer.
        call.resolve(["deepLink": SharedDataStore.readAndClearPendingDeepLink() ?? NSNull()])
    }

    @objc func consumeSharedChore(_ call: CAPPluginCall) {
        // Pops the OLDEST queued share; the JS side calls this on every
        // foreground, so multiple shares queued while the app was closed
        // surface one per open rather than all-but-the-last being lost.
        call.resolve(["text": SharedDataStore.consumeNextSharedChore() ?? NSNull()])
    }
}
