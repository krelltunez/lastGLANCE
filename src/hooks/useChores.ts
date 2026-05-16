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

      // Attach children to their parent (one level only)
      const roots: CategoryWithChores[] = []
      for (const entry of allWithChores) {
        const parentId = entry.category.parent_category_id
        if (parentId) {
          byId.get(parentId)?.subcategories.push(entry)
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
