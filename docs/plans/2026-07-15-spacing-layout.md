# Spacing/Layout Contract v1 + Agent-DX (2026-07-15) — v2 (после раунда 1 Codex-ревью)

## Context

Анализ реальных прод-прототипов показал: на yandex-pay (единственная «живая» агентская DS, 78 компонентов) **33% всех элементов документа — это `YpSpacer`** (54 из 165 в cpqr-scenario), потому что `YpBox` — флекс-контейнер без `gap`/`padding`/`margin`. Enum размеров спейсера (4–24) не покрывает нужные значения → агенты штабелируют спейсеры (24+24+16 = 64px тремя элементами), 2×2 сетки строятся вложенными боксами с gutter-спейсерами, magic numbers (`8`×21, `24`×31) без токенов, все 9 пропов YpBox сериализуются даже в дефолтах (причина — manifest экспортирует output-схему Zod, где defaulted-поля становятся required; см. D9a). У формата нет общего spacing-контракта; единственный «лаз» — недокументированный `className` на shadcn Stack/Grid/Card. У агента нет численного фидбэка по layout — только пиксельный дифф.

Решения пользователя: (1) общий spacing-контракт на уровне формата, YpBox/YpBlock — первое применение, `layoutNeutral` разрешить custom-компонентам; (2) позиционирование = поток (flex/grid) + узкий overlay-примитив, без свободных координат; (3) agent-DX: spacing-линты + геометрический фидбэк + layout-гайд в SKILL.md (codemod не делаем).

## Триаж находок ревью (раунд 1: 4 blocker, 13 major, 3 minor)

Все 4 blocker и все 13 major **приняты**; все 3 minor **приняты**. Ключевые следствия:
- **B1 (Overlay недоступен в custom-only DS; прод-экраны YP — canvas)** → принято: Overlay становится **host-примитивом** (глобальный `hostPrimitives`-реестр, мёржится в каталог любой DS на сервере/клиенте/валидации, имя зарезервировано); **разрешён на canvas-экранах** (D5).
- **B2 (absolute не привязывает к stage)** → принято: ScreenSurface извлекает Overlay-поддеревья из spec и рендерит их в отдельный stage-layer (portal), не внутри root-компонента; layer добавляется только при наличии Overlay; нормативно заданы размеры stage, stacking, pointer-events, множественные Overlay, scrim (D5).
- **B3 (layout-метаданные не доходят до агента)** → принято: полная цепочка сериализации в W2 (design-system summary, manifest/version DTO, `server/components/types.ts`, `src/api/client.ts`, driver `compactCatalog`, `scripts/generate-builtin-catalog.ts`, `/api/schemas/component-definition.json`, builtin hash).
- **B4 (плоских rect'ов мало для gaps)** → принято: geometry v1 **ограничен** — rect'ы для всех, расчёт зазоров только для одномерного non-wrapped flex без repeat/named slots; ответ включает DOM-порядок и parent-link; ограничения зафиксированы в API и driver-выводе (D7).
- **M5 (default-noise: причина — output-схема)** → принято: `z.toJSONSchema(props, {io:"input"})`; «добавить .default()» убрано из D9.
- **M6 (token runtime)** → принято: `space.*` в теме — валидные CSS-length строки (`"12px"`), отдельная валидация; canonical px — только fallback для компонентов без темы; каталог отдаёт resolved scale per DS (D2).
- **M7 (wireframe px-remap ломает старые пиксели)** → принято: существующие px wireframe Stack (sm/md/lg = 8/16/24) **не меняются**; enum расширяется новыми токенами с DS-выбранными px; никакого remap (D2/W1).
- **M8 (семантика, а не только форма)** → принято: нормативный раздел semantics v1 (precedence, оси, применимость gap по mode/direction) + conformance-фикстуры; частично отклонена замена `spacing: string[]` на структурную декларацию — оставляем список + нормативную доку + правило применимости для линта (обоснование: v1 сознательно минимален, структура добавится в v2 при необходимости).
- **M9** → принято: общий Zod-introspection helper (выносится из `src/editor/propsForm/introspect.ts`), используется в declaration-валидации, propsForm и линте дефолтов.
- **M10 (layoutNeutral eligibility)** → принято: publish **error** (не warning), правила: объявлен default slot, `interactive !== true`, atomic level ∈ {atom, molecule}.
- **M11 (нет `code` у issues)** → принято: optional `code` в `ValidationIssue` + contracts + DTO + editor/driver, bump `VALIDATOR_VERSION`.
- **M12 (эвристики линтов)** → принято: per-field defaults, группировка детей по slot, учёт `gap:"none"`/оси/mode, legacy-allowlist вместо `/spacer/i` (точный список: `YpSpacer`), явный allowlist числовых spacing-пропов, negative-тесты, фиксация ожидаемых warning-counts на прод-снапшоте; shipped-фикстуры остаются warning-free (правим фикстуры, а не ослабляем контракт теста).
- **M13 (geometry как отдельный probe)** → принято: `probe`-режим без asset ingest, `resolvedRev` в ответе, CSS-px относительно border box capture-surface, стабильный порядок, bounded; ownership + `worker-mjs.d.ts`, `src/visual/api.ts`.
- **M14 (named examples не показывают layout)** → принято: демонстрация layout — через composed prototype-фикстуры «до/после», а не named examples (named examples остаются как есть — только пропсы).
- **M15 (миграция YP-темы)** → принято: отдельная операционная волна W7 (оркестратор, прод): CAS PATCH темы с `space.*`, publish компонентов, пересохранение выбранных прототипов (новые pins), проверка immutable-ревизий, rollback-план.
- **M16 (visual baseline до изменений)** → принято: новая волна W0 — снять бейзлайны до любых изменений.
- **M17 (декомпозиция)** → принято: волны переупорядочены, W4 и W5 сериализованы, ownership дополнен.
- **M18 (done-матрица)** → принято: сводная матрица приёмки (см. Верификация).
- **m19–m21** → приняты: `layout.version` обязателен везде; `spacer` конфликтует только с **непустыми** slots; отмечено, что Grid gap в shadcn — `sm..xl` (без none); Drawer, а не Sheet; D6 переименована в advisory; политика валидации задокументирована как «shape — на save (checkSource), conformance — на publish».

## Архитектурные решения

### D1. Форма контракта: конвенция «имя + канонический enum» + метаданный блок `layout` в definition

Компонент-контейнер объявляет пропы из стандартного словаря (`gap`, `padding`, `paddingX`, `paddingY`), типизированные каноническим token-enum'ом (или его подмножеством), и декларирует это блоком `layout` в definition-метаданных (тем же additive-паттерном, что `atomicLevel`/`interactive` — `src/catalog/normalize.ts:17-41`). Грамматика документа не меняется, старые документы валидны (новые пропы optional).

Политика валидации декларации: **shape-валидация — на save** (extraction в `checkSource` запускается уже на POST/PUT компонента — так и остаётся, документируем), **conformance (рендер-смоук с layout-фикстурой) — на publish**. Сообщения ошибок различают эти стадии.

Отвергнуто (раунд 0): зарезервированный `layout`-блок в грамматике (styleContract v2, хрупкий рендер поверх `display:contents`, не понимается pinned json-render 0.19) и серверный mixin в схемы (инжектированные пропы компонент не рендерит).

### D2. Token scale и runtime

```
spaceToken = none | xs | sm | md | lg | xl | 2xl
canonical fallback px: 0 / 4 / 8 / 12 / 16 / 24 / 32   ← только fallback, НЕ норматив для DS
```

- Подмножество канонического enum — валидно. shadcn Stack `none..xl` и Grid `sm..xl` соответствуют as-is (npm-схемы не трогаем). **wireframe Stack сохраняет текущие px (sm/md/lg = 8/16/24)** — существующие пиксели не двигаются; enum расширяется до полного scale c монотонными DS-значениями (none=0, xs=4, xl=32, 2xl=48).
- **Resolved scale — свойство дизайн-системы**: тема декларирует `space.none..space.2xl` как **валидные CSS-length строки** (`"12px"`); серверная валидация темы проверяет формат (`designSystemsMeta`). Каталог/манифест отдают resolved scale per DS — агент видит фактические px.
- Custom TSX резолвит через существующий shim `token("space.md")` (ABI v2, `server/shims/abi-v2.ts`) с canonical fallback при отсутствии токена. Новый ABI не нужен (значения — уже строки с единицами).
- yandex-pay: тема получает `space.*` = 0/4/8/12/16/24/32 px. Legacy-значения YpSpacer (включая 20, не имеющее токена) остаются валидными как числа — обратная совместимость; линт подсказывает gap.
- Builtin-системы (shadcn/wireframe) токены темы не потребляют (статические классы) — их resolved scale захардкожен в декларации DS и тоже рекламируется в каталоге.

### D3. Спецификация метаданных и семантика v1

```ts
// ComponentDefinition
layout?: {
  version: 1;                      // обязателен всегда
  spacing?: ("gap" | "padding" | "paddingX" | "paddingY")[];
  spacer?: true;                   // чистый спейсер (питает линты)
}
```

Валидация декларации (общий Zod-introspection helper, см. D8a): каждый проп из `spacing` существует в схеме и является enum-подмножеством канонического scale (обёртки Optional/Nullable/Default/Prefault/Readonly/Catch/Pipe разворачиваются); `spacer:true` несовместим с **непустыми** `slots` и со `spacing`; нарушение = 422 на save custom-компонента / throw при сборке builtin-каталога.

**Нормативная семантика v1** (раздел в prototype-format.md + conformance-фикстуры):
- `padding` — все четыре стороны; `paddingX` = inline-ось, `paddingY` = block-ось; при одновременном задании `paddingX/Y` **перекрывают** `padding` по своей оси.
- `none` = 0, отсутствие пропа = дефолт компонента.
- `gap` применяется к промежуткам между детьми default-slot в направлении раскладки; компонент, у которого gap применим не во всех режимах (YpBox `mode:"box"` = block), обязан указать это в description; линт `spacer-vs-gap` срабатывает только когда статический mode/direction родителя — flex (row/col).
- Оси — logical (RTL-корректность за счёт CSS logical properties в реализациях).

Capabilities: `layoutContractVersion: 1`, `features.layoutContract`.

### D4. layoutNeutral для custom-компонентов

Добавить в strict-схемы `server/components/extract-subprocess.ts` (metadata + resultSchema), passthrough через `definitionMeta` (pipeline) → manifest → `src/customComponents/loader.ts`. **Eligibility — publish error (422), не warning**: `layoutNeutral: true` допустим только если компонент объявляет default slot, `interactive !== true` и atomic level ∈ {atom, molecule} (или не задан). Негативные интеграционные тесты обязательны.

### D5. Overlay — host-примитив

```
Overlay { placement: top|bottom|center|top-left|top-right|bottom-left|bottom-right,
          inset: spaceToken = "md", scrim: boolean = false }
slots: [default], atomicLevel: atom, layoutNeutral: true
```

- **Host-примитив, не компонент DS**: новый реестр `hostPrimitives` (host-side definitions + реализация), мёржится в каталог **любой** дизайн-системы (builtin и custom-only) на сервере (manifest/summary), клиенте (runtime registry) и в валидации. Имя `Overlay` резервируется — publish custom-компонента с таким именем → 409 (как существующий конфликт с builtin).
- **Рендер — выделенный stage-layer**: ScreenSurface извлекает Overlay-поддеревья из spec до рендера root-компонента и рендерит их в отдельный absolutely-positioned layer поверх stage (portal в stage-контейнер). Root-компонент Overlay-детей не получает — layer не зависит от того, рендерит ли root children, и не меняет containing block существующего контента. Layer добавляется **только при наличии Overlay** в экране — нулевой риск для существующих пикселей.
- Нормативно: stage = viewport экрана (device frame в player / capture-surface в capture); overlay clip'ится stage'ем; scroll контента не двигает overlay; z-index layer'а ниже Drawer/Dialog порталов; несколько Overlay складываются в порядке документа; `scrim:true` рисует подложку на весь stage под контентом overlay, клики сквозь scrim отключены (pointer-events), обычный Overlay — pointer-events только на своём контенте; scrim получает `aria-hidden`, фокус не ловит (это прототип, не продакшен-модалка).
- **Разрешён на canvas-экранах** (прод-YP — целиком canvas): якорится к canvas-stage. Validate-errors: Overlay — только прямой ребёнок root экрана; запрещён внутри repeat и внутри другого Overlay.
- Кейсы: badge, FAB, sticky-футер, scrim; модалки — по-прежнему Drawer/Dialog.

### D6. className: advisory-политика

Не убираем (npm-схема + прод-документы) и не заявляем «constrain». Документируем в prototype-format.md как **best-effort escape hatch без гарантий**: не для позиционирования и не для спейсинга между сиблингами; runtime-значения Tailwind не гарантированно присутствуют в скомпилированном CSS. Warning-линт `layout/classname-positioning` — токенизированный парсер class-строки с allowlist-подходом (матчит `absolute|fixed|sticky|relative`, `z-*`, `inset-*`, `top/bottom/left/right-*`, `translate-*`, margin-утилиты, включая variant-префиксы `md:absolute` и arbitrary `z-[999]`), с тестами вариантов.

### D7. Geometry probe (v1 — со заявленными ограничениями)

- Worker (`scripts/screenshot-worker.mjs`): после `__EUI_CAPTURE_READY__` — `page.evaluate`: обход `[data-eui-key]` (включая новый stage-layer Overlay), для каждого маркера union-rect **поддерева маркера** (порталы вне поддерева не входят; fixed-элементы вне capture-surface отфильтровываются), координаты в CSS-px относительно **border box capture-surface**, округление до 0.01. Логика union-rect — переиспользование подхода `unionMarkerRect` (`src/player/ScreenSurface.tsx:40`) в сериализуемой функции с перекрёстным тестом на общей DOM-фикстуре.
- Ответ: `{resolvedRev, rects: [{key, instance, parentKey?, domIndex, x, y, width, height, hidden?}]}`, стабильный порядок (DOM), bounded (лимит элементов — из capabilities).
- **Probe-режим**: `probe: "geometry"` в теле POST `/api/prototypes/:id/screens/:screenId/screenshot` → PNG не создаётся и **asset ingest не выполняется**; жоба возвращает только geometry. Комбинированный режим (PNG+geometry) — не в v1.
- Driver `geometry <protoId> <screenId>`: печатает rect'ы + таблицу зазоров, но **зазоры считаются только** для родителей, чьи дети — одномерный non-wrapped flex, без repeat и named slots (по документу resolvedRev + domIndex); для остальных печатается пометка `gaps: n/a (grid/wrap/repeat/slots)`. Ограничения зафиксированы в docs/server-api.md и в выводе.
- SKILL.md-рецепт: «собрал экран → geometry → зазоры равны resolved-токенам DS».

### D8. Линты (non-blocking warnings, `src/prototype/layoutLints.ts`)

#### D8a. Инфраструктура
- Общий Zod-introspection helper: вынести из `src/editor/propsForm/introspect.ts` в shared-модуль (`src/catalog/zodIntrospect.ts`), покрыть Optional/Nullable/Default/Prefault/Readonly/Catch/Pipe и не-object root; использовать в declaration-валидации (D3), propsForm и линтах.
- `ValidationIssue` получает optional `code: string`; прокидывается в contracts (schemas save-ответа), client DTO, editor (`docDiff` presentation), driver; `VALIDATOR_VERSION` bump. Старые warnings — без code.
- Спейсер-идентификация: `definition.layout?.spacer === true`; fallback — **точный legacy-allowlist** `["YpSpacer"]` (константа с TODO-датой удаления после republish), не regex.
- Дефолты: per-field (по каждому top-level полю схемы через shared introspect), не `safeParse({})` целиком.
- Дети группируются по slot; линты работают внутри каждой slot-группы.

#### D8b. Правила

| Код | Эвристика | Порог |
|---|---|---|
| `layout/spacer-chain` | ≥2 спейсеров подряд в одной slot-группе | 2 |
| `layout/spacer-heavy` | доля спейсеров среди элементов экрана | >25% и ≥8 |
| `layout/spacer-vs-gap` | родитель декларирует gap, статический mode/direction — flex (row/col), gap отсутствует или `"none"`, ось спейсера совместима с направлением, и в детях есть спейсер | 1 |
| `layout/default-props-noise` | ≥N статических пропов равны per-field default'ам | N=5 |
| `layout/magic-number-repetition` | одно числовое значение повторяется в пропах из явного allowlist числовых spacing-пропов (`size`, `inset`, `spacing` — конфигурируемый список) | ≥5, ∉{0,1} |
| `layout/classname-positioning` | токенизированный парсер из D6 | — |

Сообщения с конкретной рекомендацией («replace 3 consecutive YpSpacer with gap:"xl" on the parent»). Negative-тесты на каждый линт; прогон на прод-снапшоте cpqr фиксирует ожидаемые counts; shipped-фикстуры репо остаются warning-free (фикстуры правим).

### D9. Фикс YpBox/YpBlock/YpSpacer (первое применение)

- **D9a (сервер, для всех)**: manifest/version экспортируют **input**-схему: `z.toJSONSchema(props, {io:"input"})` в `server/components/pipeline.ts` — defaulted-поля перестают быть required. Регресс-тест: минимальный `{}`-input валиден по схеме манифеста + пиксельная эквивалентность рендера `{}` и явно сериализованных дефолтов (capture-тест).
- **YpBox**: + `gap?/padding?/paddingX?/paddingY?: spaceToken` (optional); px через `token("space."+v)` + canonical fallback; `layout={version:1, spacing:[...]}`; `layoutNeutral: true` (declared default slot есть); в description — «gap применяется в mode row|col».
- **YpBlock**: + `padding?: spaceToken`; `layout={version:1, spacing:["padding"]}`.
- **YpSpacer**: `layout={version:1, spacer:true}`, описание «prefer gap on the parent».
- Демонстрация layout — **composed prototype-фикстуры «до/после»** (cpqr-паттерн), а не named examples (named examples рендерятся без детей и layout не покажут). Эталонные исходники — в `.claude/skills/author/examples/`.

## Waves

Порядок: **W0 → W1 → W2 → W3 → W4 → W5 → W6 → W7**. W2 распараллеливается внутри (W2a ∥ W2b — непересекающиеся файлы), остальные волны последовательны (W4 и W5 сериализованы: W5 тестирует DOM, который меняет W4). Правило: каждая волна, трогающая `validate.ts`, выносит логику в свой модуль; `server/contracts.ts`, `docs/prototype-format.md`, `docs/server-api.md` — никогда в параллельных задачах одной волны.

### W0 — Visual baselines до изменений (оркестратор, без Codex)
Снять и зафиксировать baseline-generations (`driver baseline`) для репрезентативных документов: shadcn-фикстуры репо, wireframe-фикстуры, локальные копии прод-YP (cpqr, ctyp) на dev-сервере. Эти бейзлайны — референс «legacy drift = 0» для всех последующих волн.
**Done**: baseline-sets созданы, `driver check` зелёный на нетронутом коде.

### W1 — Ядро контракта
**Файлы**: `src/designSystems/types.ts`, `src/catalog/normalize.ts`, новый `src/catalog/zodIntrospect.ts` (вынос из `src/editor/propsForm/introspect.ts` + переключение propsForm на shared), `src/designSystems/shadcn/index.ts` (+соседний `layout.ts`), `src/designSystems/wireframe/definitions.ts` + `src/designSystems/wireframe/components.tsx`, `src/designSystems/fixtures.ts`, `src/catalog/definitions.test.ts`, `docs/prototype-format.md` (раздел «Spacing & layout contract v1» + нормативная семантика D3).
**Работа**: `SpaceToken`/`SPACE_TOKENS`/`CANONICAL_SPACE_PX`; `ComponentDefinition.layout` + `validateLayoutDeclaration` (на shared introspect; throw из `normalizeDefinitions`); декларации на shadcn Stack/Grid (subset) и wireframe Stack; wireframe Stack: **существующие px не трогать**, расширить enum (none=0, xs=4, xl=32, 2xl=48); resolved scale в декларации DS.
**Done**: unit-тесты декларации (валид/подмножество/не-enum/spacer+непустые slots/version); тест «старые wireframe-значения дают прежние px»; test+typecheck зелёные; `validate:prototypes` без изменений; `driver check` против W0-бейзлайнов — zero drift.

### W2a — Custom-компоненты plumbing
**Файлы**: `server/components/extract-subprocess.ts`, `server/components/pipeline.ts`, `server/components/types.ts`, `src/customComponents/loader.ts`, `server/components.test.ts`.
**Работа**: metadata/result-схемы + `layoutNeutral` + `layout` (shape-валидация на save через introspect-эквивалент в subprocess); eligibility `layoutNeutral` = 422 (D4); passthrough в `definitionMeta`; **D9a: `z.toJSONSchema(props, {io:"input"})`** + регресс-тест минимального input.
**Done**: publish фикстуры с `layout`+`layoutNeutral` проходит; кривая декларация → 422 на save с внятным сообщением; неэлигибельный `layoutNeutral` → 422; `layoutNeutral` гасит atomic-nesting warning (интеграционный тест); manifest-схема YpBox-подобной фикстуры не требует defaulted-поля.

### W2b — Contracts/сериализация/каталог
**Файлы**: `server/contracts.ts`, `server/routes/designSystems.ts`, `server/routes/meta.ts` (capabilities + ручная `/api/schemas/component-definition.json`), `server/builtinHash.ts`, `src/api/client.ts`, `scripts/generate-builtin-catalog.ts`, `.claude/skills/author/driver.mjs` (`compactCatalog`), `.claude/skills/author/reference/builtin-catalog.json` (regen), `server/openapi.json` (regen), `docs/server-api.md`.
**Работа**: `layoutContractVersion:1` + `features.layoutContract` + resolved space scale per DS в capabilities/summary; `layout`/`layoutNeutral`/input `propsJsonSchema` во всех DTO-цепочках до агента (B3); builtin hash включает props-схему + layout-метаданные + версию render-contract (M7); optional `code` в issue-схемах save-ответа.
**Done**: `/api/capabilities`, design-system summary, manifest/version, driver `catalog` и reference-каталог отдают `layout`/`layoutNeutral`/resolved scale; drift-check OpenAPI зелёный; snapshot-тесты сериализации.

### W3 — Линты
**Файлы**: новый `src/prototype/layoutLints.ts` (+тест), `src/prototype/validate.ts` (одна строка вызова), `src/prototype/types.ts` (+`code`), `src/editor/docDiff.ts` (presentation `code`), фикстуры `src/prototype/__tests__/`.
**Работа**: D8a-инфраструктура + шесть правил D8b; `VALIDATOR_VERSION` bump.
**Done**: unit-тест на каждый линт (позитив/негатив/порог/slot-группировка/ось); фикстура cpqr-паттерна даёт ожидаемый набор warnings c кодами; прогон на локальной копии прод-cpqr — errors: 0, warning-counts зафиксированы snapshot'ом; shipped-фикстуры репо warning-free; existing validate.test.ts контракт не ослаблен.

### W4 — Overlay (host-примитив)
**Файлы**: новый `src/catalog/hostPrimitives/` (definition + реализация + stage-layer), `src/designSystems/index.ts` (merge hostPrimitives), `server/designSystems.ts` + `server/routes/components.ts` (merge в summary/manifest, резервация имени), `src/player/ScreenSurface.tsx` (извлечение Overlay + portal-layer, добавляется только при наличии Overlay), новый `src/prototype/overlayRules.ts` (+строка в validate.ts), stories, тесты, `docs/prototype-format.md` (раздел Overlay).
**Done**: Overlay рендерится в shadcn, wireframe **и custom-only DS** (фикстурная custom-система), на flow- и canvas-экранах; 7 placements + inset + scrim; несколько Overlay; z-index ниже Drawer/Dialog; validate-errors (не root-ребёнок / внутри repeat / вложенный Overlay) покрыты; publish custom-компонента `Overlay` → 409; `driver check` против W0-бейзлайнов — zero drift на документах без Overlay (во всех поверхностях: player/present/CJM/editor/capture).

### W5 — Geometry probe
**Файлы**: `scripts/screenshot-worker.mjs`, `server/screenshot/worker-mjs.d.ts`, `server/screenshot/service.ts` (+sessions при необходимости), `server/routes/screenshots.ts`, `server/contracts.ts` (+regen openapi), `src/visual/api.ts` (если типы жобы там), `.claude/skills/author/driver.mjs` (`geometry`-команда + gaps c ограничениями D7), `docs/server-api.md`, тесты.
**Работа**: probe-режим без PNG/ingest; ответ `{resolvedRev, rects[...]}`; лимит в capabilities.
**Done**: `driver geometry` печатает rect'ы + зазоры/`n/a`-пометки; перекрёстный тест union-rect (общая DOM-фикстура с ScreenSurface-логикой); e2e: Stack gap:"md" — равные зазоры по resolved px; тесты: repeat, named slots, Grid, hidden, Dialog-портал, fixed ancestor, scroll, clipping, Overlay-layer; drift зелёный.

### W6 — Применение: yandex-pay fix (dev), SKILL.md, дока
**Файлы**: `.claude/skills/author/SKILL.md` (Layout guide: словарь, semantics, gap vs padding vs Overlay, анти-паттерн спейсеров, geometry-loop, resolved scale), `.claude/skills/author/examples/*` (yp-box.tsx и др. эталоны), composed «до/после»-фикстуры, `docs/prototype-format.md` (className advisory D6), фикстуры `validate:prototypes`.
**Работа**: dev-publish исправленных YpBox/YpBlock/YpSpacer по D9 (+ тема с `space.*` на dev); composed-демо cpqr-паттерна «до/после»; conformance-фикстуры семантики D3.
**Done**: SKILL.md с гайдом и рецептом; dev-publish проходит, manifest показывает `layout` + input-схему без ложных required; «до»-документ валиден с ожидаемыми warnings, «после» — без layout-warnings; пиксельная эквивалентность `{}` vs явные дефолты; `npm run verify` + `npm run e2e` зелёные.

### W7 — Прод-миграция yandex-pay (оркестратор, отдельно, после приёмки)
Операционный порядок: логический бэкап → CAS PATCH темы yandex-pay (`space.*` CSS-length, новая meta-версия) → publish новых версий YpBox/YpBlock/YpSpacer → пересохранение выбранных прототипов (новые component/theme pins) → проверка: старые immutable-ревизии рендерятся как раньше (пины), новые — с контрактом → rollback-план (предыдущая meta-версия темы + статусы версий компонентов). Ожидаемые версии фиксируются в чек-листе перед выполнением.

## Риски

1. **Порталы/fixed в geometry** — обход строго поддеревом маркера, фильтрация fixed вне surface; тестовая матрица W5.
2. **Subset-scale** (shadcn без xs/2xl, Grid без none) — дока: «доступные значения — в propsJsonSchema компонента», resolved scale в каталоге.
3. **Zod-introspection** — единый shared helper (D8a) вместо трёх реализаций; тесты на все обёртки.
4. **Stage-layer и существующие пиксели** — layer только при наличии Overlay + W0-бейзлайны как ворота мержа W4.
5. **Дублирование rect-логики** (ScreenSurface vs worker) — общий тестовый вектор.
6. **`{io:"input"}`** меняет схемы существующих компонентов в манифесте (required-поля исчезнут) — желаемое изменение, но editor propsForm и screenshot props-валидацию проверить регресс-тестами (W2a Done).
7. **Прод-миграция W7** — immutable-ревизии защищены пинами; бэкап + rollback-план обязательны.

## Верификация (сводная матрица приёмки)

- **Сериализация**: snapshot-тесты manifest/version/design-system summary/driver catalog/reference-каталога с `layout`/`layoutNeutral`/resolved scale; drift OpenAPI; `/api/schemas/component-definition.json` актуальна.
- **Совместимость**: старые shadcn/wireframe/YP-ревизии (пины) рендерятся без drift (W0-бейзлайны); старые wireframe px неизменны; `validate:prototypes` зелёный; минимальный `{}`-input валиден и пиксельно эквивалентен явным дефолтам.
- **Overlay**: все поверхности (player/present/CJM/editor/capture), custom-only DS, canvas, repeat/root/вложенность-violations, несколько Overlay, scrim/pointer-events, 409 на имя.
- **Geometry**: repeat/slots/Grid/wrap/hidden/portal/fixed/scroll/clipping/Overlay-layer; числовая проверка Stack gap:"md".
- **Линты**: precision/negative-фикстуры, стабильные codes, зафиксированные warning-counts на прод-снапшоте, shipped-фикстуры warning-free.
- **Сквозное**: `npm run verify`, `npm run e2e`, publish-цикл фикстурного custom-компонента с `layout`+`layoutNeutral`, dev-прогон D9, `driver geometry` на Stack-фикстуре.

## Процесс

План v2 → повторное Codex-ревью (`--resume` того же треда) → триаж → исполнение волнами Codex-задачами (`--fresh --write --effort medium`) с независимой верификацией done-критериев перед каждым коммитом. W0 и W7 выполняет оркестратор. Прод-republish (W7) — только после полной приёмки W1–W6.
