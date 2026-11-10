// lastglance:// deep links (docs/desktop-app.md, section 8). A URL becomes the
// same internal token the iOS shell stashes (AppDelegate.deepLinkToken) and the
// page already consumes (src/native/pendingDeepLink.ts): `chore:<id>`,
// `filter:soon`, `person:<id>`, `log:<id>`, `people`, `chores`,
// `action:search`, `action:add`. Anything else is refused rather than guessed.
// deepLink.test.ts holds the host list equal to AppDelegate.swift's.
//
// Ids are checked against the shape sync ids have, so a crafted URL cannot
// carry anything else into the page.

export const DEEP_LINK_SCHEME = 'lastglance';
export const DEEP_LINK_HOSTS = ['chore', 'filter', 'person', 'log', 'people', 'chores', 'action'] as const;

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The token for a lastglance:// URL, or null. */
export function deepLinkToken(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments.length ? decodeURIComponent(segments[segments.length - 1]) : '';
  const withId = (kind: string) => (ID.test(last) ? `${kind}:${last}` : null);
  switch (url.hostname.toLowerCase()) {
    case 'chore': return withId('chore');
    case 'filter': return 'filter:soon';
    case 'person': return withId('person');
    case 'log': return withId('log');
    case 'people': return 'people';
    case 'chores': return 'chores';
    case 'action':
      if (last === 'search') return 'action:search';
      if (last === 'add') return 'action:add';
      return null;
    default: return null;
  }
}

/** The first lastglance:// URL on a command line (Windows and Linux hand URLs over as arguments). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`));
  return arg ?? null;
}
