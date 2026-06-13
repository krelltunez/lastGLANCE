# Phase 4 Testing: GLANCEvault database transport

This document covers manual verification of the GLANCEvault (DB) sync transport
that was wired into lastGLANCE in Phase 4. The transport is additive and
reversible: it runs alongside the existing file tier (WebDAV) engine and is
gated entirely by the vault config. With the vault disabled, the app behaves
exactly as before.

## What is automated

The unit tests (run with `npm test`) cover the parts that do not need a live
vault:

1. `getDeviceId` returns a stable UUID across calls and generates a fresh one
   when none is stored (`src/sync/deviceId.test.ts`).
2. `getLocalEntity` looks up entities across all four Dexie tables
   (categories, chores, completionEvents, users) by `sync_id` and returns the
   camelCase sync shape, including resolving a completion event's `choreSyncId`
   (`src/sync/dbEngine.test.ts`).
3. `isInsertOnly` returns true only for completion events
   (`src/sync/dbEngine.test.ts`).
4. `getEntityLastModified` returns `updatedAt` for categories, chores, and
   users, and `completedAt` for completion events (`src/sync/dbEngine.test.ts`).
5. The vault config is saved to and loaded from localStorage, treats
   disabled/incomplete configs as not enabled, and tolerates malformed JSON
   (`src/sync/vaultConfig.test.ts`).

## What needs a running GLANCEvault

Entity push, pull, per entity encryption, salt registration, and the device
cursor cannot be exercised without a live vault. Use the steps below against a
running GLANCEvault instance.

### Prerequisites

- A running GLANCEvault instance reachable from the browser (its URL).
- A device bearer token and a household account id provisioned in the vault.
- Two browsers or profiles (call them Device A and Device B) so you can observe
  cross device sync.

### 1. Enable the vault on Device A

1. Open lastGLANCE, open the Cloud Sync settings (the cloud icon, or press `s`).
2. Scroll to the "GLANCEvault (beta)" section and turn the toggle on.
3. Fill in:
   - Vault URL, for example `https://vault.glance-apps.com`
   - Device token (the bearer token)
   - Account ID (the household account id)
4. Make sure encryption is enabled and that you have set your sync passphrase
   (the DB transport derives its root key from the same passphrase as the file
   tier). If you have not set a passphrase yet, enable encryption in the
   Encryption section and choose one.
5. Close the settings modal. The app reloads to construct the DB engine.

### 2. Make a change and confirm it reaches the vault

1. After the reload, create or complete a chore (any local write: add a
   category, add a chore, log a completion, rename a user).
2. The change is marked dirty and pushed on the next DB sync cycle (which fires
   on load, on tab focus, and every 5 minutes). To force it immediately, switch
   to another tab and back, or wait for the interval.
3. Verify the row landed in the vault:

   ```
   curl -s \
     -H "Authorization: Bearer $VAULT_TOKEN" \
     "$VAULT_URL/sync/lastglance/list?accountId=$ACCOUNT_ID&since=0"
   ```

   You should see one row per changed entity, each with an `entityId` matching
   the entity's `sync_id`, a `seq`, and an opaque `ciphertext` (the data is
   encrypted per entity, so the body is not human readable). Deletions appear as
   rows with `deleted: true`.

### 3. Sync back to a second device

1. On Device B, enable the vault with the SAME Vault URL, account id, and a
   device token for that device, and enter the SAME sync passphrase.
2. Close settings (the app reloads). On the next DB sync cycle Device B pulls
   from `since = 0` and applies the remote rows.
3. Confirm the entity you created on Device A now appears on Device B.
4. Make a change on Device B (for example rename the chore), let it push, then
   switch back to Device A and confirm the change syncs in. This exercises the
   entity grain last writer wins path (`updatedAt` / `completedAt` decides the
   winner).

### 4. Verify deletions propagate

1. Delete a chore on Device A. This writes a local tombstone and marks the
   entity dirty; because the row no longer exists locally, the push sends a soft
   delete to the vault.
2. Confirm with the `list` curl above that the entity now shows `deleted: true`.
3. On Device B, after the next cycle, confirm the chore is gone.

### 5. Confirm the file tier is unaffected

1. Keep WebDAV sync configured as well. Make a change and confirm it still syncs
   over WebDAV exactly as before (check the sync folder file timestamp).
2. Turn the GLANCEvault toggle off and close settings (the app reloads). Confirm
   the app reverts to file only sync with no errors. Re-enabling restores DB
   sync.

## Notes and limitations

- Completion events are insert only in both transports: an edited note does not
  overwrite an event that already exists on another device. This matches the
  file tier behavior.
- The DB engine never reads or writes the WebDAV sync file; the two transports
  share only the local Dexie data and the sync passphrase.
- The `meUserSyncId` device identity is never synced by either transport; it is
  not part of any entity's sync shape.
