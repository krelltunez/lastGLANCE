import { createContext, useContext } from 'react'
import type { User } from '@/types'
import type { UserFilter } from './settings'

interface UsersContextValue {
  users: User[]
  multiUserEnabled: boolean
  meId: string | null
  filter: UserFilter
  setFilter: (f: UserFilter) => void
  reload: () => void
}

export const UsersContext = createContext<UsersContextValue>({
  users: [],
  multiUserEnabled: false,
  meId: null,
  filter: 'all',
  setFilter: () => {},
  reload: () => {},
})

export function useUsersContext() {
  return useContext(UsersContext)
}
