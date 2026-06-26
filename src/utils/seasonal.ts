import type { Chore } from '@/types'

// True when a chore is within its active seasonal window (or has no window set).
// `seasonal_start`/`seasonal_end` are "MM-DD" strings; a window whose start is
// after its end wraps across the new year (e.g. 11-01 → 02-28).
export function isInSeasonalWindow(
  chore: Pick<Chore, 'seasonal_start' | 'seasonal_end'>,
  now: Date = new Date(),
): boolean {
  if (!chore.seasonal_start || !chore.seasonal_end) return true
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const s = chore.seasonal_start
  const e = chore.seasonal_end
  return s <= e ? today >= s && today <= e : today >= s || today <= e
}
