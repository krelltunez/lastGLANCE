import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

/**
 * Returns a 0–1 fill ratio based on elapsed vs target cadence.
 * Clamps at 1 (never goes negative or over 1 for the bar itself).
 */
export function getFillRatio(elapsedDays: number, targetDays: number): number {
  return Math.min(elapsedDays / targetDays, 1)
}

/**
 * Interpolates through fresh (green) → mid (amber) → stale (red).
 * ratio: 0 = just done, 1 = at/past cadence target.
 */
export function getCadenceColor(ratio: number): string {
  if (ratio <= 0.5) {
    // green → amber
    const t = ratio / 0.5
    return interpolateHex('#22c55e', '#f59e0b', t)
  } else {
    // amber → red
    const t = (ratio - 0.5) / 0.5
    return interpolateHex('#f59e0b', '#ef4444', t)
  }
}

function interpolateHex(a: string, b: string, t: number): string {
  const ra = parseInt(a.slice(1, 3), 16)
  const ga = parseInt(a.slice(3, 5), 16)
  const ba = parseInt(a.slice(5, 7), 16)
  const rb = parseInt(b.slice(1, 3), 16)
  const gb = parseInt(b.slice(3, 5), 16)
  const bb = parseInt(b.slice(5, 7), 16)
  const r = Math.round(ra + (rb - ra) * t)
  const g = Math.round(ga + (gb - ga) * t)
  const bv = Math.round(ba + (bb - ba) * t)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bv.toString(16).padStart(2, '0')}`
}

export function formatElapsed(elapsedDays: number | null, lastCompletedAt: string | null): string {
  if (elapsedDays === null || lastCompletedAt === null) return 'never'
  const diffMinutes = dayjs().diff(dayjs(lastCompletedAt), 'minute')
  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (elapsedDays < 1) {
    const diffHours = Math.floor(diffMinutes / 60)
    return `${diffHours}h ago`
  }
  if (elapsedDays < 2) return 'yesterday'
  return `${Math.floor(elapsedDays)}d ago`
}
