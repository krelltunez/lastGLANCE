// Bundles the plugin, its dependencies, the shared protocol
// (../electron/deckProtocol.ts) and the generated icon table into one file
// Stream Deck runs with its own Node.
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/plugin.ts',
  output: {
    file: 'com.lastglance.streamdeck.sdPlugin/bin/plugin.js',
    format: 'cjs',
    sourcemap: true,
  },
  plugins: [
    resolve({ browser: false, preferBuiltins: true }),
    commonjs(),
    json({ compact: true }),
    // rootDir spans src/ and ../electron/ for the shared protocol.
    typescript({ tsconfig: './tsconfig.json', rootDir: '..', outDir: 'com.lastglance.streamdeck.sdPlugin/bin', noEmitOnError: true }),
  ],
  onwarn(warning, warn) {
    // ws's optional native accelerators are not installed, by design.
    if (warning.code === 'UNRESOLVED_IMPORT' && /bufferutil|utf-8-validate/.test(warning.message)) return;
    warn(warning);
  },
};
