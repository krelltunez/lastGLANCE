// Background mode and open at login (docs/desktop-app.md, section 7, Staying
// alive). The decisions are pure functions here, tested without Electron;
// main.ts applies them.
//
//  - macOS: closing the window hides it, as Mac apps do, whatever the setting.
//  - Windows and Linux: with "Keep running in the background" on (the
//    default, since reminders depend on it), closing hides the window to the
//    tray, and the first time a notification says lastGLANCE is still running.
//    With it off, closing quits.
//  - "Open at login" is off by default. macOS and Windows use
//    app.setLoginItemSettings (SMAppService under the MAS sandbox); Linux uses
//    an XDG autostart entry. Windows and Linux start hidden at login
//    (`--hidden`); macOS opens the window, since SMAppService passes no
//    arguments.
//
// The settings live in userData/desktop-settings.json, best-effort: a missing
// or corrupt file means the defaults.

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicWrite.js';

export const DESKTOP_SETTINGS_FILE = 'desktop-settings.json';
export const HIDDEN_ARG = '--hidden';
export const AUTOSTART_FILE = 'lastglance.desktop';

export interface DesktopSettings {
  /** Windows and Linux: closing hides to the tray. Ignored on macOS. */
  keepRunning: boolean;
  openAtLogin: boolean;
  /** The "still running" notice has been shown once. */
  backgroundNoticeShown: boolean;
  /** Global shortcuts (Electron accelerators); '' for none. */
  popupShortcut: string;
  windowShortcut: string;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  keepRunning: true, openAtLogin: false, backgroundNoticeShown: false, popupShortcut: '', windowShortcut: '',
};

/** A plausible accelerator: modifiers and one key joined by "+", nothing else. */
export function isAcceleratorText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^([A-Za-z]+\+)*[^+\s]+$|^([A-Za-z]+\+)*\+$/.test(value);
}

export function parseDesktopSettings(raw: unknown): DesktopSettings {
  const s = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const bool = (key: 'keepRunning' | 'openAtLogin' | 'backgroundNoticeShown') =>
    (typeof s[key] === 'boolean' ? s[key] as boolean : DEFAULT_DESKTOP_SETTINGS[key]);
  const shortcut = (key: 'popupShortcut' | 'windowShortcut') => (isAcceleratorText(s[key]) ? s[key] as string : '');
  return {
    keepRunning: bool('keepRunning'), openAtLogin: bool('openAtLogin'), backgroundNoticeShown: bool('backgroundNoticeShown'),
    popupShortcut: shortcut('popupShortcut'), windowShortcut: shortcut('windowShortcut'),
  };
}

export function loadDesktopSettings(userData: string): DesktopSettings {
  try {
    return parseDesktopSettings(JSON.parse(fs.readFileSync(path.join(userData, DESKTOP_SETTINGS_FILE), 'utf-8')));
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

export function saveDesktopSettings(userData: string, settings: DesktopSettings): void {
  try {
    writeFileAtomicSync(path.join(userData, DESKTOP_SETTINGS_FILE), JSON.stringify(settings));
  } catch { /* best-effort: this session still follows it */ }
}

/** What closing the main window does. */
export function closeAction(o: { platform: NodeJS.Platform; isQuitting: boolean; keepRunning: boolean }): 'hide' | 'close' {
  if (o.isQuitting) return 'close';
  if (o.platform === 'darwin') return 'hide';
  return o.keepRunning ? 'hide' : 'close';
}

/** Whether this launch should stay in the background (an open-at-login start on Windows or Linux). */
export function launchedHidden(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_ARG);
}

/**
 * The XDG autostart entry for Linux. `exec` is the AppImage's own path when
 * run from one (process.env.APPIMAGE), else the executable.
 */
export function autostartEntry(exec: string): string {
  const quoted = /[\s"'\\]/.test(exec) ? `"${exec.replace(/(["\\`$])/g, '\\$1')}"` : exec;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=lastGLANCE',
    `Exec=${quoted} ${HIDDEN_ARG}`,
    'Icon=lastglance',
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=false',
    '',
  ].join('\n');
}

export interface LoginItemDeps {
  platform: NodeJS.Platform;
  /** app.setLoginItemSettings (macOS, Windows). */
  setLoginItemSettings: (settings: { openAtLogin: boolean; args?: string[] }) => void;
  /** ~/.config, or $XDG_CONFIG_HOME. */
  configHome: string;
  exec: string;
}

/** Turn open-at-login on or off. Best-effort; returns whether it applied. */
export function applyOpenAtLogin(enabled: boolean, deps: LoginItemDeps): boolean {
  try {
    if (deps.platform === 'linux') {
      const file = path.join(deps.configHome, 'autostart', AUTOSTART_FILE);
      if (enabled) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, autostartEntry(deps.exec));
      } else {
        fs.rmSync(file, { force: true });
      }
      return true;
    }
    deps.setLoginItemSettings(deps.platform === 'win32'
      ? { openAtLogin: enabled, args: [HIDDEN_ARG] }
      : { openAtLogin: enabled });
    return true;
  } catch {
    return false;
  }
}
