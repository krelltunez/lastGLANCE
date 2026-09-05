import { describe, it, expect, afterEach, vi } from 'vitest'
import dayjs from 'dayjs'
import {
  applyDateLocale,
  getActiveLocale,
  formatDate,
  formatTime,
  formatDayHeading,
  formatMonthDay,
  formatMonthYear,
  firstDayOfWeek,
  weekdayMinLabels,
  weekdayAtOffset,
} from './datetime'

// A Wednesday, deliberately in the afternoon so the 12-/24-hour split shows.
const SAMPLE = '2026-08-12T14:05:00'

afterEach(() => {
  vi.unstubAllGlobals()
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

  it('orders the short month-and-day form per locale', () => {
    applyDateLocale('en')
    expect(formatMonthDay(SAMPLE)).toBe('Aug 12')
    applyDateLocale('fr')
    // "12 août", never "août 12" — the reason this does not use a fixed token.
    expect(formatMonthDay(SAMPLE)).toMatch(/^12/)
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
