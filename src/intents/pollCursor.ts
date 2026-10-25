// The filename cursor the file-tier intent polls (WebDAV, iCloud) keep, and
// how far behind it they look again.

/**
 * How far back to look behind the stored cursor when filtering events. Covers
 * a device that uploads an event stamped earlier than one already processed
 * (out-of-order delivery); the dedupe on each event guards the window.
 */
export const CURSOR_LOOKBACK_MS = 60 * 60 * 1000

/** A filename timestamp (yyyymmddThhmmssZ) moved back by windowMs. */
export function cursorLookback(cursor: string, windowMs: number): string {
  const iso = cursor.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    '$1-$2-$3T$4:$5:$6Z',
  )
  const adjusted = new Date(new Date(iso).getTime() - windowMs)
  return adjusted.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}
