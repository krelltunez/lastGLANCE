import { buildAuthHeader, getFileOrNull, ensureFolder, putFile } from '@/intents/webdav'
import type { IntentsConfig } from '@/intents/config'
import type { User } from '@/types'

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

function usersFolder(config: IntentsConfig): string {
  return (config.usersPath ?? '/GLANCE/users/').replace(/^\//, '').replace(/\/$/, '')
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
  config: IntentsConfig,
  localUsers: User[]
): Promise<SyncSharedUsersResult | null> {
  if (!config.webdavUrl || !config.webdavUsername || !config.webdavPassword) return null

  const auth = buildAuthHeader(config.webdavUsername, config.webdavPassword)
  const base = config.webdavUrl
  const folder = usersFolder(config)
  const filename = 'glance-users.json'

  // Fetch existing roster
  let remote: SharedUser[] = []
  try {
    const raw = await getFileOrNull(base, folder, filename, auth)
    if (raw) {
      const parsed = JSON.parse(raw) as SharedRoster
      if (Array.isArray(parsed.users)) remote = parsed.users
    }
  } catch {
    // treat as empty / first write
  }

  const merged = mergeUsers(remote, localUsers)
  const roster: SharedRoster = { version: 1, users: merged, updated_at: new Date().toISOString() }
  const body = JSON.stringify(roster, null, 2)

  try {
    await putFile(base, folder, filename, body, auth)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('404') || msg.includes('409')) {
      await ensureFolder(base, folder, auth)
      await putFile(base, folder, filename, body, auth)
    } else {
      throw err
    }
  }

  return { merged: merged.filter(u => !u.deleted) }
}
