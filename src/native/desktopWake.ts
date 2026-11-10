import type { DesktopBridge } from './desktop'

// The desktop app's wake signal (docs/desktop-app.md, section 7). Many hooks
// kick their work on `visibilitychange` (a sync, the day rollover, reminders),
// and a desktop window that stays up across a sleep, or a screen lock, never
// sends one. The main process says when the machine woke, the screen unlocked
// or the window was shown, and the page replays the event the hooks already
// listen for: each still checks visibilityState itself, so a hidden window's
// "visible-only" kicks stay quiet.

export function installDesktopWake(bridge: Pick<DesktopBridge, 'shell'>, doc: Pick<Document, 'dispatchEvent'> = document): () => void {
  return bridge.shell.onWake(() => { doc.dispatchEvent(new Event('visibilitychange')) })
}
