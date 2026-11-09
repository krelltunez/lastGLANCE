// Whether any outbound intents transport is on: the one question behind the
// send-to-dayGLANCE buttons, the notification action and the emit targets.
// Four transports, four independent switches (docs/direct-access.md,
// docs/icloud-sync.md): the WebDAV intents config, the GLANCEvault opt-in, the
// Direct Access opt-in, which also needs a folder connected on this device, and
// the iCloud opt-in, which also needs the iOS plugin. Gating on a subset of
// them hid the buttons for setups that used only the one left out, three
// times (the third was iCloud). The type is keyed by the outbox's
// TransportName, so a new transport does not compile until it is listed here,
// and intentsAvailable.test.ts checks this against the emitter's targets.

import { getIntentsConfig, isIntentsConfigured } from './config'
import { isDbIntentsEnabled } from './dbConfig'
import { getDirectAccessIntentsEnabledFlag } from './directAccessIntentsConfig'
import { isICloudIntentsEnabled } from './icloudIntents'
import type { TransportName } from './outbox'
import { directAccessTransport, type DirectAccessSnapshot } from '@/sync/directAccess'

/** One switch per outbox transport; the emitter's enabledIntentTargets covers the same set. */
export type IntentsTransportsOn = Record<TransportName, boolean>

/** Pure: is at least one transport on. */
export const anyIntentsTransportOn = (on: IntentsTransportsOn): boolean => Object.values(on).some(Boolean)

/**
 * The four switches as they stand. `directAccess` takes the transport's
 * snapshot so a React caller can pass the one it subscribes to; the status is
 * 'unknown' until the shell has restored the folder, so a caller that reads
 * it once at mount sees no folder and has to re-read when it connects.
 */
export function intentsTransportsOn(directAccess: Pick<DirectAccessSnapshot, 'supported' | 'connected'> = directAccessTransport.getSnapshot()): IntentsTransportsOn {
  return {
    webdav: isIntentsConfigured(getIntentsConfig()),
    vault: isDbIntentsEnabled(),
    directAccess: getDirectAccessIntentsEnabledFlag() && directAccess.supported && directAccess.connected,
    icloud: isICloudIntentsEnabled(),
  }
}
