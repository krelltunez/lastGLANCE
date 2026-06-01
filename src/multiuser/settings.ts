const MULTI_USER_ENABLED_KEY = 'lg_multi_user_enabled'
const ME_USER_SYNC_ID_KEY = 'lg_me_user_sync_id'
const USER_FILTER_KEY = 'lg_user_filter'

export type UserFilter = 'all' | 'mine'

export function getMultiUserEnabled(): boolean {
  return localStorage.getItem(MULTI_USER_ENABLED_KEY) === 'true'
}

export function setMultiUserEnabled(enabled: boolean): void {
  localStorage.setItem(MULTI_USER_ENABLED_KEY, String(enabled))
}

/** The sync_id of the user designated as "me" on this device. Null if not set. */
export function getMeUserSyncId(): string | null {
  return localStorage.getItem(ME_USER_SYNC_ID_KEY)
}

export function setMeUserSyncId(syncId: string | null): void {
  if (syncId === null) {
    localStorage.removeItem(ME_USER_SYNC_ID_KEY)
  } else {
    localStorage.setItem(ME_USER_SYNC_ID_KEY, syncId)
  }
}

export function getUserFilter(): UserFilter {
  return (localStorage.getItem(USER_FILTER_KEY) as UserFilter) ?? 'all'
}

export function setUserFilter(filter: UserFilter): void {
  localStorage.setItem(USER_FILTER_KEY, filter)
}
