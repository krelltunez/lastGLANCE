// The MCP discovery file (docs/mcp-and-stream-deck.md, section 5): {port, token}
// written where the bridge's lastGLANCE profile looks (@glance-apps/mcp-bridge
// src/apps.js), so a direct-download user connects Claude Desktop without
// configuring anything. Pure decisions here; main.ts owns the writes and the
// lifecycle (written while the server is on, rewritten on a new token or port,
// removed when it stops). After dayGLANCE's electron/mcpDiscovery.ts.
//
// The Mac App Store build writes none: a bridge reading into the app's sandbox
// container would set off a privacy prompt naming "node" (dayGLANCE's phase 0.5
// finding), so there the token is pasted by hand.

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicWrite.js';

/** Where the file goes on this platform, or null when none is written (MAS, an unknown platform). */
export function discoveryFilePath(
  platform: string,
  env: Record<string, string | undefined>,
  home: string,
  isMas: boolean,
): string | null {
  if (isMas) return null;
  switch (platform) {
    case 'win32':
      return env.APPDATA ? path.win32.join(env.APPDATA, 'lastGLANCE', 'mcp.json') : null;
    case 'darwin':
      return path.posix.join(home, 'Library', 'Application Support', 'lastGLANCE', 'mcp.json');
    case 'linux':
      return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'lastGLANCE', 'mcp.json');
    default:
      return null;
  }
}

/** The body: the port and the token, nothing else (every extra field is a compatibility promise). */
export function discoveryPayload(port: number, token: string): string {
  return JSON.stringify({ port, token }, null, 2) + '\n';
}

/**
 * Bring the file in line with the server: written (owner-only) while it runs
 * with a token, removed otherwise. Best-effort: a failure is returned for the
 * log, never thrown, since the server works without it (the token can be
 * pasted by hand).
 */
export function syncDiscoveryFile(file: string | null, server: { port: number; token: string } | null): string | null {
  if (!file) return null;
  try {
    if (server && server.token) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomicSync(file, discoveryPayload(server.port, server.token));
      try { fs.chmodSync(file, 0o600); } catch { /* Windows: ACLs, not modes */ }
    } else {
      fs.rmSync(file, { force: true });
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
