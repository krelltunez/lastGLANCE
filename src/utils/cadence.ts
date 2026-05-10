import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

/**
 * Returns elapsed / target, unclamped. Values < 1 = within cadence, >= 1 = overdue.
 * Bar width clamps this to 100% in the UI; color uses the unclamped value.
 */
export function getFillRatio(elapsedDays: number, targetDays: number): number {
  return elapsedDays / targetDays
}

/**
 * Within cadence (ratio 0→1): green → amber.
 * Overdue (ratio 1→2+): amber → red. Full red at 2× overdue.
 *
 * This means red = actually overdue, not merely approaching the deadline.
 */
export function getCadenceColor(ratio: number): string {
  if (ratio < 1) {
    return interpolateHex('#22c55e', '#f59e0b', ratio)
  } else {
    const t = Math.min(ratio - 1, 1)
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
