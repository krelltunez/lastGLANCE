// iCloud Drive on macOS (docs/desktop-app.md, section 6; the feature is
// docs/icloud-sync.md). The renderer runs the iOS tier unchanged (the
// transport, the cycle, the seed guards, the first-run question); this
// supplies the ICloudPluginType the iOS shell implements
// (ios/App/App/plugins/ICloudPlugin.swift), over plain files:
//
//   own        ~/Library/Mobile Documents/iCloud~com~lastglance/Documents
//              lastglance-sync.json, lastglance-people.json
//   dayglance  ~/Library/Mobile Documents/iCloud~com~dayglance/Documents
//              GLANCE/events/, the intents dayGLANCE exchanges
//
// After dayGLANCE's electron/icloud.ts (krelltunez/dayGLANCE@8d72008), which
// ships the same approach: no helper process (a helper would not inherit the
// iCloud developer entitlement under the MAS sandbox), and the real home
// recovered from the sandbox's redirected one.
//
// The rules, and where they differ from iOS:
//  - Available means the container folder exists. A Mac cannot create the
//    container itself without Apple's API, so iCloud lights up once the iOS app
//    has created it on this Apple ID; available() is asked every cycle, so it
//    appears by itself when the folder syncs down. Nothing here creates it.
//  - Reads answer the shared classification. A cloud-only file is a hidden
//    .name.icloud placeholder (before macOS 14) or a dataless file whose read
//    fetches it (macOS 14 and later): the first reads `downloading`; for the
//    second, an EDEADLK/ETIMEDOUT/EAGAIN while macOS fetches also reads
//    `downloading`, and a second read of a file whose first read has not
//    returned does too, so a stalled fetch never piles up reads.
//  - Freshness: iOS serves a file only once iCloud reports it CURRENT, an
//    answer only Apple's API gives. Here the local bytes are served as they are
//    (as dayGLANCE does), and `allowStale` changes nothing. That is safe for
//    this data: every device keeps its own copy and the cycle merges row by row
//    by edit stamp, so reading an older file only means this device catches up
//    on its next cycle; it cannot erase another device's edits.
//  - Writes are in place, never temp-and-rename (dayGLANCE's rule): rename
//    replaces the inode and drops the extended attributes that make the iCloud
//    daemon queue the upload. Each write is a full rewrite with fsync; a torn
//    read is classified by the cycle and retried.
//  - Paths are relative to Documents/ and confined to it, as on iOS.
//
// File access and the download request are injected, so this is tested
// against a temp folder.

import fs from 'node:fs';
import path from 'node:path';
import { retryTransientFs } from './fsRetry.js';

export const CONTAINERS = {
  own: 'iCloud~com~lastglance',
  dayglance: 'iCloud~com~dayglance',
} as const;
export type ICloudContainer = keyof typeof CONTAINERS;

/** The own container's files whose change on disk runs a cycle. */
export const WATCHED_FILES: ReadonlySet<string> = new Set(['lastglance-sync.json', 'lastglance-people.json']);

export const WRITE_SUPPRESSION_MS = 2000;
export const WATCH_DEBOUNCE_MS = 1000;
export const WATCH_REATTACH_MS = 5000;

export type ICloudRead =
  | { kind: 'absent' }
  | { kind: 'downloading' }
  | { kind: 'error'; error: string }
  | { kind: 'text'; text: string };

/** The real home, recovered from the MAS sandbox's redirected one (a no-op elsewhere). */
export function realHomeDir(home: string): string {
  return home.replace(/\/Library\/Containers\/[^/]+\/Data$/, '');
}

/** The path's segments, or null for an absolute path or any `..` (ICloudPlugin.segments). */
export function pathSegments(rel: unknown): string[] | null {
  if (typeof rel !== 'string') return null;
  if (rel.startsWith('/') || rel.startsWith('\\') || rel.includes(':')) return null;
  const out: string[] = [];
  for (const raw of rel.split(/[/\\]/)) {
    const seg = raw.trim();
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  return out;
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;
/** Errors macOS raises while it fetches a dataless file: not yet, try again. */
const FETCHING_CODES: ReadonlySet<string> = new Set(['EDEADLK', 'ETIMEDOUT', 'EAGAIN', 'EBUSY', 'EINTR']);

export interface ICloudStoreDeps {
  /** app.getPath('home'), possibly sandbox-redirected. */
  home: string;
  /** Ask the iCloud daemon to fetch a file (best-effort; may be absent). */
  requestDownload?: (absPath: string) => void;
  now?: () => number;
}

export function createICloudStore(deps: ICloudStoreDeps) {
  const now = deps.now ?? Date.now;
  const requestDownload = deps.requestDownload ?? (() => {});
  const mobileDocuments = path.join(realHomeDir(deps.home), 'Library', 'Mobile Documents');
  const reading = new Set<string>();
  let lastWriteAt = 0;

  const documentsDir = (container: unknown): string | null => {
    const key = typeof container === 'string' ? container : 'own';
    return Object.prototype.hasOwnProperty.call(CONTAINERS, key) ? path.join(mobileDocuments, CONTAINERS[key as ICloudContainer], 'Documents') : null;
  };
  const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

  /** The file a call names, or a reason it names none. */
  const locate = (rel: unknown, container: unknown, allowRoot = false): { abs: string } | { error: string } => {
    const docs = documentsDir(container);
    if (!docs || !isDir(docs)) return { error: 'iCloud not available' };
    const segs = pathSegments(rel);
    if (!segs || (segs.length === 0 && !allowRoot)) return { error: 'bad path' };
    return { abs: path.join(docs, ...segs) };
  };

  const placeholderOf = (abs: string) => path.join(path.dirname(abs), `.${path.basename(abs)}.icloud`);

  return {
    available(): { available: boolean } {
      const docs = documentsDir('own');
      return { available: !!docs && isDir(docs) };
    },

    async readFile(rel: unknown, container: unknown): Promise<ICloudRead> {
      const where = locate(rel, container);
      if ('error' in where) return { kind: 'error', error: where.error };
      const { abs } = where;
      if (reading.has(abs)) return { kind: 'downloading' };
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch (e) {
        if (errCode(e) !== 'ENOENT') return { kind: 'downloading' };
        if (fs.existsSync(placeholderOf(abs))) {
          requestDownload(abs);
          return { kind: 'downloading' };
        }
        return { kind: 'absent' };
      }
      if (!stat.isFile()) return { kind: 'error', error: 'not a file' };
      // A zero-length file is mid-write or mid-download, never empty data.
      if (stat.size === 0) return { kind: 'downloading' };
      reading.add(abs);
      try {
        const text = await fs.promises.readFile(abs, 'utf-8');
        return text.length === 0 ? { kind: 'downloading' } : { kind: 'text', text };
      } catch (e) {
        const code = errCode(e) ?? '';
        if (code === 'ENOENT') return { kind: 'absent' };
        if (FETCHING_CODES.has(code)) {
          requestDownload(abs);
          return { kind: 'downloading' };
        }
        return { kind: 'error', error: e instanceof Error ? e.message : 'unreadable file' };
      } finally {
        reading.delete(abs);
      }
    },

    writeFile(rel: unknown, text: unknown, container: unknown): { ok: boolean; error?: string } {
      if (typeof text !== 'string') return { ok: false, error: 'missing text' };
      const where = locate(rel, container);
      if ('error' in where) return { ok: false, error: where.error };
      try {
        fs.mkdirSync(path.dirname(where.abs), { recursive: true });
        // In place: open without replacing the inode, truncate, write, fsync.
        lastWriteAt = now();
        retryTransientFs(() => {
          const fd = fs.openSync(where.abs, fs.existsSync(where.abs) ? 'r+' : 'w');
          try {
            fs.ftruncateSync(fd, 0);
            fs.writeSync(fd, text, 0, 'utf-8');
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'write failed' };
      }
    },

    listFiles(rel: unknown, container: unknown): { names: string[] | null } {
      const where = locate(rel, container, true);
      if ('error' in where) return { names: null };
      if (!fs.existsSync(where.abs)) return { names: [] };
      try {
        const names = new Set<string>();
        for (const entry of fs.readdirSync(where.abs)) {
          // A cloud-only file is listed by its own name, so a read of it
          // answers `downloading` and the caller waits for it.
          const placeholder = /^\.(.+)\.icloud$/.exec(entry);
          if (placeholder) {
            names.add(placeholder[1]);
            requestDownload(path.join(where.abs, placeholder[1]));
          } else if (!entry.startsWith('.')) {
            names.add(entry);
          }
        }
        return { names: [...names] };
      } catch {
        return { names: null };
      }
    },

    deleteFile(rel: unknown, container: unknown): { ok: boolean; error?: string } {
      const where = locate(rel, container);
      if ('error' in where) return { ok: false, error: where.error };
      try {
        lastWriteAt = now();
        fs.unlinkSync(where.abs);
        return { ok: true };
      } catch (e) {
        return errCode(e) === 'ENOENT' ? { ok: true } : { ok: false, error: e instanceof Error ? e.message : 'delete failed' };
      }
    },

    makeDir(rel: unknown, container: unknown): { ok: boolean; error?: string } {
      const where = locate(rel, container);
      if ('error' in where) return { ok: false, error: where.error };
      try {
        fs.mkdirSync(where.abs, { recursive: true });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'mkdir failed' };
      }
    },

    /**
     * Watch the own container for a change to a sync file not made here
     * (debounced, own writes suppressed). Waits for the folder to appear, and
     * re-attaches when iCloud recreates it. Returns the stop function.
     */
    watch(onChange: () => void): () => void {
      let watcher: fs.FSWatcher | null = null;
      let debounce: ReturnType<typeof setTimeout> | null = null;
      let reattach: ReturnType<typeof setTimeout> | null = null;
      let stopped = false;
      const schedule = () => {
        if (!stopped && !reattach) reattach = setTimeout(() => { reattach = null; attach(); }, WATCH_REATTACH_MS);
      };
      const attach = () => {
        if (stopped) return;
        const docs = documentsDir('own');
        if (!docs || !isDir(docs)) { schedule(); return; }
        try {
          const self = fs.watch(docs, (_event, filename) => {
            const name = String(filename ?? '').replace(/^\.(.+)\.icloud$/, '$1');
            if (!WATCHED_FILES.has(name)) return;
            if (now() - lastWriteAt < WRITE_SUPPRESSION_MS) return;
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => { debounce = null; if (!stopped) onChange(); }, WATCH_DEBOUNCE_MS);
          });
          const lost = () => { if (watcher === self) { watcher = null; schedule(); } };
          self.on('error', lost);
          self.on('close', lost);
          watcher = self;
        } catch {
          schedule();
        }
      };
      attach();
      return () => {
        stopped = true;
        if (debounce) clearTimeout(debounce);
        if (reattach) clearTimeout(reattach);
        const w = watcher;
        watcher = null;
        try { w?.close(); } catch { /* already closed */ }
      };
    },
  };
}
