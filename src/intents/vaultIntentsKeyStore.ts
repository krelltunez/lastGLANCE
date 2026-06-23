// Vault-slot intents root-key store.
//
// This is DELIBERATELY SEPARATE from the WebDAV intents key store
// (src/intents/intentsKeyStore.ts). The two transports derive DIFFERENT root
// keys from DIFFERENT salts — the WebDAV key uses the salt file in the WebDAV
// folder, while the vault key uses the GLANCEvault /salt/:accountId salt — so
// their cached keys must never collide. They therefore live in distinct
// IndexedDB databases.
//
// Stage 2a only READS this slot (the vault deliverer loads an already-cached
// key, or returns transient when absent). Stage 2b owns populating it
// (deriveIntentsRootKey(syncPassphrase, vaultSalt) -> storeVaultIntentsRootKey)
// inside the vault-intents enable flow.

const DB_NAME = 'lastglance-vault-intents-crypto'
const STORE_NAME = 'keys'
const ROOT_KEY_ID = 'root-key'

let _cachedRootKey: CryptoKey | null = null

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function storeVaultIntentsRootKey(key: CryptoKey): Promise<void> {
  _cachedRootKey = key
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const req = tx.objectStore(STORE_NAME).put(key, ROOT_KEY_ID)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}

// Loads the vault intents root key from its dedicated slot, or null when no key
// has been cached on this device yet. The vault deliverer treats null as a
// transient failure (the key is set up by the 2b enable flow).
export async function loadVaultIntentsRootKey(): Promise<CryptoKey | null> {
  if (_cachedRootKey !== null) return _cachedRootKey
  let db: IDBDatabase
  try {
    db = await openDB()
  } catch {
    return null
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(ROOT_KEY_ID)
    req.onsuccess = () => {
      const key = (req.result as CryptoKey | undefined) ?? null
      _cachedRootKey = key
      resolve(key)
    }
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}

export async function clearVaultIntentsRootKey(): Promise<void> {
  _cachedRootKey = null
  let db: IDBDatabase
  try {
    db = await openDB()
  } catch {
    return
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const req = tx.objectStore(STORE_NAME).delete(ROOT_KEY_ID)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}

// Test-only: drop the in-memory cache so a test can simulate a fresh process
// without tearing down the IndexedDB database.
export function __resetVaultIntentsKeyCacheForTests(): void {
  _cachedRootKey = null
}
