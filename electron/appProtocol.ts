// From dayGLANCE electron/appProtocol.ts (krelltunez/dayGLANCE@8d72008), with the host
// changed to lastglance.
//
// Custom app:// protocol for the packaged Electron renderer.
//
// The renderer is served from a registered standard+secure scheme rather than
// file://, whose opaque `null` origin can be neither allowlisted nor kept
// stable. lastGLANCE ships on this origin from its first desktop build and must
// never leave it: IndexedDB (every chore) and localStorage are partitioned by
// origin, so a move would orphan them (docs/desktop-app.md, section 3).
//
// EXACT ORIGIN produced: `app://lastglance` (scheme `app`, host `lastglance`).
// It is NOT `null` and NOT `app://lastglance/` (an origin has no trailing
// slash). The renderer makes no direct network requests (section 4), so no
// server needs it in a CORS list today.
//
// This module holds ONLY the pure request->file mapping so it is unit-testable in
// vitest without importing electron. main.ts wires it into protocol.handle and
// supplies the real fs existence check + file reads.

import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'lastglance';
/** The renderer's origin (no trailing slash). Allowlist THIS in vault CORS. */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/** The URL the main/tray windows load. */
export const APP_BASE_URL = `${APP_SCHEME}://${APP_HOST}/`;

// Minimal content-type table for the asset kinds a Vite build emits. A wrong or
// missing type on the entry module script means Chromium refuses to execute it,
// so js/css/html must be exact.
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export interface AppRequestResolution {
  status: 200 | 403 | 404;
  filePath?: string;
  contentType?: string;
  /** True when SPA fallback served index.html for a non-file (client route). */
  fallback?: boolean;
}

/**
 * Map an app:// request URL to a file under distDir.
 *
 *  - `/` (or empty) → index.html.
 *  - An existing file → served with its content type.
 *  - A NON-existent path WITHOUT a file extension → SPA fallback to index.html,
 *    so client-side routes resolve. (A missing path WITH an extension — e.g. a
 *    renamed `/assets/x.js` — is a real 404, never HTML, so a broken asset fails
 *    loudly instead of silently returning the index doc.)
 *  - Path traversal outside distDir → 403.
 *
 * `isFile` is injected (fs.statSync in prod, a fake set in tests) so this stays
 * pure and testable. The query string is ignored for file resolution — the tray
 * loads `app://lastglance/?tray=1`, and index.html is served while the renderer
 * still reads the query off its document URL.
 */
export function resolveAppRequest(
  distDir: string,
  requestUrl: string,
  isFile: (p: string) => boolean,
): AppRequestResolution {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    return { status: 404 };
  }

  const distRoot = path.resolve(distDir);
  const indexPath = path.join(distRoot, 'index.html');

  if (pathname === '/' || pathname === '') {
    return { status: 200, filePath: indexPath, contentType: 'text/html; charset=utf-8' };
  }

  const rel = pathname.replace(/^\/+/, '');
  const full = path.resolve(distRoot, rel);

  // Traversal guard: the resolved path must stay inside distDir.
  if (full !== distRoot && !full.startsWith(distRoot + path.sep)) {
    return { status: 403 };
  }

  if (isFile(full)) {
    return { status: 200, filePath: full, contentType: contentTypeFor(full) };
  }

  // No real file: a route (no extension) falls back to index.html; a missing
  // asset (has an extension) is a genuine 404.
  if (!path.extname(rel)) {
    return { status: 200, filePath: indexPath, contentType: 'text/html; charset=utf-8', fallback: true };
  }
  return { status: 404 };
}
