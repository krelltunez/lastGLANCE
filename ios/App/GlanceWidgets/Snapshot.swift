import Foundation

// Swift view of the snapshot contract defined in src/native/snapshot.ts. The web
// app is the only writer; this side is read-only and must never assume more than
// the contract guarantees.
//
// This file is a member of BOTH the App and GlanceWidgetsExtension targets.
// The widgets render from it, and the app target's Shortcuts intents
// (ChoreShortcuts.swift) read the same snapshot to list and answer about
// chores. It stays pure Foundation for that reason: no SwiftUI, and no
// String(localized:) outside SnapshotLoad.problem, whose strings only ever
// render in a widget.
//
// Decoding is deliberately lenient: every field falls back to a default rather
// than throwing. A widget that renders an empty heatmap because one chore had an
// unexpected field is a bad trade against a widget that renders nothing at all,
// and the two processes are versioned independently (the WebView updates with the
// app bundle, but a placed widget can be asked to render at any moment).

// The completion timestamps in the snapshot are minted by dayjs/Date on the JS
// side and by the completion paths on both platforms, always in this exact
// form. en_US_POSIX pins the format against locale settings.
//
// It lives here rather than in ChoreSnapshot.swift (where it began) because
// both of its users have to compile in the app target as well as the widget
// one: CompletionStore, which stamps a queued completion, and the Shortcuts
// intents, which read a chore's last completion back. ChoreSnapshot.swift is
// widget-only.
let isoMillisFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
    f.timeZone = TimeZone(identifier: "UTC")
    return f
}()

enum ChoreState: String, Decodable {
    case fresh, soon, overdue, none
}

struct SnapshotChore: Decodable {
    let syncId: String
    let name: String
    let icon: String?
    let categoryName: String?
    let lastCompletedAt: String?
    let elapsedDays: Double?
    let targetCadenceDays: Double?
    let ratio: Double?
    let color: String?
    let state: ChoreState
    // Pinned and in season. Absent in snapshots from before pinning: false.
    let pinned: Bool

    private enum CodingKeys: String, CodingKey {
        case syncId, name, icon, categoryName, lastCompletedAt
        case elapsedDays, targetCadenceDays, ratio, color, state, pinned
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        syncId = (try? c.decode(String.self, forKey: .syncId)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        icon = try? c.decode(String.self, forKey: .icon)
        categoryName = try? c.decode(String.self, forKey: .categoryName)
        lastCompletedAt = try? c.decode(String.self, forKey: .lastCompletedAt)
        // Numbers are decoded as Double even where the TS side only ever emits
        // integers: elapsed_days can be fractional, and an Int decode would throw
        // on the first half-day rather than degrade.
        elapsedDays = try? c.decode(Double.self, forKey: .elapsedDays)
        targetCadenceDays = try? c.decode(Double.self, forKey: .targetCadenceDays)
        ratio = try? c.decode(Double.self, forKey: .ratio)
        color = try? c.decode(String.self, forKey: .color)
        state = (try? c.decode(ChoreState.self, forKey: .state)) ?? .none
        pinned = (try? c.decode(Bool.self, forKey: .pinned)) ?? false
    }
}

// The People block (src/native/peopleSnapshot.ts). Every People word arrives
// already in the app's language, so the People widgets carry no copy of the
// People strings. Absent in snapshots from before People widgets: decodes as
// empty, with English fallbacks for the labels.
struct PeopleReachOut: Decodable {
    let syncId: String
    let name: String
    let color: String
    let detail: String

    private enum CodingKeys: String, CodingKey { case syncId, name, color, detail }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        syncId = (try? c.decode(String.self, forKey: .syncId)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        color = (try? c.decode(String.self, forKey: .color)) ?? "#f472b6"
        detail = (try? c.decode(String.self, forKey: .detail)) ?? ""
    }
}

struct PeopleDate: Decodable {
    let personSyncId: String
    let name: String
    let label: String
    // Local day, "yyyy-MM-dd".
    let on: String

    private enum CodingKeys: String, CodingKey { case personSyncId, name, label, on }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        personSyncId = (try? c.decode(String.self, forKey: .personSyncId)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        label = (try? c.decode(String.self, forKey: .label)) ?? ""
        on = (try? c.decode(String.self, forKey: .on)) ?? ""
    }
}

struct PeopleLabels: Decodable {
    var reachOut = "Reach out"
    var comingUp = "Coming up"
    var reachOutEmpty = ""
    var comingUpEmpty = ""
    var today = "today"
    var tomorrow = "tomorrow"
    // Holds "{{count}}" for the day count.
    var inDays = "{{count}}d"

    init() {}

    private enum CodingKeys: String, CodingKey {
        case reachOut, comingUp, reachOutEmpty, comingUpEmpty, today, tomorrow, inDays
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func str(_ key: CodingKeys, _ fallback: String) -> String {
            let v = (try? c.decode(String.self, forKey: key)) ?? ""
            return v.isEmpty ? fallback : v
        }
        reachOut = str(.reachOut, reachOut)
        comingUp = str(.comingUp, comingUp)
        reachOutEmpty = str(.reachOutEmpty, reachOutEmpty)
        comingUpEmpty = str(.comingUpEmpty, comingUpEmpty)
        today = str(.today, today)
        tomorrow = str(.tomorrow, tomorrow)
        inDays = str(.inDays, inDays)
    }

    func daysUntil(_ n: Int) -> String {
        switch n {
        case 0: return today
        case 1: return tomorrow
        default: return inDays.replacingOccurrences(of: "{{count}}", with: String(n))
        }
    }
}

struct PeopleSnapshot: Decodable {
    var reachOut: [PeopleReachOut] = []
    var comingUp: [PeopleDate] = []
    var labels = PeopleLabels()

    init() {}

    private enum CodingKeys: String, CodingKey { case reachOut, comingUp, labels }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reachOut = ((try? c.decode([PeopleReachOut].self, forKey: .reachOut)) ?? []).filter { !$0.syncId.isEmpty }
        comingUp = (try? c.decode([PeopleDate].self, forKey: .comingUp)) ?? []
        labels = (try? c.decode(PeopleLabels.self, forKey: .labels)) ?? PeopleLabels()
    }
}

struct WidgetSnapshot: Decodable {
    struct Counts: Decodable {
        let overdue: Int
        let soon: Int

        init(overdue: Int = 0, soon: Int = 0) {
            self.overdue = overdue
            self.soon = soon
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            overdue = (try? c.decode(Int.self, forKey: .overdue)) ?? 0
            soon = (try? c.decode(Int.self, forKey: .soon)) ?? 0
        }

        private enum CodingKeys: String, CodingKey { case overdue, soon }
    }

    let version: Int
    let generatedAt: String?
    let counts: Counts
    // Keyed "yyyy-MM-dd" (local dates, as produced by dayjs in the WebView) to a
    // completion count for that day.
    let heatmap: [String: Int]
    // The heatmap grid's first row, 0 = Sunday … 6 = Saturday: the app's own
    // week start (issue #362). Nil from a snapshot written before it existed.
    let weekStart: Int?
    let chores: [SnapshotChore]
    let people: PeopleSnapshot

    // The week start to draw with: the app's, else the system calendar's
    // (Calendar.firstWeekday is 1 = Sunday … 7 = Saturday).
    var effectiveWeekStart: Int {
        if let w = weekStart, (0...6).contains(w) { return w }
        return (Calendar.current.firstWeekday - 1 + 7) % 7
    }

    init(version: Int = 1,
         generatedAt: String? = nil,
         counts: Counts = Counts(),
         heatmap: [String: Int] = [:],
         weekStart: Int? = nil,
         chores: [SnapshotChore] = [],
         people: PeopleSnapshot = PeopleSnapshot()) {
        self.version = version
        self.generatedAt = generatedAt
        self.counts = counts
        self.heatmap = heatmap
        self.weekStart = weekStart
        self.chores = chores
        self.people = people
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? c.decode(Int.self, forKey: .version)) ?? 1
        generatedAt = try? c.decode(String.self, forKey: .generatedAt)
        counts = (try? c.decode(Counts.self, forKey: .counts)) ?? Counts()
        heatmap = (try? c.decode([String: Int].self, forKey: .heatmap)) ?? [:]
        weekStart = try? c.decode(Int.self, forKey: .weekStart)
        chores = (try? c.decode([SnapshotChore].self, forKey: .chores)) ?? []
        people = (try? c.decode(PeopleSnapshot.self, forKey: .people)) ?? PeopleSnapshot()
    }

    private enum CodingKeys: String, CodingKey {
        case version, generatedAt, counts, heatmap, weekStart, chores, people
    }
}

// Why there is nothing to draw. Collapsing these into one empty snapshot made a
// misprovisioned App Group, a never-opened app and a corrupt payload all look
// identical on screen — a blank widget with no way to tell which. Two of the
// three are developer errors and one is a legitimate first-run state, and they
// want opposite responses, so the widget names which it hit.
enum SnapshotLoad {
    case loaded(WidgetSnapshot)
    /// UserDefaults(suiteName:) returned nil: the entitlement is missing from
    /// this target, or the provisioning profile does not carry the App Group.
    case appGroupUnavailable
    /// The container is readable but empty. Normal on a fresh install until the
    /// app foregrounds once and pushes.
    case noSnapshotYet
    case undecodable

    var snapshot: WidgetSnapshot {
        if case let .loaded(s) = self { return s }
        return WidgetSnapshot()
    }

    /// A short line to render in place of the grid, or nil when all is well.
    var problem: String? {
        switch self {
        case .loaded: return nil
        case .appGroupUnavailable: return "App Group unavailable.\nCheck the GlanceWidgets entitlement."
        case .noSnapshotYet: return String(localized: "Open lastGLANCE once to sync.")
        case .undecodable: return String(localized: "Snapshot unreadable.")
        }
    }

    static func read() -> SnapshotLoad {
        guard SharedDataStore.isAvailable else { return .appGroupUnavailable }
        guard let raw = SharedDataStore.readSnapshot() else { return .noSnapshotYet }
        guard let decoded = try? JSONDecoder().decode(WidgetSnapshot.self, from: Data(raw.utf8))
        else { return .undecodable }
        return .loaded(decoded)
    }
}
