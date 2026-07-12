// Sync encryption derives keys via the Web Crypto SubtleCrypto API
// (crypto.subtle). Browsers only expose it in a *secure context* — HTTPS, or
// http://localhost / http://127.0.0.1. Over plain HTTP on a LAN IP or bare
// hostname (a common self-hosted setup) crypto.subtle is undefined, so key
// setup throws a cryptic "Cannot read properties of undefined (reading
// 'importKey')". Detect that up front so the UI can explain it instead of
// leaking the raw error. See GLANCEvault issue re: Unlock Sync.
export function isWebCryptoAvailable(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.subtle.importKey === 'function'
  )
}
