// The desktop bridge's three spellings, held to one list (docs/desktop-app.md,
// section 2), as headlessRefresh.test.ts holds HEADLESS_BRIDGE_METHODS to
// HeadlessBridge.kt:
//
//  - src/native/desktop.ts: the renderer's interfaces and DESKTOP_BRIDGE_METHODS;
//  - electron/preload.cts: what contextBridge actually exposes;
//  - electron/main.ts: the ipcMain handlers behind it.
//
// A source-text test: the preload is sandboxed and cannot be imported here, and
// this is the seam a method added on one side only would slip through.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DESKTOP_BRIDGE_METHODS } from '../src/native/desktop';
import { DESKTOP_INFO_ARG } from './desktopInfo.js';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf-8');

const preload = read('electron/preload.cts');
const desktopTs = read('src/native/desktop.ts');
const mainTs = read('electron/main.ts');

/** The exposed object literal's groups: { group: { key: isFunction } }. */
function preloadGroups(): Record<string, Record<string, boolean>> {
  const start = preload.indexOf("exposeInMainWorld('lastGlanceDesktop', {");
  expect(start, 'preload exposes lastGlanceDesktop').toBeGreaterThan(-1);
  const body = preload.slice(start);
  const groups: Record<string, Record<string, boolean>> = {};
  let current: string | null = null;
  for (const line of body.split('\n').slice(1)) {
    const group = /^ {2}(\w+): \{$/.exec(line);
    if (group) { current = group[1]; groups[current] = {}; continue; }
    if (/^\}\);/.test(line)) break;
    const entry = /^ {4}(\w+): (.*)$/.exec(line);
    if (entry && current) groups[current][entry[1]] = /^\(.*\) =>/.test(entry[2]);
  }
  return groups;
}

/** An interface's member names, split into methods and properties. */
function interfaceMembers(name: string): { methods: string[]; props: string[] } {
  const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(desktopTs);
  expect(m, `interface ${name} in desktop.ts`).not.toBeNull();
  const methods: string[] = [];
  const props: string[] = [];
  for (const line of m![1].split('\n')) {
    const method = /^ {2}(\w+)\(/.exec(line);
    if (method) { methods.push(method[1]); continue; }
    const prop = /^ {2}(\w+)\??: /.exec(line);
    if (prop) props.push(prop[1]);
  }
  return { methods, props };
}

describe('desktop bridge contract', () => {
  const groups = preloadGroups();
  const bridge = interfaceMembers('DesktopBridge');
  const groupInterface = (group: string) => {
    const m = new RegExp(`^ {2}${group}: (\\w+)$`, 'm').exec(desktopTs);
    expect(m, `DesktopBridge.${group} has a named interface`).not.toBeNull();
    return interfaceMembers(m![1]);
  };

  it('exposes exactly the groups DesktopBridge declares', () => {
    expect(Object.keys(groups).sort()).toEqual([...bridge.props].sort());
  });

  it('exposes exactly the methods DESKTOP_BRIDGE_METHODS lists', () => {
    const exposed = Object.entries(groups).flatMap(([g, keys]) =>
      Object.entries(keys).filter(([, fn]) => fn).map(([k]) => `${g}.${k}`));
    expect(exposed.sort()).toEqual([...DESKTOP_BRIDGE_METHODS].sort());
  });

  it('declares exactly the methods DESKTOP_BRIDGE_METHODS lists', () => {
    const declared = bridge.props.flatMap((g) => groupInterface(g).methods.map((m) => `${g}.${m}`));
    expect(declared.sort()).toEqual([...DESKTOP_BRIDGE_METHODS].sort());
  });

  it('exposes every info field DesktopInfo declares, and no other', () => {
    const fields = Object.entries(groups.info ?? {}).filter(([, fn]) => !fn).map(([k]) => k);
    expect(fields.sort()).toEqual(groupInterface('info').props.sort());
  });

  it('handles in main every channel the preload sends or invokes', () => {
    const sent = new Set([...preload.matchAll(/ipcRenderer\.(?:send|invoke)\('([^']+)'/g)].map((m) => m[1]));
    const handled = new Set([...mainTs.matchAll(/ipcMain\.(?:on|handle)\('([^']+)'/g)].map((m) => m[1]));
    expect([...sent].sort()).toEqual([...handled].sort());
  });

  it('spells the info switch the same in the preload and desktopInfo.ts', () => {
    expect(preload).toContain(`const DESKTOP_INFO_ARG = '${DESKTOP_INFO_ARG}';`);
  });

  it('loads the compiled preload main.ts names', () => {
    // tsc emits preload.cts as preload.cjs; a .js name would load nothing.
    expect(mainTs).toContain("path.join(__dirname, 'preload.cjs')");
  });
});
