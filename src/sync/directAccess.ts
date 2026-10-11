// Direct Access as a snapshot-file transport (docs/direct-access.md, step 2).
//
// The user picks a folder (Android) or the sync file itself (iOS) that a
// third-party tool already keeps in step across devices; lastGLANCE reads and
// writes lastglance-sync.json there and the tool moves it. The cycle, the
// merge and every data-safety guard are `@glance-apps/sync`'s
// runSnapshotFileCycle (directAccessCycle.ts); this module is the bridge to
// the native plugin (src/native/directAccess.ts) plus the small state machine
// the settings section renders. It is dayGLANCE's src/sync/directAccessTransport.js
// with this app's names, and the rules there hold here:
//
//   • OFF until a folder is picked. Picking IS the decision, so there is no
//     first-run prompt: the snapshot in the folder is applied.
//   • `allowsPlaintextReseed` is false. The folder is someone else's cloud; an
//     encrypted file this device cannot read is left exactly as it is.
//   • A write throttle longer than a daemon's round-trip, since each write
//     inside that window risks a conflict copy.
//   • An unreachable folder (the syncing tool not running, a grant revoked)
//     is reported once and then waited out: the transport marks itself
//     unreachable, the cycle stops, and each poll tick asks the shell whether
//     the folder is back.
//
// The folder's tree URI and the iOS bookmarks live in the shell; the page sees
// a name for the settings section and nothing else.

import { createDirectAccessBridge, isDirectAccessAvailable } from '@/native/directAccess'
import type { DirectAccessBridge, DirectAccessRead, DirectAccessStatus } from '@/native/directAccess'

/** Poll cadence: the tool does the network work; we read the local file. */
export const DIRECT_ACCESS_POLL_MS = 15 * 1000
/** Drive, Dropbox and Nextcloud take seconds to a minute to round-trip a change. */
export const DIRECT_ACCESS_WRITE_THROTTLE_MS = 15 * 1000
/** Stamped by the shared cycle on every read of a real snapshot (the seed guard). */
export const DIRECT_ACCESS_LAST_SYNCED_KEY = 'lastglance-direct-access-last-synced'
/** 'true' | 'false' | absent. Absent means ON once a folder is connected. */
export const DIRECT_ACCESS_PREF_KEY = 'lastglance-direct-access-enabled'
/**
 * 'true' | absent. The per-device "encrypt the file" switch: it decides the
 * FIRST write, seeding an absent file or upgrading a plaintext one; from then
 * on the file decides for every device. Forgotten with the folder on
 * disconnect, like the last-synced stamp.
 */
export const DIRECT_ACCESS_ENCRYPT_KEY = 'lastglance-direct-access-encrypt'
/**
 * A picker that never answers (a delegate not called, a result lost on the way
 * back into the page) would otherwise leave the button disabled and say
 * nothing. Long enough to browse a slow Files location.
 */
export const DIRECT_ACCESS_PICK_TIMEOUT_MS = 3 * 60 * 1000

export type DirectAccessConnection = 'unknown' | 'disconnected' | 'connected' | 'unreachable'

export interface FileStatus { configured: boolean; name: string | null; path: string | null; reachable: boolean }

/** What the settings section renders, through useSyncExternalStore. */
export interface DirectAccessSnapshot {
  supported: boolean
  status: DirectAccessConnection
  name: string | null
  path: string | null
  connected: boolean
  enabled: boolean
  encrypt: boolean
  pickError: string | null
  /** iOS: the roster file's own status; null where the roster is a path in the folder. */
  roster: FileStatus | null
  /** iOS: likewise for the intents event set. */
  events: FileStatus | null
}

/** A file beside the snapshot (the roster, the event set): the same string contract the snapshot read has. */
export interface DirectAccessFileSlot {
  supported: () => boolean
  read: (relPath: string) => Promise<string | null>
  write: (relPath: string, text: string) => Promise<boolean>
  forget: () => Promise<void>
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface DirectAccessTransportDeps {
  bridge?: () => DirectAccessBridge | null
  storage?: () => StorageLike | null
  log?: Pick<Console, 'warn'>
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

let nativeBridge: DirectAccessBridge | null = null
const defaultBridge = (): DirectAccessBridge | null => {
  if (!isDirectAccessAvailable()) return null
  nativeBridge ??= createDirectAccessBridge()
  return nativeBridge
}
const defaultStorage = (): StorageLike | null => (typeof localStorage === 'undefined' ? null : localStorage)

/** Read without a transport: the launch-time key gate runs before any folder is restored. */
export const directAccessEncryptsWrites = (storage: () => StorageLike | null = defaultStorage): boolean => {
  try { return storage()?.getItem(DIRECT_ACCESS_ENCRYPT_KEY) === 'true' } catch { return false }
}

const normalizeFileStatus = (st: DirectAccessStatus | null | undefined): FileStatus => (st && st.configured
  ? { configured: true, name: st.name ?? null, path: st.path ?? null, reachable: !!st.reachable }
  : { configured: false, name: null, path: null, reachable: false })

/** The shell's classification onto the string contract the shared cycle reads (classifySnapshotText). */
const readToText = (r: DirectAccessRead | null | undefined, label: string): string | null => {
  switch (r?.kind) {
    case 'absent': return null
    case 'downloading': return JSON.stringify({ downloading: true })
    case 'text': return r.text ?? ''
    default: return JSON.stringify({ error: r?.error ?? `${label} unavailable` })
  }
}

export function createDirectAccessTransport({
  bridge = defaultBridge,
  storage = defaultStorage,
  log = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: DirectAccessTransportDeps = {}) {
  const state: { status: DirectAccessConnection; name: string | null; path: string | null; pickError: string | null; roster: FileStatus | null; events: FileStatus | null } =
    { status: 'unknown', name: null, path: null, pickError: null, roster: null, events: null }
  const statusListeners = new Set<(s: DirectAccessSnapshot) => void>()
  const changeListeners = new Set<() => void>()
  let initPromise: Promise<void> | null = null
  let reprobing = false

  const readPref = (): string | null => { try { return storage()?.getItem(DIRECT_ACCESS_PREF_KEY) ?? null } catch { return null } }
  const isEnabled = () => readPref() !== 'false'
  const encryptsWrites = () => directAccessEncryptsWrites(storage)
  const isConnected = () => state.status === 'connected' || state.status === 'unreachable'

  const compute = (): DirectAccessSnapshot => ({
    supported: !!bridge(),
    status: state.status,
    name: state.name,
    path: state.path,
    connected: isConnected(),
    enabled: isEnabled(),
    encrypt: encryptsWrites(),
    pickError: state.pickError,
    roster: state.roster,
    events: state.events,
  })
  let snapshot = compute()
  const notify = () => {
    snapshot = compute()
    for (const l of statusListeners) { try { l(snapshot) } catch { /* one listener must not break the others */ } }
  }
  const emitChanged = () => {
    for (const cb of changeListeners) { try { cb() } catch { /* ditto */ } }
  }

  const applyStatus = (st: DirectAccessStatus | null | undefined) => {
    if (!st || !st.configured) {
      state.status = 'disconnected'; state.name = null; state.path = null
    } else {
      state.status = st.reachable ? 'connected' : 'unreachable'
      state.name = st.name ?? null
      state.path = st.path ?? null
    }
    notify()
  }

  // Ask the shell to re-open what it remembers. Once per session; every entry
  // point funnels through here so the order of first use does not matter.
  const ensureInit = (): Promise<void> => {
    if (initPromise) return initPromise
    const b = bridge()
    if (!b) { initPromise = Promise.resolve(); return initPromise }
    initPromise = (async () => {
      try { applyStatus(await b.restore()) }
      catch (e) { log.warn('[direct-access] restore failed:', (e as Error)?.message ?? e); applyStatus(null) }
      if (b.users) { try { state.roster = normalizeFileStatus(await b.users.status()); notify() } catch { /* unknown until a pick */ } }
      if (b.events) { try { state.events = normalizeFileStatus(await b.events.status()); notify() } catch { /* unknown until a pick */ } }
    })()
    return initPromise
  }

  // While unreachable, each poll tick asks whether the folder is back; coming
  // back kicks a cycle so a change that landed meanwhile is picked up at once.
  const reprobe = async () => {
    if (reprobing) return
    reprobing = true
    try {
      const st = await bridge()?.status()
      const was = state.status
      applyStatus(st)
      if (was !== 'connected' && state.status === 'connected') emitChanged()
    } catch { /* still away */ }
    finally { reprobing = false }
  }

  const clearLastSynced = () => { try { storage()?.removeItem(DIRECT_ACCESS_LAST_SYNCED_KEY) } catch { /* ignore */ } }
  const writePref = (enabled: boolean) => { try { storage()?.setItem(DIRECT_ACCESS_PREF_KEY, enabled ? 'true' : 'false') } catch { /* ignore */ } }
  const writeEncryptPref = (on: boolean) => {
    try {
      if (on) storage()?.setItem(DIRECT_ACCESS_ENCRYPT_KEY, 'true')
      else storage()?.removeItem(DIRECT_ACCESS_ENCRYPT_KEY)
    } catch { /* ignore */ }
  }

  // A file slot beside the snapshot: the household roster and the intents
  // event set (step 3). Android offers files by path, confined to the folder
  // in the shell; an iPhone has no folder and offers each as its own
  // bookmarked file. The caller hands over the relative path either way.
  const fileSlot = (name: 'users' | 'events', label: string): DirectAccessFileSlot => ({
    supported: () => { const b = bridge(); return !!(b && (b.paths || b[name])) },
    read: async (relPath) => {
      const b = bridge()
      if (!b) return JSON.stringify({ error: 'no bridge' })
      let r: DirectAccessRead
      try {
        if (b[name]) r = await b[name].read()
        else if (b.paths) r = await b.paths.read(relPath)
        else return JSON.stringify({ error: `the ${label} is not reachable on this platform` })
      } catch (err) {
        return JSON.stringify({ error: (err as Error)?.message ?? String(err) })
      }
      return readToText(r, label)
    },
    // Creates the directory on a failed write; a bookmarked file has none to create.
    write: async (relPath, text) => {
      const b = bridge()
      if (!b) return false
      try {
        if (b[name]) return (await b[name].write(text)) === true
        if (!b.paths) return false
        if ((await b.paths.write(relPath, text)) === true) return true
        const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
        if (dir) await b.paths.makeDir(dir)
        return (await b.paths.write(relPath, text)) === true
      } catch {
        return false
      }
    },
    forget: async () => {
      const b = bridge()
      try { await b?.[name]?.forget() } catch { /* forgotten on this side regardless */ }
      const next = b?.[name] ? normalizeFileStatus(null) : null
      if (name === 'users') state.roster = next; else state.events = next
      notify()
    },
  })
  const usersSlot = fileSlot('users', 'roster')
  const eventsSlot = fileSlot('events', 'event set')

  // Files by path, confined to the folder in the shell. Android only; an
  // iPhone holds bookmarks to files and cannot list.
  const files = {
    supported: () => !!bridge()?.paths,
    list: async (dir: string): Promise<string[] | null> => {
      const b = bridge()
      if (!b?.paths) return null
      try { return await b.paths.list(dir) } catch { return null }
    },
    read: async (rel: string): Promise<string | null> => {
      const b = bridge()
      if (!b?.paths) return JSON.stringify({ error: 'files by path are not reachable on this platform' })
      try { return readToText(await b.paths.read(rel), 'file') }
      catch (err) { return JSON.stringify({ error: (err as Error)?.message ?? String(err) }) }
    },
    remove: async (rel: string): Promise<boolean> => {
      const b = bridge()
      if (!b?.paths) return false
      try { return (await b.paths.remove(rel)) === true } catch { return false }
    },
  }

  async function runPick(method: 'pick' | 'pickFile' | 'createFile', slot: 'snapshot' | 'users' | 'events' = 'snapshot'): Promise<DirectAccessSnapshot | null> {
    const b = bridge()
    if (!b) return null
    if (slot !== 'snapshot' && !b[slot]) {
      state.pickError = 'not available on this platform'
      notify()
      return null
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<{ error: string }>((resolve) => {
      timer = setTimer(() => resolve({ error: 'the picker returned no result' }), DIRECT_ACCESS_PICK_TIMEOUT_MS)
    })
    let st: Awaited<ReturnType<DirectAccessBridge['pick']>> | { error: string; path?: string }
    try { st = await Promise.race([method === 'pick' ? b.pick() : b[method](slot), timeout]) }
    catch (err) { st = { error: (err as Error)?.message ?? String(err) } }
    finally { if (timer !== null) clearTimer(timer) }
    if (st && typeof st === 'object' && 'error' in st && st.error) {
      state.pickError = st.error + (st.path ? ` (${st.path})` : '')
      log.warn('[direct-access] pick failed:', st)
      notify()
      return null
    }
    if (state.pickError) { state.pickError = null; notify() }
    if (!st) return null
    const status = st as DirectAccessStatus
    if (slot !== 'snapshot') {
      if (slot === 'users') state.roster = normalizeFileStatus(status)
      else state.events = normalizeFileStatus(status)
      notify()
      return snapshot
    }
    // A different folder has its own history: the seed guard must not read an
    // empty new folder as an eviction of the old one and wait ten minutes.
    clearLastSynced()
    writePref(true)
    applyStatus(status)
    emitChanged()
    return snapshot
  }

  return {
    id: 'direct-access',
    pollMs: DIRECT_ACCESS_POLL_MS,
    writeThrottleMs: DIRECT_ACCESS_WRITE_THROTTLE_MS,
    lastSyncedKey: DIRECT_ACCESS_LAST_SYNCED_KEY,
    allowsPlaintextReseed: false,

    isSupported: () => !!bridge(),

    isAvailable: (): boolean => {
      if (!bridge()) return false
      if (state.status === 'unknown') { void ensureInit(); return false }
      if (state.status === 'unreachable') { void reprobe(); return false }
      return state.status === 'connected'
    },

    read: async (): Promise<string | null> => {
      const b = bridge()
      if (!b) return JSON.stringify({ error: 'no bridge' })
      const r = await b.read()
      if (r?.kind !== 'absent' && r?.kind !== 'downloading' && r?.kind !== 'text' && state.status === 'connected') {
        // The folder went away under us. Say so once (the cycle surfaces the
        // error), then wait quietly: see reprobe().
        state.status = 'unreachable'
        notify()
      }
      return readToText(r, 'folder')
    },

    write: async (text: string): Promise<boolean> => (await bridge()?.write(text)) === true,

    // The household roster and the intents event set (step 3), and files by path.
    roster: usersSlot,
    events: eventsSlot,
    files,

    // Push signals: a folder picked or re-enabled in settings, and a folder
    // that came back from unreachable. The shells have no folder watcher.
    onChanged: (cb: () => void): (() => void) => {
      changeListeners.add(cb)
      return () => { changeListeners.delete(cb) }
    },

    isEnabled,
    setEnabled: (enabled: boolean) => {
      writePref(enabled)
      notify()
      if (enabled) emitChanged()
    },
    /** Turning it on kicks a cycle so the upgrade is written now; off changes nothing until the file is replaced. */
    encryptsWrites,
    setEncryptsWrites: (on: boolean) => {
      writeEncryptPref(!!on)
      notify()
      if (on) emitChanged()
    },
    // Picking the folder is the decision; the snapshot in it is applied.
    firstRunDecided: () => true,

    // ── Settings surface ──
    subscribe: (listener: (s: DirectAccessSnapshot) => void): (() => void) => {
      statusListeners.add(listener)
      void ensureInit()
      return () => { statusListeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    isConnected,

    /** Android: the folder picker. Resolves to the new snapshot, or null when cancelled, refused (pickError says why) or never answered. */
    pickFolder: () => runPick('pick'),
    /** iOS: the sync file itself, picked (pickFile) or created in a chosen folder (createFile). */
    pickFile: () => runPick('pickFile'),
    createFile: () => runPick('createFile'),
    /** iOS: the roster and the event set, bookmarked files of their own (step 3). */
    pickUsersFile: () => runPick('pickFile', 'users'),
    createUsersFile: () => runPick('createFile', 'users'),
    forgetUsersFile: usersSlot.forget,
    pickEventsFile: () => runPick('pickFile', 'events'),
    createEventsFile: () => runPick('createFile', 'events'),
    forgetEventsFile: eventsSlot.forget,

    disconnect: async () => {
      try { await bridge()?.disconnect() } catch { /* this side still forgets it */ }
      clearLastSynced()
      writeEncryptPref(false)
      applyStatus(null)
    },

    /** The shell's own view of the folder, verbatim. */
    probeStatus: async (): Promise<DirectAccessStatus | { error: string } | null> => {
      const b = bridge()
      if (!b) return null
      try { return await b.status() } catch (err) { return { error: (err as Error)?.message ?? String(err) } }
    },

    /** Deletes the snapshot in the folder. */
    deleteSnapshot: async (): Promise<boolean> => (await bridge()?.deleteFile()) === true,
  }
}

export type DirectAccessTransport = ReturnType<typeof createDirectAccessTransport>

/** The app's one Direct Access transport. */
export const directAccessTransport: DirectAccessTransport = createDirectAccessTransport()
