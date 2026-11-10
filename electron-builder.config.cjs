// electron-builder config for the lastGLANCE desktop app (docs/desktop-app.md,
// section 11). After dayGLANCE's electron-builder.config.cjs
// (krelltunez/dayGLANCE@8d72008), whose comments explain the lessons kept here.
//
// Signing is driven by the environment. With no CSC_LINK, macOS builds are
// ad-hoc signed by the afterPack hook (an "unidentified developer" prompt
// instead of a hard "damaged" block); Developer ID signing, notarization and
// the Mac App Store build arrive in Phase 5 (section 12).

const { readdirSync } = require('node:fs');
const path = require('node:path');

// The shipped languages, read from where i18n loads them, so a new locale
// reaches the macOS bundle metadata with nothing else to remember.
const SHIPPED_LANGUAGES = readdirSync(path.join(__dirname, 'public', 'locales'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

// Apple's spelling where it differs from ours (CFBundleLocalizations only).
const APPLE_LANGUAGE_IDS = { 'zh-CN': 'zh-Hans' };

const hasCert = Boolean(process.env.CSC_LINK);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  // com.lastglance.app matches Android. The MAS build (Phase 5) switches to
  // com.lastglance, the iOS bundle id, for Universal Purchase.
  appId: 'com.lastglance.app',
  productName: 'lastGLANCE',
  copyright: 'Copyright © 2026 GLANCE Apps',
  afterPack: './scripts/codesign-ad-hoc.cjs',
  // No native runtime dependency ships (see files), so there is nothing for
  // @electron/rebuild to compile.
  npmRebuild: false,
  directories: {
    buildResources: 'electron/resources',
    output: 'dist-app',
  },
  // The renderer is one Vite bundle and main needs only electron and node
  // builtins, so no node_modules ship: every runtime dependency is already
  // inside dist/. Sourcemaps stay out of the package.
  // lastglance:// (docs/desktop-app.md, section 8): CFBundleURLTypes on macOS,
  // the registry on Windows (NSIS), and the .desktop MimeType on Linux, which
  // the deb registers on install and an AppImage only once integrated.
  protocols: [{ name: 'lastGLANCE', schemes: ['lastglance'] }],
  files: [
    'dist/**/*',
    'dist-electron/**/*',
    '!**/*.map',
    '!node_modules/**/*',
  ],
  // The tray icons (section 7), outside the asar so nativeImage reads them
  // from process.resourcesPath/tray.
  extraResources: [{ from: 'electron/resources/tray', to: 'tray' }],
  mac: {
    // null: ad-hoc (no certificate); undefined: electron-builder picks the
    // Developer ID identity when CSC_LINK is set.
    identity: hasCert ? undefined : null,
    hardenedRuntime: hasCert,
    category: 'public.app-category.productivity',
    icon: 'electron/resources/icon-mac.png',
    // Only the shipped languages' .lproj folders survive; Apple reads the
    // folders as the app's languages (dayGLANCE's listing once claimed 50+).
    electronLanguages: SHIPPED_LANGUAGES,
    extendInfo: {
      CFBundleLocalizations: SHIPPED_LANGUAGES.map((l) => APPLE_LANGUAGE_IDS[l] || l),
    },
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
  },
  win: {
    icon: 'electron/resources/icon.png',
    target: [{ target: 'nsis' }],
  },
  // The AppImage's own options: forces the arch into every AppImage name (x64
  // otherwise loses its suffix and gets downloaded onto ARM), without renaming
  // the deb, which keeps Debian's name_version_arch.deb.
  appImage: {
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
  linux: {
    // category is REQUIRED (no mapping exists for the mac category; the app
    // lands in "Other"), icon avoids the generic Electron icon, and the
    // description becomes the launcher tooltip.
    category: 'Office',
    description: 'When did you last...? A last-done tracker for the things that matter.',
    icon: 'electron/resources/icon.png',
    desktop: {
      entry: {
        Keywords: 'chores;tracker;household;habits;people;contacts;journal;',
      },
    },
    // Required by the deb target, which fails the build without it. Public
    // project contact: it ships inside every package.
    maintainer: 'GLANCE Apps <hello@glance-apps.com>',
    // The arch list is explicit: the default is only the build host's arch.
    // Cross-packaging arm64 on x64 is sound while no runtime dependency is
    // native (none ship; see files above).
    target: [
      { target: 'AppImage', arch: ['x64', 'arm64'] },
      { target: 'deb', arch: ['x64', 'arm64'] },
    ],
  },
};
