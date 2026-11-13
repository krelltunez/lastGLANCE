// lastGLANCE's half of the MCP write journal (docs/mcp-and-stream-deck.md,
// 4.5): the undo op vocabulary, how ops group per item, and how the read tool
// describes them. The journal itself (append, snapshot, groups, undo plan,
// paging) is @glance-apps/mcp-host's. It is held in main for the session only,
// never on disk: it covers "undo what the assistant just did", not an audit
// history, so a restart clearing it is by design.
//
// The ops are built by the page (src/mcp/writeModel.ts, UndoOp), which alone
// holds the before-state, and applied by it again on undo. Main only stores,
// groups and sends them back, so here they are typed loosely and checked by
// kind.

import {
  appendEntry, buildUndoPlan, journalPage, journalSnapshot,
  type JournalDescription, type JournalEntry, type JournalGrouping, type JournalRecord, type JournalSnapshot,
} from '@glance-apps/mcp-host';

export const UNDO_KINDS = [
  'remove_completion', 'restore_completion_note', 'remove_created_chore', 'restore_chore_fields',
  'remove_created_category', 'restore_category_fields',
  'remove_created_person', 'restore_person_fields', 'remove_created_date', 'restore_date_fields',
  'remove_interaction', 'restore_interaction_fields', 'remove_created_circle', 'restore_circle_fields',
] as const;
export type UndoKind = (typeof UNDO_KINDS)[number];

export interface UndoOp {
  kind: UndoKind;
  choreId?: string;
  completionId?: string;
  categoryId?: string;
  personId?: string;
  dateId?: string;
  interactionId?: string;
  circleId?: string;
  before?: Record<string, unknown> | string | null;
  [key: string]: unknown;
}

export type McpJournalEntry = JournalEntry<UndoOp>;
export type McpJournalRecord = JournalRecord<UndoOp>;

export function isUndoOp(v: unknown): v is UndoOp {
  return !!v && typeof v === 'object' && (UNDO_KINDS as readonly string[]).includes((v as { kind?: unknown }).kind as string);
}

/**
 * The one item an op reverses: a completion goes with its chore, a date with
 * its person; a contact, which can cover several people, is its own item.
 * Throws on a kind it does not know.
 */
export function undoGroupKey(op: UndoOp): string {
  switch (op.kind) {
    case 'remove_completion':
    case 'restore_completion_note':
    case 'remove_created_chore':
    case 'restore_chore_fields':
      return `chore:${op.choreId}`;
    case 'remove_created_category':
    case 'restore_category_fields':
      return `category:${op.categoryId}`;
    case 'remove_created_person':
    case 'restore_person_fields':
    case 'remove_created_date':
    case 'restore_date_fields':
      return `person:${op.personId}`;
    case 'remove_interaction':
    case 'restore_interaction_fields':
      return `interaction:${op.interactionId}`;
    case 'remove_created_circle':
    case 'restore_circle_fields':
      return `circle:${op.circleId}`;
    default:
      throw new Error(`unknown undo op kind ${JSON.stringify((op as { kind?: unknown }).kind)}`);
  }
}

export const JOURNAL_GROUPING: JournalGrouping<UndoOp> = { groupKey: undoGroupKey };

/** What the read tool shows of an op: the ids, and each changed field's value before. */
export function describeUndoOp(op: UndoOp): JournalDescription {
  const ids: Record<string, unknown> = {};
  if (op.choreId) ids.chore_id = op.choreId;
  if (op.completionId) ids.completion_id = op.completionId;
  if (op.categoryId) ids.category_id = op.categoryId;
  if (op.personId) ids.person_id = op.personId;
  if (op.dateId) ids.date_id = op.dateId;
  if (op.interactionId) ids.interaction_id = op.interactionId;
  if (op.circleId) ids.circle_id = op.circleId;
  if (op.kind === 'restore_completion_note') return { ids, changes: [{ field: 'note', before: op.before ?? null }] };
  if (op.kind.startsWith('restore_') && op.before && typeof op.before === 'object') {
    const changes = Object.entries(op.before).map(([field, before]) => ({ field, before }));
    if (op.orderBefore) changes.push({ field: 'position', before: null });
    return { ids, changes };
  }
  return { ids };
}

/** The session journal: entries in, snapshots and undo plans out. */
export function createJournal(now: () => Date = () => new Date()) {
  let entries: McpJournalEntry[] = [];
  return {
    append(record: McpJournalRecord): void {
      entries = appendEntry(entries, record, now().toISOString());
    },
    entries: (): McpJournalEntry[] => entries,
    snapshot: (): JournalSnapshot => journalSnapshot(entries, JOURNAL_GROUPING, 50),
    /** The ops to undo (newest first) for one item, or every item, and the entries they come from. */
    plan(groupKey?: string): { ops: UndoOp[]; seqs: number[] } {
      const chosen = groupKey === undefined ? entries : entries.filter((e) => undoGroupKey(e.op) === groupKey);
      return { ops: buildUndoPlan(chosen).ops, seqs: chosen.map((e) => e.seq) };
    },
    /** Drop entries once the page has undone them. */
    remove(seqs: number[]): void {
      const gone = new Set(seqs);
      entries = entries.filter((e) => !gone.has(e.seq));
    },
    page: (opts: { match?: Record<string, unknown>; limit?: unknown; cursor?: unknown }) =>
      journalPage(entries, { ...opts, describe: describeUndoOp, cursorPrefix: 'lgw1.' }),
  };
}

export type McpJournal = ReturnType<typeof createJournal>;
