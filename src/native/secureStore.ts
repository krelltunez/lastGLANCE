import { registerPlugin } from '@capacitor/core'
import { isNativeShell } from './platform'
import { headlessBridge } from '@/headless/headlessMode'
import { desktopBridge } from './desktop'

// Native bridge to hardware-backed secret storage (issue #210), so secrets are
// no longer plaintext-at-rest in WebView storage. Both shells implement the
// same three-method interface with the same contract — material that cannot be
// read on THIS device reports as absent, and the app falls back to asking for
// credentials again:
//  - Android (SecureStorePlugin.java): AES-GCM ciphertext in private prefs,
//    key in the Android Keystore.
//  - iOS (SecureStorePlugin.swift): Keychain items stored with
//    AfterFirstUnlockThisDeviceOnly, encrypted under device-bound keys.
// On web/PWA callers keep their existing storage.
export interface SecureStorePlugin {
  // Resolve the stored value, or null when absent or undecryptable.
  get(options: { key: string }): Promise<{ value: string | null }>
  set(options: { key: string; value: string }): Promise<void>
  delete(options: { key: string }): Promise<void>
}

const SecureStore = registerPlugin<SecureStorePlugin>('SecureStore')

// The shim and key hooks must only engage where the plugin exists — anywhere
// else the fallback is the status quo (localStorage / IndexedDB). A headless
// refresh has no Capacitor bridge but reads the same Keystore-backed store
// through the shell's HeadlessBridge (src/headless/headlessMode.ts). The
// desktop app keeps the same contract over Electron's safeStorage
// (electron/secureStore.ts) where the OS protects it (not on Linux without a
// keyring).
const desktopStore = (): SecureStorePlugin | null => {
  const desktop = desktopBridge()
  return desktop?.info.secureStorage ? desktop.secureStore : null
}

export const isSecureStoreAvailable = isNativeShell() || headlessBridge() !== null || desktopStore() !== null

// The store behind the Capacitor plugin: the desktop's when there is one.
const store = (): SecureStorePlugin => desktopStore() ?? SecureStore

export async function secureGet(key: string): Promise<string | null> {
  const headless = headlessBridge()
  if (headless) return (JSON.parse(headless.secureGet(key)) as { value?: string | null }).value ?? null
  const res = await store().get({ key })
  return res.value ?? null
}

export async function secureSet(key: string, value: string): Promise<void> {
  const headless = headlessBridge()
  if (headless) {
    if (!headless.secureSet(key, value)) throw new Error('secure write failed')
    return
  }
  await store().set({ key, value })
}

export async function secureDelete(key: string): Promise<void> {
  const headless = headlessBridge()
  if (headless) {
    headless.secureDelete(key)
    return
  }
  await store().delete({ key })
}
