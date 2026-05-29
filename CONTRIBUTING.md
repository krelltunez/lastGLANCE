# Contributing to lastGLANCE

Thanks for your interest in contributing! Whether you're fixing a typo, squashing a bug, or building a new feature, you're welcome here. This guide will get you up and running.

---

## Table of Contents

- [Running the app locally](#running-the-app-locally)
- [Running tests](#running-tests)
- [Project structure](#project-structure)
- [Making a pull request](#making-a-pull-request)
- [Reporting security issues](#reporting-security-issues)
- [Reporting bugs](#reporting-bugs)

---

## Running the app locally

**Prerequisites:** Node.js 18+ and npm.

```bash
git clone https://github.com/krelltunez/lastGLANCE.git
cd lastGLANCE
npm install
npm run dev
```

The app will be available at `http://localhost:5173`. It hot-reloads on save.

Other useful commands:

| Command | What it does |
|---|---|
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run lint` | ESLint |

---

## Running tests

lastGLANCE does not have a test suite yet. Before submitting a PR, please run the linter to catch obvious issues:

```bash
npm run lint
```

If you're adding non-trivial logic (cadence calculations, sync/merge behaviour, encryption helpers), consider whether a test would make the logic easier to trust and maintain. The project uses Vite and TypeScript, so [Vitest](https://vitest.dev/) would be a natural fit if a test suite is added in the future.

---

## Project structure

```
lastGLANCE/
├── src/
│   ├── App.tsx                # Top-level component, wires state, hooks, and layout
│   ├── main.tsx               # Entry point
│   ├── index.css              # Global styles
│   ├── components/            # React UI components (one folder per modal or widget)
│   │   ├── ActivityLogModal/
│   │   ├── BackupModal/
│   │   ├── CategoryFormModal/
│   │   ├── CategorySection/
│   │   ├── ChoreFormModal/
│   │   ├── ChoreRow/
│   │   ├── DateTimePicker/
│   │   ├── HelpModal/
│   │   ├── IconPicker/
│   │   ├── IntegrationSettingsModal/
│   │   ├── LogModal/
│   │   ├── PassphraseModal/
│   │   ├── Ribbon/
│   │   ├── SearchModal/
│   │   ├── ShortcutsModal/
│   │   ├── SyncSettingsModal/
│   │   ├── Toast/
│   │   └── WelcomeModal/
│   ├── db/                    # Dexie schema, client initialisation, and query helpers
│   │   ├── client.ts
│   │   ├── queries.ts
│   │   └── schema.ts
│   ├── hooks/                 # Custom React hooks (one concern per hook)
│   ├── icons/                 # Lucide icon registry
│   ├── intents/               # @glance-apps/intents: polling, emission, encryption setup
│   ├── sync/                  # @glance-apps/sync engine types and adapter config
│   ├── types/                 # Shared TypeScript type definitions
│   └── utils/                 # Pure utility functions (cadence math, etc.)
├── api/
│   └── webdav-proxy.js        # Lightweight WebDAV CORS proxy (Node/serverless)
├── design/                    # Icon generation scripts and HTML snippets
├── public/                    # Static assets (icons, manifest, PWA screenshots)
├── Dockerfile
├── docker-compose.yml
├── nginx.conf                 # Production nginx config (used in the Docker image)
├── vite.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

If you're looking for a specific feature, searching for a UI string or function name is faster than browsing linearly. The hooks in `src/hooks/` are named by concern (e.g. `useChores`, `useDB`, `useIntentsPoller`) and are a good starting point when tracing a feature end-to-end.

---

## Making a pull request

1. **Fork the repo** and create a branch from `main`:
   ```bash
   git checkout -b my-fix-or-feature
   ```

2. **Keep changes focused.** One logical change per PR makes review much easier. If you find an unrelated bug while working, open a separate issue or PR for it.

3. **Check your work**: run `npm run lint` and make sure the app builds without type errors (`npm run build`). If your change touches sync or intents behaviour, verify it manually against a WebDAV server if you can.

4. **Write a clear PR description.** Explain *what* changed and *why*, not just what the code does. If it fixes a bug, link the issue.

5. **Don't sweat perfection.** If you're unsure about something, open the PR as a draft and ask. We'd rather see a rough PR than no PR.

### Guidelines

- Follow the existing code style. The project uses React with TypeScript and Tailwind for styling.
- Avoid `any` and type assertions unless you have a genuine reason. Prefer narrowing types over silencing the compiler.
- Changes to `src/db/schema.ts` affect the local Dexie database. Treat schema migrations carefully and test that existing data survives an upgrade.
- Changes to `src/sync/` or `src/intents/` affect interoperability with the `@glance-apps/sync` and `@glance-apps/intents` packages. Check the [intents protocol spec](docs/dayglance-intent-protocol.md) before changing intent shape, as dayGLANCE consumes these intents.
- Avoid adding dependencies unless necessary.
- No em dashes in user-facing copy (UI strings, docs, READMEs). Commit messages and PR descriptions are fine.

---

## Reporting security issues

Please do **not** file public issues for security vulnerabilities. Use GitHub's [private vulnerability reporting](https://github.com/krelltunez/lastGLANCE/security/advisories/new) instead, which sends the report directly to maintainers without exposing it publicly. This applies to anything that could compromise user data: sync credential leaks, encryption flaws, XSS, etc.

For non-sensitive bugs, use the public issue tracker as described below.

---

## Reporting bugs

Please [open an issue](https://github.com/krelltunez/lastGLANCE/issues) and include:

- **What you expected** to happen
- **What actually happened** (error message, screenshot, or screen recording if relevant)
- **Steps to reproduce**: the more specific, the better
- **Environment:** browser and OS version

If you're not sure whether something is a bug or by design, open an issue anyway and we'll figure it out together.
