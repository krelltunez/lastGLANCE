// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import type http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createIdempotencyStore, createWriteGate, generateMcpToken, type BridgeResult, type HostBridge } from '@glance-apps/mcp-host';
import { MCP_ENDPOINT_PATH, startMcpServer } from './mcpServer.js';
import { HISTORY_TIMEOUT_MS, UNAVAILABLE } from './mcpRendererBridge.js';
import type { ReadToolDeps } from './mcpReadTools.js';
import { createJournal } from './mcpJournal.js';
import { handleMcpRequest } from '../src/mcp/readModel';
import { fixtureData } from '../src/mcp/readModel.fixture';

// The seam no unit test sees (after dayGLANCE's suite of the same name): the
// real listener on a free loopback port, the official MCP client over real HTTP
// with the real bearer token, the real tools, and a bridge that answers through
// the page's real read model over a fixture household. It pins the wiring:
// that the names are the ones docs/mcp-tools-reference.md documents, that a
// call reaches the page as the method the read model answers, that a failure
// comes back typed and never as an empty result, and that the guards in front
// run on the real request path.

const TOKEN = generateMcpToken();
const NOW = Date.parse('2026-11-13T12:00:00Z');
const TZ = 'UTC';

const reference = readFileSync(path.resolve(__dirname, '../docs/mcp-tools-reference.md'), 'utf-8');
const documentedTools = [...reference.matchAll(/^### `(lastglance_[a-z_]+)`/gm)].map((m) => m[1]);
const documentedResources = [...reference.matchAll(/^\| `(lastglance:\/\/[a-z/-]+)` \|/gm)].map((m) => m[1]);
// The People tools are the ones documented under a "People" section heading.
const PEOPLE_TOOLS = reference.split(/^## /m).filter((section) => /^[^\n]*People/.test(section))
  .flatMap((section) => [...section.matchAll(/^### `(lastglance_[a-z_]+)`/gm)].map((m) => m[1]));
const PEOPLE_RESOURCES = ['lastglance://people/coming-up'];

type Call = { method: string; params: unknown; timeoutMs: number | undefined };

/** A bridge answered by the read model, recording every request; `answer` overrides it. */
function modelBridge(answer?: (method: string) => BridgeResult | undefined) {
  const calls: Call[] = [];
  const bridge: HostBridge = {
    async request(method, params = {}, timeoutMs) {
      calls.push({ method, params, timeoutMs });
      return answer?.(method) ?? handleMcpRequest(fixtureData(), { method, params });
    },
    async ping() { return true; },
    dispose() {},
  };
  return { bridge, calls };
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

interface Harness {
  url: string;
  connect(token?: string): Promise<Client>;
  close(): Promise<void>;
}

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((h) => h.close())); });

async function start(bridge: HostBridge, over: Partial<ReadToolDeps> = {}, token: string | (() => string) = TOKEN): Promise<Harness> {
  const port = await freePort();
  const quiet = () => {};
  const server: http.Server | null = startMcpServer({
    token,
    portOverride: port,
    readDeps: { bridge, now: () => NOW, timeZone: () => TZ, includePeople: () => false, ...over },
    writeDeps: {
      bridge, gate: createWriteGate(), store: createIdempotencyStore(), token: () => TOKEN, includeWrites: () => true, includePeople: () => over.includePeople?.() ?? false,
      onWritesDisabled: () => {}, journal: createJournal(),
    },
    log: quiet,
    logError: quiet,
  });
  if (!server) throw new Error('the listener refused to start');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const url = `http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`;
  const clients: Client[] = [];
  const h: Harness = {
    url,
    async connect(t = TOKEN) {
      const client = new Client({ name: 'lastglance-transport-test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${t}` } } }));
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  open.push(h);
  return h;
}

type Row = { [key: string]: unknown };
type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Row };
const items = (v: unknown) => v as Row[];
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  await client.callTool({ name, arguments: args }) as ToolResult;
const body = (r: ToolResult) => JSON.parse(r.content[0].text);

describe('the registered surface', () => {
  it('serves exactly the documented tools and resources, People only under the People tier', async () => {
    expect(documentedTools.length).toBeGreaterThan(0);
    expect(PEOPLE_TOOLS).toEqual(expect.arrayContaining(['lastglance_list_people', 'lastglance_log_interaction', 'lastglance_update_circle']));
    const chores = await (await start(modelBridge().bridge)).connect();
    const choreTools = (await chores.listTools()).tools.map((t) => t.name).sort();
    expect(choreTools).toEqual(documentedTools.filter((t) => !PEOPLE_TOOLS.includes(t)).sort());
    expect((await chores.listResources()).resources.map((r) => r.uri)).toEqual(documentedResources.filter((r) => !PEOPLE_RESOURCES.includes(r)));

    const people = await (await start(modelBridge().bridge, { includePeople: () => true })).connect();
    const tools = (await people.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...documentedTools].sort());
    expect((await people.listResources()).resources.map((r) => r.uri).sort()).toEqual([...documentedResources].sort());
    for (const t of tools) expect(t.description, t.name).toBeTruthy();
  });

  it('follows a tier change on the next request, without a restart', async () => {
    let people = false;
    const client = await (await start(modelBridge().bridge, { includePeople: () => people })).connect();
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('lastglance_list_people');
    people = true;
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('lastglance_list_people');
  });
});

describe('reads', () => {
  it('answers the overview through the read model, with the date and zone, People only under the tier', async () => {
    const { bridge, calls } = modelBridge();
    const client = await (await start(bridge)).connect();
    const r = await call(client, 'lastglance_get_overview');
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ date: '2026-11-13', timezone: 'UTC', counts: { overdue: 1, soon: 2 } });
    expect(items(r.structuredContent!.due).map((c) => c.id)).toEqual(['ch-water', 'ch-vacuum', 'ch-fridge']);
    expect(r.structuredContent).not.toHaveProperty('reach_out');
    expect(calls).toEqual([{ method: 'overview', params: { include_people: false }, timeoutMs: undefined }]);

    const withPeople = await (await start(modelBridge().bridge, { includePeople: () => true })).connect();
    expect(items((await call(withPeople, 'lastglance_get_overview')).structuredContent!.reach_out).length).toBeGreaterThan(0);
  });

  it('pages a list, and refuses a cursor walked under other filters', async () => {
    const client = await (await start(modelBridge().bridge)).connect();
    const first = (await call(client, 'lastglance_list_chores', { limit: 3 })).structuredContent!;
    expect(first).toMatchObject({ total: 7, truncated: true });
    expect(items(first.items)).toHaveLength(3);
    const second = (await call(client, 'lastglance_list_chores', { limit: 3, cursor: first.next_cursor })).structuredContent!;
    expect(items(second.items)[0].id).not.toBe(items(first.items)[0].id);
    const switched = await call(client, 'lastglance_list_chores', { limit: 3, cursor: first.next_cursor, state: 'due' });
    expect(switched.isError).toBe(true);
    expect(body(switched).error.code).toBe('validation');
  });

  it('validates arguments before the page is asked', async () => {
    const { bridge, calls } = modelBridge();
    const client = await (await start(bridge)).connect();
    for (const [tool, args] of [
      ['lastglance_list_chores', { state: 'urgent' }],
      ['lastglance_get_activity', { from: '2026-11-31', to: '2026-12-01' }],
      ['lastglance_get_activity', { from: '2026-11-13', to: '2026-11-01' }],
      ['lastglance_get_activity', { from: '2025-01-01', to: '2026-11-13' }],
    ] as const) {
      const r = await call(client, tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(body(r).error.code).toBe('validation');
    }
    expect(calls).toEqual([]);
  });

  it('gives the history read its longer timeout', async () => {
    const { bridge, calls } = modelBridge();
    const client = await (await start(bridge)).connect();
    const r = await call(client, 'lastglance_get_activity', { from: '2026-11-01', to: '2026-11-13' });
    expect(r.structuredContent).toMatchObject({ from: '2026-11-01', to: '2026-11-13', timezone: 'UTC' });
    expect(calls[0]).toMatchObject({ method: 'activity', timeoutMs: HISTORY_TIMEOUT_MS });
  });

  it('passes the page\'s not_found through as the typed error', async () => {
    const client = await (await start(modelBridge().bridge)).connect();
    const r = await call(client, 'lastglance_get_chore', { chore_id: 'ch-gone' });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe('not_found');
  });

  it('resolves a dayGLANCE link: a chore under either tier, a person or a date only under People', async () => {
    const chores = await (await start(modelBridge().bridge)).connect();
    expect((await call(chores, 'lastglance_resolve_link', { id: 'ch-water' })).structuredContent).toMatchObject({ kind: 'chore' });
    expect(body(await call(chores, 'lastglance_resolve_link', { id: 'p-maya' })).error.code).toBe('not_found');
    const people = await (await start(modelBridge().bridge, { includePeople: () => true })).connect();
    expect((await call(people, 'lastglance_resolve_link', { id: 'p-maya' })).structuredContent).toMatchObject({ kind: 'person' });
    expect((await call(people, 'lastglance_resolve_link', { id: 'd-maya-bday:2027' })).structuredContent).toMatchObject({ kind: 'date', for_year: 2027 });
  });

  it('reads the resources', async () => {
    const client = await (await start(modelBridge().bridge, { includePeople: () => true })).connect();
    const due = JSON.parse((await client.readResource({ uri: 'lastglance://chores/due' })).contents[0].text as string);
    expect(due).toMatchObject({ date: '2026-11-13', counts: { overdue: 1 } });
    const coming = JSON.parse((await client.readResource({ uri: 'lastglance://people/coming-up' })).contents[0].text as string);
    expect(coming.items.map((d: { person_id: string }) => d.person_id)).toEqual(['p-sam', 'p-maya']);
  });
});

describe('local time (docs/mcp-tools-reference.md, Conventions)', () => {
  it('answers every instant in the server\'s zone with its offset, in tools and resources, dates untouched', async () => {
    const raw = handleMcpRequest(fixtureData(), { method: 'get_chore', params: { chore_id: 'ch-water' } });
    const stored = (raw as { ok: true; data: Row }).data;
    const client = await (await start(modelBridge().bridge, { timeZone: () => 'America/Denver' })).connect();
    const r = await call(client, 'lastglance_get_chore', { chore_id: 'ch-water' });
    const local = r.structuredContent!;
    // The same instant, written in Denver's wall-clock time.
    expect(String(stored.last_completed_at)).toMatch(/Z$/);
    expect(String(local.last_completed_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[67]:00$/);
    expect(Date.parse(String(local.last_completed_at))).toBe(Math.floor(Date.parse(String(stored.last_completed_at)) / 1000) * 1000);
    expect(items(local.completions).every((c) => /-0[67]:00$/.test(String(c.completed_at)))).toBe(true);
    expect(local.next_due).toBe(stored.next_due);
    // The text a client reads is the structured content, localized the same way.
    expect(body(r)).toEqual(local);
    const due = JSON.parse((await client.readResource({ uri: 'lastglance://chores/due' })).contents[0].text as string);
    expect(JSON.stringify(due)).not.toMatch(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z"/);
  });
});

describe('an unavailable window', () => {
  it('is a typed error for every tool and resource, never an empty result', async () => {
    const client = await (await start(modelBridge(() => UNAVAILABLE).bridge, { includePeople: () => true })).connect();
    // Every tool that asks the page, writes included; the ping and the journal never do.
    const ARGS: Record<string, Record<string, unknown>> = {
      lastglance_get_activity: { from: '2026-11-01', to: '2026-11-13' },
      lastglance_get_chore: { chore_id: 'ch-water' },
      lastglance_get_person: { person_id: 'p-maya' },
      lastglance_complete_chore: { chore_id: 'ch-water' },
      lastglance_complete_chores: { completions: [{ chore_id: 'ch-water' }, { chore_id: 'ch-vacuum' }] },
      lastglance_resolve_link: { id: 'ch-water' },
      lastglance_send_to_dayglance: { chore_id: 'ch-water', start: '2026-11-15 09:00' },
      lastglance_update_completion: { completion_id: 'e-1', note: null },
      lastglance_create_chore: { name: 'Dust' },
      lastglance_update_chore: { chore_id: 'ch-water', name: 'Water' },
      lastglance_create_category: { name: 'Garage' },
      lastglance_update_category: { category_id: 'c-home', name: 'House' },
      lastglance_create_person: { name: 'Ann' },
      lastglance_update_person: { person_id: 'p-maya', nickname: 'M' },
      lastglance_add_person_date: { person_id: 'p-maya', month: 1, day: 2 },
      lastglance_update_person_date: { date_id: 'd-maya-bday', day: 21 },
      lastglance_log_interaction: { person_ids: ['p-maya'] },
      lastglance_update_interaction: { interaction_id: 'i-1', note: 'x' },
      lastglance_create_circle: { name: 'Work' },
      lastglance_update_circle: { circle_id: 'k-friends', name: 'Pals' },
    };
    for (const tool of documentedTools.filter((t) => t !== 'lastglance_ping' && t !== 'lastglance_list_mcp_writes')) {
      const args = ARGS[tool] ?? {};
      const r = await call(client, tool, args);
      expect(r.isError, tool).toBe(true);
      expect(body(r).error.code, tool).toBe('renderer_unavailable');
    }
    for (const uri of documentedResources) {
      await expect(client.readResource({ uri }), uri).rejects.toThrow(/renderer_unavailable/);
    }
    expect((await call(client, 'lastglance_ping')).isError).toBeFalsy();
  });
});

describe('the listener', () => {
  it('refuses a wrong token, a wrong path and a browser origin', async () => {
    const h = await start(modelBridge().bridge);
    await expect(h.connect('0'.repeat(64))).rejects.toThrow();
    const wrongPath = await fetch(h.url.replace('/mcp', '/other'), { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(wrongPath.status).toBe(404);
    const unauth = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
    const browser = await fetch(h.url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(browser.status).toBe(403);
  });

  it('reads the token on every request, so a new token applies at once', async () => {
    let token = TOKEN;
    const h = await start(modelBridge().bridge, {}, () => token);
    await h.connect(TOKEN);
    token = generateMcpToken();
    await expect(h.connect(TOKEN)).rejects.toThrow();
    await expect(h.connect(token)).resolves.toBeTruthy();
  });

  it('refuses to start with no token', () => {
    expect(startMcpServer({ token: '', readDeps: { bridge: modelBridge().bridge, now: () => NOW, timeZone: () => TZ, includePeople: () => false }, log: () => {}, logError: () => {} })).toBeNull();
  });
});
