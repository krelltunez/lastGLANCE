import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import dayjs from 'dayjs'
import {
  applyDateLocale,
  getActiveLocale,
  formatDate,
  formatTime,
  formatDateTime,
  formatDayHeading,
  formatMonthDay,
  formatMonthDayTime,
  formatMonthYear,
  firstDayOfWeek,
  weekdayMinLabels,
  weekdayAtOffset,
  setTimeFormat,
  getTimeFormat,
  loadTimeFormat,
  uses24HourClock,
  formatTimeSample,
} from './datetime'

// A Wednesday, deliberately in the afternoon so the 12-/24-hour split shows.
const SAMPLE = '2026-08-12T14:05:00'

afterEach(() => {
  vi.unstubAllGlobals()
  setTimeFormat('auto')
  applyDateLocale('en')
})

describe('applyDateLocale', () => {
  it('accepts the six base languages', () => {
    for (const lng of ['en', 'de', 'es', 'fr', 'it', 'pt']) {
      applyDateLocale(lng)
      expect(getActiveLocale()).toBe(lng)
    }
  })

  it('uses the regional dayjs locale when one exists', () => {
    // Brazilian Portuguese must not be stripped to dayjs's generic
    // (European) "pt" — dayjs ships a dedicated "pt-br".
    applyDateLocale('pt-BR')
    expect(getActiveLocale()).toBe('pt-br')
    applyDateLocale('zh-CN')
    expect(getActiveLocale()).toBe('zh-cn')
  })

  it('takes the base language from a regional tag dayjs has no locale for', () => {
    applyDateLocale('pt-PT')
    expect(getActiveLocale()).toBe('pt')
    applyDateLocale('de-AT')
    expect(getActiveLocale()).toBe('de')
  })

  it('falls back to English for anything unsupported or absent', () => {
    for (const lng of ['ja', 'xx-YY', '', undefined]) {
      applyDateLocale(lng)
      expect(getActiveLocale()).toBe('en')
    }
  })
})

describe('display formatting', () => {
  it('localizes the month name and field order', () => {
    applyDateLocale('en')
    expect(formatDate(SAMPLE)).toBe('Aug 12, 2026')
    applyDateLocale('fr')
    // Day precedes month in French, and the month name is translated.
    expect(formatDate(SAMPLE)).toMatch(/12/)
    expect(formatDate(SAMPLE)).toMatch(/août/)
    expect(formatDate(SAMPLE).indexOf('12')).toBeLessThan(formatDate(SAMPLE).indexOf('août'))
  })

  it('uses a 12-hour clock in English and a 24-hour clock elsewhere', () => {
    applyDateLocale('en')
    expect(formatTime(SAMPLE)).toMatch(/2:05\s?PM/i)
    for (const lng of ['de', 'es', 'fr', 'it', 'pt']) {
      applyDateLocale(lng)
      const time = formatTime(SAMPLE)
      expect(time).toContain('14')
      expect(time).not.toMatch(/[AP]M/i)
    }
  })

  it('localizes weekday and month names in the day heading', () => {
    applyDateLocale('en')
    expect(formatDayHeading(SAMPLE)).toMatch(/Wednesday/)
    applyDateLocale('fr')
    expect(formatDayHeading(SAMPLE)).toMatch(/mercredi/)
    applyDateLocale('de')
    expect(formatDayHeading(SAMPLE)).toMatch(/Mittwoch/)
    applyDateLocale('zh-CN')
    expect(formatDayHeading(SAMPLE)).toMatch(/8月/)
    expect(formatDayHeading(SAMPLE)).toMatch(/星期三/)
  })

  // Polish and Ukrainian decline the month: genitive after a day number
  // ("12 sierpnia"), nominative when it stands alone ("sierpień 2026"). dayjs
  // handles the switch inside the locale, so a format that concatenated a
  // month name onto a day would regress to "12 sierpień" without failing
  // anything else.
  it('declines the month in Polish and Ukrainian', () => {
    applyDateLocale('pl')
    expect(formatDayHeading(SAMPLE)).toMatch(/środa, 12 sierpnia/)
    expect(formatMonthYear(SAMPLE)).toMatch(/^sierpień 2026/)
    applyDateLocale('uk')
    expect(formatDayHeading(SAMPLE)).toMatch(/середа, 12 серпня/)
    expect(formatMonthYear(SAMPLE)).toMatch(/^серпень 2026/)
  })

  it('orders the short month-and-day form per locale', () => {
    applyDateLocale('en')
    expect(formatMonthDay(SAMPLE)).toBe('Aug 12')
    applyDateLocale('fr')
    // "12 août", never "août 12" — the reason this does not use a fixed token.
    expect(formatMonthDay(SAMPLE)).toMatch(/^12/)
  })

  it('stamps date and time in the app language', () => {
    applyDateLocale('en')
    expect(formatDateTime(SAMPLE)).toMatch(/^Aug 12, 2026, 2:05\sPM$/)
    applyDateLocale('pl')
    expect(formatDateTime(SAMPLE)).toMatch(/12 sie/)
    expect(formatDateTime(SAMPLE)).toMatch(/14:05/)
    applyDateLocale('uk')
    expect(formatDateTime(SAMPLE)).toMatch(/12 серп/)
    expect(formatDateTime(SAMPLE)).toMatch(/14:05/)
  })

  it('zero-pads the hour in log timestamps so the column lines up', () => {
    const morning = '2026-08-02T09:05:00'
    applyDateLocale('en')
    expect(formatMonthDayTime(morning)).toMatch(/^Aug 2, 09:05\sAM$/)
    applyDateLocale('fr')
    expect(formatMonthDayTime(morning)).toMatch(/^2 août/)
    expect(formatMonthDayTime(morning)).toMatch(/09:05$/)
  })

  it('localizes the month-and-year label', () => {
    applyDateLocale('en')
    expect(formatMonthYear(SAMPLE)).toBe('August 2026')
    applyDateLocale('es')
    expect(formatMonthYear(SAMPLE).toLowerCase()).toContain('agosto')
  })

  it('re-formats after a locale change rather than serving a cached formatter', () => {
    applyDateLocale('en')
    const english = formatDate(SAMPLE)
    applyDateLocale('de')
    expect(formatDate(SAMPLE)).not.toBe(english)
    applyDateLocale('en')
    expect(formatDate(SAMPLE)).toBe(english)
  })
})

describe('time format preference', () => {
  it('follows the locale on auto', () => {
    expect(uses24HourClock()).toBe(false)
    applyDateLocale('de')
    expect(uses24HourClock()).toBe(true)
    expect(formatTime(SAMPLE)).toBe('14:05')
  })

  it('forces a 24-hour clock in English', () => {
    setTimeFormat('24')
    expect(uses24HourClock()).toBe(true)
    expect(formatTime(SAMPLE)).toBe('14:05')
    expect(formatDateTime(SAMPLE)).toContain('14:05')
    expect(formatMonthDayTime(SAMPLE)).toContain('14:05')
  })

  it('renders midnight as 00, never 24', () => {
    setTimeFormat('24')
    expect(formatTime('2026-08-12T00:05:00')).toBe('00:05')
  })

  it('forces a 12-hour clock in a 24-hour locale', () => {
    applyDateLocale('de')
    setTimeFormat('12')
    expect(uses24HourClock()).toBe(false)
    expect(formatTime(SAMPLE)).toMatch(/^2:05/)
  })

  it('leaves date-only formats alone', () => {
    const before = formatDate(SAMPLE)
    setTimeFormat('24')
    expect(formatDate(SAMPLE)).toBe(before)
  })

  it('samples each choice without changing the active one', () => {
    expect(formatTimeSample(SAMPLE, '24')).toBe('14:05')
    expect(formatTimeSample(SAMPLE, '12')).toMatch(/2:05\s?PM/i)
    expect(getTimeFormat()).toBe('auto')
  })

  it('persists and reloads the choice', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
    })
    setTimeFormat('24')
    expect(store.get('lg-time-format')).toBe('24')
    store.set('lg-time-format', 'bogus')
    loadTimeFormat()
    expect(getTimeFormat()).toBe('24')
    store.set('lg-time-format', '12')
    loadTimeFormat()
    expect(getTimeFormat()).toBe('12')
  })
})

describe('week start', () => {
  // The region the browser reports, which is what actually decides this.
  function inRegion(tag: string | undefined): void {
    vi.stubGlobal('navigator', tag === undefined ? {} : { languages: [tag], language: tag })
  }

  it('follows the region, not the UI language (issue #272)', () => {
    // English UI in a Monday-first country: the reported case.
    inRegion('en-DE')
    applyDateLocale('en')
    expect(firstDayOfWeek()).toBe(1)

    // And the inverse: Spanish UI in a Sunday-first country.
    inRegion('es-MX')
    applyDateLocale('es')
    expect(firstDayOfWeek()).toBe(0)
  })

  it('keeps the familiar answer where region and language agree', () => {
    inRegion('en-US')
    applyDateLocale('en')
    expect(firstDayOfWeek()).toBe(0)
    inRegion('de-DE')
    applyDateLocale('de')
    expect(firstDayOfWeek()).toBe(1)
  })

  it('falls back to the language default when the tag carries no region', () => {
    inRegion('de')
    applyDateLocale('de')
    expect(firstDayOfWeek()).toBe(1)
    inRegion('en')
    applyDateLocale('en')
    expect(firstDayOfWeek()).toBe(0)
  })

  it('falls back to the language default when the platform reports nothing at all', () => {
    inRegion(undefined)
    applyDateLocale('fr')
    expect(firstDayOfWeek()).toBe(1)
    applyDateLocale('en')
    expect(firstDayOfWeek()).toBe(0)
  })

  it('does not let one region leak into the next locale switch', () => {
    // updateLocale mutates the shared locale object, so a Sunday-first region
    // must not still be in force after moving to a locale it never applied to.
    inRegion('en-US')
    applyDateLocale('fr')
    expect(firstDayOfWeek()).toBe(0)
    inRegion(undefined)
    applyDateLocale('fr')
    expect(firstDayOfWeek()).toBe(1)
  })

  it('moves dayjs arithmetic with it, which is what the grids are built from', () => {
    inRegion('en-US')
    applyDateLocale('en')
    expect(dayjs(SAMPLE).startOf('week').day()).toBe(0)
    inRegion('fr-FR')
    applyDateLocale('fr')
    expect(dayjs(SAMPLE).startOf('week').day()).toBe(1)
  })

  it('rotates the weekday labels to match that week order', () => {
    inRegion('en-US')
    applyDateLocale('en')
    expect(weekdayMinLabels()).toHaveLength(7)
    expect(weekdayMinLabels()[0]).toBe('Su')
    inRegion('fr-FR')
    applyDateLocale('fr')
    const fr = weekdayMinLabels()
    expect(fr).toHaveLength(7)
    expect(fr[0]).toBe('lu') // Monday leads, and the label is French
    expect(fr[6]).toBe('di')

    // The English labels rotate too when the region says Monday — the header
    // has to line up with the grid, whatever language it is written in.
    inRegion('en-GB')
    applyDateLocale('en')
    expect(weekdayMinLabels()[0]).toBe('Mo')
    expect(weekdayMinLabels()[6]).toBe('Su')
  })

  it('reports the real weekday for a row offset, so labels land on the right rows', () => {
    inRegion('en-US')
    applyDateLocale('en')
    // Sunday-start: row 1 is Monday.
    expect(weekdayAtOffset(1).weekday).toBe(1)
    inRegion('fr-FR')
    applyDateLocale('fr')
    // Monday-start: Monday is row 0 instead.
    expect(weekdayAtOffset(0).weekday).toBe(1)
    expect(weekdayAtOffset(6).weekday).toBe(0)
  })
})

// Called with no locale, `undefined` or `[]`, these format in the browser's
// language, not the app's: the sync "Last synced" stamps, the build date in
// Help and the activity log all did, so a Polish UI on an English-language
// phone showed "Oct 6, 2026". Dates go through this module instead.
describe('nothing is formatted in the browser locale', () => {
  const SRC = join(__dirname, '..')
  // Matched against whole files, so a call wrapped onto the next line counts.
  const DEFAULT_LOCALE =
    /\.toLocale(?:Date|Time)?String\(\s*(?:\)|undefined\b|\[\s*\])|new Intl\.\w+Format\(\s*(?:\)|undefined\b|\[\s*\])/g
  const sources = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))

  it('scans the app sources', () => {
    expect(sources).toContain(join('components', 'HelpModal', 'HelpModal.tsx'))
  })

  it('finds no call that leaves the locale to the browser', () => {
    const hits = sources.flatMap((file) => {
      const text = readFileSync(join(SRC, file), 'utf8')
      return [...text.matchAll(DEFAULT_LOCALE)].map(
        (m) => `  ${file}:${text.slice(0, m.index).split('\n').length}: ${m[0].replace(/\s+/g, ' ')}`,
      )
    })
    expect(
      hits,
      `Formatted with the browser locale; use src/utils/datetime.ts for dates, ` +
        `or pass getActiveLocale() for anything else:\n${hits.join('\n')}`,
    ).toEqual([])
  })
})
