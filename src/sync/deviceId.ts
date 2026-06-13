// Stable per-device identifier for the GLANCEvault DB sync transport.
//
// The DB engine uses this to maintain its device cursor on the vault (so the
// server can track which seq each device has seen for tombstone GC). It is
// generated once on first use and then persisted for the lifetime of the
// installation. It is never synced and never changes.

const DEVICE_ID_KEY = 'lastglance-device-id'

// Returns the stable device id, generating and persisting one on first call.
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}
