import dayjs from 'dayjs'
import localeData from 'dayjs/plugin/localeData'
import updateLocale from 'dayjs/plugin/updateLocale'

// Locales are imported statically rather than on demand. They are ~1KB each,
// and a dynamic import would land after i18next has already told React to
// re-render for the new language — the app would paint one frame of dates in
// the old locale every time it changed. Synchronous switching removes the race.
import 'dayjs/locale/de'
import 'dayjs/locale/es'
import 'dayjs/locale/fr'
import 'dayjs/locale/it'
import 'dayjs/locale/pl'
import 'dayjs/locale/pt'
import 'dayjs/locale/pt-br'
import 'dayjs/locale/uk'
import 'dayjs/locale/zh-cn'

dayjs.extend(localeData)
dayjs.extend(updateLocale)

/**
 * Locale-aware date handling, split by responsibility:
 *
 *   • dayjs owns date *arithmetic*. Its locale decides where a week starts,
 *     which every calendar grid and heatmap column depends on — but the week
 *     start itself comes from the *region*, not the language (see
 *     regionWeekStart below), and is written into the locale on every switch.
 *   • Intl.DateTimeFormat owns date *display*. It is CLDR-correct in every
 *     locale for free, including things a hand-written dayjs token cannot get
 *     right: field order ("Aug 12" vs "12 août"), whether a comma belongs
 *     between weekday and date, and 12- versus 24-hour time.
 *
 * Formatting a date anywhere in the app goes through this module, so no
 * component has to know which locale is active.
 */

// Week info reached ES2020's lib typings after this project's target, and the
// two engine spellings of it are both still in the wild, so declare what we
// probe for rather than casting at the call site.
interface WeekInfo { firstDay: number }
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Intl {
    interface Locale {
      getWeekInfo?: () => WeekInfo
      weekInfo?: WeekInfo
    }
  }
}

// Full tags before base languages: pt-BR must land on dayjs's "pt-br", not be
// stripped to the generic (European) "pt". i18next reports regional tags for
// Portuguese (pt-PT, pt-BR) and Chinese (zh-CN); every other language is
// still a bare tag. A new regional locale needs its lower-cased dayjs name
// listed here, or it falls back to the base language's (or English's) format.
const SUPPORTED = ['de', 'es', 'fr', 'it', 'pl', 'pt', 'pt-br', 'uk', 'zh-cn'] as const

let activeLocale = 'en'

/**
 * The user's clock preference. 'auto' leaves the 12/24-hour choice to the
 * active locale (English is 12-hour, every other shipped language 24-hour);
 * '12' and '24' override it everywhere a time is shown. Device-local, like the
 * theme: it is a display preference, not data, so it is not synced.
 */
export type TimeFormat = 'auto' | '12' | '24'

const TIME_FORMAT_KEY = 'lg-time-format'
let timeFormat: TimeFormat = 'auto'

function isTimeFormat(v: unknown): v is TimeFormat {
  return v === 'auto' || v === '12' || v === '24'
}

/** Seed the clock preference from storage. Called once at startup. */
export function loadTimeFormat(): void {
  try {
    const saved = localStorage.getItem(TIME_FORMAT_KEY)
    if (isTimeFormat(saved)) timeFormat = saved
  } catch {
    // Storage blocked (private mode, tests): stay on the locale's own clock.
  }
}

export function getTimeFormat(): TimeFormat {
  return timeFormat
}

/**
 * Switch the clock. Synchronous for the same reason applyDateLocale is: the
 * caller re-renders right after, and the memoised formatters must already be
 * gone or that render paints the old clock.
 */
export function setTimeFormat(value: TimeFormat): void {
  timeFormat = value
  formatterCache.clear()
  try {
    localStorage.setItem(TIME_FORMAT_KEY, value)
  } catch {
    // Not persisted, but still applied for this session.
  }
}

// hourCycle rather than hour12: `hour12: false` resolves to h24 in some
// engines for some locales, which renders midnight as "24:05".
function hourCycleFor(pref: TimeFormat): Intl.DateTimeFormatOptions['hourCycle'] {
  return pref === '24' ? 'h23' : pref === '12' ? 'h12' : undefined
}

export function getActiveLocale(): string {
  return activeLocale
}

/**
 * Point date handling at a language. Safe to call with anything i18next
 * reports — a regional tag ("pt-BR"), an unsupported language, or undefined —
 * and falls back to English rather than throwing.
 *
 * Synchronous by design: it must complete before React re-renders for the new
 * language, or the first frame shows stale formatting.
 */
export function applyDateLocale(lng: string | undefined): void {
  const supported = SUPPORTED as readonly string[]
  // Prefer the exact regional locale when dayjs ships one (pt-BR -> "pt-br"),
  // fall back to the base language (de-AT -> "de"), then to English.
  const full = (lng ?? 'en').toLowerCase()
  const base = full.split('-')[0]
  activeLocale = supported.includes(full) ? full : supported.includes(base) ? base : 'en'
  dayjs.locale(activeLocale)
  // Read the language's own week start before overwriting it, so the first
  // switch into a locale always sees the pristine value.
  const languageDefault = localeDefaultWeekStart(activeLocale)
  // Written every time, and always to an explicit value: updateLocale mutates
  // the shared locale object permanently, so a later switch that fell through
  // to "leave it alone" would inherit whatever the previous one wrote.
  dayjs.updateLocale(activeLocale, { weekStart: regionWeekStart() ?? languageDefault })
  formatterCache.clear()
}

/**
 * Where the user's *region* starts the week, as a dayjs weekday (0 = Sunday).
 * Null when the platform cannot say — no region in the language tag, or an
 * engine without Intl week info — leaving the language's own default to stand.
 *
 * The region is what people actually mean by "my weeks start on Monday": the
 * UI language does not decide it, and using the language as a proxy gets it
 * wrong in both directions. Someone in Germany running the app in English was
 * shown Sunday-first weeks (issue #272), and every es/pt user was shown
 * Monday-first even in Mexico and Brazil, which are Sunday-first.
 */
function regionWeekStart(): number | null {
  const tag = typeof navigator !== 'undefined'
    ? (navigator.languages?.[0] ?? navigator.language)
    : undefined
  if (!tag) return null
  try {
    const locale = new Intl.Locale(tag)
    // The region alone decides this, so a tag without one ("de", "en") has
    // nothing to say and must not be answered from the language default —
    // Intl would happily invent a region for it.
    if (!locale.region) return null
    // getWeekInfo() is the current spec; older engines (and Node) expose the
    // same object as a `weekInfo` property.
    const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo
    const firstDay = info?.firstDay
    if (typeof firstDay !== 'number') return null
    // Intl numbers days 1 = Monday … 7 = Sunday; dayjs uses 0 = Sunday.
    return firstDay % 7
  } catch {
    return null
  }
}

// A locale's own week start, captured before anything overwrites it. Read on
// the first switch into each locale — while dayjs still holds the pristine
// value — so the fallback above stays truthful for the rest of the session.
const localeDefaults = new Map<string, number>()

function localeDefaultWeekStart(locale: string): number {
  const known = localeDefaults.get(locale)
  if (known !== undefined) return known
  const value = dayjs.localeData().firstDayOfWeek()
  localeDefaults.set(locale, value)
  return value
}

// Intl.DateTimeFormat construction is comparatively expensive and these run per
// row, so formatters are memoised. Cleared whenever the locale changes.
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  // Only formats that show an hour take the clock preference; a date-only
  // format must not change shape (or cache key) with it.
  const hourCycle = opts.hour ? hourCycleFor(timeFormat) : undefined
  const resolved = hourCycle ? { ...opts, hourCycle } : opts
  const key = JSON.stringify(resolved)
  let f = formatterCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(activeLocale, resolved)
    formatterCache.set(key, f)
  }
  return f
}

export type DateInput = string | number | Date | dayjs.Dayjs

function toDate(value: DateInput): Date {
  return dayjs(value).toDate()
}

/** "Aug 12, 2026" · "12 août 2026" */
export function formatDate(value: DateInput): string {
  return formatter({ year: 'numeric', month: 'short', day: 'numeric' }).format(toDate(value))
}

/**
 * "2:05 PM" in en, "14:05" everywhere else — Intl picks the clock per locale
 * unless the user chose one (setTimeFormat).
 */
export function formatTime(value: DateInput): string {
  return formatter({ hour: 'numeric', minute: '2-digit' }).format(toDate(value))
}

/**
 * Whether times are shown on a 24-hour clock: the user's choice, else the
 * active locale's (everything but en here).
 */
export function uses24HourClock(): boolean {
  return formatter({ hour: 'numeric' }).resolvedOptions().hour12 === false
}

/**
 * "2:05 PM" · "14:05" for a given clock choice, independent of the current
 * one, so a picker can label each option with what it would look like.
 */
export function formatTimeSample(value: DateInput, pref: TimeFormat): string {
  const hourCycle = hourCycleFor(pref)
  return new Intl.DateTimeFormat(activeLocale, {
    hour: 'numeric', minute: '2-digit', ...(hourCycle ? { hourCycle } : {}),
  }).format(toDate(value))
}

/** The locale's own "AM"/"PM" label (e.g. "上午"/"下午" in zh-CN). */
export function formatDayPeriod(am: boolean): string {
  const f = new Intl.DateTimeFormat(activeLocale, { hour: 'numeric', hour12: true, timeZone: 'UTC' })
  return f.formatToParts(new Date(Date.UTC(2024, 0, 1, am ? 9 : 15)))
    .find(p => p.type === 'dayPeriod')?.value ?? (am ? 'AM' : 'PM')
}

/** "Aug 12, 2026, 2:05 PM" · "12 août 2026, 14:05" */
export function formatDateTime(value: DateInput): string {
  return formatter({
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(toDate(value))
}

/** "Wednesday, August 12, 2026" · "mercredi 12 août 2026" (no comma in fr). */
export function formatDayHeading(value: DateInput): string {
  return formatter({
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }).format(toDate(value))
}

/** "Aug 12" · "12 août" — field order follows the locale. */
export function formatMonthDay(value: DateInput): string {
  return formatter({ month: 'short', day: 'numeric' }).format(toDate(value))
}

/**
 * "Aug 12, 02:05 PM" · "12 août, 14:05" — the hour is zero-padded so a column
 * of log timestamps lines up.
 */
export function formatMonthDayTime(value: DateInput): string {
  return formatter({
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(toDate(value))
}

/** "August 2026" · "août 2026" */
export function formatMonthYear(value: DateInput): string {
  return formatter({ month: 'long', year: 'numeric' }).format(toDate(value))
}

/** "Aug" · "août" */
export function formatMonthShort(value: DateInput): string {
  return formatter({ month: 'short' }).format(toDate(value))
}

/** 0 when the week starts on Sunday, 1 when it starts on Monday. */
export function firstDayOfWeek(): number {
  return dayjs.localeData().firstDayOfWeek()
}

/**
 * Two-letter weekday initials in the active locale's week order, so a calendar
 * header lines up with the columns dayjs's startOf('week') actually produces.
 */
export function weekdayMinLabels(): string[] {
  const sundayFirst = dayjs.weekdaysMin()
  const start = firstDayOfWeek()
  return Array.from({ length: 7 }, (_, i) => sundayFirst[(start + i) % 7])
}

/**
 * Single-letter initial for the weekday `offset` rows into the week, for the
 * heatmaps' sparse row labels. `weekday` is the real day number (0 = Sunday),
 * so a caller can ask "is this row Monday?" without assuming where the week
 * starts.
 */
export function weekdayAtOffset(offset: number): { weekday: number; narrow: string } {
  const weekday = (firstDayOfWeek() + offset) % 7
  // A known Sunday, advanced to the weekday we want — independent of today.
  const sunday = dayjs('2024-01-07')
  return {
    weekday,
    narrow: formatter({ weekday: 'narrow' }).format(sunday.add(weekday, 'day').toDate()),
  }
}
