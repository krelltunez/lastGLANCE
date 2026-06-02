import { buildAuthHeader, getFileOrNull, ensureFolder, putFile } from '@/intents/webdav'
import type { SyncWebdavConfig } from '@/sync/engine'
import type { User } from '@/types'

export const DEFAULT_USERS_PATH = '/GLANCE/users/'

interface SharedUser {
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
  const filename = 'glance-users.json'

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
