# Серверный API easy-ui: создание и версионирование прототипов и кастомных компонентов (Bun)

**Версия плана: v3.** Раунд 1 ревью (Codex gpt-5.6-sol, max): 26 находок, 4 blocker → v2. Раунд 2: 14 находок, 2 blocker (version-aware навигация; staging→active активация publish) — устранены в v3, триаж в §12–13.

## Context

easy-ui сейчас полностью клиентский: прототипы — статические JSON, вбандленные через `import.meta.glob` (`src/prototype/loader.ts`); компоненты — код (36 shadcn + Hotspot). Роадмап (редактор, конструктор, AI-генерация) требует серверного хранилища с версионированием. Скоуп этой итерации: REST API для CRUD + версионирования **прототипов** и **кастомных компонентов** — новых атомов/молекул дизайн-системы (реальный React-код, не композиции каталога). UI редактора — вне скоупа, API-first.

Решения, зафиксированные с пользователем:
- **Компоненты** = новые атомы/молекулы (TSX-код), добавляемые в дизайн-систему через API.
- **Версии**: иммутабельные ревизии на каждый save (rev 1..N, head, restore = новая ревизия) + явный publish → именованные версии v1, v2…
- **Стек**: Bun по максимуму встроенного (`Bun.serve` + routes, `bun:sqlite`, `Bun.build`, нативный TS-импорт). Клиентский тулчейн — npm/vite; **зависимости ставит только npm**.
- **Доступ**: без auth, single-user; поле `author` в схеме «на вырост».

Факты, проверенные спайками (bun 1.3.14) и чтением кода:
- **Bun 1.3.14 установлен** официальным инсталлером в `~/.bun/bin` (`npm i -g bun` падает EACCES — не использовать). Пин версии: `.bun-version` c `1.3.14`; auto-install зависимостей выключить (executor сверяет механизм: `bunfig.toml [install] auto="disable"` или флаг); preflight `bun --version` в скриптах.
- **Bun.build plugin `onResolve → {path, external:true}` НЕ переписывает спецификаторы** в выходном ESM (проверено с `/`-путём и https-URL) → переписывание импортов на shim-URL — **пост-процессинг выходного ESM** (основной механизм, не фолбэк).
- Без `NODE_ENV=production` транспилятор эмитит `react/jsx-dev-runtime`; с ним — `react/jsx-runtime`. Компиляция форсит production.
- Динамический `import()` TSX из `data/modules/` под bun работает: zod резолвится из корневого npm-`node_modules`, `definition.props instanceof z.ZodType === true`.
- `@json-render/shadcn` имеет React-free subpath `./catalog` (0 упоминаний react в dist/catalog.mjs) → builtin-граф валидации без React. Импорт **кастомного** TSX всегда тянет jsx-runtime — серверный component-пайплайн React-содержащий, это два разных smoke-критерия.
- `defineCatalog(schema, catalog)` / `defineRegistry(catalog, options)` — снапшотные фабрики: каталог/registry собираются **один раз после полной загрузки манифеста**, мутация исходных map ничего не даёт; при смене манифеста — пересоздание + remount.
- `src/prototype/validate.ts:2` жёстко импортирует `componentDefinitions` — нужна параметризация.
- Смежный план `2026-07-10-flow-state-persist-share.md` тоже переписывает `PlayerShell.tsx` — исполняется **после** этого плана с аддендумом (rev/version в persist-ключах и share).

## Граница доверия (v1, зафиксировано)

Auth нет (решение пользователя). Техническая граница: **сервер слушает `127.0.0.1`** — в dev доступ через vite-proxy `/api`, в prod/preview браузер ходит через аутентифицированный coder reverse-proxy к vite/bun на localhost workspace. Код кастомных компонентов исполняется с правами серверного процесса — доверие уровня кода репозитория (single-user workspace); это документируется в `docs/server-api.md`. Смягчения: извлечение дефиниций **драфтов** — в короткоживущем сабпроцессе с таймаутом (зависание/утечка памяти не трогают сервер); **in-process импортируются только published-ревизии** (ограниченное множество, кэш навсегда). Полноценный sandbox/auth — v2.

## Ключевые решения

| Вопрос | Решение |
|---|---|
| БД | `bun:sqlite`, один файл `data/easy-ui.db`, WAL, миграции по `PRAGMA user_version`; `data/` в .gitignore |
| Пин зависимостей прототипа | На **каждом save**: резолв `element.type` → последняя published версия кастома, запись в `prototype_revision_components`. Ревизия полностью воспроизводима; новый publish компонента влияет на прототип только при следующем save. Publish прототипа = присвоение имени уже зафиксированной ревизии |
| Использование кастома | Только published-версии (драфт-ревизии компонентов не резолвятся) |
| Read-models прототипа | `GET /:id/draft` (head + пины его ревизии) и `GET /:id/versions/:v` (иммутабельный снапшот). Маршруты плеера: `/p/:id/s/:screen` = draft, `/p/:id/v/:version/s/:screen` = published. **`navigation.tsx` получает version-aware построение путей**: `routeBase` в `PlayerNavigationProvider` (или общий `buildPlayerPath()`) — меняется только конструирование URL, семантика sessionNonce/stale/flowDepth не трогается; тест: published bootstrap → navigate → restart → back не теряют `/v/:version` |
| Активация publish компонента | `component_publishes.status: staging → active \| failed`. Транзакция 1 создаёт **невидимый** staging-publish (CAS по head + `deleted_at IS NULL`); затем in-process импорт ревизии; транзакция 2 переводит в active (или failed при ошибке импорта). Манифест, резолв пинов и bundle-роуты видят **только active** |
| Валидация save прототипа | Линеаризация пинов: до валидации фиксируется точный набор `(componentId, version)` из active-publishes; `validatePrototype(doc, {definitions: builtin ∪ именно эти версии})`; транзакция вставляет **этот же** набор (без повторного резолва latest), проверяя только `deleted_at IS NULL`. Конкурентный тест save ∥ publish. Warnings возвращаются и при успехе |
| Дефиниции кастомов | Сервер: save-чек драфта в сабпроцессе (таймаут ~10s); для валидации прототипов in-process импорт **published**-ревизий из `data/modules/<id>/<rev>-<sha256_8>.tsx` (атомарная запись, никогда не перезаписывается). Клиент: схема из самого загруженного модуля |
| React singleton + shim ABI | Хост кладёт shared в `globalThis.__easyUiShared`; сервер генерирует ESM-шимы со **статически перечисленными** named exports: `/api/shims/v1/{react,react-dom,react-jsx-runtime,zod,json-render-react}.js`. `hostAbiVersion: 1` пишется в publish компонента. Bundle → шимы через пост-процессинг (см. пайплайн) |
| Компиляция при publish | Двухфазно: (1) вне транзакции — контракт-чеки + `Bun.build` (NODE_ENV=production, `splitting:false`, external = точный allowlist) + пост-процессинг + верификация; (2) короткая sync-транзакция с CAS-перепроверкой head → insert publish. `db.transaction()` — синхронный API, async внутри не живёт |
| Артефакты | Ровно один JS-output; relative/dynamic/CSS/asset-импорты и любые bare-импорты вне allowlist → 422. После пост-процессинга повторный скан: неизвестный bare-импорт → reject |
| Стили v1 | `styleContractVersion: 1`: CSS-переменные темы, inline-стили, utility-классы, уже попавшие в CSS приложения (shadcn-набор через `@source`). Произвольные новые Tailwind-классы не гарантированы; CSS-импорты отклоняются. v2 — per-version компиляция CSS |
| Конкурентность | `baseRev` **обязателен** для PUT/restore/publish/delete обоих ресурсов; проверка в той же транзакции; 409 несёт `currentRev`/`currentVersion?`. Publish дополнительно сериализуется `UNIQUE(…_id, rev)` на publish-таблицах (одна именованная версия на ревизию); все component-мутации проверяют `deleted_at IS NULL` в транзакции |
| Удаление | Компоненты: soft delete (`deleted_at`), revisions/publishes живут вечно, FK RESTRICT из пинов прототипов; `name` иммутабелен. Прототипы: hard delete с каскадом |
| Ошибки API | Единый envelope `{error:{code,message,issues?,warnings?,currentRev?,currentVersion?}}`; 422 = code `validation_failed` с `issues`; 405/413/415 обрабатываются; лимиты: doc ≤ 1 MB, source ≤ 256 KB; `Location` на 201; правило: path-id всегда == doc.id |
| Кэширование | Immutable (`public, max-age=31536000, immutable`) — **только** конкретные `/versions/:v`, `bundle.js` и шимы `/shims/v1/*`. Все списки, метаданные, draft и `/catalog/manifest` — `no-store` |
| Идентичность рантайма | На каждой prototype-ревизии сохраняется `builtin_catalog_hash` (hash отсортированных builtin-дефиниций + actions + Hotspot) — v1 информационно (read-models возвращают, клиент может предупредить о дрейфе); enforcement — v2. DTO draft/version несут `componentManifestHash` = hash отсортированных `(id, version, bundleHash)` |
| Список прототипов | Денормализованные поля списка (`name`, `description`, `device`, `screenCount`) обновляются из doc **в той же транзакции**, что и ревизия — единственное правило их согласованности |
| Seed | Ledger-таблица `seed_log(file_id, seeded_at)`: сидируется однажды, удаление не воскрешает; весь набор валидируется до транзакции, вставка атомарна. После bootstrap единственный source of truth — БД |
| Prod | `bun server/main.ts` с `SERVE_DIST=dist` (localhost) — SPA + fallback + `/api`; заменяет `vite preview` в e2e |
| Порты | vite :5173, storybook :6006, API dev :8787 (127.0.0.1), prod/preview :4173 (127.0.0.1); vite dev proxy `/api → 127.0.0.1:8787` |

## Схема БД (server/migrations.ts)

```sql
PRAGMA journal_mode = WAL;  PRAGMA foreign_keys = ON;

CREATE TABLE prototypes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, head_rev INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE prototype_revisions (
  prototype_id TEXT NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL, doc TEXT NOT NULL,
  builtin_catalog_hash TEXT NOT NULL, message TEXT, author TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY (prototype_id, rev));

CREATE TABLE prototype_revision_components (      -- пины на каждый save
  prototype_id TEXT NOT NULL, rev INTEGER NOT NULL,
  component_id TEXT NOT NULL, component_version INTEGER NOT NULL,
  PRIMARY KEY (prototype_id, rev, component_id),
  FOREIGN KEY (prototype_id, rev) REFERENCES prototype_revisions(prototype_id, rev) ON DELETE CASCADE,
  FOREIGN KEY (component_id, component_version)
    REFERENCES component_publishes(component_id, version) ON DELETE RESTRICT);

CREATE TABLE prototype_publishes (
  prototype_id TEXT NOT NULL REFERENCES prototypes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, rev INTEGER NOT NULL, message TEXT, published_at TEXT NOT NULL,
  PRIMARY KEY (prototype_id, version),
  UNIQUE (prototype_id, rev),
  FOREIGN KEY (prototype_id, rev) REFERENCES prototype_revisions(prototype_id, rev));

CREATE TABLE components (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,   -- name иммутабелен
  head_rev INTEGER NOT NULL, deleted_at TEXT,        -- soft delete
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE component_revisions (
  component_id TEXT NOT NULL REFERENCES components(id),
  rev INTEGER NOT NULL, source TEXT NOT NULL, message TEXT, author TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY (component_id, rev));

CREATE TABLE component_publishes (
  component_id TEXT NOT NULL REFERENCES components(id),
  version INTEGER NOT NULL, rev INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'staging',  -- staging | active | failed; видимы только active
  compiled_js TEXT NOT NULL, definition_meta TEXT NOT NULL, -- {events,slots,description,example?,propsJsonSchema?}
  source_hash TEXT NOT NULL, bundle_hash TEXT NOT NULL,     -- bundle_hash считается ПОСЛЕ rewrite
  host_abi_version INTEGER NOT NULL,
  message TEXT, published_at TEXT NOT NULL,
  PRIMARY KEY (component_id, version),
  UNIQUE (component_id, rev),
  FOREIGN KEY (component_id, rev) REFERENCES component_revisions(component_id, rev));

CREATE TABLE seed_log (file_id TEXT PRIMARY KEY, seeded_at TEXT NOT NULL);
```

Мутации — `db.transaction()` (sync); publish — двухфазный (§«Ключевые решения»). Published definition импортируется всегда из ревизии publish-строки, не из head.

## API (всё под /api, JSON; DTO фиксируются здесь и в docs/server-api.md до старта клиентских задач)

**Прототипы**
| Метод/путь | Запрос → Ответ |
|---|---|
| GET /prototypes | → `[{id,name,description,device,screenCount,headRev,latestVersion\|null,updatedAt}]` |
| POST /prototypes `{doc,message?}` | → 201 `{id,rev:1,warnings}` + Location |
| GET /prototypes/:id | → метаданные `{id,name,headRev,latestVersion,versions:[…],updatedAt}` |
| GET /prototypes/:id/draft | → `{doc, rev, builtinCatalogHash, componentManifestHash, components:[{id,name,version,bundleUrl,bundleHash}]}` (пины ревизии head) |
| PUT /prototypes/:id `{doc,message?,baseRev}` | → `{rev,warnings}`; 409 `{currentRev}` |
| DELETE /prototypes/:id `{baseRev}` | → 204 |
| GET /prototypes/:id/revisions?limit&before | → `[{rev,message,createdAt}]` |
| GET /prototypes/:id/revisions/:rev | → `{rev,doc,components,message,createdAt}` |
| POST /prototypes/:id/restore `{rev,baseRev}` | → `{rev}` (копия doc + пинов) |
| POST /prototypes/:id/publish `{message?,baseRev}` | → 201 `{version,rev}` |
| GET /prototypes/:id/versions | → `[{version,rev,publishedAt}]` (`no-store`) |
| GET /prototypes/:id/versions/:v | → `{version,rev,doc,builtinCatalogHash,componentManifestHash,components,publishedAt}` (immutable cache) |

**Компоненты** — симметрично (`source` вместо `doc`; `POST {id,name,source,message?}`, name `^[A-Z][A-Za-z0-9]*$`, уникален против builtin и таблицы) плюс:
- `POST /components/:id/publish {message?,baseRev}` → 201 `{version, hostAbiVersion}`;
- `GET /components/:id/versions/:v/bundle.js` → `text/javascript`, immutable;
- `DELETE /components/:id {baseRev}` → soft delete; published-прототипы и их пины продолжают работать, компонент исчезает из манифеста и не резолвится в новых save.

**Служебные**: `GET /catalog/manifest` (published кастомы без deleted: метаданные + bundleUrl + hostAbiVersion) · `GET /shims/v1/:name.js` · `GET /health` (ready только после миграций и seed).

**Контракт компонента.** Save (драфт): (1) `Bun.Transpiler` — синтаксис; (2) сабпроцесс-импорт с таймаутом — top-level исполнение изолировано; (3) контракт экспортов: named `definition` `{props: z.ZodType, events?: string[], slots?: string[], description: string, example?: Record<string, unknown>}` (metadata — строгий zod-чек; `example` при наличии валидируется через `definition.props`) + default — **plain function component** (без memo/forwardRef в v1). Publish дополнительно: `tsc --noEmit` над сгенерированной обёрткой с `satisfies CustomComponentModule<…>`; компиляция+пост-процессинг+скан импортов; render-smoke — **advisory**: в том же timeout-сабпроцессе `react-dom/server.renderToString` с `example`-props (нет `example` или SSR-небезопасный компонент → warning, не блок — v1-компоненты не обязаны быть SSR-safe); затем staging→active активация (см. пайплайн). Разрешённые импорты: ровно allowlist шимов (`react`, `react/jsx-runtime`, `react-dom`, `zod`, `@json-render/react` — типы).

**Сабпроцесс-контракт (`extract-subprocess`)**: результат — через временный JSON-файл (atomic rename), не stdout (авторский `console.log` не ломает протокол); строгая zod-схема результата + лимит размера; таймаут: TERM → grace → KILL process-group, ожидание exit, очистка temp; запуск с отключённым auto-install и минимальным env.

## Пайплайн бандла (publish компонента)

1. Контракт-чеки (§выше) + `NODE_ENV=production`; `Bun.build({entrypoints:[материализованный tsx], format:"esm", target:"browser", splitting:false, minify:true, sourcemap:"none", external:[allowlist]})`; >1 output → reject. (`sourcemap:"none"` в v1 — rewrite меняет длины спецификаторов и делает inline-map ложной; position-aware map — v2.)
2. **Пост-процессинг**: лексинг импортов выходного ESM через `es-module-lexer` — **прямая exact runtime-зависимость** (не транзитивная от vite); ошибка лексера → fail closed (reject), никакого фолбэк-парсера. Замена только specifier-токенов по таблице ABI; `react/jsx-dev-runtime` в output → reject.
3. Финальный скан: каждый импорт обязан быть **точно** из множества `/api/shims/v1/{react,react-dom,react-jsx-runtime,zod,json-render-react}.js` — всё прочее → reject 422. `bundle_hash` — от финального (переписанного) текста.
4. **Активация (закрытие blocker №2 раунда 2)**: транзакция 1 — CAS по head/`deleted_at` → insert publish со `status='staging'` (невидим для манифеста/пинов/bundle-роутов); in-process импорт ревизии; транзакция 2 — `staging→active` (ошибка импорта → `failed`, компилят остаётся для диагностики). Рестарт сервера: висящие `staging` помечаются `failed`.
5. Golden-тест на bun 1.3.14: фикстурный компонент → снапшот пост-процессенного бандла.

Шимы: **checked-in манифест экспортов ABI v1** (`server/shims/abi-v1.ts`: отсортированный allowlist named exports на каждый пакет + отдельная обработка `default`, все имена — валидные идентификаторы). На старте сервер сверяет манифест с реальными `Object.keys(mod)` установленных пакетов: расхождение → warning в лог (не падение), эмит строго по манифесту. Изменение манифеста/семантики = `/api/shims/v2/`. Browser-тест (e2e) импортирует каждый шим после инициализации shared object.

## Изменения по файлам

**Рефакторинг shared-графа (задача 1, без изменения поведения):**
- `src/prototype/validate.ts` — `validatePrototype(doc, options?: {definitions?})`, дефолт прежний.
- `src/catalog/definitions.ts` — импорт из `@json-render/shadcn/catalog`; `hotspotDefinition` → чистый `src/catalog/hotspot.definition.ts` (hotspot.tsx реэкспортирует); экспорт типа `ComponentDefinition`; кастомные дефиниции проходят ту же `normalizeDefinitions`.
- `src/catalog/runtime.ts`/`catalog.ts` — `createPlayerRuntime(deps, custom?)`: каталог+registry пересоздаются целиком по полному манифесту (снапшот-семантика defineCatalog/defineRegistry), проверка равенства множеств ключей definitions/components.

**Сервер (`server/`):** `main.ts` (Bun.serve, hostname 127.0.0.1), `db.ts`, `migrations.ts`, `repos/*`, `routes/{prototypes,components,shims}.ts`, `http.ts` (envelope, лимиты, 405/413/415), `validation.ts`, `components/{pipeline,compile,extract-subprocess}.ts`, `seed.ts`, `static.ts`, `tsconfig.json`, тесты (bun test: `:memory:` + fetch к `Bun.serve({port:0})`), фикстуры (валидный RatingStars c useState; битые: синтаксис/без definition/props не zod/лишний bare-импорт/CSS-импорт).

`static.ts` (критерии безопасности): decode URI c обработкой ошибок; `path.resolve` + containment-проверка внутри `SERVE_DIST`; запрет NUL/`\`; только GET/HEAD; SPA-fallback только при `Accept: text/html`; `/api/*` и отсутствующие ассеты (`.js`, `.css`, …) — никогда не index.html. Тесты: `..`, `%2e%2e`, double-encoding, `/api/unknown` → 404 JSON.

**Клиент:**
- `src/api/client.ts`, `src/api/hooks.ts` — типизированные обёртки (DTO из этого плана), `useApi` c AbortController + generation-token (поздний ответ старого запроса не перетирает новый).
- `src/prototype/loader.ts` — `loadPrototypeList()`, `loadPrototypeDraft(id)`, `loadPrototypeVersion(id, v)`; защитный `safeParse` ответов.
- `src/gallery/GalleryPage.tsx` — loading/error/ready; ссылки на draft и (при наличии) latest published.
- `src/app/routes.tsx` — новый маршрут `/p/:protoId/v/:version/s/:screenId`.
- `src/player/PlayerShell.tsx` + `src/player/navigation.tsx` (**единоличный владелец обоих — задача 5**) — гейт: загрузка `{doc, components}` → `loadCustomComponents` → только потом монтирование `LoadedPlayer` с key `${id}:${rev|v}:${sessionNonce}`; ошибка загрузки пинованного компонента = **экранная ошибка с диагностикой** (component/version). `navigation.tsx`: version-aware построение путей (`routeBase`/`buildPlayerPath()` — bootstrap-replace, navigate, restart строят URL внутри `/p/:id/v/:version/...` при published-входе); **семантика sessionNonce/stale-гейта/flowDepth не меняется**, существующие тесты navigation остаются зелёными.
- `src/customComponents/shared.ts` (`globalThis.__easyUiShared`), `src/customComponents/loader.ts` — `import(/* @vite-ignore */ bundleUrl)`, только same-origin `/api/...`, проверка MIME и контракта экспортов; кэш по bundleUrl.
- `vite.config.ts` — proxy `/api → http://127.0.0.1:8787`.

**Инфраструктура:** `package.json` — `server:dev`/`server:test`/`server:typecheck`/`serve` (+preflight bun), verify дополнить; deps: `es-module-lexer` exact (**runtime**); devDeps: `@types/bun` exact. Сервер требует полный `npm install` (dev-deps: typescript для publish-тайпчека) — документируется; это workspace-инструмент, не деплоймент. `.bun-version`; `.gitignore` += `data/`, `.e2e-data/`. `playwright.config.ts`: **`reuseExistingServer: false` для обоих stateful-серверов**, выделенные e2e-порты (не 8787/4173), `DATA_DIR=.e2e-data/{dev,preview}` с очисткой перед run, build-precondition для preview, URL строго `127.0.0.1` (не `localhost` — IPv6). `CLAUDE.md`: команды, bun-политика. `docs/server-api.md`: DTO, error envelope, контракт компонента, styleContractVersion 1, граница доверия, требование полного npm install.

## Смежный план (flow-persist) — аддендум

Исполняется **после** этого плана; в его файл добавлен аддендум: (1) persist-ключ и baseline включают `rev`/`version` прототипа + hash манифеста компонентов; (2) share-ссылка на published-версию пинует `version` в пути; (3) reserved-path guard — общий predicate `isReservedStatePointer()` вместо сравнения массивов разного формата; (4) эффект очистки по смене sessionNonce пропускает первый mount.

## Риски

- **Bun.serve/Bun.build поведенческие сюрпризы** → спайки на живом bun 1.3.14 первым шагом задач 2–3; golden-тест пост-процессинга.
- **Dual React / invalid hook call** → обязательная e2e-фикстура кастомного компонента с `useState`.
- **Сабпроцесс-экстракция дефиниций** — новый механизм → юниты: таймаут, битый код, чистый выход; контракт данных сабпроцесс→сервер = JSON metadata (zod-объект живёт только в in-process импортах published).
- **Async-рефакторинг loader** — владельцы всех потребителей в одной задаче; grep по `prototype/loader`.
- **Память in-process импортов** — ограничена числом publishes (осознанно принято).

## Задачи (Codex --fresh --write --effort medium; волны 1 → 2 → (3 ∥ 4) → 5 → 6)

1. **Shared-граф + параметризация валидатора.** Файлы: раздел «Рефакторинг» + тесты. Done: `npm run verify` зелёный; юнит `validatePrototype(doc,{definitions})` с кастомной дефиницией; smoke №1: builtin-цепочка definitions→validate без react в графе; smoke №2 (отдельный): импорт фикстурного кастомного TSX под bun с production deps.
2. **Bun-сервер: ядро, БД, API прототипов, seed, статика.** Файлы: `server/` (кроме components/*), package.json, .gitignore, `.bun-version`. Done: `bun test server` зелёный; сценарий: seed (ledger; повторный старт не воскрешает удалённое) → save (422 битый doc; 409 без/с неверным baseRev с currentRev; денормализация списка в той же транзакции) → revisions (pagination) → restore → publish (UNIQUE(prototype_id,rev): повторный publish той же ревизии → 409) → versions (список `no-store`, `/versions/:v` immutable); static-тесты traversal/encoding/`/api/unknown`; сервер слушает 127.0.0.1; `builtin_catalog_hash` пишется и отдаётся.
3. **Пайплайн компонентов.** Файлы: `server/components/*`, `server/shims/abi-v1.ts`, `routes/{components,shims}.ts`, `validation.ts`, фикстуры. Done: все битые фикстуры → 422 с диагностикой, сервер жив (включая таймаут сабпроцесса на `while(true)` и `console.log`-загрязнение — результат через temp-файл); bundle.js после пост-процессинга содержит **только** `/api/shims/v1/...`-импорты (golden-тест, bundle_hash от финального текста); **staging→active**: между транзакциями манифест не видит компонент, failed-импорт → status failed, рестарт добивает висящие staging; линеаризация пинов покрыта конкурентным тестом save ∥ publish; повторный publish компонента не меняет существующие ревизии прототипов; `example` валидируется через props, render-smoke advisory в сабпроцессе.
4. **Клиентский data-layer.** Файлы: `src/api/*`, `src/prototype/loader.ts`, `src/gallery/GalleryPage.tsx`(+test), `src/app/routes.tsx`, `vite.config.ts`. **PlayerShell и navigation.tsx не трогать.** Done: test+typecheck зелёные; generation-token покрыт тестом (поздний старый ответ отбрасывается); grep: синхронный `prototypes` не используется.
5. **Плеер: async-гейт, version-aware навигация, кастомный рантайм.** Файлы: `src/player/PlayerShell.tsx`(+test), `src/player/navigation.tsx`(+tests), `src/customComponents/*`(+test). Done: draft и `/v/:version` маршруты работают; **published bootstrap → navigate → restart → back сохраняют `/v/:version`** (новые тесты navigation); все существующие navigation/PlayerShell-тесты зелёные без ослабления; key включает rev/version + componentManifestHash; ошибка пинованного бандла → экранная диагностика; прототип с published RatingStars (useState) рендерится, эмитит событие.
6. **Топология, e2e, доки.** Файлы: `playwright.config.ts`, `e2e/dev/api.spec.ts`, `e2e/dev/custom-component.spec.ts`, preview на bun, `package.json` (verify), `CLAUDE.md`, `docs/server-api.md`. Done: `npm run verify` + `npm run e2e` зелёные; `reuseExistingServer:false`, выделенные порты, изолированные DATA_DIR с очисткой, URL по 127.0.0.1; e2e-шаг: импорт каждого шима `/api/shims/v1/*` в браузере после инициализации shared; runtime-прогон `/verify`.

## Верификация (финальная)

`npm run verify` (+server:typecheck, bun test) → `npm run e2e` → `/verify`-скилл: галерея с сервера; флоу checkout/settings; POST компонента → publish → прототип с ним (draft и published маршруты) рендерится, hook работает; битый компонент → 422; удаление компонента не ломает published-прототип.

## 12. Триаж ревью (раунд 1: 26 находок, 4 blocker)

**Приняты полностью** (внесены в v2): №2 пины на каждый save + join-таблицы; №3 read-models draft/version + маршрут плеера; №4 пост-процессинг как основной механизм; №5 shim ABI v1 + форс production JSX + статические экспорты; №6 нормализация связей, soft delete, иммутабельный name; №7 hashes + hostAbiVersion в publishes (rev уже был в v1); №8 двухфазный publish вне sync-транзакции; №9 обязательный baseRev на всех мутациях; №11 один артефакт, запрет relative/dynamic/CSS-импортов; №12 единый envelope, лимиты, pagination, cache policy; №13 security-критерии static.ts; №14 снапшот-семантика catalog/registry; №15 экранная ошибка вместо тихой деградации; №16 AbortController/generation-token/key с rev; №19 seed ledger; №20 изоляция e2e-данных; №21 PlayerShell → единоличный владелец задача 5, DTO зафиксированы в плане; №22 bun-политика (инсталлер, пин, no auto-install); №23 styleContractVersion; №24 точный синтаксис `@vite-ignore` + same-origin/MIME; №26 два smoke-критерия.

**Приняты частично**:
- №1 (RCE/auth) — принято: bind 127.0.0.1, сабпроцесс с таймаутом для драфтов, in-process только published, документированная граница доверия. Отклонено: полный auth (решение пользователя: single-user workspace за аутентифицированным coder-proxy) и декларативный JSON-DSL для props (ломает zod-контракт и паритет с builtin-каталогом; кандидат в v2).
- №10 (типовая проверка) — принято: tsc `--noEmit` + `satisfies`-обёртка и render-smoke на **publish**; plain function component only. Отклонено: полный чек на каждый save (стоимость/латентность save в редакторе; save-чек ловит синтаксис/контракт, типы — на publish-гейте).
- №25 (рост module cache) — принято: сабпроцесс для драфтов. Для published рост ограничен числом publishes — осознанно принято без worker-изоляции.
- №17–18 (смежный flow-persist план) — приняты как аддендум к его файлу; исполняется после этого плана.

**Отклонено**: только части №1 и №10, зафиксированные выше, с обоснованиями.

## 13. Триаж ревью (раунд 2: 14 находок, 2 blocker; вердикт — «после двух блокеров архитектурных возражений нет»)

**Blocker №1 (version-aware навигация)** — принят: `navigation.tsx` входит во владение задачи 5, `routeBase`/`buildPlayerPath()`, семантика nonce/stale/flowDepth неизменна, тесты published-цикла.
**Blocker №2 (атомарная активация publish)** — принят: `status staging|active|failed`, двухтранзакционная активация, видимость только active, добивание staging на рестарте.
**Приняты (major/minor)**: №3 линеаризация пинов (фиксация набора до валидации, без повторного резолва в транзакции, конкурентный тест); №4 `UNIQUE(…_id, rev)` на publish-таблицах + проверка `deleted_at` во всех component-транзакциях; №5 checked-in ABI-манифест шимов + сверка на старте + browser-тест; №6 `es-module-lexer` — прямая exact runtime-зависимость, fail closed без фолбэка, `sourcemap:"none"` в v1, `bundle_hash` после rewrite, скан на точное множество shim-URL; №7 `example?` в контракте (валидация через props), render-smoke advisory в timeout-сабпроцессе, SSR-safety не требуется; №8 immutable-кэш только на `/versions/:v`+bundle+shims, списки/манифест `no-store`; №9 `builtin_catalog_hash` на ревизии (v1 информационно, enforcement — v2); №10 `es-module-lexer` в runtime deps, typescript остаётся devDep с документированным требованием полного npm install (workspace-инструмент); №11 сабпроцесс-IPC через temp-файл + строгая схема + TERM→KILL process-group; №12 `reuseExistingServer:false`, выделенные e2e-порты, 127.0.0.1 в URL; №13 `componentManifestHash` (+`builtinCatalogHash`) в DTO draft/version — сортированный канонический hash считает сервер; №14 правило денормализации списка в той же транзакции, path-id == doc.id, `currentVersion?` в envelope.
**Отклонений в раунде 2 нет** (в №9 enforcement отложен в v2 осознанно — информационная выдача принята).
