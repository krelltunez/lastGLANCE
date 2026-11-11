import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyOpenAtLogin, autostartEntry, closeAction, DEFAULT_DESKTOP_SETTINGS, HIDDEN_ARG, isAcceleratorText, launchedHidden,
  loadDesktopSettings, parseDesktopSettings, saveDesktopSettings,
} from './backgroundMode';

const dirs: string[] = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lastglance-bg-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('closing the window', () => {
  it('hides on macOS whatever the setting', () => {
    expect(closeAction({ platform: 'darwin', isQuitting: false, keepRunning: false })).toBe('hide');
  });
  it.each(['win32', 'linux'] as const)('on %s hides with keep-running on, closes with it off', (platform) => {
    expect(closeAction({ platform, isQuitting: false, keepRunning: true })).toBe('hide');
    expect(closeAction({ platform, isQuitting: false, keepRunning: false })).toBe('close');
  });
  it('always closes while quitting', () => {
    expect(closeAction({ platform: 'darwin', isQuitting: true, keepRunning: true })).toBe('close');
  });
});

describe('the settings', () => {
  it('default to keep running on and open at login off', () => {
    expect(DEFAULT_DESKTOP_SETTINGS).toEqual({ keepRunning: true, openAtLogin: false, backgroundNoticeShown: false, popupShortcut: '', windowShortcut: '' });
    expect(loadDesktopSettings(temp())).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });
  it('round-trip, and a malformed field falls back to its default', () => {
    const d = temp();
    const saved = { keepRunning: false, openAtLogin: true, backgroundNoticeShown: true, popupShortcut: 'Ctrl+Shift+L', windowShortcut: 'Cmd+Alt+Space' };
    saveDesktopSettings(d, saved);
    expect(loadDesktopSettings(d)).toEqual(saved);
    expect(parseDesktopSettings({ popupShortcut: 'rm -rf /', windowShortcut: 42 })).toMatchObject({ popupShortcut: '', windowShortcut: '' });
    expect(parseDesktopSettings({ keepRunning: 'no', openAtLogin: true })).toEqual({ ...DEFAULT_DESKTOP_SETTINGS, openAtLogin: true });
    fs.writeFileSync(path.join(d, 'desktop-settings.json'), '{not json');
    expect(loadDesktopSettings(d)).toEqual(DEFAULT_DESKTOP_SETTINGS);
  });
});

describe('shortcut text', () => {
  it('accepts accelerators and refuses anything else', () => {
    for (const ok of ['Ctrl+Shift+L', 'Cmd+Alt+Space', 'F9', 'Ctrl+Shift+1', 'Ctrl+=', 'Alt+/', 'Ctrl++']) expect(isAcceleratorText(ok), ok).toBe(true);
    for (const bad of ['', 'Ctrl+Shift+', 'Ctrl Shift L', 'x'.repeat(65), 7]) expect(isAcceleratorText(bad), String(bad)).toBe(false);
  });
});

describe('open at login', () => {
  it('starts hidden only when launched with --hidden', () => {
    expect(launchedHidden(['/app', HIDDEN_ARG])).toBe(true);
    expect(launchedHidden(['/app'])).toBe(false);
  });

  it('on Linux writes and removes an XDG autostart entry that starts hidden', () => {
    const configHome = temp();
    const set = vi.fn();
    expect(applyOpenAtLogin(true, { platform: 'linux', setLoginItemSettings: set, configHome, exec: '/opt/lastGLANCE/lastglance' })).toBe(true);
    const file = path.join(configHome, 'autostart', 'lastglance.desktop');
    expect(fs.readFileSync(file, 'utf-8')).toContain('Exec=/opt/lastGLANCE/lastglance --hidden');
    applyOpenAtLogin(false, { platform: 'linux', setLoginItemSettings: set, configHome, exec: '/x' });
    expect(fs.existsSync(file)).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('quotes an executable path with spaces', () => {
    expect(autostartEntry('/home/a b/lastGLANCE.AppImage')).toContain('Exec="/home/a b/lastGLANCE.AppImage" --hidden');
  });

  it('uses login items on Windows (started hidden) and macOS', () => {
    const set = vi.fn();
    applyOpenAtLogin(true, { platform: 'win32', setLoginItemSettings: set, configHome: '', exec: '' });
    expect(set).toHaveBeenLastCalledWith({ openAtLogin: true, args: [HIDDEN_ARG] });
    applyOpenAtLogin(false, { platform: 'darwin', setLoginItemSettings: set, configHome: '', exec: '' });
    expect(set).toHaveBeenLastCalledWith({ openAtLogin: false });
  });

  it('reports a failure rather than throwing', () => {
    const set = vi.fn(() => { throw new Error('denied'); });
    expect(applyOpenAtLogin(true, { platform: 'darwin', setLoginItemSettings: set, configHome: '', exec: '' })).toBe(false);
  });
});
