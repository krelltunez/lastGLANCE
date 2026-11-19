# lastGLANCE: Mac App Store listing (draft)

Draft copy for the macOS platform on the existing lastGLANCE App Store Connect
record (Universal Purchase, `com.lastglance`). Derived from the iOS listing and
trimmed to what the Mac App Store build actually has (docs/desktop-app.md,
docs/mcp-and-stream-deck.md section 7).

## Where each field lives in App Store Connect

- **Shared with iOS (App Information, not editable per platform):** name
  ("lastGLANCE: Chores & People"), subtitle, category (Productivity), age
  rating, privacy policy URL, and the in-app purchases.
- **Per platform (the macOS version page):** promotional text, description,
  keywords, support URL, marketing URL, screenshots, What's New.
- **What's New** is not asked for on a platform's first version, so there is
  nothing to write until the first Mac update.

## What the Mac build has, and what it does not

Kept from iOS: Chores, People (circles, quick-log, Reach out, Coming up,
reciprocity), reminders and the daily digest, iCloud, WebDAV / Nextcloud /
GLANCEvault / folder sync with E2E encryption, backups, Journal and CSV,
households, seasonal chores, backdating, GLANCE integrations, ten languages.

Mac-only, now in the copy: the menu bar popup with Done and live search, the
global shortcuts, Mark done from a notification, running in the background
when the window is closed, Open at login, `lastglance://` links, Keychain,
Stream Deck, AI assistants over MCP.

Dropped from the iOS copy because the Mac build does not have them: Home
Screen and Lock Screen widgets, Control Center, Siri / Spotlight / Shortcuts,
the share sheet, contacts import and call / text / email in a tap (contacts on
macOS is a stated non-goal).

---

## Promotional text (170 max)

```
Now on Mac: see when you last did the things that matter, right from the menu bar. One purchase covers your iPhone, iPad and Mac. No accounts, no analytics, no nagging.
```

## Description (4000 max)

```
lastGLANCE is for the recurring, never-really-finished stuff that's easy to forget: When did you last water the plants? Change the sheets? Clean the litter box? Take out the garbage? Call your mom?

lastGLANCE answers those questions by showing you, at a glance, when you last did the things that matter, and who you have been meaning to call. On the Mac it also lives in your menu bar, one click away.

No accounts. No analytics. Your data stays on your Mac and only leaves it when you choose.

Give each chore a rough cadence (every 7 days, every 3 months, whatever fits) and the card eases from green toward red as time passes:
• Green: done recently
• Amber: coming due soon
• Red: overdue
One look tells you what needs attention and what you can happily ignore.

HOW IT WORKS
• Add the things you do regularly and group them into categories.
• Click Done the moment you do one. That's the whole interaction.
• Watch the colors. Do the red ones. Repeat.

THE PEOPLE YOU MEAN TO CALL
• The other half of lastGLANCE: the people who matter to you, in circles you name, each with a bar for how recently you were in touch.
• Log a catch-up in a few clicks: how (in person, call, video, text, email), when, a note and who was there.
• Reach out suggests who to contact next and says why each card is there. "Not now" hides someone for 3, 7 or 14 days.
• Coming up lists birthdays and dates in the next 30 days.

MADE FOR THE MAC
• A menu bar popup shows what is due and who to reach out to, with Done right there. Start typing to search every chore.
• Give it a global shortcut: type a few letters, press Return, then Space, and it's logged without touching the mouse.
• Mac notifications for overdue chores, birthdays and dates, plus a daily catch-up digest. Mark a chore done right from the notification.
• Close the window and lastGLANCE keeps running in the menu bar, so reminders still arrive.
• iCloud keeps your Mac in step with lastGLANCE on your iPhone and iPad.
• Stream Deck keys and dials for a chore, what is due, Reach out and more, with the lastGLANCE plugin.
• Connect an AI assistant that supports MCP to read your chores and, with your say-so, mark them done. Off by default, local to your Mac, and every change can be undone.

BUILT FOR REAL LIFE
• Seasonal chores that only count during part of the year.
• Backdate completions to bootstrap your history from day one.
• Notes on completions, and per-chore stats: total done and average interval against your cadence.
• A Journal of everything you have kept up with, by day, with CSV export.
• Households: assign chores and filter to just yours. People stays private to you.
• Fast search, a distinct icon for every chore, light and dark themes, and ten languages.

YOUR DATA, YOUR DEVICE
• Works fully offline, and you can back up and restore whenever you like.
• Sync on your terms: iCloud, your own WebDAV or Nextcloud server, GLANCEvault (a sync server you host), or a folder Syncthing, Dropbox, Google Drive or OneDrive already keeps in step. Server and folder sync can be end-to-end encrypted with AES-256-GCM, so the server sees only ciphertext, with hourly, daily and weekly backups.
• Connects to other GLANCE apps: send a chore to dayGLANCE and complete it there, or add your catch-ups to your lifeGLANCE timeline. No servers of ours, no telemetry. Off by default.
• Open source and self-hostable under Docker, if you would rather run it yourself. Either way, your data stays yours.

SUBSCRIPTION
lastGLANCE Pro starts with a 7-day free trial. After the trial it is an annual subscription at $4.99/year, renewing until canceled, or a one-time lifetime unlock at $19.99 (no trial for lifetime). One purchase unlocks lastGLANCE on your iPhone, iPad and Mac. Cancel any time in your Apple ID subscription settings.

Terms of Use: https://www.glance-apps.com/eula
Privacy Policy: https://www.glance-apps.com/lastglance/privacy

No streaks to protect, no guilt. Just an honest picture of where things stand.
```

## Keywords (100 max, comma-separated, no spaces)

Leaves out words already in the name ("lastGLANCE", "Chores", "People"),
which Apple indexes anyway.

```
menu bar,tracker,last done,household,cleaning,routine,recurring,upkeep,birthday,reminder,catch up
```

## URLs

- Support URL: same as iOS.
- Marketing URL: same as iOS, or https://lastglance.app.

## App Review notes (macOS)

```
To get past the paywall, choose "Reviewer access" on it and enter this code: [CODE]. It works the same way as in the iOS app.

The app is sandboxed and holds com.apple.security.network.server for two optional features in Settings > Integrations > On this computer, both off by default: an MCP server for AI assistants and a listener for the Stream Deck plugin. Both bind to 127.0.0.1 only and are never reachable from the network. Nothing is installed or run outside the app's bundle: the one-click Claude Desktop setup in the direct-download build is compiled out of this build.

iCloud: the app reads its own container (iCloud.com.lastglance) for sync with the iOS app, and iCloud.com.dayglance for the optional dayGLANCE integration.
```

Fill in [CODE] from `npm run reviewer-code`, and attach the demo video dayGLANCE used for Guideline 2.4.5(i) if review asks
about the listeners (docs/mcp-and-stream-deck.md, section 7).

## Screenshots still needed

None exist for the Mac yet. The Mac App Store takes 16:10 at 1280 x 800,
1440 x 900, 2560 x 1600 or 2880 x 1800, one to ten frames. Worth including:
the dashboard window, People, and the menu bar popup over a desktop (the
popup is the Mac's answer to the widgets, so it is the frame that sells the
Mac version).

## Things to check before pasting

- **Stream Deck plugin source.** The README points to GitHub Releases. The
  copy names no source on purpose: the Mac App Store listing should not send
  people to a GitHub download. If the plugin is on the Elgato Marketplace by
  launch, "from the Elgato Marketplace" can be added.
- **"MCP" and assistants by name.** The copy avoids naming Claude or any other
  assistant (third-party trademarks in metadata, Guideline 2.3.7). The
  Claude Desktop button is compiled out of this build anyway.
- **Universal Purchase line.** Only true once the macOS platform is added to
  the record and the products show on the Mac. They should, as the products
  are the record's.
- **iCloud wording.** On the Mac, iCloud appears once the iOS app has used it
  on that Apple ID (docs/desktop-app.md, section 6), so the copy says "keeps
  your Mac in step with lastGLANCE on your iPhone and iPad" rather than
  promising zero setup on its own.

---

## Suggested changes to the iOS listing

1. **Comma splice in HOW IT WORKS.** "Tap a chore the moment you do it,
   that's the interaction." Suggest: "Tap a chore the moment you do it.
   That's the whole interaction."
2. **The GLANCE integrations bullet says "all through your own server"**, but
   on iPhone and iPad the intents also travel over iCloud (README,
   Integrations). Suggest "through your own server or iCloud", or drop the
   clause.
3. **Once the Mac version is live:** add "One purchase unlocks lastGLANCE on
   your iPhone, iPad and Mac." to SUBSCRIPTION, and consider this promo text
   (143 characters):

   ```
   Track when you last did the things that matter and the people you mean to catch up with. Now on Mac too. No accounts, no analytics, no nagging.
   ```

   It drops "Includes widgets and shortcuts" to make room. Promo text can be
   changed without a new build, so this can go live the day the Mac app does.
