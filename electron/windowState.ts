// Window bounds and the pre-paint background, persisted in userData
// (docs/desktop-app.md, section 5, Window chrome). After dayGLANCE's
// electron/main.ts (krelltunez/dayGLANCE@8d72008), moved out of main so it is
// tested, plus an off-screen guard dayGLANCE lacks.
//
// Best-effort throughout: a missing or corrupt file means the defaults, and a
// failed write is ignored. Neither may stop the window from opening.

import fs from 'node:fs';
import path from 'node:path';

export const WINDOW_STATE_FILE = 'window-state.json';
export const WINDOW_THEME_FILE = 'window-theme.json';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface Rect { x: number; y: number; width: number; height: number }

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1200, height: 820, maximized: false };

// The app's own body backgrounds (src/index.css): slate-50 and slate-950.
// The window paints this before the renderer's first frame, so it must match
// or every launch flashes the wrong color.
export const LIGHT_BG = '#f8fafc';
export const DARK_BG = '#020617';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function parseWindowState(raw: unknown): WindowState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WINDOW_STATE };
  const s = raw as Record<string, unknown>;
  if (!finite(s.width) || !finite(s.height) || s.width <= 0 || s.height <= 0) return { ...DEFAULT_WINDOW_STATE };
  return {
    width: Math.round(s.width),
    height: Math.round(s.height),
    maximized: s.maximized === true,
    ...(finite(s.x) && finite(s.y) ? { x: Math.round(s.x), y: Math.round(s.y) } : {}),
  };
}

/**
 * The saved state with its position dropped when no display can show the
 * window's title area any more (a monitor unplugged since the last run). The
 * OS then centers it. Requires a 100x40 overlap with some display's work area,
 * enough to grab the title bar.
 */
export function onScreen(state: WindowState, workAreas: readonly Rect[]): WindowState {
  if (state.x == null || state.y == null) return state;
  const { x, y, width } = state;
  const visible = workAreas.some((a) => {
    const w = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
    const h = Math.min(y + 40, a.y + a.height) - Math.max(y, a.y);
    return w >= 100 && h >= 40;
  });
  if (visible) return state;
  return { width: state.width, height: state.height, maximized: state.maximized };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.writeFileSync(file, JSON.stringify(value));
  } catch { /* best-effort */ }
}

export function loadWindowState(userData: string): WindowState {
  return parseWindowState(readJson(path.join(userData, WINDOW_STATE_FILE)));
}

export function saveWindowState(userData: string, state: WindowState): void {
  writeJson(path.join(userData, WINDOW_STATE_FILE), state);
}

/**
 * The renderer reports its resolved theme (light, dark, or system resolved),
 * which main cannot read from localStorage, so the NEXT launch's window opens
 * in the right color. Before the first report, follow the OS.
 */
export function saveWindowTheme(userData: string, dark: boolean): void {
  writeJson(path.join(userData, WINDOW_THEME_FILE), { dark });
}

export function windowBackgroundColor(userData: string, osDark: boolean): string {
  const saved = readJson(path.join(userData, WINDOW_THEME_FILE)) as { dark?: unknown } | null;
  const dark = typeof saved?.dark === 'boolean' ? saved.dark : osDark;
  return dark ? DARK_BG : LIGHT_BG;
}
