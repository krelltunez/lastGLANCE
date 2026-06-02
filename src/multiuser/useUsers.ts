import { useState, useEffect, useCallback, useMemo } from 'react'
import { getUsers } from '@/db/queries'
import { getMultiUserEnabled, getMeUserSyncId, getUserFilter, setUserFilter } from './settings'
import type { UserFilter } from './settings'
import type { User } from '@/types'

export function useUsers() {
  const [multiUserEnabled, setMultiUserEnabledState] = useState(getMultiUserEnabled)
  const [users, setUsers] = useState<User[]>([])
  const [meId, setMeId] = useState<string | null>(getMeUserSyncId)
  const [filter, setFilterState] = useState<UserFilter>(getUserFilter)

  const reload = useCallback(async () => {
    const enabled = getMultiUserEnabled()
    setMultiUserEnabledState(enabled)
    setMeId(getMeUserSyncId())
    if (enabled) {
      setUsers(await getUsers())
    } else {
      setUsers([])
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    window.addEventListener('lg:sync-applied', reload)
    return () => window.removeEventListener('lg:sync-applied', reload)
  }, [reload])

  const setFilter = useCallback((f: UserFilter) => {
    setUserFilter(f)
    setFilterState(f)
  }, [])

  return useMemo(
    () => ({ users, multiUserEnabled, meId, filter, setFilter, reload }),
    [users, multiUserEnabled, meId, filter, setFilter, reload]
  )
}
