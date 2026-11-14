// lastGLANCE's MCP server (docs/mcp-and-stream-deck.md, section 4): its tools
// and resources on the listener from @glance-apps/mcp-host, which owns the
// transport and every guard in front of it (path, Host, Origin, bearer token,
// in that order; one fixed port, never scanned; loud refusals). It binds
// 127.0.0.1 only.
//
// No app state lives on the McpServer: the factory builds a fresh one per
// request, closing over deps that main.ts owns (dayGLANCE spec, 3.7).

import type http from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { startMcpListener } from '@glance-apps/mcp-host';
import { DEFAULT_MCP_PORT, MCP_ENDPOINT_PATH } from './localIntegrations.js';
import { registerReadTools, registerResources, type ReadToolDeps } from './mcpReadTools.js';
import { registerJournalReadTool, registerWriteTools, type WriteToolDeps } from './mcpWriteTools.js';
import { localizeResourceResult, localizeToolResult } from './mcpTimes.js';

export { MCP_ENDPOINT_PATH };

export interface McpServerOptions {
  /** The bearer token, or a getter read on every request (so a new token applies at once). */
  token: string | (() => string);
  portOverride?: number | null;
  readDeps: ReadToolDeps;
  /** The write tools. They are registered whenever the server runs; each call checks "Allow changes" itself. */
  writeDeps?: WriteToolDeps;
  version?: string;
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
}

/** Start the listener: the http.Server (the caller closes it), or null when it refuses to start. */
export function startMcpServer(opts: McpServerOptions): http.Server | null {
  return startMcpListener({
    name: 'lastGLANCE',
    token: opts.token,
    portOverride: opts.portOverride ?? undefined,
    defaultPort: DEFAULT_MCP_PORT,
    path: MCP_ENDPOINT_PATH,
    log: opts.log,
    logError: opts.logError,
    createServer: () => {
      const server = withLocalTimes(new McpServer({ name: 'lastGLANCE', version: opts.version || '0.0.0' }), opts.readDeps.timeZone);
      registerReadTools(server, opts.readDeps);
      registerResources(server, opts.readDeps);
      if (opts.writeDeps) {
        registerWriteTools(server, opts.writeDeps);
        if (opts.writeDeps.journal) registerJournalReadTool(server, opts.writeDeps.journal);
      }
      return server;
    },
  });
}

type Handler = (...args: unknown[]) => unknown;
type Registrar = (...args: unknown[]) => unknown;

/**
 * The server with every tool and resource answering in local time
 * (mcpTimes.ts): each handler registered on it has its result's instants
 * rewritten in the zone, read per call. One place, so a tool added later is
 * covered without knowing about it.
 */
export function withLocalTimes(server: McpServer, timeZone: () => string): McpServer {
  const s = server as unknown as { registerTool: Registrar; registerResource: Registrar };
  const wrapLast = (register: Registrar, localize: (r: unknown, tz: string) => unknown): Registrar => (...args) => {
    const handler = args[args.length - 1] as Handler;
    return register(...args.slice(0, -1), async (...call: unknown[]) => localize(await handler(...call), timeZone()));
  };
  s.registerTool = wrapLast(s.registerTool.bind(server), localizeToolResult);
  s.registerResource = wrapLast(s.registerResource.bind(server), localizeResourceResult);
  return server;
}

/** The status code a bind failure shows as in Settings. */
export function bindErrorCode(err: unknown): 'port_in_use' | 'permission_denied' | 'bind_failed' {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EADDRINUSE' ? 'port_in_use' : code === 'EACCES' ? 'permission_denied' : 'bind_failed';
}
