// From dayGLANCE electron/applicationMenu.ts (krelltunez/dayGLANCE@8d72008),
// plus the devTools option: packaged builds carry no developer tools
// (docs/desktop-app.md, section 5, Hardening), so the menu leaves the item out.
//
// The translated menu for Windows and Linux. macOS keeps Electron's native menu,
// which the OS localizes itself. The renderer pushes the labels (src/main.tsx).

import type { MenuItemConstructorOptions } from 'electron';

export const APPLICATION_MENU_LABEL_KEYS = [
  'file',
  'edit',
  'view',
  'window',
  'quit',
  'close',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'delete',
  'selectAll',
  'reload',
  'forceReload',
  'toggleDevTools',
  'resetZoom',
  'zoomIn',
  'zoomOut',
  'toggleFullScreen',
  'minimize',
  'zoom',
] as const;

/**
 * The shell's own text that rides in the same `menu` block (section 7): the
 * background notice, the tray and its menu. Optional: main falls back to
 * English for any that has not arrived.
 */
export const SHELL_LABEL_KEYS = [
  'backgroundTitle',
  'backgroundBody',
  'trayOpen',
  'trayQuit',
  'trayMarkDone',
  'trayNothingDue',
] as const;

export type ApplicationMenuLabelKey = typeof APPLICATION_MENU_LABEL_KEYS[number];
export type ApplicationMenuLabels = Record<ApplicationMenuLabelKey, string>;

export function isApplicationMenuLabels(value: unknown): value is ApplicationMenuLabels {
  if (!value || typeof value !== 'object') return false;
  const labels = value as Record<string, unknown>;
  return APPLICATION_MENU_LABEL_KEYS.every((key) => typeof labels[key] === 'string');
}

export function supportsCustomApplicationMenu(platform: string): boolean {
  return platform === 'win32' || platform === 'linux';
}

export interface ApplicationMenuOptions {
  /** False in packaged builds, where DevTools are disabled outright. */
  devTools: boolean;
}

export function buildApplicationMenuTemplate(
  text: ApplicationMenuLabels,
  { devTools }: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  return [
    {
      label: text.file,
      submenu: [
        { label: text.quit, role: 'quit', accelerator: 'CommandOrControl+Q' },
      ],
    },
    {
      label: text.edit,
      submenu: [
        { label: text.undo, role: 'undo' },
        { label: text.redo, role: 'redo' },
        { type: 'separator' },
        { label: text.cut, role: 'cut' },
        { label: text.copy, role: 'copy' },
        { label: text.paste, role: 'paste' },
        { label: text.delete, role: 'delete' },
        { type: 'separator' },
        { label: text.selectAll, role: 'selectAll' },
      ],
    },
    {
      label: text.view,
      submenu: [
        { label: text.reload, role: 'reload' },
        { label: text.forceReload, role: 'forceReload' },
        ...(devTools ? [{ label: text.toggleDevTools, role: 'toggleDevTools' } as const] : []),
        { type: 'separator' },
        { label: text.resetZoom, role: 'resetZoom' },
        { label: text.zoomIn, role: 'zoomIn' },
        { label: text.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: text.toggleFullScreen, role: 'togglefullscreen' },
      ],
    },
    {
      label: text.window,
      submenu: [
        { label: text.minimize, role: 'minimize' },
        { label: text.zoom, role: 'zoom' },
        { label: text.close, role: 'close' },
      ],
    },
  ];
}
