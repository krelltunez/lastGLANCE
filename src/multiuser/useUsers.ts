import { useState, useEffect, useCallback } from 'react'
import { getUsers } from '@/db/queries'
import { getMultiUserEnabled, getMeUserSyncId, getUserFilter, setUserFilter } from './settings'
import type { UserFilter } from './settings'
import type { User } from '@/types'

export function useUsers() {
  const [multiUserEnabled] = useState(getMultiUserEnabled)
  const [users, setUsers] = useState<User[]>([])
  const [meId] = useState<string | null>(getMeUserSyncId)
  const [filter, setFilterState] = useState<UserFilter>(getUserFilter)

  const reload = useCallback(async () => {
    if (getMultiUserEnabled()) {
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

  function setFilter(f: UserFilter) {
    setUserFilter(f)
    setFilterState(f)
  }

  return { users, multiUserEnabled, meId, filter, setFilter, reload }
}
