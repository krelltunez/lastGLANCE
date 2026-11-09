// Which URLs the shell hands to the operating system (docs/desktop-app.md,
// section 5, External links). Web pages open in the browser and mailto: links
// in the mail client (the Help screen's support address). Every other scheme
// (javascript:, file:, custom protocols) is dropped, so a crafted link cannot
// launch a local program.

const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

export function isAllowedExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
