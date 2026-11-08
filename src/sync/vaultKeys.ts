// The vault keys this device keeps between launches, and the one way to drop them.
//
// Two keys derive from the sync passphrase and the account's salt on the vault:
//   - the sync root key (`@glance-apps/sync`'s DB tier, DB_CRYPTO_CONFIG). It is
//     ONE key shared by every vault engine: chores (lastglance), People
//     (lastglance-people) and the roster (glance-users) all read the same slot.
//   - the vault intents key (src/intents/vaultIntentsKeyStore.ts).
//
// Both are cached so the passphrase is entered once, and restored on every
// launch before the passphrase is ever asked for (App.tsx, initDbRootKey). So a
// cached key that is WRONG for the account (derived from another account's salt,
// a vault database that was since recreated, or a mistyped passphrase) is used
// on every launch, and entering the right passphrase later changes nothing: the
// engines never re-derive while a key is cached. The account's key check then
// fails with KEY_MISMATCH until the key is dropped. Clearing site data drops it
// too, along with everything else the browser holds; this drops only the keys.
//
// After a clear the app must reload: each engine latches its key check once
// verified, and a fresh key must be checked again before anything is pushed.
// On the reload App.tsx finds no key and asks for the passphrase; the intents
// key is re-derived from it by ensureVaultIntentsKey on the next poll.

import { clearDbRootKey } from '@glance-apps/sync'
import { clearVaultIntentsRootKey } from '@/intents/vaultIntentsKeyStore'
import { DB_CRYPTO_CONFIG } from './engine'

export async function clearCachedVaultKeys(): Promise<void> {
  await clearDbRootKey(DB_CRYPTO_CONFIG).catch(() => { /* nothing cached */ })
  await clearVaultIntentsRootKey().catch(() => { /* nothing cached */ })
}
