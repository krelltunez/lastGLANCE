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

The key power-up. Standalone app that gains significant power when paired with dayGLANCE, via the intent protocol (see `dayglance-intent-protocol.md`). lastGLANCE is the GLANCE-family consumer the bidirectional design was built around: specifically, the requirement that a completion happening on one device propagate to lastGLANCE on another device, anywhere in the world. The WebDAV event log transport in the intent protocol exists to satisfy this requirement.

### Flows

**lastGLANCE → dayGLANCE (manual):**
- User taps a chore, selects "do this today" or similar
- lastGLANCE emits a `create` action against dayGLANCE: title, due date, `source_app=app.lastglance`, `source_entity_id=<chore_id>`
- Task appears in dayGLANCE on that day (immediately on same-device Android via intent; within polling interval cross-device via WebDAV)

**lastGLANCE → dayGLANCE (automatic, when enabled per chore):**
- When a chore with `auto_schedule_to_dayglance=true` crosses its cadence threshold
- lastGLANCE auto-emits the `create` action
- Task appears in dayGLANCE without user action

**dayGLANCE → lastGLANCE (completion loopback):**
- When a lastGLANCE-originated task is completed in dayGLANCE, dayGLANCE emits a `notify` event with `event=completed`, `source_app=app.lastglance`, and the round-tripped `source_entity_id`
- lastGLANCE receives the event (via WebDAV poll or Android broadcast), filters on `source_app=app.lastglance` to ignore events meant for other consumers, and logs a CompletionEvent with `source="dayglance"`
- Ribbon updates

This is the flow that motivates the WebDAV transport: a user completing a task on their phone away from home, and lastGLANCE on their home desktop reflecting that completion the next time it polls.

### Contract

Uses the dayGLANCE intent protocol exactly as specced. No protocol work specific to lastGLANCE.

Primary transport is the WebDAV event log (cross-platform, cross-network, cross-device). When both apps are running natively on the same Android device, the Android intent transport may be used as a low-latency optimization. The lastGLANCE consumer treats both transports uniformly: same payload shape, same handler logic, idempotent dedup on `event_id`.

**Outbound from lastGLANCE:** emits `create` actions to dayGLANCE. Every `create` includes:
- `source_app=app.lastglance`
- `source_entity_id=<chore_id>`
- `title`, `due`, and any other fields the user has configured

**Inbound to lastGLANCE:** subscribes to `notify` events (by polling the WebDAV event log, by registering for `app.dayglance.NOTIFY` Android broadcasts when on Android with both apps installed, or both). Filters on `source_app=app.lastglance`. Reacts to `event=completed` by logging a CompletionEvent with `source="dayglance"`. Other events (`rescheduled`, `deleted`, `updated`) can be handled later; v1 only needs `completed`.

### Duplicate prevention

Handled at the protocol level. dayGLANCE matches incoming `create` intents on `source_app` + `source_entity_id` + `due` and updates the existing task rather than creating a duplicate. This means a chore auto-scheduling and the user subsequently triggering it manually results in one task, not two. No lastGLANCE-side logic required.

### Standalone operation

lastGLANCE must be fully useful without dayGLANCE installed *and* without WebDAV configured. The integration is a power-up, not a dependency. Detect each prerequisite independently at install/runtime, hide the relevant UI when missing, app still works in every degraded configuration.

This is a hard rule. The target audience includes people who want "last done" tracking but don't want a day planner; that user is served by lastGLANCE on its own and never gets nudged toward dayGLANCE. The audience also includes users who self-host but haven't set up WebDAV; that user gets dayGLANCE integration on the same device via Android intents (when applicable), and is informed that cross-device integration requires WebDAV.

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
- Reuses WebView hybrid Android pattern from dayGLANCE
- SQLite schema on Android, Dexie/IndexedDB on web (no cloud sync for lastGLANCE's own data in v1; cross-app integration is via WebDAV per the intent protocol)
- Docker + Vercel deployment pattern for the web version, consistent with dayGLANCE and lifeGLANCE
- GitHub distribution via Obtainium for Android, potential Play Store presence
- Web, Android, iOS, and Electron all ship as v1.0.0 in the multi-platform release

## What's NOT in v1

- Sub-chores / hierarchical chore structures (user controls granularity by splitting)
- AI-inferred cadence (data model supports it; UI/logic deferred)
- Notifications beyond dayGLANCE auto-scheduling
- Cloud sync for lastGLANCE's own data across devices (deferred, same rationale as dayGLANCE; if GLANCEcloud ever ships across the family, lastGLANCE adopts it then). Note: this is distinct from the WebDAV event log used for cross-app integration with dayGLANCE, which is in v1.
- lifeGLANCE integration (focus is dayGLANCE pairing first)
- TRMNL plugin (possible later as a standalone lastGLANCE-specific plugin, not v1)

## Brief summary / elevator pitch

Track when you last did stuff. If you want, set a cadence and it'll schedule itself in dayGLANCE when it's time. No guilt, no nagging, just information.

---

## Status

**As of May 2026 — active development, web PWA v1 in progress.**

### Decisions made

- **Storage: Dexie (IndexedDB) for web, native SQLite for Android.** SQLite WASM requires `Atomics.wait()` which is blocked on the browser main thread; OPFS persistence is only possible from a dedicated worker. Dexie provides equivalent local-first persistence via IndexedDB with no worker or special HTTP headers required. The TypeScript data model is identical across both targets.
- **Standalone web-first, then Android, iOS, and Electron all ship as v1.0.0.** Web PWA is the lead surface and proves the product; platform wrappers follow.
- **React 19 + Vite + Tailwind CSS + TypeScript.** Consistent with dayGLANCE stack.
- **Full PWA support from day one.** Service worker, offline precache, installable.

### What's built

- Project scaffold: Vite + React 19 + TypeScript, Tailwind, vite-plugin-pwa
- Dexie data layer: schema, all CRUD queries for Category, Chore, CompletionEvent
- Ribbon UI: category tabs (mobile) / side-by-side columns (desktop), chore rows with color-gradient cadence bars
- Cadence color logic: green → amber → red gradient based on elapsed/target ratio
- Log completion flow: tap-to-log modal with optional note and backdate
- Elapsed time display: "just now" / "5m ago" / "2h ago" / "3d ago"
- Management UI: edit mode toggle in header; add/edit/delete categories and chores; cadence field per chore; confirmation dialogs for destructive actions
- Per-chore history drill-down: tap a chore name to open a detail view of past completions (timestamp, note, source); delete individual completions
- Full PWA asset set: app icons at all standard sizes, maskable variants, apple-touch-icon, favicon, manifest configured
- Seed data: 4 categories, 10 chores

### What's not built yet (v1 remaining)

- Responsive layout work: refinement across screen sizes (small phones, tablets, desktop widths). Ribbon, category navigation, and management UI all need a pass for breakpoint behavior.
- dayGLANCE intent integration (outbound `create`, inbound `notify` loopback over WebDAV; Android broadcast on Android when applicable)
- Design pass (visual identity, color, typography, ribbon visual weight, icons)
- Docker + docker-compose.yml for self-hosters, consistent with dayGLANCE and lifeGLANCE distribution
- Android wrapper (WebView shell, native SQLite swap-in, intent protocol wiring, Obtainium distribution)
- iOS app (PWA-shell or wrapped, follows the standalone Android version)
- Electron app (desktop build, consistent with dayGLANCE Desktop pattern)

## Build plan

Remaining v1 work in order:

1. **Responsive layout pass** — refine the layout across the screen-size matrix (small phones up through wide desktop). Ribbon row height and label placement, category navigation between tabs and side-by-side columns, management UI density, modal sizing on small screens. The current layout works at the sizes it was built against; this pass takes it from "works" to "feels intentional on every device."

2. **dayGLANCE integration** — outbound `create` action emitted to dayGLANCE when user schedules a chore manually or auto-schedule fires; inbound subscription to `notify` events (WebDAV poll on web/iOS/Electron, Android broadcast on Android when applicable) that logs a CompletionEvent with `source="dayglance"` for `event=completed`. Detect dayGLANCE absence and WebDAV absence independently at runtime; hide integration UI accordingly. Per-chore `auto_schedule_to_dayglance` toggle lives in the chore edit form. WebDAV endpoint config lives in app settings (defaults to same endpoint dayGLANCE uses, if discoverable).

3. **Design pass** — the app is functional but not publish-ready. Full pass covers:
   - **Color and typography** — move away from generic slate palette; establish a visual identity consistent with the GLANCE family. Consider a signature accent color, tighter typographic scale, and more intentional use of weight/spacing in the ribbon.
   - **Category and chore icons** — user-selectable icon per category and per chore. Implementation: add optional `icon` field to Category and Chore (Dexie schema v2 migration); curate ~100 relevant lucide icons (home, cleaning, pet, vehicle, garden, etc.) as a static registry; build a scrollable icon picker grid (possibly filterable) used from both the category and chore edit forms; render icons in category headers and chore rows.
   - **Ribbon visual weight** — the horizontal bar is the core visual metaphor; it should feel more intentional. Consider height, corner radius, label placement, and whether the elapsed text lives on the bar or beside it.
   - **Empty and loading states** — polish the empty state illustration/copy and the initial load experience.

4. **Docker distribution** — Dockerfile and `docker-compose.yml` for self-hosters. Consistent with dayGLANCE and lifeGLANCE distribution: static file server (nginx or similar) serving the built PWA, single image published to GHCR, single-service compose file. Document the image at ghcr.io/krelltunez/lastglance (or equivalent) and the standard port.

5. **Android wrapper** — WebView shell, native SQLite swap-in replacing Dexie, intent protocol wiring for dayGLANCE integration (Android intent transport in addition to WebDAV), Obtainium distribution, eventual Google Play presence.

6. **iOS app** — PWA-shell or native wrapper, follows the standalone Android version. WebDAV transport is the integration path on iOS (no Android intent equivalent). Background polling caveats apply.

7. **Electron app** — desktop build, consistent with the dayGLANCE Desktop pattern. WebDAV transport for cross-app integration; no local server needed unless lastGLANCE later gains an integration that requires one (none planned for v1).
