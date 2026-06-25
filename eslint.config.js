import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

// Flat config for this Vite + React + TypeScript app. Matches the rule set the
// codebase was already written against (the `eslint-disable react-hooks/*`
// comments in src/ predate this file). Lints sources only; build output, native
// shells, and generated assets are ignored.
export default tseslint.config(
  {
    ignores: ['dist', 'dev-dist', 'android', 'ios', 'public', 'coverage'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Gradual adoption: a handful of pre-existing `any`s live in the sync
      // engine's Dexie accumulator arrays. Surface them as a warning backlog
      // rather than blocking the lint on typing changes to core sync code.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Node-context config/build files aren't browser code.
    files: ['*.{js,ts}', 'scripts/**/*.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
  },
)
