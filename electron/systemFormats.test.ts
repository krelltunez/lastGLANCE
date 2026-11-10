import { describe, expect, it } from 'vitest';
import {
  hour24FromLocale, hour24FromPattern, linuxFormats, macFormats, regValue, tagFromPosixLocale, weekStartFromLocale, windowsFormats,
} from './systemFormats';

describe('the system clock and week', () => {
  it('reads a clock pattern', () => {
    expect(hour24FromPattern('HH:mm')).toBe(true);
    expect(hour24FromPattern('h:mm tt')).toBe(false);
    expect(hour24FromPattern("'h' HH:mm")).toBe(true);          // quoted text is not a field
    expect(hour24FromPattern('mm:ss')).toBeNull();
    expect(hour24FromPattern(undefined)).toBeNull();
  });

  it('reads a region\'s own clock and week', () => {
    expect(hour24FromLocale('en-US')).toBe(false);
    expect(hour24FromLocale('en-GB')).toBe(true);
    expect(weekStartFromLocale('en-US')).toBe(0);
    expect(weekStartFromLocale('de-DE')).toBe(1);
    expect(weekStartFromLocale('en')).toBeNull();                  // no region: nothing to say
  });

  it('on macOS, the 24-hour switch wins over the region', () => {
    // The reported case: an English (US) Mac with 24-hour time switched on.
    expect(macFormats({ force24: true, force12: false, firstWeekday: null, locale: 'en-US' })).toEqual({ hour24: true, weekStart: 0 });
    expect(macFormats({ force24: false, force12: true, firstWeekday: null, locale: 'en-GB' }).hour24).toBe(false);
    expect(macFormats({ force24: false, force12: false, firstWeekday: 2, locale: 'en-US' })).toEqual({ hour24: false, weekStart: 1 });
  });

  it('on Windows, reads the regional settings', () => {
    const out = [
      'HKEY_CURRENT_USER\\Control Panel\\International',
      '    sShortTime    REG_SZ    HH:mm',
      '    iFirstDayOfWeek    REG_SZ    0',
    ].join('\r\n');
    expect(regValue(out, 'sShortTime')).toBe('HH:mm');
    expect(windowsFormats(out, 'en-US')).toEqual({ hour24: true, weekStart: 1 });
    expect(windowsFormats('', 'en-US')).toEqual({ hour24: false, weekStart: 0 });   // unreadable: the locale's
  });

  it('on Linux, reads LC_TIME before LC_ALL and LANG', () => {
    expect(tagFromPosixLocale('en_GB.UTF-8')).toBe('en-GB');
    expect(tagFromPosixLocale('C')).toBeNull();
    expect(linuxFormats({ LANG: 'en_US.UTF-8', LC_TIME: 'en_GB.UTF-8' })).toEqual({ hour24: true, weekStart: 1 });
    expect(linuxFormats({ LANG: 'en_US.UTF-8' })).toEqual({ hour24: false, weekStart: 0 });
    expect(linuxFormats({})).toEqual({ hour24: null, weekStart: null });
  });
});
