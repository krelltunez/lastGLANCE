import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  DISMISSED_EVENT, DISMISSED_KEY, FIRST_SEEN_KEY, LAUNCHER_GITHUB_URL, LAUNCHER_MIN_SDK, LAUNCHER_PLAY_URL,
  PROMO_DELAY_MS, dismissPromo, isPromoDismissed, promoEntry, promoLink, readFirstSeen, recordFirstSeen,
  showPromoCard, type PromoCardInputs,
} from './launcherPromo'

const PLAY = 'https://play.google.com/store/apps/details?id=app.glance.launcher'
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 7, 12)

// Every condition met: the card shows. Each test below breaks exactly one.
const shown = (): PromoCardInputs => ({
  platform: 'android',
  channel: 'github',
  info: { sdk: LAUNCHER_MIN_SDK, installed: false },
  headless: false,
  firstSeen: NOW - 3 * DAY,
  dismissed: false,
  now: NOW,
})

class MemoryStorage {
  map = new Map<string, string>()
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
}

describe('the build channel link', () => {
  it('links the sideload build to the latest GitHub release', () => {
    expect(promoLink('github')).toEqual({ url: LAUNCHER_GITHUB_URL, store: 'github' })
    expect(LAUNCHER_GITHUB_URL).toBe('https://github.com/krelltunez/GLANCElauncher/releases/latest')
  })

  it('links the Play build to the launcher on Google Play', () => {
    expect(LAUNCHER_PLAY_URL).toBe(PLAY)
    expect(promoLink('play')).toEqual({ url: PLAY, store: 'play' })
    expect(promoEntry({ ...shown(), channel: 'play' })).not.toBeNull()
    expect(showPromoCard({ ...shown(), channel: 'play' })).toBe(true)
  })

  it('shows nothing in the Play build if its link is emptied', () => {
    const urls = { github: LAUNCHER_GITHUB_URL, play: '' }
    expect(promoLink('play', urls)).toBeNull()
    expect(showPromoCard({ ...shown(), channel: 'play', urls })).toBe(false)
  })

  it('uses the Play link, with Play wording, once it is set', () => {
    const urls = { github: LAUNCHER_GITHUB_URL, play: PLAY }
    expect(promoLink('play', urls)).toEqual({ url: PLAY, store: 'play' })
    expect(showPromoCard({ ...shown(), channel: 'play', urls })).toBe(true)
  })

  it('offers nothing on the web channel or a dev build with no channel', () => {
    for (const channel of ['web', undefined, '', 'GITHUB']) {
      expect(promoLink(channel)).toBeNull()
      expect(showPromoCard({ ...shown(), channel })).toBe(false)
    }
  })

  it('takes only an https link', () => {
    for (const github of ['http://example.com/x', 'javascript:alert(1)', 'not a url', '']) {
      expect(promoLink('github', { github, play: '' })).toBeNull()
    }
  })
})

describe('who sees the card and the entry', () => {
  it('shows both when every condition is met', () => {
    expect(showPromoCard(shown())).toBe(true)
    expect(promoEntry(shown())).toEqual({ url: LAUNCHER_GITHUB_URL, store: 'github' })
  })

  it('is Android only: never web, PWA or iOS', () => {
    for (const platform of ['web', 'ios', '']) {
      expect(showPromoCard({ ...shown(), platform })).toBe(false)
      expect(promoEntry({ ...shown(), platform })).toBeNull()
    }
  })

  it('never shows in a headless refresh', () => {
    expect(showPromoCard({ ...shown(), headless: true })).toBe(false)
    expect(promoEntry({ ...shown(), headless: true })).toBeNull()
  })

  it('hides both below Android 12, which the pairing needs', () => {
    expect(LAUNCHER_MIN_SDK).toBe(31)
    const old = { ...shown(), info: { sdk: 30, installed: false } }
    expect(showPromoCard(old)).toBe(false)
    expect(promoEntry(old)).toBeNull()
  })

  it('hides both when the launcher is installed', () => {
    const has = { ...shown(), info: { sdk: 35, installed: true } }
    expect(showPromoCard(has)).toBe(false)
    expect(promoEntry(has)).toBeNull()
  })

  it('hides both with no answer from the shell, or a doubtful one', () => {
    expect(showPromoCard({ ...shown(), info: null })).toBe(false)
    expect(promoEntry({ ...shown(), info: null })).toBeNull()
    const doubtful = [
      { sdk: Number.NaN, installed: false },
      { sdk: 35, installed: undefined as unknown as boolean },
      { sdk: '35' as unknown as number, installed: 'false' as unknown as boolean },
    ]
    for (const info of doubtful) expect(promoEntry({ ...shown(), info })).toBeNull()
  })

  it('waits until the app has been used on this device for three days', () => {
    expect(PROMO_DELAY_MS).toBe(3 * DAY)
    expect(showPromoCard({ ...shown(), firstSeen: NOW - 3 * DAY + 1 })).toBe(false)
    expect(showPromoCard({ ...shown(), firstSeen: NOW - 3 * DAY })).toBe(true)
    expect(showPromoCard({ ...shown(), firstSeen: null })).toBe(false)
    // A stamp from the future (a clock moved back) is not three days in.
    expect(showPromoCard({ ...shown(), firstSeen: NOW + DAY })).toBe(false)
    // The entry does not wait.
    const day1: PromoCardInputs = { ...shown(), firstSeen: NOW }
    expect(promoEntry(day1)).not.toBeNull()
  })

  it('never shows the card once dismissed, and keeps the entry', () => {
    expect(showPromoCard({ ...shown(), dismissed: true })).toBe(false)
    const dismissed: PromoCardInputs = { ...shown(), dismissed: true }
    expect(promoEntry(dismissed)).not.toBeNull()
  })
})

describe('device-local state', () => {
  let storage: MemoryStorage
  beforeEach(() => { storage = new MemoryStorage() })

  it('persists a dismissal and announces it', () => {
    const listener = vi.fn()
    const target = new EventTarget()
    target.addEventListener(DISMISSED_EVENT, listener)
    vi.stubGlobal('window', target)
    try {
      expect(isPromoDismissed(storage)).toBe(false)
      dismissPromo(storage)
      expect(storage.getItem(DISMISSED_KEY)).toBe('1')
      expect(isPromoDismissed(storage)).toBe(true)
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('records the first-seen stamp once, and never moves it', () => {
    recordFirstSeen({ platform: 'android', headless: false, now: NOW, storage })
    expect(readFirstSeen(storage)).toBe(NOW)
    recordFirstSeen({ platform: 'android', headless: false, now: NOW + 5 * DAY, storage })
    expect(readFirstSeen(storage)).toBe(NOW)
  })

  it('replaces an unreadable stamp', () => {
    storage.setItem(FIRST_SEEN_KEY, 'garbage')
    expect(readFirstSeen(storage)).toBeNull()
    recordFirstSeen({ platform: 'android', headless: false, now: NOW, storage })
    expect(readFirstSeen(storage)).toBe(NOW)
  })

  it('records nothing in a headless refresh', () => {
    recordFirstSeen({ platform: 'android', headless: true, now: NOW, storage })
    expect(storage.getItem(FIRST_SEEN_KEY)).toBeNull()
  })

  it('treats a headless page as headless when the caller does not say', () => {
    vi.stubGlobal('window', { location: { search: '?headless=refresh&clientId=x' } })
    try {
      recordFirstSeen({ platform: 'android', now: NOW, storage })
      expect(storage.getItem(FIRST_SEEN_KEY)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('records nothing off Android', () => {
    for (const platform of ['web', 'ios']) recordFirstSeen({ platform, headless: false, now: NOW, storage })
    expect(storage.getItem(FIRST_SEEN_KEY)).toBeNull()
  })

  it('survives blocked storage', () => {
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(readFirstSeen(blocked)).toBeNull()
    expect(isPromoDismissed(blocked)).toBe(false)
    expect(() => recordFirstSeen({ platform: 'android', headless: false, now: NOW, storage: blocked })).not.toThrow()
  })
})

// The two keys are this device's alone. Backups (db/queries.ts exportBackup)
// and both sync tiers carry named fields, never a sweep of localStorage, so
// keeping the keys out of every other module keeps them out of both.
describe('the keys stay out of sync and backups', () => {
  const SRC = join(__dirname, '..')
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })

  it('names them only in the promotion module and its tests', () => {
    const allowed = new Set(['native/launcherPromo.ts', 'native/launcherPromo.test.ts'])
    const offenders = files(SRC)
      .filter(f => !allowed.has(relative(SRC, f)))
      .filter(f => {
        const text = readFileSync(f, 'utf8')
        return text.includes(FIRST_SEEN_KEY) || text.includes(DISMISSED_KEY) || text.includes('lg-launcher-promo')
      })
    expect(offenders).toEqual([])
  })

  it('does not sweep localStorage into a backup or a sync payload', () => {
    for (const f of ['db/queries.ts', 'sync/engine.ts', 'people/sync/fileEngine.ts']) {
      const text = readFileSync(join(SRC, f), 'utf8')
      expect(text, f).not.toMatch(/localStorage\.key\(|Object\.keys\(localStorage\)|localStorage\.length/)
    }
  })
})
