---
name: deploy
description: Deploy easy-ui to production (easy-ui.pay-offline.ru on Dokploy) — push to main triggers auto-deploy; check deploy status, trigger a manual deploy/redeploy, watch progress, and verify the live instance (health, basic auth, SPA).
---

# Deploy easy-ui to Dokploy

Production runs at **https://easy-ui.pay-offline.ru** — a Dokploy compose service built from GitHub `vladprrs/easy-ui@main` (`docker-compose.yml` at repo root, single container: Bun server serving API + `dist` static, named volume `easy-ui-data:/app/data` for SQLite + published component modules). Full deployment contract: `docs/server-api.md#deployment`; plan/history: `docs/plans/2026-07-11-dokploy-deploy.md`.

All paths below are relative to the repo root. The driver is `.claude/skills/deploy/driver.mjs` (plain node, zero deps).

## Prerequisites

Secrets in `.env` at repo root (gitignored; template in `.env.example`):

```
DOKPLOY_API_KEY=...          # Dokploy UI -> Settings -> API/CLI
EASY_UI_BASIC_AUTH=user:pass # prod basic-auth creds, optional (verify degrades without it)
```

Without `DOKPLOY_API_KEY` the driver exits with code 2.

## Deploy (normal path)

Auto-deploy is on: **any push to `main` triggers a production build+deploy** via a GitHub webhook (hook id 651559498 → Dokploy `/api/deploy/compose/<refreshToken>`). So the deploy itself is:

```bash
git push origin main
node .claude/skills/deploy/driver.mjs watch    # poll until done/error (~2-3 min server-side build)
node .claude/skills/deploy/driver.mjs verify   # health/auth/SPA checks against prod
```

`verify` output — all four must PASS:

```
PASS  health open, ready (200 ready)
PASS  API requires auth (401, www-authenticate=Basic realm="easy-ui")
PASS  API with creds (200)
PASS  SPA with creds (200)
```

## Manual deploy / redeploy (no new commit)

```bash
node .claude/skills/deploy/driver.mjs deploy "reason for redeploy"
```

Triggers `compose.deploy` and watches until terminal state. Exit 1 on failed deployment (error message printed; full build logs only in Dokploy UI → project easy-ui → deployments).

## Status

```bash
node .claude/skills/deploy/driver.mjs status   # composeStatus + last 3 deployments
```

## Rollback

No first-class rollback. Revert the offending commit and push (webhook redeploys), or `git push origin <good-sha>:main`. DB migrations are forward-only — if a schema change is involved, restoring the `easy-ui-data` volume from a backup is the only way back (mind SQLite WAL: `easy-ui.db` + `-wal` + `-shm` are one unit).

## Gotchas

- **Deploy happens on every push to main** — pushing an unfinished commit deploys it. There is no staging environment.
- Dokploy builds the image **on the prod server** (`npm ci` + vite + storybook build, ~2-3 min, `mem_limit: 1g`). A failing build leaves the previous container running.
- `compose.deploy` only **queues**; `watch` polls `compose.one` every 15 s. Deployment status `running` with no progress for >10 min = check Dokploy UI logs.
- The app itself enforces basic auth (`BASIC_AUTH` env in the Dokploy service, not Traefik). Changing the password = edit the compose service env in Dokploy (UI or `compose.update` API) + redeploy, then update `.env` here.
- `curl` against SPA routes without `Accept: text/html` returns 404 — the static server's SPA fallback is HTML-only. Browsers are unaffected; the driver sends the header.
- `/api/health` is the only unauthenticated endpoint (used by the container healthcheck). Everything else, including static assets, is behind basic auth.
- Publishing custom components in prod exercises `tsc` + `Bun.build` inside the container — that's why the image keeps full devDependencies; don't "optimize" `npm ci --omit=dev`.

## Troubleshooting

- `DOKPLOY_API_KEY is not set` → create `.env` from `.env.example` (the key is in the Dokploy service owner's settings).
- `deployment failed: ...` from watch → build error on the server; read logs in Dokploy UI (API doesn't expose logPath contents).
- `verify` FAIL on "health open, ready" right after deploy → server seeds on startup (healthcheck `start_period` 90 s); wait ~30 s and re-run.
