import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyTransition, DEFAULT_LOCAL_INTEGRATIONS, DEFAULT_MCP_PORT, integrationsView, listenerEffects, loadLocalIntegrations,
  LOCAL_INTEGRATIONS_FILE, mcpGates, normalizeConfig, saveLocalIntegrations, STREAM_DECK_PORT,
  type LocalIntegrationsConfig, type TransitionResult,
} from './localIntegrations';

const dirs: string[] = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lastglance-li-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const NOW = '2026-11-12T18:00:00.000Z';
let tokens: string[];
const deps = { now: () => NOW, newToken: () => tokens.shift() ?? 'f'.repeat(64) };
afterEach(() => { tokens = []; });
tokens = [];

const ok = (r: TransitionResult): LocalIntegrationsConfig => {
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.config;
};
const off = (): LocalIntegrationsConfig => normalizeConfig({});
const on = (tier: 'chores' | 'chores_people' = 'chores'): LocalIntegrationsConfig => {
  tokens = [TOKEN_A];
  return ok(applyTransition(off(), { type: 'set-mcp-read-tier', tier, consentConfirmed: true, peopleConsentConfirmed: true }, deps));
};

describe('the defaults', () => {
  it('turn everything off, with no token', () => {
    expect(off()).toEqual(DEFAULT_LOCAL_INTEGRATIONS);
    expect(off().streamDeck.enabled).toBe(false);
    expect(mcpGates(off())).toEqual({ bound: false, includePeople: false, includeWrites: false });
  });
});

describe('reading the file', () => {
  it('reads a missing file as the defaults, and round-trips a saved one owner-only', () => {
    const d = temp();
    expect(loadLocalIntegrations(d)).toEqual({ config: DEFAULT_LOCAL_INTEGRATIONS, recovered: false });
    const config = on('chores_people');
    expect(saveLocalIntegrations(d, config)).toBe(true);
    expect(loadLocalIntegrations(d)).toEqual({ config, recovered: false });
    if (process.platform !== 'win32') expect(fs.statSync(path.join(d, LOCAL_INTEGRATIONS_FILE)).mode & 0o777).toBe(0o600);
  });

  it('sets a corrupt file aside and fails closed', () => {
    const d = temp();
    const file = path.join(d, LOCAL_INTEGRATIONS_FILE);
    for (const text of ['{not json', '[]', 'null']) {
      fs.writeFileSync(file, text);
      expect(loadLocalIntegrations(d)).toEqual({ config: DEFAULT_LOCAL_INTEGRATIONS, recovered: true });
      expect(fs.readFileSync(`${file}.corrupt`, 'utf-8')).toBe(text);
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  it('never reads a field into a state its consent does not back', () => {
    const consented = { consentAcceptedAt: NOW, peopleConsentAcceptedAt: NOW, writesConsentAcceptedAt: NOW, token: TOKEN_A };
    // A tier with no consent stamp, or no token, is off.
    expect(normalizeConfig({ mcp: { ...consented, readTier: 'chores', consentAcceptedAt: null } }).mcp.readTier).toBe('off');
    expect(normalizeConfig({ mcp: { ...consented, readTier: 'chores', token: 'short' } }).mcp.readTier).toBe('off');
    // People without its own consent drops to chores.
    expect(normalizeConfig({ mcp: { ...consented, readTier: 'chores_people', peopleConsentAcceptedAt: 'whenever' } }).mcp.readTier).toBe('chores');
    // Writes need a read tier and their own stamp.
    expect(normalizeConfig({ mcp: { ...consented, readTier: 'chores', writesEnabled: true } }).mcp.writesEnabled).toBe(true);
    expect(normalizeConfig({ mcp: { ...consented, readTier: 'off', writesEnabled: true } }).mcp.writesEnabled).toBe(false);
    expect(normalizeConfig({ mcp: { ...consented, readTier: 'chores', writesEnabled: true, writesConsentAcceptedAt: null } }).mcp.writesEnabled).toBe(false);
    // Junk is the default.
    expect(normalizeConfig({ streamDeck: { enabled: 'yes' }, mcp: { readTier: 'all', portOverride: 0 } })).toEqual(DEFAULT_LOCAL_INTEGRATIONS);
    expect(normalizeConfig({ mcp: { portOverride: 8123 } }).mcp.portOverride).toBe(8123);
  });
});

describe('turning MCP on', () => {
  it('needs the consent dialog, and makes the token then', () => {
    expect(applyTransition(off(), { type: 'set-mcp-read-tier', tier: 'chores' }, deps)).toEqual({ ok: false, error: 'consent_required' });
    const c = on('chores');
    expect(c.mcp).toMatchObject({ readTier: 'chores', token: TOKEN_A, consentAcceptedAt: NOW, peopleConsentAcceptedAt: null });
    expect(mcpGates(c)).toEqual({ bound: true, includePeople: false, includeWrites: false });
  });

  it('needs the People consent for People, also from the chores tier', () => {
    expect(applyTransition(off(), { type: 'set-mcp-read-tier', tier: 'chores_people', consentConfirmed: true }, deps))
      .toEqual({ ok: false, error: 'people_consent_required' });
    const chores = on('chores');
    expect(applyTransition(chores, { type: 'set-mcp-read-tier', tier: 'chores_people' }, deps)).toEqual({ ok: false, error: 'people_consent_required' });
    const people = ok(applyTransition(chores, { type: 'set-mcp-read-tier', tier: 'chores_people', peopleConsentConfirmed: true }, deps));
    expect(mcpGates(people).includePeople).toBe(true);
    // Back down to chores needs nothing, and keeps the token.
    expect(ok(applyTransition(people, { type: 'set-mcp-read-tier', tier: 'chores' }, deps)).mcp).toMatchObject({ readTier: 'chores', token: TOKEN_A });
  });

  it('asks again after being turned off', () => {
    const offAgain = ok(applyTransition(on(), { type: 'set-mcp-read-tier', tier: 'off' }, deps));
    expect(offAgain.mcp.token).toBe(TOKEN_A);
    expect(applyTransition(offAgain, { type: 'set-mcp-read-tier', tier: 'chores' }, deps)).toEqual({ ok: false, error: 'consent_required' });
  });

  it('turns writes off with the server', () => {
    const writing = ok(applyTransition(on(), { type: 'set-mcp-writes', enabled: true, writesConsentConfirmed: true }, deps));
    expect(mcpGates(writing).includeWrites).toBe(true);
    const stopped = ok(applyTransition(writing, { type: 'set-mcp-read-tier', tier: 'off' }, deps));
    expect(stopped.mcp.writesEnabled).toBe(false);
  });
});

describe('allowing changes', () => {
  it('needs a read tier and its own consent', () => {
    expect(applyTransition(off(), { type: 'set-mcp-writes', enabled: true, writesConsentConfirmed: true }, deps))
      .toEqual({ ok: false, error: 'read_tier_required' });
    expect(applyTransition(on(), { type: 'set-mcp-writes', enabled: true }, deps)).toEqual({ ok: false, error: 'writes_consent_required' });
    const writing = ok(applyTransition(on(), { type: 'set-mcp-writes', enabled: true, writesConsentConfirmed: true }, deps));
    expect(writing.mcp).toMatchObject({ writesEnabled: true, writesConsentAcceptedAt: NOW });
    expect(ok(applyTransition(writing, { type: 'set-mcp-writes', enabled: false }, deps)).mcp.writesEnabled).toBe(false);
  });
});

describe('the token and the port', () => {
  it('rotates the token', () => {
    const bound = on();
    tokens = [TOKEN_B];
    expect(ok(applyTransition(bound, { type: 'rotate-token' }, deps)).mcp.token).toBe(TOKEN_B);
  });

  it('takes a port override, refuses a bad one and the Stream Deck port', () => {
    expect(ok(applyTransition(off(), { type: 'set-mcp-port', port: 8123 }, deps)).mcp.portOverride).toBe(8123);
    expect(ok(applyTransition(off(), { type: 'set-mcp-port', port: DEFAULT_MCP_PORT }, deps)).mcp.portOverride).toBeNull();
    for (const port of [0, 65536, 1.5, '8123', undefined]) {
      expect(applyTransition(off(), { type: 'set-mcp-port', port }, deps)).toEqual({ ok: false, error: 'invalid_port' });
    }
    expect(applyTransition(off(), { type: 'set-mcp-port', port: STREAM_DECK_PORT }, deps)).toEqual({ ok: false, error: 'port_reserved' });
  });

  it('refuses anything else that comes over IPC', () => {
    for (const action of [null, 'rotate-token', { type: 'nope' }, { type: 'set-mcp-read-tier', tier: 'everything' }, { type: 'set-stream-deck', enabled: 1 }]) {
      expect(applyTransition(off(), action, deps)).toEqual({ ok: false, error: 'invalid_action' });
    }
  });

  it('never changes the config it was given', () => {
    const before = on();
    const snapshot = JSON.stringify(before);
    applyTransition(before, { type: 'set-mcp-read-tier', tier: 'off' }, deps);
    applyTransition(before, { type: 'rotate-token' }, deps);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('what a transition does to the listeners', () => {
  it('starts and stops MCP on binding, restarts it on a port change while bound only', () => {
    const bound = on();
    expect(listenerEffects(off(), bound).mcp).toBe('start');
    expect(listenerEffects(bound, ok(applyTransition(bound, { type: 'set-mcp-read-tier', tier: 'off' }, deps))).mcp).toBe('stop');
    expect(listenerEffects(bound, ok(applyTransition(bound, { type: 'set-mcp-port', port: 8123 }, deps))).mcp).toBe('restart');
    expect(listenerEffects(off(), ok(applyTransition(off(), { type: 'set-mcp-port', port: 8123 }, deps))).mcp).toBe('none');
    // The listener reads the token and the tier per request: neither restarts it.
    expect(listenerEffects(bound, ok(applyTransition(bound, { type: 'rotate-token' }, deps))).mcp).toBe('none');
    expect(listenerEffects(bound, ok(applyTransition(bound, { type: 'set-mcp-writes', enabled: true, writesConsentConfirmed: true }, deps))).mcp).toBe('none');
  });

  it('starts and stops Stream Deck with its toggle, independent of MCP', () => {
    const deck = ok(applyTransition(off(), { type: 'set-stream-deck', enabled: true }, deps));
    expect(listenerEffects(off(), deck)).toEqual({ mcp: 'none', streamDeck: 'start' });
    expect(listenerEffects(deck, off())).toEqual({ mcp: 'none', streamDeck: 'stop' });
  });
});

describe('the Settings view', () => {
  it('resolves the ports and the endpoint', () => {
    const idle = { running: false, error: null };
    const v = integrationsView(ok(applyTransition(on(), { type: 'set-mcp-port', port: 8123 }, deps)), { mcp: { running: true, error: null }, streamDeck: idle });
    expect(v.mcp).toMatchObject({ readTier: 'chores', port: 8123, portOverride: 8123, endpoint: 'http://127.0.0.1:8123/mcp', status: { running: true, error: null } });
    expect(v.streamDeck).toEqual({ enabled: false, port: STREAM_DECK_PORT, status: idle });
    expect(integrationsView(off(), { mcp: idle, streamDeck: idle }).mcp.endpoint).toBe('http://127.0.0.1:7900/mcp');
  });
});
