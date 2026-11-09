// The Content-Security-Policy for every document the renderer loads
// (docs/desktop-app.md, section 3).
//
// connect-src 'self' is the point: the renderer makes no network request of
// its own. Sync, the vault and intents go through the main process (section
// 4), so a fetch site that was missed fails loudly here instead of meeting a
// server's CORS rules. 'self' is app://lastglance, which covers the locale
// bundles the renderer loads from its own origin.
//
//  - script-src 'self': only the bundle's own scripts; no inline script, no eval.
//  - style-src 'unsafe-inline': React sets inline style attributes.
//  - img-src data: blob:: icon data URLs and blob previews.
//  - object-src, base-uri, frame-src 'none': no plugins, no base-tag injection,
//    no frames.

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join('; ');
