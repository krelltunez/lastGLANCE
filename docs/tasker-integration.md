# Driving lastGLANCE from Tasker (Android intents)

lastGLANCE (Android) can be driven by another Android app — **Tasker**,
MacroDroid, Automate, or anything that can send an intent. You can create
chores, mark them done, foreground the app, and read live counts, all without
touching the screen.

This is **Android-only**. iOS has no equivalent broadcast mechanism.

> Implementation details live in [`tasker-intents-architecture.md`](./tasker-intents-architecture.md).
> This page is the end-user recipe.

---

## The actions

Every inbound action is an Android intent whose **action string** is one of the
four below, carrying a single **`payload` String extra** containing a JSON
object.

| Action string | What it does |
|---|---|
| `app.lastglance.CREATE`   | Create a chore |
| `app.lastglance.COMPLETE` | Log a completion for a chore (match by title) |
| `app.lastglance.OPEN`     | Foreground the app, optionally routing the UI |
| `app.lastglance.QUERY`    | Reply with current counts (via a RESULT broadcast) |

Two broadcasts go the other way:

| Action string | Meaning |
|---|---|
| `app.lastglance.RESULT` | The outcome of a handled action (also the QUERY reply) |
| `app.lastglance.NOTIFY` | Fired when a chore is completed via `COMPLETE` |

### Broadcast vs Activity — which to send

- **Broadcast** (Tasker → *Send Intent*, **Package** left blank or targeting the
  receiver) works while lastGLANCE is **foregrounded, backgrounded, or killed**.
  When the app is killed the intent is **stored and applied the next time the app
  runs** — it is not lost, but it is not processed live.
- **Activity** (Tasker → *Send Intent*, **Target: Activity**) **launches /
  foregrounds** the app and applies the intent on cold start. Use this for
  `OPEN`, or when you need a killed app to act *now* (Android forbids launching
  an Activity from the background, so the app will come to the foreground).

A good pattern: send as a **broadcast** first and treat the `RESULT` broadcast as
a liveness probe; if no `RESULT` arrives within a second or two, resend as an
**Activity** intent.

---

## Payloads

### CREATE — `app.lastglance.CREATE`

```json
{ "title": "Descale the kettle", "project": "Kitchen" }
```

| Field | Required | Notes |
|---|---|---|
| `title` | ✅ | The chore name. |
| `project` | — | A **category** name. If it exists (case-insensitive) the chore goes there; if not, the category is created. Omit it and the chore lands in an auto-created **"Inbox"** category. |

New chores are created with **no cadence** (they won't turn amber/red until you
give them a target cadence in the app).

**Idempotent:** sending the same `title` into the same category twice does **not**
create a duplicate — the second call returns the existing chore with a warning.
So a double-firing Tasker profile is safe.

### COMPLETE — `app.lastglance.COMPLETE`

```json
{ "title": "Mop kitchen" }
```

| Field | Required | Notes |
|---|---|---|
| `title` | ✅ | Matched against chore names: an **exact** (case-insensitive) match wins; otherwise a **unique substring** match is accepted (the RESULT carries a `warning` noting the fuzzy match). |
| `completed_at` | — | ISO-8601 timestamp with offset (e.g. `2026-07-02T09:30:00+02:00`). Defaults to now. |

If the title matches **nothing** or is **ambiguous** (more than one chore), the
action fails and the RESULT `error` explains which.

### OPEN — `app.lastglance.OPEN`

```json
{ "tab": "soon" }
```

Send as an **Activity** intent (Target: Activity) so it can foreground the app.

| `tab` value | Result |
|---|---|
| `soon` / `due` / `attention` | Foreground and switch on the **Soon** (needs-attention) filter |
| `search` / `find` | Foreground and open **search** |
| `add` / `new` / `create` | Foreground and open the **new-chore** form |
| *(anything else / omitted)* | Just foreground the app |

### QUERY — `app.lastglance.QUERY`

```json
{}
```

No payload fields. lastGLANCE replies with a `RESULT` broadcast (see below).
To read the reply, the app must be **running** (send `QUERY` as a broadcast to a
foregrounded/backgrounded app, or `OPEN` it first).

---

## Reading replies: the RESULT broadcast

After every handled action lastGLANCE broadcasts `app.lastglance.RESULT` with two
String extras:

- `action` — the **original** action you sent (e.g. `app.lastglance.COMPLETE`), so
  your profile's `%action` matches what it fired.
- `result` — a **JSON string** you parse (Tasker: *Variable → Structure Output
  (JSON)* on the receiving variable, or the *JSON Read* action).

`result` always contains:

| Key | Meaning |
|---|---|
| `success` | `true` / `false` |
| `chore_id` | The affected chore's stable id (CREATE / COMPLETE) |
| `error` | Present when `success` is `false` |
| `warning` | Present on a non-fatal note (fuzzy match, duplicate ignored) |

A `QUERY` reply additionally carries these count variables (named so they read
naturally after parsing):

| Key | Meaning |
|---|---|
| `%lg_count_due` | Chores needing attention now (amber/red — soon **and** overdue) |
| `%lg_count_overdue` | Chores past their target cadence |
| `%lg_count_done_today` | Completions logged today |
| `%lg_count_total` | Total chores across all categories |

To receive `RESULT` (and `NOTIFY`) in Tasker, add a **Profile → Event → System →
Intent Received** with the matching action string.

## The NOTIFY broadcast

When a chore is completed **via a `COMPLETE` intent**, lastGLANCE broadcasts
`app.lastglance.NOTIFY` with a `payload` String extra (JSON). Use it to have
automation react to completions. The JSON's inner `payload` object includes
`source_entity_id` (the chore id), `title`, and `completed_at`.

> Completions made **inside the app** do not currently emit this broadcast — only
> those driven through the `COMPLETE` intent do.

---

## Gotchas

- **OPEN needs Target: Activity.** A broadcast can't foreground the app.
- **RESULT/QUERY need a receiver profile.** Without an *Intent Received* profile
  listening for `app.lastglance.RESULT`, the reply goes nowhere.
- **Parse the `result` string.** It's one JSON string, not separate extras.
- **The pending slot is single-depth.** Two intents fired in the same instant can
  overwrite each other before the app reads the first. Space bursts out, or make
  each send self-sufficient. (Activity intents each cold-start cleanly.)
- **Namespace.** Everything is under `app.lastglance.*`, distinct from dayGLANCE's
  `app.dayglance.*`, so the two apps never cross-talk if both are installed.
