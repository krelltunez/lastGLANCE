// Dexie opens the IndexedDB connection lazily on first query — no explicit
// initialization required. This hook exists as a seam for future needs
// (e.g. migration checks) and to keep App.tsx's structure consistent.
export function useDBReady() {
  return { state: 'ready' as const, error: null }
}
