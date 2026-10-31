# lastGLANCE

**when did you last...?** A privacy-first recency tracker for the chores and upkeep that don't fit a calendar, and for the people you mean to stay in touch with. Runs in your browser, with no account and no server unless you bring your own.

Part of the **GLANCE family**: focused, standalone apps connected through a shared intent protocol. See also [dayGLANCE](https://github.com/krelltunez/dayGLANCE) (today), lastGLANCE (recent upkeep), and [lifeGLANCE](https://github.com/krelltunez/lifeGLANCE) (your whole timeline).

[<img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" alt="Get it on Google Play" height="75">](https://play.google.com/store/apps/details?id=com.lastglance.app)

[![Version](https://img.shields.io/github/package-json/v/krelltunez/lastGLANCE?color=green&label=version)](../../releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

![lastGLANCE dashboard](docs/screenshots/screenshot.png)

lastGLANCE is a progressive web app that answers one question: *when did I last do this?* It tracks recency, not schedules. The emotional register is information, not guilt.

It has two workspaces, switched under the wordmark:
- **Chores**: recurring upkeep, colored by how long ago you last did it.
- **People**: the people who matter to you, who you're overdue to reach out to, and the birthdays and dates coming up.

---

## Android App

A native Android app is available on Google Play and as a direct APK download. The Google Play build is a commercial binary that supports continued development.

[<img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" alt="Get it on Google Play" height="60">](https://play.google.com/store/apps/details?id=com.lastglance.app)

[**Download APK from Releases →**](../../releases)

[**Get it on Obtainium →**](https://github.com/ImranR98/Obtainium)
<br> *Just point Obtainium to `krelltunez/lastGLANCE`!*

### Which build am I running?

The two Android builds differ in one way only: the **Play** build is a paid app
(subscription or one-off lifetime unlock), the **GitHub APK is fully unlocked** —
no paywall, no billing, every feature on. They otherwise share a package name,
app name, icon and version, so once installed they look identical. Two ways to
tell them apart:

- **Settings → Subscription.** The GitHub APK says *"This build is fully
  unlocked"* and offers nothing to buy. The Play build shows a purchase status
  with *Manage subscription* / *Restore purchase* instead.
- **The version.** The sideload APK's version ends in `-github`, e.g.
  `2.5.2-github` (releases up to 2.5.2 do not carry this marker yet).

**If you are seeing a paywall, you are running the Play build.** Third-party
mirrors (APKPure, APKMirror, Aptoide and similar) republish the *Play* build
under the same name and version — only the [releases page](../../releases) and
Obtainium serve the ungated one. Switching from the Play build to the sideload
APK needs an uninstall (the signing keys differ, so Android cannot update one
into the other), and **uninstalling erases local data — export first**, or set
up [sync](#sync--storage) before you switch.

### Verifying the APK

Every release publishes `SHA256SUMS.txt` next to the APK:

```bash
sha256sum -c SHA256SUMS.txt      # run in the folder you downloaded into
```

The APK is signed with this certificate — any APK claiming to be lastGLANCE
with a different fingerprint was not built by us:

```
SHA-256: 50:D7:13:7E:92:B4:7A:6C:AB:C6:EF:57:22:AA:D2:07:AB:B9:00:CC:A0:1B:AB:23:85:A9:79:31:EF:76:04:69
```

```bash
apksigner verify --print-certs lastglance-github.apk
```

(The Play copy is re-signed by Google Play App Signing, so it legitimately shows
a *different* fingerprint — that is itself a way to tell the two apart. A
single-engine antivirus flag on the sideload APK is the same story: the two
signatures differ by design.)

The Android app ships the full web app in a WebView with native enhancements that aren't possible in a browser:

| Feature | Details |
|---|---|
| 🏠 **Home screen widgets** | A completion heatmap, a "soon" list, your pinned chores, the single most-overdue chore, and a quick-add button, each with one-tap done. For People, a Reach out widget (tap to quick-log) and a Coming up widget for the next dates |
| ⚡ **Quick Settings tiles** | An "Add chore" tile and a "Soon" tile that shows a live overdue and soon count right in the notification shade |
| 🔔 **Background reminders** | Overdue chores, birthdays and dates, and a daily catch-up digest fire reliably even when the app is closed |
| 📇 **Phone contacts** | Optional and read-only: import people with their birthdays, link a person to a contact, and call, text or email them in one tap |
| 🔗 **Native intents** | Hand overdue chores to dayGLANCE through the GLANCE intents protocol, and drive lastGLANCE from Tasker and other automation apps |
| ☁️ **Proxy-free sync** | CapacitorHttp connects straight to WebDAV and Nextcloud with no CORS proxy required |
| 🌗 **Offline-first shell** | The full app runs installable and offline, with dark and light themes |

| Chores | Chore detail |
|:-:|:-:|
| ![lastGLANCE Android dashboard](docs/screenshots/screenshot_phone_dashboard.png) | ![lastGLANCE chore detail and history](docs/screenshots/screenshot_phone_detail.png) |

| People | Person detail |
|:-:|:-:|
| ![lastGLANCE People on Android](docs/screenshots/screenshot_phone_people.png) | ![lastGLANCE person detail and timeline](docs/screenshots/screenshot_phone_person.png) |

---

## Features

### Chores

- **Recency tracking**: each chore shows how long ago it was last done, encoded as a color gradient from fresh green through amber to red
- **Cadence**: set a target interval in days; overdue chores sort to the top automatically
- **Categories & subcategories**: organize chores into collapsible groups with custom icons
- **Freeform masonry layout**: category cards size to their content and arrange across columns; your spatial organization is preserved
- **Activity heatmap**: a GitHub-style contribution graph in the header gives an at-a-glance view of completion history; tap a day to open it in the Journal
- **Completion history**: per-chore stats (total completions, average interval vs. target), a per-chore contribution graph, and a timestamped log with per-entry notes
- **Journal**: every completion across all chores, grouped by day, with date ranges and CSV export
- **Backdate entry**: log completions in the past to bootstrap history from day one
- **Reminders**: notifications when a chore is overdue (opt-in per chore)
- **Seasonal chores**: hide chores outside their active date range each year
- **Household**: share chores with the people you live with, assign them, and see "Mine" at a glance

![lastGLANCE chore detail](docs/screenshots/screenshot_details.png)

![lastGLANCE Journal](docs/screenshots/screenshot_journal.png)

### People

- **People and circles**: add the people who matter to you and group them into circles (family, friends, work, or your own), each with a bar showing how recently you were in touch
- **Quick-log**: record a contact in a couple of taps: how (in person, call, video call, text, email or other), when, a note, everyone involved, and who reached out
- **Reach out**: suggestions of who to contact next, from the cadence you set, upcoming dates and who got in touch last. Each card says why it's there, and "Not now" hides someone for 3, 7 or 14 days
- **Coming up**: birthdays and other dates in the next 30 days
- **Reciprocity**: see the balance of who reaches out ("You 5, them 2") and runs of unanswered reach-outs, or hide it all in Settings > People
- **Reminders**: a notification on each date, with an optional heads-up 1 to 14 days before, and one daily catch-up digest for the people you want reminding about; both times are adjustable
- **Phone contacts** (Android and iOS): optional and read-only. Import people with their birthdays, link a person to a contact, and call, text or email them from lastGLANCE. Nothing leaves your phone unless you use sync
- **Heatmap and Journal**: in People mode the header heatmap counts contacts per day and the Journal lists them, with the same ranges and CSV export
- **Household aware**: People is personal; each household member sees only their own

![lastGLANCE People](docs/screenshots/screenshot_people.png)

### Everywhere

- **Cloud sync**: keep data in step across devices through iCloud (iPhone and iPad, zero-config), WebDAV or Nextcloud, GLANCEvault, or a folder a sync tool already keeps in step (Direct Access); end-to-end encryption available
- **Auto-backups**: periodic remote snapshots (hourly/daily/weekly) in a `backups/` subfolder alongside the sync file
- **GLANCE integrations**: send chores and People catch-ups to dayGLANCE, and logged contacts to your lifeGLANCE timeline
- **Languages**: English, French, German, Spanish, Italian, Portuguese (Portugal and Brazil), Polish, Ukrainian and Chinese
- **PWA**: installable, works offline, auto-updates
- **Light, dark and system themes**, 12- or 24-hour clock, and your choice of first day of the week

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React 19, Tailwind CSS, Lucide icons |
| Local storage | Dexie (IndexedDB) |
| Sync | `@glance-apps/sync` (WebDAV, GLANCEvault and Direct Access engines) |
| Intents | `@glance-apps/intents` |
| Build | Vite 6, TypeScript |
| PWA | vite-plugin-pwa (Workbox) |
| Mobile | Capacitor (Android + iOS) |
| Container | nginx (production), Docker |

---

## Quick Start

Use the hosted version at [lastglance.app](https://lastglance.app), or self-host with Docker.

### Self-host with Docker

```bash
docker run -d \
  -p 3000:80 \
  --restart unless-stopped \
  ghcr.io/krelltunez/lastglance:latest
```

Or with Docker Compose:

```yaml
services:
  app:
    image: ghcr.io/krelltunez/lastglance:latest
    ports:
      - "3000:80"
    restart: unless-stopped
```

Available at `http://localhost:3000`.

### Self-host (static files)

```bash
npm install
npm run build
# Serve the dist/ folder from any static host (nginx, Caddy, Cloudflare Pages, etc.)
```

> **Note:** lastGLANCE makes WebDAV requests from the browser. If your WebDAV server does not allow cross-origin requests (CORS), you will need the WebDAV proxy (see [Configuration](#configuration)).

### Build from Source

```bash
npm install
npm run dev        # Vite dev server at http://localhost:5173
npm run build      # Production build -> dist/
npm run preview    # Preview production build locally
npm run lint       # ESLint
```

### Mobile apps (Android & iOS)

Native Android and iOS apps are built from the same web build with
[Capacitor](https://capacitorjs.com/):

```bash
npm install
npm run cap:sync       # build dist/ and sync into the native projects
npm run cap:android    # build + sync, then open Android Studio
npm run cap:ios        # build + sync, then open Xcode (requires macOS)
```

WebDAV/Nextcloud sync works without a CORS proxy in the apps thanks to the
CapacitorHttp plugin. See [docs/mobile.md](docs/mobile.md) for details.

---

## Configuration

lastGLANCE is configured entirely in-app. A couple of environment variables are available at build time:

| Variable | Required | Description |
|---|---|---|
| `VITE_WEBDAV_PROXY_URL` | No | Base URL of a [WebDAV CORS proxy](https://github.com/krelltunez/lastGLANCE/tree/main/api) to relay requests when the WebDAV server doesn't allow browser requests directly. Leave unset to use the same-origin proxy bundled with the Docker image. |
| `VITE_WEBDAV_DIRECT` | No | Set to `true` to skip the CORS proxy entirely and connect straight to your WebDAV server from the browser. Use this only when your server sends permissive CORS headers or sits behind a reverse proxy that handles CORS — otherwise sync requests will fail CORS. Leave unset to keep using the proxy. |
| `WEBDAV_PROXY_BLOCK_PRIVATE` | No | Runtime (not build time), for the Docker image's bundled proxy. The proxy reaches WebDAV servers on your own network by default, since that is the point of self-hosting, while always refusing the cloud metadata endpoint and other reserved ranges and pinning each connection to a validated address. Set to `1` if your instance is reachable by people you would rather not let relay requests into your network: private and LAN targets are then refused too, matching the cloud deployment. |

Create a `.env.local` for local development:

```env
VITE_WEBDAV_PROXY_URL=https://your-proxy.example.com
```

### WebDAV Proxy

The `api/` directory contains a lightweight server-side proxy (`webdav-proxy.js`) for deployments where CORS is a constraint. It accepts requests at `/api/webdav-proxy/?url=<encoded-target>` and forwards them to the target WebDAV server, stripping the `X-WebDAV-Auth` header into a standard `Authorization` header on the way out.

---

## Sync & Storage

All data is stored locally in IndexedDB (via Dexie). Cloud sync is optional and configured in **Settings > Cloud Sync**.

**Supported providers:**
- Generic WebDAV (pCloud, Seafile, self-hosted, etc.)
- Nextcloud (uses the native WebDAV endpoint)
- Koofr (self-hosted app recommended; Koofr blocks browser requests from Vercel-hosted origins)
- [GLANCEvault](https://github.com/glance-apps/glance-vault), a sync server you host, always end-to-end encrypted
- iCloud (iPhone and iPad): on by default, nothing to set up. Every device signed in to your Apple ID stays in step, and each has its own off switch. A fresh install that finds your data in iCloud asks before restoring it. See [docs/icloud-sync.md](docs/icloud-sync.md)
- Direct Access: a folder that Syncthing, Nextcloud, Google Drive, Dropbox, OneDrive or FolderSync already keeps in step across your devices (Android: pick the folder; iPhone and iPad: pick the file). See [docs/direct-access.md](docs/direct-access.md)

**File layout on the server** (default folder `GLANCE/lastglance`, configurable in sync settings):
```
GLANCE/lastglance/
  lastglance-sync.json      <- live sync file (chores)
  lastglance-people.json    <- People, synced separately so older versions never see it
  backups/
    lastglance-backup-hourly-...json
    lastglance-backup-daily-...json
    lastglance-backup-weekly-...json
```

People syncs on every road chores do, as its own file or vault app so older versions never see it: `lastglance-people.json` next to the chore file on WebDAV, in iCloud and in a Direct Access folder (on iPhone and iPad you choose or create that file too), and the `lastglance-people` app on GLANCEvault. **Settings > People** can keep People off a vault you share.

**Encryption:** end-to-end AES-256-GCM encryption is optional for WebDAV and Direct Access, and always on for GLANCEvault. iCloud files are protected by Apple's iCloud encryption instead. When enabled, the sync files and all backup files are encrypted before upload; People uses the same key as chores. The passphrase never leaves the device, and there is no recovery mechanism, so store it somewhere safe.

---

## Integrations

Integrations travel over the GLANCE intents protocol, through your own WebDAV server, GLANCEvault or Direct Access folder, or on iPhone and iPad through iCloud (dayGLANCE's iCloud events folder; opt-in under **Settings > Integrations**). Configure them in **Settings > Integrations**.

### dayGLANCE

lastGLANCE can send chores to [dayGLANCE](https://github.com/krelltunez/dayGLANCE) as scheduled tasks. Completing the task in dayGLANCE logs the chore here.

Two delivery modes are available per chore:
- **Manual**: the -> dG button on a chore card sends it immediately
- **Auto**: the chore is sent once per day whenever it's overdue (requires the intents poller to be running)

People can use it too, both off by default:
- **Per person, "Add to dayGLANCE when overdue"**: a "Call Sam" task once per overdue stretch, worded by their usual channel. Done in dayGLANCE, it logs an outbound contact here.
- **Settings > People**: today's birthdays and dates go to dayGLANCE as all-day items (per device).

### lifeGLANCE

Per person, **"Add contacts to lifeGLANCE"** adds each contact you log with them to your [lifeGLANCE](https://github.com/krelltunez/lifeGLANCE) timeline as a milestone.

### Tasker and automation (Android)

Other apps can drive lastGLANCE through `app.lastglance.*` intents: create, complete or open a chore, query counts, and log a contact with a person (`LOG_INTERACTION`). See [docs/tasker-integration.md](docs/tasker-integration.md).

---

## Data & Backups

- **Export**: download a full JSON backup at any time from **Settings > Backup & Restore**
- **Import**: restore from a local JSON file (replaces all current data)
- **Remote restore**: browse and restore from any auto-backup on your WebDAV server
- **Clear sample data**: remove the example categories and chores from a fresh install (also offered in the welcome modal)

---

## Privacy

lastGLANCE has no backend, no analytics, and no accounts. All data is stored locally on your device. Cloud sync goes only to your own iCloud account (on iPhone and iPad, on by default, with an off switch on each device), or to a server or folder you control, where it can be end-to-end encrypted so the server never sees plaintext. Phone contacts are read only when you turn them on, and never leave your phone except as people you imported, through your own sync. See the [privacy policy](https://www.glance-apps.com/lastglance/privacy).

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the app locally, project structure, pull request guidelines, and how to report bugs or security issues.

---

## License

The source code is [MIT-licensed](LICENSE): free to build, self-host, modify, and distribute. The web app is free to use, [hosted](https://lastglance.app) or self-hosted, and free builds (including the sideload APK) are on the [releases page](../../releases).

The paid Google Play / App Store builds are a convenience distribution that funds development: you're paying for the packaged, signed, auto-updating binary, not the code.

The lastGLANCE name, logo, and app icon are trademarks and are not covered by the MIT license.

---

## Support

If lastGLANCE has been useful to you, consider supporting its development:

[![GitHub Sponsors](https://img.shields.io/badge/GitHub_Sponsors-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/krelltunez)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-F16061?logo=kofi&logoColor=white)](https://ko-fi.com/krelltunez)
