// lastGLANCE's MCP write tools (docs/mcp-and-stream-deck.md, 4.5; the contract
// and the field audit are in docs/mcp-tools-reference.md). After dayGLANCE's
// electron/mcpWriteTools.ts. No state here: the gate, the replay store, the
// journal and the bridge are main.ts's, closed over per request.
//
// Every write, in order:
//   1. consent: without "Allow changes" a write is a read_only_mode error;
//   2. replay: a known (token, tool, idempotency_key) returns the first
//      result, with no gate charge and no change;
//   3. the gate: 30 writes a minute per token, and repeated overruns turn
//      writes off until lastGLANCE restarts;
//   4. the page applies it through the data layer the app's forms use
//      (src/mcp/writeModel.ts), refusing what a form would not save, and
//      returns the entity plus the undo record, which goes to the journal and
//      never into the tool's output.
//
// A create's id is derived from its idempotency key, so a retry after the
// replay store has forgotten it still finds its own row and changes nothing.
// Nothing is ever deleted.

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  isValidIdempotencyKey, makeStoreKey,
  type HostBridge, type IdempotencyStore, type WriteGate,
} from '@glance-apps/mcp-host';
import { isUndoOp, type McpJournal } from './mcpJournal.js';
import { toolError } from './mcpReadTools.js';
import { parseTimeInput } from './mcpTimes.js';
import { isValidLocalDate } from '@glance-apps/mcp-host/dates';

export interface WriteToolDeps {
  bridge: HostBridge;
  gate: WriteGate;
  store: IdempotencyStore<Record<string, unknown>>;
  /** The bearer token: the gate's and the replay store's key. */
  token: () => string;
  /** "Allow changes" in Settings, read per call. */
  includeWrites: () => boolean;
  /** The "Chores and People" tier: the People write tools exist only under it, as the People reads do. */
  includePeople: () => boolean;
  /** Fired once, when repeated overruns turn writes off. */
  onWritesDisabled: () => void;
  journal?: McpJournal;
  /** After every write that changed something. */
  onWrite?: () => void;
  /** The IANA zone a local time input ("2026-11-13 19:30") is read in; this machine's by default. */
  timeZone?: () => string;
}

type Result = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const ok = (data: Record<string, unknown>): Result => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

/** A sync id from the idempotency key: the same key always names the same row. */
export function idFromKey(storeKey: string): string {
  const h = createHash('sha256').update(storeKey).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The most completions lastglance_complete_chores takes at once (under the rate limit of 30 a minute). */
export const MAX_BATCH = 25;
/** The errors that end a batch: the rest would meet them too. */
const STOPS_BATCH = new Set(['rate_limited', 'writes_disabled', 'renderer_unavailable']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_FORMS = 'a local time "2026-11-12 18:30", or ISO 8601 with a zone, "2026-11-12T18:30:00-07:00"';

const KEY = z.string().optional()
  .describe('Optional retry token, 1-128 characters of [A-Za-z0-9_.:-]. Sending the same key again returns the first result and changes nothing. Use one per intended change.');
const POSITION = z.number().int().optional().describe('Where it goes among its siblings, 0 for first; past the end means last. Leave out to keep the order.');
const ICON = 'A Lucide icon name the app knows, e.g. "Sprout" (the names lastglance_get_chore shows).';
const SEASON = z.object({ start: z.string(), end: z.string() }).nullable().optional()
  .describe('Seasonal window as MM-DD days, e.g. {"start":"04-01","end":"10-31"}; an end before the start wraps the new year. The app hides the chore outside it. null for all year.');
const ASSIGNEES = z.array(z.string()).optional().describe('User ids from lastglance_list_users. An empty list means everyone.');

const NO_DELETE = ' Nothing can be deleted over MCP: removing anything is done in the app.';
const UNDO_NOTE = ' The user can undo this change from lastGLANCE.';

export function registerWriteTools(server: McpServer, deps: WriteToolDeps): void {
  const zone = () => deps.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  /** The pipeline: consent, replay, gate, then the page. `newId` is for creates. */
  const write = async (tool: string, key: unknown, method: string, params: (newId: string) => Record<string, unknown>): Promise<Result> => {
    if (!deps.includeWrites()) {
      return toolError('read_only_mode', 'lastGLANCE is read-only for assistants: "Allow changes" is off in its Settings. Ask the user to turn it on.');
    }
    let storeKey: string | null = null;
    if (key !== undefined) {
      if (!isValidIdempotencyKey(key)) return toolError('validation', 'idempotency_key must be 1-128 characters of [A-Za-z0-9_.:-].');
      storeKey = makeStoreKey(deps.token(), tool, key);
      const replay = deps.store.get(storeKey);
      if (replay) return ok({ ...replay, replayed: true });
    }
    const admission = deps.gate.tryWrite(deps.token());
    if (!admission.allowed) {
      if (admission.disabledNow) deps.onWritesDisabled();
      return admission.reason === 'writes_disabled'
        ? toolError('writes_disabled', 'Changes have been turned off after repeated overruns of the rate limit. They come back when the user restarts lastGLANCE.')
        : toolError('rate_limited', 'At most 30 changes a minute. Wait before retrying; repeated overruns turn changes off.');
    }
    const r = await deps.bridge.request(method, params(storeKey ? idFromKey(storeKey) : randomUUID()));
    if (!r.ok) return toolError(r.error.code, r.error.message);
    const data = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
    if (isUndoOp((r.undo as { op?: unknown } | undefined)?.op) && deps.journal) {
      const undo = r.undo as { summary: string; op: Parameters<McpJournal['append']>[0]['op'] };
      deps.journal.append({ tool: `lastglance_${tool}`, summary: undo.summary, op: undo.op, ...(typeof key === 'string' && { idempotencyKey: key }) });
    }
    if (r.undo) deps.onWrite?.();
    if (storeKey) deps.store.put(storeKey, data);
    return ok(data);
  };

  /** The fields an update names, and only those: null is a value (clear it), absent is untouched. */
  const named = (args: Record<string, unknown>, keys: readonly string[]) =>
    Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

  server.registerTool(
    'lastglance_complete_chore',
    {
      description:
        'Mark a chore done, now or at an earlier time (never a future one), optionally with a note. The completion is by this ' +
        'device\'s user, as when the user taps it in the app. Returns the completion and the chore as it now stands.' + UNDO_NOTE,
      inputSchema: z.object({
        chore_id: z.string().describe('A chore id from lastglance_list_chores or lastglance_get_overview.'),
        completed_at: z.string().optional().describe(`When it was done: ${TIME_FORMS}. Default now.`),
        note: z.string().optional().describe('A note on this completion.'),
        idempotency_key: KEY,
      }),
    },
    async ({ chore_id, completed_at, note, idempotency_key }) => {
      const at = completed_at === undefined ? undefined : parseTimeInput(completed_at, zone());
      if (at === null) return toolError('validation', `completed_at must be ${TIME_FORMS}, got ${JSON.stringify(completed_at)}.`);
      return write('complete_chore', idempotency_key, 'complete_chore', (new_id) => ({ chore_id, completed_at: at, note, new_id }));
    },
  );

  server.registerTool(
    'lastglance_complete_chores',
    {
      description:
        `Mark several chores done in one call, e.g. "did all four bathrooms Saturday morning". Each is an ordinary completion, ` +
        'exactly as if completed one at a time: the chores stay separate, nothing groups them, and each change is undone on its own. ' +
        'completed_at and note at the top apply to every item that gives none of its own. ' +
        `At most ${MAX_BATCH} items. Every time is checked before anything is written. One item failing (an unknown id, say) ` +
        'does not stop the others; reaching the rate limit (or the window not answering) stops the batch, and the items after ' +
        'it come back not_attempted, ' +
        'to retry later. One idempotency_key covers the whole batch: a retry with it repeats nothing that already went through.' + UNDO_NOTE,
      inputSchema: z.object({
        completions: z.array(z.object({
          chore_id: z.string(),
          completed_at: z.string().optional(),
          note: z.string().optional(),
        })).describe(`The chores, 1 to ${MAX_BATCH}, each with an optional time and note of its own.`),
        completed_at: z.string().optional().describe(`When they were done, for items without their own: ${TIME_FORMS}. Default now.`),
        note: z.string().optional().describe('A note for items without their own.'),
        idempotency_key: z.string().optional().describe('Makes a retried batch safe: 1-120 characters of [A-Za-z0-9_.:-].'),
      }),
    },
    async (args) => {
      if (!deps.includeWrites()) {
        return toolError('read_only_mode', 'lastGLANCE is read-only for assistants: "Allow changes" is off in its Settings. Ask the user to turn it on.');
      }
      const items = args.completions;
      if (items.length < 1 || items.length > MAX_BATCH) return toolError('validation', `completions takes 1 to ${MAX_BATCH} items, got ${items.length}.`);
      const key = args.idempotency_key;
      if (key !== undefined && (!isValidIdempotencyKey(key) || key.length > 120)) {
        return toolError('validation', 'idempotency_key must be 1-120 characters of [A-Za-z0-9_.:-].');
      }
      // Every time first, so a bad one writes nothing.
      const times: (string | undefined)[] = [];
      for (const [i, item] of items.entries()) {
        const given = item.completed_at ?? args.completed_at;
        const at = given === undefined ? undefined : parseTimeInput(given, zone());
        if (at === null) return toolError('validation', `completions[${i}].completed_at must be ${TIME_FORMS}, got ${JSON.stringify(given)}.`);
        times.push(at);
      }
      const results: Record<string, unknown>[] = [];
      let stopped: { code: string; message: string } | null = null;
      for (const [i, item] of items.entries()) {
        if (stopped) {
          results.push({ chore_id: item.chore_id, ok: false, error: { code: 'not_attempted', message: `Not tried: ${stopped.message}` } });
          continue;
        }
        const note = item.note ?? args.note;
        const r = await write('complete_chores', key === undefined ? undefined : `${key}:${i}`, 'complete_chore',
          (new_id) => ({ chore_id: item.chore_id, completed_at: times[i], note, new_id }));
        if (r.isError) {
          const error = (JSON.parse(r.content[0].text) as { error: { code: string; message: string } }).error;
          // The window not answering is the whole call's error while nothing has gone through, as for every tool.
          if (error.code === 'renderer_unavailable' && !results.some((x) => x.ok)) return r;
          results.push({ chore_id: item.chore_id, ok: false, error });
          if (STOPS_BATCH.has(error.code)) stopped = error;
        } else {
          results.push({ chore_id: item.chore_id, ok: true, ...r.structuredContent });
        }
      }
      return ok({ completed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results });
    },
  );

  server.registerTool(
    'lastglance_send_to_dayglance',
    {
      description:
        'Send a chore to dayGLANCE as a linked task: done there, it is the chore done here, as when the user sends it from ' +
        'the app. Works for any chore, due or not. start places it: a local time "2026-11-15 09:00" (or ISO 8601 with a ' +
        'zone) for a timed block, a date "2026-11-15" for an all-day task, or leave it out for the dayGLANCE inbox. ' +
        'DURATION: only a timed send carries one, duration_minutes or else the chore\'s own duration_minutes; an all-day ' +
        'or inbox send gets dayGLANCE\'s default length, so to set it, resize the block with dayglance_resize_block or ' +
        'set it with dayglance_update_task once it is in dayGLANCE. Returns dayglance_task_id, the id the task gets in ' +
        'dayGLANCE, with pending: true: the task appears once dayGLANCE picks the send up, which can take a while. ' +
        'To MOVE or RESIZE it later, use dayGLANCE\'s tools on that id (dayglance_move_block, dayglance_resize_block, ' +
        'dayglance_schedule_task for an inbox task), never another send: a send for a different time makes a second ' +
        'task. A send for the same start updates the same task. When this device sent the chore before for another ' +
        'time and has had no word since that it was completed or deleted, the result carries a warning and ' +
        'previous_send: check that task in dayGLANCE. Needs the dayGLANCE integration on in lastGLANCE ' +
        '(not_connected otherwise). Not undone from lastGLANCE: remove the task in dayGLANCE.',
      inputSchema: z.object({
        chore_id: z.string().describe('A chore id from lastglance_list_chores or lastglance_get_overview.'),
        start: z.string().optional().describe(`${TIME_FORMS} for a timed block; "YYYY-MM-DD" for all day; leave out for the inbox.`),
        duration_minutes: z.number().int().optional().describe('Timed sends only: the block\'s length, 1 to 1440. Default the chore\'s own duration_minutes, else dayGLANCE\'s default.'),
        idempotency_key: KEY,
      }),
    },
    async ({ chore_id, start, duration_minutes, idempotency_key }) => {
      let due: string | undefined;
      let allDay: boolean | undefined;
      if (start !== undefined) {
        if (DATE_ONLY.test(start)) {
          if (!isValidLocalDate(start)) return toolError('validation', `start ${JSON.stringify(start)} is not a date.`);
          due = start;
          allDay = true;
        } else {
          const at = parseTimeInput(start, zone());
          if (at === null) return toolError('validation', `start must be ${TIME_FORMS}, or a date "YYYY-MM-DD" for all day, got ${JSON.stringify(start)}.`);
          due = at;
          allDay = false;
        }
      }
      if (duration_minutes !== undefined && allDay !== false) {
        return toolError('validation', 'duration_minutes needs a timed start ("2026-11-15 09:00"): an all-day or inbox send takes ' +
          'dayGLANCE\'s default length. Send it, then set the length with dayglance_resize_block or dayglance_update_task.');
      }
      return write('send_to_dayglance', idempotency_key, 'send_to_dayglance', () => ({
        chore_id, ...(due !== undefined && { due, all_day: allDay }), ...(duration_minutes !== undefined && { duration_minutes }),
      }));
    },
  );

  server.registerTool(
    'lastglance_update_completion',
    {
      description: 'Change the note on one completion, as the app allows; nothing else about a completion can change. ' +
        'Completion ids are in lastglance_get_chore and lastglance_get_activity.' + UNDO_NOTE,
      inputSchema: z.object({
        completion_id: z.string(),
        note: z.string().nullable().describe('The new note, or null to clear it.'),
        idempotency_key: KEY,
      }),
    },
    async ({ completion_id, note, idempotency_key }) =>
      write('update_completion', idempotency_key, 'update_completion', () => ({ completion_id, note })),
  );

  const choreFieldsSchema = {
    cadence_days: z.number().int().nullable().optional().describe('How often, in whole days, 1 or more; null for no cadence.'),
    duration_minutes: z.number().int().nullable().optional().describe('How long it takes, in minutes, 1 to 1440; null to clear. The task length when it is sent to dayGLANCE at a set time.'),
    icon: z.string().nullable().optional().describe(`${ICON} null for none.`),
    details: z.string().nullable().optional().describe('Notes about the chore, at most 2000 characters; null to clear.'),
    pinned: z.boolean().optional().describe('Also shown in the Pinned row.'),
    notify_when_overdue: z.boolean().optional().describe('A reminder once it is overdue (needs a cadence).'),
    auto_schedule_to_dayglance: z.boolean().optional().describe('Send it to dayGLANCE once overdue (needs a cadence and the dayGLANCE integration).'),
    season: SEASON,
    assignee_ids: ASSIGNEES,
    position: POSITION,
  };

  server.registerTool(
    'lastglance_create_chore',
    {
      description:
        'Add a chore. With no category_id it goes to the Inbox, as an add from anywhere in the app does. Left out, the icon is ' +
        'the category\'s and the assignees are the category\'s, as in the app\'s form. A chore with the same name already in that ' +
        'category is returned instead, with already_existed true.' + UNDO_NOTE,
      inputSchema: z.object({
        name: z.string().describe('Required.'),
        category_id: z.string().optional().describe('A category id from lastglance_list_categories. Default the Inbox.'),
        ...choreFieldsSchema,
        idempotency_key: KEY,
      }),
    },
    async (args) => write('create_chore', args.idempotency_key, 'create_chore', (new_id) => ({
      new_id, name: args.name, ...named(args, ['category_id', ...Object.keys(choreFieldsSchema)]),
    })),
  );

  const CHORE_EDITABLE = ['name', 'category_id', 'cadence_days', 'icon', 'details', 'pinned', 'notify_when_overdue', 'auto_schedule_to_dayglance', 'season', 'assignee_ids'];
  server.registerTool(
    'lastglance_update_chore',
    {
      description:
        'Change a chore: any field the app\'s chore form edits, and its position. Only the fields given change; null clears one. ' +
        'Moving it to another category keeps its assignees, as in the app.' + NO_DELETE + UNDO_NOTE,
      inputSchema: z.object({
        chore_id: z.string(),
        name: z.string().optional(),
        category_id: z.string().optional().describe('Move it to this category.'),
        ...choreFieldsSchema,
        idempotency_key: KEY,
      }),
    },
    async (args) => write('update_chore', args.idempotency_key, 'update_chore', () => ({
      chore_id: args.chore_id, fields: named(args, CHORE_EDITABLE), ...(args.position !== undefined && { position: args.position }),
    })),
  );

  server.registerTool(
    'lastglance_create_category',
    {
      description:
        'Add a category, or a subcategory under a top-level one (the app has two levels). A subcategory takes its parent\'s icon ' +
        'when none is given; assignees are not inherited.' + UNDO_NOTE,
      inputSchema: z.object({
        name: z.string(),
        icon: z.string().optional().describe(ICON),
        parent_id: z.string().optional().describe('A top-level category id, for a subcategory.'),
        assignee_ids: ASSIGNEES,
        position: POSITION,
        idempotency_key: KEY,
      }),
    },
    async (args) => write('create_category', args.idempotency_key, 'create_category', (new_id) => ({
      new_id, name: args.name, ...named(args, ['icon', 'parent_id', 'assignee_ids', 'position']),
    })),
  );

  server.registerTool(
    'lastglance_update_category',
    {
      description:
        'Change a category: name, icon, parent, assignees, and its position among its siblings. parent_id null makes it ' +
        'top-level. Putting a category under another lifts its own subcategories beside it, as the app does, since the app ' +
        'draws two levels.' + NO_DELETE + UNDO_NOTE,
      inputSchema: z.object({
        category_id: z.string(),
        name: z.string().optional(),
        icon: z.string().nullable().optional().describe(`${ICON} null for none.`),
        parent_id: z.string().nullable().optional(),
        assignee_ids: ASSIGNEES,
        position: POSITION,
        idempotency_key: KEY,
      }),
    },
    async (args) => write('update_category', args.idempotency_key, 'update_category', () => ({
      category_id: args.category_id, fields: named(args, ['name', 'icon', 'parent_id', 'assignee_ids']),
      ...(args.position !== undefined && { position: args.position }),
    })),
  );

  if (deps.includePeople()) registerPeopleWriteTools(server, write, named, zone);
}

type Write = (tool: string, key: unknown, method: string, params: (newId: string) => Record<string, unknown>) => Promise<Result>;
type Named = (args: Record<string, unknown>, keys: readonly string[]) => Record<string, unknown>;

const PEOPLE_NOTE = ' Only this user\'s People can be changed, as the People screens show them.';
const CHANNEL = 'in_person, call, video, text, email or other.';
const DATE_SCHEMA = {
  kind: z.string().optional().describe('birthday (default), anniversary or custom.'),
  label: z.string().nullable().optional().describe('A custom date\'s name; ignored for a birthday or anniversary, as in the app.'),
  month: z.number().int().optional().describe('1-12.'),
  day: z.number().int().optional().describe('A real day of that month; Feb 29 is allowed.'),
  year: z.number().int().nullable().optional().describe('The year it started, when known (for the age or years); null when unknown.'),
  remind_days_before: z.number().int().optional().describe('0 (on the day, the default), 1, 2, 3, 7 or 14, as the app offers.'),
};
const DATE_KEYS = Object.keys(DATE_SCHEMA);

function registerPeopleWriteTools(server: McpServer, write: Write, named: Named, zone: () => string): void {
  const personFields = {
    nickname: z.string().nullable().optional(),
    circle_id: z.string().nullable().optional().describe('A circle id from lastglance_list_circles, or null for none.'),
    cadence_days: z.number().int().nullable().optional().describe('How often to be in touch, in whole days, 1 or more (the app shows weeks: 7 a week); null for none.'),
    preferred_channel: z.string().nullable().optional().describe(`${CHANNEL} null for no preference.`),
    details: z.string().nullable().optional().describe('Notes about the person; null to clear.'),
    notify_when_overdue: z.boolean().optional().describe('In the daily People digest once overdue (needs a cadence).'),
    add_to_dayglance_when_overdue: z.boolean().optional().describe('Send a task to dayGLANCE once overdue (needs a cadence and the dayGLANCE integration).'),
    send_to_lifeglance: z.boolean().optional().describe('Send each contact logged with them to the lifeGLANCE timeline (needs the integration).'),
  };
  const PERSON_KEYS = Object.keys(personFields);

  server.registerTool(
    'lastglance_create_person',
    {
      description: 'Add a person to People, optionally with their birthday and other dates. With multi-user mode on, the person is this ' +
        'user\'s, as when added in the app.' + UNDO_NOTE,
      inputSchema: z.object({
        name: z.string(),
        ...personFields,
        dates: z.array(z.object(DATE_SCHEMA)).optional().describe('Dates to add with them, each as in lastglance_add_person_date.'),
        idempotency_key: KEY,
      }),
    },
    async (args) => write('create_person', args.idempotency_key, 'create_person', (new_id) => ({
      new_id, name: args.name, ...named(args, [...PERSON_KEYS, 'dates']),
    })),
  );

  server.registerTool(
    'lastglance_update_person',
    {
      description: 'Change a person: any field the person form edits, and archive or snooze them as the app\'s buttons do. ' +
        'Only the fields given change; null clears one. Their dates change with lastglance_add_person_date and ' +
        'lastglance_update_person_date.' + PEOPLE_NOTE + NO_DELETE + UNDO_NOTE,
      inputSchema: z.object({
        person_id: z.string(),
        name: z.string().optional(),
        ...personFields,
        archived: z.boolean().optional().describe('Archived people leave Reach out and the lists, as in the app.'),
        snooze_days: z.number().int().nullable().optional().describe('Hide them from Reach out for 3, 7 or 14 days, as the app offers; null ends a snooze.'),
        idempotency_key: KEY,
      }),
    },
    async (args) => write('update_person', args.idempotency_key, 'update_person', () => ({
      person_id: args.person_id, fields: named(args, ['name', ...PERSON_KEYS, 'archived', 'snooze_days']),
    })),
  );

  server.registerTool(
    'lastglance_add_person_date',
    {
      description: 'Add a birthday, anniversary or custom date to a person.' + PEOPLE_NOTE + UNDO_NOTE,
      inputSchema: z.object({ person_id: z.string(), ...DATE_SCHEMA, idempotency_key: KEY }),
    },
    async (args) => write('add_person_date', args.idempotency_key, 'add_person_date', (new_id) => ({
      new_id, person_id: args.person_id, ...named(args, DATE_KEYS),
    })),
  );

  server.registerTool(
    'lastglance_update_person_date',
    {
      description: 'Change one of a person\'s dates (ids are in lastglance_get_person). Only the fields given change.' + PEOPLE_NOTE + NO_DELETE + UNDO_NOTE,
      inputSchema: z.object({ date_id: z.string(), ...DATE_SCHEMA, idempotency_key: KEY }),
    },
    async (args) => write('update_person_date', args.idempotency_key, 'update_person_date', () => ({
      date_id: args.date_id, fields: named(args, DATE_KEYS),
    })),
  );

  const contactFields = {
    channel: z.string().optional().describe(`${CHANNEL} On a new contact, the first person's preferred channel, else the last one used, by default.`),
    direction: z.string().nullable().optional().describe('outbound (the user reached out), inbound (they did), mutual, or null for not recorded.'),
    note: z.string().nullable().optional(),
    occurred_at: z.string().optional().describe(`When: ${TIME_FORMS}; never in the future. Default now.`),
  };

  server.registerTool(
    'lastglance_log_interaction',
    {
      description: 'Log a contact with one or more people (a dinner with three friends is one contact). Logging ends their snooze, ' +
        'as in the app. Archived people cannot be logged with.' + PEOPLE_NOTE + UNDO_NOTE,
      inputSchema: z.object({
        person_ids: z.array(z.string()).describe('At least one person id from lastglance_list_people.'),
        ...contactFields,
        idempotency_key: KEY,
      }),
    },
    async (args) => {
      const at = args.occurred_at === undefined ? undefined : parseTimeInput(args.occurred_at, zone());
      if (at === null) return toolError('validation', `occurred_at must be ${TIME_FORMS}, got ${JSON.stringify(args.occurred_at)}.`);
      return write('log_interaction', args.idempotency_key, 'log_interaction', (new_id) => ({
        new_id, person_ids: args.person_ids, ...named({ ...args, occurred_at: at }, Object.keys(contactFields)),
      }));
    },
  );

  server.registerTool(
    'lastglance_update_interaction',
    {
      description: 'Change a logged contact (ids are in lastglance_get_person): who it was with, the channel, direction, note or time. ' +
        'Only the fields given change.' + PEOPLE_NOTE + NO_DELETE + UNDO_NOTE,
      inputSchema: z.object({
        interaction_id: z.string(),
        person_ids: z.array(z.string()).optional(),
        ...contactFields,
        idempotency_key: KEY,
      }),
    },
    async (args) => {
      const at = args.occurred_at === undefined ? undefined : parseTimeInput(args.occurred_at, zone());
      if (at === null) return toolError('validation', `occurred_at must be ${TIME_FORMS}, got ${JSON.stringify(args.occurred_at)}.`);
      return write('update_interaction', args.idempotency_key, 'update_interaction', () => ({
        interaction_id: args.interaction_id, fields: named({ ...args, occurred_at: at }, ['person_ids', ...Object.keys(contactFields)]),
      }));
    },
  );

  server.registerTool(
    'lastglance_create_circle',
    {
      description: 'Add a circle to group People in. Circles have a name and an order; the app sets no icon on them.' + UNDO_NOTE,
      inputSchema: z.object({ name: z.string(), position: POSITION, idempotency_key: KEY }),
    },
    async (args) => write('create_circle', args.idempotency_key, 'create_circle', (new_id) => ({
      new_id, name: args.name, ...named(args, ['position']),
    })),
  );

  server.registerTool(
    'lastglance_update_circle',
    {
      description: 'Rename a circle, or move it in the order.' + NO_DELETE + UNDO_NOTE,
      inputSchema: z.object({ circle_id: z.string(), name: z.string().optional(), position: POSITION, idempotency_key: KEY }),
    },
    async (args) => write('update_circle', args.idempotency_key, 'update_circle', () => ({
      circle_id: args.circle_id, fields: named(args, ['name']), ...(args.position !== undefined && { position: args.position }),
    })),
  );
}

/** The journal, as a read: what MCP changed this session. Under the read tier, whatever "Allow changes" says. */
export function registerJournalReadTool(server: McpServer, journal: McpJournal): void {
  server.registerTool(
    'lastglance_list_mcp_writes',
    {
      description:
        'What assistants changed in lastGLANCE this session, newest first: when, which tool, a summary, the ids, and each changed ' +
        'field\'s value before. Filter by one id. Cleared when lastGLANCE restarts, and as the user undoes changes.',
      inputSchema: z.object({
        chore_id: z.string().optional(),
        category_id: z.string().optional(),
        person_id: z.string().optional(),
        interaction_id: z.string().optional(),
        circle_id: z.string().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().optional(),
      }),
    },
    async ({ chore_id, category_id, person_id, interaction_id, circle_id, limit, cursor }) => {
      const page = journal.page({ match: { chore_id, category_id, person_id, interaction_id, circle_id }, limit, cursor });
      if (!page.ok) return toolError('validation', page.reason);
      return ok({ items: page.items, truncated: page.truncated, next_cursor: page.nextCursor, total: page.total });
    },
  );
}
