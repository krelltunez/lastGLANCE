import SwiftUI
import WidgetKit

// The Pinned list widget: the chores pinned in the app, in the app's Pinned
// order (most overdue first), each with one-tap Done. The iOS counterpart of
// PinnedWidget.kt, and built like SoonListWidgetView: the same rows (with the
// category ahead of the elapsed text, as in the app's Pinned row, since pins
// come from every category) and the same measured fit, ViewThatFits picking
// the most rows this family holds with "+N more" for the rest.

struct PinnedWidgetView: View {
    var entry: SnapshotEntry

    @Environment(\.widgetFamily) private var family

    // Same trim as the Soon list: medium only fits two rows with the tighter
    // padding (see SoonListWidgetView).
    private var compactRows: Bool { family == .systemMedium }

    var body: some View {
        Group {
            if let problem = entry.problem {
                SnapshotProblemView(message: problem)
            } else {
                content
            }
        }
        .containerBackground(for: .widget) {
            Color(uiColor: .systemBackground)
        }
        // No widgetURL: a tap outside a row or Done opens the app, which on a
        // phone starts on its Pinned tab.
    }

    private var content: some View {
        let all = entry.snapshot.pinnedList(limit: 100)

        return Group {
            if all.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    Spacer(minLength: 0)
                    Text("Pin chores in the app to see them here.")
                        .font(.system(size: 14))
                        .foregroundStyle(.primary)
                    Spacer(minLength: 0)
                    Wordmark(size: 16)
                }
            } else {
                // Candidates in descending order, as in SoonListWidgetView; they
                // must contain no Spacer or flexible frame, or every one "fits".
                ViewThatFits(in: .vertical) {
                    candidate(all, 10)
                    candidate(all, 9)
                    candidate(all, 8)
                    candidate(all, 7)
                    candidate(all, 6)
                    candidate(all, 5)
                    candidate(all, 4)
                    candidate(all, 3)
                    candidate(all, 2)
                    candidate(all, 1)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        Text("PINNED")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(.secondary)
            .padding(.bottom, compactRows ? 4 : 6)
    }

    private func subtitle(_ chore: SnapshotChore) -> String {
        [chore.categoryName, chore.elapsedLabel].compactMap { $0 }.joined(separator: " · ")
    }

    private func candidate(_ all: [SnapshotChore], _ count: Int) -> some View {
        let shown = Array(all.prefix(count))
        let hidden = all.count - shown.count

        return VStack(alignment: .leading, spacing: 0) {
            header
            ForEach(shown, id: \.syncId) { chore in
                ChoreRowView(chore: chore, subtitle: subtitle(chore))
                    .padding(.vertical, compactRows ? 3 : 4)
            }
            if hidden > 0 {
                Text("+\(hidden) more")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.top, compactRows ? 1 : 2)
            }
        }
    }
}

struct PinnedWidget: Widget {
    let kind = "PinnedWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
            PinnedWidgetView(entry: entry)
        }
        .configurationDisplayName("Pinned")
        .description("Your pinned chores, most overdue first, with one-tap Done.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
