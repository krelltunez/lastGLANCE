// Which names lucide exports each icon under, shared by the native icon
// generators (gen-lucide-drawables.mjs, gen-lucide-swift.mjs). chore.icon can hold
// any of them, since ICON_REGISTRY in src/icons/registry.ts resolves them all, so
// each platform stores an icon once under canonicalName and maps the rest to it.

import * as Lucide from 'lucide-react'

// Mirror src/icons/registry.ts: every name of every real icon component, grouped
// by component, so an alias can never be mistaken for a second icon.
export function iconGroups() {
  const groups = new Map()
  for (const [name, val] of Object.entries(Lucide)) {
    if (
      name.endsWith('Icon') ||
      name === 'createLucideIcon' ||
      val === null ||
      typeof val !== 'object' ||
      !('$$typeof' in val)
    ) continue
    if (!groups.has(val)) groups.set(val, [])
    groups.get(val).push(name)
  }
  return [...groups.entries()]
}

// The name an icon is stored under: the plain spelling over Lucide*, then
// shortest, then alphabetical. Never enumeration order, which is how 730 Android
// files once ended up as ic_lucide_lucide_*.
export function canonicalName(names) {
  return [...names].sort((a, b) =>
    Number(a.startsWith('Lucide')) - Number(b.startsWith('Lucide')) ||
    a.length - b.length ||
    (a < b ? -1 : 1),
  )[0]
}
