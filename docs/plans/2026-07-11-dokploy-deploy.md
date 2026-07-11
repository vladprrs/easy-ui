# Деплой easy-ui на Dokploy (dokploy.pay-offline.ru)

## Context

easy-ui (Vite SPA + Bun API-сервер, SQLite) сейчас живёт только в dev-окружении. Нужен продовый деплой на существующий Dokploy-сервер через его API. Разведка показала:

- **Dokploy**: API-ключ рабочий; все существующие сервисы (auth-service, gitea, komodo…) — compose-сервисы, домены `*.pay-offline.ru` через Traefik + Let's Encrypt. Wildcard DNS уже указывает на сервер (158.160.169.159) — `easy-ui.pay-offline.ru` резолвится, DNS-работ нет.
- **Решения пользователя**: источник — публичный GitHub `vladprrs/easy-ui` (custom git, не Gitea); домен `easy-ui.pay-offline.ru`; защита — basicAuth на весь домен.
- **Деплой-поверхность репо** (в репо нет Dockerfile/compose/CI-деплоя):
  - Прод-запуск: `bun server/main.ts` с `SERVE_DIST=dist` — один процесс отдаёт API (`/api/*`) и статику (SPA + `dist/storybook`). Healthcheck: `GET /api/health` (200 ready / 503 starting).
  - Сборка: `npm run build` = `vite build && storybook build -o dist/storybook`. Node ≥24.
  - Рантайм: Bun 1.3.14 (`.bun-version`) **и** Node 24 (publish typecheck спавнит `node_modules/.bin/tsc` — devDependencies обязаны быть в проде; ставить только `npm ci`).
  - `DATA_DIR` (SQLite WAL + `modules/*.tsx`) обязан лежать внутри корня проекта (bare-импорты материализованных TSX резолвятся через корневой `node_modules`) → volume монтировать в `/app/data`, `DATA_DIR=data`.
  - **Блокер**: `server/main.ts:32` хардкодит `hostname: "127.0.0.1"` — в контейнере недостижим. Нужен env-переопределитель.
  - API без аутентификации, publish исполняет присланный TSX на сервере (= RCE для любого с доступом к URL) → защита обязательна.

## Изменения в репозитории (коммит в main → Dokploy тянет с GitHub)

1. **`server/main.ts`** — два минимальных изменения:
   - `hostname: process.env.HOST || "127.0.0.1"` (локальное поведение не меняется; в контейнере `HOST=0.0.0.0`).
   - basicAuth-гейт в начале fetch-хендлера: если задан env `BASIC_AUTH` (`user:pass`), сравнивать с заголовком `Authorization: Basic …` (timing-safe сравнение), иначе `401 + WWW-Authenticate: Basic`. `/api/health` оставить открытым для healthcheck. Без env — поведение как сейчас (dev не затронут).
   - *Почему в приложении, а не Traefik-labels*: пользователь выбрал «basicAuth на весь домен»; домены у Dokploy-compose управляются самим Dokploy (router-имена генерируются), навешивание своего middleware на чужой router хрупко. App-level гейт даёт тот же результат (пароль на всё) надёжно; Traefik-вариант — отклонён на этапе планирования, зафиксировать в триаже ревью.
2. **`Dockerfile`** (одностейджевый — devDeps нужны в рантайме):
   - `FROM node:24-slim` + `COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun`
   - `WORKDIR /app` → `COPY package*.json` → `npm ci` → `COPY .` → `npm run build`
   - `ENV SERVE_DIST=dist DATA_DIR=data HOST=0.0.0.0 PORT=8787 NODE_ENV=production`, `EXPOSE 8787`, `CMD ["bun", "server/main.ts"]`
   - Healthcheck не в Dockerfile, а в compose (curl может отсутствовать — использовать `bun -e "fetch(...)"`).
3. **`.dockerignore`**: `node_modules`, `dist`, `data`, `.e2e-data`, `.git`, `.claude*`, `.codex-home`, `docs`, `playwright-report`, `test-results`.
4. **`docker-compose.yml`** (его читает Dokploy, `composePath: ./docker-compose.yml`):
   ```yaml
   services:
     easy-ui:
       build: .
       restart: unless-stopped
       environment:
         - BASIC_AUTH=${BASIC_AUTH}
       volumes:
         - easy-ui-data:/app/data
       expose: ["8787"]
       healthcheck: # bun fetch /api/health
   volumes:
     easy-ui-data:
   ```
   Значение `BASIC_AUTH` — только в env сервиса в Dokploy (не в git).
5. **`CLAUDE.md` / `docs/server-api.md`** — короткая секция Deployment (домен, env, volume, как задеплоить заново).

## Настройка Dokploy через API

Все вызовы — `curl -H "x-api-key: …" https://dokploy.pay-offline.ru/api/<router>.<proc>` (мутации — POST с JSON):

1. `project.create` → `{name: "easy-ui", description: …}`; из ответа взять default environment `environmentId`.
2. `compose.create` → `{name: "easy-ui", environmentId, composeType: "docker-compose"}`.
3. `compose.update` → `{composeId, sourceType: "git", customGitUrl: "https://github.com/vladprrs/easy-ui.git", customGitBranch: "main", composePath: "./docker-compose.yml", triggerType: "push", env: "BASIC_AUTH=vlad:<сгенерированный пароль>"}`.
   (точные имена полей сверить по OpenAPI: `GET /api/settings.getOpenApiDocument` или swagger на `/swagger`; у auth-service поля видны в `compose.one` — `customGitUrl/customGitBranch` для custom-провайдера.)
4. `domain.create` → `{host: "easy-ui.pay-offline.ru", https: true, port: 8787, certificateType: "letsencrypt", domainType: "compose", serviceName: "easy-ui", composeId}` (образец — домен auth-service).
5. `compose.deploy` → `{composeId}`; следить за статусом через `compose.one` → `deployments[].status`, логи по `logPath` недоступны напрямую — при ошибке смотреть `deployment.all`/`compose.one`.
6. **autoDeploy по push** (опционально, финальный штрих): у compose есть `refreshToken` — добавить GitHub webhook `https://dokploy.pay-offline.ru/api/deploy/compose/<refreshToken>` (payload URL из UI; сверить точный путь по OpenAPI). Если возиться с webhook не хочется — редеплой вызовом `compose.deploy` после push.

## Процесс (workflow CLAUDE.md)

1. Скопировать этот план в `docs/plans/2026-07-11-dokploy-deploy.md`, закоммитить.
2. Codex adversarial review плана (companion CLI, read-only, config-level max effort), триаж находок в файле плана; при существенных правках — повторный раунд `--resume`.
3. Исполнение: задача одна и связная (Dockerfile+compose+патч сервера — одна зона владения) — один `--fresh --write --effort medium` Codex-диспатч на изменения в репо; API-вызовы к Dokploy оркестратор делает сам (секреты и внешние мутации не отдавать исполнителю).
4. Коммит и push в GitHub main — после независимой верификации.

## Верификация

1. Локально: `docker build` + запуск контейнера, `curl -u vlad:… http://127.0.0.1:8787/api/health` и корень SPA; без креденшалов — 401; `/api/health` без пароля — 200. `npm run verify` — dev-поведение не сломано (HOST/BASIC_AUTH не заданы).
   - Если docker в этом контейнере недоступен — верифицировать патч сервера локально (`BASIC_AUTH=a:b HOST=0.0.0.0 bun server/main.ts`), а сборку образа проверит сам Dokploy при деплое.
2. Прод после `compose.deploy`: дождаться `composeStatus: done`; `curl -u … https://easy-ui.pay-offline.ru/api/health` → `{"status":"ready"}`; открыть галерею, прогнать флоу прототипа, publish кастомного компонента через API с паролем; повторный `compose.deploy` → данные в volume пережили редеплой.
3. Негатив: запрос без пароля → 401; TLS-серт Let's Encrypt валиден.

## Триаж ревью (Codex gpt-5.6-sol, 2026-07-11)

**Принято (вошло в план):**
- [blocker] Fail-closed auth: в compose `BASIC_AUTH: ${BASIC_AUTH:?BASIC_AUTH is required}` (деплой падает без секрета) + сервер отказывается стартовать, если `HOST` не loopback и `BASIC_AUTH` пуст.
- [blocker] Явный гейт: изменения закоммичены и запушены в GitHub `main` **до** `compose.deploy` (Dokploy тянет из remote).
- [major] Auth-гейт стоит до всех веток (API, статика, SPA fallback), 401 — прямой `Response` (не ApiError) с `WWW-Authenticate`, `Cache-Control: no-store`. Открыт только `GET /api/health`.
- [major] При включённом auth: `Vary: Authorization` на все ответы, `public` в cache-control заменяется на `private`.
- [major] Timing-safe сравнение: SHA-256 обоих значений → сравнение 32-байтовых digest; malformed base64 → 401; scheme case-insensitive.
- [major] Bun-бинарник: exact-теги образов + `RUN bun --version` в билде (smoke на glibc/AVX2).
- [major] `${BASIC_AUTH}` инжектится в контейнер только через явный `environment:` с required-оператором (Dokploy кладёт env в `.env` рядом с compose).
- [major] Healthcheck exec-form `["CMD","bun","-e",...]` с проверкой 200 и `status:"ready"`, `start_period`/`timeout`/`retries`.
- [major] Идемпотентность API-вызовов: перед create — поиск существующих project/compose/domain; IDs из вложенных полей ответа; domain создаётся до deploy; после deploy — poll статуса.
- [major] `.dockerignore` расширен (`.github`, `.env*`, coverage/playwright-outputs, SQLite sidecars); слои: сначала package*.json + `npm ci`, потом исходники.
- [major, частично] Лёгкий hardening: `init: true`, `mem_limit`, `stop_grace_period`, `restart: unless-stopped`. Non-root/cap_drop/read-only rootfs — отклонено (ниже).
- [minor] `HOST` через `startServer({host})` options, auth-конфиг передаётся в `createHandler`.
- [minor] Обновить `docs/server-api.md` (trust boundary, env, health-исключение) — код исполняется уже при save (extract), не только publish.
- [minor] Интеграционные bun-тесты auth-гейта: disabled/missing/wrong/correct, health bypass, статика/SPA под auth, заголовки 401.

**Принято как документированный риск (без реализации сейчас):**
- Server-side build (vite+storybook) может быть тяжёлым для VPS — если OOM/таймаут, план Б: CI-сборка образа + registry. Фиксируем после первого деплоя.
- SQLite WAL backup: named volume + Dokploy Volume Backups позже; в docs — предупреждение про `-wal/-shm` и `down -v`.
- Rollback = revert/checkout предыдущего SHA + `compose.deploy`; миграции forward-only — перед рискованными изменениями бэкапить volume.

**Отклонено:**
- Traefik/forward-auth вместо app-level — решение зафиксировано на планировании: Dokploy-managed router, свой middleware хрупок; app-level гейт fail-closed покрывает требование.
- Multi-stage + перенос typescript в dependencies — devDeps нужны в рантайме (publish typecheck); полный `npm ci` в одном стейдже проще и корректнее; размер образа — осознанная цена.
- Non-root/cap_drop/pids_limit — сервис намеренно исполняет доверенный код за паролем, единственный пользователь; изоляция — контейнер. Пересмотрим при мульти-пользовательском сценарии.
- Пиновка base-образов по digest — exact-теги достаточны для этого проекта.
