# lastGLANCE MCP tools reference

The contract of the desktop app's MCP server (`docs/mcp-and-stream-deck.md`,
section 4). `electron/mcpServer.transport.test.ts` parses the tool names from
the `###` headings and the resource URIs from the table below, and holds the
server to them: a tool added or renamed lands here and in the code, or the
suite fails.

## Conventions

- **Endpoint.** `http://127.0.0.1:7900/mcp` (the port can be changed in
  Settings), Streamable HTTP, with `Authorization: Bearer <token>` from
  Settings. Loopback only.
- **Ids.** Every id is a sync id, the same on every device. Pass ids exactly as
  a tool returned them; never construct one.
- **Dates and times, all local.** A date is the user's local calendar date,
  `YYYY-MM-DD`, resolved on the user's machine; a dated response echoes `date`
  (or `from`/`to`) and the IANA `timezone`. A time (every field ending in `_at`
  or `_until`: `completed_at`, `last_completed_at`, `occurred_at`,
  `created_at`, the journal's `at`, ...) is the user's local wall-clock time
  with its offset, `2026-11-13T19:30:00-07:00`, never UTC: a Friday-evening
  completion reads as Friday. The server rewrites every instant it returns on
  the way out (`electron/mcpTimes.ts`), tools and resources alike. A time
  argument takes either a local time, `2026-11-13 19:30` (dayGLANCE's form,
  read in the same zone), or ISO 8601 with a zone.
- **Chore state.** From how long ago a chore was last done against its cadence:
  `overdue` (ratio ≥ 1), `soon` (ratio ≥ 0.75), `fresh`, or `none` (no cadence,
  or never done). `ratio` is elapsed days over cadence days. `next_due` is the
  local date it comes due. `in_season` is false for a seasonal chore outside
  its window, which the app hides.
- **Pagination.** List tools page at 50 by default, 200 at most. `truncated`
  says more remain; pass `next_cursor` back as `cursor` with the same filters.
  A cursor is bound to its filters: changing them mid-walk is a `validation`
  error. `total` counts the filtered set.
- **Errors.** A failed tool call has `isError: true` and a JSON body
  `{ "error": { "code", "message" } }`:

  | Code | Meaning |
  |---|---|
  | `renderer_unavailable` | The lastGLANCE window is not answering (starting, restarting or closed). NOT an empty result: retry shortly. |
  | `not_found` | No chore, category, user, person or circle with that id. |
  | `validation` | A malformed argument, with what was expected. |
  | `not_connected` | `lastglance_send_to_dayglance` while the dayGLANCE integration is off on this device; the message names the setting. |
  | `internal` | The read or write failed inside the app. |
  | `read_only_mode` | A write while "Allow changes" is off in Settings. |
  | `rate_limited` | More than 30 writes in a minute. Wait; repeated overruns turn writes off. |
  | `writes_disabled` | Writes were turned off after repeated overruns, until lastGLANCE restarts. |

  A resource read that fails throws, with the same code first: `[renderer_unavailable] ...`.

- **Consent tiers.** Settings decides what exists. "Chores" serves the chore
  tools and `lastglance://chores/due`. "Chores and People" adds the People
  tools, People in `lastglance_get_overview`, and `lastglance://people/coming-up`.
  The tier is read on every request, so a change shows on the next one.
- **Writes.** Every write tool exists while the server runs, and each call
  checks "Allow changes" itself. A write takes an optional `idempotency_key`
  (1-128 characters of `[A-Za-z0-9_.:-]`): the same key again returns the first
  result with `replayed: true` and changes nothing, and a create keyed the same
  way finds its own row even after a restart. A write returns the entity as the
  read tools show it. Nothing is ever deleted. Each change is in the session's
  journal (`lastglance_list_mcp_writes`), and the user can undo it from
  Settings or the tray menu; an undo keeps anything the user changed since.
- **People scoping.** With multi-user mode on, only this device's user's People
  are returned, exactly as the People screens show them. Chores are household
  data: every chore is returned, with its assignees.

## Chore tools

### `lastglance_ping`

Connectivity check. Reads no data. Returns `{ ok: true, server }`.

### `lastglance_get_overview`

No arguments. What needs doing today:

- `date`, `timezone`
- `counts`: `overdue`, `soon`, `done_today`, `chores`
- `due`: in-season chores that are overdue or soon, most overdue first, at most
  50 (`due_truncated` when there are more)
- `pinned`: in-season pinned chores
- People tier only: `reach_out` (each a person summary plus `reason`: `date`,
  `unreturned`, `streak` or null) and `coming_up` (dates in the next 30 days)

### `lastglance_list_chores`

| Argument | |
|---|---|
| `category_id` | Optional. Includes its subcategories. |
| `state` | Optional. `overdue`, `soon`, `due` (overdue or soon), `fresh`, `none`, `all` (default). |
| `assigned_to` | Optional. A user id (assigned on the chore or its own category), `unassigned`, or `me` (the app's Mine view: unassigned or mine; needs multi-user mode with Me set). |
| `query` | Optional. Words matched in the name and category path, accents and case ignored. |
| `due_after`, `due_before` | Optional local dates, `YYYY-MM-DD`, both included: only chores whose `next_due` falls in the window ("what comes due by Sunday"). With either, a chore with no `next_due` (no cadence, or never done) or out of season is left out. |
| `sort` | Optional. `next_due`: soonest due first, so overdue chores (due in the past) lead; chores without one last. |
| `limit`, `cursor` | Pagination. |

Each item is a chore summary: `id`, `name`, `icon`, `category_id`,
`category_path`, `state`, `ratio`, `cadence_days`, `duration_minutes` (how long
it takes, or null), `last_completed_at`, `elapsed_days`, `next_due`, `pinned`,
`in_season`, `assignee_ids`. With a state
filter the list is most overdue first, otherwise by category path then name;
`sort: "next_due"` overrides both.

### `lastglance_get_chore`

| Argument | |
|---|---|
| `chore_id` | Required. |
| `completions_limit` | Optional, 0-200, default 20. |

The chore summary plus every field the chore form edits: `details`,
`seasonal_start`, `seasonal_end` (`MM-DD`), `notify_when_overdue`,
`auto_schedule_to_dayglance`; and `created_at`,
`updated_at`, `completions_total`, and `completions` newest first (`id`,
`completed_at`, `note`, `source`, `completed_by_user_id`).

### `lastglance_list_categories`

No arguments. The category tree, flat: `id`, `name`, `icon`, `parent_id`
(null at the top), `path`, `assignee_ids`, `chore_count`, `sort_order`.

### `lastglance_get_activity`

| Argument | |
|---|---|
| `from`, `to` | Required local dates, both included, at most 366 days apart. |
| `limit`, `cursor` | Pagination of `items`. |

`by_day` counts every completion in the window by local date. `items` lists
them newest first: the completion fields plus `date`, `chore_id`,
`chore_name`, `category_path`.

### `lastglance_list_users`

No arguments. `multi_user_enabled`, `me_user_id` (who this device is, with
multi-user mode on), and `users` as `{ id, name }`.

### `lastglance_resolve_link`

What a dayGLANCE task's `link` points to here. A task lastGLANCE sent to
dayGLANCE carries `link: { app: "lastglance", id }` in dayGLANCE's MCP output,
and dayGLANCE stores nothing that says whether the id is a chore or a person
(the intents create cannot carry it: krelltunez/lastGLANCE#454). This answers
by looking, as lastGLANCE resolves the completion dayGLANCE sends back.

| Argument | |
|---|---|
| `id` | Required: the `link.id`. |

Returns `kind` and `id`, and:
- `chore`: `chore`, a chore summary;
- `person` (a reach-out): `person`, a person summary;
- `date` (a birthday or date, `<date id>:<year>`): `date` (`id`, `kind`,
  `label`, `month`, `day`, `year`), `for_year` (the year the task was for) and
  `person`.

Registered under both tiers; a person or a date only resolves under "Chores
and People", and is `not_found` otherwise, as is an id nothing has (a deleted
chore, say).

## People tools

Registered only under the "Chores and People" tier.

### `lastglance_list_people`

| Argument | |
|---|---|
| `circle_id` | Optional. A circle id, or `none` for people in no circle. |
| `include_archived` | Optional, default false. |
| `query` | Optional. Words matched in the name and nickname. |
| `limit`, `cursor` | Pagination. |

Each item is a person summary: `id`, `name`, `nickname`, `circle_id`,
`circle_name`, `cadence_days`, `preferred_channel`, `last_interaction_at`,
`last_channel`, `last_interaction_note` (the note on the last contact, its
first 280 characters, or null when it has none: for what to follow up on;
`lastglance_get_person` has every note in full), `elapsed_days`, `ratio`,
`due_on`, `snoozed_until` (only while snoozed), `archived`. Sorted by name.

### `lastglance_get_person`

| Argument | |
|---|---|
| `person_id` | Required. |
| `interactions_limit` | Optional, 0-200, default 20. |

The person summary plus every field the person form edits: `details`,
`notify_when_overdue`, `add_to_dayglance_when_overdue`, `send_to_lifeglance`;
and `owner_user_id`, `created_at`, `updated_at`, `reciprocity`
(`unreturned`, `outbound_in_a_row`), `dates` (`id`, `kind`, `label`, `month`,
`day`, `year`, `remind_days_before`, `next_on`, `days_until`),
`interactions_total`, and `interactions` newest first (`id`, `occurred_at`,
`channel`, `direction`, `note`, `source`, `person_ids`).

### `lastglance_list_upcoming_dates`

| Argument | |
|---|---|
| `days` | Optional, 0-366, default 30. |

Dates falling in the window, soonest first: `id`, `person_id`, `person_name`,
`kind`, `label`, `on`, `days_until`, `turning` (the age or years, when the year
is known).

### `lastglance_list_circles`

No arguments. `id`, `name`, `icon`, `people_count`, in the app's order.

## What the tools change

The rule (decided in review): every field the app's own forms let the user
change can be changed over MCP, and nothing a form cannot change. This table
is the audit of the forms, and the write tools follow it.

| Entity | Field | Where the app edits it | Over MCP | Rules, as the form applies them |
|---|---|---|---|---|
| Chore | `name` | Chore form | create, update | Trimmed, required, at most 500 |
| Chore | `category_id` | Chore form, drag to a category | create, update | No category on create means the Inbox; a move keeps the assignees |
| Chore | `cadence_days` | Chore form | create, update | Whole days, 1 or more, or null |
| Chore | `duration_minutes` | Chore form | create, update | Whole minutes, 1 to 1440, or null; the dayGLANCE task length on a timed send |
| Chore | `icon` | Chore form | create, update | A Lucide name the app knows, or null; on create, the category's icon by default |
| Chore | `details` | Chore form | create, update | At most 2000 characters, or null |
| Chore | `pinned` | Chore form, the log sheet's pin | create, update | |
| Chore | `notify_when_overdue` | Chore form | create, update | Meaningful with a cadence |
| Chore | `auto_schedule_to_dayglance` | Chore form | create, update | Meaningful with a cadence and the dayGLANCE integration |
| Chore | `season` | Chore form | create, update | `MM-DD` start and end, real days, or null |
| Chore | `assignee_ids` | Chore form (multi-user) | create, update | Known users; on create, the category's by default |
| Chore | `position` | Drag within a category | create, update | Among the category's chores, 0 first |
| Completion | (a new one) | Log sheet, quick log | `lastglance_complete_chore` | By this device's Me; now, or backdated, never in the future |
| Completion | `note` | Completion row | `lastglance_update_completion` | The only field of a completion the app edits |
| Category | `name` | Category form | create, update | Trimmed, required, at most 500 |
| Category | `icon` | Category form, the inline icon | create, update | A subcategory takes its parent's icon by default |
| Category | `parent_id` | Category form | create, update | A top-level category, or null; nesting lifts its own subcategories beside it |
| Category | `assignee_ids` | Category form (multi-user) | create, update | Not inherited from the parent |
| Category | `position` | Drag, up and down | create, update | Among its siblings, 0 first |
| Person | `name` | Person form | create, update | Trimmed, required, at most 500 |
| Person | `nickname` | Person form | create, update | Or null |
| Person | `circle_id` | Person form | create, update | A circle, or null |
| Person | `cadence_days` | Person form (entered in weeks) | create, update | Whole days, 1 or more (7 a week), or null |
| Person | `preferred_channel` | Person form | create, update | `in_person`, `call`, `video`, `text`, `email`, `other`, or null |
| Person | `details` | Person form | create, update | Or null |
| Person | `notify_when_overdue` | Person form | create, update | Meaningful with a cadence |
| Person | `add_to_dayglance_when_overdue` | Person form | create, update | Meaningful with a cadence and the dayGLANCE integration |
| Person | `send_to_lifeglance` | Person form | create, update | Meaningful with the lifeGLANCE integration |
| Person | `archived` | Person detail, Archive | update | Not on create |
| Person | `snooze_days` | Reach out, Snooze | update | 3, 7 or 14 days, as the app offers; null ends a snooze; not on create |
| Date | `kind` | Person form, dates | create person, add, update | `birthday`, `anniversary`, `custom` |
| Date | `label` | Person form, dates | create person, add, update | Custom dates only, as the form saves it |
| Date | `month`, `day` | Person form, dates | create person, add, update | A real day; Feb 29 allowed |
| Date | `year` | Person form, dates | create person, add, update | 1-9999, or null when unknown |
| Date | `remind_days_before` | Person form, dates | create person, add, update | 0, 1, 2, 3, 7 or 14 |
| Contact | (a new one) | Log sheet, one-tap logs | `lastglance_log_interaction` | One or more people, not archived; never in the future; ends their snooze |
| Contact | `person_ids`, `channel`, `direction`, `note`, `occurred_at` | Log sheet, editing a contact | `lastglance_update_interaction` | At least one person; never in the future |
| Circle | `name` | Circle manager | create, update | Trimmed, required |
| Circle | `position` | Circle manager, up and down | create, update | 0 first |

Not changed over MCP, on purpose:

- **Deleting** anything: chores, completions, categories, people, dates,
  contacts, circles. A delete is done in
  the app. An undo of an MCP create is the one removal, and it declines when
  the user has added to the item since (a chore done since, a category with
  chores in it, a person with a contact logged or a date added since, a circle
  with people in it).
- **A completion's time, completer and source**: no form edits them.
- **`preferred_schedule_behavior`**: no form edits it and nothing in the app
  reads it (every chore holds null), so it is not shown either. Where a chore
  lands in dayGLANCE is chosen when it is sent.
- **Household members and this device's settings** (multi-user mode, who is
  Me): edited in Settings, about the device rather than the household's data.
- **A person's owner**: stamped when they are added (this user, with
  multi-user mode on), as the app does; no form changes it.
- **A circle's icon** and **a contact's source**: no form edits them.
- **Another household member's People**: with multi-user mode on, they do not
  exist for these tools, as they do not on this user's People screens.

## Write tools

### `lastglance_complete_chore`

| Argument | |
|---|---|
| `chore_id` | Required. |
| `completed_at` | Optional. A local time, `2026-11-12 18:30`, or ISO 8601 with a zone. Default now. Never in the future. |
| `note` | Optional. |
| `idempotency_key` | Optional. |

Returns `completion` (`id`, `completed_at`, `note`) and `chore`, as
`lastglance_get_chore` shows it.

### `lastglance_complete_chores`

Several chores done at once ("did all four bathrooms Saturday morning"), for
convenience only: each is an ordinary completion, exactly as if completed one at
a time. Nothing groups them, they stay separate chores for scheduling, and each
is journaled and undone on its own.

| Argument | |
|---|---|
| `completions` | Required, 1 to 25: `{ chore_id, completed_at?, note? }`. |
| `completed_at`, `note` | Optional, for items without their own. |
| `idempotency_key` | Optional, 1-120 characters, covering the whole batch: a retry repeats nothing that went through. |

Every time is checked before anything is written. Returns `completed`,
`failed`, and `results` in order: `{ chore_id, ok: true, completion, chore }`,
or `{ chore_id, ok: false, error: { code, message } }`. One item failing (an
unknown id) does not stop the rest; reaching the rate limit does, as does the
window not answering, and the items after it come back `not_attempted`, to
retry later. If the window is not answering before anything went through, the
whole call is the `renderer_unavailable` error, as for every tool.

### `lastglance_update_completion`

`completion_id`, `note` (text, or null to clear), `idempotency_key`. Returns
`completion` and `chore`.

### `lastglance_create_chore`

`name` (required), and optionally `category_id`, `cadence_days`, `duration_minutes`, `icon`,
`details`, `pinned`, `notify_when_overdue`, `auto_schedule_to_dayglance`,
`season` (`{ start, end }` or null), `assignee_ids`, `position`,
`idempotency_key`. Returns `chore`. A chore with the same name already in the
category is returned instead, with `already_existed: true`.

### `lastglance_update_chore`

`chore_id`, and any of the create fields. Only the fields given change; null
clears one. Returns `chore`.

### `lastglance_send_to_dayglance`

A chore to dayGLANCE as a linked task, any chore, due or not: done there, it
is the chore done here (the same GLANCE intent the app's send uses).

| Argument | |
|---|---|
| `chore_id` | Required. |
| `start` | Optional. A local time, `2026-11-15 09:00` (or ISO 8601 with a zone): a timed block. A date, `2026-11-15`: an all-day task. Left out: the dayGLANCE inbox. |
| `duration_minutes` | Optional, timed sends only: the block's length, 1 to 1440. Default the chore's own `duration_minutes`. |
| `idempotency_key` | Optional. |

**Duration only rides a timed send.** The intents schema refuses a duration
without a time, so an all-day or inbox send takes dayGLANCE's default length
(30 minutes), and `duration_minutes` with any other `start` is a `validation`
error. Set the length in dayGLANCE once the task is there:
`dayglance_resize_block` for a block, `dayglance_update_task` for an inbox
task. (Untimed sends carrying a duration wait on krelltunez/lastGLANCE#454.)

Returns `chore_id`, `dayglance_task_id` (the id the task gets in dayGLANCE,
worked out the way dayGLANCE makes it), `pending: true` (the task appears once
dayGLANCE picks the send up), `placed` (`timed`, `all_day` or `inbox`), `due`,
`duration_minutes`, and `chore`.

**Move it with dayGLANCE's tools, by that id; never send again to move it.**
dayGLANCE keys a sent task on the chore and its `due`: a send with the same
`start` updates the same task, and one with a different `start` makes a second
task. So to move or resize the block, use `dayglance_move_block`,
`dayglance_resize_block`, or `dayglance_schedule_task` for an inbox task, on
`dayglance_task_id`.

**Duplicate warning.** This device remembers what it sent for each chore (the
app's own sends and auto-schedule included) until dayGLANCE reports the task
completed or deleted. A send for another `start` while it has had no word on
the last one returns `warning` and `previous_send` (`dayglance_task_id`,
`due`, `sent_at`). It is a warning, not a refusal, and best effort: it knows
only this device's sends, and cannot see a task left open in dayGLANCE after
the chore was done in lastGLANCE, so it says "no word since", never "still
open".

Needs the dayGLANCE integration on (Settings, Integrations, dayGLANCE
Integration): `not_connected` otherwise. Not journaled and not undone from
lastGLANCE: the task is dayGLANCE's once it lands, so remove it there.

### `lastglance_create_category`

`name` (required), and optionally `icon`, `parent_id`, `assignee_ids`,
`position`, `idempotency_key`. Returns `category`, as
`lastglance_list_categories` shows it.

### `lastglance_update_category`

`category_id`, and any of `name`, `icon` (null for none), `parent_id` (null
for top level), `assignee_ids`, `position`. Returns `category`.

## People write tools

Registered only under the "Chores and People" tier, like the People reads.

### `lastglance_create_person`

`name` (required), and optionally `nickname`, `circle_id`, `cadence_days`,
`preferred_channel`, `details`, `notify_when_overdue`,
`add_to_dayglance_when_overdue`, `send_to_lifeglance`, `dates` (each as in
`lastglance_add_person_date`), `idempotency_key`. Returns `person`, as
`lastglance_get_person` shows them.

### `lastglance_update_person`

`person_id`, and any of the create fields, plus `archived` and `snooze_days`
(3, 7 or 14, or null to end a snooze). Only the fields given change; null clears
one. Returns `person`.

### `lastglance_add_person_date`

`person_id`, `kind` (default `birthday`), `label` (custom only), `month`, `day`,
`year`, `remind_days_before`, `idempotency_key`. Returns `date_id` and `person`.

### `lastglance_update_person_date`

`date_id`, and any of the date fields. Returns `date_id` and `person`.

### `lastglance_log_interaction`

| Argument | |
|---|---|
| `person_ids` | Required, at least one; archived people cannot be logged with. |
| `channel` | Optional; by default the first person's preferred channel, else the last one used, else `in_person`, as the log sheet suggests. |
| `direction` | Optional: `outbound`, `inbound`, `mutual`, or null. |
| `note` | Optional. |
| `occurred_at` | Optional. A local time, `2026-11-12 18:30`, or ISO 8601 with a zone. Default now. Never in the future. |
| `idempotency_key` | Optional. |

Logging ends a snooze on its people, as in the app (an undo puts a snooze that
has not ended yet back). Returns `interaction` and `people`.

### `lastglance_update_interaction`

`interaction_id`, and any of `person_ids`, `channel`, `direction`, `note`,
`occurred_at`. Returns `interaction`.

### `lastglance_create_circle`

`name` (required), `position`, `idempotency_key`. Returns `circle`.

### `lastglance_update_circle`

`circle_id`, and `name` and/or `position`. Returns `circle`.

## The write journal

### `lastglance_list_mcp_writes`

| Argument | |
|---|---|
| `chore_id`, `category_id`, `person_id`, `interaction_id`, `circle_id` | Optional filters, one id. |
| `limit`, `cursor` | Pagination. |

What assistants changed this session, newest first: `at`, `tool`, `summary`,
the ids, and `changes` (each changed field's value `before`). Never the
idempotency key. Under the read tiers, whatever "Allow changes" says. Cleared
by a restart, and as the user undoes changes.

## Resources

| URI | Tier | Contents |
|---|---|---|
| `lastglance://chores/due` | Chores | `date`, `timezone`, `counts`, `due`, `due_truncated`, as in `lastglance_get_overview` |
| `lastglance://people/coming-up` | Chores and People | `date`, `timezone`, `days`, `items`, as in `lastglance_list_upcoming_dates` |

No subscriptions: the transport keeps no sessions.
