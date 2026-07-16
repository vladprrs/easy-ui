# CLAUDE.md

## Проект: easy-ui

Просмотрщик кликабельных прототипов поверх json-render + Storybook: многоэкранные флоу из живых shadcn-компонентов, навигация через actions, общий стейт флоу. Источник истины — каталог/registry в `src/catalog/`; Storybook — витрина. Роадмап: редактор прототипов, конструктор экранов, AI-генерация.

- План MVP и контракты: `docs/plans/2026-07-10-prototype-viewer-mvp.md` (v3), формат прототипов: `docs/prototype-format.md` (строгий allowlist v1), Bun API: `docs/server-api.md` (в т.ч. discovery: `GET /api/openapi.json`, `GET /api/capabilities`, JSON-схемы документа/компонента).
- Ключевые зоны: `src/catalog/` (definitions/actions/runtime/fixtures), `src/designSystems/` (definitions систем и atomic-уровни), `src/prototype/` (schema/validate/loader), `src/player/` (navigation с sessionNonce, stale-гейт) + `src/player/inspector/` (interaction inspector за `?debug=1`), `src/capture/` (capture-shell для скриншотов), `src/visual/` (visual regression UI), `src/gallery|library/`, `server/assets|screenshot|visual/`, `prototypes/*.json`.
- Команды: `npm run dev` (:5173, proxy `/api` → 127.0.0.1:8787) · `npm run server:dev` (:8787) · `npm run serve` (:4173, API + статика из `dist`) · `npm run storybook` (:6006) · `npm run verify` (полный агрегат) · `npm run e2e` (vite+API dev и Bun preview) · `npm run validate:prototypes` · `npm run build` (SPA + dist/storybook).
- Production-деплой в Dokploy описан в `docs/server-api.md#deployment`; точка входа — корневой `docker-compose.yml`. Bootstrap-admin задаётся секретами `ADMIN_NAME`/`ADMIN_PASSWORD`; переходный внешний барьер — `LEGACY_BASIC_AUTH` (`BASIC_AUTH` временно принимается как deprecated alias для rollback-window). Рецепт деплоя/верификации прода — скилл `/deploy` (`.claude/skills/deploy/SKILL.md`); push в `main` собирает образ в GitHub Actions (GHCR) и автодеплоится — **сборка на прод-сервере запрещена** (роняет хост).
- Версии пинованы: `@json-render/*` exact 0.19.0 (обновлять только связкой), Storybook exact 10.4.6, React ^19.2.7, zod 4, Tailwind 4. Зависимости устанавливает только **npm** (pnpm и `bun install` не использовать), Node ≥24. Bun 1.3.14 пинован в `.bun-version` и используется только как runtime для `server/`; рабочий бинарник — `~/.bun/bin/bun`, битый npm-шим `/usr/local/bin/bun` не использовать, поэтому `~/.bun/bin` должен идти первым в `PATH`.
- Stateful e2e-серверы никогда не переиспользуются: API dev работает с `.e2e-data/dev` на 127.0.0.1:8787, Bun preview — с `.e2e-data/preview` на 127.0.0.1:4173; каталоги очищаются командами `webServer` перед запуском. Vite и Storybook остаются на `localhost`, поскольку vite в контейнере слушает IPv6 localhost.
- `DATA_DIR` обязан находиться внутри корня проекта: материализованные TSX-модули разрешают `react`, `zod` и остальные зависимости из корневого `node_modules`. Сервер — workspace-инструмент и требует полный `npm install`, включая devDependencies для publish typecheck.
- Окружение: code-server **игнорирует флаги портов** — реальный порт брать из лога сервера; reverse-proxy хосты `*.coder` разрешены в `vite.config.ts` (`server`/`preview.allowedHosts`) и `.storybook/main.ts` (`core.allowedHosts` — у Storybook своя проверка хоста).
- Рецепт runtime-верификации: `.claude/skills/verify/SKILL.md`.

## Workflow: Fable 5 (orchestrator) + Codex gpt-5.6-sol (reviewer & executor)

Every non-trivial task goes through three stages: planning → adversarial plan review → delegated execution. Do not start implementation until the plan has passed review.

### Roles

| Role | Model | Reasoning effort |
|---|---|---|
| Planner & orchestrator | Claude Fable 5 | max |
| Plan reviewer | Codex `gpt-5.6-sol` | max (via Codex config, see note below) |
| Task executor | Codex `gpt-5.6-sol` | `--effort medium` |

### Механика диспатча Codex (проверено 2026-07-10, plugin v1.0.6)

Единственный надёжный способ запускать длинные Codex-задачи — companion CLI **из основного шелла оркестратора**:

```bash
COMP=".claude-config/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs"
node "$COMP" task --background [--write] --model gpt-5.6-sol [--effort medium] [--fresh|--resume] < prompt.txt
node "$COMP" status --json | result <jobId> | cancel <jobId>
```

- **Промпт всегда через файл + stdin**, не инлайном в Bash: бэктики в тексте выполняются шеллом как command substitution.
- **Не диспатчить долгие задачи через rescue-subagent/форвардер**: companion-раннер умирает вместе с ходом сабагента → зомби-задача («running», мёртвый PID).
- **Наблюдение**: фоновый цикл по `status --json` + `kill -0 <pid>`. Статус «running» при мёртвом PID = зомби → `cancel` + повторный диспатч. `result` работает только по завершённым задачам.
- Codex иногда завершает ход на промежуточной реплике («продолжаю…») — возобновить тред: `task --resume "Продолжай выполнение задачи по ТЗ из первого сообщения треда"`.
- **Песочница**: bwrap в этом контейнере невозможен (`No permissions to create a new namespace`) → в companion пропатчена строка ~491: write-задачи идут с `danger-full-access` вместо `workspace-write` (авторизовано пользователем; эквивалент его `codex-here.sh` с `--dangerously-bypass-approvals-and-sandbox`). Обновление плагина затирает патч — при повторном `bwrap`-падении write-задач переприменить. Режим песочницы фиксируется при создании треда: после переприменения патча диспатчить `--fresh`, а не `--resume`.
- Write-задачам запрещать `git commit` в промпте — коммитит оркестратор после независимой проверки done-критериев.

### Stage 1 — Planning (Fable 5, max)

1. Work in plan mode (`/plan`) with maximum reasoning effort.
2. Save the finished plan to `docs/plans/YYYY-MM-DD-<topic>.md` and commit — ревью читает файл из рабочего дерева git.

### Stage 2 — Plan review (Codex gpt-5.6-sol, max)

1. Диспатч ревью — той же механикой (`task --background`, read-only, без `--write`), промпт: «адверсариально отревьюй план в docs/plans/<file> — оспорь подход, допущения, декомпозицию; выдай находки с severity (blocker/major/minor) и рекомендациями». Команда `/codex:adversarial-review` из плагина в сессии оркестратора недоступна — не полагаться на неё.
2. Effort note: GPT-5.6 Sol supports `max`, but the plugin's `--effort` flag does not accept it (none/minimal/low/medium/high/xhigh). Config-level `max` задан в `model_reasoning_effort = "max"` (`.codex-home/config.toml` — проектный CODEX_HOME; companion без экспорта переменной читает `~/.codex`). Для гарантии — `export CODEX_HOME="$PWD/.codex-home"` перед диспатчем ревью; task-раны перекрывают per-call `--effort medium`.
3. Fable 5 triages the review findings and revises the plan (триаж фиксировать в плане: принято/отклонено с обоснованием). If the plan changes substantially, re-run the review — iterate until no blocking objections remain. Повторный раунд — `--resume` того же треда (контекст ресёрча сохраняется).
4. Never silently apply review findings to code — update the plan first.

### Stage 3 — Execution (Fable 5 orchestrates, Codex executes)

1. Fable 5 decomposes the approved plan into self-contained tasks with clear done-criteria **и явным file ownership** (какая задача какими файлами владеет; параллелить только непересекающиеся зоны).
2. Каждая задача — отдельный `--fresh` диспатч с `--write --effort medium`; в промпте: ссылка на план и конкретные §§, скоуп/владение файлами, критерии, «читай `.d.ts` в node_modules, не угадывай API», «не коммить».
3. Fable 5 manages the task flow as orchestrator:
   - параллельные волны — несколько `--background`-задач + общий наблюдатель;
   - **независимо верифицирует done-критерии каждой задачи** (прогоняет команды сам, смотрит ключевые файлы) до коммита и следующей волны;
   - коммитит поэтапно, по зонам владения;
   - зомби/оборванные ходы — по правилам из «Механики диспатча».
4. If Codex gets stuck or the result is unsatisfactory after one iteration, escalate: re-dispatch with `--effort high`/`xhigh` (или без флага — упадёт в config-level `max`).
5. Fable 5 itself handles integration of results, conflict resolution between tasks, and the final verification pass: `npm run verify` + `npm run e2e` + runtime-прогон по `.claude/skills/verify/SKILL.md` (скилл `/verify`).
