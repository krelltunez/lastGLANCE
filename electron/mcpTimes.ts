// Times on the MCP surface are the user's local time (docs/mcp-tools-reference.md,
// Conventions). The app stores instants as UTC ISO strings ("...Z"), and a
// completion at 9 pm on a Friday in Denver reads as Saturday in UTC: a model
// reading those strings gets the day wrong. So every instant a tool or a
// resource returns is rewritten here, once, as wall-clock time in the server's
// zone with its offset ("2026-11-13T19:30:00-07:00"): the same instant, read
// the way the user reads it. Dates (YYYY-MM-DD) are already local and stay.
//
// It runs at the server's edge (withLocalTimes in mcpServer.ts), over every
// result, so a tool added later is covered without knowing about it. Only
// fields named like times (…_at, …_until) are rewritten, and only when the
// whole value is an ISO instant: a note that happens to hold a timestamp is
// the user's text and is never touched.
//
// Inputs take either an ISO instant with a zone or a local wall-clock time
// ("2026-11-13 19:30", dayGLANCE's form), read in the same zone.

/** A whole ISO 8601 instant: date, time, and a zone (Z or an offset). */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** A local wall-clock time with no zone: "2026-11-13 19:30", "2026-11-13T19:30" or with seconds. */
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
/** Field names that hold instants. */
const TIME_KEY = /(_at|_until)$|^at$/;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(ms: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** The zone's offset from UTC at an instant, in minutes (Denver in winter: -420). */
function offsetMinutes(ms: number, timeZone: string): number {
  const p = partsIn(ms, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** An instant as local wall-clock time in the zone, with its offset, to the second. */
export function toLocalIso(ms: number, timeZone: string): string {
  const p = partsIn(ms, timeZone);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${offsetText(offsetMinutes(ms, timeZone))}`;
}

/** Every instant in a result, in local time; everything else as it was. Returns a new value. */
export function localizeTimes(value: unknown, timeZone: string, key = ''): unknown {
  if (typeof value === 'string') {
    if (!TIME_KEY.test(key) || !ISO_INSTANT.test(value)) return value;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : toLocalIso(ms, timeZone);
  }
  if (Array.isArray(value)) return value.map((v) => localizeTimes(v, timeZone, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localizeTimes(v, timeZone, k)]));
  }
  return value;
}

/**
 * A time a tool was given, as an ISO instant with an offset, or null when it is
 * neither form. A wall-clock time is read in the zone; in the hour a DST change
 * repeats, the first of the two is meant, and in the hour it skips, the time
 * after the gap.
 */
export function parseTimeInput(input: string, timeZone: string): string | null {
  if (ISO_INSTANT.test(input)) return Number.isNaN(Date.parse(input)) ? null : input;
  const m = LOCAL_TIME.exec(input);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null; // 2026-02-30
  // The zone's offsets either side of this day (equal unless DST changes in
  // between): the readings that land on the wall-clock time asked for are the
  // candidates, two in the repeated hour, of which the earlier is meant. None
  // lands in the skipped hour: the offset from before the change reads it as
  // the same distance past the gap (2:30 becomes 3:30).
  const before = offsetMinutes(wall - 86_400_000, timeZone);
  const after = offsetMinutes(wall + 86_400_000, timeZone);
  const wanted = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  const fits = [before, after].map((o) => wall - o * 60_000).filter((ms) => toLocalIso(ms, timeZone).startsWith(wanted));
  return toLocalIso(fits.length ? Math.min(...fits) : wall - before * 60_000, timeZone);
}

type ToolResult = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** A tool's result with its times localized: the structured content and the text that mirrors it. */
export function localizeToolResult<T>(result: T, timeZone: string): T {
  const r = result as ToolResult;
  if (!r || typeof r !== 'object' || r.isError || !r.structuredContent) return result;
  const structured = localizeTimes(r.structuredContent, timeZone) as Record<string, unknown>;
  return {
    ...r,
    structuredContent: structured,
    content: (r.content ?? []).map((c) => (c.type === 'text' ? { ...c, text: JSON.stringify(structured) } : c)),
  } as T;
}

type ResourceResult = { contents?: { mimeType?: string; text?: string }[] };

/** A resource's JSON bodies with their times localized. */
export function localizeResourceResult<T>(result: T, timeZone: string): T {
  const r = result as ResourceResult;
  if (!r || typeof r !== 'object' || !Array.isArray(r.contents)) return result;
  return {
    ...r,
    contents: r.contents.map((c) => {
      if (c.mimeType !== 'application/json' || typeof c.text !== 'string') return c;
      try { return { ...c, text: JSON.stringify(localizeTimes(JSON.parse(c.text), timeZone)) }; } catch { return c; }
    }),
  } as T;
}
