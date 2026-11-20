// Apply the saved theme before the first paint. A classic script loaded from
// <head> (index.html) runs before the body is parsed, so the first frame is
// already in the right theme: no dark-to-light (or light-to-dark) jump while
// the module bundle loads. A file rather than an inline script because the
// Content-Security-Policy is script-src 'self' (electron/csp.ts).
//
// 'system' (or nothing stored yet) follows the OS. App.tsx keeps the class in
// step from then on; this only decides the first frame, with the same rule.
try {
  var saved = localStorage.getItem('theme')
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  if (saved === 'dark' || (saved !== 'light' && prefersDark)) {
    document.documentElement.classList.add('dark')
  }
} catch (e) {
  // Storage or matchMedia unavailable: App.tsx applies the theme on mount.
}
