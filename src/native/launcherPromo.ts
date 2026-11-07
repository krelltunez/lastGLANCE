import { isHeadlessRefresh } from '@/headless/headlessMode'

// Telling Android users about GLANCElauncher, the companion home screen
// launcher (docs/launcher-integration.md, "Telling users about the launcher").
// It lives in Settings, never as a popup: a one-time card at the top of the
// panel, and a permanent entry under Integrations so it can be found again
// after the card is dismissed.
//
// Everything here is pure or takes its storage as an argument; the hook
// (src/hooks/useLauncherPromo.ts) supplies the platform, the build channel and
// the native answer. Both the card and the entry need, all of:
//   - the Android app (never web, PWA or iOS), and not a headless refresh;
//   - a link for this build channel (an https URL; see the constants below);
//   - Android 12 or later, which the pairing needs (`knownSigner`);
//   - the launcher NOT installed, from a lookup that answered. No answer, or
//     a doubtful one, hides both.
// The card also waits until the app has been used on this device for three
// days, and never returns once dismissed. The two keys below are this
// device's alone: localStorage, not synced, not in backups.

// The product's name, the card's title. Untranslated in every language.
export const LAUNCHER_NAME = 'GLANCElauncher'

// The launcher's application id, the one the shell looks up
// (LauncherBridgePlugin.promoInfo, and <queries> in AndroidManifest.xml).
export const LAUNCHER_PACKAGE = 'app.glance.launcher'

// Android 12 (API 31). The provider and receiver sit behind a
// `signature|knownSigner` permission, and knownSigner exists from Android 12;
// below it the launcher can only show demo data, so it is not offered.
export const LAUNCHER_MIN_SDK = 31

// The sideload build (github channel) links to the launcher's releases.
export const LAUNCHER_GITHUB_URL = 'https://github.com/krelltunez/GLANCElauncher/releases/latest'

// The Play build's link. EMPTY until GLANCElauncher is approved on Google
// Play, and while it is empty the Play build shows neither the card nor the
// Settings entry. Once the launcher is live on Play, set this to:
//   https://play.google.com/store/apps/details?id=app.glance.launcher
export const LAUNCHER_PLAY_URL = ''

// How long the app must have been in use on this device before the card shows.
export const PROMO_DELAY_MS = 3 * 24 * 60 * 60 * 1000

// Device-local, never synced or backed up (launcherPromo.test.ts checks that
// nothing else in the app names them).
export const FIRST_SEEN_KEY = 'lg-launcher-promo-first-seen'
export const DISMISSED_KEY = 'lg-launcher-promo-dismissed'

// Fired on this window when the card is dismissed, so every hook instance hides it.
export const DISMISSED_EVENT = 'lg:launcher-promo-dismissed'

export type PromoStore = 'github' | 'play'

export interface PromoLink {
  url: string
  // Which store the link opens, for the button's wording.
  store: PromoStore
}

// What the shell answers (LauncherBridge.promoInfo).
export interface PromoInfo {
  // Build.VERSION.SDK_INT.
  sdk: number
  // True when the launcher is installed, or when the lookup could not tell.
  installed: boolean
}

export interface PromoUrls {
  github: string
  play: string
}

const DEFAULT_URLS: PromoUrls = { github: LAUNCHER_GITHUB_URL, play: LAUNCHER_PLAY_URL }

function isHttpsUrl(url: string): boolean {
  if (!url) return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

// The link for a build channel, or null for a channel with none: web, a dev
// build with no channel, or Play while its constant is empty.
export function promoLink(channel: string | undefined, urls: PromoUrls = DEFAULT_URLS): PromoLink | null {
  if (channel !== 'github' && channel !== 'play') return null
  const url = urls[channel]
  return isHttpsUrl(url) ? { url, store: channel } : null
}

export interface PromoInputs {
  // Capacitor.getPlatform(): 'android' | 'ios' | 'web'.
  platform: string
  // import.meta.env.VITE_BUILD_CHANNEL.
  channel: string | undefined
  // The shell's answer; null until it arrives, or when there was none.
  info: PromoInfo | null
  headless?: boolean
  urls?: PromoUrls
}

// The permanent Settings entry: the link to show, or null to show nothing.
export function promoEntry(inputs: PromoInputs): PromoLink | null {
  if (inputs.headless) return null
  if (inputs.platform !== 'android') return null
  const link = promoLink(inputs.channel, inputs.urls)
  if (!link) return null
  const info = inputs.info
  if (!info || info.installed !== false) return null
  if (!(info.sdk >= LAUNCHER_MIN_SDK)) return null
  return link
}

export interface PromoCardInputs extends PromoInputs {
  // When the app was first seen on this device (ms), or null when not recorded.
  firstSeen: number | null
  dismissed: boolean
  now: number
}

// The one-time card: everything the entry needs, three days in, not dismissed.
export function showPromoCard(inputs: PromoCardInputs): boolean {
  if (!promoEntry(inputs)) return false
  if (inputs.dismissed) return false
  if (inputs.firstSeen === null) return false
  return inputs.now - inputs.firstSeen >= PROMO_DELAY_MS
}

// ── Device-local storage ─────────────────────────────────────────────────────

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): KeyStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readFirstSeen(storage: KeyStore | null = defaultStorage()): number | null {
  try {
    const raw = storage?.getItem(FIRST_SEEN_KEY)
    if (raw == null) return null
    const ms = Number(raw)
    return Number.isFinite(ms) && ms > 0 ? ms : null
  } catch {
    return null
  }
}

export interface RecordFirstSeenInputs {
  platform: string
  // Defaults to whether this page is a headless refresh.
  headless?: boolean
  now: number
  storage?: KeyStore | null
}

// Stamps the first day the app ran on this device, once: at app start, on
// Android only, never in a headless refresh (a run is not the user using the
// app). An unreadable stamp is replaced; a good one is never moved.
export function recordFirstSeen({
  platform, headless = isHeadlessRefresh(), now, storage = defaultStorage(),
}: RecordFirstSeenInputs): void {
  if (headless || platform !== 'android' || !storage) return
  if (readFirstSeen(storage) !== null) return
  try {
    storage.setItem(FIRST_SEEN_KEY, String(now))
  } catch {
    // Storage blocked: no stamp, so no card. The entry still shows.
  }
}

export function isPromoDismissed(storage: KeyStore | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissPromo(storage: KeyStore | null = defaultStorage()): void {
  try {
    storage?.setItem(DISMISSED_KEY, '1')
  } catch {
    // Storage blocked: hidden for this session only.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DISMISSED_EVENT))
}
