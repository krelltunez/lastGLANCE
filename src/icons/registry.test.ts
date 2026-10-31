import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '../../public/locales/en/translation.json'
import { ICON_REGISTRY, ICON_NAMES, ICON_GROUPS, ALL_GROUPS } from './registry'

// The picker renders each group's name from iconPicker.groups.<id>. A group
// added here without that key would show its raw key path; the locale parity
// test then carries the requirement into every other language.
describe('icon groups', () => {
  it('has an English name for every group id', () => {
    const names: Record<string, string> = en.iconPicker.groups
    const missing = ICON_GROUPS.map((g) => g.id).filter((id) => !names[id])
    expect(missing).toEqual([])
  })

  it('uses each id once', () => {
    const ids = ICON_GROUPS.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/**
 * lucide exports 4042 icon names for 1767 components — every component has at
 * least two spellings, and 243 have more than one plain spelling. This file
 * used to serve resolution and display from one map deduplicated by component
 * reference, which threw away whichever alias `Object.entries` yielded second.
 *
 * The two jobs are now separate, and the tests below are split the same way:
 *
 *   ICON_REGISTRY  every spelling resolves. Keyed lookup only. Additive, so no
 *                  icon name already stored in user data changes meaning.
 *   ICON_NAMES     one name per component, for anything that lists icons.
 *
 * lucide-react is pinned exactly in package.json because enumeration order used
 * to decide which names worked. It no longer does — that is the point of the
 * split — but the pin also keeps the baselines below stable, so a bump has to
 * be a deliberate act with a re-measure attached.
 */

describe('ICON_REGISTRY, the resolution table', () => {
  it('carries every alias, not one name per component', () => {
    expect(Object.keys(ICON_REGISTRY).length).toBeGreaterThan(ICON_NAMES.length)
  })

  it.each([
    ['Mail', 'LucideMail'],
    ['PawPrint', 'LucidePawPrint'],
    ['Home', 'House'],
    ['BarChart', 'ChartNoAxesColumnIncreasing'],
  ])('resolves %s and %s to the same component', (plain, alias) => {
    // Each pair is one icon under two names. Before the split, one of each pair
    // resolved and the other was simply absent, which is what silently blanked
    // icons in stored data and emptied half the picker's categories.
    expect(ICON_REGISTRY[plain], `${plain} must resolve`).toBeTruthy()
    expect(ICON_REGISTRY[alias], `${alias} must resolve`).toBeTruthy()
    expect(ICON_REGISTRY[plain]).toBe(ICON_REGISTRY[alias])
  })
})

describe('ICON_NAMES, the display list', () => {
  it('is exactly one name per distinct component', () => {
    // The invariant that replaces "ICON_NAMES is the registry key set", which
    // stopped holding when the registry started carrying aliases.
    expect(new Set(Object.values(ICON_REGISTRY)).size).toBe(ICON_NAMES.length)
    expect(new Set(ICON_NAMES.map((n) => ICON_REGISTRY[n])).size).toBe(ICON_NAMES.length)
  })

  it('resolves every name it offers', () => {
    expect(ICON_NAMES.filter((n) => !ICON_REGISTRY[n])).toEqual([])
  })

  it('never offers a Lucide-prefixed alias', () => {
    // These were what the picker's tooltips read before: "LucideMail".
    expect(ICON_NAMES.filter((n) => n.startsWith('Lucide'))).toEqual([])
  })
})

/**
 * Eleven authored names are not in lucide 1.31.0 under any spelling — real
 * removals, not alias shadowing, and dropped before this change as well. They
 * are listed rather than counted so that a bump which removes a twelfth names
 * the casualty instead of just moving a number.
 */
const REMOVED_FROM_LUCIDE = [
  'Braille', 'Delta', 'Function', 'FolderUser', 'HandBraille', 'Lemon',
  'Messages', 'NotEqual', 'Packages', 'Paperclips', 'Wheelchair',
]

describe('the authored taxonomy', () => {
  const authored = [...new Set(ALL_GROUPS.flatMap((g) => g.icons))]

  it('still has the shape these baselines were measured against', () => {
    expect(ALL_GROUPS.length).toBe(33)
    expect(authored.length).toBe(1089)
  })

  it('loses only the names lucide has actually removed', () => {
    // Was 523 before the split: 512 of those were alias-shadowed and came back.
    expect(authored.filter((n) => !(n in ICON_REGISTRY)).sort()).toEqual([...REMOVED_FROM_LUCIDE].sort())
  })
})

describe('ICON_GROUPS, what the picker browses', () => {
  const componentsOf = (names: string[]) =>
    new Set(names.map((n) => ICON_REGISTRY[n]).filter(Boolean))

  it('keeps every authored icon that resolves, in its own group', () => {
    // The real version of the assertion that used to be vacuous. It compares
    // each group against its AUTHORED source, so canonicalising to display
    // names and deduplicating cannot quietly lose an icon from a category.
    const lost: string[] = []
    for (const authoredGroup of ALL_GROUPS) {
      const shown = ICON_GROUPS.find((g) => g.id === authoredGroup.id)
      const want = componentsOf(authoredGroup.icons)
      const got = componentsOf(shown?.icons ?? [])
      for (const c of want) if (!got.has(c)) lost.push(authoredGroup.id)
    }
    expect(lost).toEqual([])
  })

  it('shows no component twice within one group', () => {
    // The authored list names two aliases of one component in the same group 33
    // times (Home/House, most of the chart family). Once both spellings
    // resolve, without the dedup those draw the same icon twice side by side.
    const offenders: string[] = []
    for (const group of ICON_GROUPS) {
      const seen = new Map<unknown, string[]>()
      for (const name of group.icons) {
        const component = ICON_REGISTRY[name]
        const names = seen.get(component) ?? []
        names.push(name)
        seen.set(component, names)
      }
      for (const names of seen.values()) {
        if (names.length > 1) offenders.push(`${group.id}: ${names.join(' = ')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('shows every icon under its display name', () => {
    const wrong = ICON_GROUPS.flatMap((g) => g.icons).filter((n) => !ICON_NAMES.includes(n))
    expect(wrong).toEqual([])
  })
})

describe('the icon names the app itself ships', () => {
  // Read as source rather than imported: the seed arrays and the v15 patch maps
  // are module-private, and exporting them to satisfy a test would be the tail
  // wagging the dog. The count assertions catch a refactor that moves them.
  const client = readFileSync(join(__dirname, '../db/client.ts'), 'utf8')

  // `icon: 'Home'` — SEED_CATEGORIES and SEED_CHORES.
  const seeded = [...client.matchAll(/\bicon:\s*'([^']+)'/g)].map((m) => m[1])
  // `'00000000-...-000000000001': 'Home',` — the v15 migration's icon patch
  // maps, which exist because this dedup already bit the seed data once.
  const patched = [...client.matchAll(/'[0-9a-f-]{36}':\s*'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1])

  // The hand-maintained demo fixture, imported through Settings > Backup &
  // Restore. Five of its names (House, Utensils, WashingMachine, Sprout,
  // PawPrint) did not resolve before the split and now do, unedited.
  const demo = JSON.parse(readFileSync(join(__dirname, '../../public/demo-backup.json'), 'utf8')) as {
    categories: { icon?: string }[]
    chores: { icon?: string }[]
  }
  const fixture = [...demo.categories, ...demo.chores].map((r) => r.icon).filter(Boolean) as string[]

  it('found the literals to check', () => {
    expect(seeded.length).toBeGreaterThan(10)
    expect(patched.length).toBeGreaterThan(10)
    expect(fixture.length).toBeGreaterThan(20)
  })

  // Nothing launders these. Every new install sees the seed, so a miss there is
  // a first-run screen of blank icons.
  it.each([
    ['seed data', () => seeded],
    ['the v15 icon migration', () => patched],
    ['public/demo-backup.json', () => fixture],
  ])('resolves every icon name in %s', (_label, get) => {
    const broken = [...new Set(get().filter((n) => !ICON_REGISTRY[n]))]
    expect(broken).toEqual([])
  })
})
