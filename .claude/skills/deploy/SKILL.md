---
name: deploy
description: Deploy easy-ui to production (easy-ui.pay-offline.ru on Dokploy) — push to main builds the image in GitHub Actions (GHCR) and auto-deploys; check deploy status, trigger a manual redeploy, watch progress, and verify health, session auth, and SPA.
---

# Deploy easy-ui to Dokploy

Production runs at **https://easy-ui.pay-offline.ru** — a Dokploy compose service running the prebuilt image `ghcr.io/vladprrs/easy-ui:latest` (`docker-compose.yml` at repo root, single container: Bun server serving API + `dist` static, named volume `easy-ui-data:/app/data` for SQLite + published component modules). Application auth uses named cookie sessions bootstrapped by `ADMIN_NAME`/`ADMIN_PASSWORD`. The outer Basic barrier (`LEGACY_BASIC_AUTH`, deprecated alias `BASIC_AUTH`) was removed from the prod env on 2026-07-20 — the server code still honors those vars, so setting them in Dokploy re-enables the barrier if ever needed. The image is built by GitHub Actions (`.github/workflows/build-image.yml`) — **never on the prod server**: server-side builds (npm ci + chromium + vite + storybook) starved the 1-CPU host and took the whole box down three times on 2026-07-14. Full deployment contract: `docs/server-api.md#deployment`; plan/history: `docs/plans/2026-07-11-dokploy-deploy.md`.

All paths below are relative to the repo root. The driver is `.claude/skills/deploy/driver.mjs` (plain node, zero deps).

## Prerequisites

Secrets in `.env` at repo root (gitignored; template in `.env.example`):

```
DOKPLOY_API_KEY=...          # Dokploy UI -> Settings -> API/CLI
EASYUI_USERNAME=admin        # named account for post-deploy API/SPA verification
EASYUI_PASSWORD=...          # named-account password
```

Without `DOKPLOY_API_KEY` the driver exits with code 2.

## Deploy (normal path)

Auto-deploy is on: **any push to `main`** runs the `build-image` workflow (build image in Actions → push `ghcr.io/vladprrs/easy-ui:{latest,<sha>}` → call `compose.deploy` via the Dokploy API (`DOKPLOY_API_KEY` Actions secret; the refreshToken deploy-URL rejects non-GitHub payloads with "Branch Not Match")). Dokploy then only does `docker compose pull` + `up` (`pull_policy: always`), ~1-2 min, no load on the host. The old direct GitHub→Dokploy webhook (hook id 651559498) is **disabled** — do not re-enable it: it makes Dokploy build from source on the server. So the deploy itself is:

```bash
git push origin main
gh run watch --repo vladprrs/easy-ui $(gh run list --repo vladprrs/easy-ui --workflow build-image --limit 1 --json databaseId --jq '.[0].databaseId')   # ~3-6 min CI build
node .claude/skills/deploy/driver.mjs watch    # poll Dokploy until done/error (~1-2 min pull+up)
node .claude/skills/deploy/driver.mjs verify   # health/auth/SPA checks against prod
```

The legacy deploy driver still checks infrastructure state; use the author driver for the session-auth read-back after it reports healthy:

```bash
EASYUI_API=https://easy-ui.pay-offline.ru/api node .claude/skills/author/driver.mjs get prototypes
```

Expected auth gates:

```
PASS  health open, ready (200 ready)
PASS  API requires auth (401, www-authenticate=null)
PASS  SPA open (200)
PASS  login sets session cookie (200)
PASS  API with session cookie (200)
```

## Manual deploy / redeploy (no new commit)

```bash
node .claude/skills/deploy/driver.mjs deploy "reason for redeploy"
```

Triggers `compose.deploy` (pull `ghcr.io/vladprrs/easy-ui:latest` + up) and watches until terminal state. Exit 1 on failed deployment (error message printed; full logs only in Dokploy UI → project easy-ui → deployments). This redeploys whatever `latest` currently points to — to ship new code, push to `main` and let the workflow build the image first. To rebuild the image without a code change: `gh workflow run build-image --repo vladprrs/easy-ui` (workflow_dispatch does not auto-trigger the Dokploy deploy — run `deploy` after it finishes).

## Status

```bash
node .claude/skills/deploy/driver.mjs status   # composeStatus + last 3 deployments
```

## Rollback

No first-class rollback. Point the compose file at a known-good image tag (`ghcr.io/vladprrs/easy-ui:<sha>` — every main commit is tagged) and redeploy, or revert the offending commit and push (workflow rebuilds and redeploys). DB migrations are forward-only — if a schema change is involved, restoring the `easy-ui-data` volume from a backup is the only way back (mind SQLite WAL: `easy-ui.db` + `-wal` + `-shm` are one unit).

## Gotchas

- **Deploy happens on every push to main** — pushing an unfinished commit deploys it (after the CI build). There is no staging environment.
- **Never build on the prod server.** The image comes prebuilt from GHCR (public package, anonymous pull). If Dokploy ever reports a source build, the disabled webhook was re-enabled or `docker-compose.yml` regained a `build:` section — fix that first.
- Keep `ADMIN_NAME`/`ADMIN_PASSWORD` paired. `LEGACY_BASIC_AUTH`/`BASIC_AUTH` are no longer set in prod; the code still accepts them (new name wins when both are set) if the barrier ever needs to come back.
- A failing CI build or failed pull leaves the previous container running — prod stays up.
- `compose.deploy` only **queues**; `watch` polls `compose.one` every 15 s. Deployment status `running` with no progress for >10 min = check Dokploy UI logs.
- The API returns `deployments` unsorted and `composeStatus` can hold a stale `error` — the driver sorts by `createdAt` and trusts only the newest deployment's status.
- The app enforces named cookie sessions; auth lives in the app (not Traefik).
- `curl` against SPA routes without `Accept: text/html` returns 404 — the static server's SPA fallback is HTML-only. Browsers are unaffected; the driver sends the header.
- `/api/health`, share exchange/share-scope and capture-scope are open without a session; everything else on `/api` requires one.
- Publishing custom components in prod exercises `tsc` + `Bun.build` inside the container — that's why the image keeps full devDependencies; don't "optimize" `npm ci --omit=dev`.

## Troubleshooting

- `DOKPLOY_API_KEY is not set` → create `.env` from `.env.example` (the key is in the Dokploy service owner's settings).
- `deployment failed: ...` from watch → pull/up error on the server; read logs in Dokploy UI (API doesn't expose logPath contents). Check `docker manifest inspect ghcr.io/vladprrs/easy-ui:latest` — if the manifest is missing or the package went private, the pull fails.
- `verify` FAIL on "health open, ready" right after deploy → server seeds on startup (healthcheck `start_period` 90 s); wait ~30 s and re-run.
