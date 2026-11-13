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
- **Dates and times.** A date is the user's local calendar date, `YYYY-MM-DD`,
  resolved on the user's machine; a dated response echoes `date` (or
  `from`/`to`) and the IANA `timezone`. A time is an ISO instant as stored
  (`completed_at`, `occurred_at`).
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
| `limit`, `cursor` | Pagination. |

Each item is a chore summary: `id`, `name`, `icon`, `category_id`,
`category_path`, `state`, `ratio`, `cadence_days`, `last_completed_at`,
`elapsed_days`, `next_due`, `pinned`, `in_season`, `assignee_ids`. With a state
filter the list is most overdue first, otherwise by category path then name.

### `lastglance_get_chore`

| Argument | |
|---|---|
| `chore_id` | Required. |
| `completions_limit` | Optional, 0-200, default 20. |

The chore summary plus every field the chore form edits: `details`,
`seasonal_start`, `seasonal_end` (`MM-DD`), `notify_when_overdue`,
`auto_schedule_to_dayglance`, `preferred_schedule_behavior`; and `created_at`,
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
`last_channel`, `elapsed_days`, `ratio`, `due_on`, `snoozed_until` (only while
snoozed), `archived`. Sorted by name.

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

Not changed over MCP, on purpose:

- **Deleting** anything: chores, completions, categories. A delete is done in
  the app. An undo of an MCP create is the one removal, and it declines when
  the user has added to the item since (a chore done since, a category with
  chores in it).
- **A completion's time, completer and source**: no form edits them.
- **`preferred_schedule_behavior`**: no form edits it.
- **Household members and this device's settings** (multi-user mode, who is
  Me): edited in Settings, about the device rather than the household's data.
- **People, dates, contacts and circles**: the People write tools come next,
  under the same rules.

## Write tools

### `lastglance_complete_chore`

| Argument | |
|---|---|
| `chore_id` | Required. |
| `completed_at` | Optional ISO 8601 time with a zone, e.g. `2026-11-12T18:30:00-07:00`. Default now. Never in the future. |
| `note` | Optional. |
| `idempotency_key` | Optional. |

Returns `completion` (`id`, `completed_at`, `note`) and `chore`, as
`lastglance_get_chore` shows it.

### `lastglance_update_completion`

`completion_id`, `note` (text, or null to clear), `idempotency_key`. Returns
`completion` and `chore`.

### `lastglance_create_chore`

`name` (required), and optionally `category_id`, `cadence_days`, `icon`,
`details`, `pinned`, `notify_when_overdue`, `auto_schedule_to_dayglance`,
`season` (`{ start, end }` or null), `assignee_ids`, `position`,
`idempotency_key`. Returns `chore`. A chore with the same name already in the
category is returned instead, with `already_existed: true`.

### `lastglance_update_chore`

`chore_id`, and any of the create fields. Only the fields given change; null
clears one. Returns `chore`.

### `lastglance_create_category`

`name` (required), and optionally `icon`, `parent_id`, `assignee_ids`,
`position`, `idempotency_key`. Returns `category`, as
`lastglance_list_categories` shows it.

### `lastglance_update_category`

`category_id`, and any of `name`, `icon` (null for none), `parent_id` (null
for top level), `assignee_ids`, `position`. Returns `category`.

## The write journal

### `lastglance_list_mcp_writes`

| Argument | |
|---|---|
| `chore_id`, `category_id` | Optional filters. |
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
