import { canonicalJson, RELAY_CONFIRM_MS } from '@glance-apps/sync'
import { buildAuthHeader, getFileOrNull, ensureFolder, putFile } from '@/intents/webdav'
import type { SyncWebdavConfig } from '@/sync/engine'
import { directAccessTransport, type DirectAccessTransport } from '@/sync/directAccess'
import type { User } from '@/types'

export const DEFAULT_USERS_PATH = '/GLANCE/users/'
const USERS_FILENAME = 'glance-users.json'

/**
 * When the household roster was last edited ON THIS DEVICE (a member added,
 * renamed or removed in the Users panel), as opposed to merged in from a
 * transport. The Direct Access roster sync writes at once for a change made
 * here and waits for the folder to catch up with one that arrived by another
 * road, the rule the snapshot cycle follows.
 */
export const ROSTER_EDIT_KEY = 'lastglance-users-local-edit-at'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null
const defaultStorage = (): StorageLike => (typeof localStorage === 'undefined' ? null : localStorage)

export function markRosterEdited(storage: StorageLike = defaultStorage()): void {
  try { storage?.setItem(ROSTER_EDIT_KEY, new Date().toISOString()) } catch { /* storage unavailable */ }
}

export interface SharedUser {
  id: string      // sync_id
  name: string
  updatedAt: string
  deleted?: boolean
}

interface SharedRoster {
  version: 1
  users: SharedUser[]
  updated_at: string
}

function usersFolder(usersPath: string): string {
  return (usersPath ?? DEFAULT_USERS_PATH).replace(/^\//, '').replace(/\/$/, '')
}

function mergeUsers(remote: SharedUser[], local: User[]): SharedUser[] {
  const byId = new Map<string, SharedUser>()
  for (const u of remote) byId.set(u.id, u)
  for (const u of local) {
    const existing = byId.get(u.sync_id)
    if (!existing || u.updated_at > existing.updatedAt) {
      byId.set(u.sync_id, { id: u.sync_id, name: u.name, updatedAt: u.updated_at })
    }
  }
  return Array.from(byId.values())
}

export interface SyncSharedUsersResult {
  merged: Array<{ id: string; name: string; updatedAt: string }>
}

export async function syncSharedUsers(
  syncConfig: SyncWebdavConfig,
  usersPath: string,
  localUsers: User[]
): Promise<SyncSharedUsersResult | null> {
  const auth = buildAuthHeader(syncConfig.username, syncConfig.appPassword)
  const base = syncConfig.webdavUrl
  const folder = usersFolder(usersPath)
  const filename = USERS_FILENAME

  // Fetch existing roster
  let remote: SharedUser[] = []
  let isNew = false
  try {
    const raw = await getFileOrNull(base, folder, filename, auth)
    if (raw) {
      const parsed = JSON.parse(raw) as SharedRoster
      if (Array.isArray(parsed.users)) remote = parsed.users
    } else {
      isNew = true
    }
  } catch {
    isNew = true
  }

  const merged = mergeUsers(remote, localUsers)
  const roster: SharedRoster = { version: 1, users: merged, updated_at: new Date().toISOString() }
  const body = JSON.stringify(roster, null, 2)

  // If file didn't exist, ensure the directory exists before writing
  if (isNew) {
    await ensureFolder(base, folder, auth)
  }

  await putFile(base, folder, filename, body, auth)

  return { merged: merged.filter(u => !u.deleted) }
}

// ─── Direct Access (docs/direct-access.md, step 3) ───────────────────────────

/** The roster's directory and file, relative to a folder root (no leading slash). */
export function relativeRosterPaths(usersPath?: string | null): { dirPath: string; filePath: string } {
  const dirPath = usersFolder(usersPath ?? DEFAULT_USERS_PATH) + '/'
  return { dirPath, filePath: dirPath + USERS_FILENAME }
}

const wireUsersOf = (remoteRaw: string | null | undefined): SharedUser[] => {
  if (!remoteRaw) return []
  try {
    const data = JSON.parse(remoteRaw)
    return Array.isArray(data?.users) ? data.users : []
  } catch { return [] }
}

/**
 * What a folder-based roster sync does with what it read: the merged roster
 * and the body to write back, or null when the file is still downloading and
 * the caller should retry next cycle. `remoteRaw` follows the snapshot read
 * contract: null for an absent file, '{"downloading":true}', or the text.
 */
export function reconcileRoster(remoteRaw: string | null | undefined, localUsers: User[]): { merged: SharedUser[]; body: string } | null {
  if (remoteRaw && typeof remoteRaw === 'string') {
    try {
      const parsed = JSON.parse(remoteRaw)
      if (parsed?.downloading === true) return null
    } catch { /* not JSON: treat as content */ }
  }
  const merged = mergeUsers(remoteRaw == null || remoteRaw === 'null' ? [] : wireUsersOf(remoteRaw), localUsers)
  const roster: SharedRoster = { version: 1, users: merged, updated_at: new Date().toISOString() }
  return { merged, body: JSON.stringify(roster, null, 2) }
}

const rosterKey = (users: SharedUser[]): string =>
  canonicalJson([...users].map((u) => ({ id: u.id, name: u.name, updatedAt: u.updatedAt, ...(u.deleted ? { deleted: true } : {}) })).sort((a, b) => a.id.localeCompare(b.id)))

/** Per-transport bookkeeping for the write rules: the last successful write, the previous read (the baseline a local edit has to be newer than before any write), and the pending relay look. */
export interface RosterSyncState { lastWrittenAt: number; previousReadAt: number; pending: { fingerprint: string; at: number } | null }
const rosterSyncState = new Map<string, RosterSyncState>()
const stateFor = (id: string): RosterSyncState => {
  let st = rosterSyncState.get(id)
  if (!st) { st = { lastWrittenAt: 0, previousReadAt: 0, pending: null }; rosterSyncState.set(id, st) }
  return st
}
export function _resetRosterSyncStateForTests(): void { rosterSyncState.clear() }

export interface DirectAccessRosterDeps {
  now?: () => number
  storage?: StorageLike
  state?: RosterSyncState
  log?: Pick<Console, 'warn'>
}

/**
 * Sync the local user list with glance-users.json in the Direct Access folder,
 * at the same relative path WebDAV uses, through the transport's roster slot:
 * a path in the folder on Android, the roster's own bookmarked file on iOS.
 *
 * Unlike the WebDAV roster sync, which rewrites the file on every run, this
 * one follows the snapshot cycle's rules, because two devices rewriting one
 * file in a syncing folder is a conflict copy per run: it writes only when
 * the roster the file holds would change, at once for a change made on this
 * device (ROSTER_EDIT_KEY newer than this device's last write, or before any
 * write its previous read), and for a change that arrived by another road
 * only once the file has sat unchanged, still lacking it, for RELAY_CONFIRM_MS.
 * The merged roster is returned and applied locally either way.
 *
 * Returns null when no folder is connected, the folder or roster is
 * unreachable (nothing is written then), or the file is still being
 * delivered (retry next cycle).
 */
export async function syncSharedUsersViaDirectAccess(
  usersPath: string,
  localUsers: User[],
  transport: DirectAccessTransport = directAccessTransport,
  deps: DirectAccessRosterDeps = {},
): Promise<SyncSharedUsersResult | null> {
  if (!transport.isSupported() || !transport.roster.supported()) return null
  if (!transport.isAvailable()) return null
  const now = deps.now ?? Date.now
  const storage = deps.storage ?? defaultStorage()
  const log = deps.log ?? console
  const st = deps.state ?? stateFor(transport.id)
  const { filePath } = relativeRosterPaths(usersPath)

  let remoteRaw: string | null
  try {
    remoteRaw = await transport.roster.read(filePath)
  } catch (err) {
    log.warn('[shared-users/direct-access] read error:', (err as Error)?.message ?? err)
    return null
  }
  // An error object (the folder went away, a roster that cannot be reached):
  // say nothing and write nothing. Seeding over a folder we cannot read would
  // be the resurrection the snapshot cycle guards against.
  let remoteStamp = 'absent'
  if (remoteRaw && typeof remoteRaw === 'string') {
    try {
      const parsed = JSON.parse(remoteRaw)
      if (parsed && typeof parsed === 'object' && parsed.error) {
        log.warn('[shared-users/direct-access] roster unavailable:', parsed.error)
        return null
      }
      if (parsed && typeof parsed === 'object' && parsed.updated_at) remoteStamp = String(parsed.updated_at)
    } catch { /* content */ }
  }

  const r = reconcileRoster(remoteRaw, localUsers)
  if (!r) return null
  const { merged, body } = r
  const result: SyncSharedUsersResult = { merged: merged.filter((u) => !u.deleted) }
  const readAt = now()
  const previousReadAt = st.previousReadAt
  st.previousReadAt = readAt

  // The write question: would the roster the file holds change?
  const changed = rosterKey(merged) !== rosterKey(wireUsersOf(remoteRaw))
  if (!changed) { st.pending = null; return result }

  // Made here, or relayed.
  let editedAt = 0
  try { const v = storage?.getItem(ROSTER_EDIT_KEY); const t = v ? new Date(v).getTime() : NaN; editedAt = Number.isFinite(t) ? t : 0 } catch { editedAt = 0 }
  const baseline = st.lastWrittenAt || previousReadAt
  const ownEdits = editedAt > baseline
  const fingerprint = `${remoteStamp}\u0000${rosterKey(merged)}`
  if (!ownEdits) {
    if (!(st.pending && st.pending.fingerprint === fingerprint && readAt - st.pending.at >= RELAY_CONFIRM_MS)) {
      if (!st.pending || st.pending.fingerprint !== fingerprint) st.pending = { fingerprint, at: readAt }
      return result
    }
  }

  const ok = await transport.roster.write(filePath, body)
  if (!ok) log.warn('[shared-users/direct-access] write failed')
  else { st.lastWrittenAt = readAt; st.pending = null }
  return result
}
