// The facts main hands the preload for `bridge.info` (docs/desktop-app.md,
// section 2): the app version and whether this is the Mac App Store build.
//
// They travel as one command-line switch (webPreferences.additionalArguments)
// because the sandboxed preload cannot reach `app`, and a synchronous IPC round
// trip at boot would block the renderer. The preload is a separate, sandboxed
// script that cannot import this module, so it decodes the switch itself;
// bridgeContract.test.ts holds the two spellings of the switch equal.

export const DESKTOP_INFO_ARG = '--lastglance-desktop-info=';

export interface DesktopInfoArg {
  version: string;
  isMAS: boolean;
}

export function encodeDesktopInfo(info: DesktopInfoArg): string {
  return encodeURIComponent(JSON.stringify(info));
}

/** The decoded switch from an argv, or null when absent or malformed. */
export function decodeDesktopInfo(argv: readonly string[]): DesktopInfoArg | null {
  const arg = argv.find((a) => a.startsWith(DESKTOP_INFO_ARG));
  if (!arg) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(arg.slice(DESKTOP_INFO_ARG.length))) as Partial<DesktopInfoArg>;
    if (typeof parsed.version !== 'string' || typeof parsed.isMAS !== 'boolean') return null;
    return { version: parsed.version, isMAS: parsed.isMAS };
  } catch {
    return null;
  }
}
