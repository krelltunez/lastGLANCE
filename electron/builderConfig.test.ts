// electron-builder.config.cjs, checked without running electron-builder: CI's
// pull-request path never packages, so a malformed config would first meet
// reality at release time. After dayGLANCE's electron/builderConfigSchema.test.ts
// (krelltunez/dayGLANCE@8d72008), which validates against electron-builder's own
// schema for the same reason (an artifactName inside a target entry killed a
// release build with an error pointing at the wrong key).

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');

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

  it('ships the renderer bundle and main, and no node_modules', () => {
    expect(config.files).toEqual(expect.arrayContaining(['dist/**/*', 'dist-electron/**/*', '!**/*.map', '!node_modules/**/*']));
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

  it('keeps the Android application id for direct builds', () => {
    expect(config.appId).toBe('com.lastglance.app');
  });
});
