# MCP and Stream Deck for the desktop app

Status: built, phases 1 to 7 (section 8); the plan was reviewed 2026-11-12 (section 9). Follows `docs/desktop-app.md`, section 10 ("Commands
from outside the window, and the road to MCP and Stream Deck"), which reserved
the ports and built the seams this plan uses. dayGLANCE is the reference
(`docs/mcp-server-spec.md`, `docs/mcp-tools-reference.md`, `electron/ws-server.ts`
and `stream-deck-plugin/` there); this document says what lastGLANCE takes from
it, what it does differently, and why.

## 1. What ships

- **An MCP server** in the desktop app, so Claude (Claude Desktop, Claude Code,
  any MCP client) can read your chores and People and, if you allow it, mark
  chores done, add chores and log interactions.
- **A Stream Deck plugin** with keys and dials for chores and People, talking to
  the desktop app on the same computer.
- Both are **off until you turn them on**, both listen on **127.0.0.1 only**, and
  neither is reachable from the network.

Not in scope: an MCP server on the phone apps or the web, a GLANCEvault-client
MCP host (dayGLANCE's `docs/mcp-vault-host.md` path), and delete tools of any
kind.

## 2. Branching and release

No long-lived branch. Each phase lands on `main` in its own PR, and `main` stays
releasable throughout:

- The Settings section that turns either feature on is not mounted until the
  phase that ships it (a single `LOCAL_INTEGRATIONS_UI` constant in
  `src/native/localIntegrations.ts`, flipped in the last PR). With the section unmounted,
  nothing can enable a listener, so an in-between `main` behaves like 3.1.0.
- A fix for 3.1.x lands on `main` and ships as 3.1.1. If `main` ever holds
  something not ready to ship, a `release/3.1.x` branch is cut from the `v3.1.0`
  tag then, not before.

## 3. Shared foundation: `local-integrations.json`

One config file in `userData`, one pure state machine, one Settings section,
after dayGLANCE's `electron/localIntegrations.ts`:

```ts
interface LocalIntegrationsConfig {
  streamDeck: { enabled: boolean }
  mcp: {
    readTier: 'off' | 'chores' | 'chores_people'
    writesEnabled: boolean
    token: string | null
    portOverride: number | null
    consentAcceptedAt: string | null
    peopleConsentAcceptedAt: string | null
    writesConsentAcceptedAt: string | null
  }
}
```

- **Defaults:** everything off. There are no upgraders to migrate (dayGLANCE
  turned Stream Deck on for existing installs because it had shipped
  unconditionally; lastGLANCE never has).
- **Corrupt file:** moved aside to `.corrupt`; MCP fails closed (off), Stream
  Deck stays off.
- **Transitions** (`applyTransition`, pure, tested): `set-mcp-read-tier`
  (enabling from off needs `consentConfirmed`; `chores_people` also needs
  `peopleConsentConfirmed`; `off` also turns writes off), `set-mcp-writes`
  (needs a read tier and `writesConsentConfirmed`), `rotate-token`,
  `set-mcp-port`, `set-stream-deck`. `listenerEffects(before, after)` says
  start, stop, restart or nothing for each listener.
- **IPC:** `local-integrations:get`, `local-integrations:transition`, and the
  `local-integrations:status` push. Added to `DESKTOP_BRIDGE_METHODS`, so the
  bridge contract test holds preload, `desktop.ts` and main equal.
- **Settings → Integrations → On this computer** (desktop only): the Stream Deck
  toggle, the MCP tier radio group, the writes toggle, the token (copy, rotate),
  the port, the endpoint, the setup helpers (section 5) and any listener error.
  "Both listen on 127.0.0.1 only and are never reachable from the network."

## 4. MCP

### 4.1 Listener

- `@glance-apps/mcp-host` (on npm, 0.2.0) for everything generic: the listener
  and its guards (path, Host, Origin, bearer token, in that order), the port
  policy (one port, 7900 by default, never scans, an invalid override is an
  error), the write gate (30 writes a minute; three violations in five minutes
  disable writes until restart), the idempotency store, pagination, the journal
  and the local-date rules. Its README already uses lastGLANCE on 7900 as the
  example.
- `@modelcontextprotocol/server` 2.3.1 and `/node` 2.1.1, `zod` 4, as dayGLANCE.
  `@modelcontextprotocol/client` as a dev dependency for the transport suite.
- `electron/mcpServer.ts` registers lastGLANCE's tools on a fresh `McpServer`
  per request; all state lives at module scope in main (dayGLANCE spec, 3.7).
- The token is generated on the first enable and read on every request through
  a getter, so rotating it needs no restart.
- A taken port is a status message in Settings, never a crash and never another
  port.

### 4.2 Reads: a request bridge to the page

The tray reads the cached widget snapshot, but MCP needs more than the snapshot
carries (completion history, notes, People details), so reads use dayGLANCE's
request bridge (`electron/mcpRendererBridge.ts`):

- Main sends `mcp:request {id, method, params}` to the main window and waits for
  `mcp:response`. `request()` never rejects or hangs: no window, a send that
  throws, or a timeout (3 s; 8 s for history) resolves to `renderer_unavailable`,
  whose message says plainly that this is NOT an empty list. Replies from any
  other webContents (the tray popup) are dropped.
- The page answers in `src/mcp/useMcpBridge.ts` from Dexie through the existing
  query modules (`src/db/queries.ts`, `src/people/queries.ts`), not from React
  state, so a hidden window answers as well as a visible one.
- The read model is pure, `src/mcp/readModel.ts` (`handleMcpRequest(data,
  request)`), tested without Electron. Multi-user scoping: chores and People
  are household data, so the read model returns everything, and names who a
  chore is assigned to and who completed each event. People rows carry an
  `owner_user_sync_id`; the read model shows exactly what the People screens
  show this device's user, and phase 2 pins that with a test.

### 4.3 Read tools (proposed)

| Tool | Returns |
|---|---|
| `lastglance_get_overview` | counts (overdue, soon, done today), the due chores, Reach out, Coming up |
| `lastglance_list_chores` | every chore, filterable by category and state; paginated |
| `lastglance_get_chore` | one chore with its cadence, assignees and recent completions (with notes) |
| `lastglance_list_categories` | the category tree with assignees |
| `lastglance_get_activity` | completions between two local dates, by day |
| `lastglance_list_users` | household members, whether multi-user mode is on, and who this device is |
| `lastglance_list_people` | People with circle, cadence and last interaction (People tier) |
| `lastglance_get_person` | one person: dates, recent interactions with notes, details (People tier) |
| `lastglance_list_upcoming_dates` | birthdays and dates in a window (People tier) |
| `lastglance_list_circles` | the circles People are grouped in (People tier) |
| `lastglance_list_mcp_writes` | what MCP changed this session, for undo context (phase 3, with the writes) |

Also `lastglance_ping`, a connectivity check that reads nothing.

Resources: `lastglance://chores/due` and `lastglance://people/coming-up`.

`docs/mcp-tools-reference.md` is the contract, and the transport suite parses
the tool names from it, as dayGLANCE's does: a tool lands in both or the suite
fails.

### 4.4 Consent tiers

Three settings, after dayGLANCE's section 6, adapted to what lastGLANCE holds:

- **Off** (default).
- **Chores:** chores, categories, completions and household members.
- **Chores and People:** adds People, interactions, dates and notes. People data
  is about other people, so this tier has its own consent copy that says so, as
  dayGLANCE's device-calendar tier does.
- **Allow changes:** a separate opt-in on top of a read tier.

Every consent dialog says plainly that what Claude reads is sent to the AI
provider and leaves lastGLANCE's guarantees.

### 4.5 Writes

Write tools, none destructive. **Every field the app's own screens let you
change is changeable through MCP** (decided in review): if a form can edit it,
a tool can; nothing a form cannot edit is exposed.

| Tool | Does |
|---|---|
| `lastglance_complete_chore` | marks a chore done, now or at a given time, with an optional note |
| `lastglance_update_completion` | edits a completion's note |
| `lastglance_create_chore` | adds a chore; new chores take the category's assignees as everywhere else |
| `lastglance_update_chore` | every field the chore form edits (name, category, cadence, icon, pinned, and the rest) |
| `lastglance_create_category`, `lastglance_update_category` | every field the category form edits (name, icon, parent, assignees) |
| `lastglance_log_interaction` | logs a contact with a person (People tier) |
| `lastglance_update_interaction` | every field the interaction form edits (People tier) |
| `lastglance_create_person` | adds a person, with their dates (People tier) |
| `lastglance_update_person` | every field the person form edits: name, nickname, circle, cadence, preferred channel, details, snooze, archive, the per-person notification switches, and their birthday and dates (People tier) |

Phase 3 starts with an audit of every edit form (chore, category, completion,
person, date, interaction) and writes the field list into
`docs/mcp-tools-reference.md`, so "every field" is a written list that review
can check, not a promise. Archive counts as an edit: it is reversible in the
app and undoable here. Deleting anything stays out.

Every write takes an `idempotency_key`. The pipeline is mcp-host's, as
dayGLANCE uses it: consent gate, replay (a repeated key returns the stored
result without touching data), the write gate, a pure argument planner whose
by-design rejections are typed `validation` errors, then the request bridge.
Schemas stay permissive so the planner's message reaches the client rather than
the SDK's generic one.

**How a write reaches the data.** Not through `commands.json`. The queue exists
for presses that must survive a crash and need no reply; an MCP write needs its
result and has its own retry story in the idempotency key. So writes ride the
request bridge, and the page applies them in `src/mcp/writeModel.ts` through
the same data-layer calls the app's forms make (`createChore`, `updateChore`,
`logCompletion`, ...), with the forms' rules (the category's icon and assignees
on a new chore, the device's Me as the completer, no future completions). That
marks each change dirty and gets it pushed as a form's save is, and fires the
same `lg:chore-logged` the intents path fires, so the screens, widgets and
reminders refresh. A create's id is derived from its idempotency key, so a
retry finds its own row even after the replay store has forgotten it; a chore
with the same name in the same category is returned rather than duplicated, as
the intents path does. (Decided while building 3a: the launcher's ledger
answers "was this delivered" with an id, but a write here needs the entity and
an undo record, which the data layer gives directly.)

**Undo.** Each write returns an undo op from the page (it alone has the
before-state): `remove_completion`, `remove_created` (a chore, category or person, removed
with a tombstone), `remove_interaction`, and `restore_fields` (the before-values
of whatever an edit changed). The journal is
mcp-host's, held in main for the session only. Undo is per item and all at once,
from Settings and from the tray popup's menu, which also carries the kill switch
("Turn off MCP"), so the server can be stopped without opening the window.

### 4.6 Visible state

The changes list with Undo and Undo all in Settings, a notice there when the
rate gate has paused writes, and the tray menu's "Undo assistant changes (N)"
and "Turn off assistant access" (phase 3a). With the Settings mount (phase 7),
the indicator: a dot in the tray popup's header and beside the MCP setting,
green while the server is running, blue while there are changes from this
session to undo (also after the server is turned off), red while writes are
paused. Main decides it (`assistantIndicator` in
`electron/localIntegrations.ts`) and sends it with the Settings view and the
tray state, so the two cannot disagree; the popup's dot opens Settings at
Integrations (the `settings:integrations` token, accepted from the popup only,
not from `lastglance://` links). No per-write modal (dayGLANCE spec, 4.3):
read-only by default, no deletes, a rate limit and undo instead.

## 5. Connecting Claude

- **Claude Code and other HTTP clients** connect directly. Settings shows the
  endpoint (`http://127.0.0.1:7900/mcp`) and a ready-to-copy
  `claude mcp add --transport http lastglance ... --header "Authorization: Bearer ..."`
  line.
- **Claude Desktop** only speaks stdio from its config file, so it needs the
  stdio bridge: a stateless pipe from stdio to the app's HTTP listener, with no
  tools or data of its own (every tool comes from the app it connects to).
  `@glance-apps/mcp-bridge` 0.1.2 hard-codes dayGLANCE in four places: the
  discovery paths, port 7893, the `DAYGLANCE_MCP_*` variables, and the error
  text. Proposed, in `glance-apps/mcp-bridge`, released as 0.2.0:
  - **App profiles.** A small table (`src/apps.js`) holds what differs per app:
    display name, default port, discovery folder names, environment prefix, and
    where in the app's Settings to enable the server. `--app lastglance` selects
    lastGLANCE's; with no `--app`, dayGLANCE's, so every existing dayGLANCE setup
    keeps working unchanged.
  - **One bin and one Claude Desktop extension (`.mcpb`) per app**, built from
    the same source: `lastglance-mcp-bridge` and `lastglance-mcp-bridge.mcpb`,
    with lastGLANCE's name and icon, beside dayGLANCE's.
  - **What a user of one app sees.** Only that app. Each app's setup button
    writes only its own entry (`mcpServers.lastglance`) into Claude Desktop's
    config and bundles its own copy of the bridge inside its own app; Claude
    lists only the tools of the apps you connected; every message the bridge
    prints names the app it was started for ("Could not reach lastGLANCE on
    127.0.0.1:7900"). The one place both appear is the package's README on
    npm and GitHub, which becomes the GLANCE apps' bridge with a section per
    app. The package name is already neutral.

  lastGLANCE then ships the bridge in `extraResources` on macOS and Windows and
  gets dayGLANCE's "Set up Claude Desktop" button (`mcpDesktopConfig.ts`, the
  MSIX path handling, a backup before writing, never overwriting a file it
  cannot parse).
- **Discovery file** `lastGLANCE/mcp.json` (mode 0600) beside the app's data on
  direct builds, so the bridge finds the port and token itself. Not on the Mac
  App Store build: reading another app's sandbox container prompts the user
  (dayGLANCE's phase 0.5 finding).

## 6. Stream Deck

### 6.1 Desktop side

- `electron/streamDeckServer.ts`: a `ws` WebSocket server on 127.0.0.1:7901,
  started and stopped by the toggle. A taken port is a status message.
- **Trust:** dayGLANCE's model, kept on purpose. A client with no Origin header
  is a native process (the plugin's Node backend) and is trusted; a client with
  an Origin (a browser, or the plugin's property inspector) must present a
  session token the backend received within five seconds or is dropped. That
  is what keeps a web page from driving the socket. Any local process can
  connect, which is the same reach a local process already has to the app's
  files. Small `maxPayload`, and every inbound frame validated against the
  protocol, not forwarded as is.
- **Reads come from the snapshot.** Main already caches the widget snapshot for
  the tray (`electron/trayModel.ts`). The deck state is built in main from that
  cache (`electron/deckModel.ts`, pure): no new push from the page, no 15-second
  re-render loop. A one-minute tick recomputes the fill ratios from each
  chore's last completion so a key ages while the window is closed.
- **Writes go through `commands.json`**, with a new source `streamdeck`. That is
  what the queue was built for: a press must not be lost if the window is
  closed or the page is busy, and needs no reply.
- **No toggles, no double completions.** dayGLANCE's deck "complete" toggles,
  so a second press undoes the first. Here a press only completes, and main
  refuses a second completion of the same chore from the deck within a minute
  (the key shows it done in the meantime, as the tray hides a chore it just
  completed).

### 6.2 Protocol

`electron/deckProtocol.ts`, shared by the app and the plugin (the plugin's
rollup imports it, as dayGLANCE's does), version 1:

- out: `lg:state` (counts, due chores, pinned chores, every chore's id, name,
  icon, colour, state and fill; Reach out; Coming up; the time format), and
  `lg:token` for the property inspector handshake;
- in: `lg:auth`, `lg:chore:complete {choreId, clientId}`,
  `lg:open {target}` (a `lastglance://` token: a chore, a person's log, add).

### 6.3 The plugin

`stream-deck-plugin/` in this repo, `@elgato/streamdeck` v2 (SDK 2, Node 20),
UUID `com.lastglance.streamdeck`, its own `package.json` and lockfile. Keys are
drawn as SVG, 144×144 on a key and 200×100 on the Stream Deck + touch strip
(`src/render.ts`); what each key shows is a pure function of the app's
`lg:state` and the clock (`src/keys.ts`), so it is tested without Stream Deck.

| Action | Shows | Press | Dial (Stream Deck +) |
|---|---|---|---|
| Chore | one chosen chore: its icon in its cadence colour, the fill bar, and a line that turns every 4 seconds between "3d ago" and "due now" | marks it done | |
| Due | the due chores, most overdue first, its place ("2/5") in the corner | tap shows the next; hold (half a second) marks the shown one done | turn to move; push or tap the strip to mark done |
| Pinned | the pinned chores in season, in the app's Pinned order | as Due | as Due |
| Soon | the overdue count (or the soon count), big | opens the app filtered to due soon | |
| Reach out | the people in Reach out, in its order (the first on a key) | opens the shown person's contact log | turn to move; push or tap to open the log |
| Coming up | the birthdays and dates ahead, soonest first: rose within a week, slate further off | opens the shown person | turn to move; push or tap to open the person |
| Add chore | a plus | opens Add chore | |

- **The words for time are the app's.** Main works out "since" and "next due"
  for each chore with the app's rules (`sinceOf` and `nextDueOf` in
  `electron/deckModel.ts`, following `formatElapsed` and `formatNextDue`):
  calendar days in the user's zone, so a chore done on Thursday evening is "2d
  ago" on Saturday morning, as the chore list says, not the 1d of 24-hour
  periods the first version counted. `deckModel.test.ts` runs both over the same
  instants, DST included. The plugin only shortens them. The state also carries
  the pinned chores in the app's order. Both are optional fields of protocol
  version 1: a plugin keeps working against an app from before them.
- **Soon** was called Overview, and keeps its action id
  (`com.lastglance.streamdeck.overview`), so a key already placed keeps working.
- **Lists on a dial:** Due, Pinned, Reach out and Coming up share one list
  action (`src/actions/list-action.ts`): each key and dial keeps its own place,
  and a key shows where it is ("2/5") in its top corner.

- **The connection** (`src/connection.ts`): one socket to 127.0.0.1:7901 with
  no Origin, so the app trusts it as a native client; reconnects with backoff
  from 1 to 30 seconds; every command carries a `clientId` and waits up to five
  seconds for its `lg:result`. Not connected reads as "Not running" on every
  key, and connected before the first snapshot as "Open the app", never as
  "nothing due". A press shows the app's answer: a tick for done (and for a
  second press the guard refused, since the chore is done), an alert otherwise.
- **The Chore key's picker** asks the plugin backend for the chore list over
  Stream Deck's own property inspector channel (`sendToPlugin`), not over a
  second socket, so the session token (`lg:token`) is unused by this plugin.
- **Icons:** `scripts/gen-assets.mjs` generates the icon table from the app's
  own `lucide-react` with the widgets' name rules (`scripts/lucide-names.mjs`),
  so every name a chore can store (Sprout, LucideSprout, SproutIcon, an old
  alias) draws the icon the app shows. It runs from the root install, so the
  plugin always draws the app's version. The plugin and action icons are made
  by the same script from the app icon and Lucide glyphs.
- **Words on the keys are English only.** Stream Deck gives the plugin no
  language of the app's, and the keys carry little text (a name, "3d").
- **Tests** run with the app's (`npx vitest run stream-deck-plugin`), including
  one that drives the real connection against the app's real listener and deck
  model over a socket.
- **Build and release:** unlike dayGLANCE's hand-packed plugin, CI builds,
  typechecks, validates and packs it (`ci.yml`), and `release-desktop.yml`
  attaches `com.lastglance.streamdeck.streamDeckPlugin` to the tag's release.
  The Elgato Marketplace submission is a manual step in
  `docs/releasing-desktop.md`. The manifest has no `URL`: `streamdeck validate`
  fetches it, which would tie CI to the website being up.

## 7. Mac App Store

- Both listeners need `com.apple.security.network.server`, in
  `entitlements.mas.plist` since phase 4a (`electron/builderConfig.test.ts`
  holds it). dayGLANCE passed review with both (Guideline 2.4.5(i), answered
  with a demo video); expect to need the same for the first MAS build with the
  section mounted.
- The Claude Desktop setup and the bundled bridge are compiled out (Guideline
  2.5.2: the app must not install or run code), with dayGLANCE's two mechanisms:
  a vite define (`__MAS_BUILD__`) that removes the button, and top-level `files`
  negations that keep `mcpDesktopSetup*` and `mcpDesktopConfig*` out of the
  asar. `scripts/verify-mas-compileout.mjs` checks the built app. MAS users
  connect Claude Desktop through the bridge's own install with the token pasted
  in; Settings shows them the setup guide instead of the button.

## 8. Phases

Each phase is one PR to `main`, tests with it, the Settings section unmounted
until phase 7.

1. **Foundation.** `local-integrations.json`, the state machine and its tests,
   the IPC and bridge contract, the Settings section (unmounted).
2. **MCP reads.** The request bridge, the read model, the read tools and
   resources, `docs/mcp-tools-reference.md`, and the transport suite over a real
   loopback listener and the official client.
3. **MCP writes**, in two PRs.
   - **3a, chores (done):** the write pipeline (consent, replay, rate gate),
     the page's write model through the data layer the forms use, the field
     audit in `docs/mcp-tools-reference.md`, chores, completions and
     categories, the session journal with undo from Settings and the tray
     menu, and the tray menu's off switch.
   - **3b, People (done):** people (with archive and snooze), dates,
     contacts and circles on the same pipeline, under the People tier, for
     this user's People only; the audit rows and tools in
     `docs/mcp-tools-reference.md`.
   The indicator (4.6) comes with the Settings mount in phase 7.
4. **Connecting Claude**, in two steps.
   - **The bridge:** app profiles in `glance-apps/mcp-bridge` (0.2.0): one
     bridge, a profile per app, `--app lastglance`, its own `.mcpb`; dayGLANCE
     unchanged with no `--app`.
   - **4a (done):** the discovery file, the Claude Desktop config writer and
     its button (`mcpDesktopConfig.ts`, `mcpDesktopSetup.ts`), the MAS
     compile-out (`__MAS_BUILD__`, the package exclusions,
     `scripts/verify-mas-compileout.mjs`, run on direct builds in CI) and the
     MAS `network.server` entitlement. The Claude Code line was built in
     phase 1.
   - **4b (done):** `@glance-apps/mcp-bridge` 0.2.0 shipped in
     `extraResources` on macOS and Windows direct builds (never MAS, never
     Linux), so the button's entry points at a file that exists; the verify
     script checks it, and the smoke test runs the entry's exact command (the
     build's binary as Node on the bridge, `--app lastglance`) against the live
     server over stdio.
5. **Stream Deck, desktop side (done).** `electron/streamDeckServer.ts` on
   127.0.0.1:7901 (dayGLANCE's trust model, plus a loopback Host check, a
   16 KB frame limit, every frame parsed by `electron/deckProtocol.ts`, and an
   `lg:result` answer per command); `electron/deckModel.ts` (the tray's
   snapshot aged by the clock, with the app's thresholds and colours);
   presses through the command queue as `streamdeck`. The double-completion
   guard keeps the deck's own presses for the full minute and also reads the
   snapshot's last completion: the smoke test showed that relying on the
   tray's "done here" record alone forgot a press as soon as a snapshot
   settled it. The widget snapshot is now stamped before its data is read,
   which also stops the tray from briefly showing a chore it just completed.
6. **Stream Deck plugin (done).** `stream-deck-plugin/`: the six actions,
   the Chore key's picker over Stream Deck's channel, the key renderer with the
   app's own Lucide icons, the connection with backoff, CI building and packing
   it and the release attaching it (6.3).
7. **Ship (done).** `LOCAL_INTEGRATIONS_UI` on, so Settings → Integrations
   shows "On this computer"; the indicator (4.6) in Settings and the tray
   popup, its strings in all 10 languages (the section's own were written in
   phase 1); the README; the release checks in `docs/releasing-desktop.md`.
   The smoke test opens Settings the way the popup's dot does and follows the
   indicator through a write and its undo.

## 9. Decisions (review, 2026-11-12)

1. **MCP read tiers:** Chores / Chores and People, People behind its own consent
   (4.4). Agreed.
2. **Writes:** complete, create and edit chores, and the same for People (log a
   contact, add a person, edit a person). Every field the app's screens can
   change is exposed (4.5). No deletes.
3. **The bridge:** generalise `glance-apps/mcp-bridge` with app profiles (5),
   pending your go-ahead. A user of one app must never see the other.
4. **Stream Deck trust:** dayGLANCE's model (6.1). Agreed.
5. **Stream Deck actions:** the six in 6.3, to start.
6. **Order:** MCP first, then Stream Deck.
