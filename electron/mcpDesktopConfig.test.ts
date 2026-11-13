import { describe, expect, it } from 'vitest';
import {
  bridgeEntry, bridgeScriptPath, claudeConfigIsPackaged, claudeConfigPath, manualEntrySnippet, mergeClaudeConfig, SERVER_KEY,
} from './mcpDesktopConfig';

const probe = (tree: Record<string, string[]>) => ({ readDir: (p: string) => tree[p] ?? [] });

describe('the Claude Desktop config', () => {
  it('is found where Claude Desktop reads it: macOS, Windows classic and MSIX, none on Linux', () => {
    expect(claudeConfigPath('darwin', {}, '/Users/casey')).toBe('/Users/casey/Library/Application Support/Claude/claude_desktop_config.json');
    const env = { APPDATA: 'C:\\Users\\c\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\c\\AppData\\Local' };
    expect(claudeConfigPath('win32', env, 'C:\\Users\\c', probe({}))).toBe('C:\\Users\\c\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
    const pkgs = 'C:\\Users\\c\\AppData\\Local\\Packages';
    const msix = claudeConfigPath('win32', env, 'C:\\Users\\c', probe({
      [pkgs]: ['Claude_aaa', 'Claude_bbb', 'Other_x'],
      [`${pkgs}\\Claude_bbb\\LocalCache\\Roaming\\Claude`]: ['claude_desktop_config.json'],
    }));
    expect(msix).toBe(`${pkgs}\\Claude_bbb\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json`);   // the one in use
    expect(claudeConfigIsPackaged(msix!)).toBe(true);
    expect(claudeConfigIsPackaged('C:\\Users\\c\\AppData\\Roaming\\Claude\\claude_desktop_config.json')).toBe(false);
    expect(claudeConfigPath('linux', {}, '/home/c')).toBeNull();
  });

  it('runs lastGLANCE\'s own binary as Node on the bundled bridge, with lastGLANCE\'s profile', () => {
    const entry = bridgeEntry('/Applications/lastGLANCE.app/Contents/MacOS/lastGLANCE', '/Applications/lastGLANCE.app/Contents/Resources');
    expect(entry).toEqual({
      command: '/Applications/lastGLANCE.app/Contents/MacOS/lastGLANCE',
      args: [bridgeScriptPath('/Applications/lastGLANCE.app/Contents/Resources'), '--app', 'lastglance'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    // A packaged Claude Desktop cannot see the discovery file: the port and token go in the entry.
    expect(bridgeEntry('/x', '/r', { port: 7900, token: 'tok' }).args.slice(1)).toEqual(['--app', 'lastglance', '--port', '7900', '--token', 'tok']);
  });

  it('merges only its own entry, leaving every other server (dayGLANCE\'s included) and key alone', () => {
    const entry = bridgeEntry('/x', '/r');
    expect(SERVER_KEY).toBe('lastglance');
    const created = mergeClaudeConfig(null, entry);
    expect(created.action).toBe('created');
    expect(JSON.parse((created as { text: string }).text)).toEqual({ mcpServers: { lastglance: entry } });

    const existing = JSON.stringify({ globalShortcut: 'Ctrl+Space', mcpServers: { dayglance: { command: 'dg' }, lastglance: { command: 'old' } } });
    const merged = mergeClaudeConfig(existing, entry);
    expect(merged.action).toBe('merged');
    expect(JSON.parse((merged as { text: string }).text)).toEqual({ globalShortcut: 'Ctrl+Space', mcpServers: { dayglance: { command: 'dg' }, lastglance: entry } });

    for (const bad of ['{oops', '[]', 'null', '"text"']) expect(mergeClaudeConfig(bad, entry)).toEqual({ action: 'unparseable' });
    expect(JSON.parse(manualEntrySnippet(entry))).toEqual({ mcpServers: { lastglance: entry } });
  });

  it('never writes a URL entry, which Claude Desktop drops the whole mcpServers block over', () => {
    expect(JSON.stringify(bridgeEntry('/x', '/r'))).not.toMatch(/"url"/);
  });
});
