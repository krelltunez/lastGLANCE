// Local integrations: the MCP server and the Stream Deck listener
// (docs/mcp-and-stream-deck.md, section 3). One config file in userData, and the
// pure rules that change it, after dayGLANCE's electron/localIntegrations.ts.
// main.ts owns the file and the listeners; everything that decides lives here,
// tested without Electron.
//
// The rules that matter:
//  - Everything is off by default. There are no upgraders to migrate: neither
//    integration has ever shipped on by default.
//  - Consent is given by the person, through the dialog's Accept, and only a
//    transition carrying the matching `...ConsentConfirmed` flag can turn a tier
//    on. Enabling from off asks again every time.
//  - MCP fails closed. A corrupt file is set aside as `.corrupt` and read as the
//    defaults (off); a field that does not hold its invariant is read as off,
//    never as on.
//  - The token is in the file (mode 0600), as dayGLANCE keeps it: the bridge's
//    discovery file needs the same value in the clear, and the listener reads
//    it on every request so a rotation takes effect at once.

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicWrite.js';

export const LOCAL_INTEGRATIONS_FILE = 'local-integrations.json';

/** Reserved in docs/desktop-app.md, section 10; dayGLANCE uses 7892 and 7893. */
export const DEFAULT_MCP_PORT = 7900;
export const STREAM_DECK_PORT = 7901;

export const MCP_READ_TIERS = ['off', 'chores', 'chores_people'] as const;
export type McpReadTier = (typeof MCP_READ_TIERS)[number];

export interface LocalIntegrationsConfig {
  streamDeck: { enabled: boolean };
  mcp: {
    readTier: McpReadTier;
    writesEnabled: boolean;
    /** 64 hex characters, made on the first enable; null until then. */
    token: string | null;
    portOverride: number | null;
    consentAcceptedAt: string | null;
    peopleConsentAcceptedAt: string | null;
    writesConsentAcceptedAt: string | null;
  };
}

export const DEFAULT_LOCAL_INTEGRATIONS: LocalIntegrationsConfig = Object.freeze({
  streamDeck: Object.freeze({ enabled: false }),
  mcp: Object.freeze({
    readTier: 'off',
    writesEnabled: false,
    token: null,
    portOverride: null,
    consentAcceptedAt: null,
    peopleConsentAcceptedAt: null,
    writesConsentAcceptedAt: null,
  }),
}) as LocalIntegrationsConfig;

const defaults = (): LocalIntegrationsConfig => ({
  streamDeck: { ...DEFAULT_LOCAL_INTEGRATIONS.streamDeck },
  mcp: { ...DEFAULT_LOCAL_INTEGRATIONS.mcp },
});

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** The port the MCP listener binds: the override, else 7900. */
export function mcpPort(config: LocalIntegrationsConfig): number {
  return config.mcp.portOverride ?? DEFAULT_MCP_PORT;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const stamp = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v)) ? v : null);

/**
 * A config from whatever the file held, field by field. Anything malformed is
 * its default, and the invariants are enforced downward: a tier without its
 * consent stamp drops a tier, writes without a read tier or their stamp are
 * off, and a tier with no token is off (the listener cannot bind without one).
 */
export function normalizeConfig(raw: unknown): LocalIntegrationsConfig {
  const r = obj(raw);
  const sd = obj(r.streamDeck);
  const m = obj(r.mcp);
  const config = defaults();

  config.streamDeck.enabled = sd.enabled === true;

  const token = typeof m.token === 'string' && TOKEN_RE.test(m.token) ? m.token : null;
  const consentAcceptedAt = stamp(m.consentAcceptedAt);
  const peopleConsentAcceptedAt = stamp(m.peopleConsentAcceptedAt);
  const writesConsentAcceptedAt = stamp(m.writesConsentAcceptedAt);
  let readTier: McpReadTier = MCP_READ_TIERS.includes(m.readTier as McpReadTier) ? m.readTier as McpReadTier : 'off';
  if (readTier === 'chores_people' && !peopleConsentAcceptedAt) readTier = 'chores';
  if (readTier !== 'off' && (!consentAcceptedAt || !token)) readTier = 'off';
  const writesEnabled = m.writesEnabled === true && readTier !== 'off' && !!writesConsentAcceptedAt;

  config.mcp = {
    readTier,
    writesEnabled,
    token,
    portOverride: isValidPort(m.portOverride) ? m.portOverride : null,
    consentAcceptedAt,
    peopleConsentAcceptedAt,
    writesConsentAcceptedAt,
  };
  return config;
}

export interface LoadedConfig {
  config: LocalIntegrationsConfig;
  /** The file was unreadable and was moved aside to `.corrupt`. */
  recovered: boolean;
}

/** Read the file. Missing means the defaults; unparseable is set aside and means the defaults. */
export function loadLocalIntegrations(userData: string): LoadedConfig {
  const file = path.join(userData, LOCAL_INTEGRATIONS_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return { config: defaults(), recovered: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  } catch {
    try { fs.renameSync(file, `${file}.corrupt`); } catch { /* best-effort: the defaults apply either way */ }
    return { config: defaults(), recovered: true };
  }
  return { config: normalizeConfig(parsed), recovered: false };
}

/** Write the file, owner-only: it holds the token. Returns whether it was written. */
export function saveLocalIntegrations(userData: string, config: LocalIntegrationsConfig): boolean {
  const file = path.join(userData, LOCAL_INTEGRATIONS_FILE);
  try {
    writeFileAtomicSync(file, JSON.stringify(config, null, 2));
    try { fs.chmodSync(file, 0o600); } catch { /* Windows: ACLs, not modes */ }
    return true;
  } catch {
    return false;
  }
}

export type IntegrationsAction =
  | { type: 'set-mcp-read-tier'; tier: McpReadTier; consentConfirmed?: boolean; peopleConsentConfirmed?: boolean }
  | { type: 'set-mcp-writes'; enabled: boolean; writesConsentConfirmed?: boolean }
  | { type: 'rotate-token' }
  | { type: 'set-mcp-port'; port: number | null }
  | { type: 'set-stream-deck'; enabled: boolean };

export type TransitionError =
  | 'invalid_action'
  | 'consent_required'
  | 'people_consent_required'
  | 'writes_consent_required'
  | 'read_tier_required'
  | 'invalid_port'
  | 'port_reserved';

export type TransitionResult =
  | { ok: true; config: LocalIntegrationsConfig }
  | { ok: false; error: TransitionError };

export interface TransitionDeps {
  /** ISO timestamp for the consent stamps. */
  now: () => string;
  /** 64 hex characters (crypto.randomBytes(32)). */
  newToken: () => string;
}

const clone = (c: LocalIntegrationsConfig): LocalIntegrationsConfig => ({ streamDeck: { ...c.streamDeck }, mcp: { ...c.mcp } });

/**
 * Apply one Settings action to the config. Pure: the result is a new config or
 * the reason it was refused; the input is never changed. `action` comes over
 * IPC, so it is validated here rather than trusted.
 */
export function applyTransition(config: LocalIntegrationsConfig, action: unknown, deps: TransitionDeps): TransitionResult {
  const a = obj(action);
  const next = clone(config);
  switch (a.type) {
    case 'set-mcp-read-tier': {
      const tier = a.tier as McpReadTier;
      if (!MCP_READ_TIERS.includes(tier)) return { ok: false, error: 'invalid_action' };
      if (tier === 'off') {
        next.mcp.readTier = 'off';
        next.mcp.writesEnabled = false;
        return { ok: true, config: next };
      }
      const now = deps.now();
      if (config.mcp.readTier === 'off') {
        if (a.consentConfirmed !== true) return { ok: false, error: 'consent_required' };
        next.mcp.consentAcceptedAt = now;
      }
      if (tier === 'chores_people' && config.mcp.readTier !== 'chores_people') {
        if (a.peopleConsentConfirmed !== true) return { ok: false, error: 'people_consent_required' };
        next.mcp.peopleConsentAcceptedAt = now;
      }
      if (!next.mcp.token) next.mcp.token = deps.newToken();
      next.mcp.readTier = tier;
      return { ok: true, config: next };
    }
    case 'set-mcp-writes': {
      if (typeof a.enabled !== 'boolean') return { ok: false, error: 'invalid_action' };
      if (!a.enabled) {
        next.mcp.writesEnabled = false;
        return { ok: true, config: next };
      }
      if (config.mcp.readTier === 'off') return { ok: false, error: 'read_tier_required' };
      if (config.mcp.writesEnabled) return { ok: true, config: next };
      if (a.writesConsentConfirmed !== true) return { ok: false, error: 'writes_consent_required' };
      next.mcp.writesEnabled = true;
      next.mcp.writesConsentAcceptedAt = deps.now();
      return { ok: true, config: next };
    }
    case 'rotate-token':
      next.mcp.token = deps.newToken();
      return { ok: true, config: next };
    case 'set-mcp-port': {
      if (a.port === null) {
        next.mcp.portOverride = null;
        return { ok: true, config: next };
      }
      if (!isValidPort(a.port)) return { ok: false, error: 'invalid_port' };
      if (a.port === STREAM_DECK_PORT) return { ok: false, error: 'port_reserved' };
      next.mcp.portOverride = a.port === DEFAULT_MCP_PORT ? null : a.port;
      return { ok: true, config: next };
    }
    case 'set-stream-deck':
      if (typeof a.enabled !== 'boolean') return { ok: false, error: 'invalid_action' };
      next.streamDeck.enabled = a.enabled;
      return { ok: true, config: next };
    default:
      return { ok: false, error: 'invalid_action' };
  }
}

/** What the MCP listener serves under a config. */
export function mcpGates(config: LocalIntegrationsConfig): { bound: boolean; includePeople: boolean; includeWrites: boolean } {
  const bound = config.mcp.readTier !== 'off' && config.mcp.token !== null;
  return {
    bound,
    includePeople: bound && config.mcp.readTier === 'chores_people',
    includeWrites: bound && config.mcp.writesEnabled,
  };
}

export type McpEffect = 'start' | 'stop' | 'restart' | 'none';
export type StreamDeckEffect = 'start' | 'stop' | 'none';

/**
 * What a transition does to the listeners. A token rotation or a tier change
 * needs no restart (the listener reads both per request); only binding,
 * unbinding and a port change while bound do.
 */
export function listenerEffects(before: LocalIntegrationsConfig, after: LocalIntegrationsConfig): { mcp: McpEffect; streamDeck: StreamDeckEffect } {
  const was = mcpGates(before).bound;
  const is = mcpGates(after).bound;
  const mcp: McpEffect = !was && is ? 'start'
    : was && !is ? 'stop'
      : was && is && mcpPort(before) !== mcpPort(after) ? 'restart'
        : 'none';
  const streamDeck: StreamDeckEffect = !before.streamDeck.enabled && after.streamDeck.enabled ? 'start'
    : before.streamDeck.enabled && !after.streamDeck.enabled ? 'stop'
      : 'none';
  return { mcp, streamDeck };
}

export interface ListenerStatus {
  running: boolean;
  /** A bind failure the person should see (the port is taken), else null. */
  error: string | null;
}

/** What the Settings section shows: the config with the ports resolved, and each listener's state. */
export interface LocalIntegrationsView {
  streamDeck: { enabled: boolean; port: number; status: ListenerStatus };
  mcp: {
    readTier: McpReadTier;
    writesEnabled: boolean;
    token: string | null;
    port: number;
    portOverride: number | null;
    endpoint: string;
    status: ListenerStatus;
    /** Repeated overruns of the write rate limit turned changes off until restart. */
    writesPaused: boolean;
  };
}

export const MCP_ENDPOINT_PATH = '/mcp';

export function integrationsView(
  config: LocalIntegrationsConfig,
  status: { mcp: ListenerStatus; streamDeck: ListenerStatus },
  extras: { writesPaused?: boolean } = {},
): LocalIntegrationsView {
  const port = mcpPort(config);
  return {
    streamDeck: { enabled: config.streamDeck.enabled, port: STREAM_DECK_PORT, status: { ...status.streamDeck } },
    mcp: {
      readTier: config.mcp.readTier,
      writesEnabled: config.mcp.writesEnabled,
      token: config.mcp.token,
      port,
      portOverride: config.mcp.portOverride,
      endpoint: `http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`,
      status: { ...status.mcp },
      writesPaused: extras.writesPaused === true,
    },
  };
}
