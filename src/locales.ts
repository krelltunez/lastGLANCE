// The languages this app ships, derived from what is actually on disk.
//
// The runtime keeps loading translations over i18next-http-backend from
// /locales/<lng>/translation.json — that works across web and the Capacitor
// shells, which serve public/ as the web root. What this module removes is the
// second, hand-kept copy of the language list: gating anything on a list that
// has to be updated by hand is how sibling app dayGLANCE shipped four locale
// files no user could reach. Adding a language is now just adding
// public/locales/<lng>/translation.json.
const loaderModules = import.meta.glob<Record<string, unknown>>(
  '../public/locales/*/translation.json',
  { import: 'default' },
)

// "../public/locales/pt/translation.json" -> "pt"
function tagOf(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 2]
}

// Lazy per-language loaders. The app itself never calls these — the HTTP
// backend fetches from /locales at runtime — but the test suite does: going
// through the bundler resolves the same files the backend serves, without the
// tests needing a web server.
export const loaders: Record<string, () => Promise<Record<string, unknown>>> =
  Object.fromEntries(
    Object.entries(loaderModules).map(([path, load]) => [tagOf(path), load]),
  )

// Sorted so the value is stable across platforms — glob key order follows the
// filesystem, which is not guaranteed to match between a dev machine and CI.
export const languages = Object.keys(loaders).sort()
