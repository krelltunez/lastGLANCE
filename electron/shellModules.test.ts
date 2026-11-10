import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_SECURITY_POLICY } from './csp.js';
import { isAllowedExternalUrl } from './externalLinks.js';
import { decodeDesktopInfo, encodeDesktopInfo, DESKTOP_INFO_ARG } from './desktopInfo.js';
import {
  DARK_BG, DEFAULT_WINDOW_STATE, LIGHT_BG, WINDOW_STATE_FILE,
  loadWindowState, onScreen, parseWindowState, saveWindowState, saveWindowTheme, windowBackgroundColor,
} from './windowState.js';

const directive = (name: string) =>
  CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith(`${name} `));

describe('CONTENT_SECURITY_POLICY', () => {
  it('allows the renderer no network request beyond its own origin', () => {
    // Section 4: sync goes through main. Loosening this hides a missed fetch site.
    expect(directive('connect-src')).toBe("connect-src 'self'");
  });

  it('allows only the bundle’s own scripts', () => {
    expect(directive('script-src')).toBe("script-src 'self'");
  });

  it('closes plugins, base tags and frames', () => {
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('frame-src')).toBe("frame-src 'none'");
  });
});

describe('isAllowedExternalUrl', () => {
  it.each(['https://www.glance-apps.com/', 'http://example.com/x', 'mailto:support@glance-apps.com'])(
    'hands %s to the OS', (url) => { expect(isAllowedExternalUrl(url)).toBe(true); });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'app://lastglance/', 'smb://host/share', 'not a url'])(
    'drops %s', (url) => { expect(isAllowedExternalUrl(url)).toBe(false); });
});

describe('desktop info switch', () => {
  it('round-trips through argv', () => {
    const argv = ['/path/electron', '--type=renderer', `${DESKTOP_INFO_ARG}${encodeDesktopInfo({ version: '3.0.1', isMAS: true, secureStorage: false })}`];
    expect(decodeDesktopInfo(argv)).toEqual({ version: '3.0.1', isMAS: true, secureStorage: false });
  });

  it('is null when absent or malformed', () => {
    expect(decodeDesktopInfo(['--type=renderer'])).toBeNull();
    expect(decodeDesktopInfo([`${DESKTOP_INFO_ARG}%7Bnope`])).toBeNull();
    expect(decodeDesktopInfo([`${DESKTOP_INFO_ARG}${encodeURIComponent('{"version":3}')}`])).toBeNull();
    expect(decodeDesktopInfo([`${DESKTOP_INFO_ARG}${encodeURIComponent('{"version":"1","isMAS":false}')}`])).toBeNull();
  });
});

describe('window state', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastglance-winstate-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('uses the defaults on a first launch or a corrupt file', () => {
    expect(loadWindowState(dir)).toEqual(DEFAULT_WINDOW_STATE);
    fs.writeFileSync(path.join(dir, WINDOW_STATE_FILE), '{not json');
    expect(loadWindowState(dir)).toEqual(DEFAULT_WINDOW_STATE);
  });

  it('round-trips the saved bounds', () => {
    saveWindowState(dir, { x: 10, y: 20, width: 900, height: 700, maximized: true });
    expect(loadWindowState(dir)).toEqual({ x: 10, y: 20, width: 900, height: 700, maximized: true });
  });

  it('rejects nonsense sizes and drops a half-saved position', () => {
    expect(parseWindowState({ width: -1, height: 700 })).toEqual(DEFAULT_WINDOW_STATE);
    expect(parseWindowState({ width: 900, height: 700, x: 5 })).toEqual({ width: 900, height: 700, maximized: false });
  });

  describe('onScreen', () => {
    const primary = { x: 0, y: 0, width: 1920, height: 1080 };
    const state = { width: 1200, height: 800, maximized: false };

    it('keeps a position on a connected display', () => {
      expect(onScreen({ ...state, x: 100, y: 100 }, [primary])).toEqual({ ...state, x: 100, y: 100 });
    });

    it('drops a position left on a display that is gone', () => {
      expect(onScreen({ ...state, x: 2500, y: 100 }, [primary])).toEqual(state);
    });

    it('drops a position whose title bar is above every display', () => {
      expect(onScreen({ ...state, x: 100, y: -500 }, [primary])).toEqual(state);
    });

    it('keeps a position on a second display left of the primary', () => {
      const left = { x: -1440, y: 0, width: 1440, height: 900 };
      expect(onScreen({ ...state, x: -1300, y: 50 }, [primary, left])).toEqual({ ...state, x: -1300, y: 50 });
    });
  });

  it('paints the theme the renderer last reported, else the OS theme', () => {
    expect(windowBackgroundColor(dir, true)).toBe(DARK_BG);
    expect(windowBackgroundColor(dir, false)).toBe(LIGHT_BG);
    saveWindowTheme(dir, false);
    expect(windowBackgroundColor(dir, true)).toBe(LIGHT_BG);
  });

  it('matches the app’s own body backgrounds (src/index.css)', () => {
    // slate-50 and slate-950: a mismatch is a flash on every launch.
    const css = fs.readFileSync(path.resolve(__dirname, '../src/index.css'), 'utf-8');
    expect(css).toContain('@apply bg-slate-50 text-slate-900');
    expect(css).toContain('@apply bg-slate-950 text-slate-100');
    expect([LIGHT_BG, DARK_BG]).toEqual(['#f8fafc', '#020617']);
  });
});
