import AppIntents
import Foundation
import WidgetKit

// App Shortcuts: lastGLANCE in the Shortcuts app, Spotlight and Siri.
//
// This is iOS's answer to the Android broadcast intents bridge
// (intents/IntentReceiver + IntentsBridgePlugin, docs/tasker-integration.md),
// and it covers the same four verbs: CREATE, COMPLETE, QUERY, OPEN. Android
// exposes them to Tasker through explicit broadcasts; iOS has no such thing,
// and the sanctioned equivalent is AppIntents, which also buys Siri phrases
// and Spotlight for free.
//
// THIS FILE IS A MEMBER OF THE App TARGET ONLY, and that is deliberate in both
// directions:
//
//  - It must be in the app target. App Shortcuts are read out of the *app's*
//    AppIntents metadata; a provider compiled into an extension alone is never
//    discovered. This is the same trap AddChoreControl.swift documents, from
//    the other side.
//  - It must NOT also be in the widget extension. The same intent vended by
//    two targets is two entries in the Shortcuts action list, with no way for
//    a user to tell which is which.
//
// That membership is why Snapshot.swift and CompletionStore.swift are now
// compiled into both targets: the intents below read chores out of the
// App-Group snapshot and queue completions through the same store the widget
// Done buttons use. Nothing here reaches the database. The web app owns it,
// and none of this runs inside the WebView:
//
//   COMPLETE → the App-Group completion queue, drained on next foreground by
//              the existing pendingCompletions path, idempotent on sync_id.
//   QUERY    → read straight from the snapshot the app last pushed.
//   CREATE   → write the deep-link token and open the app, exactly as the
//              Control Center control does.
//   OPEN     → the same, with the Soon filter's token.
//
// Everything is gated at iOS 17.0 rather than the app's own 15.0 floor. The
// widget extension already targets 17.0 for the same reason (section 4 of
// docs/ios-native-features-plan.md): the pre-17 API shapes would be a second
// code path to carry, and a device below 17 is simply not offered the feature.
// No existing user loses anything they had.

// MARK: - The chore a shortcut acts on

// A chore as the Shortcuts app sees it: an id to act on and a name to show.
// Nothing else, because nothing else survives being picked once and replayed
// for months — the snapshot's colours, ratios and elapsed days are read fresh
// at perform() time instead.
@available(iOS 17.0, *)
struct ChoreEntity: AppEntity, Identifiable {

    let id: String
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Chore")
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    static var defaultQuery = ChoreEntityQuery()
}

// EntityStringQuery, not EntityQuery: the string half is what lets Siri match
// a chore the user *said* ("mark mop the floor done") against the snapshot,
// rather than only a chore they tapped in a picker.
@available(iOS 17.0, *)
struct ChoreEntityQuery: EntityStringQuery {

    // Chores as the last snapshot push left them. A chore deleted since is
    // simply absent, which is the correct answer to "what can I act on".
    private func allChores() -> [ChoreEntity] {
        SnapshotLoad.read().snapshot.chores
            .filter { !$0.syncId.isEmpty }
            .map { ChoreEntity(id: $0.syncId, name: $0.name) }
    }

    // Resolving a chore a saved shortcut already holds. Returning [] for an id
    // that is gone is what makes Shortcuts tell the user the chore no longer
    // exists instead of silently logging against a dead id.
    func entities(for identifiers: [ChoreEntity.ID]) async throws -> [ChoreEntity] {
        let all = allChores()
        return identifiers.compactMap { id in all.first { $0.id == id } }
    }

    func entities(matching string: String) async throws -> [ChoreEntity] {
        allChores().filter { $0.name.localizedCaseInsensitiveContains(string) }
    }

    func suggestedEntities() async throws -> [ChoreEntity] {
        allChores()
    }
}

// MARK: - COMPLETE

@available(iOS 17.0, *)
struct MarkChoreDoneIntent: AppIntent {

    static let title: LocalizedStringResource = "Mark chore done"
    static var description = IntentDescription("Log a completion, without opening the app.")
    // Headless on purpose: the completion goes to the App-Group queue, which
    // the web app drains on its next foreground. Opening the app to log would
    // defeat the point of a shortcut and an automation could not run unattended.
    static let openAppWhenRun = false

    @Parameter(title: "Chore")
    var chore: ChoreEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Mark \(\.$chore) done")
    }

    init() {}

    init(chore: ChoreEntity) {
        self.chore = chore
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        // The same call the widget Done button makes: mints the sync_id,
        // queues the completion and folds it into the snapshot so every
        // placed widget shows it before the app has run.
        CompletionStore.complete(choreSyncId: chore.id)
        return .result(dialog: "Logged \(chore.name).")
    }
}

// MARK: - QUERY

// "When did I last…?" is the question the app exists to answer, so it is worth
// answering without opening the app at all.
@available(iOS 17.0, *)
struct ChoreLastDoneIntent: AppIntent {

    static let title: LocalizedStringResource = "Check when a chore was last done"
    static var description = IntentDescription("Answer when you last did a chore, without opening the app.")
    static let openAppWhenRun = false

    @Parameter(title: "Chore")
    var chore: ChoreEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Check when \(\.$chore) was last done")
    }

    init() {}

    init(chore: ChoreEntity) {
        self.chore = chore
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        // Re-read rather than trusting the entity: a saved shortcut carries
        // the id and name it was built with, and the answer has to be about
        // the chore as it stands now.
        let lastDone = SnapshotLoad.read().snapshot.chores
            .first { $0.syncId == chore.id }?
            .lastCompletedAt
            .flatMap { isoMillisFormatter.date(from: $0) }

        guard let lastDone else {
            let never = LocalizedStringResource("Not done yet.")
            return .result(value: String(localized: never), dialog: IntentDialog(never))
        }

        // RelativeDateTimeFormatter, not the widgets' "3d ago": the system
        // formatter is spoken-language correct in every locale the app ships,
        // plurals and all, with no strings of our own to keep in step. It is
        // duration-based where the widget label counts calendar days, and for
        // an answer read aloud that is the better of the two — a chore done
        // late last night reads "10 hours ago" rather than "yesterday".
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        let relative = formatter.localizedString(for: lastDone, relativeTo: Date())

        let answer = LocalizedStringResource("Last done \(relative).")
        return .result(value: String(localized: answer), dialog: IntentDialog(answer))
    }
}

// MARK: - CREATE and OPEN

// Both of these open the app, and both carry their destination the way
// AddChoreControl.swift documents at length: the token is written to the App
// Group *before* the open is handed back, because `openAppWhenRun` can satisfy
// "open the app" without the system ever performing the chained OpenURLIntent.
// The chained intent is kept for the case where it does: AppDelegate maps the
// URL to the same token, into the same single slot, so the destination is the
// same value either way and is consumed once.
//
// This is a second Add-chore intent rather than a reuse of the control's
// OpenAddChoreIntent, which does the identical thing. That one lives in
// App/Shared/AddChoreControl.swift, a member of both targets because a
// Control Center control needs it there, and is marked isDiscoverable = false
// for exactly the reason given at the top of this file: an intent vended by
// two targets appears twice in Shortcuts. One of them has to be the one users
// see, and it has to be the app-only one.

@available(iOS 17.0, *)
struct AddChoreShortcutIntent: AppIntent {

    static let title: LocalizedStringResource = "Add chore"
    static var description = IntentDescription("Open lastGLANCE ready to add a new chore.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        SharedDataStore.writePendingDeepLink("action:add")
        return .result(opensIntent: OpenURLIntent(URL(string: "lastglance://action/add")!))
    }
}

@available(iOS 17.0, *)
struct ShowSoonChoresIntent: AppIntent {

    static let title: LocalizedStringResource = "Show chores due soon"
    static var description = IntentDescription("Open lastGLANCE on the chores that need attention.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        SharedDataStore.writePendingDeepLink("filter:soon")
        return .result(opensIntent: OpenURLIntent(URL(string: "lastglance://filter/soon")!))
    }
}

// MARK: - The App Shortcuts themselves

// What Siri and Spotlight offer without the user building anything. Every
// phrase has to contain \(.applicationName) — iOS drops a phrase that does
// not, silently — and the phrases are localized through
// App/AppShortcuts.xcstrings, whose keys are the English phrase with
// ${applicationName} in place of the interpolation.
@available(iOS 17.0, *)
struct LastGlanceShortcuts: AppShortcutsProvider {

    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: MarkChoreDoneIntent(),
            phrases: [
                "Mark a chore done in \(.applicationName)",
                "Log a chore in \(.applicationName)",
            ],
            shortTitle: "Mark done",
            systemImageName: "checkmark.circle"
        )
        AppShortcut(
            intent: ChoreLastDoneIntent(),
            phrases: [
                "When did I last do a chore in \(.applicationName)",
                "Check a chore in \(.applicationName)",
            ],
            shortTitle: "Last done",
            systemImageName: "clock.arrow.circlepath"
        )
        AppShortcut(
            intent: AddChoreShortcutIntent(),
            phrases: [
                "Add a chore in \(.applicationName)",
                "New chore in \(.applicationName)",
            ],
            shortTitle: "Add chore",
            systemImageName: "plus.circle"
        )
        AppShortcut(
            intent: ShowSoonChoresIntent(),
            phrases: [
                "Show chores due soon in \(.applicationName)",
                "What is due soon in \(.applicationName)",
            ],
            shortTitle: "Due soon",
            systemImageName: "exclamationmark.triangle"
        )
    }
}
