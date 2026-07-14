/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WEBDAV_PROXY_URL?: string
  readonly VITE_WEBDAV_DIRECT?: string
  // Distribution channel, set per artifact by build-android.sh: 'play' (gated
  // AAB), 'github' (ungated sideload APK); unset/'web' for web/PWA builds.
  readonly VITE_BUILD_CHANNEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string
