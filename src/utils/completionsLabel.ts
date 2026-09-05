import type { TFunction } from 'i18next'

/**
 * "3 completions" / "1 completion" / "No completions" for a heatmap cell.
 *
 * Zero takes its own key rather than a `_zero` plural suffix: no shipped
 * language has a CLDR zero plural category (locales.test.ts pins this), so a
 * count of 0 would fall through to the `_other` form and read as
 * "0 completions".
 *
 * Shared by both heatmaps — the header one and the per-chore one in LogModal —
 * so their cells describe themselves identically.
 */
export function completionsLabel(t: TFunction, count: number): string {
  return count === 0
    ? t('heatmap.noCompletions')
    : t('heatmap.completions', { count })
}
