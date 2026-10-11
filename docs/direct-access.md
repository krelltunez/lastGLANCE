# Direct Access sync

Sync through a folder a third-party tool already keeps in step across devices
(Nextcloud, Syncthing, FolderSync, Google Drive, Dropbox, OneDrive): lastGLANCE
reads and writes one file there, and the tool moves it. The design is
dayGLANCE's `docs/direct-access-sync.md`; this tier is its Phase 7b, built
in the order that document gives, so the same folder carries all three apps:

1. **The folder bridge (this page).** `DirectAccessPlugin` on both shells,
   behind `src/native/directAccess.ts`, which hands the transport the same
   bridge shape dayGLANCE's shells produce. Android holds a folder (a SAF tree
   with a persistable grant, walked with DocumentFile; crash-safe writes
   through `SafeReplace`; paths confined by `DirectAccessPath`). iOS holds
   files, one security-scoped bookmark each for the snapshot
   (`lastglance-sync.json`), the household roster (`glance-users.json`) and the
   intents event set (`glance-events.json`), because the Files providers of
   the common cloud tools cannot hand an app a folder (Apple FB9703910). The
   read classification is the one every shell answers: `absent` only when the
   folder is there and the file is not; a zero-length file is `downloading`,
   never absent; a vanished folder or revoked grant is `error`. Web/PWA has no
   plugin and no tier.
2. **Snapshot sync through the folder (done).** `@glance-apps/sync` 2.1.0's
   `runSnapshotFileCycle` (the cycle dayGLANCE's iCloud and Direct Access
   tiers run: the seed guard, the content gate, the made-here-or-relayed rule
   with staggered relays, the envelope rules) over `src/sync/directAccess.ts`,
   the transport. `src/sync/directAccessCycle.ts` fills in what is this
   app's: the payload is built from Dexie before the cycle, the apply is the
   WebDAV tier's `applyPayload` and is awaited, chores + categories +
   completion events count as data, and the two device-local stamps are the
   WebDAV engine's local-modified key (so a change that arrived through the
   folder is pushed on by WebDAV) and `lastglance-local-edit-at`, which the
   data layer sets on every write of its own through `dirtyTracker.markDirty`
   and no apply ever touches. `hooks/useDirectAccessSync.ts` owns the 15 s
   poll, the foreground kick, the in-flight guard and the prompts; the
   section in the Cloud Sync dialog (`DirectAccessSection.tsx`) connects the
   folder (Android) or the file (iOS), with the per-device on/off and encrypt
   switches, "Sync now" and the last-synced stamp. Picking is the decision,
   so there is no first-run prompt; an encrypted file this device cannot
   read is never written over; a device without the key tries its cached key
   once, then raises the passphrase prompt the other tiers use.
3. **The roster and the intents transport.** The roster is Phase 5's
   `GLANCE/users/glance-users.json`, the same file WebDAV uses; the intents
   transport is Phase 7's single event-set file `GLANCE/events/glance-events.json`,
   a union keyed by `event_id` with a sender ledger and a cursor per transport.
   Both are app-independent by construction: this app adds its own switch,
   its own cursor key and its own sender ledger.

## The plugin contract

Every method answers JSON shapes, promise-based (Capacitor):

| method | answer |
| --- | --- |
| `status()` (and on iOS `usersStatus()`, `eventsStatus()`) | `{ configured, name, path, reachable }` |
| `pickFolder()` (Android) | the status after the pick, or `{ cancelled: true }` |
| `pickFile({slot})`, `createFile({slot})` (iOS) | the status with `slot`, `{ cancelled: true }`, or a rejection naming why (a wrong file, a bookmark failure, with `data.path`) |
| `read()` (and `readUsers()`, `readEvents()`) | `{ kind: absent \| downloading \| error \| text, text?, error? }` |
| `write({text})` (and `writeUsers`, `writeEvents`) | `{ ok }` |
| `deleteFile()` | `{ ok }`; on iOS the bookmark is forgotten with the file |
| `disconnect()`, `forgetUsers()`, `forgetEvents()` | `{}` |
| `listFiles({rel})` (Android) | `{ names: [...] \| null }`; null when the path escapes the folder or the folder is unusable |
| `readFile({rel})`, `writeFile({rel,text})`, `deleteFileAt({rel})`, `makeDir({rel})` (Android) | as above, by path |

The JVM tests pin the confinement rule (`DirectAccessPathTest`), every branch
of the read classification (`DirectAccessReadTest`) and every crash window of
the write (`SafeReplaceTest`); `src/native/directAccess.test.ts` pins the
bridge shape on both platforms; `src/sync/directAccess.test.ts` the transport's
state machine over a fake bridge; `src/sync/directAccessCycle.test.ts` two
devices over one folder through the real package cycle and the real merge
(seed, apply, an edit made here written at once, a relayed change deferred
and staggered, the envelope rules, a device without the key held).

## Storage keys

| key | holds |
| --- | --- |
| `lastglance-direct-access-enabled` | `'true'` / `'false'` / absent (absent is on once connected) |
| `lastglance-direct-access-encrypt` | `'true'` when this device seeds or upgrades the file as an envelope |
| `lastglance-direct-access-last-synced` | stamped on every read of a real snapshot; the seed guard's "has synced before" |
| `lastglance-direct-access-last-synced:writers` | the `writtenBy` ids seen in the file header; ranks this device's relay wait |
| `lastglance-local-edit-at` | when this device itself last changed its data |
| `lastglance_direct_access` (shell preferences) | the Android tree URI / the iOS bookmarks |
