# Atomic Design + мультисистемность (design systems) в easy-ui

## Context

Сейчас в easy-ui один жёстко зашитый каталог компонентов (shadcn из `@json-render/shadcn` + Hotspot), без какой-либо классификации. Пользователь хочет:

1. **Несколько дизайн-систем как отдельные библиотеки компонентов.** MVP: `shadcn` (существующий каталог) + новая lo-fi система `wireframe` (серые блоки, схематичные контролы) в репо. Архитектура — подключение будущих систем (MUI и т.п.) как ещё одного модуля.
2. **Atomic Design** (atoms/molecules/organisms/templates/pages): уровень у каждого компонента; отражён в метаданных + Library UI, в Storybook, и в валидации композиции (**warnings**, не errors — существующие прототипы работают).
3. **Строгая привязка прототипа к системе**: `designSystem` в JSON-документе; валидатор и плеер резолвят компоненты только из этой системы (+ её кастомные). Селектор/фильтр в UI: фильтр в галерее, переключатель систем в библиотеке.
4. **Отражение в API**: `designSystem` в схеме/DTO/БД прототипов и в кастомных компонентах, `atomicLevel` в контракте публикации (`DefinitionMeta`) и манифесте, новый `GET /api/design-systems`.

Обратная совместимость: старые доки/строки БД → дефолт `shadcn`; `version` документа остаётся `1`.

## Ключевые решения

- **Модуль системы** — `src/designSystems/<id>/`, реестр `src/designSystems/index.ts`:
  ```ts
  // src/designSystems/types.ts
  export const atomicLevels = ["atom","molecule","organism","template","page"] as const;
  export type AtomicLevel = (typeof atomicLevels)[number];
  export const atomicRank: Record<AtomicLevel, number> = { atom:1, molecule:2, organism:3, template:4, page:5 };
  export interface DesignSystem {
    id: string; name: string; description: string;
    definitions: Record<string, ComponentDefinition>;   // нормализованные, с atomicLevel
    components: Record<string, ComponentType>;
    fixtures: Record<string, Record<string, unknown>>;
  }
  ```
- `ComponentDefinition` получает **опциональные** `atomicLevel?: AtomicLevel` и `layoutNeutral?: boolean` (ноль поломок для пакета @json-render и уже опубликованных кастомных бандлов). Контракт: **у builtin-компонентов обеих систем уровень обязателен** (drift-тест), у кастомных — опционален (ABI v1 back-compat; публикация без уровня даёт warning; UI относит отсутствие уровня к «Other»).
- **Уровни для shadcn** (пакет не редактируем) — проектная карта `src/designSystems/shadcn/atomicLevels.ts` + unit-тест на дрейф (каждое имя имеет уровень и наоборот). Раскладка 37 компонентов:
  - layout-neutral (atom + `layoutNeutral:true`): Stack, Grid
  - atom (18): Button, Link, Input, Textarea, Checkbox, Switch, Slider, Toggle, Heading, Text, Image, Avatar, Badge, Separator, Progress, Skeleton, Spinner, Hotspot
  - molecule (12): Select, Radio, DropdownMenu, ToggleGroup, ButtonGroup, Pagination, Tooltip, Popover, Alert, Collapsible, Accordion, Carousel
  - organism (5): Card, Tabs, Dialog, Drawer, Table
- **Правило вложенности** (warning): DFS несёт уровень ближайшего не-layout-neutral предка; warning если `rank(level) > rank(ancestorLevel)`. Layout-neutral и компоненты без уровня прозрачны/пропускаются. Равные уровни разрешены (Card в Card — ок). Hotspot — atom, входит в каждую систему. Warning указывает на конкретный element-путь.
- **Модель хранения `designSystem`**: источник истины — **нормализованный doc ревизии**. Все чтения сохранённых доков на сервере идут через единый `parseStoredPrototypeDoc(json)` = `prototypeDocSchema.parse(JSON.parse(json))` — Zod-default дописывает `shadcn` старым докам на чтении (физическая миграция doc-JSON не делается). Колонка `prototypes.design_system` — **денормализация head** только для списка/фильтра галереи; обновляется в `create/save/restore`. Per-revision колонка не нужна: система ревизии всегда выводима из её doc; `builtin_catalog_hash` ревизии считается от системы её doc.
- **Имена компонентов остаются глобально уникальными** (pins/registry/`components.name UNIQUE` ключуются по имени). Композитный ключ `(design_system, name)` — post-MVP. Политика эволюции: регистрация новой builtin-системы, чьё имя коллидирует с существующим кастомным компонентом, — dev-time блокер; серверный startup-инвариант сверяет union builtin-имён всех систем с таблицей `components` и падает с внятной ошибкой (grandfathering решается вручную при добавлении системы). Задокументировать в `docs/server-api.md`.
- **Кастомные компоненты**: `designSystem` — свойство записи (`POST /api/components` принимает опционально, дефолт `shadcn`, колонка `components.design_system`); `atomicLevel` — опционально в `definition`-экспорте TSX.
- **`builtinCatalogHash` становится per-system**, формула v1-дескриптора не меняется (name/description/events/slots + actions — `atomicLevel` в дескриптор НЕ входит, т.к. не влияет на рендер-совместимость; metadata/warnings могут меняться без смены хеша — задокументировать) ⇒ хеш shadcn байт-в-байт прежний; серверный тест-ассерт на это. **Семантика mismatch в MVP — как сегодня: хеш диагностический**, рантайм его не сверяет; фиксируем в docs как осознанное решение (enforcement/compat-таблицы — post-MVP). Тест: старая published-версия с прежним хешем читается и играется.

## Checklist потребителей единого каталога (полный)

| Место | Решение |
|---|---|
| `src/catalog/definitions.ts` | compat-шим = shadcn definitions |
| `src/catalog/catalog.ts` (singleton `catalog`) | остаётся shadcn-compat; per-system каталоги мемоизируются в модулях систем |
| `src/catalog/events.ts` (`componentEvents`) | остаётся shadcn-compat с комментарием; per-system деривация при необходимости |
| `src/catalog/fixtures.ts` | compat-реэкспорт из `shadcnSystem` (владелец — фаза 1) |
| `src/smoke/SmokeSpec.tsx` | явно shadcn-only (комментарий) |
| `server/seed.ts` | system-aware через doc (фаза 4c) + тест |
| `server/builtinHash.ts` | `builtinCatalogHashFor(systemId)` |
| тестовые фабрики server/player, `src/catalog/fixtures.test.tsx`, `definitions.test.ts` | обновить/параметризовать |
| `src/prototype/loader.ts` | уже парсит через `prototypeDocSchema` после API-read — default срабатывает, изменений не нужно (проверить тестом) |

## Фазы

### Фаза 1 — Фундамент: реестр систем + модуль shadcn
- **Новые**: `src/catalog/normalize.ts` (вынести `ComponentDefinition`, `normalizeSchema`, `normalizeDefinitions` — разрывает цикл типов; делать первым); `src/designSystems/types.ts`; `src/designSystems/fixtures.ts` — **чистый `createFixtures(definitions, overrides)`**; `src/designSystems/shadcn/atomicLevels.ts`; `src/designSystems/shadcn/overrides.ts` (перенос fixture-overrides из `src/catalog/fixtures.ts`); `src/designSystems/shadcn/index.ts` — собирает definitions + components + fixtures **внутри себя, без импорта compat-шимов** (разрыв runtime-цикла DesignSystem↔fixtures); `src/designSystems/index.ts` (`designSystems`, `DEFAULT_DESIGN_SYSTEM_ID`, `getDesignSystem`, `resolveDefinitions`).
- **Правки**: `src/catalog/definitions.ts` и `src/catalog/fixtures.ts` → тонкие compat-реэкспорты из `shadcnSystem`; все ~12 импортёров компилируются без изменений.
- **Тесты**: дрейф уровней (двусторонний); smoke-тест импорта `definitions` + `fixtures` + registry + shadcn-системы (ловля import-цикла; проверка одновременного импорта обеих систем — в фазе 2).

### Фаза 2 — Wireframe-система (`src/designSystems/wireframe/`)
- `components.tsx`: plain div + Tailwind (серая палитра, пунктирные рамки, без shadcn-импортов), конвенция `({ props, emit, on })` (паттерн — `src/catalog/hotspot.tsx`). Набор: Box/Stack/Grid (layout-neutral, слот children); atoms: Heading, Text, Image (серый прямоугольник с крестом, без внешних URL), Button (`press`), Input (`change`), Checkbox (`change`) + переиспользованный Hotspot; molecule: Select (`change`); organism: Card (children, опц. титул).
- `definitions.ts` (zod-схемы, у каждого `example`), `index.ts` (`wireframeSystem`).
- Тесты: рендер каждого компонента из `example` через registry (зеркало `fixtures.test.tsx`); smoke-тест одновременного импорта обеих систем.

### Фаза 3 — Схема прототипа + валидация (клиент/shared)
- `src/prototype/schema.ts`: `designSystem: slugSchema.default("shadcn")` в `prototypeDocSchema` (strictObject, version = 1).
- `src/prototype/validate.ts`: дефолт definitions = `getDesignSystem(doc.designSystem).definitions`; unknown system → error по пути `/designSystem` (клиентский строковый формат путей) и ранний выход. Warning вложенности — расширить существующий `dfs` (`validate.ts:160`) параметром `ancestorLevel`; текст: `atomic-design: <Type> (<level>) should not be nested inside a <ancestorLevel>`; путь — конкретный element.
- `scripts/validate-prototypes.ts` — без изменений.
- Тесты: дефолт designSystem; unknown system; organism-in-atom; **несколько layout-neutral подряд** (organism в Stack в Grid в Button → warning; в Stack в Card → нет); равный уровень без warning; безуровневый тип между предком и потомком; atomic-обход совместно с cycle/orphan-структурами.

### Фаза 4a — Сервер: миграция БД (additive)
- `server/migrations.ts`: рефактор в пошаговый массив; v2: `ALTER TABLE prototypes ADD COLUMN design_system TEXT NOT NULL DEFAULT 'shadcn'`; `ALTER TABLE components ADD COLUMN design_system TEXT NOT NULL DEFAULT 'shadcn'`.
- **Совместимость positional insert**: `server/repos/components.ts:11` использует `INSERT INTO components VALUES (?,?,1,NULL,?,?)` — после добавления седьмой колонки сломается. В этой же фазе заменить на явный список колонок `INSERT INTO components (id,name,head_rev,deleted_at,created_at,updated_at) VALUES (?,?,1,NULL,?,?)` (design_system берёт DEFAULT); проверить остальные positional insert-ы обеих таблиц.
- Тесты: апгрейд заполненной v1-базы → v2; старые кастомные компоненты получают `shadcn`.

### Фаза 4b — Сервер: реестр/хеш/нормализация чтения
- `server/builtinHash.ts`: `builtinCatalogHashFor(systemId)` (прежняя формула, от definitions системы); `builtinCatalogHash` = shadcn (тест на равенство дореформенному значению).
- `server/repos/prototypes.ts`: единый `parseStoredPrototypeDoc()` вместо голых `JSON.parse` в `draft/revision/version/restore/publish` (repos:75, 89, 107, 110, 112). Тесты на v1-док без поля во всех пяти путях.
- Серверный startup-инвариант: union builtin-имён всех систем vs `components` (см. «Ключевые решения»).

### Фаза 4c — Сервер: save/restore/publish/seed прототипов
- `create/save`: писать `prototypes.design_system` из doc; `insertRevision` хранит `builtinCatalogHashFor(doc.designSystem)` (repos:39–43).
- `restore` (repos:72): нормализовать source doc (`parseStoredPrototypeDoc`), хеш и head-колонку — от **его** системы; проверить, что каждый копируемый pin принадлежит той же системе (JOIN `components.design_system`), иначе 422. Тест-сценарий: shadcn → wireframe → restore shadcn-ревизии.
- `publish` (repos:86): типы классифицировать против definitions системы ревизии; **каждый pin** проверять JOIN-ом `components.design_system` = система ревизии.
- `server/validation.ts` `snapshotDefinitions`: builtin = definitions системы дока (unknown system → `ApiError(422, "validation_failed", issues:[{path:["designSystem"],...}])` — Zod-style массив, серверный формат; исключение из `getDesignSystem` не должно утекать 500-й); SQL-резолв кастомных `AND c.design_system = ?`; сообщение `Unknown or unpublished component type in design system '<id>': <name>`.
- `validatePrototypeForSave` (`server/routes/prototypes.ts:23`) сейчас задаёт `componentDefinitions` собственным default-параметром — фаза 3 его сама не исправит. Явно: убрать shadcn-default; при отсутствии переданных snapshot-definitions выбирать definitions по `doc.designSystem`; POST/PUT продолжают передавать merged snapshot definitions.
- `server/seed.ts`: серверный тест, что wireframe-документ **реально засеялся** (а не молча пропущен через `console.error`) — через временный seed-каталог с wireframe-фикстурой (файл `prototypes/wireframe-demo.json` появляется только в фазе 8; там — отдельная проверка реального файла). Кастомные компоненты в seed не поддерживаются — зафиксировать комментарием.

### Фаза 4d — Сервер: кастомные компоненты + манифест
- `server/components/types.ts`: `atomicLevel?` в `CustomComponentDefinition` и `DefinitionMeta`.
- `server/components/extract-subprocess.ts`: `atomicLevel: z.enum([...]).optional()` в **обеих** strictObject-схемах (child + `resultSchema.meta`); тесты с/без поля.
- `pipeline.ts` `definitionMeta()` пробрасывает `atomicLevel`; публикация без уровня → warning в ответе publish.
- `server/routes/components.ts` POST: опц. `designSystem` (валидация против реестра, 422 Zod-style), коллизия имени против union builtin-имён всех систем; `create(..., designSystem)`; DTO list/meta + `designSystem`; `catalogManifest()` + `designSystem`.
- `src/customComponents/loader.ts`: пропускать/копировать `atomicLevel`.

### Фаза 4e — Сервер: endpoint design-systems + DTO-матрица
- **`GET /api/design-systems`** (`server/routes/designSystems.ts`, роут в `server/main.ts` до 404, no-store): `{designSystems:[{id,name,description,builtinCatalogHash,components:[{name,atomicLevel,layoutNeutral,description,events,slots}]}]}`.
- **DTO-матрица** (правило: где в ответе есть нормализованный `doc` — система живёт в `doc.designSystem`, top-level поле не дублируется; top-level только там, где doc отсутствует):
  | Endpoint | designSystem |
  |---|---|
  | `GET /prototypes` (list) | top-level (из колонки head) |
  | `GET /prototypes/:id` (meta) | top-level (из колонки head) |
  | draft / revision / version | внутри `doc` (после `parseStoredPrototypeDoc`) |
  | create/save/restore responses | не добавляется (rev-only) |
  | `GET /components` list/meta | top-level |
  | manifest | top-level per entry |
- `src/api/client.ts`: `designSystem` в `PrototypeSummary`/`PrototypeMeta`, component DTO; `DesignSystemSummary` + `listDesignSystems()`. Тест-инвариант — интеграционный серверный: после create/save/restore сравнить `designSystem` из list/meta с `draft.doc.designSystem` (list/meta сами doc не содержат).
- Тесты: wireframe-прототип с shadcn-only типом → 422; кастомный wireframe-компонент не резолвится из shadcn-прототипа → 422; шейп design-systems; round-trip atomicLevel в манифест.

### Фаза 5 — Плеер
- `src/catalog/runtime.ts`: `createPlayerRuntime(deps, custom?, designSystemId = "shadcn")` — builtins из `getDesignSystem(id)` (unknown → throw; на сервере/валидаторе не возникает); fast-path — мемоизированный `createCatalog(system.definitions)` per system.
- `src/player/PlayerShell.tsx` (`LoadedPlayer`): передать `doc.designSystem`, включить в deps `useMemo`/runtime-key.
- `src/catalog/stories/story-utils.tsx`: `ElementStory`/`SpecStory` + опц. `system?: string`, ленивый `Map<string, runtime>`.
- `src/smoke/SmokeSpec.tsx`: комментарий «shadcn-only».
- Тесты: wireframe-runtime резолвит wireframe Button; unknown system бросает; старая published-версия (прежний hash) играется.

### Фаза 6 — Storybook (атомарно с фикстурами; ДО фазы 7)
- Конвенция тайтлов: `"<System>/<LevelPlural>/<Name>"` (`Shadcn/Atoms/Button`, layout-neutral → `Shadcn/Layout/Stack`), обзорные — `Shadcn/All Components`, `Wireframe/All Components`. Хелпер `titleFor(name)` из `shadcnAtomicLevels` (анти-дрейф).
- Переименовать тайтлы в 10 файлах `src/catalog/stories/`; новые сторисы `src/designSystems/wireframe/stories/` (AllComponents + Button/Input/Select/Card через `ElementStory system="wireframe"`).
- Пересчитать `expectedStoryIds` (id = kebab тайтла + `--default`) — тем же коммитом.

### Фаза 7 — UI: фильтр галереи, переключатель библиотеки
- `src/gallery/GalleryPage.tsx`: фильтр-чипы **из `listDesignSystems()`** (зарегистрированные системы видны и без прототипов; legacy/unknown значения из списка прототипов добавляются как чипы «как есть») + бейдж системы на карточке.
- `src/library/LibraryPage.tsx`: парсинг 3-сегментных тайтлов `System/Level/Name`; переключатель систем (первый сегмент); сайдбар группирует по второму (Layout, Atoms, Molecules, Organisms, Templates, Pages, Other); 1–2-сегментные тайтлы → «Other».
- Обновить `GalleryPage.test.tsx`, `LibraryPage.test.tsx`.

### Фаза 8 — Доки + демо + верификация
- `docs/prototype-format.md`: поле `designSystem`, семантика atomic-warnings, per-system allowlist.
- `docs/server-api.md`: `GET /api/design-systems`, DTO-матрица, `atomicLevel` в `DefinitionMeta`/манифесте, диагностическая семантика `builtinCatalogHash`, политика глобальной уникальности имён и эволюции систем.
- `CLAUDE.md`: ключевые зоны + `src/designSystems/`.
- `prototypes/wireframe-demo.json` (`designSystem:"wireframe"`).

## Последовательность и владение файлами

1 → 2 → 3 → 4a → 4b → 4c → 4d → 4e → 5 → 6 → 7 → 8. Каждая подфаза — отдельный коммит, зелёный сам по себе. `src/catalog/fixtures.ts` принадлежит фазе 1; `expectedStoryIds` — фазе 6.

## Триаж ревью Codex (раунд 1, 2026-07-11)

| # | Severity | Вердикт | Как учтено |
|---|---|---|---|
| 1 | blocker | принято | Модель хранения: источник истины — doc ревизии; `prototypes.design_system` — head-денормализация; см. «Ключевые решения» |
| 2 | blocker | принято | `parseStoredPrototypeDoc()` во всех read/restore/publish путях (фаза 4b) |
| 3 | blocker | принято | seed в фазе 4c + тест реального засева wireframe-demo |
| 4 | blocker | принято | `createFixtures` + overrides в отдельных модулях, сборка внутри `shadcn/index.ts` (фаза 1) |
| 5 | major | принято частично | Hash остаётся диагностическим в MVP (задокументировано); designSystem в runtime-key; тест старой версии. Enforcement — post-MVP |
| 6 | major | принято | restore: нормализация, hash от системы source, head-обновление, проверка pins (фаза 4c) |
| 7 | major | принято частично | Глобальная уникальность остаётся (MVP); startup-инвариант + dev-time политика коллизий; композитный ключ — post-MVP |
| 8 | major | принято | DTO-матрица (фаза 4e), правило «doc — источник, top-level только без doc» |
| 9 | major | принято | publish/restore проверяют систему каждого pin (фаза 4c) |
| 10 | major | принято | Два формата путей зафиксированы: сервер — Zod-массивы, клиент — строки; unknown system → 422, не 500 |
| 11 | major | принято | Полный checklist потребителей каталога (раздел выше) |
| 12 | major | принято | Фаза 4 разбита на 4a–4e; Storybook (6) перед Library (7); владельцы файлов уточнены |
| 13 | minor | принято | Контракт: builtin — обязателен, custom — optional + publish-warning + «Other» |
| 14 | minor | принято | Расширенные DFS-тесты (фаза 3) |
| 15 | minor | принято | Чипы галереи из `listDesignSystems()` |

## Триаж ревью Codex (раунд 2, 2026-07-11)

Блокирующих возражений нет; план признан готовым после правок. Все 5 находок приняты и внесены: (1, major) positional insert `components` чинится в фазе 4a; (2, major) тест «обе системы» перенесён в фазу 2; (3, minor) seed-тест 4c — через временный каталог; (4, minor) `validatePrototypeForSave` — явный пункт в 4c; (5, minor) DTO-инвариант уточнён как интеграционный.

## Риски

- **Дрейф builtinCatalogHash**: `atomicLevel` не в дескрипторе — тест равенства shadcn-хеша дореформенной константе.
- **Циклы импортов**: типовой (normalize.ts) и runtime-цикл fixtures (createFixtures) — оба разорваны в фазе 1; smoke-тест импорта.
- **strictObject в extract-subprocess**: покрыть тестами с/без `atomicLevel`.
- **Churn story-id**: фаза 6 атомарна с `expectedStoryIds`.
- Wireframe-компоненты обязаны использовать `emit`/`on` конвенцию `BaseComponentProps` (образец — `src/catalog/hotspot.tsx`).

## Верификация

`npm run verify` (typecheck ×2, lint, vitest, bun-тесты сервера, validate:prototypes, build + storybook, drift-check) → `npm run e2e` → runtime-прогон по скиллу `/verify`: галерея с фильтром систем → wireframe-demo в плеере → переключатель систем в библиотеке. Плюс ручная проверка: создание кастомного компонента с `designSystem:"wireframe"` + `atomicLevel` и его использование в wireframe-прототипе.

## Процесс (workflow CLAUDE.md)

План прошёл два раунда адверсариального ревью Codex gpt-5.6-sol (триаж выше); блокирующих возражений нет — **план одобрен к исполнению**. Исполнение волнами Codex `--write --effort medium` по подфазам с независимой верификацией done-критериев перед каждым коммитом.
