import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createICloudStore, pathSegments, realHomeDir, WRITE_SUPPRESSION_MS } from './icloud.js';

let home: string;
const docs = (container = 'iCloud~com~lastglance') => path.join(home, 'Library', 'Mobile Documents', container, 'Documents');
const makeContainer = (container?: string) => fs.mkdirSync(docs(container), { recursive: true });

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lastglance-icloud-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('paths', () => {
  it('recovers the real home from the MAS sandbox, and leaves a real one alone', () => {
    expect(realHomeDir('/Users/me/Library/Containers/com.lastglance/Data')).toBe('/Users/me');
    expect(realHomeDir('/Users/me')).toBe('/Users/me');
  });

  it('confines paths to Documents, as the iOS plugin does', () => {
    expect(pathSegments('GLANCE/events/a.json')).toEqual(['GLANCE', 'events', 'a.json']);
    expect(pathSegments('./x//y')).toEqual(['x', 'y']);
    for (const bad of ['/etc/passwd', '../x', 'a/../../b', 'C:\\x', '\\x', 42]) expect(pathSegments(bad)).toBeNull();
  });
});

describe('availability', () => {
  it('is the own container existing, and nothing creates it', async () => {
    const store = createICloudStore({ home });
    expect(store.available()).toEqual({ available: false });
    expect(store.writeFile('lastglance-sync.json', '{}', 'own')).toEqual({ ok: false, error: 'iCloud not available' });
    expect(await store.readFile('lastglance-sync.json', 'own')).toEqual({ kind: 'error', error: 'iCloud not available' });
    expect(fs.existsSync(docs())).toBe(false);
    makeContainer();
    expect(store.available()).toEqual({ available: true });
  });

  it('refuses an unknown container', async () => {
    makeContainer();
    expect(await createICloudStore({ home }).readFile('x.json', 'elsewhere')).toEqual({ kind: 'error', error: 'iCloud not available' });
  });
});

describe('reads', () => {
  beforeEach(() => makeContainer());

  it('classifies absent, text, empty and placeholder files', async () => {
    const requestDownload = vi.fn();
    const store = createICloudStore({ home, requestDownload });
    expect(await store.readFile('lastglance-sync.json', 'own')).toEqual({ kind: 'absent' });
    fs.writeFileSync(path.join(docs(), 'lastglance-sync.json'), '{"v":1}');
    expect(await store.readFile('lastglance-sync.json', 'own')).toEqual({ kind: 'text', text: '{"v":1}' });
    fs.writeFileSync(path.join(docs(), 'lastglance-people.json'), '');
    expect(await store.readFile('lastglance-people.json', 'own')).toEqual({ kind: 'downloading' });
    fs.writeFileSync(path.join(docs(), '.cloud-only.json.icloud'), 'bplist');
    expect(await store.readFile('cloud-only.json', 'own')).toEqual({ kind: 'downloading' });
    expect(requestDownload).toHaveBeenCalledWith(path.join(docs(), 'cloud-only.json'));
  });

  it('reads the dayglance container by path, and refuses a path outside it', async () => {
    makeContainer('iCloud~com~dayglance');
    fs.mkdirSync(path.join(docs('iCloud~com~dayglance'), 'GLANCE/events'), { recursive: true });
    fs.writeFileSync(path.join(docs('iCloud~com~dayglance'), 'GLANCE/events/e1.json'), '{"e":1}');
    const store = createICloudStore({ home });
    expect(await store.readFile('GLANCE/events/e1.json', 'dayglance')).toEqual({ kind: 'text', text: '{"e":1}' });
    expect(await store.readFile('../../../escape.json', 'dayglance')).toEqual({ kind: 'error', error: 'bad path' });
  });
});

describe('writes', () => {
  beforeEach(() => makeContainer());

  it('replaces the content in place, keeping the inode the iCloud daemon tracks', () => {
    const store = createICloudStore({ home });
    const file = path.join(docs(), 'lastglance-sync.json');
    fs.writeFileSync(file, 'a much longer first version of the file');
    const inode = fs.statSync(file).ino;
    expect(store.writeFile('lastglance-sync.json', '{"v":2}', 'own')).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"v":2}');
    expect(fs.statSync(file).ino).toBe(inode);
  });

  it('creates folders inside the container, lists, and deletes', () => {
    const store = createICloudStore({ home });
    expect(store.makeDir('GLANCE/events', 'own')).toEqual({ ok: true });
    expect(store.writeFile('GLANCE/events/b.json', '{}', 'own')).toEqual({ ok: true });
    fs.writeFileSync(path.join(docs(), 'GLANCE/events/.c.json.icloud'), 'x');
    fs.writeFileSync(path.join(docs(), 'GLANCE/events/.DS_Store'), 'x');
    expect(store.listFiles('GLANCE/events', 'own').names?.sort()).toEqual(['b.json', 'c.json']);
    expect(store.listFiles('GLANCE/missing', 'own')).toEqual({ names: [] });
    expect(store.deleteFile('GLANCE/events/b.json', 'own')).toEqual({ ok: true });
    expect(store.deleteFile('GLANCE/events/b.json', 'own')).toEqual({ ok: true });
    expect(store.writeFile('../outside.json', '{}', 'own')).toEqual({ ok: false, error: 'bad path' });
  });
});

describe('watching', () => {
  it('reports a change to a sync file made elsewhere, not its own writes, and waits for the folder', async () => {
    let t = 1_000_000;
    const store = createICloudStore({ home, now: () => t });
    const onChange = vi.fn();
    const stop = store.watch(onChange);
    try {
      makeContainer(); // appears after watching began: re-attached within 5 s
      await new Promise((r) => setTimeout(r, 5500));
      store.writeFile('lastglance-sync.json', '{"mine":true}', 'own');
      await new Promise((r) => setTimeout(r, 1300));
      expect(onChange).not.toHaveBeenCalled();
      t += WRITE_SUPPRESSION_MS + 1;
      fs.writeFileSync(path.join(docs(), 'lastglance-people.json'), '{"theirs":true}');
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 4000 });
      fs.writeFileSync(path.join(docs(), 'unrelated.json'), '{}');
      await new Promise((r) => setTimeout(r, 1300));
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  }, 20_000);
});
