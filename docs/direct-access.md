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
2. **Snapshot sync through the folder**, with the pure file cycle dayGLANCE's
   `src/sync/snapshotFileSync.js` runs: the seed guard, the first-run prompt,
   the content gate, the made-here-or-relayed rule with staggered relays, and
   the envelope rules. The cycle moves into `@glance-apps/sync` for this,
   beside the merge the apps already share.
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
bridge shape on both platforms.
