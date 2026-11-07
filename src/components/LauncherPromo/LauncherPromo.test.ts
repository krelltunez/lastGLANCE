import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  LAUNCHER_GITHUB_URL, LAUNCHER_MIN_SDK, promoEntry, showPromoCard, type PromoCardInputs, type PromoLink,
} from '@/native/launcherPromo'
import type { LauncherPromo } from '@/hooks/useLauncherPromo'

// Rendered in this node environment as the paywall's test does: the portal
// renders in place and the strings are their own keys.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en', changeLanguage: () => {} } }),
}))
vi.mock('@/intents/IntentsContext', () => ({ useIntents: () => ({ isConfigured: false }) }))

// The Settings panel's promotion comes from the real gating rules over these
// inputs; only the shell's answer and the clock are supplied here.
let promo: LauncherPromo
const dismiss = vi.fn()
vi.mock('@/hooks/useLauncherPromo', () => ({ useLauncherPromo: () => promo }))

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 7, 12)
function promoFor(over: Partial<PromoCardInputs> = {}): LauncherPromo {
  const inputs: PromoCardInputs = {
    platform: 'android', channel: 'github', info: { sdk: LAUNCHER_MIN_SDK, installed: false },
    firstSeen: NOW - 4 * DAY, dismissed: false, now: NOW, ...over,
  }
  return { entry: promoEntry(inputs), card: showPromoCard(inputs), dismiss }
}

const GITHUB: PromoLink = { url: LAUNCHER_GITHUB_URL, store: 'github' }
const PLAY: PromoLink = { url: 'https://play.google.com/store/apps/details?id=app.glance.launcher', store: 'play' }

// Walks an element tree a component returned, without a DOM.
function findAll(node: ReactNode, match: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(n => findAll(n, match))
  if (!isValidElement(node)) return []
  const el = node as ReactElement<Record<string, unknown>>
  return [...(match(el) ? [el] : []), ...findAll(el.props.children as ReactNode, match)]
}

describe('the card and the entry', () => {
  let mod: typeof import('./LauncherPromo')
  beforeAll(async () => { mod = await import('./LauncherPromo') })
  beforeEach(() => dismiss.mockReset())

  it('renders the card: title, body, the GitHub link and Not now', () => {
    const html = renderToStaticMarkup(createElement(mod.LauncherPromoCard, { link: GITHUB, onDismiss: dismiss }))
    expect(html).toContain('GLANCElauncher')
    expect(html).toContain('settings.launcherPromo.body')
    expect(html).toContain(`href="${LAUNCHER_GITHUB_URL}"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('settings.launcherPromo.viewOnGithub')
    expect(html).toContain('settings.launcherPromo.notNow')
    expect(html).not.toContain('settings.launcherPromo.getOnPlay')
  })

  it('words a Play link for Play', () => {
    const html = renderToStaticMarkup(createElement(mod.LauncherPromoCard, { link: PLAY, onDismiss: dismiss }))
    expect(html).toContain(`href="${PLAY.url}"`)
    expect(html).toContain('settings.launcherPromo.getOnPlay')
    expect(html).not.toContain('settings.launcherPromo.viewOnGithub')
  })

  it('dismisses from Not now', () => {
    const tree = mod.LauncherPromoCard({ link: GITHUB, onDismiss: dismiss })
    const buttons = findAll(tree, el => el.type === 'button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].props.children).toBe('settings.launcherPromo.notNow')
    ;(buttons[0].props.onClick as () => void)()
    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('renders the entry with the same words and link, and no dismiss', () => {
    const html = renderToStaticMarkup(createElement(mod.LauncherPromoEntry, { link: GITHUB }))
    expect(html).toContain('GLANCElauncher')
    expect(html).toContain('settings.launcherPromo.body')
    expect(html).toContain(`href="${LAUNCHER_GITHUB_URL}"`)
    expect(html).not.toContain('settings.launcherPromo.notNow')
  })
})

// One SettingsPanel serves every layout: a full-height sheet on phones and a
// centered dialog from the sm breakpoint up (tablets in either orientation).
// The card sits above the sections in its one scroll body, so it is at the
// top of each; the entry is in Integrations.
describe('in the Settings panel', () => {
  let SettingsPanel: typeof import('@/components/SettingsPanel/SettingsPanel').SettingsPanel
  beforeAll(async () => {
    vi.stubGlobal('__APP_VERSION__', '0.0.0-test')
    // The portal's target; the mock above renders in place.
    vi.stubGlobal('document', { body: null })
    ;({ SettingsPanel } = await import('@/components/SettingsPanel/SettingsPanel'))
  })

  const render = (initialSection?: 'integrations' | 'appearance' | 'sync') => renderToStaticMarkup(createElement(SettingsPanel, {
    onClose: () => {}, initialSection,
    themePref: 'system', onThemeChange: () => {}, timeFormat: 'auto', onTimeFormatChange: () => {},
    weekStart: 'auto', onWeekStartChange: () => {}, syncIcon: null, syncWarn: false,
    onOpenSync: () => {}, onOpenIntegration: () => {}, onOpenShortcuts: () => {},
    engine: null, billing: {} as never, onUserMutated: () => {}, onImported: () => {},
  }))
  const cardAt = (html: string) => html.indexOf('data-testid="launcher-promo-card"')
  const firstSection = (html: string) => html.indexOf('aria-controls="settings-section-')

  it('puts the card at the top, above every section', () => {
    promo = promoFor()
    for (const section of ['appearance', 'sync', 'integrations'] as const) {
      const html = render(section)
      expect(cardAt(html)).toBeGreaterThan(-1)
      expect(cardAt(html)).toBeLessThan(firstSection(html))
      expect(html.match(/launcher-promo-card/g)).toHaveLength(1)
    }
  })

  it('lists the entry under Integrations', () => {
    promo = promoFor()
    const html = render('integrations')
    const entry = html.indexOf('data-testid="launcher-promo-entry"')
    expect(entry).toBeGreaterThan(html.indexOf('id="settings-section-integrations"'))
    expect(html).toContain(`href="${LAUNCHER_GITHUB_URL}"`)
  })

  it('keeps the entry after the card is dismissed', () => {
    promo = promoFor({ dismissed: true })
    const html = render('integrations')
    expect(cardAt(html)).toBe(-1)
    expect(html).toContain('data-testid="launcher-promo-entry"')
  })

  it('keeps the entry, without the card, in the first three days', () => {
    promo = promoFor({ firstSeen: NOW - DAY })
    const html = render('integrations')
    expect(cardAt(html)).toBe(-1)
    expect(html).toContain('data-testid="launcher-promo-entry"')
  })

  it('hides both when the launcher is installed', () => {
    promo = promoFor({ info: { sdk: 35, installed: true } })
    const html = render('integrations')
    expect(html).not.toContain('launcher-promo')
    expect(html).not.toContain('GLANCElauncher')
  })

  it('hides both off Android and on a channel with no link', () => {
    for (const over of [{ platform: 'web' }, { platform: 'ios' }, { channel: 'play' }, { channel: 'web' }, { channel: undefined }]) {
      promo = promoFor(over)
      expect(render('integrations')).not.toContain('launcher-promo')
    }
  })
})
