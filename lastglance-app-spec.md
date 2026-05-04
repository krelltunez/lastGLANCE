# lastGLANCE — Scoping Doc

Third standalone app in the GLANCE family. Tracks when you last did recurring upkeep activities, with optional cadence and optional auto-scheduling to dayGLANCE.

## Core thesis

Chores are fundamentally different from tasks, routines, events, goals, and projects:

- **Events** are scheduled in advance, inflexible
- **Tasks** are not skippable, have deadlines, can be one-and-done or recurring
- **Routines** are daily/weekly, flexible, skippable, don't need "credit" (meds, meals, TV with spouse)
- **Goals/Projects** are outcome-oriented with task rollup
- **Chores** are irregular upkeep that benefit from tracking when last done, but shouldn't generate guilt when put off

The emotional register is the key design constraint. Saying "mop the floor every 2 weeks" leads to disappointment and frustration. The app should surface **information** (last done when) without **judgment** (you're overdue).

The name itself reflects this: lastGLANCE answers "when did I last do this?" rather than "when do I need to do this next?" Most chore apps focus on what's coming up. lastGLANCE focuses on what's already been done.

## Visual concept

Horizontal ribbon view, one line per chore, grouped by user-defined category. Consistent with dayGLANCE and lifeGLANCE's timeline-based visual language.

- Each chore is a horizontal bar/line showing time since last completion
- Color gradient reflects how long it's been, softening the "overdue" concept into a continuous visual signal rather than a binary flag
- No cadence set = neutral gray track, pure information, no color logic
- Cadence set = bar fills proportionally as elapsed time approaches target, color shifts through ramp (fresh → getting stale → really overdue)
- Scrollable left-to-right for history, similar to lifeGLANCE
- Large screens: show multiple categories simultaneously (e.g. 4 at once)
- Phone: one category at a time, swipe/tab between

Tap any row to log completion.

## Data model (draft)

### Chore
- `id`
- `name` (e.g. "Mop kitchen")
- `category_id` (FK)
- `target_cadence_days` (nullable — null means no target)
- `auto_schedule_to_dayglance` (bool, requires `target_cadence_days` to be set)
- `preferred_schedule_behavior` (enum: "today" | "next_weekend" | "next_free_day" — TBD)
- `created_at`, `updated_at`

### Category
- `id`
- `name` (e.g. "Home", "Pets", "Vehicle", "Deep clean")
- `sort_order`

User decides granularity. Fish tank water changes can be one chore or five — up to the user. No sub-chore machinery in v1.

### CompletionEvent
- `id`
- `chore_id` (FK)
- `completed_at` (timestamp)
- `note` (optional, free text — "did both tanks", "only the front bathroom")
- `source` (enum: "manual" | "dayglance" — tracks whether completion came from the lastGLANCE app directly or via the dayGLANCE integration loopback)

## Cadence behavior

**Default: no target.** User opts in per chore.

When a target is set:
- It's a soft expectation, not a deadline
- UI renders it as a gradient, not a binary past/not-past
- Missing the target generates no alert by default — the color shift IS the signal
- User can optionally flip on "auto-schedule to dayGLANCE when due" per chore

Cadence storage: single `target_cadence_days` integer. UI handles the softening via gradient rendering. Keeps the data model simple; the "ish" lives in the presentation layer.

**Future consideration:** AI-inferred cadence after enough completion history exists. Not v1, but the data model supports it — completion history is already being recorded, so cadence inference is a later addition without schema changes.

## dayGLANCE integration

The key power-up. Standalone app that gains significant power when paired with dayGLANCE, via the intent protocol (see `dayglance-intent-protocol.md`). lastGLANCE is the second consumer of the protocol after Tasker, and the one that drove its bidirectional design.

### Flows

**lastGLANCE → dayGLANCE (manual):**
- User taps a chore, selects "do this today" or similar
- lastGLANCE fires an `app.dayglance.CREATE` intent: title, due date, `source_app=app.lastglance`, `source_entity_id=<chore_id>`
- Task appears in dayGLANCE on that day

**lastGLANCE → dayGLANCE (automatic, when enabled per chore):**
- When a chore with `auto_schedule_to_dayglance=true` crosses its cadence threshold
- lastGLANCE auto-fires the `create` intent
- Task appears in dayGLANCE without user action

**dayGLANCE → lastGLANCE (completion loopback):**
- When a lastGLANCE-originated task is completed in dayGLANCE, dayGLANCE broadcasts `app.dayglance.NOTIFY` with `event=completed`, `source_app=app.lastglance`, and the round-tripped `source_entity_id`
- lastGLANCE receives the broadcast, filters on `source_app=app.lastglance` to ignore events meant for other consumers, and logs a CompletionEvent with `source="dayglance"`
- Ribbon updates

### Contract

Uses the dayGLANCE intent protocol exactly as specced. No protocol work specific to lastGLANCE.

**Outbound from lastGLANCE:** fires `create` intents against dayGLANCE. Every `create` includes:
- `source_app=app.lastglance`
- `source_entity_id=<chore_id>`
- `title`, `due`, and any other fields the user has configured

**Inbound to lastGLANCE:** subscribes to `app.dayglance.NOTIFY` broadcasts. Filters on `source_app=app.lastglance`. Reacts to `event=completed` by logging a CompletionEvent with `source="dayglance"`. Other events (`rescheduled`, `deleted`, `updated`) can be handled later; v1 only needs `completed`.

### Duplicate prevention

Handled at the protocol level. dayGLANCE matches incoming `create` intents on `source_app` + `source_entity_id` + `due` and updates the existing task rather than creating a duplicate. This means a chore auto-scheduling and the user subsequently triggering it manually results in one task, not two. No lastGLANCE-side logic required.

### Standalone operation

lastGLANCE must be fully useful without dayGLANCE installed. The integration is a power-up, not a dependency. Detect absence of dayGLANCE at install/runtime, hide the relevant UI, app still works.

This is a hard rule. The target audience includes people who want "last done" tracking but don't want a day planner — that user is served by lastGLANCE on its own and never gets nudged toward dayGLANCE.

## Standalone-first decision

**Decision: standalone app, integrated via the intent protocol when paired with dayGLANCE.**

Rationale:
- Target audience includes people who want "last done" tracking but don't want a day planner. The FOSS/self-hosted community contains plenty of users in that bucket.
- "Chore tracker that talks to dayGLANCE" is a stronger pitch than "dayGLANCE has a chores tab."
- Establishes the GLANCE family as a constellation of focused apps connected by a shared protocol, rather than a monolith with feature creep.
- Precedent: lifeGLANCE is standalone, lastGLANCE follows the same pattern.

Cost acknowledged: full integration layer (intents, completion loopback, duplicate handling, standalone mode detection) rather than just shared database access. Shares the dayGLANCE intent protocol with Tasker and any future GLANCE-family app; no protocol work specific to lastGLANCE.

## Open questions

- **Preferred schedule behavior options.** "Today" vs "next weekend" vs "next free day" — what does the user actually want to pick from? Might be simpler than this list.
- **Backdating completions.** One-tap log is the primary flow. Optional "done it earlier" backdate should be supported but not primary. How prominent in the UI?
- **History visualization.** The ribbon shows recent state. What does zoomed-out history look like? Per-chore drill-down with completion timeline? Weekly/monthly heatmap view?
- **Notifications.** Default is no nagging. But some users will want a subtle nudge. Opt-in per chore? Opt-in globally? Separate from auto-schedule?

## Architectural notes

- Local-first, privacy-first, consistent with rest of GLANCE family
- Likely reuses WebView hybrid Android pattern from dayGLANCE
- SQLite schema (no cloud sync required for v1)
- Docker + Vercel deployment pattern if a web version is in scope
- GitHub distribution via Obtainium, potential Play Store presence
- Electron, Android, and iOS builds follow the standalone web/Android v1, in that order

## What's NOT in v1

- Sub-chores / hierarchical chore structures (user controls granularity by splitting)
- AI-inferred cadence (data model supports it; UI/logic deferred)
- Notifications beyond dayGLANCE auto-scheduling
- Cloud sync (deferred, same rationale as dayGLANCE; if paid sync ever ships across the family, lastGLANCE adopts it then)
- iOS version (follows the standalone Android version)
- lifeGLANCE integration (focus is dayGLANCE pairing first)
- TRMNL plugin (possible later as a standalone lastGLANCE-specific plugin, not v1)

## Brief summary / elevator pitch

Track when you last did stuff. If you want, set a cadence and it'll schedule itself in dayGLANCE when it's time. No guilt, no nagging, just information.
