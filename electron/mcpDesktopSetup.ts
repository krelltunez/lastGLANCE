// The impure half of the "Set up Claude Desktop" button (docs/mcp-and-stream-deck.md,
// section 5), after dayGLANCE's electron/mcpDesktopSetup.ts: read Claude
// Desktop's config, back it up, merge the lastglance entry (pure logic in
// mcpDesktopConfig.ts), write it back. Direct-download builds only.
//
// LEFT OUT OF THE MAC APP STORE BUILD (section 7): this module and
// mcpDesktopConfig.ts are excluded from the MAS package by
// electron-builder.config.cjs, and main.ts loads this one dynamically, so its
// absence there is a no-op. Never import either statically from anything that
// ships on MAS. scripts/verify-mas-compileout.mjs checks the built app.

import { ipcMain } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { claudeConfigPath, claudeConfigIsPackaged, bridgeEntry, bridgeScriptPath, mergeClaudeConfig, manualEntrySnippet } from './mcpDesktopConfig.js';

export const SETUP_CHANNEL = 'mcp-setup:claude-desktop';

/** Never throws: an unreadable or absent directory is simply no candidates. */
const dirProbe = {
  readDir(p: string): string[] {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

/**
 * @param getConnection supplies the live MCP port and token, used only when
 *   Claude Desktop is packaged and discovery cannot cross the container
 *   boundary (see bridgeEntry). Returning null falls back to discovery.
 */
export function registerMcpDesktopSetup(
  getConnection: () => { port: number; token: string } | null = () => null,
  isMainWindowSender: (sender: Electron.WebContents) => boolean = () => true,
): void {
  ipcMain.handle('mcp-setup:claude-desktop', (event) => {
    if (!isMainWindowSender(event.sender)) return { ok: false, reason: 'invalid_sender' };
    const path = claudeConfigPath(process.platform, process.env, homedir(), dirProbe);
    // Only override discovery where it provably cannot work. An unpackaged
    // install keeps the 0600 discovery file as the only place the token lives.
    const connection = path && claudeConfigIsPackaged(path) ? getConnection() : null;
    const entry = bridgeEntry(process.execPath, process.resourcesPath, connection);
    if (!path) {
      return { ok: false, reason: 'unsupported_platform', manualEntry: manualEntrySnippet(entry) };
    }

    // The bridge is put here by a per-platform extraResources entry, and a
    // platform that forgets to declare one still reaches this handler with a
    // perfectly well-formed entry pointing at nothing. Writing it would leave
    // the user a config that looks right, a success message, and a client that
    // silently fails to connect — which is exactly what the Windows build did
    // before this check existed. Report it instead.
    const bridgePath = bridgeScriptPath(process.resourcesPath);
    if (!existsSync(bridgePath)) {
      return { ok: false, reason: 'bridge_missing', path, bridgePath };
    }

    let existingText: string | null = null;
    try {
      existingText = readFileSync(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, reason: 'unreadable', path, error: String((err as Error).message), manualEntry: manualEntrySnippet(entry) };
      }
    }

    const merged = mergeClaudeConfig(existingText, entry);
    if (merged.action === 'unparseable') {
      // NEVER overwrite a file we cannot parse: the user may have (broken)
      // hand-edits worth keeping, and Claude Desktop itself rewrites this
      // file when it dislikes an entry. Report and hand over the snippet.
      return { ok: false, reason: 'unparseable', path, manualEntry: manualEntrySnippet(entry) };
    }

    try {
      mkdirSync(dirname(path), { recursive: true });
      let backupPath: string | null = null;
      if (existingText !== null) {
        backupPath = `${path}.bak-lastglance-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        copyFileSync(path, backupPath);
      }
      writeFileSync(path, merged.text);
      return { ok: true, action: merged.action, path, backupPath };
    } catch (err) {
      return { ok: false, reason: 'write_failed', path, error: String((err as Error).message), manualEntry: manualEntrySnippet(entry) };
    }
  });
}
