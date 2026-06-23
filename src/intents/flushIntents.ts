import { outbox } from './outbox'
import { webdavDeliverer, vaultDeliverer } from './deliverers'

// Single outbound flush entry point: drains the durable outbox using the real
// per-transport deliverers (webdav + vault; no iCloud). The outbox's in-flight
// lock makes overlapping calls safe, so every trigger can call this freely.
//
// This is the ONLY place the deliverers are wired to the outbox, keeping the
// "emit -> enqueue -> flush(deliverers)" path in one spot.
export function flushIntents(): Promise<void> {
  return outbox.flush({ webdav: webdavDeliverer, vault: vaultDeliverer })
}
