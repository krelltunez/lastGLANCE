import { Capacitor, registerPlugin } from '@capacitor/core'
import type { DirectAccessRead } from './directAccess'

// Zero-config iCloud sync (docs/icloud-sync.md): the iOS plugin
// (ios/App/App/plugins/ICloudPlugin.swift) and the bridge the transports use.
// Files are named by a path relative to a container's Documents/ folder; the
// "own" container holds lastGLANCE's sync files, "dayglance" is dayGLANCE's,
// whose GLANCE/events/ carries the intents the two apps exchange. Reads answer
// the classification every file shell answers (DirectAccessRead).
//
// iOS only: Android and the web have no plugin and isICloudAvailable() is false.

export type ICloudContainer = 'own' | 'dayglance'

export interface ICloudPluginType {
  available(): Promise<{ available: boolean }>
  readFile(options: { path: string; container?: ICloudContainer; allowStale?: boolean }): Promise<DirectAccessRead>
  writeFile(options: { path: string; text: string; container?: ICloudContainer; atomic?: boolean }): Promise<{ ok: boolean; error?: string }>
  listFiles(options: { path: string; container?: ICloudContainer }): Promise<{ names: string[] | null }>
  deleteFile(options: { path: string; container?: ICloudContainer }): Promise<{ ok: boolean }>
  makeDir(options: { path: string; container?: ICloudContainer }): Promise<{ ok: boolean }>
  addListener(event: 'changed', cb: () => void): Promise<{ remove: () => Promise<void> }>
}

export const ICloud = registerPlugin<ICloudPluginType>('ICloud')

/** True only inside an iOS shell that registered the plugin. */
export function isICloudAvailable(): boolean {
  return Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('ICloud')
}

/** The calls the transports make, every failure answered rather than thrown. */
export interface ICloudBridge {
  available: () => Promise<boolean>
  read: (path: string, opts?: { container?: ICloudContainer; allowStale?: boolean }) => Promise<DirectAccessRead>
  write: (path: string, text: string, opts?: { container?: ICloudContainer; atomic?: boolean }) => Promise<boolean>
  list: (path: string, container?: ICloudContainer) => Promise<string[] | null>
  remove: (path: string, container?: ICloudContainer) => Promise<boolean>
  makeDir: (path: string, container?: ICloudContainer) => Promise<boolean>
  onChanged: (cb: () => void) => () => void
}

const badAnswer: DirectAccessRead = { kind: 'error', error: 'bad answer from the shell' }

export function createICloudBridge(plugin: ICloudPluginType = ICloud): ICloudBridge {
  const errorOf = (err: unknown): DirectAccessRead => ({ kind: 'error', error: (err as Error)?.message ?? String(err) })
  return {
    available: async () => { try { return (await plugin.available())?.available === true } catch { return false } },
    read: async (path, { container = 'own', allowStale = false } = {}) => {
      try {
        const r = await plugin.readFile({ path, container, allowStale })
        return r && typeof r.kind === 'string' ? r : badAnswer
      } catch (err) { return errorOf(err) }
    },
    write: async (path, text, { container = 'own', atomic = false } = {}) => {
      try { return (await plugin.writeFile({ path, text, container, atomic }))?.ok === true } catch { return false }
    },
    list: async (path, container = 'own') => {
      try { const r = await plugin.listFiles({ path, container }); return Array.isArray(r?.names) ? r.names : null } catch { return null }
    },
    remove: async (path, container = 'own') => {
      try { return (await plugin.deleteFile({ path, container }))?.ok === true } catch { return false }
    },
    makeDir: async (path, container = 'own') => {
      try { return (await plugin.makeDir({ path, container }))?.ok === true } catch { return false }
    },
    onChanged: (cb) => {
      let handle: { remove: () => Promise<void> } | null = null
      let removed = false
      plugin.addListener('changed', cb).then((h) => { if (removed) void h.remove(); else handle = h }).catch(() => {})
      return () => { removed = true; void handle?.remove() }
    },
  }
}

let shared: ICloudBridge | null = null
/** The app's bridge, or null where there is no iCloud plugin. */
export function icloudBridge(): ICloudBridge | null {
  if (!isICloudAvailable()) return null
  shared ??= createICloudBridge()
  return shared
}
