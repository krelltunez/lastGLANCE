import SwiftUI
import WidgetKit

// Phase 2: the "Soon" list widget — the chores aged into the amber/red zone,
// most-overdue first, each with one-tap Done. The iOS counterpart of
// SoonListWidget.kt; row anatomy, colours and type sizes mirror the Glance
// rows so the platforms read as one product.
//
// One structural difference from Android: Glance lists scroll, WidgetKit
// widgets never do — a widget is a static render with tappable islands, so
// there is no scrolling to offer. Instead the row count adapts: ViewThatFits
// measures candidate lists from ten rows down and renders the most that
// actually fit this family on this device, with a "+N more" line standing in
// for the tail. Measured, not guessed — a hardcoded per-family cap overflowed
// on the iPad mini (SwiftUI centers overflowing content, clipping both ends,
// which read as a list stuck mid-scroll).

// The one-tap Done chip, shared by the list rows and the single-chore widget.
// Runs CompleteChoreIntent in-process — the widget updates immediately, offline,
// and the app replays the queued completion on next foreground.
struct DoneButton: View {
    let choreSyncId: String
    var compact = true

    var body: some View {
        Button(intent: CompleteChoreIntent(choreSyncId: choreSyncId)) {
            Text("Done")
                .font(.system(size: compact ? 12 : 13, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, compact ? 10 : 12)
                .padding(.vertical, compact ? 5 : 6)
                .background(Color(hexString: "#22c55e"))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }
}

// One chore as a list row: recency bar, tinted icon, name over elapsed text,
// Done. Same anatomy as ChoreListRow in the Kotlin widget (bar 5x26 r2, icon
// 18, name 14 medium, elapsed 11). The Pinned widget passes a subtitle that
// puts the category ahead of the elapsed text.
struct ChoreRowView: View {
    let chore: SnapshotChore
    var subtitle: String? = nil

    var body: some View {
        HStack(spacing: 8) {
            // The body of the row deep-links to the chore (Android's
            // openChoreIntent); the Done button stays OUTSIDE the Link so its
            // AppIntent keeps the tap. Link and Button are both tappable islands
            // inside a widget — whichever is hit wins.
            Link(destination: choreURL(chore.syncId)) {
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(chore.recencyColor)
                        .frame(width: 5, height: 26)
                    if let icon = chore.icon {
                        LucideIconView(name: icon, color: chore.recencyColor, size: 18)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(chore.name)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Text(subtitle ?? chore.elapsedLabel)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                }
            }
            DoneButton(choreSyncId: chore.syncId)
        }
    }
}

// A chore's deep link; syncIds are UUIDs, so this cannot really fail, but a
// fallback to the Soon view beats a crash on a malformed one.
func choreURL(_ syncId: String) -> URL {
    URL(string: "lastglance://chore/\(syncId)") ?? soonURL
}

let soonURL = URL(string: "lastglance://filter/soon")!

struct SoonListWidgetView: View {
    var entry: SnapshotEntry

    @Environment(\.widgetFamily) private var family

    // Medium is ~113pt of usable height on the iPad mini, and the standard row
    // metrics put the two-row candidate at ~112pt — losing by a point, so the
    // widget showed a single row over a slab of dead space. Trimming row
    // padding 4→3 and header padding 6→4 in medium alone brings two rows to
    // ~106pt with real clearance. Large keeps the standard metrics untouched;
    // ViewThatFits still measures, so if a device disagrees the widget degrades
    // to one row instead of clipping.
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
        // Anywhere that is not a row Link or a Done button opens the Soon view.
        .widgetURL(soonURL)
    }

    private var content: some View {
        let all = entry.snapshot.soonList(limit: 100)

        return Group {
            if all.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    Spacer(minLength: 0)
                    Text("All caught up")
                        .font(.system(size: 14))
                        .foregroundStyle(.primary)
                    Spacer(minLength: 0)
                    Wordmark(size: 16)
                }
            } else {
                // Candidates in descending order; ViewThatFits renders the first
                // whose measured height fits, falling back to the last (a single
                // row) when even that overflows. The candidates must contain no
                // Spacer or flexible frame — flexible content always "fits", and
                // the measurement would be meaningless.
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
        Text("SOON")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(.secondary)
            .padding(.bottom, compactRows ? 4 : 6)
    }

    private func candidate(_ all: [SnapshotChore], _ count: Int) -> some View {
        let shown = Array(all.prefix(count))
        let hidden = all.count - shown.count

        return VStack(alignment: .leading, spacing: 0) {
            header
            ForEach(shown, id: \.syncId) { chore in
                ChoreRowView(chore: chore)
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

struct SoonListWidget: Widget {
    let kind = "SoonListWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
            SoonListWidgetView(entry: entry)
        }
        .configurationDisplayName("Soon")
        .description("Chores that are due soon or overdue, with one-tap Done.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
