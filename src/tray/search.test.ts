import { describe, expect, it } from 'vitest'
import { fold, searchChores } from './search'
import type { DesktopTrayChore } from '@/native/desktop'

const chore = (syncId: string, name: string, state: DesktopTrayChore['state'], ratio: number | null, categoryName: string | null = null): DesktopTrayChore =>
  ({ syncId, name, icon: null, categoryName, state, lastCompletedAt: null, elapsedDays: null, targetCadenceDays: null, ratio, color: null })

const CHORES = [
  chore('a', 'Clean litterboxes', 'fresh', 0.1, 'Basement'),
  chore('b', 'Litterbox deep clean', 'overdue', 1.4, 'Basement'),
  chore('c', 'Mop', 'soon', 0.9, 'Kitchen'),
  chore('d', 'Café grinder', 'none', null, 'Kitchen'),
  chore('e', 'Water the ferns', 'fresh', 0.3, 'Plants'),
]

describe('the tray popup search', () => {
  it('finds every chore whose name has the text, ignoring case', () => {
    expect(searchChores(CHORES, 'litter').map((c) => c.syncId)).toEqual(['b', 'a'])
    expect(searchChores(CHORES, 'LITTER').map((c) => c.syncId)).toEqual(['b', 'a'])
  })

  it('puts due chores first, most overdue first', () => {
    expect(searchChores(CHORES, 'e').map((c) => c.state)).toEqual(['overdue', 'soon', 'fresh', 'fresh', 'none'])
  })

  it('matches every word across the name and the category', () => {
    expect(searchChores(CHORES, 'kitch mop').map((c) => c.syncId)).toEqual(['c'])
    expect(searchChores(CHORES, 'basement deep').map((c) => c.syncId)).toEqual(['b'])
    expect(searchChores(CHORES, 'mop plants')).toEqual([])
  })

  it('ignores accents both ways', () => {
    expect(fold('Café')).toBe('cafe')
    expect(searchChores(CHORES, 'cafe').map((c) => c.syncId)).toEqual(['d'])
    expect(searchChores(CHORES, 'grinder café').map((c) => c.syncId)).toEqual(['d'])
  })

  it('returns nothing for an empty query, and caps the results', () => {
    expect(searchChores(CHORES, '   ')).toEqual([])
    const many = Array.from({ length: 80 }, (_, i) => chore(`x${i}`, `Task ${i}`, 'fresh', 0.5))
    expect(searchChores(many, 'task')).toHaveLength(50)
  })
})
