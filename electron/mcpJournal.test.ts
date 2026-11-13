import { describe, expect, it } from 'vitest';
import { createJournal, describeUndoOp, isUndoOp, undoGroupKey, type UndoOp } from './mcpJournal';

const created: UndoOp = { kind: 'remove_created_chore', choreId: 'ch' };
const done: UndoOp = { kind: 'remove_completion', choreId: 'ch', completionId: 'e1' };
const renamed: UndoOp = { kind: 'restore_category_fields', categoryId: 'c', before: { name: 'Home' } };

describe('the MCP write journal', () => {
  it('groups a completion with its chore, and refuses an op it does not know', () => {
    expect(undoGroupKey(created)).toBe('chore:ch');
    expect(undoGroupKey(done)).toBe('chore:ch');
    expect(undoGroupKey(renamed)).toBe('category:c');
    expect(() => undoGroupKey({ kind: 'drop_table' } as unknown as UndoOp)).toThrow();
    expect(isUndoOp(created)).toBe(true);
    expect(isUndoOp({ kind: 'drop_table' })).toBe(false);
  });

  it('plans an undo newest first, for one item or all, and forgets what was undone', () => {
    const j = createJournal(() => new Date('2026-11-13T18:00:00Z'));
    j.append({ tool: 'lastglance_create_chore', summary: 'Created “Dust”', op: created });
    j.append({ tool: 'lastglance_update_category', summary: 'Edited the category “House”', op: renamed });
    j.append({ tool: 'lastglance_complete_chore', summary: 'Marked “Dust” done', op: done });
    expect(j.snapshot()).toMatchObject({ total: 3, groups: [{ key: 'chore:ch', count: 2 }, { key: 'category:c', count: 1 }] });
    const chore = j.plan('chore:ch');
    expect(chore.ops).toEqual([done, created]);
    j.remove(chore.seqs);
    expect(j.plan().ops).toEqual([renamed]);
    expect(j.entries()).toHaveLength(1);
  });

  it('shows the ids and the values before, never the op itself', () => {
    expect(describeUndoOp(done)).toEqual({ ids: { chore_id: 'ch', completion_id: 'e1' } });
    expect(describeUndoOp(renamed)).toEqual({ ids: { category_id: 'c' }, changes: [{ field: 'name', before: 'Home' }] });
    const j = createJournal();
    j.append({ tool: 'lastglance_update_category', summary: 'Edited the category “House”', op: renamed, idempotencyKey: 'k1' });
    const page = j.page({ match: { category_id: 'c' } });
    expect(page.ok && page.items).toEqual([expect.objectContaining({ tool: 'lastglance_update_category', category_id: 'c', changes: [{ field: 'name', before: 'Home' }] })]);
    expect(JSON.stringify(page)).not.toContain('k1');
    expect(JSON.stringify(page)).not.toContain('restore_category_fields');
  });
});
