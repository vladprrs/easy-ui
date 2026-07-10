# Серверный API easy-ui: создание и версионирование прототипов и кастомных компонентов (Bun)

## Context

easy-ui сейчас полностью клиентский: прототипы — статические JSON, вбандленные через `import.meta.glob` (`src/prototype/loader.ts`); компоненты — код (36 shadcn + Hotspot). Роадмап (редактор, конструктор, AI-генерация) требует серверного хранилища с версионированием. Скоуп этой итерации: REST API для CRUD + версионирования **прототипов** и **кастомных компонентов** — новых атомов/молекул дизайн-системы (реальный React-код, не композиции каталога). UI редактора — вне скоупа, API-first.

Решения, зафиксированные с пользователем:
- **Компоненты** = новые атомы/молекулы (TSX-код), добавляемые в дизайн-систему через API.
- **Версии**: иммутабельные ревизии на каждый save (rev 1..N, head, restore = новая ревизия) + явный publish → именованные версии v1, v2…
- **Стек**: Bun по максимуму встроенного (`Bun.serve` + routes, `bun:sqlite`, `Bun.build`, нативный TS-импорт). Bun **не установлен** (Node 24.18) — установка входит в план; зависимости ставит только npm (`bun install` не запускать).
- **Доступ**: без auth, single-user; поле `author` в схеме «на вырост».

Проверенные факты, на которых держится дизайн:
- `@json-render/shadcn` имеет subpath `./catalog` (`dist/catalog.mjs`) — экспортирует `shadcnComponentDefinitions`, **0 упоминаний react** (проверено) → серверный граф валидации без React возможен.
- `src/prototype/validate.ts:2` жёстко импортирует `componentDefinitions` — нужна параметризация.
- zod 4.4.3 установлен, есть `z.toJSONSchema` (для информационного propsJsonSchema).
- `scripts/validate-prototypes.ts` уже гоняет schema+validate в Node — валидатор изоморфен.
- Смежный план `2026-07-10-flow-state-persist-share.md` тоже переписывает `PlayerShell.tsx` — **не параллелить**, секвенировать.

## Ключевые решения

| Вопрос | Решение |
|---|---|
| БД | `bun:sqlite`, один файл `data/easy-ui.db`, WAL, миграции по `PRAGMA user_version`; `data/` в .gitignore |
| Ссылки прототипов на кастомы | `element.type` = PascalCase-имя; head-прототип резолвит **последнюю published** версию; publish прототипа снапшотит `{componentId: version}` |
| Использование кастома | Только после publish компонента (клиент грузит только скомпилированные бандлы) |
| Валидация save | Сервер: `prototypeDocSchema` + `validatePrototype(doc, {definitions: builtin ∪ custom})` → 422 `{errors, warnings}` (существующий `ValidationIssue`) |
| Дефиниции кастомов | zod не сериализуем: сервер получает схему **импортом исходника** (Bun TS-импорт, материализация в `data/modules/<id>/<rev>-<hash>.tsx` = cache-busting, try/catch); клиент — из самого загруженного модуля |
| React singleton | Хост кладёт shared в `globalThis.__easyUiShared` (`src/customComponents/shared.ts`); сервер генерирует ESM-шимы `/api/shims/<name>.js` (react, react/jsx-runtime, react-dom, zod, @json-render/react); Bun.build-плагин переписывает bare-импорты на эти URL. Без import map, dev/prod-паритет |
| Стили v1 | Гарантированы: классы, уже попавшие в CSS приложения (весь shadcn-набор через `@source`), CSS-переменные темы, inline-стили. Произвольные новые Tailwind-классы — нет (документируем; v2 — per-version компиляция CSS) |
| Конкурентность | Опциональный `baseRev` в PUT → 409 при несовпадении с head |
| Seed | Идемпотентный импорт `prototypes/*.json` на старте (id нет в БД → rev 1); файлы остаются, `validate:prototypes` не меняется |
| Prod | `bun server/main.ts` с `SERVE_DIST=dist` раздаёт SPA (+fallback) + `/api` — заменяет `vite preview` в e2e |
| Порты | vite :5173, storybook :6006, API dev :8787, prod/preview :4173; vite dev proxy `/api → :8787` |

## Схема БД (server/migrations.ts)

Две симметричные тройки таблиц:
- `prototypes(id slug PK, name, head_rev, created_at, updated_at)` · `prototype_revisions(prototype_id, rev, doc JSON, message, author, created_at, PK(id,rev))` · `prototype_publishes(prototype_id, version, rev, component_versions JSON, message, published_at, PK(id,version))`
- `components(id slug PK, name PascalCase UNIQUE, head_rev, ...)` · `component_revisions(..., source TSX, ...)` · `component_publishes(..., compiled_js, definition_meta JSON {events,slots,description,propsJsonSchema?}, ...)`

Save/publish — в `db.transaction()`; rev монотонный; hard delete с каскадом (DELETE компонента → 409, если он в `component_versions` published-прототипов).

## API (всё под /api, JSON)

Ошибки: 400/404/409 `{error:{code,message}}`; 422 `{errors, warnings}` (ValidationIssue `{path,message}`).

**Прототипы**: `GET /prototypes` (summary-список) · `POST /prototypes {doc,message?}` → 201 · `GET /prototypes/:id` → `{doc, headRev, components:[{id,name,version,bundleUrl}]}` · `PUT /prototypes/:id {doc,message?,baseRev?}` · `DELETE` · `GET /:id/revisions[/:rev]` · `POST /:id/restore {rev}` · `POST /:id/publish` (422 если head использует неопубликованный кастом; снапшотит componentVersions) · `GET /:id/versions[/:version]`.

**Компоненты**: то же по форме (`source` вместо `doc`) + `POST /components {id, name, source}` (name уникален против builtin и таблицы) · `POST /:id/publish` → компиляция Bun.build, сохранение compiled_js + definition_meta · `GET /:id/versions/:v/bundle.js` (immutable cache).

**Служебные**: `GET /catalog/manifest` (последние published кастомы: метаданные + bundleUrl) · `GET /shims/:name.js` · `GET /health`.

Контракт компонента при save (эшелоны → 422): (1) `Bun.Transpiler` — синтаксис; (2) материализация + `import()` в try/catch; (3) экспорты: named `definition` `{props: z.ZodType, events?, slots?, description}` + default React-компонент (`BaseComponentProps`, как `src/catalog/hotspot.tsx`). Разрешённые импорты: zod, react, `@json-render/react` (типы). Зависший top-level код — принятый риск single-user (v2 — Bun Worker + таймаут).

## Изменения по файлам

**Рефакторинг shared-графа (без изменения поведения):**
- `src/prototype/validate.ts` — `validatePrototype(doc, options?: {definitions?})`, дефолт прежний; заменить 2 обращения к константе.
- `src/catalog/definitions.ts` — импорт из `@json-render/shadcn/catalog`; `hotspotDefinition` → новый чистый `src/catalog/hotspot.definition.ts` (hotspot.tsx реэкспортирует). Экспортировать тип `ComponentDefinition`.
- `src/catalog/runtime.ts`/`catalog.ts` — `createPlayerRuntime(deps, custom?)`: при наличии кастомов собирать каталог/registry динамически (сигнатуры `defineCatalog`/`defineRegistry` сверять по `.d.ts`).

**Сервер (новое, `server/`):** `main.ts` (Bun.serve routes), `db.ts`, `migrations.ts`, `repos/*`, `routes/{prototypes,components,shims}.ts`, `validation.ts` (merged definitions), `components/{pipeline,compile}.ts`, `seed.ts`, `static.ts`, `tsconfig.json` (types: ["bun"], без vite/client), `*.test.ts` (bun test, `:memory:` БД + fetch к `Bun.serve({port:0})`), фикстура `server/fixtures/rating-stars.tsx`.

**Клиент:** `src/api/{client,hooks}.ts` (новые) · `src/prototype/loader.ts` — async fetch вместо glob (защитный safeParse остаётся) · `src/gallery/GalleryPage.tsx` — loading/error/ready · `src/player/PlayerShell.tsx` — гейт загрузки doc + кастомов, передача `custom` в runtime (механику sessionNonce/`navigation.tsx` не трогать) · `src/customComponents/{shared,loader}.ts` (новые) · `vite.config.ts` — proxy `/api`.

**Инфраструктура:** `package.json` — `server:dev` (`bun --watch server/main.ts`), `server:test`, `server:typecheck`, `serve`; `verify` дополнить; devDep `@types/bun` (через npm). `.gitignore` — `data/`, `.e2e-data/`. `playwright.config.ts` — webServer для API (health-url) + preview через bun. `CLAUDE.md` — команды, «пакеты ставит только npm; bun — рантайм server/». Новый `docs/server-api.md` — контракты API, формат компонента, стилевое ограничение v1.

## Риски

- **Bun не установится** (сеть) — первый шаг серверной задачи: `npm i -g bun`, фолбэк — официальный установщик; если оба мимо — **эскалация пользователю** (не менять стек молча).
- **Bun.build-плагин `{path: "/api/...", external: true}`** — семантика не проверена вживую → спайк первым шагом; фолбэк — пост-процессинг импорт-спецификаторов в выходном ESM.
- **Dual React / invalid hook call** — обязательная e2e-фикстура кастомного компонента **с useState**.
- **Async-рефакторинг loader** — одна задача владеет всеми потребителями; grep по `prototype/loader` перед сдачей.
- **Конфликт с flow-persist-планом** (общий PlayerShell.tsx) — секвенировать, не параллелить.

## Задачи (Codex --fresh --write --effort medium; волны 1 → 2 → (3 ∥ 4) → 5 → 6)

1. **Shared-граф + параметризация валидатора** — файлы из «Рефакторинг» + тесты. Done: `npm run verify` зелёный; юнит на `validatePrototype(doc,{definitions})` с кастомной дефиницией; node-smoke: цепочка definitions→validate резолвится без react.
2. **Bun-сервер: ядро, БД, API прототипов, seed, статика** — `server/` (кроме components/*), package.json, .gitignore. Предусловие: установка bun. Done: `bun test server` зелёный; curl-сценарий seed → save (422/409) → revisions → restore → publish → versions; `SERVE_DIST=dist` отдаёт SPA с fallback.
3. **Пайплайн компонентов** — `server/components/*`, `routes/{components,shims}.ts`, `validation.ts`, фикстура. Done: 422 с диагностикой на битый исходник (сервер жив); bundle.js импортирует `/api/shims/...`; save прототипа с кастомом валидируется; publish снапшотит componentVersions.
4. **Клиентский data-layer** — `src/api/*`, loader, Gallery, PlayerShell, vite.config. Done: test+typecheck зелёные (client замокан); в dev галерея и прототипы живые; синхронный `prototypes` не используется нигде.
5. **Клиентский рантайм кастомов** — `src/customComponents/*`, интеграция в PlayerShell. Done: битый модуль → мягкая деградация; прототип с published RatingStars (с useState) рендерится и эмитит событие.
6. **Топология, e2e, доки** — playwright.config, `e2e/dev/api.spec.ts`, `e2e/dev/custom-component.spec.ts`, preview на bun, verify, CLAUDE.md, docs/server-api.md. Done: `npm run verify` + `npm run e2e` зелёные; runtime-прогон `/verify`.

## Верификация (финальная)

`npm run verify` (включая server:typecheck + bun test) → `npm run e2e` (dev + preview на bun-сервере) → скилл `/verify`: галерея с сервера, флоу checkout/settings, POST кастомного компонента → publish → прототип с ним рендерится, hook работает, событие эмитится.

## Процесс (workflow проекта)

1. **Stage 1**: сохранить план как `docs/plans/2026-07-10-server-api-versioning.md`, закоммитить.
2. **Stage 2**: `export CODEX_HOME="$PWD/.codex-home"` → adversarial-ревью Codex gpt-5.6-sol (`task --background`, read-only, промпт из файла через stdin, зомби-вотчер). Триаж находок в план; существенные правки → `--resume` того же треда.
3. **Stage 3**: задачи 1–6 по волнам, независимая верификация done-критериев оркестратором, поэтапные коммиты по зонам владения.
