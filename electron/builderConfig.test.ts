// electron-builder.config.cjs, checked without running electron-builder: CI's
// pull-request path never packages, so a malformed config would first meet
// reality at release time. After dayGLANCE's electron/builderConfigSchema.test.ts
// (krelltunez/dayGLANCE@8d72008), which validates against electron-builder's own
// schema for the same reason (an artifactName inside a target entry killed a
// release build with an error pointing at the wrong key).

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DEEP_LINK_SCHEME } from './deepLink';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');

/** A bare specifier's package name: '@scope/name' or 'name'. */
const packageOf = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

/**
 * The packages main loads at run time: every value import (not `import type`)
 * in electron/*.ts outside the tests, other than electron, node builtins and
 * billing (shipped in part, checked on its own), with their dependencies and
 * peer dependencies followed transitively.
 */
function mainRuntimeClosure(): Set<string> {
  const seeds = readdirSync(path.join(root, 'electron'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .flatMap((f) => [...readFileSync(path.join(root, 'electron', f), 'utf-8').matchAll(/^import (?!type )[^'"]*from '([^'.][^']*)'/gm)].map((m) => m[1]))
    .filter((spec) => spec !== 'electron' && !spec.startsWith('node:'))
    .map(packageOf)
    .filter((name) => name !== '@glance-apps/billing');
  const closure = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift()!;
    if (closure.has(name)) continue;
    closure.add(name);
    const pkg = JSON.parse(readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf-8'));
    queue.push(...Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }));
  }
  return closure;
}

function loadConfig() {
  delete require.cache[require.resolve('../electron-builder.config.cjs')];
  return require('../electron-builder.config.cjs');
}

describe('electron-builder.config.cjs', () => {
  const config = loadConfig();

  it('validates against electron-builder’s own schema', () => {
    const Ajv = require('ajv');
    const schema = require('app-builder-lib/scheme.json');
    const check = new Ajv({ allErrors: true, strict: false, verbose: true }).compile(schema);
    const ok = check(config);
    const detail = (check.errors ?? [])
      .map((e: { instancePath?: string; dataPath?: string; message?: string }) => `${e.instancePath ?? e.dataPath} ${e.message}`)
      .join('\n');
    expect(ok, detail).toBe(true);
  });

  it('target entries carry only target and arch, the keys the schema allows', () => {
    for (const platform of ['mac', 'win', 'linux']) {
      for (const t of (config[platform]?.target ?? []) as Record<string, unknown>[]) {
        for (const key of Object.keys(t)) {
          expect(['target', 'arch'], `${platform}.target has illegal key "${key}"`).toContain(key);
        }
      }
    }
  });

  it('builds both architectures on macOS and Linux, spelled out', () => {
    // An omitted arch means the build host's only: Linux shipped x64-only
    // that way in dayGLANCE for three releases.
    for (const platform of ['mac', 'linux']) {
      for (const t of config[platform].target as { target: string; arch: string[] }[]) {
        expect(t.arch, `${platform} ${t.target}`).toEqual(['x64', 'arm64']);
      }
    }
  });

  it('ships the renderer bundle and main, and of node_modules only what main imports at run time', () => {
    expect(config.files).toEqual(expect.arrayContaining(['dist/**/*', 'dist-electron/**/*', '!**/*.map', '!node_modules/**/*']));
    const shipped = config.files.filter((f: string) => f.startsWith('node_modules/'));
    // @glance-apps/billing ships only its main half, which may import nothing
    // that would then be missing from the package.
    expect(shipped).toEqual(expect.arrayContaining(['node_modules/@glance-apps/billing/package.json', 'node_modules/@glance-apps/billing/dist/electron-main/**/*']));
    const src = readFileSync(path.join(root, 'node_modules/@glance-apps/billing/dist/electron-main/index.js'), 'utf-8');
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.every((m) => m === 'electron' || m.startsWith('node:'))).toBe(true);

    // Every other package main imports ships whole, with everything it imports
    // in turn (dependencies, and peer dependencies, which npm installs): a
    // package left out is a crash at run time that no test before packaging sees.
    const whole = shipped
      .filter((f: string) => !f.startsWith('node_modules/@glance-apps/billing/'))
      .map((f: string) => /^node_modules\/((?:@[^/]+\/)?[^/]+)\/\*\*\/\*$/.exec(f)?.[1] ?? f);
    expect([...whole].sort()).toEqual([...mainRuntimeClosure()].sort());
  });

  it('points at icons that exist', () => {
    for (const icon of [config.mac.icon, config.win.icon, config.linux.icon]) {
      expect(existsSync(path.join(root, icon)), icon).toBe(true);
    }
  });

  it('lists every shipped locale in the macOS bundle', () => {
    const locales = readdirSync(path.join(root, 'public/locales')).sort();
    expect(config.mac.electronLanguages).toEqual(locales);
    expect(config.mac.extendInfo.CFBundleLocalizations).toContain('zh-Hans');
  });

  it('gives the deb the metadata it fails without', () => {
    expect(config.linux.maintainer).toMatch(/<.+@.+>/);
    expect(config.linux.category).toBeTruthy();
  });

  it('ships the tray icons main loads', () => {
    expect(config.extraResources).toEqual([{ from: 'electron/resources/tray', to: 'tray' }]);
    for (const name of ['trayTemplate.png', 'trayTemplate@2x.png', 'tray.png', 'tray@2x.png']) {
      expect(existsSync(path.join(root, 'electron/resources/tray', name)), name).toBe(true);
    }
  });

  it('signs ad-hoc without a certificate, and notarizes through the afterSign hook', () => {
    expect(config.mac.identity).toBeNull();
    expect(config.mac.hardenedRuntime).toBe(false);
    expect(config.mac.notarize).toBe(false);
    expect(config.afterSign).toBe('./scripts/notarize.cjs');
    expect(existsSync(path.join(root, 'scripts/notarize.cjs'))).toBe(true);
    for (const f of [config.mac.entitlements, config.mas.entitlements, config.mas.entitlementsInherit]) {
      expect(existsSync(path.join(root, f)), f).toBe(true);
    }
  });

  it('with a Developer ID certificate, signs with Hardened Runtime', () => {
    process.env.CSC_LINK = 'x';
    try {
      const signed = loadConfig();
      expect(signed.mac.identity).toBeUndefined();
      expect(signed.mac.hardenedRuntime).toBe(true);
    } finally {
      delete process.env.CSC_LINK;
    }
  });

  it('the MAS build takes the iOS bundle id, a rising build number, and a keychain identity', () => {
    process.env.LASTGLANCE_APP_ID = 'com.lastglance';
    try {
      const mas = loadConfig();
      expect(mas.appId).toBe('com.lastglance');
      expect(mas.mac.identity).toBeUndefined();
      expect(mas.buildVersion).toMatch(/^\d{8}\.\d{4}$/);
      expect(mas.mas.hardenedRuntime).toBe(false);
      expect(mas.mas.provisioningProfile).toBe('electron/lastglance.mas.provisionprofile');
    } finally {
      delete process.env.LASTGLANCE_APP_ID;
    }
    expect(config.buildVersion).toBeUndefined();
  });

  it('gives the MAS app the sandbox, both iCloud containers, and nothing it does not use', () => {
    const plist = readFileSync(path.join(root, 'electron/entitlements.mas.plist'), 'utf-8');
    for (const key of [
      'com.apple.security.app-sandbox', 'com.apple.security.network.client',
      'com.apple.security.files.user-selected.read-write', 'com.apple.security.files.bookmarks.app-scope',
      'iCloud.com.lastglance', 'iCloud.com.dayglance', 'CloudDocuments',
    ]) expect(plist, key).toContain(key);
    // No listener yet (MCP and Stream Deck come later), and Apple Pay's
    // entitlement fails App Store validation on macOS.
    expect(plist).not.toContain('<key>com.apple.security.network.server</key>');
    expect(plist).not.toContain('<key>com.apple.security.in-app-payments</key>');
    const inherit = readFileSync(path.join(root, 'electron/entitlements.mas.inherit.plist'), 'utf-8');
    expect(inherit).toContain('com.apple.security.inherit');
  });

  it('keeps the provisioning profile out of git', () => {
    expect(readFileSync(path.join(root, '.gitignore'), 'utf-8')).toContain('electron/*.provisionprofile');
  });

  it('registers the lastglance:// scheme the app handles', () => {
    expect(config.protocols).toEqual([{ name: 'lastGLANCE', schemes: [DEEP_LINK_SCHEME] }]);
  });

  it('keeps the Android application id for direct builds', () => {
    expect(config.appId).toBe('com.lastglance.app');
  });
});
