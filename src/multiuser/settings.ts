const MULTI_USER_ENABLED_KEY = 'lg_multi_user_enabled'
const USER_FILTER_KEY = 'lg_user_filter'
const ATTENTION_FILTER_KEY = 'lg_attention_filter'
const MULTIUSER_CONFIG_KEY = 'lg_multiuser_config'

export const DEFAULT_USERS_PATH = '/GLANCE/users/'

export type UserFilter = 'all' | 'mine'

interface MultiUserConfig {
  meUserSyncId: string | null
  usersPath: string
}

function getMultiUserConfig(): MultiUserConfig {
  try {
    const raw = localStorage.getItem(MULTIUSER_CONFIG_KEY)
    if (raw) return { meUserSyncId: null, usersPath: DEFAULT_USERS_PATH, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  // Migrate from old separate keys if present
  const legacyMe = localStorage.getItem('lg_me_user_sync_id')
  const legacyPath = localStorage.getItem('lg_users_path')
  return {
    meUserSyncId: legacyMe ?? null,
    usersPath: legacyPath ?? DEFAULT_USERS_PATH,
  }
}

function saveMultiUserConfig(config: MultiUserConfig): void {
  localStorage.setItem(MULTIUSER_CONFIG_KEY, JSON.stringify(config))
}

export function getMultiUserEnabled(): boolean {
  return localStorage.getItem(MULTI_USER_ENABLED_KEY) === 'true'
}

export function setMultiUserEnabled(enabled: boolean): void {
  localStorage.setItem(MULTI_USER_ENABLED_KEY, String(enabled))
}

export function getMeUserSyncId(): string | null {
  return getMultiUserConfig().meUserSyncId
}

export function setMeUserSyncId(syncId: string | null): void {
  saveMultiUserConfig({ ...getMultiUserConfig(), meUserSyncId: syncId })
}

export function getUserFilter(): UserFilter {
  return (localStorage.getItem(USER_FILTER_KEY) as UserFilter) ?? 'all'
}

export function setUserFilter(filter: UserFilter): void {
  localStorage.setItem(USER_FILTER_KEY, filter)
}

export function getAttentionFilter(): boolean {
  return localStorage.getItem(ATTENTION_FILTER_KEY) === 'true'
}

export function setAttentionFilter(on: boolean): void {
  localStorage.setItem(ATTENTION_FILTER_KEY, String(on))
}

export function getUsersPath(): string {
  return getMultiUserConfig().usersPath
}

export function setUsersPath(path: string): void {
  saveMultiUserConfig({ ...getMultiUserConfig(), usersPath: path })
}
