import { createProviders } from '@glance-apps/sync'
import type { SyncEngineConfig } from '@glance-apps/sync'
import { isNativePlatform, nativeHttpFetch } from '@/sync/nativeHttp'

// createProviders only uses the transport/crypto subset of SyncEngineConfig;
// the data lifecycle callbacks are engine-only concerns.
const lastGlanceEngineConfig = {
  appFolderName: 'GLANCE/lastglance',
  syncFilename: 'lastglance-sync.json',
  cryptoDBName: 'lastglance-crypto',
  nativeHttpRequest: null,
  // On native (Capacitor) route WebDAV directly through the native HTTP stack
  // (no CORS proxy); the browser/PWA keeps using proxyUrl.
  electronProxyFetch: isNativePlatform ? nativeHttpFetch : null,
  proxyUrl: import.meta.env.VITE_WEBDAV_PROXY_URL ?? '',
  nativeGetSyncKey: null,
  nativeStoreSyncKey: null,
} as unknown as SyncEngineConfig

export const cloudSyncProviders = createProviders(lastGlanceEngineConfig)
