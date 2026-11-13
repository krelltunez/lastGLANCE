import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoveryFilePath, discoveryPayload, syncDiscoveryFile } from './mcpDiscovery';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('the MCP discovery file', () => {
  it('goes where the bridge\'s lastGLANCE profile looks, on every platform, and nowhere on MAS', () => {
    expect(discoveryFilePath('darwin', {}, '/Users/casey', false)).toBe('/Users/casey/Library/Application Support/lastGLANCE/mcp.json');
    expect(discoveryFilePath('win32', { APPDATA: 'C:\\Users\\casey\\AppData\\Roaming' }, 'C:\\Users\\casey', false))
      .toBe('C:\\Users\\casey\\AppData\\Roaming\\lastGLANCE\\mcp.json');
    expect(discoveryFilePath('linux', { XDG_CONFIG_HOME: '/home/casey/.cfg' }, '/home/casey', false)).toBe('/home/casey/.cfg/lastGLANCE/mcp.json');
    expect(discoveryFilePath('linux', {}, '/home/casey', false)).toBe('/home/casey/.config/lastGLANCE/mcp.json');
    expect(discoveryFilePath('darwin', {}, '/Users/casey', true)).toBeNull();
    expect(discoveryFilePath('win32', {}, 'C:\\Users\\casey', false)).toBeNull();
    expect(discoveryFilePath('sunos', {}, '/home/casey', false)).toBeNull();
  });

  it('holds the port and the token only', () => {
    expect(JSON.parse(discoveryPayload(7900, 'tok'))).toEqual({ port: 7900, token: 'tok' });
  });

  it('is written owner-only while the server runs, and removed when it stops', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lastglance-discovery-')); dirs.push(d);
    const file = path.join(d, 'lastGLANCE', 'mcp.json');
    expect(syncDiscoveryFile(file, { port: 7900, token: 'tok' })).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ port: 7900, token: 'tok' });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    syncDiscoveryFile(file, { port: 8123, token: 'new' });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ port: 8123, token: 'new' });
    syncDiscoveryFile(file, null);
    expect(fs.existsSync(file)).toBe(false);
    expect(syncDiscoveryFile(null, { port: 1, token: 't' })).toBeNull();   // MAS: nothing, quietly
  });
});
