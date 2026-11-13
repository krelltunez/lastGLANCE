import { drainLauncherQueue, type DrainedWrite } from '@/intents/launcherQueue'
import { LG_LAUNCHER_ACTIONS, type LauncherWrite } from '@/intents/launcherWrites'
import type { IntentContext } from '@/intents/handleIntent'
import type { DesktopCommand, DesktopCommands } from './desktop'

// The desktop command queue's page side (docs/desktop-app.md, section 10;
// electron/commandQueue.ts). The tray and notification actions queue writes in
// the main process; the page applies them with the same handlers and ledger as
// the GLANCElauncher's writes (src/intents/launcherQueue.ts), so a replay after
// a crash is deduped on the clientId, and the main window's registered vault
// engines mark and push what they change (CLAUDE.md, "Launcher writes are
// applied, then pushed").

const ACTIONS: Record<string, string> = {
  complete: LG_LAUNCHER_ACTIONS.COMPLETE,
  create: LG_LAUNCHER_ACTIONS.CREATE,
  log_interaction: LG_LAUNCHER_ACTIONS.LOG_INTERACTION,
}

/** A command as the launcher queue's write; an action outside the vocabulary keeps its own name, which the handler refuses. */
export function commandAsWrite(command: DesktopCommand): LauncherWrite {
  return { action: ACTIONS[command.action] ?? command.action, payload: command.payload, clientId: command.clientId }
}

/** Where the activity log says a write came from. */
export const commandVia = (command: Pick<DesktopCommand, 'source'>): string =>
  (command.source === 'notification' ? 'a notification' : command.source === 'streamdeck' ? 'the Stream Deck' : 'the tray')

/** Take the queue, apply each command, acknowledge each once handled. */
export async function drainDesktopCommands(
  queue: Pick<DesktopCommands, 'take' | 'ack'>,
  ctxFor: (via: string) => IntentContext,
  cancelled: () => boolean = () => false,
): Promise<DrainedWrite[]> {
  let taken: DesktopCommand[]
  try { taken = await queue.take() } catch { return [] }
  if (!Array.isArray(taken) || taken.length === 0) return []
  const results: DrainedWrite[] = []
  // One at a time, so each write's context names its own source.
  for (const command of taken) {
    if (cancelled()) break
    results.push(...await drainLauncherQueue({
      entries: [commandAsWrite(command)],
      ctx: () => ctxFor(commandVia(command)),
      ack: (ids) => queue.ack(ids),
      cancelled,
    }))
  }
  return results
}
