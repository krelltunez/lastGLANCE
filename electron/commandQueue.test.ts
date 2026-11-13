import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMAND_LIMIT, createCommandQueue } from './commandQueue';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function queue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastglance-commands-'));
  dirs.push(dir);
  let n = 0;
  const file = path.join(dir, 'commands.json');
  return { file, q: createCommandQueue({ file, newId: () => `id-${++n}`, now: () => Date.parse('2026-11-10T12:00:00Z') }) };
}

describe('the command queue', () => {
  it('keeps a command until it is acknowledged, across a restart', () => {
    const { file, q } = queue();
    const c = q.enqueue('complete', { chore_id: 'c1' }, 'tray');
    expect(c).toEqual({ clientId: 'id-1', action: 'complete', payload: { chore_id: 'c1' }, source: 'tray', at: '2026-11-10T12:00:00.000Z' });
    expect(q.take()).toEqual([c]);
    expect(q.take()).toEqual([c]);                           // taking does not remove
    const again = createCommandQueue({ file, newId: () => 'x' });
    expect(again.take()).toEqual([c]);                        // a crash before the ack replays it
    again.ack(['id-1']);
    expect(q.take()).toEqual([]);
  });

  it('refuses actions outside the vocabulary, and ignores a bad ack', () => {
    const { q } = queue();
    expect(q.enqueue('delete_everything', {}, 'tray')).toBeNull();
    q.enqueue('complete', { chore_id: 'c1' }, 'notification');
    q.ack('id-1');
    q.ack([42, 'nope']);
    expect(q.take()).toHaveLength(1);
  });

  it('acknowledges by id, leaving the rest in order', () => {
    const { q } = queue();
    q.enqueue('complete', { chore_id: 'a' }, 'tray');
    q.enqueue('complete', { chore_id: 'b' }, 'tray');
    q.enqueue('complete', { chore_id: 'c' }, 'tray');
    q.ack(['id-2']);
    expect(q.take().map((c) => c.payload.chore_id)).toEqual(['a', 'c']);
  });

  it('is bounded, dropping the oldest', () => {
    const { q } = queue();
    for (let i = 0; i < COMMAND_LIMIT + 5; i++) q.enqueue('complete', { chore_id: `c${i}` }, 'tray');
    const all = q.take();
    expect(all).toHaveLength(COMMAND_LIMIT);
    expect(all[0].payload.chore_id).toBe('c5');
  });

  it('reads a corrupt or foreign file as empty, and drops malformed entries', () => {
    const { file, q } = queue();
    fs.writeFileSync(file, '{oops');
    expect(q.take()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify([
      { clientId: 'ok', action: 'complete', payload: {}, source: 'tray', at: 'x' },
      { clientId: 'deck', action: 'complete', payload: {}, source: 'streamdeck', at: 'x' },
      { clientId: 'stranger', action: 'complete', payload: {}, source: 'webpage', at: 'x' },
      { clientId: 'bad' }, null,
    ]));
    expect(q.take().map((c) => c.clientId)).toEqual(['ok', 'deck']);
  });
});
