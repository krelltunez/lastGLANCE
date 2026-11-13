// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createIdempotencyStore, createWriteGate, generateMcpToken, type HostBridge, type WriteGate } from '@glance-apps/mcp-host';
import { MCP_ENDPOINT_PATH, startMcpServer } from './mcpServer.js';
import { createJournal, type McpJournal } from './mcpJournal.js';
import type { WriteToolDeps } from './mcpWriteTools.js';
import { answerMcpRequest } from '../src/mcp/useMcpBridge';
import { handleMcpWrite } from '../src/mcp/writeModel';
import { db } from '../src/db/client';
import { createCategory } from '../src/db/queries';

// Writes end to end: the real listener and the official client, the real write
// tools and pipeline (consent, replay, gate, journal), and behind the bridge
// the page's real write model on an in-memory database, so each call is
// checked where the app reads it: in the database, and through the read tools.

const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
} as Storage;

const TOKEN = generateMcpToken();
const ctx = { meUserSyncId: null, now: () => new Date(), changed: () => {}, activity: () => {} };

/** The page, answering over the bridge: reads from the database, writes through the write model. */
function pageBridge() {
  const methods: string[] = [];
  const bridge: HostBridge = {
    async request(method, params = {}) {
      methods.push(method);
      const r = await answerMcpRequest({ id: 1, method, params }, { write: (m, p) => handleMcpWrite(m, p, ctx) });
      return r as Awaited<ReturnType<HostBridge['request']>>;   // the extra id is ignored, as main ignores it
    },
    async ping() { return true; },
    dispose() {},
  };
  return { bridge, methods };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });

interface Setup { client: Client; journal: McpJournal; methods: string[]; deps: WriteToolDeps }

async function start(over: Partial<WriteToolDeps> = {}, gate: WriteGate = createWriteGate()): Promise<Setup> {
  const port = await freePort();
  const { bridge, methods } = pageBridge();
  const journal = createJournal();
  const deps: WriteToolDeps = {
    bridge, gate, store: createIdempotencyStore(), token: () => TOKEN, includeWrites: () => true,
    onWritesDisabled: vi.fn(), journal, onWrite: vi.fn(), ...over,
  };
  const server = startMcpServer({
    token: TOKEN, portOverride: port, log: () => {}, logError: () => {},
    readDeps: { bridge, now: () => Date.now(), timeZone: () => 'UTC', includePeople: () => false },
    writeDeps: deps,
  })!;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const client = new Client({ name: 'lastglance-writes-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  }));
  closers.push(async () => {
    await client.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, journal, methods, deps };
}

type Row = { [key: string]: unknown };
type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Row };
const call = async (client: Client, name: string, args: Row = {}) => await client.callTool({ name, arguments: args }) as ToolResult;
const errorCode = (r: ToolResult) => JSON.parse(r.content[0].text).error.code as string;
const chore = (r: ToolResult) => r.structuredContent!.chore as Row;

beforeEach(async () => {
  await Promise.all([db.categories.clear(), db.chores.clear(), db.completionEvents.clear(), db.tombstones.clear(), db.users.clear()]);
  await createCategory('Home', undefined, 'House', undefined, [], 'c-home');
});

describe('MCP writes', () => {
  it('registers the write tools, and refuses them all without "Allow changes", before the page is asked', async () => {
    const { client, methods } = await start({ includeWrites: () => false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['lastglance_create_chore', 'lastglance_complete_chore', 'lastglance_list_mcp_writes']));
    const r = await call(client, 'lastglance_create_chore', { name: 'Dust' });
    expect(errorCode(r)).toBe('read_only_mode');
    expect(methods).toEqual([]);
    expect(await db.chores.count()).toBe(0);
  });

  it('creates a chore, journals it, and replays a retried key without a second chore, even after the replay store forgets', async () => {
    const s = await start();
    const r = await call(s.client, 'lastglance_create_chore', { name: 'Dust', category_id: 'c-home', cadence_days: 7, idempotency_key: 'k-dust' });
    expect(r.isError).toBeFalsy();
    expect(chore(r)).toMatchObject({ name: 'Dust', icon: 'House', cadence_days: 7 });
    expect(r.structuredContent).not.toHaveProperty('undo');   // the undo record is main's, never output
    expect(s.journal.snapshot()).toMatchObject({ total: 1, entries: [{ tool: 'lastglance_create_chore', summary: 'Created “Dust”' }] });
    expect(s.deps.onWrite).toHaveBeenCalledTimes(1);

    expect((await call(s.client, 'lastglance_create_chore', { name: 'Dust', category_id: 'c-home', idempotency_key: 'k-dust' })).structuredContent!.replayed).toBe(true);
    s.deps.store.reset();
    const afterReset = await call(s.client, 'lastglance_create_chore', { name: 'Dust', category_id: 'c-home', idempotency_key: 'k-dust' });
    expect(afterReset.structuredContent!.replayed).toBe(true);
    expect(await db.chores.count()).toBe(1);
    expect(s.journal.entries()).toHaveLength(1);
  });

  it('marks done, edits, and lists what it changed; the undo puts everything back', async () => {
    const s = await start();
    const id = chore(await call(s.client, 'lastglance_create_chore', { name: 'Water plants', category_id: 'c-home', cadence_days: 7, icon: 'Sprout' })).id as string;
    const done = await call(s.client, 'lastglance_complete_chore', { chore_id: id, note: 'Ferns too' });
    expect(chore(done)).toMatchObject({ state: 'fresh', completions_total: 1 });
    const edited = await call(s.client, 'lastglance_update_chore', { chore_id: id, name: 'Water the ferns', icon: null, cadence_days: null });
    expect(chore(edited)).toMatchObject({ name: 'Water the ferns', icon: null, cadence_days: null });

    const list = (await call(s.client, 'lastglance_list_mcp_writes', { chore_id: id })).structuredContent!;
    expect((list.items as Row[]).map((i) => i.tool)).toEqual(['lastglance_update_chore', 'lastglance_complete_chore', 'lastglance_create_chore']);
    expect((list.items as Row[])[0].changes).toEqual(expect.arrayContaining([{ field: 'name', before: 'Water plants' }, { field: 'icon', before: 'Sprout' }]));

    // What main does for Settings' "Undo" on this item.
    const plan = s.journal.plan(`chore:${id}`);
    const undone = await s.deps.bridge.request('undo_mcp_writes', { ops: plan.ops });
    expect(undone).toMatchObject({ ok: true, data: { undone: 3, skipped: [] } });
    expect(await db.chores.count()).toBe(0);
    expect(await db.completionEvents.count()).toBe(0);
  });

  it('passes the page\'s by-design refusals through, and checks a time before the page is asked', async () => {
    const { client, methods } = await start();
    expect(errorCode(await call(client, 'lastglance_create_chore', { name: 'x', cadence_days: 0 }))).toBe('validation');
    expect(errorCode(await call(client, 'lastglance_complete_chore', { chore_id: 'ch-gone' }))).toBe('not_found');
    const before = methods.length;
    expect(errorCode(await call(client, 'lastglance_complete_chore', { chore_id: 'x', completed_at: 'yesterday' }))).toBe('validation');
    expect(methods.length).toBe(before);
  });

  it('limits the rate, and turns writes off after repeated overruns, telling main once', async () => {
    const s = await start({}, createWriteGate({ limit: 2, violationLimit: 2 }));
    for (const name of ['A', 'B']) expect((await call(s.client, 'lastglance_create_chore', { name })).isError).toBeFalsy();
    expect(errorCode(await call(s.client, 'lastglance_create_chore', { name: 'C' }))).toBe('rate_limited');
    expect(errorCode(await call(s.client, 'lastglance_create_chore', { name: 'D' }))).toBe('writes_disabled');
    expect(errorCode(await call(s.client, 'lastglance_create_chore', { name: 'E' }))).toBe('writes_disabled');
    expect(s.deps.onWritesDisabled).toHaveBeenCalledTimes(1);
    expect(await db.chores.count()).toBe(2);
  });
});
