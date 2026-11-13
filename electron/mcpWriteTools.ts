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

export interface WriteToolDeps {
  bridge: HostBridge;
  gate: WriteGate;
  store: IdempotencyStore<Record<string, unknown>>;
  /** The bearer token: the gate's and the replay store's key. */
  token: () => string;
  /** "Allow changes" in Settings, read per call. */
  includeWrites: () => boolean;
  /** Fired once, when repeated overruns turn writes off. */
  onWritesDisabled: () => void;
  journal?: McpJournal;
  /** After every write that changed something. */
  onWrite?: () => void;
}

type Result = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const ok = (data: Record<string, unknown>): Result => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

/** A sync id from the idempotency key: the same key always names the same row. */
export function idFromKey(storeKey: string): string {
  const h = createHash('sha256').update(storeKey).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

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
        completed_at: z.string().optional().describe('When it was done: ISO 8601 with a zone, e.g. "2026-11-12T18:30:00-07:00". Default now.'),
        note: z.string().optional().describe('A note on this completion.'),
        idempotency_key: KEY,
      }),
    },
    async ({ chore_id, completed_at, note, idempotency_key }) => {
      if (completed_at !== undefined && (!ISO_TIME.test(completed_at) || Number.isNaN(Date.parse(completed_at)))) {
        return toolError('validation', `completed_at must be ISO 8601 with a zone, e.g. "2026-11-12T18:30:00-07:00", got ${JSON.stringify(completed_at)}.`);
      }
      return write('complete_chore', idempotency_key, 'complete_chore', (new_id) => ({ chore_id, completed_at, note, new_id }));
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
}

/** The journal, as a read: what MCP changed this session. Under the read tier, whatever "Allow changes" says. */
export function registerJournalReadTool(server: McpServer, journal: McpJournal): void {
  server.registerTool(
    'lastglance_list_mcp_writes',
    {
      description:
        'What assistants changed in lastGLANCE this session, newest first: when, which tool, a summary, the ids, and each changed ' +
        'field\'s value before. Filter by chore_id or category_id. Cleared when lastGLANCE restarts, and as the user undoes changes.',
      inputSchema: z.object({
        chore_id: z.string().optional(),
        category_id: z.string().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().optional(),
      }),
    },
    async ({ chore_id, category_id, limit, cursor }) => {
      const page = journal.page({ match: { chore_id, category_id }, limit, cursor });
      if (!page.ok) return toolError('validation', page.reason);
      return ok({ items: page.items, truncated: page.truncated, next_cursor: page.nextCursor, total: page.total });
    },
  );
}
