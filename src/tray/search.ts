import type { DesktopTrayChore } from '@/native/desktop'

// The tray popup's chore search (docs/desktop-app.md, section 7): a live
// filter over every chore the snapshot carries. Each word typed must appear in
// the chore's name or its category, ignoring case and accents, so "litter"
// finds every Litterbox chore and "kitch mop" finds "Mop" in Kitchen. Due
// chores come first, most overdue first, as in the due list.

export const SEARCH_LIMIT = 50

const STATE_RANK: Record<DesktopTrayChore['state'], number> = { overdue: 0, soon: 1, fresh: 2, none: 3 }

/** Lower-case, without accents: "Café" -> "cafe". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

export function searchChores(chores: readonly DesktopTrayChore[], query: string, limit = SEARCH_LIMIT): DesktopTrayChore[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return chores
    .filter((c) => {
      const haystack = fold(`${c.name} ${c.categoryName ?? ''}`)
      return words.every((w) => haystack.includes(w))
    })
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (b.ratio ?? -1) - (a.ratio ?? -1) || a.name.localeCompare(b.name))
    .slice(0, limit)
}
