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
 * ICON_REGISTRY is built at runtime from lucide-react's exports and
 * deduplicated BY COMPONENT REFERENCE, so where one icon is exported under
 * several aliases only the name `Object.entries` happens to yield first
 * survives. Today that is the `Lucide`-prefixed alias for 763 of the 1767
 * entries, which means `Mail`, `Map`, `MapPin`, `PawPrint` and 759 others are
 * not in the registry at all — only `LucideMail` and friends are.
 *
 * Nothing warns you. Every call site is `ICON_REGISTRY[name]` with a null
 * fallback (ChoreRow, CategorySection, SearchModal, JournalModal, Ribbon, both
 * form modals), so a name that stops resolving renders nothing and logs
 * nothing.
 *
 * Which alias wins depends on enumeration order in the INSTALLED lucide-react,
 * so an ordinary dependency bump can flip it. lucide-react is pinned exactly in
 * package.json for that reason. The suites below are the other half of that pin.
 */

describe('ICON_NAMES', () => {
  it('is exactly the registry key set', () => {
    expect([...ICON_NAMES].sort()).toEqual(Object.keys(ICON_REGISTRY).sort())
  })

  it('resolves every name it offers', () => {
    // The picker's search filters ICON_NAMES, so anything here is pickable.
    expect(ICON_NAMES.filter((n) => !ICON_REGISTRY[n])).toEqual([])
  })
})

describe('ICON_GROUPS', () => {
  it('offers only names that resolve', () => {
    // Note what this does and does not prove. ICON_GROUPS is ALL_GROUPS AFTER a
    // filter that drops anything absent from the registry, so this assertion
    // cannot fail while that filter exists. It is a tripwire for the filter
    // being removed, not for lucide changing underneath. The assertion with
    // teeth is the baseline below, against the authored list.
    const broken = [...new Set(ICON_GROUPS.flatMap((g) => g.icons).filter((n) => !ICON_REGISTRY[n]))]
    expect(broken).toEqual([])
  })
})

/**
 * The authored taxonomy, pre-filter. This is where the dedup actually shows up:
 * a curated name on the losing side is not a broken icon, it is an icon that
 * silently leaves its category and lands in the catch-all "other" bucket. A
 * reader browsing Animals for a paw print does not find one, because `PawPrint`
 * was dropped and `LucidePawPrint` went to "other" along with ~1200 others.
 *
 * The count is pinned rather than asserted to zero because 523 of the 1256
 * authored names are already on the losing side today. Fixing that belongs with
 * the dedup rule, not with this guard. What this catches is MOVEMENT: bump
 * lucide-react and flip which aliases win, and this number changes, and CI says
 * so before anyone ships a picker whose categories have quietly reshuffled.
 */
describe('the authored icon taxonomy', () => {
  const authored = ALL_GROUPS.flatMap((g) => g.icons)
  const shadowed = [...new Set(authored.filter((n) => !(n in ICON_REGISTRY)))]

  it('still has the shape this baseline was measured against', () => {
    expect(ALL_GROUPS.length).toBe(33)
    expect(authored.length).toBe(1256)
  })

  it('drops exactly the names it dropped when lucide-react was pinned', () => {
    expect(
      shadowed.length,
      'The set of lucide aliases that win has moved. If you just bumped ' +
        'lucide-react, every stored icon name on the newly-losing side stops ' +
        'rendering, silently, in real user data. Re-measure deliberately and ' +
        'update this number, or revert the bump.',
    ).toBe(523)
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

  it('found the literals to check', () => {
    expect(seeded.length).toBeGreaterThan(10)
    expect(patched.length).toBeGreaterThan(10)
  })

  // These are the ones with real teeth: nothing launders them, so a name on the
  // losing side fails here. Every new install sees the seed, so a miss is a
  // first-run screen of blank icons.
  it.each([
    ['seed data', () => seeded],
    ['the v15 icon migration', () => patched],
  ])('resolves every icon name in %s', (_label, get) => {
    const broken = [...new Set(get().filter((n) => !ICON_REGISTRY[n]))]
    expect(broken).toEqual([])
  })
})
