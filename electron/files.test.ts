import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filtersFor, registerFilesHandlers, safeFileName } from './files.js';

describe('safeFileName', () => {
  it('keeps an ordinary name', () => {
    expect(safeFileName('lastglance-backup-2026-11-09.json')).toBe('lastglance-backup-2026-11-09.json');
  });
  it('drops any directory part, so nothing leaves the folder', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Windows\\win.ini')).toBe('win.ini');
  });
  it('refuses what is left empty, hidden, odd or too long', () => {
    for (const bad of ['', '   ', '../', '.bashrc', 'x'.repeat(201), 42, null]) expect(safeFileName(bad)).toBeNull();
    expect(safeFileName('a<b>:c?.json')).toBe('abc.json');
  });
});

describe('filtersFor', () => {
  it('offers the file type, then everything', () => {
    expect(filtersFor('journal.csv')).toEqual([{ name: 'CSV', extensions: ['csv'] }, { name: 'All files', extensions: ['*'] }]);
    expect(filtersFor('noext')).toEqual([{ name: 'All files', extensions: ['*'] }]);
  });
});

describe('handlers', () => {
  let dir: string;
  const handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown> = {};
  const sender = {};
  let showSaveDialog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastglance-files-'));
    showSaveDialog = vi.fn();
    registerFilesHandlers({
      ipcMain: { handle: (channel: string, fn: (...a: never[]) => unknown) => { handlers[channel] = fn as never; } } as never,
      dialog: { showSaveDialog } as never,
      getWindow: () => null,
      isMainWindowSender: (s) => s === (sender as never),
      downloadsDir: () => path.join(dir, 'Downloads'),
      backupsDir: () => path.join(dir, 'userData', 'backups'),
      log: () => {},
    });
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('saves where the user chose, starting in Downloads with the given name', async () => {
    const target = path.join(dir, 'chosen.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    expect(await handlers['files:save-text']({ sender }, { filename: 'backup.json', text: '{"v":1}' })).toEqual({ saved: true });
    expect(showSaveDialog.mock.calls[0][0].defaultPath).toBe(path.join(dir, 'Downloads', 'backup.json'));
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"v":1}');
  });

  it('treats a cancelled dialog as not saved, not as an error', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true });
    expect(await handlers['files:save-text']({ sender }, { filename: 'backup.json', text: '{}' })).toEqual({ saved: false });
  });

  it('stashes silently into userData/backups, confined by name', () => {
    handlers['files:stash']({ sender }, { filename: '../../outside.json', text: '{"before":true}' });
    expect(fs.readFileSync(path.join(dir, 'userData', 'backups', 'outside.json'), 'utf-8')).toBe('{"before":true}');
    expect(fs.existsSync(path.join(dir, 'outside.json'))).toBe(false);
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('answers only the main window', async () => {
    expect(await handlers['files:save-text']({ sender: {} }, { filename: 'b.json', text: '' })).toEqual({ saved: false });
    expect(() => handlers['files:stash']({ sender: {} }, { filename: 'b.json', text: '' })).toThrow();
  });
});
