// Direct Access INTENTS opt-in gate (docs/direct-access.md, step 3).
//
// A single persisted boolean, default FALSE, independent of the Direct Access
// SYNC switch and of the WebDAV and GLANCEvault intents transports. The intents
// path (emitting to the event-set file and polling it) is active only when the
// user flipped this on AND a folder is connected on this device. Without the
// opt-in the path is fully inert.

import { directAccessTransport, type DirectAccessTransport } from '@/sync/directAccess'

export const DIRECT_ACCESS_INTENTS_ENABLED_KEY = 'lg_direct_access_intents_enabled'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
const defaultStorage = (): StorageLike => (typeof localStorage === 'undefined' ? null : localStorage)

/** The raw opt-in flag, independent of the connection. */
export function getDirectAccessIntentsEnabledFlag(storage: StorageLike = defaultStorage()): boolean {
  try { return storage?.getItem(DIRECT_ACCESS_INTENTS_ENABLED_KEY) === 'true' } catch { return false }
}

/** Persist the opt-in flag. Removes the key when disabling. */
export function setDirectAccessIntentsEnabled(enabled: boolean, storage: StorageLike = defaultStorage()): void {
  try {
    if (enabled) storage?.setItem(DIRECT_ACCESS_INTENTS_ENABLED_KEY, 'true')
    else storage?.removeItem(DIRECT_ACCESS_INTENTS_ENABLED_KEY)
  } catch { /* private mode / quota */ }
}

/**
 * True only when the user opted in AND a folder is connected on this device
 * (connected or temporarily unreachable: the deliverer holds while it is
 * away). Both the emit target and the poller are gated on this.
 */
export function isDirectAccessIntentsEnabled(transport: DirectAccessTransport = directAccessTransport): boolean {
  if (!getDirectAccessIntentsEnabledFlag()) return false
  if (!transport.isSupported()) return false
  return transport.isConnected()
}
