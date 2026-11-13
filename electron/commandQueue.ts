// The command queue (docs/desktop-app.md, section 10): how the surfaces outside
// the window (the tray, notification actions, the Stream Deck)
// change data the page owns. Main never opens the database. It appends a
// command to userData/commands.json and nudges the page; the page takes the
// queue, applies each command through the app's own handlers and ledger
// (src/native/desktopCommands.ts, over src/intents/launcherQueue.ts), and only
// then acknowledges it by clientId. A crash between the take and the
// acknowledgement replays the command, and the ledger makes the replay harmless.
//
// Commands use handleIntent's vocabulary: `complete` ({ chore_id,
// completed_at? }), `create`, `log_interaction`. The file is bounded; past the
// limit the oldest are dropped, which only a page that never loads would reach.

import fs from 'node:fs';
import { writeFileAtomicSync } from './atomicWrite.js';

export const COMMANDS_FILE = 'commands.json';
export const COMMAND_LIMIT = 200;
export const COMMAND_ACTIONS: ReadonlySet<string> = new Set(['complete', 'create', 'log_interaction']);

export type CommandSource = 'tray' | 'notification' | 'streamdeck';
const SOURCES: ReadonlySet<string> = new Set<CommandSource>(['tray', 'notification', 'streamdeck']);

export interface DesktopCommand {
  clientId: string;
  action: string;
  payload: Record<string, unknown>;
  source: CommandSource;
  at: string;
}

function isCommand(v: unknown): v is DesktopCommand {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return typeof c.clientId === 'string' && !!c.clientId && typeof c.action === 'string' && COMMAND_ACTIONS.has(c.action)
    && !!c.payload && typeof c.payload === 'object' && !Array.isArray(c.payload)
    && SOURCES.has(c.source as string) && typeof c.at === 'string';
}

export interface CommandQueueDeps {
  /** The queue file's path. */
  file: string;
  newId: () => string;
  now?: () => number;
}

export function createCommandQueue({ file, newId, now = Date.now }: CommandQueueDeps) {
  const read = (): DesktopCommand[] => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(parsed) ? parsed.filter(isCommand) : [];
    } catch {
      return [];
    }
  };
  const write = (commands: DesktopCommand[]) => {
    try { writeFileAtomicSync(file, JSON.stringify(commands)); } catch { /* the in-memory caller still has it */ }
  };

  return {
    /** Append a command; returns it, or null for an action outside the vocabulary. */
    enqueue(action: string, payload: Record<string, unknown>, source: CommandSource): DesktopCommand | null {
      if (!COMMAND_ACTIONS.has(action)) return null;
      const command: DesktopCommand = { clientId: newId(), action, payload, source, at: new Date(now()).toISOString() };
      const next = [...read(), command];
      write(next.length > COMMAND_LIMIT ? next.slice(next.length - COMMAND_LIMIT) : next);
      return command;
    },
    /** Every queued command, oldest first. Nothing leaves the queue until acknowledged. */
    take(): DesktopCommand[] {
      return read();
    },
    /** Remove handled commands. Unknown ids are ignored. */
    ack(ids: unknown): void {
      if (!Array.isArray(ids)) return;
      const done = new Set(ids.filter((id): id is string => typeof id === 'string'));
      if (done.size === 0) return;
      const all = read();
      const rest = all.filter((c) => !done.has(c.clientId));
      if (rest.length !== all.length) write(rest);
    },
  };
}

export type CommandQueue = ReturnType<typeof createCommandQueue>;
