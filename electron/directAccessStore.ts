// From dayGLANCE electron/directAccessStore.ts (krelltunez/dayGLANCE@8d72008), with lastGLANCE's file
// names and the People file watched beside the snapshot.
//
/**
 * Direct Access sync: the filesystem half (docs/direct-access.md).
 *
 * Reads and writes lastglance-sync.json inside a folder the user picked, which
 * a third-party tool (Google Drive for desktop, Dropbox, OneDrive, Syncthing, a
 * network share) keeps in step across devices. This module knows nothing about
 * Electron: directAccess.ts owns the dialog, the security-scoped bookmark and
 * the IPC, and hands this store the resolved folder. Keeping the two apart is
 * what lets the read classification and the watcher run under vitest against
 * a temp directory.
 *
 * Read classification is the part that carries data safety, and it mirrors the
 * iCloud bridge's contract (electron/icloud.ts) so the renderer's shared cycle
 * (src/sync/snapshotFileSync.js) treats both alike:
 *
 *   absent        → the file is not there: the renderer may seed it.
 *   downloading   → the file is there but cannot be trusted yet: a zero-length
 *                   placeholder (Drive streaming, OneDrive Files On-Demand and
 *                   Dropbox online-only all materialise cloud-only files this
 *                   way, and a tool mid-write looks the same), or a read that
 *                   failed transiently. The renderer skips the cycle and the
 *                   next poll retries. This is NEVER reported as absent, because
 *                   absent means "seed over it".
 *   error         → the folder itself is unreachable (unmounted drive, the
 *                   streaming tool not running, a revoked grant) or the file is
 *                   unreadable for a permanent reason. The renderer surfaces it.
 *   text          → the file's content, for the renderer to parse and merge.
 *
 * Writes are atomic (temp file in the same directory, fsync, rename) via
 * writeFileAtomicSync. Unlike the iCloud container, these folders do not rely on
 * extended attributes to queue an upload, and a torn file is the worse hazard:
 * the syncing tool would ship the torn copy to every other device.
 */

import path from 'node:path';
import fs from 'node:fs';
import { retryTransientFs } from './fsRetry.js';
import { writeFileAtomicSync } from './atomicWrite.js';

export const SYNC_FILE = 'lastglance-sync.json';
/** People's snapshot, beside the chores one (src/sync/directAccess.ts). */
export const PEOPLE_FILE = 'lastglance-people.json';
/** A change to either nudges a sync cycle; the 15 s poll covers everything else. */
export const WATCHED_FILES: ReadonlySet<string> = new Set([SYNC_FILE, PEOPLE_FILE]);

/**
 * How long after our own write the watcher ignores events on the file. The
 * atomic rename fires one or two events; a tool re-stamping the file after it
 * uploads can add another shortly after. Remote changes arriving inside the
 * window are not lost: the poll reads the file regardless.
 */
export const WRITE_SUPPRESSION_MS = 2000;
export const WATCH_DEBOUNCE_MS = 1000;
export const WATCH_REATTACH_MS = 5000;

export type DirectAccessRead =
  | { kind: 'absent' }
  | { kind: 'downloading' }
  | { kind: 'error'; error: string }
  | { kind: 'text'; text: string };

const errCode = (e: unknown): string | undefined =>
  (e as NodeJS.ErrnoException | undefined)?.code;

/** Permanent read failures that the user has to act on. Everything else is retried silently. */
const PERMANENT_READ_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM']);

/**
 * Describes why a folder cannot be reached, in words the settings panel can
 * show without leaking a path into the status line.
 */
export function describeFolderError(e: unknown): string {
  switch (errCode(e)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'folder not found';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    default:
      return (e as Error | undefined)?.message || 'folder unavailable';
  }
}

export interface DirectAccessStore {
  /** Point the store at a folder (or at nothing). Clears the read cache. */
  setBase(dir: string | null): void;
  getBase(): string | null;
  /** Is the folder a readable directory right now? */
  reachable(): boolean;
  read(): DirectAccessRead;
  write(text: string): boolean;
  /** Deletes the snapshot. A missing file counts as deleted. */
  remove(): boolean;
  /** Watches the folder for changes to the snapshot not made by this store. */
  startWatch(onChange: () => void): void;
  stopWatch(): void;

  // ── Files by path, confined to the folder (docs/direct-access.md,
  // Phase 5). The household roster lives at GLANCE/users/glance-users.json
  // relative to the picked folder, and the intents transport (Phase 7) lists
  // and creates event files under GLANCE/events/. Every path is relative to
  // the folder; one that escapes it (`..`, an absolute path) is refused HERE,
  // never left to the renderer. The snapshot calls above stay as they are.
  /** File names in a directory, [] for a missing directory, null when the folder itself is unusable. */
  listFiles(rel: string): string[] | null;
  readFile(rel: string): DirectAccessRead;
  /** Atomic, parents created. */
  writeFile(rel: string, text: string): boolean;
  /** Idempotent: a missing file counts as deleted. */
  deleteFile(rel: string): boolean;
  makeDir(rel: string): boolean;
}

/**
 * The absolute path of `rel` inside `base`, or null when it would land
 * outside. Only `rel` strings that resolve to the folder itself or below it
 * pass: `..`, an absolute path, a drive letter on Windows all fail the prefix
 * check after resolution.
 */
export function resolveInside(base: string, rel: unknown): string | null {
  if (typeof rel !== 'string') return null;
  const root = path.resolve(base);
  const abs = path.resolve(root, rel);
  if (abs === root) return abs;
  return abs.startsWith(root + path.sep) ? abs : null;
}

interface StoreDeps {
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

export function createDirectAccessStore({ now = Date.now, log = console }: StoreDeps = {}): DirectAccessStore {
  let base: string | null = null;
  let lastWriteAt = 0;

  // The poll reads the file every 15 s. Most of those reads find it untouched,
  // so the content is served from this cache while size and mtime match the
  // last read; our own writes invalidate it.
  let cache: { mtimeMs: number; size: number; text: string } | null = null;

  let watcher: fs.FSWatcher | null = null;
  let watchCb: (() => void) | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let reattach: ReturnType<typeof setTimeout> | null = null;

  const filePath = (): string | null => (base ? path.join(base, SYNC_FILE) : null);

  const reachable = (): boolean => {
    if (!base) return false;
    try {
      fs.accessSync(base, fs.constants.R_OK);
      return fs.statSync(base).isDirectory();
    } catch {
      return false;
    }
  };

  const read = (): DirectAccessRead => {
    const file = filePath();
    if (!file || !base) return { kind: 'error', error: 'no folder connected' };

    // The folder first: a vanished mount or a stopped streaming tool must read
    // as an error, not as "the file is absent" (which would seed a new file
    // into whatever reappears there).
    try {
      if (!fs.statSync(base).isDirectory()) return { kind: 'error', error: 'folder not found' };
    } catch (e) {
      return { kind: 'error', error: describeFolderError(e) };
    }

    let stat: fs.Stats;
    try {
      stat = retryTransientFs(() => fs.statSync(file));
    } catch (e) {
      if (errCode(e) === 'ENOENT') return { kind: 'absent' };
      if (PERMANENT_READ_CODES.has(errCode(e) ?? '')) return { kind: 'error', error: describeFolderError(e) };
      return { kind: 'downloading' };
    }
    if (!stat.isFile()) return { kind: 'error', error: `${SYNC_FILE} is not a file` };
    // A cloud-only placeholder, or a tool part-way through replacing the file.
    if (stat.size === 0) return { kind: 'downloading' };

    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return { kind: 'text', text: cache.text };
    }

    let text: string;
    try {
      text = retryTransientFs(() => fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      if (PERMANENT_READ_CODES.has(errCode(e) ?? '')) return { kind: 'error', error: describeFolderError(e) };
      // Hydration in progress, a lock held by the syncing tool, a transient
      // I/O failure: retry on the next poll.
      return { kind: 'downloading' };
    }
    // Read raced a truncate-then-write by another tool.
    if (text.length === 0) return { kind: 'downloading' };
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, text };
    return { kind: 'text', text };
  };

  const write = (text: string): boolean => {
    const file = filePath();
    if (!file) return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      lastWriteAt = now();
      writeFileAtomicSync(file, text);
      cache = null;
      return true;
    } catch (e) {
      log.warn('[direct-access] write failed:', (e as Error)?.message ?? e);
      return false;
    }
  };

  const remove = (): boolean => {
    const file = filePath();
    if (!file) return false;
    try {
      lastWriteAt = now();
      fs.unlinkSync(file);
      cache = null;
      return true;
    } catch (e) {
      cache = null;
      return errCode(e) === 'ENOENT';
    }
  };

  const clearTimers = () => {
    if (debounce) { clearTimeout(debounce); debounce = null; }
    if (reattach) { clearTimeout(reattach); reattach = null; }
  };

  const stopWatch = () => {
    watchCb = null;
    clearTimers();
    if (watcher) {
      try { watcher.close(); } catch { /* already closed */ }
      watcher = null;
    }
  };

  // Re-attachable: syncing tools recreate the folder on occasion (a remount, a
  // full re-sync), which closes the watcher silently. The poll keeps sync
  // working in the meantime; this only makes remote changes land sooner.
  const attach = () => {
    if (!base || !watchCb) return;
    const dir = base;
    try {
      const self = fs.watch(dir, (_eventType, filename) => {
        if (watcher !== self) return;
        if (!filename || !WATCHED_FILES.has(String(filename))) return;
        if (now() - lastWriteAt < WRITE_SUPPRESSION_MS) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          watchCb?.();
        }, WATCH_DEBOUNCE_MS);
      });
      watcher = self;
      // Only the live watcher may schedule a re-attach: closing a superseded
      // one (stopWatch, setBase) emits 'close' too, and that must not tear
      // down its replacement.
      const scheduleReattach = () => {
        if (watcher !== self || !watchCb) return;
        try { self.close(); } catch { /* ignore */ }
        watcher = null;
        if (!reattach) reattach = setTimeout(() => { reattach = null; attach(); }, WATCH_REATTACH_MS);
      };
      self.on('error', scheduleReattach);
      self.on('close', scheduleReattach);
    } catch {
      // fs.watch is unsupported on some network filesystems; the poll covers it.
      if (!reattach) reattach = setTimeout(() => { reattach = null; attach(); }, WATCH_REATTACH_MS);
    }
  };

  const startWatch = (onChange: () => void) => {
    stopWatch();
    watchCb = onChange;
    attach();
  };

  const setBase = (dir: string | null) => {
    const cb = watchCb;
    stopWatch();
    base = dir;
    cache = null;
    if (cb && dir) startWatch(cb);
  };

  // ── Files by path ──────────────────────────────────────────────────────
  const inside = (rel: unknown): string | null => (base ? resolveInside(base, rel) : null);

  const listFiles = (rel: string): string[] | null => {
    if (!reachable()) return null;
    const abs = inside(rel);
    if (!abs) return null;
    try {
      return fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
    } catch (e) {
      return errCode(e) === 'ENOENT' ? [] : null;
    }
  };

  const readFile = (rel: string): DirectAccessRead => {
    if (!base) return { kind: 'error', error: 'no folder connected' };
    if (!reachable()) return { kind: 'error', error: 'folder not found' };
    const abs = inside(rel);
    if (!abs || abs === path.resolve(base)) return { kind: 'error', error: 'path outside the folder' };
    let stat: fs.Stats;
    try {
      stat = retryTransientFs(() => fs.statSync(abs));
    } catch (e) {
      if (errCode(e) === 'ENOENT') return { kind: 'absent' };
      if (PERMANENT_READ_CODES.has(errCode(e) ?? '')) return { kind: 'error', error: describeFolderError(e) };
      return { kind: 'downloading' };
    }
    if (!stat.isFile()) return { kind: 'error', error: `${rel} is not a file` };
    // The same placeholder rule as the snapshot: a cloud-only file is an
    // empty entry until the tool materialises it.
    if (stat.size === 0) return { kind: 'downloading' };
    try {
      const text = retryTransientFs(() => fs.readFileSync(abs, 'utf-8'));
      return text.length === 0 ? { kind: 'downloading' } : { kind: 'text', text };
    } catch (e) {
      if (PERMANENT_READ_CODES.has(errCode(e) ?? '')) return { kind: 'error', error: describeFolderError(e) };
      return { kind: 'downloading' };
    }
  };

  const writeFile = (rel: string, text: string): boolean => {
    if (!base || !reachable()) return false;
    const abs = inside(rel);
    if (!abs || abs === path.resolve(base) || typeof text !== 'string') return false;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      lastWriteAt = now();
      writeFileAtomicSync(abs, text);
      return true;
    } catch (e) {
      log.warn('[direct-access] writeFile failed:', (e as Error)?.message ?? e);
      return false;
    }
  };

  const deleteFile = (rel: string): boolean => {
    if (!base || !reachable()) return false;
    const abs = inside(rel);
    if (!abs || abs === path.resolve(base)) return false;
    try {
      lastWriteAt = now();
      fs.unlinkSync(abs);
      return true;
    } catch (e) {
      return errCode(e) === 'ENOENT';
    }
  };

  const makeDir = (rel: string): boolean => {
    if (!base || !reachable()) return false;
    const abs = inside(rel);
    if (!abs) return false;
    try {
      fs.mkdirSync(abs, { recursive: true });
      return true;
    } catch {
      return false;
    }
  };

  return {
    setBase,
    getBase: () => base,
    reachable,
    read,
    write,
    remove,
    startWatch,
    stopWatch,
    listFiles,
    readFile,
    writeFile,
    deleteFile,
    makeDir,
  };
}
