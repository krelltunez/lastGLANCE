// Exports and the pre-restore copy (docs/desktop-app.md, section 5, Export and
// import), the desktop half of src/utils/exportFile.ts:
//
//  - saveText: a backup, the Journal's CSV. The native save dialog, starting
//    in Downloads with the app's file name; cancelling is not an error.
//  - stash: the copy of the current data taken just before a restore. Written
//    silently to userData/backups, never a dialog in the middle of a restore,
//    as the phones keep theirs in app storage.
//
// File names come from the renderer, so only a bare name is used: no
// directory part, no leading dot, nothing that could leave the folder.

import type { Dialog, IpcMain, BrowserWindow, WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicWrite.js';

export const MAX_EXPORT_CHARS = 100_000_000;

/** A bare, safe file name from the renderer's, or null when nothing usable remains. */
export function safeFileName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  if (!cleaned || cleaned.startsWith('.') || cleaned.length > 200) return null;
  return cleaned;
}

/** Save-dialog filters for the file's type, plus "All files". */
export function filtersFor(fileName: string): Array<{ name: string; extensions: string[] }> {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const named: Record<string, string> = { json: 'JSON', csv: 'CSV' };
  return [...(ext ? [{ name: named[ext] ?? ext.toUpperCase(), extensions: [ext] }] : []), { name: 'All files', extensions: ['*'] }];
}

export interface FilesDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  dialog: Pick<Dialog, 'showSaveDialog'>;
  getWindow: () => BrowserWindow | null;
  isMainWindowSender: (sender: WebContents) => boolean;
  /** Where the save dialog opens (the Downloads folder). */
  downloadsDir: () => string;
  /** userData/backups, for the pre-restore copies. */
  backupsDir: () => string;
  log: (message: string) => void;
}

export function registerFilesHandlers(deps: FilesDeps): void {
  deps.ipcMain.handle('files:save-text', async (event, options: unknown) => {
    if (!deps.isMainWindowSender(event.sender)) return { saved: false };
    const { filename, text } = (options ?? {}) as { filename?: unknown; text?: unknown };
    const name = safeFileName(filename);
    if (!name || typeof text !== 'string' || text.length > MAX_EXPORT_CHARS) throw new Error('Invalid export');
    const dialogOptions = { defaultPath: path.join(deps.downloadsDir(), name), filters: filtersFor(name) };
    const win = deps.getWindow();
    const result = win ? await deps.dialog.showSaveDialog(win, dialogOptions) : await deps.dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return { saved: false };
    // The user chose this path in the native dialog; write it as is.
    await fs.promises.writeFile(result.filePath, text, 'utf-8');
    return { saved: true };
  });

  deps.ipcMain.handle('files:stash', (event, options: unknown) => {
    if (!deps.isMainWindowSender(event.sender)) throw new Error('Not allowed from this window');
    const { filename, text } = (options ?? {}) as { filename?: unknown; text?: unknown };
    const name = safeFileName(filename);
    if (!name || typeof text !== 'string' || text.length > MAX_EXPORT_CHARS) throw new Error('Invalid stash');
    const dir = deps.backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(path.join(dir, name), text);
    deps.log(`files: stashed ${name}`);
  });
}
