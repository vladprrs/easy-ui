# easy-ui

easy-ui is a viewer for clickable, JSON-defined UI prototypes. It renders flows with
[`json-render`](https://github.com/vercel-labs/json-render), provides a gallery and
stateful player, and embeds the component catalog from Storybook in the Library page.

## Quick start

Requires Node.js 24 or newer. Server commands also require Bun 1.3.14 installed at
`~/.bun/bin`; ensure it precedes other Bun installations in `PATH`:

```sh
export PATH="$HOME/.bun/bin:$PATH"
```

```sh
npm ci
npm run dev
```

In a second terminal, start Storybook so `/library` can load the live catalog:

```sh
npm run storybook
```

Open `http://localhost:5173`.

## Add a prototype

Add a JSON document to `prototypes/`, with its `id` matching the filename, then run
`npm run validate:prototypes`. The complete schema, navigation rules, state bindings,
and author checklist are in [docs/prototype-format.md](docs/prototype-format.md).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development app |
| `npm run storybook` | Start the live component catalog |
| `npm run server:dev` | Start the Bun API server on 127.0.0.1:8787 |
| `npm run server:test` | Run Bun server tests |
| `npm run server:typecheck` | Type-check the server without Vite globals |
| `npm run serve` | Serve `dist/` and the API with Bun on 127.0.0.1:4173 |
| `npm test` | Run unit and component tests |
| `npm run validate:prototypes` | Validate every prototype JSON file |
| `npm run build` | Build the app and static Storybook into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run verify` | Run all static checks, tests, validation, builds, CSS and Storybook drift checks |
| `npm run e2e` | Run Chromium E2E tests against development and preview servers |

Install the browser once before the first E2E run with
`npx playwright install chromium`. Run `npm run verify` before `npm run e2e`, because
the preview project tests the generated `dist/` output.

## Repository structure

- `prototypes/` — prototype documents.
- `src/player/` — session-aware prototype player and navigation.
- `src/catalog/` — json-render catalog, fixtures, and Storybook stories.
- `src/gallery/` and `src/library/` — prototype gallery and embedded Storybook browser.
- `scripts/` — prototype, CSS, and Storybook drift validation.
- `e2e/` — Playwright development and production-preview scenarios.
- `docs/` — prototype format and implementation plan.
