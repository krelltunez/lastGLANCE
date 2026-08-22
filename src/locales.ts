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

/**
 * Which regional variant a bare language tag means when more than one ships.
 * Empty while every shipped locale is a bare tag; a split like pt → pt-PT and
 * pt-BR adds its entry here so existing users keep the standard they had.
 */
const REGIONAL_DEFAULTS: Record<string, string> = {}

/**
 * Map any language tag onto one this app actually ships.
 *
 * Used in two places that must agree: the detector, so a stored or browser tag
 * resolves before i18next sees it, and the picker, so the select always has a
 * matching option. If they disagreed, the UI would render one language while
 * the picker displayed another — a select whose value matches no option
 * silently displays its first entry.
 */
export function resolveLanguage(reported: unknown, available: string[] = languages): string {
  const fallback = available.includes('en') ? 'en' : available[0]
  if (!reported || typeof reported !== 'string') return fallback

  if (available.includes(reported)) return reported

  // "pt-br" from a browser that lower-cases the region.
  const exact = available.find((l) => l.toLowerCase() === reported.toLowerCase())
  if (exact) return exact

  const base = reported.split('-')[0].toLowerCase()
  if (available.includes(base)) return base

  const preferred = REGIONAL_DEFAULTS[base]
  if (preferred && available.includes(preferred)) return preferred

  // A regional tag for a language we ship only regionally, with no default
  // declared — any variant beats falling through to English.
  const sameLanguage = available.find((l) => l.split('-')[0].toLowerCase() === base)
  return sameLanguage ?? fallback
}
