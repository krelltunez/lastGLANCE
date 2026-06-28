# GLANCEvault credential entry & connection setup — reference for lifeGLANCE

A read-only, implementation-level explainer of how **lastGLANCE** lets a user
enter GLANCEvault credentials, verifies them, and activates vault sync. Written
so the same flow can be rebuilt in lifeGLANCE's own settings UI and get the
verification + activation ordering right the first time.

All `file:line` references are to lastGLANCE at the time of writing. Nothing in
the codebase was changed to produce this doc.

> **Read this first — the single most important takeaway.** lastGLANCE does
> **not** have a dedicated "Test vault connection" button. The WebDAV tier has
> one; the vault tier does not. Credential validity is proven *implicitly* by
> the first sync cycle / `ensureRootKey()` after a reload, and failures surface
> only through the engine's `onError` callback. That gap — "credentials save,
> reload happens, sync silently does nothing, no obvious error" — was the core
> pain point. The one place lastGLANCE *does* verify against the server before
> committing is the **intents** path (`getSalt()` in
> `setupVaultIntentsEncryption.ts`). **lifeGLANCE should generalize that
> `getSalt` verification into the credential-entry step itself**, so the vault
> URL + token + account are proven valid *before* save/activate, not after.

---

## 1. Where the credentials are entered

**One modal, stacked sections — not a separate screen and not a tier toggle.**

Everything lives in `src/components/SyncSettingsModal/SyncSettingsModal.tsx`
(opened via the cloud icon / `s` key). The modal renders, top to bottom, five
independent sections in one scroll body:

1. **WebDAV Connection** (`t('sync.webdavConnection')`) — provider select,
   credential fields, folder, an enable toggle, a **Test connection** button and
   a **Sync now** button — `SyncSettingsModal.tsx:291-412`.
2. **Encryption** — the sync passphrase setup (shared by both tiers; see §5) —
   `:414-495`.
3. **Remote backups** — `:497-523`.
4. **GLANCEvault (beta)** — the vault credential entry — `:525-641`.
5. Footer "Save & close" button — `:645-653`.

So the WebDAV tier and the vault tier are **two sections of the same modal**,
each with its own enable toggle. They are *additive and coexist* — there is no
"switch between tiers" control. The vault section header literally carries a
beta/experimental warning (`:530-532`):

```tsx
<h3 …>GLANCEvault (beta)</h3>
<p …>⚠️ Experimental. Requires a self-hosted GLANCEvault server. Not
  recommended for most users.</p>
```

The vault credential fields are only revealed once its toggle is on
(`{vaultEnabled && ( … fields … )}`, `:551-596`).

**lifeGLANCE adaptation:** the "same modal, separate section, independent
toggle, coexists with the existing tier" shape is the correct general pattern.
The component name, the beta warning copy, and the exact Tailwind classes are
lastGLANCE-specific.

---

## 2. What the user enters, and what gets persisted

### The three fields (all user-entered; nothing is derived or generated)

`SyncSettingsModal.tsx:551-591`:

| UI label (literal)         | State var        | Input type | Placeholder                  |
| -------------------------- | ---------------- | ---------- | ---------------------------- |
| `Vault URL`                | `vaultUrl`       | `text`     | `https://vault.glance-apps.com` |
| `Device token`             | `vaultToken`     | `password` | `Bearer token`               |
| `Account ID`               | `vaultAccountId` | `text`     | `Household account id`       |

The **accountId is entered by the user**, not derived, generated, or
auto-discovered. It is the household account id that was provisioned in the
vault server out-of-band (see `PHASE4_TESTING.md:36-39`: "A device bearer token
and a household account id provisioned in the vault"). The device token is
likewise a pre-provisioned per-device bearer token. There are **no defaults** —
the placeholder URL is illustrative only.

### Where it's persisted — the config the sync engine reads

`src/sync/vaultConfig.ts` owns the whole contract:

```ts
const VAULT_CONFIG_KEY = 'lastglance-vault-config'         // :9

export interface VaultConfig {                             // :11-16
  enabled: boolean
  vaultUrl: string    // e.g. https://vault.glance-apps.com
  vaultToken: string  // device bearer token
  accountId: string   // household account id
}
```

- `getVaultConfig()` (`:19-33`) reads/parses the localStorage JSON, defaulting
  every field so a partial/corrupt blob never throws.
- `setVaultConfig(config | null)` (`:36-39`) writes the JSON, or **removes the
  key entirely when passed `null`** (this is the "revert to file tier" path).
- `isVaultEnabled()` (`:42-45`) is the gate the engine factory uses — it is true
  **only when `enabled && vaultUrl && vaultToken && accountId` are all truthy**.
  A toggle-on with a blank field does *not* count as enabled.

This config is **deliberately separate** from the WebDAV/file-tier config
(`vaultConfig.ts:1-7`): the file tier lives under `SYNC_FOLDER_KEY` + the engine
config; the vault lives under `lastglance-vault-config`. Clearing the vault
config reverts to file-only behavior instantly.

The values flow into the engine in `src/sync/dbEngine.ts:471-492`
(`createDbEngine`), which reads `getVaultConfig()` and passes
`vaultUrl / vaultToken / accountId` straight into `createDbSyncEngine({...})`.
The intents transport reads the *same* config via `getConn()`
(`src/intents/dbTransport.ts:50-54`) — so both the DB-row sync and the intents
channel share one credential blob.

**lifeGLANCE adaptation:** keep the same logical shape
(`{ enabled, vaultUrl, vaultToken, accountId }`) and the same "all-four-truthy"
gate. The storage key name (`lastglance-vault-config`), the `lastglance` app id,
and "localStorage" as the medium are lastGLANCE-specific — lifeGLANCE already
reads `vaultUrl/vaultToken/accountId` from its own cloud-sync config, so map
these three fields onto that and reuse its enable flag.

---

## 3. Connection test / verification — the part you most want

### What lastGLANCE actually does (and the honest gap)

**The vault section has no pre-save test.** Look at the buttons rendered in the
vault block: the only action button is **Sync now** (`:598-621`,
`handleVaultSyncNow`). Compare the WebDAV block, which *does* have a real test
button wired to `engine.test()` (`:371-378`, `handleTest` at `:126-142`).

So in lastGLANCE the credentials are **saved first, the app reloads, the engine
is constructed, and the first sync cycle is what actually exercises the URL +
token + account**. Verification is a *side effect of the first sync*, not a
gate before save.

### How a failure is surfaced (the swallow-and-surface pattern)

Both engines **swallow** sync errors — they resolve their promise either way and
only advance the stored "last synced" timestamp on success. The modal exploits
exactly that to decide success vs failure (`SyncSettingsModal.tsx:188-242`):

```ts
// handleVaultSyncNow — :220-242
const before = dbEngine.getLastSynced()
try {
  await dbEngine.dbSyncCycle()
} catch (err) { /* the few paths that DO throw */ setVaultSyncResult('error'); … return }
const after = dbEngine.getLastSynced()
if (after && after !== before) { setVaultLastSynced(after); setVaultSyncResult('ok') }
else                            { setVaultSyncResult('error') }       // resolved-but-unchanged == failure
```

The *reason* for the failure comes from the engine's `onError` callback, which
is threaded down from `App.tsx` as `vaultSyncError` / `vaultSyncErrorCode` props
(`SyncSettingsModal.tsx:19-24`, `App.tsx:251-268`). It is localized at render
time via `syncErrorText(t, message, code)`
(`src/sync/syncErrorText.ts:26-34`): if a typed code is present it looks up
`sync.errors.<CODE>`, else it shows the raw English message.

### The error codes it distinguishes

`App.tsx:251-277` wires the DB engine's `onError(msg, code)` and special-cases
one code, storing the rest:

```ts
const dbEngine = createDbEngine({
  onError: (msg, code) => {
    if (code === 'PASSPHRASE_REQUIRED') {       // :255-260
      setVaultSyncError(null); setVaultSyncErrorCode(null)
      setShowPassphrase(true)                   // prompt, NOT an error
      return
    }
    setVaultSyncError(msg)                       // :265-267
    setVaultSyncErrorCode(code)
    if (msg) console.warn('[lastglance] vault sync error:', code ?? '(no code)', msg)
  },
  onRowsSkipped: (count) => { … },               // per-row decrypt quarantine
})
```

The typed codes and their user-facing strings live in
`public/locales/en/translation.json:277-294` (`sync.errors.*`). The ones that
map onto vault failure modes:

| Code                    | Meaning / failure mode                                                  | English text                                                       |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `PASSPHRASE_REQUIRED`   | No encryption key cached → prompt, not a failure                        | (intercepted; shows the passphrase modal)                          |
| `AUTH_FAILURE`          | Bad token / sign-in failed                                              | "Sign-in failed. Check your username and password."                |
| `FORBIDDEN`             | Token valid but not allowed for this account                           | "The sync server refused access. Check your account's permissions." |
| `NETWORK_ERROR`         | Server unreachable / bad URL / offline                                  | "Couldn't reach the sync server. Check your connection…"           |
| `KEY_MISMATCH`          | Wrong sync passphrase vs other devices                                  | "Wrong sync passphrase — it must exactly match…"                   |
| `ROW_DECRYPT_FAILED`    | Some rows undecryptable (per-row quarantine, see below)                 | "Some synced data couldn't be decrypted. Check your passphrase."   |
| `VERIFIER_UNSUPPORTED`  | Vault server too old to support key verification                        | "Your sync server needs to be updated to support key verification." |
| `ACCOUNT_ID_REQUIRED`   | **Salt not yet established / setup still finishing — retryable**        | "Finishing sync setup — try again in a moment."                    |

Note the comment at `App.tsx:261-264`: a wrong key **fails fast and uploads
nothing**, so a bad passphrase never pollutes the account; and
`ACCOUNT_ID_REQUIRED` is explicitly the *retryable* "not ready yet" state.

### The one place lastGLANCE DOES verify against the server first

The **intents** key setup is the model to copy. In
`src/intents/setupVaultIntentsEncryption.ts:65-82`:

```ts
export async function setupVaultIntentsEncryption(passphrase: string): Promise<void> {
  const conn = getConn()
  if (!conn) throw new VaultConnMissingError()              // url/token/account absent

  const client = createVaultClient({ vaultUrl: conn.vaultUrl, vaultToken: conn.vaultToken, fetchImpl: vaultFetchImpl() })

  const salt = await client.getSalt(conn.accountId)         // ← the real round-trip
  if (!salt) throw new VaultSaltMissingError()              // server reachable, but no salt for this account yet

  const rootKey = await deriveIntentsRootKey(passphrase, new Uint8Array(salt))
  await storeVaultIntentsRootKey(rootKey)                   // only cached on success
}
```

This is a genuine credential probe: `GET {vaultUrl}/salt/:accountId` with the
device token. It distinguishes **two named failures** —
`VaultConnMissingError` (credentials not entered) and `VaultSaltMissingError`
(server reachable + token accepted, but no salt registered for that account yet,
i.e. the account hasn't been bootstrapped by a first sync) — plus a raw network
error if the request itself fails (`setupVaultIntentsEncryption.ts:18-35,
60-82`). Crucially it **caches nothing on failure** — the caller must not enable
the feature unless this resolves.

The enable-time orchestration that wraps it, `ensureVaultIntentsKey(...)`
(`:104-122`), returns a three-way result — `'ready' | 'cancelled' | 'error'` —
and is consumed in `IntegrationSettingsModal.tsx:138-158`, which maps each
outcome to a distinct message and **refuses to enable without a derived key**:

```ts
const r = await ensureVaultIntentsKey({ loadCachedKey, getPassphrase, promptForPassphrase, derive: setupVaultIntentsEncryption })
if (r.status !== 'ready') {
  setDbIntentsEnabled(false)                                       // never enable without a key
  if (r.status === 'cancelled')                 setSetupError(t('integration.vaultIntentsEncryptionRequired'))
  else if (r.error instanceof VaultSaltMissingError) setSetupError(t('integration.vaultIntentsSaltMissing'))
  else if (r.error instanceof VaultConnMissingError) setSetupError(t('integration.vaultIntentsNoConnection'))
  else                                          setSetupError(t('integration.setupFailed'))
  return
}
```

**This `getSalt` → typed-error → never-enable-without-key shape is exactly what
lifeGLANCE should lift up into its credential-entry step**, so the URL+token+
account are validated against the live server *before* save/activate.

---

## 4. Enable / activation flow

### What turns vault sync ON

There is **no "activate" button** — activation is implicit on save+reload:

1. The user flips the **`vaultEnabled` toggle** (`:540-548`) and fills the three
   fields.
2. On modal close, `handleClose()` → `saveConfig()`
   (`SyncSettingsModal.tsx:93-122`). `saveConfig` writes the vault config (or
   `null` when the toggle is off) and computes `vaultChanged` by diffing each
   field against the snapshot taken at mount (`initVault.current`,
   `:70`/`:96-105`):

   ```ts
   const nextVault = vaultEnabled
     ? { enabled: true, vaultUrl: vaultUrl.trim(), vaultToken: vaultToken.trim(), accountId: vaultAccountId.trim() }
     : null
   setVaultConfig(nextVault)
   const vaultChanged = (prev enabled/url/token/account) !== (next …)
   …
   if (folderPath !== originalFolder.current || vaultChanged) window.location.reload()   // :114-116
   ```

3. **A reload is mandatory** because the engines are constructed once at mount.
   `createDbEngine()` only builds a DB engine when `isVaultEnabled()` is true
   (`dbEngine.ts:471-473`); changing the config in place does nothing until the
   app remounts. The UI even says so inline (`:592-594`, `:626`): *"Saved on
   close. The app reloads to apply vault changes."* / *"Save & reload to
   activate GLANCEvault sync."*

### Interaction with an already-configured WebDAV tier

They **coexist; neither takes precedence**. The vault is purely additive
(`dbEngine.ts:1-13`, `vaultConfig.ts:1-7`): the DB engine "runs ALONGSIDE the
file-tier engine, never replacing it… The file engine, its WebDAV payload, and
its sync cycle are completely untouched." Both can be on at once; both, one, or
neither is valid. In `App.tsx:247-287` the file `engine` and the `dbEngine` are
built side by side and synced independently (`engine.sync()` and `runDbSync()`).
The vault section copy reinforces it (`:537`): *"Runs alongside your existing
WebDAV sync. Your WebDAV data is never modified."*

### What happens on first activation

On the first-ever cycle (high-water-mark 0), `createDbEngine` wraps the engine's
`dbSyncCycle` to **seed a full snapshot** (`dbEngine.ts:448-465, 508-535`):

```ts
export async function markAllLocalEntitiesDirty(engine) {       // :454-465
  // mark every category/chore/completion/user dirty so the first push is a full snapshot
}
…
const dbSyncCycle = async () => {
  if (engine.getHighWaterMark() === 0) {                        // :513-520 — first ever sync
    try { await markAllLocalEntitiesDirty(engine) } catch (err) { /* non-fatal */ }
  }
  const result = await runCycle()
  …
}
```

Without this, an existing user enabling the vault would push only *future*
changes (their data predates dirty-tracking). It also runs
`recoverStalePullCursor(engine)` (`:434-446, 497`) and `resolveCategoryParents()`
(`:504-506`) on open — recovery work explained in §6.

**Salt establishment** happens on first use, not at credential entry. The
passphrase modal's submit handler drives it (`App.tsx:648-666`):

```ts
const dbEng = dbEngineRef.current
if (dbEng) {
  dbEng.ensureRootKey()                  // fetches OR registers the per-account salt with the vault
    .then(() => dbEng.dbSyncCycle())
    .catch((err) => console.warn('[lastglance] vault root key setup failed:', err))
}
```

The comment (`App.tsx:657-659`, and `dbEngine.ts:467-470`) is explicit:
"`ensureRootKey` fetches or registers the per-account salt with the vault
automatically on first use." So the *first* device to enable a fresh account
**registers** the salt; later devices **fetch** it.

**lifeGLANCE adaptation:** the activation *ordering* (validate → persist →
(re)construct engine → first cycle seeds a full snapshot → salt established on
first use) is the general pattern. The `window.location.reload()` mechanism is a
lastGLANCE shortcut around its mount-once engine construction; lifeGLANCE can
instead reconstruct/restart its sync engine in place if its architecture allows
— the requirement is "the engine must be rebuilt with the new credentials before
the first cycle," not "the page must reload."

---

## 5. Passphrase / encryption-key relationship

**The vault reuses the same sync passphrase as the file tier — it is not entered
in the vault section.** The vault section's only note about it (`:592-594`):
*"Uses your sync passphrase for encryption."*

- The passphrase is set in the **Encryption** section
  (`SyncSettingsModal.tsx:414-495`, `handleEnableEncryption` at `:144-168` →
  `setupEncryptionKey(passphrase, CRYPTO_CONFIG)`), or via the shared
  `PassphraseModal` prompt (`App.tsx:648-668`).
- The DB engine derives its root key from **that same cached passphrase**
  combined with the **per-account salt fetched from the vault**. The derivation
  is `deriveIntentsRootKey(passphrase, salt)` and is **byte-identical across
  GLANCE apps** (`setupVaultIntentsEncryption.ts:5-9, 78-81`): *"any GLANCE app
  deriving from the SAME sync passphrase and the SAME vault salt obtains the
  IDENTICAL key (required for cross-app decryptability). Only the salt SOURCE
  differs."*
- At mount, if the vault is enabled but no root key is cached and no passphrase
  is in the session, lastGLANCE prompts (`App.tsx:206-218`):

  ```ts
  if (!isVaultEnabled()) return
  const hasRoot = hasDbRootKey() || await initDbRootKey(CRYPTO_CONFIG)
  if (!hasRoot && getSyncPassphrase() === null) setShowPassphrase(true)
  ```

- The derived vault key is cached in a **distinct key slot** from the WebDAV one
  (`vaultIntentsKeyStore.ts`; `setupVaultIntentsEncryption.ts:5-9`), so the two
  transports never trample each other's keys.

**Why this matters for lifeGLANCE:** lifeGLANCE's blob and intents work derive
from the *same* passphrase+salt. To stay cross-app decryptable, lifeGLANCE must
(a) reuse the user's single sync passphrase rather than introduce a vault-only
one, and (b) derive against the **salt fetched from the vault for that account**,
never a locally invented salt. Same passphrase + same vault salt = same key =
data each app can read. The PBKDF/derivation function and salt source must match
what the other GLANCE apps use.

---

## 6. Pain points and how they were resolved

Each is something the code/comments show went wrong, plus the fix now in place,
so lifeGLANCE can skip rediscovering it.

1. **Credentials save but sync silently does nothing / "succeeds" with no
   effect.** Both engines swallow errors and resolve regardless, advancing the
   "last synced" timestamp *only* on success. A naive caller sees a resolved
   promise and reports success.
   *Fix:* treat **advanced timestamp = success, resolved-but-unchanged =
   failure**, and read the reason from the engine's last `onError`
   (`SyncSettingsModal.tsx:188-242`). lifeGLANCE must not equate "the sync
   promise resolved" with "the sync worked."

2. **No verification step before enabling (the headline gap).** The vault tier
   has no pre-save test; validity is only proven by the first post-reload cycle.
   The mitigation that *does* exist is the intents path's real server probe —
   `getSalt()` with typed `VaultConnMissingError` / `VaultSaltMissingError`
   distinctions and a hard "never enable without a derived key" rule
   (`setupVaultIntentsEncryption.ts:65-82`,
   `IntegrationSettingsModal.tsx:138-158`). **lifeGLANCE should do the probe at
   credential entry** so the user learns the URL/token/account are bad
   immediately, not after a confusing reload.

3. **Salt-not-established race.** On a brand-new account the salt doesn't exist
   until the first sync registers it; deriving a key against a missing salt would
   produce a key no other device can reproduce. Two guards: the code **refuses
   to invent a salt** and throws `VaultSaltMissingError` instead
   (`setupVaultIntentsEncryption.ts:27-35, 75-76`); and the sync engine surfaces
   the transient `ACCOUNT_ID_REQUIRED` → *"Finishing sync setup — try again in a
   moment."* (`translation.json:289`, treated as retryable in
   `App.tsx:261-264`). `ensureRootKey()` does the fetch-or-register on first use
   (`App.tsx:657-665`, `dbEngine.ts:467-470`).

4. **Ordering: derive the key *before* save + reload.** If you persist the
   enable flag and reload before the key is cached, the transport reloads with
   no key and can never send. The vault intents save handler runs key derivation
   **first**, explicitly (`IntegrationSettingsModal.tsx:128-158`): *"Run BEFORE
   any other save side effect and BEFORE the reload below, so the vault intents
   key is derived while the passphrase is available and is already cached… when
   the app reloads."* General rule: **validate + derive while the passphrase is
   in hand, only then persist + (re)build the engine.**

5. **A "needs passphrase" state surfaced as an error (confusing failure-that-is-
   not-a-failure).** `PASSPHRASE_REQUIRED` is intercepted in `onError` and turned
   into a passphrase *prompt* with the error cleared, rather than shown as a red
   sync failure (`App.tsx:255-260`). Distinguish "needs input" from "failed."

6. **Wrong passphrase polluting the account.** A key mismatch **fails fast and
   uploads nothing** (`App.tsx:261-264`), so a bad passphrase can't write
   garbage rows. Surfaced distinctly as `KEY_MISMATCH`
   (`translation.json:286`). Don't push first and validate later.

7. **Partial-decrypt rows silently lost.** Per-row decrypt quarantine
   (`@glance-apps/sync` 1.5.0): rows that fail to decrypt are skipped and
   *retried*, never dropped, and the count is surfaced as a **durable amber
   note** (not just a transient toast) so a passphrase mismatch on some rows
   stays visible — `onRowsSkipped` → `vaultSkipped`
   (`App.tsx:269-277`, `SyncSettingsModal.tsx:629-638`).

8. **Pull-cursor poisoning from older engine versions.** In `@glance-apps/sync`
   ≤1.3.x a push advanced the same high-water mark the pull resumed from, so
   pushing local rows skipped unread lower-seq peer rows forever — the
   "completions won't sync no matter what" symptom. Fixed by a one-time,
   generation-gated `recoverStalePullCursor()` that resets the pull cursor to 0
   so the next pull re-lists full history (idempotent applies make this safe) —
   `dbEngine.ts:407-446, 494-497`. (lastGLANCE-specific historical baggage, but a
   useful warning: keep push and pull cursors separate.)

9. **Out-of-order / orphan rows dropped on apply.** A child category arriving
   before its parent, a chore before its category, or a completion before its
   chore used to be dropped (insert-only completions then lost permanently).
   Fixed with **deferred buffers** that park unresolved rows and drain them when
   the dependency lands (`dbEngine.ts:214-325, 360-387`), plus a standalone
   `resolveCategoryParents()` relink pass (`:197-212`). Relevant to lifeGLANCE
   only if its entities have FK ordering; the principle — *never drop an
   insert-only row just because its dependency hasn't arrived* — is general.

---

## 7. What lifeGLANCE should replicate vs. what's lastGLANCE-specific

### Replicate (the general correct pattern)

- **Verify credentials against the live server before enabling.** Generalize the
  intents `getSalt()` probe into the credential-entry step: a real
  authenticated round-trip (`GET /salt/:accountId` with the device token) that
  proves URL + token + account together.
- **Distinguish failure modes with typed errors**, not one generic "failed":
  connection-missing, server-unreachable/bad-URL, bad-token (auth), wrong-account
  (forbidden), salt-not-established-yet (retryable), wrong-passphrase
  (key-mismatch), server-too-old. Map each to its own message.
- **Never enable without a usable key.** On cancel/error, force the toggle back
  off and cache nothing (the `ensureVaultIntentsKey` three-way `ready /
  cancelled / error` contract).
- **Activation ordering:** validate + derive the key (passphrase in hand) →
  persist config → (re)build the sync engine with the new credentials → first
  cycle seeds a **full snapshot** → salt fetched-or-registered on first use.
- **Success detection by effect, not by promise resolution** (timestamp advanced
  vs unchanged) when the engine swallows errors.
- **Reuse the single sync passphrase and the vault-provided salt** so keys are
  byte-identical across apps; never invent a salt; treat "needs passphrase" as a
  prompt, not an error.
- **Coexist with the existing tier** — additive, reversible, never mutate the
  other tier's data; clearing the vault config reverts cleanly.

### lastGLANCE-specific (adapt to lifeGLANCE's own UI/config)

- Component/file names (`SyncSettingsModal`, `IntegrationSettingsModal`), section
  layout, the beta warning copy, exact Tailwind styling and toggle markup.
- Storage key `lastglance-vault-config` and the `lastglance` app id — lifeGLANCE
  already has its own cloud-sync config holding `vaultUrl/vaultToken/accountId`;
  map onto that instead of a new localStorage blob.
- `window.location.reload()` as the activation mechanism — a workaround for
  mount-once engine construction. lifeGLANCE can reconstruct its sync engine in
  place if its architecture supports it; the *ordering* requirement stands, the
  page reload does not.
- The Dexie table mappings, deferred-buffer machinery, category-parent relink,
  and the ≤1.3.x cursor-recovery generation — all tied to lastGLANCE's data
  model and engine-version history. Port the *principles* (don't drop
  insert-only rows; keep push/pull cursors separate) only if they apply.
