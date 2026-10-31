import Foundation
import WidgetKit

// Record a completion made outside the web app: queue it for the app to replay
// into the DB, and optimistically fold it into the snapshot so the widgets
// reflect it instantly, before the app ever runs. The iOS counterpart of
// CompletionStore in SingleChoreWidget.kt, field for field:
//
//  - The sync_id is minted HERE (lowercase UUID). The web drain replays via
//    logCompletion(choreId, { syncId }) which dedupes on it, so draining twice
//    — or the event arriving from another device first — cannot double-count.
//  - completedAt is "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'" UTC, the exact shape the JS
//    side and the Android tap path produce.
//  - The optimistic fold mutates the RAW snapshot JSON via JSONSerialization,
//    not through the Codable model: the model is lenient and lossy by design,
//    and a decode→encode round trip would silently drop any field this build
//    does not know about.
//
// This file is a member of BOTH the App and GlanceWidgetsExtension targets.
// The widget Done buttons call it from the extension process; the Shortcuts
// "Mark chore done" intent (ChoreShortcuts.swift) calls it from the app's.
// Both write the same queue with the same contract, which is the whole point
// of there being one of these rather than two.
enum CompletionStore {

    static func complete(choreSyncId: String) {
        let syncId = UUID().uuidString.lowercased()
        let completedAt = isoMillisFormatter.string(from: Date())
        SharedDataStore.appendPendingCompletion(
            choreSyncId: choreSyncId, syncId: syncId, completedAt: completedAt
        )

        applyOptimistically(choreSyncId: choreSyncId, completedAt: completedAt)

        // Every widget kind re-renders from the mutated snapshot: the tile and
        // the list show the completion, the heatmap gains today's cell.
        WidgetCenter.shared.reloadAllTimelines()
    }

    private static func applyOptimistically(choreSyncId: String, completedAt: String) {
        guard let raw = SharedDataStore.readSnapshot(),
              var root = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any]
        else { return }

        if var chores = root["chores"] as? [[String: Any]] {
            for i in chores.indices where (chores[i]["syncId"] as? String) == choreSyncId {
                chores[i]["lastCompletedAt"] = completedAt
                chores[i]["elapsedDays"] = 0
                chores[i]["ratio"] = 0
                chores[i]["color"] = "#22c55e"
                chores[i]["state"] = "fresh"
                break
            }
            var overdue = 0, soon = 0
            for ch in chores {
                switch ch["state"] as? String {
                case "overdue": overdue += 1
                case "soon": soon += 1
                default: break
                }
            }
            var counts = root["counts"] as? [String: Any] ?? [:]
            counts["overdue"] = overdue
            counts["soon"] = soon
            root["counts"] = counts
            root["chores"] = chores
        }

        // Local-day key, matching the web snapshot's dayjs().format('YYYY-MM-DD').
        let dayFormatter = DateFormatter()
        dayFormatter.locale = Locale(identifier: "en_US_POSIX")
        dayFormatter.dateFormat = "yyyy-MM-dd"
        let today = dayFormatter.string(from: Date())
        var heatmap = root["heatmap"] as? [String: Any] ?? [:]
        heatmap[today] = (heatmap[today] as? Int ?? 0) + 1
        root["heatmap"] = heatmap

        if let data = try? JSONSerialization.data(withJSONObject: root),
           let json = String(data: data, encoding: .utf8) {
            SharedDataStore.writeSnapshot(json)
        }
        // On failure: nothing written — the completion is already queued for the
        // DB replay, so the widget is merely stale until the next app foreground.
    }
}
