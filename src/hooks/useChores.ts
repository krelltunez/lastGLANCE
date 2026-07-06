import { useState, useEffect, useCallback } from 'react'
import type { Category, ChoreWithLastCompletion } from '@/types'
import { getCategories, getChoresForCategory } from '@/db/queries'

export interface CategoryWithChores {
  category: Category
  chores: ChoreWithLastCompletion[]
  subcategories: CategoryWithChores[]
}

export function useChores() {
  const [data, setData] = useState<CategoryWithChores[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const categories = await getCategories()

      const allWithChores: CategoryWithChores[] = await Promise.all(
        categories.map(async category => ({
          category,
          chores: await getChoresForCategory(category.id),
          subcategories: [],
        }))
      )

      const byId = new Map(allWithChores.map(d => [d.category.id, d]))

      // Attach each category under a root, keeping the tree at the two levels the
      // UI can draw. Normally a subcategory's parent is a root, so it attaches
      // directly. But a category can end up nested deeper than two levels (a
      // pre-fix re-parent, see #191) or point at a parent that no longer exists.
      // Rather than let such a category — and every chore under it — silently
      // disappear, walk up to its nearest root ancestor and attach it there; if no
      // root ancestor resolves, surface it as a root itself. Nothing is ever hidden.
      const roots: CategoryWithChores[] = []
      for (const entry of allWithChores) {
        const parentId = entry.category.parent_category_id
        if (!parentId) { roots.push(entry); continue }
        let ancestor = byId.get(parentId)
        const guard = new Set<number>([entry.category.id])
        while (ancestor && ancestor.category.parent_category_id != null && !guard.has(ancestor.category.id)) {
          guard.add(ancestor.category.id)
          ancestor = byId.get(ancestor.category.parent_category_id)
        }
        if (ancestor && ancestor.category.id !== entry.category.id) {
          ancestor.subcategories.push(entry)
        } else {
          roots.push(entry)
        }
      }

      setData(roots)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { data, loading, refresh }
}
