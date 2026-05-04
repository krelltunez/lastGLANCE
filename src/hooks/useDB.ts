import { useState, useEffect } from 'react'
import { getDB } from '@/db/client'

type DBState = 'loading' | 'ready' | 'error'

export function useDBReady(): { state: DBState; error: Error | null } {
  const [state, setState] = useState<DBState>('loading')
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    getDB()
      .then(() => setState('ready'))
      .catch(e => {
        setError(e instanceof Error ? e : new Error(String(e)))
        setState('error')
      })
  }, [])

  return { state, error }
}
