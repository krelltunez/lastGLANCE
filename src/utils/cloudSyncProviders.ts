import { createProviders } from '@glance-apps/sync'
import type { SyncEngineConfig } from '@glance-apps/sync'
import { browserDirectFetch, isNativePlatform, nativeHttpFetch, webdavDirect } from '@/sync/nativeHttp'

// createProviders only uses the transport/crypto subset of SyncEngineConfig;
// the data lifecycle callbacks are engine-only concerns.
const lastGlanceEngineConfig = {
  appFolderName: 'GLANCE/lastglance',
  syncFilename: 'lastglance-sync.json',
  cryptoDBName: 'lastglance-crypto',
  nativeHttpRequest: null,
  // On native (Capacitor) route WebDAV directly through the native HTTP stack
  // (no CORS proxy). In the browser/PWA use a direct fetch when VITE_WEBDAV_DIRECT
  // is enabled; otherwise fall back to proxyUrl. electronProxyFetch takes
  // priority over proxyUrl in the engine, so a null here keeps the proxy path.
  electronProxyFetch: isNativePlatform ? nativeHttpFetch : webdavDirect ? browserDirectFetch : null,
  proxyUrl: import.meta.env.VITE_WEBDAV_PROXY_URL ?? '',
  nativeGetSyncKey: null,
  nativeStoreSyncKey: null,
} as unknown as SyncEngineConfig

export const cloudSyncProviders = createProviders(lastGlanceEngineConfig)
