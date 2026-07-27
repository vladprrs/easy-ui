# План: реализация фидбэка «Easy UI — предложения по развитию продукта v2»

Дата: 2026-07-27 · Ревизия: v2 (после двух адверсариальных ревью)
Источник: `docs/easy-ui-product-improvements-v2.md`

## Цель

Сделать архитектуру экрана видимой и проверяемой, дать переиспользуемую композицию как first-class ресурс и свести доказательство готовности в один воспроизводимый отчёт.

## Принципы (жёсткие инварианты)

1. **Сначала лекарство, потом диагноз.** Ни один архитектурный gate не становится блокирующим раньше, чем появится поддерживаемая альтернатива (Composition) и проставлены метаданные.
2. **Warn-only по умолчанию.** `validatePrototype` никогда не превращает новые архитектурные правила в 422 на save. Readiness публикуется как отчёт с `blocking: []` по умолчанию.
3. **Аддитивность.** Новые поля опциональны; отсутствие поля не даёт issue. Существующие 99 компонентов и 27 прототипов прода сохраняются/публикуются без изменений.
4. **Строгие схемы правятся комплектом.** Любое новое поле definition требует одновременной правки: `server/components/types.ts`, `server/components/extract-subprocess.ts` (strictObject в дочернем процессе + `metaSchema`/`resultSchema`), `server/components/pipeline.ts` (`definitionMeta`), `server/contracts.ts` (`definition_meta` strictObject, ~:137), `src/catalog/normalize.ts`, `src/customComponents/loader.ts` (allowlist копирования полей!), `scripts/generate-openapi.ts` → `server/openapi.json`.
5. **Каждая волна с новым endpoint'ом** обязана обновить `server/contracts.ts` + перегенерировать `server/openapi.json` (иначе `npm run verify` красный на `contract.test.ts`).
6. Миграции нумеруются **по порядку слияния**, а не по номеру волны. Текущий head — v15.

---

## Триаж ревью (принято/отклонено)

| Находка ревью | Решение |
|---|---|
| B1 `loader.ts` теряет новые поля definition → lint инертен в редакторе | **Принято**: allowlist `src/customComponents/loader.ts` — в зону владения волны 2 + тест |
| B2 `arch/canonical-bypass` невычислимо внутри `validatePrototype` | **Принято**: правило удалено из lint; canonical/replacement сурфейсится в библиотеке (волна 3) и в readiness-гейте `deprecated` |
| B3 раскрытие композиций после pin-фазы теряет pins компонентов/ассетов | **Принято**: сбор ссылок и раскрытие переносится в save-путь, до `snapshotDefinitions`/`collectAndValidateAssetRefs` и до проверки в `publish()` |
| B4 регионы анализируются по authored-спеке | **Принято**: в v1 композиции **не могут** нести `region`; `analyzeScreenRegions` продолжает работать по authored-спеке, `@eui/Composition` трактуется как обычный элемент |
| B5 named slots на host-primitive отвергаются валидатором и `toRuntimeSpec` | **Принято**: волна 5 расширяет slot-проверку (`validate.ts:340`) и `isCustom`-гейт (`runtimeSpec.ts:237`) на `@eui/Composition`, тесты в `server/named-slots.test.ts` |
| M1 OpenAPI drift в каждой волне | **Принято**: см. принцип 5 |
| M2/m1 нумерация миграций | **Принято**: по порядку слияния; `migrations.test.ts` — обновить только `user_version === 15`, **не трогать** `toBe(12)` в partial-rollback кейсе |
| M3 гейт `routes` невыполним без `SERVE_DIST` | **Принято**: гейт считается из `classifyRevision` (document+bundles), route-готовность выносится в отдельный информационный подпункт |
| M4 два конкурирующих механизма конфигурации гейтов | **Принято**: один глобальный конфиг (`EASYUI_PUBLISH_GATES`, default пусто), колонка `publish_gates` не заводится |
| M5 readiness нельзя считать внутри `PrototypeRepo.publish` (sync-транзакция) | **Принято**: readiness считается в роут-ветке до `repo.publish`; TOCTOU снимается сверкой `rev` в отчёте с `baseRev` публикации |
| M6 конфликт владения `src/library/` между волнами | **Принято**: библиотеку целиком владеет волна 3; волна 5 добавляет только новый файл-раздел |
| M7 регрессия по warnings, а не по 422 | **Принято**: критерий — `scripts/validate-templates.ts` и фикстуры без новых warning'ов |
| M8/B3(2) strictObject в трёх местах | **Принято**: принцип 4 |
| Ревью-2 B1: 96/124 прод-экранов упадут в `arch/root-not-allowed` | **Принято**: правила смотрят только на **явно объявленный** scope; вывод из `atomicLevel` используется лишь для отображения, не для lint. Плюс волна 0 (`kind`) как ось исключений |
| Ревью-2 B2: publish сегодня не валидирует документ | **Принято**: readiness — report-only, `blocking: []` по умолчанию, обязательный dry-run по всем прод-прототипам перед включением любого гейта |
| Ревью-2 M1: 100vh-скан ловит канонические `yp-screen`/`yp-panel` | **Принято**: скан только при `sourceBounded === true` |
| Ревью-2 M3: `/repin` избыточен | **Частично**: реализуем как тонкую обёртку над re-save головного документа + `?dryRun` diff (ценность §5 «repin compatible heads» сохраняется, параллельного pin-writer'а нет) |
| Ревью-2 M4: 410 и `DELETE` без `baseRev` — breaking | **Принято**: bare `GET` остаётся 404; tombstone только под `?includeDeleted=1`; `DELETE` сохраняет `baseRev`, новые поля опциональны |
| Ревью-2 M5: префикс ключей композиции ломает geometry/scenarios | **Принято**: ключи вида `<hostKey>$<inner>`; контракт зафиксирован в `docs/prototype-format.md`; коллизии исключены по построению (символ `$` запрещён в авторских ключах) |
| Ревью-2: cut recorder-UI/replay-job/perceptual hash/новый CLI/`publish_gates`/co-occurrence | **Принято** кроме recorder-UI: минимальный рекордер кликов остаётся (это суть §7), но серверный headless-replay и таблица runs — вырезаны |
| Ревью-2: дубли с существующими lint'ами `validate.ts:484/493` | **Принято**: существующий monolithic-screen lint **расширяется** (учёт `@eui/FlowRoot`-обёртки), новый параллельный не заводится |
| Ревью-2: нет backfill метаданных | **Принято**: волна 2 включает backfill-скрипт для yandex-pay |
| Ревью-2: нет acceptance-теста мотивирующего кейса | **Принято**: см. «Acceptance» |
| Ревью-2: Этап 2.2 «screen/composition templates» отсутствует | **Принято**: покрывается волной 5 (композиция, созданная из существующего экрана — «extract composition») |

Отклонено: перенос Composition строго перед Inspector (Inspector дешевле и даёт немедленную ценность; Composition идёт сразу после метаданных и до включения любых гейтов).

---

## Волна 0 — Prototype lifecycle (фидбэк §11)

**Миграция v16**: `prototypes.kind TEXT NOT NULL DEFAULT 'product-flow'`, `prototypes.tags TEXT` (JSON-массив), `prototypes.derived_from TEXT`. Значения `kind`: `product-flow | composition-fixture | component-gallery | evidence | visual-reference | experiment`. Существующие строки → `product-flow` (галерея не пустеет).

- API: `kind`/`tags`/`derivedFrom` в `PrototypeSummary`/`PrototypeMeta`, приём в `POST /api/prototypes` и `PUT /api/prototypes/:id` (или отдельный `POST /api/prototypes/:id/lifecycle`), фильтр `GET /api/prototypes?kind=`.
- Галерея: чипы фильтра по kind; служебные виды (`composition-fixture`, `evidence`, `visual-reference`, `component-gallery`) скрыты из основной витрины за табом «Служебные»; строка «derived from» на карточке.
- Зачем первым: `kind` — основная ось исключений для архитектурных правил (галерея из 49 экранов и evidence-прототипы легитимно одноэлементные).

Файлы: `server/migrations.ts`, `server/migrations.test.ts`, `server/repos/prototypes.ts`, `server/routes/prototypes.ts`, `server/contracts.ts`, `server/openapi.json`, `src/api/client.ts`, `src/gallery/*`, `docs/server-api.md`.

---

## Волна 1 — Component Tree Inspector (фидбэк §3, этап 1.1)

Только чтение, нулевой риск миграций, немедленная ценность.

- `src/architecture/screenTree.ts` (new): `buildScreenArchitectureTree(screen, { definitions, pins, manifest, issues })` → узлы с `key/type/depth/children/region/slot/scope/atomicLevel/source/version/status/canonicalFor/sourceBounded/replacement/propsDiff/issues`.
  `propsDiff` — «отличается от объявленного дефолта» (`src/catalog/zodIntrospect.ts`), формулировка в UI именно такая (Renderer zod-дефолты не применяет).
- Редактор: `src/editor/ComponentTreeInspector.tsx` заменяет `ElementTree` в `InspectorPanel.tsx:123` (сохранив API `{spec, selectedKey, onSelect}`), добавляя бейджи scope/версии/статуса, маркер issue и раскрываемую детализацию узла.
- Плеер: расширяем **существующий** debug-инспектор (`src/player/inspector/`, тумблер `ScreenView.tsx:247`) новой вкладкой «Дерево»; наведение/выбор узла подсвечивает DOM по `data-eui-key` (механика `MisclickHighlightSurface`, `ScreenSurface.tsx:63`); клик по экрану в режиме инспекции выбирает ближайший `[data-eui-key]` и его узел; в подписи — фактический `getBoundingClientRect`.

Файлы: `src/architecture/*` (new), `src/editor/ComponentTreeInspector.tsx` (new), `src/editor/InspectorPanel.tsx`, `src/player/inspector/*`, `src/player/ScreenSurface.tsx`, `src/app/strings/*`, тесты + e2e.

---

## Волна 2 — Architecture metadata, backfill, recursive lint (фидбэк §2)

### 2.1 Метаданные (принцип 4 — один коммит, семь файлов)

```ts
scope?: "primitive" | "section" | "shell" | "screen";
allowedAsRoot?: boolean;
canonicalFor?: string[];               // slug-роли: "ctyp-success-navbar"
sourceBounded?: boolean;
ownership?: { reason: string; provenance?: string };
replacement?: string;
```

`src/designSystems/scope.ts`: `COMPONENT_SCOPES`, `scopeRank`, `inferScopeFromAtomicLevel(level)` — **только для отображения** в инспекторе/библиотеке; lint использует исключительно явный `scope`.

### 2.2 Backfill

`scripts/backfill-component-scope.ts` — по каталогу design system проставляет `scope` в исходниках компонентов через API (revision + publish) по правилу atomicLevel→scope с ручным списком исключений (`yp-screen`, `yp-panel`, `yp-app-home-shell`, `yp-scroll-area` → `shell`). Запускается вручную против прода после деплоя; в CI — dry-run отчёт.

### 2.3 Lint

`src/prototype/architectureLints.ts`, вызывается из `validatePrototype` рядом с `lintPrototypeLayouts` (`validate.ts:528`), получает `{ kind }` прототипа (передаётся сервером в `options`) и `doc.architecture.exemptions`.

| id | Условие (срабатывает только при **явном** `scope`) |
|---|---|
| `arch/monolith-root` | root экрана — или единственный ребёнок `@eui/FlowRoot` — custom-компонент со `scope ∈ {section, shell, screen}` без children и без заполненных slots. Реализуется **расширением** существующего lint'а `validate.ts:493-501` (учёт FlowRoot-обёртки), а не вторым правилом |
| `arch/root-not-allowed` | элемент в позиции root, чей definition имеет `allowedAsRoot === false` (явно) |
| `arch/screen-scope-nested` | компонент со `scope: "screen"` использован не как root экрана |
| `arch/region-owns-page` | элемент региона содержит компонент со `scope ∈ {shell, screen}` (структурное правило, без процентных порогов) |
| `arch/ownership-unexplained` | custom-компонент со `scope ∈ {shell, screen}` без `ownership.reason` |
| `arch/bounded-as-owner` | компонент с `sourceBounded: true` использован как root экрана или владелец региона |

Правила не применяются, если `kind ∈ {component-gallery, evidence, visual-reference, composition-fixture}`.

Исключения — аддитивное поле `architecture.exemptions` в `src/prototype/schema.ts` (обе схемы: `inputPrototypeDocSchema` strict и `storedPrototypeDocSchema`), лимит 200, `reason` ≥ 8 символов. Сработавшее исключение снимает issue и попадает в readiness как `exempted`. Обновить `server/contracts.ts`, `server/openapi.json`, `docs/prototype-format.md`, `revisionDiff`.

### 2.4 Publish-time проверки компонента (warn-only)

В `publishComponent` (`server/routes/components.ts:40`): `scope: "screen"|"shell"` без `ownership.reason` → warning; `replacement` на несуществующий компонент → warning; screen-geometry скан исходника (`h-screen`, `min-h-screen`, `100vh`, `100dvh`, `fixed inset-0`) **только при `sourceBounded === true`** → warning.

---

## Волна 3 — Usage graph, tombstones, catalog discovery (фидбэк §4, §5)

### 3.1 Usage graph (без миграции)

- `server/usageGraph.ts`: `componentUsages(db, componentId)` → `{ currentHeadUsages: [{prototypeId, name, kind, rev, screens:[{screenId, elementKeys}]}], immutableUsages: [{prototypeId, version, componentVersion}], versionsInUse, safeToRemove }`. Источник: `prototype_revision_components` + разбор `doc` головных ревизий.
- `GET /api/components/:id/usages` (+ `?format=tree`).
- `GET /api/catalog/usages?designSystem=` — агрегированный индекс с кэшем, ключ инвалидации `MAX(prototypes.updated_at)`.

### 3.2 Tombstones и безопасное удаление

- **Миграция v17**: `components.delete_reason TEXT`, `components.replacement_component_id TEXT`. Обычный `ALTER TABLE ADD COLUMN` — перестройка таблиц по паттерну v8 не требуется.
- `GET /api/components?includeDeleted=1` и `GET /api/components/:id?includeDeleted=1` возвращают tombstone `{deleted:true, deletedAt, reason, replacement}`; **bare GET по-прежнему 404** (совместимость с `driver.mjs` и `src/api/client.ts`).
- `DELETE /api/components/:id` сохраняет обязательный `baseRev`; принимает опциональные `reason`/`replacement`; при `currentHeadUsages.length > 0` — 409 `component_in_use` (обход: `force: true`, только admin — по образцу существующей admin-проверки на `routes/components.ts:74`).
- `POST /api/prototypes/:id/repin` — тонкая обёртка над re-save головного документа (переиспользует `updatePrototypeFromDoc`), `?dryRun=1` возвращает diff пинов без записи.

### 3.3 Библиотека (владеет всем `src/library/`)

- Манифест каталога дополняется `scope`, `canonicalFor`, `sourceBounded`, `replacement`, `deprecated`, `headUsageCount` (кэш по `MAX(prototypes.updated_at)`).
- Поиск по product job: токенизация запроса, матчинг по имени + description + `canonicalFor` + scope + atomicLevel; ранжирование: точное совпадение роли > имя > описание. RU/EN — без словаря синонимов, матчинг по подстрокам токенов.
- Бейдж `canonical` (компонент объявляет `canonicalFor`), бейдж `deprecated → replacement` со ссылкой.
- Блок «Используется в head» (счётчик + список), «Показать usages» (дерево путей), «Похожие компоненты» (тот же `canonicalFor` либо тот же scope + пересечение токенов имени).
- `/library/c/:id`: вкладка «Usages», блок provenance рядом с активным исходником.

Отклонено из §4: «рекомендованная композиция» через co-occurrence-майнинг (n=27 статистически бессмысленно) — вместо этого раздел «Композиции» появляется в волне 5 и показывает, где компонент используется в композициях.

---

## Волна 4 — Ready-to-publish report (фидбэк §6)

`GET /api/prototypes/:id/readiness` → отчёт с `rev` и гейтами:

| gate | Источник | Может ли быть blocking по умолчанию |
|---|---|---|
| `architecture` | `validatePrototype` (arch-issues + exempted) | нет |
| `schema` | `validatePrototype.errors` | нет (но save и так их не пускает) |
| `screens` | `classifyRevision` — документ + бандлы по всем экранам | нет |
| `assets` | `prototype_revision_assets` + наличие в реестре | нет |
| `pins` | `bundleReadiness` + статусы публикаций | нет |
| `deprecated` | пины со статусом `deprecated`/`superseded` + `replacement` | нет |
| `visual` | последние `visual_baseline_sets`/runs (читает, не запускает) | нет |
| `capture` | последний screenshot-job по экрану, если есть; иначе `unknown` | нет |
| `interactions` | сценарии волны 6; при отсутствии — `unknown` | нет |
| `publishDiff` | наличие diff против последней версии | нет |

Семантика статусов: `pass | warn | fail | unknown`. `unknown` — данных нет (например, capture не запускался); `unknown` **никогда** не блокирует.

- Конфиг: единственный глобальный `EASYUI_PUBLISH_GATES` (CSV id гейтов), по умолчанию **пусто** → `blocking: []`, `publishable: true`.
- `POST /api/prototypes/:id/publish` считает readiness в роут-ветке (`routes/prototypes.ts:137`) **до** `repo.publish`, сверяет `report.rev === baseRev`; при непустом `blocking` → 409 `publish_blocked` с отчётом; `force: true` (владелец/админ) обходит с записью в `audit_events`.
- UI: панель «Готовность к публикации» в редакторе и в диалоге публикации галереи, со ссылками на проблемный экран/элемент.
- Обязательный dry-run: `scripts/readiness-dryrun.ts` прогоняет отчёт по всем прототипам локальной копии прод-данных и печатает сводку — до включения любого гейта.

---

## Волна 5 — Versioned Composition (фидбэк §1, этап 2.1/2.2)

### 5.1 Ресурс

**Миграция v18**: `compositions`, `composition_revisions`, `composition_publishes` (зеркало компонентных таблиц: `head_rev`, статусы, `source_hash`, `deleted_at`), `prototype_revision_compositions` (pins, FK RESTRICT на `composition_publishes`).

Документ (`src/prototype/composition.ts`, zod, версия 1):

```ts
{
  version: 1, name, description,
  params: Record<slug, { type: "string"|"number"|"boolean"|"json"|"asset";
                          required?: boolean; default?: JsonValue }>,
  slots: slug[],
  spec: Spec,          // элементы; значения props могут быть {"$param":"amount"}
  provenance?: { source?: string; figmaNodeId?: string }
}
```

Ограничения v1 (фиксируются в `docs/prototype-format.md`):
- композиции **не содержат** `region`-маркеров и `@eui/FlowRoot`;
- **не вкладываются** друг в друга (`@eui/Composition` внутри композиции запрещён);
- события внутри композиции работают как в обычном экране (`on` + действия), state-байндинги адресуют `doc.state` прототипа-хоста — параметры не подменяют указатели state, а только props;
- `@eui/Slot` (host-primitive, только внутри композиции) отмечает точку вставки детей.

### 5.2 Раскрытие — в save-пути, не в рантайме

`expandCompositions(doc, { compositions })` (`src/prototype/composition.ts`) возвращает раскрытый документ. Порядок в `server/routes/prototypes.ts`:

1. загрузить пины/головы композиций → раскрыть;
2. `collectAndValidateAssetRefs` и `snapshotDefinitions` работают по **раскрытому** документу → пины компонентов и ассетов полны (снимает B3);
3. `validatePrototype` валидирует раскрытый документ, но пути issue'ов мапятся обратно на `<hostKey>$<inner>`;
4. в БД сохраняется **авторский** документ (с `@eui/Composition`), пины — от раскрытого;
5. `PrototypeRepo.publish` проверяет пины по раскрытому набору типов.

Клиент раскрывает тот же документ перед `toRuntimeSpec`; `analyzeScreenRegions` продолжает работать по авторской спеке (B4: композиции регионов не несут).

Ключи: `<hostKey>$<innerKey>`; символ `$` запрещён в авторских ключах (валидатор). Метаданные узла получают `compositionRef`, чтобы дерево волны 1 показывало композицию как раскрываемый узел.

### 5.3 Named slots

`validate.ts:340` и `runtimeSpec.ts:237` расширяются: `@eui/Composition` — допустимый slot-родитель, список слотов берётся из документа композиции (снимает B5). Тесты — `server/named-slots.test.ts`.

### 5.4 API/UI

- `GET/POST /api/compositions`, `GET/PUT/DELETE /api/compositions/:id`, `/revisions`, `/publish`, `/versions`, `/versions/:v` (+ contracts + openapi).
- Библиотека: раздел «Композиции» (слоты, параметры, где используется).
- Редактор: вставка композиции, редактирование параметров, наполнение слотов; действие **«Извлечь композицию из экрана»** (покрывает «screen/composition templates» этапа 2.2).

---

## Волна 6 — Scenarios: recorder + client replay (фидбэк §7, урезано)

- **Миграция v19**: `prototype_scenarios(prototype_id, id, name, steps_json, author, created_at, updated_at)`. Таблица runs и серверный headless-replay — **вырезаны**.
- Схема шага (`src/prototype/scenario.ts`): `click{elementKey,label?}`, `expectScreen{screenId}`, `expectText{text}`, `setState{pointer,value}`, `expectState{pointer,value}`, `expectDisabled{elementKey}`.
- Рекордер: режим записи в плеере — перехват кликов по `[data-eui-key]` и навигаций, панель шагов, добавление expectation, сохранение сценария.
- Раннер: `src/player/scenarioRunner.ts` — чистая функция поверх `EasyUiActionRuntime` (без DOM), работает для draft и для immutable version; UI-прогон с подсветкой шага.
- Гейт `interactions` в readiness — информационный (`unknown`/`warn`/`pass`), никогда не blocking.
- Ключи шагов версионируются вместе с `rev`; при расхождении ключей шаг помечается `stale`, а не падает.

---

## Волна 7 — P1: контракт скриншотов, CLI-верби, SDK, Asset Workbench

### 7.1 Screenshot/geometry contract (§8)

- Результат job: `imageProduced`, `captureClean`, `runtimeWarnings[]`; `consoleErrors` разделяются на `productErrors` и `infraNoise` (allowlist: favicon, расширения, `ERR_NETWORK_CHANGED`, `ResizeObserver loop`).
- `.claude/skills/author/driver.mjs` (единственный рабочий CLI; `.claude/skills/deploy/driver.mjs` не трогаем): `snap` → exit `0` при созданном PNG без product-ошибок, `2` при PNG + product-ошибках, `1` если PNG не создан; retry (2 попытки) на infra-ошибке/таймауте. Обновить `server/driver-cli.test.ts` и `.claude/skills/{author,verify,yp-prototype}/SKILL.md`.
- Geometry: `safeArea`, `viewportOwnership`, отдельные rect'ы `panel`/`frame`/`region` + `issues[]` (clipping/overlap/footer ownership).

### 7.2 CLI-верби (§10)

Расширение того же `driver.mjs`: `publish <id> --verify`, `readiness <id>`, `usages <component>`, `audit --design-system <ds>`, `--all-screens` для `status`/`snap`, `--json`. Один логин на батч, retry/backoff. Отдельный `server/cli/easyui.ts` — **отклонён** (две авторизации, дублирование).

### 7.3 Typed authoring SDK (§12)

`scripts/generate-sdk.ts` → `sdk/catalog.d.ts` + `sdk/builders.ts` (`component()`, `composition()`, `screen.flowRoot()`), генерация из `GET /api/catalog/manifest` + JSON-схем пропсов; проверка дрейфа по образцу `verify:openapi`.

### 7.4 Asset Workbench (§9, урезано)

Страница `/assets`: превью-сетка, dimensions/MIME/alpha/`naturalWidth`, usage graph (`GET /api/assets/:id/usage` уже есть), точные дубликаты (content-addressing даёт бесплатно), предупреждение «растровый ассет при наличии SVG того же имени». Перцептивный хеш и `asset_meta` — **вырезаны**.

---

## Порядок, владение файлами, миграции

| Волна | Зона владения | Миграция |
|---|---|---|
| 0 lifecycle | `server/{migrations,repos/prototypes,routes/prototypes,contracts}.ts`, `src/gallery/*`, `src/api/client.ts` | **v16** |
| 1 inspector | `src/architecture/*`, `src/editor/*`, `src/player/inspector/*`, `src/player/ScreenSurface.tsx` | — |
| 2 metadata+lint | `src/designSystems/*`, `src/catalog/normalize.ts`, `src/customComponents/loader.ts`, `src/prototype/{schema,validate,architectureLints}.ts`, `server/components/*`, `server/routes/components.ts`, `scripts/backfill-*` | — |
| 3 usage+catalog | `server/usageGraph.ts`, `server/repos/components.ts`, `server/routes/components.ts`, `src/library/*` | **v17** |
| 4 readiness | `server/readiness.ts`, `server/routes/prototypes.ts`, `src/editor/ReadinessPanel.tsx`, `src/gallery/*` (диалог) | — |
| 5 composition | `src/prototype/composition.ts`, `src/prototype/{schema,validate,runtimeSpec}.ts`, `server/routes/compositions.ts`, `server/repos/compositions.ts`, `src/library/CompositionsSection.tsx`, `src/editor/*` | **v18** |
| 6 scenarios | `src/prototype/scenario.ts`, `src/player/scenario*`, `server/routes/scenarios.ts` | **v19** |
| 7 P1 | `.claude/skills/author/driver.mjs`, `server/screenshot/*`, `src/capture/geometry.mjs`, `scripts/generate-sdk.ts`, `src/assets/*` | — |

Волны 0–2 последовательны (общие файлы схемы/контрактов). 3 и 4 могут идти параллельно (разные зоны), 5 после 2, 6 после 5, 7 независима.

## Acceptance (продуктовые критерии, не только зелёный CI)

1. Экран формы `YpCtypMagnitPaymentSuccess` (single custom organism под `@eui/FlowRoot`, `scope: "screen"`) **флагается** lint'ом волны 2 и виден как один узел в инспекторе волны 1.
2. Тот же экран **пересобирается** как `CtypPaymentSuccessComposition` со слотами (nav/merchant/accrual/offer/payment-method/footer), сохраняется, пины полны, публикуется без blocking-issue — фикстура в `test/fixtures/` + тест.
3. Прогон readiness по всем прототипам локальной копии прод-данных: сводка записана в план, ни один прототип не теряет способность сохраняться/публиковаться.
4. `npm run verify` + `npm run e2e` зелёные после каждой волны; runtime-приёмка (`/verify`) после волн 1, 4, 5.
5. `scripts/validate-templates.ts` и фикстуры — без новых warning'ов.
6. Документация: `docs/prototype-format.md`, `docs/server-api.md`, статус пунктов в `docs/easy-ui-product-improvements-v2.md`.
