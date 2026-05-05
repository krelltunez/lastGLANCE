import { useState, useEffect, useCallback } from 'react'
import type { Category, ChoreWithLastCompletion } from '@/types'
import { getCategories, getChoresForCategory } from '@/db/queries'

export interface CategoryWithChores {
  category: Category
  chores: ChoreWithLastCompletion[]
}

export function useChores() {
  const [data, setData] = useState<CategoryWithChores[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const categories = await getCategories()
      const results = await Promise.all(
        categories.map(async category => ({
          category,
          chores: await getChoresForCategory(category.id),
        }))
      )
      setData(results)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { data, loading, refresh }
}
