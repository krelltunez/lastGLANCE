# iCloud sync

Zero-config sync for the iOS app: every iPhone and iPad signed in to the same
Apple ID keeps chores and People in step through iCloud, with nothing to set
up. It is dayGLANCE's iCloud tier (`src/sync/icloudSnapshotTransport.js`,
`src/utils/icloudSyncPref.js`, `dayglance-ios/.../ICloudBridge.swift`) built on
this app's file-tier machinery, the same cycles Direct Access runs
(`docs/direct-access.md`).

## Pieces

- **The plugin**, `ios/App/App/plugins/ICloudPlugin.swift`, registered in
  `BridgeViewController`. Files by path under a container's `Documents/`, in
  one of two containers:
  - `own`, `iCloud.com.lastglance`: `lastglance-sync.json` (chores) and
    `lastglance-people.json` (People);
  - `dayglance`, `iCloud.com.dayglance`: dayGLANCE's `GLANCE/events/`, for
    intents.

  Reads answer the classification every file shell answers (absent,
  downloading, error, text), with dayGLANCE's two iCloud rules: a local copy
  is served only once it is `.current` (every read asks the daemon to
  download), and `allowStale` reads the last downloaded copy. An
  NSMetadataQuery on the two sync files posts `changed`, which runs a cycle
  at once. Snapshots are written atomically; event files in place, keeping
  the xattrs that queue the upload.
- **The bridge**, `src/native/icloud.ts`: the plugin's calls, every failure
  answered rather than thrown. iOS only; elsewhere `icloudBridge()` is null
  and nothing below runs.
- **The transport**, `src/sync/icloud.ts`: the chore file and `peopleFile`,
  each with its own seed-guard stamp (`lastglance-icloud-last-synced`,
  `lastglance-icloud-people-last-synced`). Plaintext (iCloud Drive is
  encrypted by Apple), so `encryptsWrites` is false and an envelope is
  rewritten plain (`allowsPlaintextReseed`). 15 s poll, 5 s write throttle,
  and a download stalled past `ICLOUD_DOWNLOAD_GRACE_MS` (2 min) is read from
  the last downloaded copy. Availability is re-probed every cycle, so iCloud
  switched off mid-session goes quiet and comes back by itself.
- **The hook**, `src/hooks/useSnapshotFileSync.ts`, shared with Direct Access
  (`useDirectAccessSync` is a thin wrapper): the poll, foreground and change
  kicks, the chore cycle then the People cycle, the key prompts, and the
  first-run question. One in-flight guard spans every instance, so iCloud and
  Direct Access never merge into the store at once.

## The rules

- **On by default, and a per-device switch.** The preference
  (`lastglance-icloud-sync-enabled`) is tri-state: absent means on and
  undecided, `'true'`, `'false'`. Off is inert: nothing is read or written,
  and the iCloud copy and other devices are untouched. The switch is in Cloud
  Sync (`ICloudSection.tsx`).
- **A fresh install is asked before anything is restored.** Deleting the app
  leaves the files in the container, and reinstalling turns iOS's per-app
  iCloud switch back on, so without the question the app would restore
  silently. The cycle asks (`prompted`) when the decision is open, iCloud
  holds data and this device holds none (`ICloudFirstRunModal`); either
  answer is recorded, and "start fresh" turns the switch off. A device with
  data of its own merges without asking, which is what keeps it zero-config.
- **Sample chores are not data.** A fresh install seeds sample chores with
  fixed ids and an old stamp (`isPristineSeed`); `choresHaveRealData` leaves
  them out, or a fresh install would never count as empty and the question
  would never come.
- **Both files, both stamps.** Each file's "made here" stamp is its own
  (`lastglance-local-edit-at`, `lastglance-people-local-edit-at`), and an
  apply stamps that data's WebDAV local-modified key, so a change that
  arrived through iCloud is pushed on by WebDAV too.

## Intents

`src/intents/icloudIntents.ts`, after dayGLANCE's iCloud intents: one file per
event (the package's `filenameFor`) in `GLANCE/events/` of dayGLANCE's
container, so the two apps exchange intents with nothing but iCloud. Opt-in,
off by default (Integrations, iOS only), like every intents transport. Always
plaintext: dayGLANCE's iCloud poll refuses an encrypted envelope as a
misconfigured sender, and this poll does the same. The deliverer holds while
the opt-in is off or iCloud is away; the poll (`useICloudIntents`) runs every
two minutes and on foreground, keeps its own cursor
(`lg_icloud_intents_cursor`), and stops at a file still downloading so it is
read on a later poll. dayGLANCE prunes old event files from the folder.

The household roster does not travel over iCloud.

## Apple Developer portal

Both containers must be assigned to the `com.lastglance` App ID (iCloud, with
iCloud Documents), and the provisioning profiles regenerated. The entitlements
are in `ios/App/App/App.entitlements`.

That is the **iOS bundle ID**, not the Android application ID
`com.lastglance.app`, which this page named until 2026-10 and which is not an
App ID on App Store Connect at all. The two have never matched, and the same
trap is called out in `docs/ios-native-features-plan.md` for the App Group. A
container assigned to the wrong App ID fails the way everything else on this
page fails: silently, with every read looking like a fresh install.

## Tests

- `src/sync/icloud.test.ts`: the preference, real data, the transport,
  the bridge.
- `src/sync/icloudSync.scenarios.test.ts`: an iPhone and an iPad over one
  container (silent merge, the first-run question, restore, start fresh, a
  People-only question, an edit crossing).
- `src/intents/icloudIntents.test.ts`: the deliverer and the poll.
- `src/native/icloudIosParity.test.ts`: the Swift plugin against the bridge,
  the entitlements and the Xcode project, since CI does not compile Swift.
