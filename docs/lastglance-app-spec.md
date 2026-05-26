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

Tagline: **"when did you last...?"** — the product in five words. Frames the use case as a question the user is already asking themselves rather than a schedule the app is imposing.

Wordmark: `last` in regular weight, `GLANCE` in bold italic. Terminal-phosphor green accent color, dark palette. Distinct from dayGLANCE (Lora, blue/orange) and lifeGLANCE (Courier Prime, amber/indigo/coral); shares the GLANCE family DNA via wordmark structure but stakes out its own color identity. Green ties thematically to the "done" semantic at the heart of the product.

**Dashboard layout: freeform masonry of category cards.** Each category is a card; chores live inside as horizontal ribbon rows. Cards size to their content (no forced height normalization) and the user arranges them spatially however they think about their own categories. The masonry is the layout that makes lastGLANCE feel like *theirs*; it's a hard decision and has implications elsewhere (see "Detail view" below).

**Header strip: contribution-graph-style activity visualization.** A GitHub-style heatmap of aggregate completion activity across the user's history, sitting next to the wordmark. Instantly legible visual idiom, reinforces the "last done" thesis, gives the top bar a satisfying horizontal balance.

**Chore cards are the ribbons.** Each chore card is a horizontal stripe with a left-edge color anchor that encodes recency, the chore name and last-done timestamp inside, and a "Done" action button on the right. The "ribbon" isn't a separate visualization with cards inside it — the cards themselves are the ribbons. One element doing the work of two.

Per-chore visual encoding:

- Each chore is a horizontal bar/line showing time since last completion
- Color gradient reflects how long it's been, softening the "overdue" concept into a continuous visual signal rather than a binary flag
- No cadence set = neutral gray track, pure information, no color logic
- Cadence set = bar fills proportionally as elapsed time approaches target, color shifts through ramp (green → amber → orange → red)
- Large screens: multiple category cards arranged in masonry (typically 3-4 columns)
- Phone: single-column stack, scroll vertically

Tap "Done" on any row to log completion. Tap the chore name/body to open the detail view.

### Detail view

Tap a chore card to open a per-chore detail view as a modal overlay over a darkened-but-not-blacked-out dashboard. The overlay (rather than in-place expansion) is necessary because of the masonry layout — there's no clean way to push siblings around without reflowing the whole layout and breaking the user's mental map of where everything lives. The overlay also gives the detail view as much horizontal space as it needs without being constrained by parent card width, which the contribution graph in particular benefits from.

Detail view contents:

- **Stats row at top:** Total (completion count), Avg interval (realized cadence from completion history), Target (configured `target_cadence_days`, or em-dash if no cadence set). The gap between Avg interval and Target is genuinely useful information: "I aim for every 14d but I actually do it every 22d on average."
- **Past-year contribution graph:** per-chore, mirroring the dashboard header strip's visual idiom but scoped to one chore. Beautiful consistency across the two levels of aggregation.
- **History list:** completions with absolute timestamps ("Apr 12, 2026 12:00 PM"). Absolute timestamps in history (forensic work), relative timestamps on the dashboard (at-a-glance). Right tool, right context.
- **Per-completion notes:** notes are attached to a specific completion, not the chore globally. Chore-level notes would be generic ("the front bathroom takes longer"); completion-level notes are specific to the instance ("only did the front bathroom this time because the back is being remodeled"). Specific, preserved in history, matches how people actually think about chores.
- **"Done earlier?" backdate field:** addresses the empty-state onboarding problem — users can backfill past completions when first setting up the app, bootstrapping the contribution graph and stats from day one rather than starting from a dead-empty state.

This is also where AI features will live in the future (see "AI" section below).

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

## AI

**BYO API key.** Consistent with the GLANCE family's "your data, your services, your call" stance. Self-hosters bring their own Anthropic, OpenAI, or compatible-API key; the app doesn't phone home for inference. No separate billing relationship for the project to manage, no free-tier-vs-paid-tier split in the UX. Everyone gets the same lastGLANCE; if you want AI features, you plug in a key.

**Surface: detail view, not dashboard.** AI features live in the per-chore detail view. The dashboard is the at-a-glance read; cluttering it with AI suggestions would compete with the core scan-and-act loop. The detail view is where users are already in "thinking mode" — examining history, considering whether the cadence is right — so AI prompts there feel like a research assistant rather than a chatbot interrupting the morning.

**v1 features:** none. AI is deferred past v1.0.0. The detail view is structured to support AI additions later (Total / Avg interval / Target / completion history / per-completion notes is the data substrate AI would consume).

**Implementation considerations** (for when AI ships):

- **Provider abstraction.** Build against a thin internal interface from the start so users can BYO their preferred provider — Anthropic, OpenAI, OpenAI-compatible endpoints, local Ollama — with one config change. The audience here will request Ollama.
- **Key storage:** local browser storage for web, native secure storage (Keystore on Android, Keychain on iOS) for native apps, env var or config file for Docker. Self-hosters care about this; document it clearly.
- **Privacy granularity:** a per-call or global "include notes in AI requests" toggle. Some users will have sensitive completion notes and may not want them leaving the device even with their own key.
- **Model defaults:** smart default (e.g. Haiku for cost) with an advanced override for users who want to pick.

## dayGLANCE integration

The key power-up. Standalone app that gains significant power when paired with dayGLANCE, via the intent protocol (see `dayglance-intent-protocol.md`). lastGLANCE is the GLANCE-family consumer the bidirectional design was built around: specifically, the requirement that a completion happening on one device propagate to lastGLANCE on another device, anywhere in the world. The WebDAV event log transport in the intent protocol exists to satisfy this requirement.

### Flows

The dayGLANCE integration is primarily a **moment-of-action** surface, not a per-chore configuration surface. The user's actual intent is "this specific chore is due *and* I want to schedule it today" — a per-instance decision that may go differently from one cycle to the next depending on what's on their plate. The integration is exposed accordingly:

**Primary surface 1 — Card-level affordance:** when a chore's cadence crosses a threshold (e.g. enters the amber/orange zone), an unobtrusive `+ dG` button appears on the chore card. The user is scanning the dashboard, sees a chore tilting toward overdue, and the affordance surfaces the option without nagging.

**Primary surface 2 — Overdue notification popup:** when a chore crosses overdue and the optional "Notify when overdue" notification fires, the popup includes a "Send to dayGLANCE" button. One tap from notification to scheduled, friction-free, contextually obvious.

**Secondary surface — Per-chore `auto_schedule_to_dayglance` toggle:** for users who want set-and-forget auto-scheduling on a specific chore, the toggle exists in the chore edit form. Default off; integration is a power-up, not a default-on behavior. When enabled, a chore crossing its cadence threshold auto-emits the `create` action without user action.

**lastGLANCE → dayGLANCE (manual via card/notification button):**
- User taps `+ dG` on a card, or "Send to dayGLANCE" on the overdue notification popup
- lastGLANCE emits a `create` action against dayGLANCE: title, due date (today by default), `source_app=app.lastglance`, `source_entity_id=<chore_id>`
- Task appears in dayGLANCE on that day (immediately on same-device Android via intent; within polling interval cross-device via WebDAV)

**lastGLANCE → dayGLANCE (automatic, when `auto_schedule_to_dayglance=true`):**
- When a chore with `auto_schedule_to_dayglance=true` crosses its cadence threshold
- lastGLANCE auto-emits the `create` action
- Task appears in dayGLANCE without user action

**dayGLANCE → lastGLANCE (completion loopback):**
- When a lastGLANCE-originated task is completed in dayGLANCE, dayGLANCE emits a `notify` event with `event=completed`, `source_app=app.lastglance`, and the round-tripped `source_entity_id`
- lastGLANCE receives the event (via WebDAV poll or Android broadcast), filters on `source_app=app.lastglance` to ignore events meant for other consumers, and logs a CompletionEvent with `source="dayglance"`
- Ribbon updates

This is the flow that motivates the WebDAV transport: a user completing a task on their phone away from home, and lastGLANCE on their home desktop reflecting that completion the next time it polls.

### Contract

lastGLANCE consumes the shared `@glance-apps/intents` package for schema validation, normalization, idempotency key generation, and WebDAV envelope handling. The package is published independently and is the source of truth for the protocol shape; lastGLANCE-side logic is limited to outbound `create` emission, inbound `notify` consumption, standalone-mode detection, and UI.

Primary transport is the WebDAV event log (cross-platform, cross-network, cross-device). When both apps are running natively on the same Android device, the Android intent transport may be used as a low-latency optimization. The lastGLANCE consumer treats both transports uniformly: same payload shape, same handler logic, idempotent dedup on `event_id`.

**Outbound from lastGLANCE:** emits `create` actions to dayGLANCE. Every `create` includes:
- `source_app=app.lastglance`
- `source_entity_id=<chore_id>`
- `title`, `due`, and any other fields the user has configured

**Inbound to lastGLANCE:** subscribes to `notify` events (by polling the WebDAV event log, by registering for `app.dayglance.NOTIFY` Android broadcasts when on Android with both apps installed, or both). Filters on `source_app=app.lastglance`. Reacts to `event=completed` by logging a CompletionEvent with `source="dayglance"`. Other events (`uncompleted`, `rescheduled`, `deleted`, `updated`) are accepted by the package's schema but ignored by lastGLANCE in v1. If a user wants to remove a completion that originated from a dayGLANCE un-completion, they delete the CompletionEvent manually in lastGLANCE.

**Encryption (optional):** the WebDAV intent transport supports optional AES-GCM encryption of event payloads. Encryption is gated on cloud sync encryption being enabled. At intents-encryption setup, lastGLANCE derives an intents-owned HKDF root key from the cloud sync passphrase plus a shared root salt stored on the WebDAV endpoint, caches that root key non-extractably in IndexedDB, and discards the passphrase. After setup, every envelope encrypts with a unique AES-GCM key derived via HKDF from the cached root key plus a fresh per-envelope salt; the passphrase is never needed again. The cross-app shared root salt means both lastGLANCE and dayGLANCE derive the same root key, so they can encrypt and decrypt each other's envelopes without coordinating sessions. Plaintext and encrypted events coexist in the same directory; consumers without a configured root key skip encrypted events and log a warning. The Android intent transport remains plaintext (intra-device, OS-level access controls apply); encryption only affects the WebDAV path. See `dayglance-intents-package.md` Phase 2.7 for the envelope spec and the rationale.

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

- **Preferred schedule behavior options.** "Today" vs "next weekend" vs "next free day" — what does the user actually want to pick from? Might be simpler than this list. Current default for the card/notification button is "today"; multi-option selector may be a v1.1 refinement.
- **Notifications beyond "Notify when overdue".** Current per-chore toggle fires a notification when a chore with a cadence crosses overdue. Some users may want subtler nudges (e.g. "approaching cadence" rather than "overdue"). Opt-in per chore? Opt-in globally? Defer to user feedback after v1.0.0 ships.

## Architectural notes

- Local-first, privacy-first, consistent with rest of GLANCE family
- Reuses WebView hybrid Android pattern from dayGLANCE
- SQLite schema on Android, Dexie/IndexedDB on web (no cloud sync for lastGLANCE's own data in v1; cross-app integration is via WebDAV per the intent protocol)
- Docker + Vercel deployment pattern for the web version, consistent with dayGLANCE and lifeGLANCE
- GitHub distribution via Obtainium for Android, potential Play Store presence
- Web, Android, iOS, and Electron all ship as v1.0.0 in the multi-platform release

## What's NOT in v1

- AI-inferred cadence (data model supports it; UI/logic deferred)
- lifeGLANCE integration (focus is dayGLANCE pairing first)
- TRMNL plugin (possible later as a standalone lastGLANCE-specific plugin, not v1)

## Brief summary / elevator pitch

Track when you last did stuff. If you want, set a cadence and it'll schedule itself in dayGLANCE when it's time. No guilt, no nagging, just information.

---

## Status

**v1.0.0 shipped May 2026** — web PWA with full dayGLANCE integration (encrypted intent transport via Phase 2.7 of the intents package) and cloud sync with remote backup. Released in coordination with dayGLANCE v2.12.0.

### Locked architectural decisions

- **Storage: Dexie (IndexedDB) for web, native SQLite for Android.** SQLite WASM requires `Atomics.wait()` which is blocked on the browser main thread; OPFS persistence is only possible from a dedicated worker. Dexie provides equivalent local-first persistence via IndexedDB with no worker or special HTTP headers required. The TypeScript data model is identical across both targets.
- **Standalone web-first, then Android, iOS, and Electron as separate releases.** Web PWA is the lead surface and is the v1.0.0 release; platform wrappers follow as their own version trains.
- **React 19 + Vite + Tailwind CSS + TypeScript.** Consistent with dayGLANCE stack.
- **Full PWA support from day one.** Service worker, offline precache, installable.
- **Shared `@glance-apps/intents` package for protocol implementation.** lastGLANCE consumes the published package rather than re-implementing protocol logic. Schema decisions and package build history are in `dayglance-intents-package.md`.
- **Optional encryption for WebDAV intent transport.** Gated on cloud sync encryption being enabled. Uses an intents-owned HKDF root key derived once at intents-encryption setup from the cloud sync passphrase plus a shared root salt stored on the WebDAV endpoint. Per-envelope encryption key is derived via HKDF from the cached root key plus a fresh per-envelope salt; passphrase is needed only at setup. Set-and-forget UX across app sessions. AES-GCM cipher. Independent toggle in integration settings. Android intent transport stays plaintext (intra-device).
- **AI is BYO key, deferred past v1.0.0.** See "AI" section above.
- **Visual identity is locked** (terminal-phosphor green wordmark, dark palette, masonry layout, contribution-graph header strip, color-gradient ribbon encoding).

### Shipped in v1.0.0

- Project scaffold: Vite + React 19 + TypeScript, Tailwind, vite-plugin-pwa
- Dexie data layer: schema, all CRUD queries for Category, Chore, CompletionEvent
- Dashboard with freeform masonry layout: category cards arranged by user, each containing chore ribbon rows with color-gradient cadence encoding
- Contribution-graph header strip showing aggregate completion activity
- Visual identity: terminal-phosphor green wordmark, dark palette, "when did you last...?" tagline
- Cadence color logic: green → amber → orange → red gradient based on elapsed/target ratio
- Log completion flow: tap "Done" on a chore row to log; modal allows optional note and backdate
- Elapsed time display on cards: "just now" / "5m ago" / "2h ago" / "3d ago" / "13d ago" / "never"
- Management UI: edit mode toggle in header; add/edit/delete categories and chores; cadence field per chore; icon picker per chore and category; confirmation dialogs for destructive actions; drag handles for reordering categories (masonry) and chores within a category
- Per-chore edit modal: name, icon, category, optional cadence (days), "Notify when overdue" toggle (only appears when cadence is set — progressive disclosure)
- Per-chore detail view (modal overlay over darkened dashboard): stats row (Total, Avg interval, Target), past-year contribution graph, history list with absolute timestamps, per-completion notes, "Done earlier?" backdate field
- Full PWA asset set: app icons at all standard sizes, maskable variants, apple-touch-icon, favicon, manifest configured
- Docker + docker-compose.yml for self-hosters, consistent with dayGLANCE and lifeGLANCE distribution
- Responsive layout across small phones, tablets, desktop widths
- Search and subcategories
- **dayGLANCE intent integration:** card-level `+ dG` button when cadence threshold crossed, "Send to dayGLANCE" button in overdue notification popup, per-chore `auto_schedule_to_dayglance` toggle in edit form. Outbound `create` action on user trigger or auto-schedule. Inbound subscription to `notify` events over WebDAV that logs a CompletionEvent with `source="dayglance"` for `event=completed`. Detects dayGLANCE absence and WebDAV absence independently at runtime; hides integration UI accordingly.
- **Optional intents encryption** via Phase 2.7 of the intents package: HKDF-per-envelope key derivation against an intents-owned cached root key. Set-and-forget UX (passphrase needed only at intents-encryption setup, never on subsequent app sessions). Cross-app key agreement via shared root salt stored on the WebDAV endpoint.
- **Cloud sync via `@glance-apps/sync`:** local-first with optional WebDAV-backed sync. Encryption keyed on a passphrase; derived non-extractable `CryptoKey` cached in IndexedDB.
- **Remote backup to WebDAV.**

### Roadmap beyond v1.0.0

1. **Android wrapper** — WebView shell, native SQLite swap-in replacing Dexie, intent protocol wiring for dayGLANCE integration (Android intent transport in addition to WebDAV), Obtainium distribution, eventual Google Play presence.
2. **iOS app** — PWA-shell or native wrapper. WebDAV transport is the integration path on iOS (no Android intent equivalent). Background polling caveats apply.
3. **Electron app** — desktop build, consistent with the dayGLANCE Desktop pattern. WebDAV transport for cross-app integration.
4. **AI (BYO key)** — see "AI" section above. Deferred past v1.0.0 release. Triggers and surface design specced; provider integration and prompt engineering remain.
