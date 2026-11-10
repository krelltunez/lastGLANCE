// The operating system's clock and week settings, for the app's "Automatic"
// time format and week start (src/utils/datetime.ts). Chromium formats with
// the app's language, so an English app on a Mac set to 24-hour time showed a
// 12-hour clock: the OS setting never reached it. The phone shells answer the
// same questions from their own APIs (WidgetBridge.systemClock and
// systemWeekStart).
//
//  - macOS: the 24-hour switch in System Settings is the AppleICUForce24HourTime
//    (or ...12HourTime) user default; otherwise the region's own clock. The
//    first day of the week is AppleFirstWeekday's gregorian entry (1 = Sunday);
//    otherwise the region's.
//  - Windows: the short time pattern and first day in the user's regional
//    settings (HKCU\Control Panel\International: sShortTime, iFirstDayOfWeek,
//    0 = Monday).
//  - Linux: the LC_TIME locale (else LC_ALL, else LANG).
//
// Each answer is null when the OS cannot say, and the app falls back to its
// language. Pure parsing here; the reads are injected.

export interface SystemFormats {
  hour24: boolean | null;
  /** 0 = Sunday … 6 = Saturday. */
  weekStart: number | null;
}

/** A clock pattern's cycle: H/k are 24-hour, h/K 12-hour. Quoted text is skipped. */
export function hour24FromPattern(pattern: unknown): boolean | null {
  if (typeof pattern !== 'string') return null;
  const bare = pattern.replace(/'[^']*'/g, '');
  if (/[Hk]/.test(bare)) return true;
  if (/[hK]/.test(bare)) return false;
  return null;
}

/** A BCP 47 tag from a POSIX locale ("en_GB.UTF-8@euro" -> "en-GB"), or null. */
export function tagFromPosixLocale(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value === 'C' || value === 'POSIX') return null;
  const tag = value.split(/[.@]/)[0].replace(/_/g, '-');
  try { return new Intl.Locale(tag).toString(); } catch { return null; }
}

/** The region's own clock for a locale tag. */
export function hour24FromLocale(tag: string | null): boolean | null {
  if (!tag) return null;
  try {
    const cycle = new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h23' || cycle === 'h24' ? true : cycle === 'h11' || cycle === 'h12' ? false : null;
  } catch {
    return null;
  }
}

/** The region's first day of the week for a locale tag (0 = Sunday), when it names a region. */
export function weekStartFromLocale(tag: string | null): number | null {
  if (!tag) return null;
  try {
    const locale = new Intl.Locale(tag) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    if (!locale.region) return null;
    const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
    return typeof info?.firstDay === 'number' ? info.firstDay % 7 : null;
  } catch {
    return null;
  }
}

export interface MacDefaults {
  force24: boolean;
  force12: boolean;
  /** AppleFirstWeekday's gregorian entry, 1 = Sunday, or null. */
  firstWeekday: number | null;
  /** The system locale, e.g. "en-US". */
  locale: string | null;
}

export function macFormats(d: MacDefaults): SystemFormats {
  const hour24 = d.force24 ? true : d.force12 ? false : hour24FromLocale(d.locale);
  const weekStart = d.firstWeekday !== null && d.firstWeekday >= 1 && d.firstWeekday <= 7
    ? d.firstWeekday - 1
    : weekStartFromLocale(d.locale);
  return { hour24, weekStart };
}

/** `reg query` output's REG_SZ / REG_DWORD value for a name. */
export function regValue(output: string, name: string): string | null {
  const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'mi').exec(output);
  return m ? m[1] : null;
}

export function windowsFormats(regOutput: string, locale: string | null): SystemFormats {
  const hour24 = hour24FromPattern(regValue(regOutput, 'sShortTime')) ?? hour24FromLocale(locale);
  const first = Number.parseInt(regValue(regOutput, 'iFirstDayOfWeek') ?? '', 10);
  const weekStart = Number.isInteger(first) && first >= 0 && first <= 6 ? (first + 1) % 7 : weekStartFromLocale(locale);
  return { hour24, weekStart };
}

export function linuxFormats(env: Record<string, string | undefined>): SystemFormats {
  const tag = tagFromPosixLocale(env.LC_TIME) ?? tagFromPosixLocale(env.LC_ALL) ?? tagFromPosixLocale(env.LANG);
  return { hour24: hour24FromLocale(tag), weekStart: weekStartFromLocale(tag) };
}
