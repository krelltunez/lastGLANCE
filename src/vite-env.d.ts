/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WEBDAV_PROXY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string
