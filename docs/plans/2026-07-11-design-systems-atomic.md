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
- `ComponentDefinition` получает **опциональные** `atomicLevel?: AtomicLevel` и `layoutNeutral?: boolean` (ноль поломок для пакета @json-render и уже опубликованных кастомных бандлов). `normalizeDefinitions` клонирует спредом — новые поля проходят сами.
- **Уровни для shadcn** (пакет не редактируем) — проектная карта `src/designSystems/shadcn/atomicLevels.ts` + unit-тест на дрейф (каждое имя имеет уровень и наоборот). Раскладка 37 компонентов:
  - layout-neutral (atom + `layoutNeutral:true`): Stack, Grid
  - atom (18): Button, Link, Input, Textarea, Checkbox, Switch, Slider, Toggle, Heading, Text, Image, Avatar, Badge, Separator, Progress, Skeleton, Spinner, Hotspot
  - molecule (12): Select, Radio, DropdownMenu, ToggleGroup, ButtonGroup, Pagination, Tooltip, Popover, Alert, Collapsible, Accordion, Carousel
  - organism (5): Card, Tabs, Dialog, Drawer, Table
- **Правило вложенности** (warning): DFS несёт уровень ближайшего не-layout-neutral предка; warning если `rank(level) > rank(ancestorLevel)`. Layout-neutral и компоненты без уровня прозрачны/пропускаются. Равные уровни разрешены (Card в Card — ок). Hotspot — atom, входит в каждую систему.
- **Имена компонентов остаются глобально уникальными** (pins/registry/`components.name UNIQUE` ключуются по имени). Trade-off задокументировать; коллизия при создании кастомного проверяется против объединения builtin-имён всех систем.
- **Кастомные компоненты**: `designSystem` — свойство записи (`POST /api/components` принимает опционально, дефолт `shadcn`, колонка `components.design_system`); `atomicLevel` — опционально в `definition`-экспорте TSX.
- **`builtinCatalogHash` становится per-system**, формула v1-дескриптора не меняется (name/description/events/slots + actions — `atomicLevel` в дескриптор НЕ входит) ⇒ хеш shadcn байт-в-байт прежний; серверный тест-ассерт на это.

## Фазы

### Фаза 1 — Фундамент: реестр систем + модуль shadcn
- **Новые**: `src/catalog/normalize.ts` (вынести `ComponentDefinition`, `normalizeSchema`, `normalizeDefinitions` из `definitions.ts` — разрывает цикл импортов; делать первым), `src/designSystems/types.ts`, `src/designSystems/shadcn/atomicLevels.ts`, `src/designSystems/shadcn/index.ts` (`shadcnSystem`), `src/designSystems/index.ts` (`designSystems`, `DEFAULT_DESIGN_SYSTEM_ID`, `getDesignSystem`, `resolveDefinitions`).
- **Правки**: `src/catalog/definitions.ts` → тонкий compat-шим (`componentDefinitions = shadcnSystem.definitions` + реэкспорты; все ~12 импортёров компилируются без изменений); `src/catalog/fixtures.ts` — fixtures деривятся из `shadcnSystem`.

### Фаза 2 — Wireframe-система (`src/designSystems/wireframe/`)
- `components.tsx`: plain div + Tailwind (серая палитра, пунктирные рамки, без shadcn-импортов), конвенция вызова `({ props, emit, on })` как у кастомных (паттерн — `src/catalog/hotspot.tsx`). Набор: Box/Stack/Grid (layout-neutral, слот children), atoms: Heading, Text, Image (серый прямоугольник с крестом, без внешних URL), Button (`press`), Input (`change`), Checkbox (`change`) + переиспользованный Hotspot; molecule: Select (`change`); organism: Card (children, опц. титул).
- `definitions.ts` (zod-схемы, у каждого `example` — из него генерятся fixtures/stories), `index.ts` (`wireframeSystem`).
- Тесты: рендер каждого компонента из `example` через registry (зеркало `src/catalog/fixtures.test.tsx`).

### Фаза 3 — Схема прототипа + валидация
- `src/prototype/schema.ts`: `designSystem: slugSchema.default("shadcn")` в `prototypeDocSchema` (strictObject, version = 1; старые JSON парсятся, output всегда несёт поле).
- `src/prototype/validate.ts`: дефолт definitions = `getDesignSystem(doc.designSystem).definitions`; unknown system → error по пути `/designSystem` и ранний выход. Warning вложенности — расширить существующий `dfs` (`validate.ts:160`) параметром `ancestorLevel`; текст: `atomic-design: <Type> (<level>) should not be nested inside a <ancestorLevel>`.
- `scripts/validate-prototypes.ts` — без изменений; `prototypes/*.json` дефолтятся в shadcn.
- Тесты: дефолт designSystem, unknown system, organism-in-atom warning, прозрачность layout-neutral, пропуск безуровневых типов.

### Фаза 4 — Сервер: БД, валидация, контракты, API
- **Миграции** (`server/migrations.ts`): рефактор в пошаговый массив; v2: `ALTER TABLE prototypes ADD COLUMN design_system TEXT NOT NULL DEFAULT 'shadcn'` и то же для `components` (SQLite сам бэкфиллит). Тест апгрейда v1→v2.
- **`server/builtinHash.ts`**: `builtinCatalogHashFor(systemId)` по прежней формуле от definitions системы; `builtinCatalogHash` остаётся = shadcn (тест на неизменность значения).
- **Репо**: `prototypes.ts` — писать `design_system` из дока, `insertRevision` хранит `builtinCatalogHashFor(doc.designSystem)`, DTO (`list/meta/draft/version`) + `designSystem`; `publish()` перепроверяет типы против definitions системы строки, не глобальных. `components.ts` — `create(..., designSystem)`, DTO + `designSystem`.
- **`server/validation.ts` `snapshotDefinitions`**: builtin = definitions системы дока (unknown system → 422 по пути `designSystem`); SQL-резолв кастомных получает `AND c.design_system = ?`; сообщение: `Unknown or unpublished component type in design system '<id>': <name>`.
- **Контракт кастомных**: `server/components/types.ts` — `atomicLevel?` в `CustomComponentDefinition` и `DefinitionMeta`; `server/components/extract-subprocess.ts` — `atomicLevel: z.enum([...]).optional()` в **обеих** strictObject-схемах (child + `resultSchema.meta`; тесты с/без поля); `pipeline.ts` `definitionMeta()` пробрасывает. `server/routes/components.ts` POST: опц. `designSystem` (валидация против реестра, 422), коллизия имени против union builtin-имён всех систем; `catalogManifest()` + `designSystem` в записях.
- `src/customComponents/loader.ts`: пропускать/копировать `atomicLevel`, если валидация шейпа вайтлистит поля.
- **`GET /api/design-systems`** (новый `server/routes/designSystems.ts`, роут в `server/main.ts` до 404, no-store): `{designSystems:[{id,name,description,builtinCatalogHash,components:[{name,atomicLevel,layoutNeutral,description,events,slots}]}]}`.
- Тесты: прототип `wireframe` с shadcn-only типом → 422; кастомный компонент wireframe не резолвится из shadcn-прототипа → 422; шейп design-systems; round-trip atomicLevel в манифест.

### Фаза 5 — Плеер
- `src/catalog/runtime.ts`: `createPlayerRuntime(deps, custom?, designSystemId = "shadcn")` — builtins из `getDesignSystem(id)` (throw на unknown); fast-path без кастомных — мемоизированный `createCatalog(system.definitions)` per system.
- `src/player/PlayerShell.tsx` (`LoadedPlayer`): передать `doc.designSystem`, добавить в deps `useMemo`.
- `src/catalog/stories/story-utils.tsx`: `ElementStory`/`SpecStory` + опц. `system?: string`, ленивый `Map<string, runtime>`.
- Тест: wireframe-runtime резолвит wireframe Button; unknown system бросает.

### Фаза 6 — UI: фильтр галереи, переключатель библиотеки, API-клиент
- `src/api/client.ts`: `designSystem` в `PrototypeSummary`/draft/version DTO; `DesignSystemSummary` + `listDesignSystems()`.
- `src/gallery/GalleryPage.tsx`: ряд фильтр-чипов (`All | shadcn/ui | Wireframe`, из distinct значений ответа — будущие системы появляются сами) + бейдж системы на карточке.
- `src/library/LibraryPage.tsx`: парсинг 3-сегментных тайтлов `System/Level/Name`; переключатель систем сверху (по первому сегменту); сайдбар группирует по второму (порядок: Layout, Atoms, Molecules, Organisms, Templates, Pages, Other); graceful fallback для 1–2-сегментных тайтлов → «Other».
- Обновить тест-фикстуры `GalleryPage.test.tsx`, `LibraryPage.test.tsx`.

### Фаза 7 — Storybook (атомарно с фикстурами!)
- Конвенция тайтлов: `"<System>/<LevelPlural>/<Name>"` (`Shadcn/Atoms/Button`, `Shadcn/Organisms/Dialog`, layout-neutral → `Shadcn/Layout/Stack`), обзорные — `Shadcn/All Components`, `Wireframe/All Components`. Уровень в тайтле деривить хелпером `titleFor(name)` из `shadcnAtomicLevels` (анти-дрейф).
- Переименовать тайтлы во всех 10 файлах `src/catalog/stories/`; новые сторисы `src/designSystems/wireframe/stories/` (AllComponents-галерея + Button/Input/Select/Card через `ElementStory system="wireframe"`).
- Пересчитать `expectedStoryIds` в `src/catalog/fixtures.ts` (id = kebab тайтла + `--default`); `scripts/check-storybook-drift.ts` не меняется.

### Фаза 8 — Доки + верификация
- `docs/prototype-format.md` (поле `designSystem`, семантика atomic-warnings, per-system allowlist), `docs/server-api.md` (`GET /api/design-systems`, `designSystem` в DTO/create body, `atomicLevel` в `DefinitionMeta`/манифесте), `CLAUDE.md` (строка ключевых зон + `src/designSystems/`).
- Демо-прототип `prototypes/wireframe-demo.json` (`designSystem:"wireframe"`) — галерея и e2e прогоняют вторую систему end-to-end.

## Последовательность и владение файлами

1 → 2 → 3 → 4 → 5 → 6‖7 → 8. Фазы 1–3 — чистый клиент/shared, зелёные независимо; фаза 4 — единственная, трогающая БД. Фаза 7 — одним коммитом с обновлением `expectedStoryIds`.

## Риски

- **Дрейф builtinCatalogHash**: `atomicLevel` не должен попасть в v1-дескриптор — тест-ассерт равенства shadcn-хеша дореформенной константе.
- **Цикл импортов** definitions ↔ designSystems — решается выносом `normalize.ts` первым шагом.
- **strictObject в extract-subprocess**: забытый `atomicLevel` в child-схеме → непрозрачный фейл публикации; покрыть тестами оба варианта.
- **Churn story-id** ломает drift-check и тесты LibraryPage — фаза 7 атомарна.
- Wireframe-компоненты обязаны использовать `emit`/`on` конвенцию `BaseComponentProps` (образец — `src/catalog/hotspot.tsx`).

## Верификация

`npm run verify` (typecheck ×2, lint, vitest, bun-тесты сервера, validate:prototypes, build + storybook, drift-check) → `npm run e2e` → runtime-прогон по скиллу `/verify`: галерея с фильтром систем → wireframe-demo в плеере → переключатель систем в библиотеке. Плюс ручная проверка: создание кастомного компонента с `designSystem:"wireframe"` + `atomicLevel` и его использование в wireframe-прототипе.

## Процесс (workflow CLAUDE.md)

После утверждения: сохранить план в `docs/plans/2026-07-11-design-systems-atomic.md`, закоммитить, прогнать адверсариальное ревью Codex gpt-5.6-sol (Stage 2, `--effort` config-level max), триаж находок в плане, затем исполнение волнами Codex `--write --effort medium` по зонам владения фаз с независимой верификацией done-критериев перед каждым коммитом.
