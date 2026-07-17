# easy-ui

easy-ui is a multi-user viewer and editor for clickable JSON-defined UI prototypes. It uses [`json-render`](https://github.com/vercel-labs/json-render), host-rendered `Image`/`Hotspot`/`Overlay`/`@eui/FlowRoot`, and API-published custom React components. The Library is custom-only; Storybook and built-in component catalogs have been removed.

## Quick start

Requires Node.js 24+ and Bun 1.3.14 at `~/.bun/bin/bun` for server commands.

```sh
npm ci
npm run server:dev
# in another terminal
npm run dev
```

Open `http://localhost:5173`. Create design systems and components through the API; the declarative `e2e-starter` example lives in `test/fixtures/starter/`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite app |
| `npm run server:dev` | Start the Bun API on 127.0.0.1:8787 |
| `npm run typecheck` / `npm run server:typecheck` | Type-check browser/server code |
| `npm test` / `npm run server:test` | Run browser/server tests |
| `npm run validate:templates` | Strictly validate gallery and starter templates against exact definitions |
| `npm run build` | Build the SPA into `dist/` |
| `npm run verify` | Run the full non-E2E release gate, including CSS compatibility |
| `npm run e2e` | Run Playwright scenarios (maintained separately) |

See [docs/prototype-format.md](docs/prototype-format.md) for the document grammar and [docs/server-api.md](docs/server-api.md) for the API.

## Repository structure

- `src/catalog/` — host content/extraction types, actions, and runtime composition.
- `src/gallery/`, `src/library/` — prototype gallery and custom component library.
- `src/player/`, `src/editor/`, `src/capture/` — authorized render surfaces.
- `test/fixtures/` — test data and declarative starter DS/components.
- `scripts/` — template, CSS, OpenAPI, and operational checks.
