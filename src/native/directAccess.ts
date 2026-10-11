import { Capacitor, registerPlugin } from '@capacitor/core'
import { isAndroid, isIOS } from './platform'

// Direct Access sync (docs/direct-access.md): the native folder plugin, and
// the bridge shape the shared file transport consumes.
//
// Both shells implement the same plugin (DirectAccessPlugin.kt, .swift) with
// one difference that the bridge carries rather than hides: Android holds a
// FOLDER (a SAF tree) and offers files by path below it; iOS holds FILES (a
// bookmark each for the snapshot, the household roster and the intents event
// set), because the Files providers cannot hand an app a folder. The bridge
// an app-level transport receives is therefore the same shape dayGLANCE's
// shells produce (its src/sync/directAccessNativeBridge.js), so the transport
// and the cycle are shared code:
//
//   restore / status            → { configured, name, path, reachable }
//   pick()                      → the status, null when cancelled, { error } when refused
//   pickFile(slot) / createFile(slot)   iOS only (the snapshot, 'users' or 'events')
//   disconnect / read / write / deleteFile
//   paths.{list, read, write, remove, makeDir}   Android only, paths confined to the folder
//   users.{status, read, write, forget}          iOS only
//   events.{status, read, write, forget}         iOS only
//
// Web/PWA has no folder access a page could hold across sessions: the plugin
// is absent there and isDirectAccessAvailable() is false.

export type DirectAccessSlot = 'snapshot' | 'users' | 'events'

export interface DirectAccessStatus {
  configured: boolean
  name: string | null
  path: string | null
  reachable: boolean
  slot?: DirectAccessSlot
}

export interface DirectAccessRead {
  kind: 'absent' | 'downloading' | 'error' | 'text'
  text?: string
  error?: string
}

export interface DirectAccessPluginType {
  status(): Promise<DirectAccessStatus>
  pickFolder(): Promise<DirectAccessStatus | { cancelled: true }>
  pickFile(options: { slot: DirectAccessSlot }): Promise<DirectAccessStatus | { cancelled: true }>
  createFile(options: { slot: DirectAccessSlot }): Promise<DirectAccessStatus | { cancelled: true }>
  disconnect(): Promise<void>
  read(): Promise<DirectAccessRead>
  write(options: { text: string }): Promise<{ ok: boolean }>
  deleteFile(): Promise<{ ok: boolean }>
  // Android: files by path.
  listFiles(options: { rel: string }): Promise<{ names: string[] | null }>
  readFile(options: { rel: string }): Promise<DirectAccessRead>
  writeFile(options: { rel: string; text: string }): Promise<{ ok: boolean }>
  deleteFileAt(options: { rel: string }): Promise<{ ok: boolean }>
  makeDir(options: { rel: string }): Promise<{ ok: boolean }>
  // iOS: the roster and the event set as bookmarked files.
  usersStatus(): Promise<DirectAccessStatus>
  readUsers(): Promise<DirectAccessRead>
  writeUsers(options: { text: string }): Promise<{ ok: boolean }>
  forgetUsers(): Promise<void>
  eventsStatus(): Promise<DirectAccessStatus>
  readEvents(): Promise<DirectAccessRead>
  writeEvents(options: { text: string }): Promise<{ ok: boolean }>
  forgetEvents(): Promise<void>
}

export const DirectAccess = registerPlugin<DirectAccessPluginType>('DirectAccess')

/** True only inside a shell that registered the plugin; an older shell, and the web, answer false. */
export function isDirectAccessAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('DirectAccess')
}

export interface FileSlot {
  status: () => Promise<DirectAccessStatus>
  read: () => Promise<DirectAccessRead>
  write: (text: string) => Promise<boolean>
  forget: () => Promise<boolean>
}

export interface DirectAccessBridge {
  restore: () => Promise<DirectAccessStatus>
  status: () => Promise<DirectAccessStatus>
  pick: () => Promise<DirectAccessStatus | { error: string; path?: string } | null>
  pickFile: (slot?: DirectAccessSlot) => Promise<DirectAccessStatus | { error: string; path?: string } | null>
  createFile: (slot?: DirectAccessSlot) => Promise<DirectAccessStatus | { error: string; path?: string } | null>
  disconnect: () => Promise<boolean>
  read: () => Promise<DirectAccessRead>
  write: (text: string) => Promise<boolean>
  deleteFile: () => Promise<boolean>
  paths?: {
    list: (rel: string) => Promise<string[] | null>
    read: (rel: string) => Promise<DirectAccessRead>
    write: (rel: string, text: string) => Promise<boolean>
    remove: (rel: string) => Promise<boolean>
    makeDir: (rel: string) => Promise<boolean>
  }
  users?: FileSlot
  events?: FileSlot
}

type PickResult = DirectAccessStatus | { cancelled: true }

/** A plugin rejection becomes the `{ error, path? }` the transport shows on its card; a dismissal becomes null. */
async function pickResult(run: () => Promise<PickResult>): Promise<DirectAccessStatus | { error: string; path?: string } | null> {
  let r: PickResult
  try {
    r = await run()
  } catch (err) {
    const e = err as { message?: string; data?: { path?: string } }
    const path = e?.data?.path
    return { error: e?.message ?? String(err), ...(path ? { path } : {}) }
  }
  if (!r || (r as { cancelled?: boolean }).cancelled) return null
  return r as DirectAccessStatus
}

const badAnswer: DirectAccessRead = { kind: 'error', error: 'bad answer from the shell' }
const readOf = async (run: () => Promise<DirectAccessRead>): Promise<DirectAccessRead> => {
  const r = await run()
  return r && typeof r.kind === 'string' ? r : badAnswer
}
const okOf = async (run: () => Promise<{ ok: boolean }>): Promise<boolean> => (await run())?.ok === true

/**
 * The bridge for the running shell. `platform` and `plugin` are injectable for
 * tests; by default the plugin is the registered one and the platform the
 * real one.
 */
export function createDirectAccessBridge(
  plugin: DirectAccessPluginType = DirectAccess,
  platform: 'android' | 'ios' = isIOS() ? 'ios' : 'android',
): DirectAccessBridge {
  const slot = (
    status: () => Promise<DirectAccessStatus>,
    read: () => Promise<DirectAccessRead>,
    write: (o: { text: string }) => Promise<{ ok: boolean }>,
    forget: () => Promise<void>,
  ): FileSlot => ({
    status,
    read: () => readOf(read),
    write: (text) => okOf(() => write({ text })),
    forget: async () => { try { await forget(); return true } catch { return false } },
  })
  return {
    restore: () => plugin.status(),
    status: () => plugin.status(),
    pick: () => pickResult(() => (platform === 'ios' ? plugin.pickFile({ slot: 'snapshot' }) : plugin.pickFolder())),
    pickFile: (s = 'snapshot') => pickResult(() => plugin.pickFile({ slot: s })),
    createFile: (s = 'snapshot') => pickResult(() => plugin.createFile({ slot: s })),
    disconnect: async () => { try { await plugin.disconnect(); return true } catch { return false } },
    read: () => readOf(() => plugin.read()),
    write: (text) => okOf(() => plugin.write({ text })),
    deleteFile: () => okOf(() => plugin.deleteFile()),
    ...(platform === 'android'
      ? {
          paths: {
            list: async (rel: string) => { const r = await plugin.listFiles({ rel }); return Array.isArray(r?.names) ? r.names : null },
            read: (rel: string) => readOf(() => plugin.readFile({ rel })),
            write: (rel: string, text: string) => okOf(() => plugin.writeFile({ rel, text })),
            remove: (rel: string) => okOf(() => plugin.deleteFileAt({ rel })),
            makeDir: (rel: string) => okOf(() => plugin.makeDir({ rel })),
          },
        }
      : {
          users: slot(() => plugin.usersStatus(), () => plugin.readUsers(), (o) => plugin.writeUsers(o), () => plugin.forgetUsers()),
          events: slot(() => plugin.eventsStatus(), () => plugin.readEvents(), (o) => plugin.writeEvents(o), () => plugin.forgetEvents()),
        }),
  }
}

// Re-exported so a caller that only needs the platform question has one import.
export { isAndroid, isIOS }
