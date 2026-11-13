# Releasing the desktop app

How to ship the lastGLANCE desktop app for macOS, Windows and Linux. The design
is in [desktop-app.md](desktop-app.md), sections 9 and 11. The Android and iOS
releases are unchanged and share the version: `package.json` is the single
source.

There are two kinds of desktop build:

| Build | How it ships | Billing |
|---|---|---|
| **Direct**: macOS (Developer ID), Windows, Linux | CI, attached to the GitHub release for a `v*` tag | Free, ungated |
| **Mac App Store** | Built on a Mac, uploaded with Transporter | Gated: the iOS app's products, under Universal Purchase |

## 1. One-time setup

### GitHub secrets (direct macOS build)

Under the repository's Settings → Secrets and variables → Actions. Without them
the macOS build is still produced, but ad-hoc signed: it opens only after
right-click → Open, and Gatekeeper warns.

| Secret | What it is |
|---|---|
| `CSC_LINK` | The **Developer ID Application** certificate and key, exported from Keychain Access as a `.p12`, then base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `CSC_KEY_PASSWORD` | The password chosen when exporting the `.p12` |
| `APPLE_ID` | The Apple ID email of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from appleid.apple.com, for the notary service |
| `APPLE_TEAM_ID` | The 10-character Team ID |

These can be the same team's values that dayGLANCE's release workflow uses.

### Apple and RevenueCat (Mac App Store build)

- **Apple Developer, App ID `com.lastglance`:**
  - enable macOS for the App ID;
  - check that both iCloud containers, `iCloud.com.lastglance` and
    `iCloud.com.dayglance`, are assigned to it (the iOS app already uses them);
  - create a **Mac App Store** provisioning profile for it, download it, and save
    it as `electron/lastglance.mas.provisionprofile`. That path is git-ignored;
    `MAC_PROVISIONING_PROFILE` can point elsewhere.
- **Certificates in the Mac's login keychain:** "Apple Distribution" (or "3rd
  Party Mac Developer Application") to sign the app, and "Mac Installer
  Distribution" (or "3rd Party Mac Developer Installer") to sign the `.pkg`.
- **App Store Connect:** add the macOS platform to the existing lastGLANCE app
  record. Universal Purchase then carries `lastglance_pro_annual` and
  `lastglance_pro_lifetime` to the Mac.
- **RevenueCat:** the iOS App Store app's configuration covers Mac receipts
  under Universal Purchase, as it does for dayGLANCE. The Mac app uses the iOS
  public key (`electron/billingConfig.ts`).

## 2. Before tagging

1. Bump `version` in `package.json` as for any release.
2. Run the checks: `npm run lint`, `npm test`, and the desktop smoke test
   (`npm run build:electron:dir && npm run test:electron-smoke`; under
   `xvfb-run` on Linux).
3. To try a packaging change first, run **Release desktop** from the Actions tab
   (Run workflow). A manual run builds all three platforms and uploads the
   files to the run, without touching any release.

## 3. Direct builds

Push the version tag, as for the Android release:

```bash
git tag v3.1.0
```

```bash
git push origin v3.1.0
```

`release-desktop.yml` then builds:

- macOS: `dmg` and `zip`, for Apple silicon and Intel, signed and notarized
  when the secrets are set;
- Windows: the NSIS installer (`.exe`), not code-signed, so SmartScreen warns
  on first run;
- Linux: `AppImage` and `deb`, for x64 and arm64.

It adds the files to the GitHub release for the tag. If that release already
exists (the Android APK's, say), the files are uploaded to it and it stays as
it is; otherwise a draft release is created with them. Write or finish the
release notes there (no em dashes, per CLAUDE.md), and publish.

Desktop users on an older version see a "lastGLANCE x.y.z is available" notice
within a few hours: the app checks for the latest published release that has a
download for their OS. A release without desktop files is never announced to
them.

## 4. Mac App Store build

On a Mac with the certificates and the provisioning profile from section 1:

```bash
npm ci
```

```bash
npm run build:electron:mas
```

This builds the universal `.pkg` in `dist-app/mas-universal/`, as
`com.lastglance`, sandboxed, with both iCloud containers and in-app purchases.
Its build number is `YYYYMMDD.HHMM`, so every upload is higher than the last
(`BUILD_NUMBER` overrides). Before uploading, check it carries nothing the
store build must not (the Claude Desktop setup, docs/mcp-and-stream-deck.md,
section 7):

```bash
node scripts/verify-mas-compileout.mjs --mas dist-app/mas-universal/lastGLANCE.app
```

Then:

1. Upload the `.pkg` with **Transporter**.
2. In App Store Connect, add the build to the macOS version, with the release
   notes (no em dashes), and submit it for review. TestFlight for Mac works
   with the same build.
3. App Review needs a way past the paywall: the reviewer code, as for iOS
   (`npm run reviewer-code`).

## 5. After release

- Download the macOS `dmg` on a Mac that has never run the app. It should open
  without a Gatekeeper warning (signed builds only).
- On an install of the previous version, check that the update notice appears.
- On the Mac App Store build, check that the paywall shows App Store prices,
  that a purchase or restore unlocks, and that iCloud reaches both containers
  (desktop-app.md, section 6).
