# GLANCElauncher integration

How lastGLANCE hands its data to the GLANCElauncher and takes writes back. The
launcher's side of the design is `SPEC.md` ("Real data") in the launcher repo;
this is the app's half, built to the same pattern as dayGLANCE's
`docs/launcher-integration.md`.

lastGLANCE's data lives in the WebView's IndexedDB, which native code cannot
read. The native side has only what the web layer pushes, so the launcher
reads a **snapshot** the app builds, and its writes reach the app the way the
automation intents do: queued natively, drained by the web layer when it runs.

## Reads: the launcher snapshot and the provider

`src/native/launcherSnapshot.ts` builds the snapshot from plain inputs;
`src/hooks/useLauncherSnapshot.ts` loads them, runs on the widget snapshot's
triggers (mount, a chore logged, a sync applied, People changed, the app
backgrounded) plus a launcher write landing and the day rolling over, and
pushes through the `LauncherBridge` plugin only when the content changed. The
widget snapshot and its hook are untouched. Shape:

```
{ version: 1, updatedAt, timezone, today,
  chores: [{ id, name, category, categoryId, targetCadenceDays, lastDoneAt, elapsedDays,
             icon, updatedAt, clientId, pinned }],
  people: [{ id, name, nickname, circle, circleId, targetCadenceDays, lastInteractionAt,
             lastChannel, unreturned, snoozedUntil,
             dates: [{ id, kind, label, month, day, year }], updatedAt }],
  handledWrites: [{ clientId, action, entityId, at }] }
```

Ids are the rows' `sync_id`s, the ids the launcher writes back by. Chores
follow the widgets' "Mine" rule under multi-user; people are the ones this
user sees, archived left out, snoozed included with `snoozedUntil` so the
launcher can hide them the way the app does.

`LauncherProvider` (`android/.../launcher/`) serves it read-only at
`content://com.lastglance.app.launcher/<collection>` for `chores`, `people`
and `meta` (one row: version, updatedAt, timezone, today, handledWrites).
Each cursor has `_id`, `id` and `json` columns, the row as JSON. Every push
calls `notifyChange` on the authority, so a `ContentObserver` registered on
any collection URI sees every change. `insert`, `update` and `delete` throw.

## Freshness: the heartbeat and REFRESH

The snapshot is pushed only when its content changes, so `meta.updatedAt` says
when something last moved, not when the app last looked. Two more stamps say
that, written natively by `LauncherBridgePlugin.touchHeartbeat` and merged into
`meta` by the provider:

- `checkedAt` (ms): every run of the snapshot builder, changed or not, and
  every return to the foreground.
- `syncedAt` (ISO): the latest completed cycle across the roads that are on
  (the file engine's and the vault engine's `getLastSynced`), the moment other
  devices' changes are known to be in. Null without one.

`meta` also carries `rendererAlive` (whether the Capacitor bridge is loaded in
the process at the moment of the read), `headlessRunning` (whether a headless
refresh's WebView exists, below) and `refreshLog`, the last 20 REFRESH
requests.

**`com.lastglance.app.launcher.REFRESH`** asks the app to confirm its data now.
It is not a write: it carries a `clientId` for dedupe and logging only, is never
in the handled ledger, and the launcher sends it outside its outbox. The
receiver routes it by liveness and logs every request with the liveness it saw:

| Outcome | When |
| --- | --- |
| `queued` | the renderer is alive: queued and woken, and held awake (below); the web layer runs every road (chores and People, file and vault) to completion, re-pushes, re-stamps the heartbeat, then reports `ran` (with `durationMs`) or `failed` (with `reason`) into the same entry |
| `scheduled` | no renderer in the process: a headless run is enqueued (below); the worker adds `startedAt`, `waitMs` (how long the OS held the job) and `headless: true` when it runs, then the outcome |
| `coalesced` | a queued or scheduled refresh from the last minute has no outcome yet |
| `unanswered` | a `queued` refresh the web layer did not answer while `LauncherAwakeWorker` held the app awake; `reason` says how far it got (the wake never reached the app; the app was woken but the page never took it; or the page took it and did not finish), how long the hold lasted and how late it began (Android can hold the job itself back). `wokenAt` and `pickedUpAt` stamp the first two steps (`LauncherRefreshTrace`), `holdStartedAt` and `finishedAt` the hold. A cycle that hangs once taken reports `failed` after 45 s instead, naming the tiers still running (`REFRESH_CAP_MS`). After two minutes or more in the background, a page that left a refresh unanswered is closed, as a swipe from Recents would, once it answers the retire check (a script handed to it directly); the reason then ends "the app closed the unresponsive page, and a headless refresh follows", and a `<clientId>-headless` entry follows (`LauncherPageRetire`). Otherwise it ends "the page was left open: …" |
| `throttled` | a headless run started less than ten minutes ago (reported by the worker) |
| `aborted` | the user opened the app during a headless run (the reverse lock, below) |
| `deferred` | no renderer, and the headless run could not even be enqueued |

Alive is not the same as running. Android freezes a backgrounded app's
processes, the WebView's renderer among them, a couple of minutes after it goes
idle: the receiver is thawed for the broadcast, the web layer is not, and a
queued refresh would wait for the user to next open the app. So with every
`queued` request the receiver also starts `LauncherAwakeWorker`, an expedited
WorkManager job (an app running a job is not frozen) that runs nothing itself:
it waits, at most the 60-second in-flight window, for the web layer to record
an outcome on the entry, then ends so the app can be frozen again. The cycle is
still the app's own, in its one WebView. Ported from dayGLANCE's worker of the
same name.

### The headless refresh (a dead process)

With no renderer, the receiver enqueues `LauncherRefreshWorker`: an expedited,
network-constrained, unique WorkManager job that boots the web bundle in a
WebView with no Activity, at `https://localhost/index.html?headless=refresh&clientId=…`.
main.tsx sees the query and runs `src/headless/headlessRefresh.ts` instead of
App: the sync keys, then one cycle of the same roads the alive path runs (chores
and People, file and vault), then the snapshot and heartbeat, then the outcome
through `headlessDone`, which the worker writes into the entry and tears the
WebView down.

Capacitor cannot run without an Activity, so the headless WebView has no
Capacitor bridge. It loads the app's own files (`assets/public`) at Capacitor's
own origin, `https://localhost`, which is what makes it share the app's
IndexedDB and localStorage; `HeadlessBridge` (`window.LastGlanceHeadless`)
stands in for the plugins a run touches, and nothing else:

- the secure store (`secureGet`, `secureSet`, `secureDelete`), over the same
  Keystore-backed entries as `SecureStorePlugin` (`SecureStore.java`), so the
  credentials shim and the sync-key hooks hydrate as in the app;
- HTTP (`httpRequestAsync`), on OkHttp for every verb: `nativeHttpFetch` for
  WebDAV and a `fetch` for the vault engines (`fetchImpl`), where the app has
  CapacitorHttp;
- the launcher push (`updateLauncherSnapshot`, `touchLauncherHeartbeat`);
- the run's protocol (`headlessShouldAbort`, `headlessDone`).

The list is `HEADLESS_BRIDGE_METHODS` in `src/headless/headlessMode.ts`, kept
equal to `HeadlessBridge.kt`. Those four modules ask `headlessBridge()` first;
it is null in the app, so the app's paths are unchanged.

The rules, from dayGLANCE's headless refresh (its CLAUDE.md, "Headless
refresh"):

- **An allowlist, not App with features off.** The root imports only the keys,
  the engines and the snapshot builder; main.tsx does not evaluate App's
  modules in a headless run. No UI, reminders, widgets, intents, Direct Access
  or SSE.
- **The reverse lock is signal-abort.** `MainActivity.onCreate` destroys a
  headless WebView in flight, on the main thread, before the bridge loads the
  live one; the root also asks `headlessShouldAbort` at each phase boundary.
  The app's own start runs a cycle, and a run makes no local edits, so stopping
  loses nothing.
- **Ten minutes between headless runs, a two-minute cap**
  (`HeadlessRefreshPolicy`), and a renderer that appeared while the job waited
  takes the refresh instead (`queued`, held awake as on the alive path).
- **A run's outcome names its roads.** The engines report through callbacks,
  not by throwing; a road whose last report is an error fails the run as
  `failed` with `file: …`, `vault: …` in the reason. The snapshot is pushed
  either way: another road may have applied, and `checkedAt` records the look.

The app registers its PWA service worker in the native build too, and it
controls `https://localhost`, so a headless page is served from the worker's
cache. Right after an update that can be the previous bundle, which has no
headless root and would render App instead. The worker routes the service
worker's own requests to the installed files (as Capacitor does), so its update
check sees the new version, and tears down any page that has not called the
bridge within 20 seconds (`failed`: "the page did not start a headless run").
The next run gets the new bundle.

The launcher measures staleness per app from `syncedAt` when sync is
configured and from `checkedAt` otherwise, and shows the log in its
diagnostics panel.

## Writes: the launcher receiver

`LauncherIntentReceiver` takes `com.lastglance.app.launcher.CREATE`,
`.COMPLETE` and `.LOG_INTERACTION` broadcasts with two String extras:
`payload`, a JSON object in the automation transport's shape (`title` and
optional `project` for CREATE; `chore_id` and optional `completed_at`, or
`title`, for COMPLETE; `person_id` or `name`, optional `channel`, `direction`,
`note`, `occurred_at` for LOG_INTERACTION), and `clientId`, an id the launcher
generates per write (a UUID). The receiver queues the write in its own slot
(several deep, unlike the automation transport's single slot) and sends the
same package-scoped wake broadcast, so a running app drains at once.

A write leaves the queue only once it is handled (`src/intents/launcherQueue.ts`):
`drainPendingIntents` hands the page every entry but keeps the writes
(`LauncherWriteQueue`), and each is acknowledged (`ackIntents`) when its handler
returns, which is when its database write has landed. A page that stalls in the
background, or is closed or killed first, leaves its writes for the next, which
dedupes on the id. Writes are handled before refreshes, so none waits behind a
sync cycle; a REFRESH is still taken off on read.

A write that reaches the app while it is closed does not wait for it to open:
the receiver schedules a headless run (logged as `<clientId>-write`, unless a
run is already queued or running, or one ran in the last ten minutes; the
launcher re-sends a write until it sees it land, so a later send starts it).
The run applies the queue after its roads, with the app's own handlers and
ledger, acknowledges each write, and runs the roads again to push what changed
(`src/headless/headlessRefresh.ts`). A completion applied there sends no NOTIFY
broadcast: that is a Capacitor plugin, absent from a headless run, and it was
always best-effort.

The web layer (`src/intents/launcherWrites.ts`, drained first by
`useAndroidIntentBridge`) handles each write through the automation handlers
and dedupes on `clientId` with a ledger kept in localStorage: a re-sent write
is acknowledged, never applied twice. `COMPLETE` with `chore_id` logs a
completion for that chore; `LOG_INTERACTION` uses the `clientId` as the
interaction's own `sync_id` unless the payload carries an `event_id`, so the
People data layer's own check (`interactionExists`) backs the ledger across
devices. The ledger rides the snapshot as `handledWrites`, and a chore the
launcher created carries its `clientId` in the snapshot, joined in from the
ledger rather than stored on the row: lastGLANCE's sync tiers map chore fields
one by one, so a field on the chore would have to be taught to both engines
and both apply paths, and the ledger already carries the same fact on the
device the write landed on. The launcher retires an outbox entry when the
snapshot shows its id either way.

The client id travels beside the payload rather than inside it because the
intents package's payload schemas are strict and shared with Tasker. The
receiver does not consult the "Automation intents" toggle, which keeps gating
the public transport exactly as before. No RESULT broadcast is sent for
launcher writes; the launcher reads the outcome from the next snapshot. The
activity log names the sender ("via GLANCElauncher").

## Links the launcher opens

Besides its writes, the launcher opens the app through `lastglance://` links
(`MainActivity.linkFromUri` maps each to a pending token the web app routes):
`chore/<id>`, `person/<id>`, `log/<id>`, `people`, `chores`, `filter/soon`,
`action/search`, `action/add` (the new-chore form) and `action/addPerson`
(People, with the add-person form open; the launcher's Add person). Adding a
person stays in the app's own form rather than a launcher write: a person has
circles, dates and a cadence that a one-line write would leave unset.

## Permission

Both the provider and the receiver sit behind `com.lastglance.permission.LAUNCHER`,
`protectionLevel="signature|knownSigner"`, with `knownCerts` naming the
**launcher's** signing certificates (`res/values/launcher_certs.xml`): its
release certificate, its debug certificate (removed before any public release)
and its Play app signing certificate once it ships there. lastGLANCE's own
signature satisfies the `signature` half, so the app can always reach its own
provider. `knownSigner` exists from Android 12; on older devices the permission
is signature-only and the launcher stays in demo mode. The launcher declares
`<uses-permission android:name="com.lastglance.permission.LAUNCHER" />`.

The digests in `launcher_certs.xml` are placeholders until read from the
launcher's keystores (`keytool -list -v`, SHA-256, lowercase, no colons). They
are the same three digests dayGLANCE lists.

## Verifying on a device

With the launcher's real digests in `launcher_certs.xml` and both apps installed:

1. Open lastGLANCE once so the web layer pushes. Then from a shell:
   `adb shell content query --uri content://com.lastglance.app.launcher/meta`
   prints the meta row (adb's shell holds every permission). `.../chores` and
   `.../people` list the rows; log a chore in the app and query again.
2. A write: `adb shell am broadcast -a com.lastglance.app.launcher.COMPLETE
   -n com.lastglance.app/.launcher.LauncherIntentReceiver --es clientId test-1
   --es payload '{"chore_id":"<an id from step 1>"}'`. With the app in the
   foreground the completion is logged at once; with it dead, on next launch.
   Send it again with the same `clientId`: nothing changes, and `meta` lists
   the id under `handledWrites`.
3. A create: the same with `.CREATE` and `--es payload '{"title":"From the
   launcher"}'`; the new chore's row carries `"clientId":"test-2"`.
4. A contact: `.LOG_INTERACTION` with `--es payload '{"person_id":"<an id from
   people>","channel":"call"}'`; the person's `lastInteractionAt` moves and the
   interaction's id in the app is the `clientId`.
5. A refresh: `am broadcast -a com.lastglance.app.launcher.REFRESH -n
   com.lastglance.app/.launcher.LauncherIntentReceiver --es clientId rf-1`.
   With the app alive, `meta.refreshLog` shows the entry go `queued` then
   `ran`; with the process killed (`adb shell am kill com.lastglance.app`,
   never `force-stop`), `rendererAlive` reads false and the entry goes
   `scheduled`, then `ran` with `headless: true` and its `waitMs`. A second
   killed-process refresh inside ten minutes reads `throttled`; opening the
   app while a headless run is in flight makes it `aborted`.
   Frozen: leave the app in the background until `adb shell dumpsys activity
   processes com.lastglance.app` shows `isFrozen=true`, then send a refresh
   with a new `clientId`; the entry still goes `queued` then `ran` within
   seconds, not when the app is next opened.
6. Permission: from any app without the permission the query is refused
   with a `SecurityException` and the broadcast is not delivered.

Unit tests: `npx vitest run src/native/launcherSnapshot.test.ts
src/intents/launcherWrites.test.ts src/headless/` and, on the Android side,
`./gradlew :app:testDebugUnitTest --tests '*LauncherSnapshotRowsTest*' --tests '*LauncherRefreshWaitTest*' --tests '*HeadlessRefreshPolicyTest*'`.
`src/headless/headlessRefresh.scenarios.test.ts` walks a headless run end to
end against the real engines and Dexie under a fake bridge: credentials out of
the secure store, the WebDAV file over the bridge's HTTP, the merge into
IndexedDB, and the snapshot back to the launcher, and holds it to the
allowlist.
