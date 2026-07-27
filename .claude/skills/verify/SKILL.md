---
name: verify
description: Verify easy-ui custom-only flows end-to-end with Playwright and screenshots.
---

# Verify easy-ui

## Build and launch

- `npm ci` (Node ≥24; committed package-lock).
- `npm run server:dev` → API :8787, then `npm run dev` → app :5173.
- Production: `npm run build`, then `npm run serve` → API + SPA :4173.
- This workspace may ignore port flags; use the server log as the source of truth.

## Drive

Use API-created custom components or `test/fixtures/starter/`; do not assume any built-in catalog. Verify:

1. Gallery → custom prototype → player navigation/state/restart.
2. Player, Present, CJM, Editor and Capture render pinned custom bundles plus host `Image`/`Hotspot`/`Overlay`/`@eui/FlowRoot`.
3. An unrenderable authorized revision shows «Прототип в архиве» before component bundles load; revoked share URLs remain 404/410.
4. Gallery archive cards show the archive badge without mounting a preview.
5. `/library` lists only API-backed custom components and their capture previews.
6. `/p/nonexistent` and missing screens show friendly not-found states.

## Server-side screenshots

`node .claude/skills/author/driver.mjs snap <protoId> ./shots [--all-screens] [--json]` снимает PNG через job-API (playwright локально не нужен). Exit codes — часть контракта: `0` — PNG на всех экранах без product-ошибок, `2` — PNG есть, но прототип логировал ошибки (`productErrors`), `1` — PNG не создан (инфраструктура; драйвер уже сделал 2 попытки). Инфраструктурный шум (favicon, расширения браузера, `ERR_NETWORK_CHANGED`, `ResizeObserver loop`, посторонние origin'ы) уходит в `infraNoise` и exit code не меняет. `geometry <protoId> <screenId>` дополнительно печатает роли/`safeArea`/`viewportOwnership` и `issues[]` (clipping, overlap, footer ownership) — это предупреждения, не провал.

## Static release gate

Run `npm run verify`. It includes strict template validation, the SPA build, and the ordered CSS compatibility gate; `dist/storybook` must not exist.
