---
name: verify
description: Verify easy-ui changes end-to-end by driving the running app (gallery → player flows → library) with Playwright and screenshots.
---

# Verify easy-ui

## Build & launch

- `npm ci` (Node ≥24; committed package-lock).
- App dev server: `npm run dev` → **:5173**. Storybook: `npm run storybook` → **:6006**.
  ⚠ This code-server workspace **ignores port flags** (`-p`, `--port`) — always detect the real port from the server log, never assume a flag worked.
- Production check: `npm run build` then `npx vite preview` → :4173 (script `preview` also exists). SPA fallback must serve `/p/<id>/s/<screen>` deep links; `/storybook/index.json` is same-origin static.
- Reverse proxy hosts (`*.coder`) are allowlisted via `server.allowedHosts`/`preview.allowedHosts` in vite.config.ts — if a new host is blocked, extend that list.

## Drive (surface = browser GUI)

Playwright chromium is installed. For an ad-hoc driver script outside the repo, import from the project tree:
`import { chromium } from '/home/coder/project/node_modules/playwright/index.mjs'`.

Flows worth driving (labels are Russian — take them from `prototypes/*.json` props, don't guess):
1. `/` gallery → card «Мобильное оформление заказа» → `/p/checkout/s/catalog`.
2. Hotspot «Открыть карточку кроссовок» → product; «В корзину» → cart badge increments ($state); «Оформить» → form; fill input, browser Back/Forward → value must persist ($bindState); «Оплатить» → success; «Начать заново» (restart) → catalog with clean state; then several browser Backs → must **stay** on the current-session start screen (stale-history gate).
3. `/p/settings` → Tabs, Switch toggles «Тёмная тема включена» visibility, Dialog, «Назад».
4. `/library` → story tree from Storybook index.json, iframe preview, "Open in Storybook" link. With Storybook down it must degrade to instructions, not crash.
5. Probes: `/p/nonexistent` and `/p/checkout/s/nonexistent` → friendly 404 page.

## Gotchas

- Never `pkill -f` with a pattern that appears literally in your own command line (it kills your own shell). Kill by PID or use harness background tasks + TaskStop.
- Backticks in long shell strings execute (command substitution) — pass long prompts/scripts via files.
- `npm test` / typecheck are CI's job — verification here means driving the running app and capturing screenshots.
