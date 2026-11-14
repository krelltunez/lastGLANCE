// lastGLANCE's MCP read tools and resources (docs/mcp-and-stream-deck.md,
// 4.3; the contract is docs/mcp-tools-reference.md, which the transport suite
// holds the names to). After @glance-apps/dayglance-mcp's readTools.js.
//
// No state here: everything arrives in `deps`, owned by main.ts and closed
// over by the per-request server factory (mcpServer.ts). The tools validate
// and paginate; the page's read model (src/mcp/readModel.ts) resolves ids,
// filters and shapes, over the request bridge.
//
// Errors are tool errors (isError) with a JSON body {error: {code, message}}
// the model can branch on: renderer_unavailable, not_found, validation,
// internal. An unavailable window is never an empty result.
//
// The People tools exist only under the "Chores and People" tier: registration
// runs per request, so a tier change shows on the client's next request.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, paginate, type BridgeResult, type HostBridge } from '@glance-apps/mcp-host';
import { dateEnvelope, isValidLocalDate, localDateOf } from '@glance-apps/mcp-host/dates';
import { HISTORY_TIMEOUT_MS } from './mcpRendererBridge.js';

/** lastGLANCE's cursor prefix ("lastGLANCE cursor, version 1"): part of the wire format. */
export const CURSOR_PREFIX = 'lgc1.';
export const CHORE_STATES = ['overdue', 'soon', 'due', 'fresh', 'none', 'all'] as const;
/** The longest window lastglance_get_activity reads at once. */
export const MAX_ACTIVITY_DAYS = 366;

export interface ReadToolDeps {
  bridge: HostBridge;
  /** Epoch ms. */
  now: () => number;
  /** The IANA zone the server resolves dates in, never the client's. */
  timeZone: () => string;
  /** The "Chores and People" tier. */
  includePeople: () => boolean;
}

type Result = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (data: Record<string, unknown>): Result => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
export const toolError = (code: string, message: string): Result =>
  ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] });
const bridgeError = (r: Extract<BridgeResult, { ok: false }>) => toolError(r.error.code, r.error.message);
const data = (r: Extract<BridgeResult, { ok: true }>) => (r.data && typeof r.data === 'object' ? r.data as Record<string, unknown> : {});

const PAGING = `Paginated: default page ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}. When truncated is true, pass next_cursor back as cursor ` +
  'for the next page, with the same filters: a cursor is bound to the filters it was issued under, and changing them mid-walk ' +
  'is a validation error.';

const IDS = 'Every id is lastGLANCE\'s sync id, the same on every device; pass ids exactly as returned, never construct one.';

const CHORE_NOTE =
  ' A chore\'s state comes from how long ago it was last done against its cadence: "overdue" (past its cadence), ' +
  '"soon" (75% of the way there), "fresh", or "none" (no cadence, or never done). ratio is elapsed days over cadence ' +
  '(1.0 = due today). next_due is the local date it comes due. in_season is false for a seasonal chore outside its window; ' +
  'the app hides those.';

const pagingSchema = {
  limit: z.number().int().optional().describe(`Page size, 1-${MAX_LIST_LIMIT}. Default ${DEFAULT_LIST_LIMIT}.`),
  cursor: z.string().optional().describe("Opaque cursor from a previous response's next_cursor."),
};

function page(items: unknown[], filterKey: string, limit: unknown, cursor: unknown, extra: Record<string, unknown>, tz: string): Result {
  const p = paginate(items, { limit, cursor, filterKey, cursorPrefix: CURSOR_PREFIX });
  if (!p.ok) return toolError('validation', p.reason);
  return ok({ ...extra, items: p.items, truncated: p.truncated, next_cursor: p.nextCursor, total: p.total, timezone: tz });
}

export function registerReadTools(server: McpServer, deps: ReadToolDeps): void {
  const today = () => localDateOf(deps.now(), deps.timeZone());
  const ask = (method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => deps.bridge.request(method, params, timeoutMs);

  server.registerTool(
    'lastglance_ping',
    { description: 'Connectivity check: confirms the lastGLANCE MCP server is reachable. Reads no data.' },
    async () => ok({ ok: true, server: 'lastGLANCE MCP' }),
  );

  server.registerTool(
    'lastglance_get_overview',
    {
      description:
        'What needs doing in lastGLANCE today: counts (overdue, soon, done today, all chores), the due chores most overdue ' +
        'first (in-season only, at most 50, due_truncated when there are more), and the pinned chores.' +
        (deps.includePeople() ? ' Also reach_out (People to get in touch with, each with the reason when there is one and ' +
          'last_interaction_note, what the last contact\'s note said) and coming_up (birthdays and dates in the next 30 days).' +
          PEOPLE_NOTE : '') +
        ' Resolves today on the user\'s machine and echoes the date and IANA timezone. Start here for "what should I do".' + CHORE_NOTE,
    },
    async () => {
      const r = await ask('overview', { include_people: deps.includePeople() });
      if (!r.ok) return bridgeError(r);
      return ok({ ...dateEnvelope(today(), deps.timeZone()), ...data(r) });
    },
  );

  server.registerTool(
    'lastglance_list_chores',
    {
      description:
        'Every chore, with filters. category_id includes its subcategories. state: "overdue", "soon", "due" (overdue or soon), ' +
        '"fresh", "none" or "all" (default). assigned_to: a user id (assigned on the chore or its category), "unassigned", or ' +
        '"me" (what the app\'s Mine view shows: unassigned or mine; needs multi-user mode with Me set). query matches words in the ' +
        'name and category, accents and case ignored. due_after and due_before (local YYYY-MM-DD, both included) keep the chores ' +
        'whose next_due falls in that window, for "what comes due by Sunday"; a chore with no next_due (no cadence, never done) ' +
        'or out of season is left out when either is given. sort "next_due" lists soonest due first, overdue ones leading. ' +
        'Otherwise, with a state filter the list is most overdue first, else by category then name. ' + PAGING + ' ' + IDS + CHORE_NOTE,
      inputSchema: z.object({
        category_id: z.string().optional().describe('A category id from lastglance_list_categories.'),
        state: z.string().optional().describe('overdue, soon, due, fresh, none or all.'),
        assigned_to: z.string().optional().describe('A user id from lastglance_list_users, "unassigned" or "me".'),
        query: z.string().optional().describe('Words to find in the chore name or category.'),
        due_after: z.string().optional().describe('Only chores whose next_due is on or after this local date, YYYY-MM-DD.'),
        due_before: z.string().optional().describe('Only chores whose next_due is on or before this local date, YYYY-MM-DD.'),
        sort: z.string().optional().describe('"next_due": soonest due first. Leave out for the default order.'),
        ...pagingSchema,
      }),
    },
    async ({ category_id, state, assigned_to, query, due_after, due_before, sort, limit, cursor }) => {
      if (state !== undefined && !(CHORE_STATES as readonly string[]).includes(state)) {
        return toolError('validation', `state must be one of ${CHORE_STATES.join(', ')}, got ${JSON.stringify(state)}.`);
      }
      for (const [name, value] of [['due_after', due_after], ['due_before', due_before]] as const) {
        if (value !== undefined && !isValidLocalDate(value)) return toolError('validation', `${name} must be a local date, YYYY-MM-DD, got ${JSON.stringify(value)}.`);
      }
      if (due_after !== undefined && due_before !== undefined && due_after > due_before) {
        return toolError('validation', 'due_after must be on or before due_before.');
      }
      if (sort !== undefined && sort !== 'next_due') return toolError('validation', `sort must be "next_due", got ${JSON.stringify(sort)}.`);
      const filter = { category_id, state: state ?? 'all', assigned_to, query: query?.trim() || undefined, due_after, due_before, sort };
      const r = await ask('list_chores', filter);
      if (!r.ok) return bridgeError(r);
      return page((data(r).items as unknown[]) ?? [], JSON.stringify(filter), limit, cursor, {}, deps.timeZone());
    },
  );

  server.registerTool(
    'lastglance_get_chore',
    {
      description:
        'One chore in full: every field the chore form edits (name, category, cadence, icon, details, pinned, seasonal window, ' +
        'notifications, dayGLANCE scheduling, assignees), its state, and its most recent completions, newest first, each with ' +
        'its note and who did it (completions_limit, default 20, max 200; completions_total counts them all).' + CHORE_NOTE,
      inputSchema: z.object({
        chore_id: z.string().describe('A chore id from lastglance_list_chores or lastglance_get_overview.'),
        completions_limit: z.number().int().optional().describe('How many recent completions to return, 0-200. Default 20.'),
      }),
    },
    async ({ chore_id, completions_limit }) => {
      const r = await ask('get_chore', { chore_id, completions_limit });
      if (!r.ok) return bridgeError(r);
      return ok({ ...data(r), timezone: deps.timeZone() });
    },
  );

  server.registerTool(
    'lastglance_resolve_link',
    {
      description:
        'What a dayGLANCE task\'s link points to in lastGLANCE. A task lastGLANCE sent to dayGLANCE carries ' +
        'link: { app: "lastglance", id } in dayGLANCE\'s MCP output; pass that id here. Answers kind ("chore", ' +
        '"person" or "date") with the item: the chore as lastglance_list_chores shows it; the person as ' +
        'lastglance_list_people shows them; or, for a birthday or date (an id ending ":<year>"), the date, the year it ' +
        'was for, and its person. Then lastglance_get_chore or lastglance_get_person for the rest. ' +
        (deps.includePeople() ? '' : 'People and dates are resolved only under the "Chores and People" tier, which is off: ' +
          'an id that is not a chore comes back not_found. ') + IDS,
      inputSchema: z.object({
        id: z.string().describe('The link.id from a dayGLANCE task.'),
      }),
    },
    async ({ id }) => {
      const r = await ask('resolve_link', { id, include_people: deps.includePeople() });
      return r.ok ? ok(data(r)) : bridgeError(r);
    },
  );

  server.registerTool(
    'lastglance_list_categories',
    {
      description:
        'The category tree, flat: each category with its id, name, icon, parent_id (null at the top), path ("Home › Kitchen"), ' +
        'assignee_ids and chore_count. ' + IDS,
    },
    async () => {
      const r = await ask('list_categories');
      if (!r.ok) return bridgeError(r);
      return ok(data(r));
    },
  );

  server.registerTool(
    'lastglance_get_activity',
    {
      description:
        'What was done between two LOCAL calendar dates (YYYY-MM-DD, both included, at most 366 days apart): by_day counts ' +
        'every completion in the window, and items lists them newest first, each with its chore, note and who did it. ' + PAGING,
      inputSchema: z.object({
        from: z.string().describe('First local date, YYYY-MM-DD.'),
        to: z.string().describe('Last local date, YYYY-MM-DD, on or after from.'),
        ...pagingSchema,
      }),
    },
    async ({ from, to, limit, cursor }) => {
      if (!isValidLocalDate(from) || !isValidLocalDate(to)) {
        return toolError('validation', `from and to must be real local dates in strict YYYY-MM-DD form, got ${JSON.stringify(from)} and ${JSON.stringify(to)}.`);
      }
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
      if (days < 0) return toolError('validation', 'from must be on or before to.');
      if (days >= MAX_ACTIVITY_DAYS) return toolError('validation', `The window is at most ${MAX_ACTIVITY_DAYS} days; ask for it in parts.`);
      const r = await ask('activity', { from, to }, HISTORY_TIMEOUT_MS);
      if (!r.ok) return bridgeError(r);
      const d = data(r);
      return page((d.items as unknown[]) ?? [], `${from}|${to}`, limit, cursor, { from, to, by_day: d.by_day ?? {} }, deps.timeZone());
    },
  );

  server.registerTool(
    'lastglance_list_users',
    {
      description:
        'The household members chores can be assigned to, as { id, name }, with multi_user_enabled and me_user_id (who this ' +
        'device is, when multi-user mode is on). Resolve names through this list; never guess an id.',
    },
    async () => {
      const r = await ask('list_users');
      if (!r.ok) return bridgeError(r);
      return ok(data(r));
    },
  );

  if (deps.includePeople()) registerPeopleTools(server, deps);
}

const PEOPLE_NOTE =
  ' People are the user\'s private notes about other people; read them only to help the user stay in touch. ' +
  'With multi-user mode on, only this user\'s People are returned, as the app shows them. ratio is days since the last ' +
  'contact over the person\'s cadence (1.0 = due), due_on the local date the next catch-up comes due. ' +
  'last_interaction_note is the note on the last contact (the first 280 characters; lastglance_get_person has each note in full), ' +
  'for suggesting what to follow up on; null when that contact has no note.';

function registerPeopleTools(server: McpServer, deps: ReadToolDeps): void {
  const ask = (method: string, params: Record<string, unknown> = {}) => deps.bridge.request(method, params);

  server.registerTool(
    'lastglance_list_people',
    {
      description:
        'People, with filters. circle_id is a circle id from lastglance_list_circles, or "none" for people in no circle. ' +
        'Archived people are left out unless include_archived is true. query matches words in the name and nickname. ' +
        'Sorted by name. ' + PAGING + ' ' + IDS + PEOPLE_NOTE,
      inputSchema: z.object({
        circle_id: z.string().optional().describe('A circle id, or "none".'),
        include_archived: z.boolean().optional().describe('Default false.'),
        query: z.string().optional().describe('Words to find in the name or nickname.'),
        ...pagingSchema,
      }),
    },
    async ({ circle_id, include_archived, query, limit, cursor }) => {
      const filter = { circle_id, include_archived: include_archived === true, query: query?.trim() || undefined };
      const r = await ask('list_people', filter);
      if (!r.ok) return bridgeError(r);
      return page((data(r).items as unknown[]) ?? [], JSON.stringify(filter), limit, cursor, {}, deps.timeZone());
    },
  );

  server.registerTool(
    'lastglance_get_person',
    {
      description:
        'One person in full: every field the person form edits (name, nickname, circle, cadence, preferred channel, details, ' +
        'snooze, archive, notification and GLANCE switches), their birthday and dates with the next time each falls, whether ' +
        'they are waiting on a reply (reciprocity), and the most recent contacts, newest first (interactions_limit, default 20, ' +
        'max 200).' + PEOPLE_NOTE,
      inputSchema: z.object({
        person_id: z.string().describe('A person id from lastglance_list_people.'),
        interactions_limit: z.number().int().optional().describe('How many recent contacts to return, 0-200. Default 20.'),
      }),
    },
    async ({ person_id, interactions_limit }) => {
      const r = await ask('get_person', { person_id, interactions_limit });
      if (!r.ok) return bridgeError(r);
      return ok({ ...data(r), timezone: deps.timeZone() });
    },
  );

  server.registerTool(
    'lastglance_list_upcoming_dates',
    {
      description:
        'Birthdays, anniversaries and other dates falling in the next `days` days (default 30, max 366), soonest first, each ' +
        'with the local date it falls on, days_until, and turning (the age or years, when the year is known).' + PEOPLE_NOTE,
      inputSchema: z.object({ days: z.number().int().optional().describe('0-366. Default 30.') }),
    },
    async ({ days }) => {
      const r = await ask('upcoming_dates', { days });
      if (!r.ok) return bridgeError(r);
      return ok({ ...dateEnvelope(localDateOf(deps.now(), deps.timeZone()), deps.timeZone()), ...data(r) });
    },
  );

  server.registerTool(
    'lastglance_list_circles',
    { description: 'The circles People are grouped in, in the app\'s order, with how many people each holds. ' + IDS },
    async () => {
      const r = await ask('list_circles');
      if (!r.ok) return bridgeError(r);
      return ok(data(r));
    },
  );
}

/** Resource reads have no error channel of their own: a failure throws, with the same code first. Never empty contents. */
const resourceError = (r: Extract<BridgeResult, { ok: false }>) => new Error(`[${r.error.code}] ${r.error.message}`);

export function registerResources(server: McpServer, deps: ReadToolDeps): void {
  const today = () => localDateOf(deps.now(), deps.timeZone());
  const json = (uri: string, body: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(body) }] });

  server.registerResource(
    'lastglance-chores-due',
    'lastglance://chores/due',
    {
      title: 'Chores due',
      description: 'The chores due now, most overdue first, with today\'s counts. The same data as lastglance_get_overview, without People.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const r = await deps.bridge.request('overview', { include_people: false });
      if (!r.ok) throw resourceError(r);
      const d = data(r);
      return json(uri.href, { ...dateEnvelope(today(), deps.timeZone()), counts: d.counts, due: d.due, due_truncated: d.due_truncated });
    },
  );

  if (!deps.includePeople()) return;
  server.registerResource(
    'lastglance-people-coming-up',
    'lastglance://people/coming-up',
    {
      title: 'Coming up',
      description: 'Birthdays and dates in the next 30 days, soonest first. The same data as lastglance_list_upcoming_dates.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const r = await deps.bridge.request('upcoming_dates', { days: 30 });
      if (!r.ok) throw resourceError(r);
      return json(uri.href, { ...dateEnvelope(today(), deps.timeZone()), ...data(r) });
    },
  );
}
