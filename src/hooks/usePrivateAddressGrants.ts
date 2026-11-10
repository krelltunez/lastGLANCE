import { useCallback, useEffect, useState } from 'react'
import { desktopBridge, type DesktopHttpGrant } from '@/native/desktop'

/** The origins this desktop may reach on a private network, from the main process. */
export function usePrivateAddressGrants() {
  const http = desktopBridge()?.http ?? null
  const [grants, setGrants] = useState<DesktopHttpGrant[]>([])

  const refresh = useCallback(async () => {
    if (!http) return
    try {
      setGrants(await http.grants())
    } catch {
      // The list is informational; the next refresh shows the truth.
    }
  }, [http])

  const revoke = useCallback(async (origin: string) => {
    if (!http) return
    try {
      await http.revoke(origin)
    } finally {
      await refresh()
    }
  }, [http, refresh])

  useEffect(() => { void refresh() }, [refresh])

  return { supported: http !== null, grants, refresh, revoke }
}
