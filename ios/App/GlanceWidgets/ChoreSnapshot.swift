import SwiftUI

// Chore selection and row-level formatting for the list and single-chore
// widgets — the iOS counterpart of ChoreSnapshot in SingleChoreWidget.kt. Every
// rule here is copied from the Kotlin deliberately: which chores qualify, how
// ties break, what the elapsed text says, and which colours stand in when the
// snapshot has none. The two platforms must pick the same chore and describe it
// the same way.

extension WidgetSnapshot {

    // Chores aged into the amber/red zone (state soon or overdue), most-overdue
    // first, capped at `limit`. Powers the Soon list widget.
    func soonList(limit: Int) -> [SnapshotChore] {
        chores
            .filter { $0.state == .soon || $0.state == .overdue }
            .sorted { ($0.ratio ?? 0) > ($1.ratio ?? 0) }
            .prefix(limit)
            .map { $0 }
    }

    // Pinned chores in the app's Pinned order: most overdue first by ratio,
    // chores without a ratio (no cadence, or never done) last, ties by name.
    // Mirrors collectPinned in src/utils/pinned.ts and pickPinnedList in the
    // Kotlin. Powers the Pinned widget.
    func pinnedList(limit: Int) -> [SnapshotChore] {
        chores
            .filter { $0.pinned }
            .sorted { a, b in
                switch (a.ratio, b.ratio) {
                case let (ra?, rb?) where ra != rb: return ra > rb
                case (.some, nil): return true
                case (nil, .some): return false
                default: return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
                }
            }
            .prefix(limit)
            .map { $0 }
    }

    // The chore with the highest elapsed/target ratio (most overdue, or closest
    // to due). Nil when nothing has a cadence + a completion yet.
    var mostOverdue: SnapshotChore? {
        chores.filter { $0.ratio != nil }.max { ($0.ratio ?? -1) < ($1.ratio ?? -1) }
    }

    // The specific chore chosen for a configured single-chore widget. Nil if it
    // is gone from the snapshot (e.g. deleted) — the widget then shows empty.
    func chore(bySyncId syncId: String) -> SnapshotChore? {
        chores.first { $0.syncId == syncId }
    }
}

// isoMillisFormatter lives in Snapshot.swift, not here. This file is
// widget-only: it imports SwiftUI and its String(localized:) lookups resolve
// against the widget bundle's string catalog. CompletionStore needs the
// formatter and is now a member of the app target too (the Shortcuts intents
// queue completions through it), so the formatter had to move to a file the
// app target compiles.

extension SnapshotChore {

    // "today" / "yesterday" / "Nd ago" / "never" — the same words the app and
    // the Android widgets use. Calendar-day boundaries off the real timestamp,
    // so a chore done last night reads "yesterday" this morning, not "today";
    // elapsedDays alone is a duration and gets that wrong (a 10pm→8am gap is
    // under 24h). Falls back to the duration when the timestamp is missing.
    var elapsedLabel: String {
        guard elapsedDays != nil else { return String(localized: "never") }
        if let iso = lastCompletedAt, let then = isoMillisFormatter.date(from: iso) {
            let calendar = Calendar.current
            let days = calendar.dateComponents(
                [.day],
                from: calendar.startOfDay(for: then),
                to: calendar.startOfDay(for: Date())
            ).day ?? 0
            switch days {
            case ...0: return String(localized: "today")
            case 1: return String(localized: "yesterday")
            default: return String(localized: "\(days)d ago")
            }
        }
        let d = elapsedDays ?? 0
        if d < 1 { return String(localized: "today") }
        return String(localized: "\(Int(d.rounded()))d ago")
    }

    // The recency colour the snapshot shipped, with the same two fallbacks as
    // Android: neutral slate when the chore has no cadence/completion yet, and
    // the brand green when a shipped value fails to parse.
    var recencyColor: Color {
        Color(hexString: color ?? "#94a3b8") ?? Color(hexString: "#22c55e")!
    }
}

extension Color {
    // #rrggbb only — the only form the snapshot ever contains.
    init?(hexString: String) {
        var s = hexString
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(
            red: Double((v >> 16) & 0xFF) / 255,
            green: Double((v >> 8) & 0xFF) / 255,
            blue: Double(v & 0xFF) / 255
        )
    }
}
