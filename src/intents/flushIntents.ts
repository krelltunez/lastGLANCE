import { outbox, type FlushResult } from './outbox'
import { webdavDeliverer, vaultDeliverer } from './deliverers'
import { reconcileDeliveryFromFlush } from './config'

// Single outbound flush entry point: drains the durable outbox using the real
// per-transport deliverers (webdav + vault; no iCloud). The outbox's in-flight
// lock makes overlapping calls safe, so every trigger can call this freely.
//
// This is the ONLY place the deliverers are wired to the outbox, keeping the
// "emit -> enqueue -> flush(deliverers)" path in one spot. It is therefore also
// the one place that folds each pass's outcome back into the Activity Log, so
// BOTH the emit-time flush and the background drain (both call this) update the
// "queued -> waiting for key -> delivered" chips without any extra wiring.
export async function flushIntents(): Promise<FlushResult> {
  const result = await outbox.flush({ webdav: webdavDeliverer, vault: vaultDeliverer })
  reconcileDeliveryFromFlush(result)
  return result
}
