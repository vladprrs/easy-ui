# CLAUDE.md

## Проект: easy-ui

Мультиюзерный просмотрщик и редактор кликабельных прототипов поверх json-render. Каталог custom-only: компоненты публикуются через API, а `Image`/`Hotspot`/`Overlay`/`@eui/FlowRoot` поставляет host runtime. Storybook и встроенные дизайн-системы удалены.

- План MVP и контракты: `docs/plans/2026-07-10-prototype-viewer-mvp.md` (v3), формат прототипов: `docs/prototype-format.md` (строгий allowlist v1), Bun API: `docs/server-api.md` (в т.ч. discovery: `GET /api/openapi.json`, `GET /api/capabilities`, JSON-схемы документа/компонента).
- Ключевые зоны: `src/catalog/` (host definitions/actions/runtime), `src/designSystems/` (theme/spacing compatibility), `src/prototype/` (schema/validate/loader), `src/player/`, `src/editor/`, `src/capture/`, `src/visual/`, `src/gallery|library/`, `server/assets|screenshot|visual/`, `test/fixtures/`.
- Команды: `npm run dev` (:5173, proxy `/api` → 127.0.0.1:8787) · `npm run server:dev` (:8787) · `npm run serve` (:4173) · `npm run verify` · `npm run e2e` · `npm run validate:templates` · `npm run build` (только SPA).
- Production-деплой в Dokploy описан в `docs/server-api.md#deployment`; точка входа — корневой `docker-compose.yml`. Bootstrap-admin задаётся секретами `ADMIN_NAME`/`ADMIN_PASSWORD`; внешний Basic-барьер (`LEGACY_BASIC_AUTH`, alias `BASIC_AUTH`) снят с прода 2026-07-20, но код его поддерживает — задать переменную в Dokploy, если понадобится вернуть. Рецепт деплоя/верификации прода — скилл `/deploy` (`.claude/skills/deploy/SKILL.md`); push в `main` собирает образ в GitHub Actions (GHCR) и автодеплоится — **сборка на прод-сервере запрещена** (роняет хост).
- Версии пинованы: `@json-render/core|react` exact 0.19.0 (обновлять только связкой), React ^19.2.7, zod 4, Tailwind 4. Зависимости устанавливает только **npm** (pnpm и `bun install` не использовать), Node ≥24. Bun 1.3.14 пинован в `.bun-version` и используется только как runtime для `server/`; рабочий бинарник — `~/.bun/bin/bun`, битый npm-шим `/usr/local/bin/bun` не использовать, поэтому `~/.bun/bin` должен идти первым в `PATH`.
- Stateful e2e-серверы никогда не переиспользуются: API dev работает с `.e2e-data/dev` на 127.0.0.1:8787, Bun preview — с `.e2e-data/preview` на 127.0.0.1:4173; каталоги очищаются командами `webServer` перед запуском.
- `DATA_DIR` обязан находиться внутри корня проекта: материализованные TSX-модули разрешают `react`, `zod` и остальные зависимости из корневого `node_modules`. Сервер — workspace-инструмент и требует полный `npm install`, включая devDependencies для publish typecheck.
- Окружение: code-server **игнорирует флаги портов** — реальный порт брать из лога сервера; reverse-proxy хосты `*.coder` разрешены в `vite.config.ts` (`server`/`preview.allowedHosts`).
- Рецепт runtime-верификации: `.claude/skills/verify/SKILL.md`.

## Workflow: Fable 5 (orchestrator) + subagents/workflows (Opus)

Every non-trivial task goes through three stages: planning → adversarial plan review → delegated execution. Do not start implementation until the plan has passed review.

Делегирование — через встроенные механизмы Claude Code: **Agent tool** (subagents) для отдельных задач и **Workflow tool** для детерминированной оркестрации (fan-out, pipeline, adversarial verify). Модель субагентов и workflow-агентов — **Opus** (`model: "opus"`); оркестратор — Fable 5.

### Stage 1 — Planning (Fable 5, max)

1. Work in plan mode (`/plan`) with maximum reasoning effort.
2. Save the finished plan to `docs/plans/YYYY-MM-DD-<topic>.md` and commit.

### Stage 2 — Plan review (subagents, Opus)

1. Диспатч адверсариального ревью плана: один или несколько read-only субагентов (Opus), промпт: «адверсариально отревьюй план в docs/plans/<file> — оспорь подход, допущения, декомпозицию; выдай находки с severity (blocker/major/minor) и рекомендациями». Для тщательного ревью — Workflow с несколькими ревьюерами по разным линзам (correctness, scope, риски миграций) + verify-стадией.
2. Fable 5 triages the review findings and revises the plan (триаж фиксировать в плане: принято/отклонено с обоснованием). If the plan changes substantially, re-run the review — iterate until no blocking objections remain.
3. Never silently apply review findings to code — update the plan first.

### Stage 3 — Execution (Fable 5 orchestrates, Opus subagents execute)

1. Fable 5 decomposes the approved plan into self-contained tasks with clear done-criteria **и явным file ownership** (какая задача какими файлами владеет; параллелить только непересекающиеся зоны).
2. Каждая задача — отдельный субагент (Agent tool, `model: "opus"`) либо стадия Workflow; в промпте: ссылка на план и конкретные §§, скоуп/владение файлами, критерии, «читай `.d.ts` в node_modules, не угадывай API», «не коммить» (коммитит оркестратор после независимой проверки done-критериев).
3. Fable 5 manages the task flow as orchestrator:
   - параллельные волны — несколько background-субагентов или Workflow-`pipeline`/`parallel`; при параллельной записи в пересекающиеся файлы — `isolation: "worktree"`;
   - **независимо верифицирует done-критерии каждой задачи** (прогоняет команды сам, смотрит ключевые файлы) до коммита и следующей волны;
   - коммитит поэтапно, по зонам владения.
4. Если субагент застрял или результат неудовлетворителен после одной итерации — продолжить его тред через SendMessage с уточнениями либо передиспатчить свежего субагента с уточнённым ТЗ; при необходимости Fable 5 доделывает сам.
5. Fable 5 itself handles integration of results, conflict resolution between tasks, and the final verification pass: `npm run verify` + `npm run e2e` + runtime-прогон по `.claude/skills/verify/SKILL.md` (скилл `/verify`).
