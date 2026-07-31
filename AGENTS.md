# AGENTS.md — операционная инструкция для агентов в этом репозитории

Читают все агенты, в том числе те, что **не** читают `CLAUDE.md` (Codex CLI и внешние клиенты).
Поэтому операционные разделы здесь развёрнуты целиком, а не ссылкой.

## Проект

easy-ui — мультиюзерный просмотрщик и редактор кликабельных прототипов поверх json-render.
Каталог **custom-only**: компоненты публикуются через HTTP API, а `Image`/`Hotspot`/`Overlay`/
`@eui/FlowRoot` поставляет host runtime. Storybook и встроенные дизайн-системы удалены.

Ключевые зоны: `src/catalog/` (host definitions/actions/runtime), `src/designSystems/`,
`src/prototype/` (schema/validate/loader), `src/player/`, `src/editor/`, `src/capture/`,
`src/visual/`, `src/gallery|library/`, `server/` (Bun API), `sdk/` (типизированный SDK авторинга),
`test/fixtures/`.

Документы-источники истины:

| Тема | Файл |
|---|---|
| Политика авторинга (reuse before create) | **`docs/agent-authoring-policy.md`** — канон |
| Глоссарий канонических ролей | `docs/canonical-roles.md` + `server/catalog/roles.json` |
| HTTP API, коды ошибок, deployment | `docs/server-api.md` |
| Грамматика документа прототипа | `docs/prototype-format.md` |
| Типизированный SDK авторинга | `docs/authoring-sdk.md` |
| Канон дизайн-системы yandex-pay | `docs/design/yandex-pay.md` |

## Команды

```bash
npm run dev              # Vite SPA :5173, proxy /api → 127.0.0.1:8787
npm run server:dev       # Bun API :8787
npm run serve            # preview :4173
npm run verify           # полный релизный гейт без e2e (typecheck, lint, тесты, openapi, sdk, build, css)
npm run e2e              # Playwright, отдельно от verify
npm run server:typecheck # tsc по server/
npm run lint             # eslint
npm run verify:sdk       # tsc sdk/ + drift-проверка + vitest sdk/
npm run validate:templates
```

Серверные тесты — `~/.bun/bin/bun test server/` (или `npm run server:test`).

## Окружение (грабли, стоившие времени)

- Зависимости ставит **только npm** (`npm install` / `npm ci`); pnpm и `bun install` не использовать.
  Node ≥ 24.
- Bun 1.3.14 пинован в `.bun-version` и используется **только** как runtime для `server/`.
  Рабочий бинарник — `~/.bun/bin/bun`; битый npm-шим `/usr/local/bin/bun` не использовать,
  поэтому `~/.bun/bin` должен идти первым в `PATH`.
- Версии пинованы: `@json-render/core|react` exact `0.19.0` (обновлять только связкой),
  React `^19.2.7`, zod 4, Tailwind 4.
- `DATA_DIR` обязан лежать **внутри корня проекта**: материализованные TSX-модули резолвят
  `react`, `zod` и остальное из корневого `node_modules`. Сервер — workspace-инструмент и требует
  полный `npm install`, включая devDependencies (publish делает typecheck).
- Stateful e2e-серверы не переиспользуются: API dev — `.e2e-data/dev` на 127.0.0.1:8787,
  Bun preview — `.e2e-data/preview` на 127.0.0.1:4173; каталоги чистятся командами `webServer`.
- code-server **игнорирует флаги портов** — реальный порт брать из лога сервера; reverse-proxy
  хосты `*.coder` разрешены в `vite.config.ts`.
- Сборка образа на прод-сервере **запрещена** (роняет хост): push в `main` собирает образ в
  GitHub Actions (GHCR), Dokploy только пуллит.
- Публичный API имеет rate-limit на логин: не логиниться в цикле, драйвер логинится один раз
  на процесс.

## Правила работы с кодом

- Не коммитить и не пушить без явной просьбы; на дефолтной ветке сначала завести ветку.
- Читать `.d.ts` в `node_modules` и фактический код, а не угадывать API.
- Правки в чужих зонах не «чинить попутно»: сначала согласовать.
- Тесты и типы обязаны быть зелёными в затронутых зонах до сдачи работы.

## Авторинг компонентов и прототипов: **переиспользуй, прежде чем создавать**

Канон — `docs/agent-authoring-policy.md`. Ниже — исполняемая выжимка; при расхождении прав канон.

Харнес — `.claude/skills/author/driver.mjs` (Node ≥ 18, без зависимостей). Креды —
`EASYUI_USERNAME` / `EASYUI_PASSWORD`, инстанс — `EASYUI_API` (по умолчанию прод).
Любой verb принимает `--json`.

### 1. Дешёвый цикл открытия каталога

```bash
node driver.mjs catalog list yandex-pay
node driver.mjs catalog search yandex-pay --intent "Let a customer rate a product from one to five stars" --limit 5 --json
node driver.mjs catalog get yandex-pay yp-box YpText --json
```

`catalog list` — инвентарь (имена берутся отсюда), `catalog search` — кандидаты матчера,
`catalog get` — exact definitions **только** названных артефактов. Полный дамп
(`catalog <ds> --full`) — примерно на порядок дороже по контексту; запускать только когда нужен
весь каталог целиком.

### 2. Прежде чем создавать компонент

1. Сформулируй `intent` — продуктовую задачу, 8..500 символов, минимум один токен вне стоп-набора
   `component`/`компонент`/`element`/`элемент`/`ui`.
2. Прогони `catalog search` и прочитай кандидатов.
3. Кандидат покрывает — используй его; почти покрывает — **расширь новой ревизией** non-breaking
   (обновление гейт создания не проходит); не подходит — создавай и объясни отличие в `intent`.
4. Создание: `node driver.mjs component <id> <Name> <src.tsx> --design-system <ds> --intent "<intent>"`.

Задача «собрать экран из существующего» решается **композицией**, а не новым компонентом:
`node driver.mjs composition <id> <doc.json> --design-system <ds>` и
`node driver.mjs composition publish <id>`.

### 3. `409` — терминальный STOP

`component_reuse_required`, `canonical_role_conflict`, `catalog_changed` приходят с
`retryable: false`. **Не ретраить, не переименовывать ради обхода, не звать `--force-new`
автоматически** — драйвер печатает кандидатов и выходит с кодом `2`.

Сохрани `decisionId`. `resolution: "reuse"` означает, что блокирующий кандидат способен выразить
нужное (см. `propsDelta`); `"escalate"` — не способен. `catalog_changed` требует повторного
discovery и нового решения человека. Обход существует только как двухфазное действие человека и
только у администратора:

```bash
node driver.mjs component rating-stars RatingStars examples/rating-stars.tsx \
  --design-system yandex-pay \
  --intent "Let a customer rate a product from one to five stars" \
  --force-new --reason "Product owner approved a distinct rating interaction for this flow"
```

`--reason` — 20..500 символов; не-администратор получает `403 admin_required`; каждый обход
попадает в append-only аудит (`node driver.mjs audit reuse --design-system yandex-pay`, только админ).

### 4. Фаза гейта

`GET /api/capabilities` → `reuseGate {mode, intentRequired, policyVersion}`. `intentRequired`
истинно ровно в `enforce`. Пиши клиента, который умеет обе фазы: `intent` слать всегда, на успех
создания дубликата не рассчитывать. В `shadow` блокирующее совпадение возвращается в `warnings[]`
— читать, а не глушить.

### 5. Метаданные

Новый компонент обязан нести содержательный `description`, незавышенный `atomicLevel`, при
применимости `scope`, и `canonicalFor` — только слагами из `docs/canonical-roles.md` и только если
компонент действительно канонический для роли. Пустая мета готовит следующий дубликат.

## Скиллы (Claude Code)

`.claude/skills/author` — механика авторинга и драйвер; `.claude/skills/yandex-pay` — канон
компонентов YP; `.claude/skills/yp-prototype` — сборка YP-прототипов; `.claude/skills/verify` —
runtime-верификация; `.claude/skills/deploy` — деплой. Агенту без поддержки скиллов достаточно
этого файла и `docs/agent-authoring-policy.md`.
