# Spacing/Layout Contract v1 + Agent-DX (2026-07-15) — v3 (после раундов 1–2 Codex-ревью)

## Context

Анализ реальных прод-прототипов показал: на yandex-pay (единственная «живая» агентская DS, 78 компонентов) **33% всех элементов документа — это `YpSpacer`** (54 из 165 в cpqr-scenario), потому что `YpBox` — флекс-контейнер без `gap`/`padding`/`margin`. Enum размеров спейсера (4–24) не покрывает нужные значения → агенты штабелируют спейсеры (24+24+16 = 64px тремя элементами), 2×2 сетки строятся вложенными боксами с gutter-спейсерами, magic numbers (`8`×21, `24`×31) без токенов, все 9 пропов YpBox сериализуются даже в дефолтах (причина — manifest экспортирует output-схему Zod, где defaulted-поля становятся required; см. D9a). У формата нет общего spacing-контракта; единственный «лаз» — недокументированный `className` на shadcn Stack/Grid/Card. У агента нет численного фидбэка по layout — только пиксельный дифф.

Решения пользователя: (1) общий spacing-контракт на уровне формата, YpBox/YpBlock — первое применение, `layoutNeutral` разрешить custom-компонентам; (2) позиционирование = поток (flex/grid) + узкий overlay-примитив, без свободных координат; (3) agent-DX: spacing-линты + геометрический фидбэк + layout-гайд в SKILL.md (codemod не делаем).

## Триаж ревью

**Раунд 1** (4 blocker, 13 major, 3 minor): все приняты; следствия вшиты в v2 (Overlay как host-примитив + stage-layer; полная цепочка сериализации `layout` до агента; geometry как probe без asset ingest; `{io:"input"}` для manifest-схем; wireframe px не трогаем; волны W0/W7; `code` у issues; единый Zod-introspect; eligibility `layoutNeutral`; advisory-политика className; save/publish-стадии валидации).

**Раунд 2** (3 blocker, 12 major, 3 minor): все приняты, включая доработку частично отклонённой M8:
- **B1' (space.* резолвится по-разному у builtin/custom/host)** → единый `resolveSpacingScale` + синтез недостающих ключей до ABI + инъекция во все render surfaces (D2).
- **B2' (Overlay не покрывает editor/CJM/gallery, рендерящие Renderer напрямую)** → общий `HostStageSurface`/`splitHostPrimitives`, миграция всех поверхностей, правила Overlay↔Hotspot (D5).
- **B3' (из `spacing: string[]` машина не выводит применимость gap)** → optional `flow`-метаданные в `layout`; линты/gap-расчёты работают только там, где flow известен (D3, D7, D8).
- **M4'–M15'**: coordinate truth table и sibling-layer вместо обёртки (D5); hostPrimitives отдельной секцией каталога, не в bundle-manifest (D5); `space.*` = только неотрицательные абсолютные px, все 7 ключей, монотонность, валидация merged-темы, только новые версии (D2); SSR-conformance ≠ layout-conformance — разделение критериев (D1); ужесточение eligibility layoutNeutral (непустой spacing, без events, sentinel-child) (D4); расширение шкалы до `3xl=48`/`4xl=64` + линт рекомендует замену только при точном эквиваленте (D2, D8); builtin hash = детектор несовместимости, не pin — обязательный `renderContractVersion`, hash включает scale и host-дескрипторы (W2b); discriminated union `kind: image|geometry` + полный контекст в результате probe (D7); lint-allowlist per (componentType, propName) из layout-метаданных (D8); W7-rollback: новая версия темы с прежним контентом, deprecated вместо rejected, CAS-restore ревизий (W7); воспроизводимый baseline-tuple + Playwright-покрытие editor/CJM/gallery + custom-aware fixture harness (W0/W6); integration gate после W2, дополненный ownership (Waves).
- **m16'–m18'**: introspect-модуль буквально один (import в subprocess или corpus-тест на обе стороны); минимальный input-example для YpBox; W0-аудит существующих имён `Overlay` в прод-DB.

## Архитектурные решения

### D1. Форма контракта: конвенция «имя + канонический enum» + метаданный блок `layout`

Компонент-контейнер объявляет пропы из стандартного словаря (`gap`, `padding`, `paddingX`, `paddingY`), типизированные каноническим token-enum'ом (или подмножеством), и декларирует это блоком `layout` в definition-метаданных (additive-паттерн `atomicLevel`/`interactive`, `src/catalog/normalize.ts:17-41`). Грамматика документа не меняется, старые документы валидны (новые пропы optional).

Стадии валидации:
- **save (checkSource)**: shape-валидация декларации против Zod-схемы (422 при нарушении).
- **publish**: SSR-conformance — компонент рендерится, принимает заявленные пропы, **сохраняет sentinel default child** (проверка прозрачности slot). SSR-смоук **не** заявляется как проверка computed-геометрии; browser-conformance (реальные px) — только через conformance-фикстуры W6 и geometry probe, документируем это разделение честно.

Отвергнуто (раунд 0): `layout`-блок в грамматике документа (styleContract v2, хрупко поверх `display:contents`, не понимается pinned json-render 0.19); серверный mixin в схемы.

### D2. Token scale и единый runtime-резолв

```
spaceToken = none | xs | sm | md | lg | xl | 2xl | 3xl | 4xl
canonical fallback px: 0 / 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64
```

- `3xl`/`4xl` добавлены, чтобы шкала представляла реальные прод-интервалы (кейс 24+24+16 = 64px). Подмножество канонического enum — валидно (shadcn Stack `none..xl`, Grid `sm..xl` — as-is, npm-схемы не трогаем; wireframe Stack сохраняет px sm/md/lg = 8/16/24, enum расширяется монотонными DS-значениями).
- **Единый резолв**: функция `resolveSpacingScale(designSystem, pinnedThemeVersion): Record<SpaceToken, string>` — единственный источник шкалы для builtin-, custom-компонентов и host-примитивов. Резолв: merged-тема DS → недостающие ключи синтезируются из canonical fallback **до** создания runtime ABI (custom-компонент никогда не видит пустой `token("space.*")`). Одна и та же resolved-шкала инжектится во **все** render surfaces (player/present/capture/editor/CJM/gallery/story) через общий theme-plumbing (`src/designSystems/theme.tsx`).
- **Формат токенов темы**: `space.*` — только неотрицательные **абсолютные px-строки** (`"12px"`); обязательны все 9 ключей при объявлении хотя бы одного, `none = "0px"`, значения монотонно неубывают. Валидация — на **merged**-теме (не только patch), применяется к **новым** версиям темы (старые сохранённые темы продолжают открываться). rem/%/calc/viewport-units — вне v1.
- Каталог/манифест/capabilities отдают resolved scale per DS — агент видит фактические px. Builtin-системы токены не потребляют (статические классы) — их шкала захардкожена в декларации DS и рекламируется так же.
- yandex-pay: тема получает `space.*` = 0/4/8/12/16/24/32/48/64. Legacy-значения YpSpacer (включая 20) остаются валидными числами; линт подсказывает gap только при точном эквиваленте.

### D3. Спецификация метаданных и семантика v1

```ts
// ComponentDefinition
layout?: {
  version: 1;                          // обязателен всегда
  spacing?: ("gap" | "padding" | "paddingX" | "paddingY")[];
  spacer?: true;                       // чистый спейсер; несовместим с непустыми slots и spacing
  flow?: {                             // применимость gap — машиночитаемо (B3')
    // фиксированное направление ИЛИ проп-переключатель с маппингом значений
    direction:
      | "vertical" | "horizontal"
      | { prop: string; vertical: string[]; horizontal: string[]; none?: string[] };
    wrap?: { prop: string; truthy: unknown[] };   // если контейнер умеет wrap
    slot?: string;                     // slot, к которому применяется gap (default: "default")
  };
}
```

- Правила: `layout` без `spacing` и без `spacer` — 422 (пустая декларация запрещена); дубликаты имён в `spacing` — 422; `flow` допустим только вместе с `spacing ⊇ ["gap"]`; значения `flow.direction.prop` должны существовать в схеме пропа.
- Валидация декларации — общим Zod-introspection модулем (D8a; **буквально один модуль**: subprocess импортирует его же, при невозможности — corpus-тест, гоняющий один набор схем через обе стороны): каждый проп из `spacing` существует и является enum-подмножеством канонического scale (Optional/Nullable/Default/Prefault/Readonly/Catch/Pipe разворачиваются).
- **Нормативная семантика v1** (prototype-format.md + conformance-фикстуры): `padding` — четыре стороны; `paddingX` = inline, `paddingY` = block, при одновременном задании перекрывают `padding` по своей оси; `none` = 0; отсутствие пропа = дефолт компонента; `gap` — промежутки между детьми slot'а из `flow.slot` в направлении `flow.direction`; оси logical (RTL через CSS logical properties).
- **Честное ограничение**: линты применимости gap и расчёт зазоров в geometry работают только для контейнеров с задекларированным `flow` (плюс builtin-контейнеры, чей flow задекларирован в W1: shadcn Stack `direction: {prop:"direction", vertical:["vertical"], horizontal:["horizontal"]}`, Grid — без flow (grid), wireframe Stack — `direction:"vertical"`). Для контейнеров без flow — только rect'ы, без выводов.
- Capabilities: `layoutContractVersion: 1`, `features.layoutContract`.

### D4. layoutNeutral для custom-компонентов

Схемы `server/components/extract-subprocess.ts` (metadata + resultSchema) + passthrough `definitionMeta` → manifest → `src/customComponents/loader.ts`. **Eligibility — ошибки, не warnings**:
- save (shape): `layoutNeutral: true` требует объявленного default slot, непустого `layout.spacing`, отсутствия declared events/eventPayloads, `interactive !== true`, atomic level ∈ {atom, molecule} либо не задан;
- publish (SSR): sentinel default child обязан присутствовать в выводе `renderToString` (прозрачность контейнера).
Негативные интеграционные тесты обязательны.

### D5. Overlay — host-примитив со stage-layer во всех поверхностях

```
Overlay { placement: top|bottom|center|top-left|top-right|bottom-left|bottom-right,
          inset: spaceToken = "md", scrim: boolean = false }
slots: [default], atomicLevel: atom, layoutNeutral: true
```

- **Host-примитив**: реестр `hostPrimitives` — **отдельная секция** catalog summary / discovery (не внутри bundle-manifest: manifest — это загружаемые bundle-записи с `bundleUrl`/hash, host-примитив без bundle сломал бы loader-контракт). Мёржится в клиентский runtime registry и в валидацию для любой DS. Имя `Overlay` резервируется на create/update/publish (409); дескриптор host-примитива входит в builtin compatibility hash.
- **Рендер — sibling stage-layer, не обёртка**: общий сплиттер `splitHostPrimitives` (обобщение существующего Hotspot-сплиттера в `src/prototype/runtimeSpec.ts:160` — рекурсивное извлечение поддеревьев с сохранением descendant-маркеров) + общий компонент `HostStageSurface`, рендерящий overlay-layer **рядом** с контентом (sibling над content box), не оборачивая legacy flow в новый positioned ancestor. На него переводятся **все** поверхности: player/present (`ScreenSurface`), capture, editor canvas + screen strip, CJM tile, gallery preview, story/library preview.
- **Coordinate truth table** (нормативный раздел в доке): mobile — stage = device frame viewport; desktop — stage = content box экрана с явно заданной минимальной высотой (высота stage = max(viewport, контент)); `bottom`-плейсменты на desktop якорятся к нижней границе stage; overlay clip'ится stage'ем; scroll контента не двигает overlay; stacking: content < Overlay-layer < Drawer/Dialog порталы; несколько Overlay — в порядке документа; `scrim:true` — подложка на весь stage, клики сквозь неё отключены, `aria-hidden`, фокус не ловит; обычный Overlay — pointer-events только на своём контенте; hit-testing Hotspot'ов не пересекается с Overlay (см. ниже).
- **Overlay ↔ Hotspot/canvas**: Overlay разрешён на canvas-экранах (якорится к canvas-stage); `Hotspot` внутри Overlay запрещён (validate error), Overlay внутри Hotspot/Overlay/repeat запрещён; Overlay — только прямой ребёнок root экрана.
- Кейсы: badge, FAB, sticky-футер, scrim; модалки — Drawer/Dialog.

### D6. className: advisory-политика

Не убираем (npm-схема + прод-документы). Документируем как **best-effort escape hatch без гарантий** (Tailwind-классы не гарантированно присутствуют в скомпилированном CSS): не для позиционирования и не для спейсинга между сиблингами. Warning-линт `layout/classname-positioning` — токенизированный парсер class-строки (позиционные утилиты, включая `relative`, `inset-*`, variant-префиксы, arbitrary `z-[999]`, margin-утилиты), только по **статическим** строкам (директивы → `not-applicable`), с тестами вариантов.

### D7. Geometry probe (v1 — с заявленными ограничениями)

- Worker (`scripts/screenshot-worker.mjs`): после `__EUI_CAPTURE_READY__` — `page.evaluate`: обход `[data-eui-key]` (включая Overlay-layer), union-rect поддерева маркера (порталы вне поддерева не входят; fixed вне capture-surface отфильтровываются), CSS-px относительно border box capture-surface, округление до 0.01. Для контейнеров дополнительно снимается **computed layout context**: `display`, `flex-direction`, `flex-wrap` — вместе с `flow`-метаданными это основа честного расчёта зазоров. Логика union-rect — общий подход с `unionMarkerRect` (`src/player/ScreenSurface.tsx:40`), перекрёстный тест на общей DOM-фикстуре.
- **Контракт результата — discriminated union** `kind: "image" | "geometry"` (существующие image-поля не превращаются в optional). Geometry-результат: `{kind:"geometry", resolvedRev, prototypeInstanceId, componentPins, designSystemMetaVersion, resolvedSpaceScale, viewport, dpr, rects: [{key, instance, parentKey?, domIndex, x, y, width, height, hidden?, layoutContext?}], truncated, total}`. Различаются: отсутствующий маркер (не в rects) / `hidden: true` / zero-size rect. Лимит маркеров учитывает repeat-бюджет; при усечении — `truncated: true` + `total`.
- **Probe-режим**: `probe: "geometry"` в POST `/api/prototypes/:id/screens/:screenId/screenshot` → PNG не создаётся, asset ingest не выполняется. Комбинированный режим — не в v1.
- Driver `geometry <protoId> <screenId>`: rect'ы + таблица зазоров; **зазоры считаются только** когда родитель имеет известный flow (D3) И computed layout context подтверждает non-wrapped flex нужного направления, без repeat/named slots в группе; иначе `gaps: n/a (<причина>)`. Ограничения — в docs/server-api.md и в выводе.
- SKILL.md-рецепт: «собрал экран → geometry → зазоры равны resolved-токенам DS».

### D8. Линты (non-blocking warnings, `src/prototype/layoutLints.ts`)

#### D8a. Инфраструктура
- Zod-introspection: **один** shared-модуль (`src/catalog/zodIntrospect.ts`, вынос из `src/editor/propsForm/introspect.ts`), импортируется normalize/validate/lints/propsForm и extraction-subprocess (или corpus-тест на эквивалентность, если import через subprocess-границу невозможен). Покрытие: Optional/Nullable/Default/Prefault/Readonly/Catch/Pipe, не-object root.
- `ValidationIssue` + optional `code`; прокидка: contracts (схемы save-ответа), client DTO, `server/validationRecords.ts` (если формат записей версионируется), editor `docDiff`, driver; `VALIDATOR_VERSION` bump. Issue включает component key и JSON path.
- Спейсер-идентификация: `layout.spacer === true`; fallback — точный legacy-allowlist `["YpSpacer"]` (константа, TODO-дата удаления после republish).
- Дефолты: per-field через shared introspect. Дети группируются по slot.

#### D8b. Правила

| Код | Эвристика | Порог |
|---|---|---|
| `layout/spacer-chain` | ≥2 спейсеров подряд в одной slot-группе | 2 |
| `layout/spacer-heavy` | доля спейсеров среди элементов экрана | >25% и ≥8 |
| `layout/spacer-vs-gap` | родитель декларирует gap **и flow**, статическое направление — flex, gap отсутствует/`"none"`, ось спейсера совместима, в детях спейсер | 1 |
| `layout/default-props-noise` | ≥N статических пропов равны per-field default'ам | N=5 |
| `layout/magic-number-repetition` | одно числовое значение повторяется в пропах из allowlist **per (componentType, propName)**, выводимого из layout-метаданных + явных записей для legacy (`YpSpacer.size`) | ≥5, ∉{0,1} |
| `layout/classname-positioning` | токенизированный парсер из D6, только статические строки | — |

Рекомендация замены (например, «replace 3 consecutive YpSpacer with gap:"4xl"») печатается **только при точном px-эквиваленте** в resolved scale DS; иначе — общая подсказка без конкретного значения. Negative-тесты на каждый линт; прогон на прод-снапшоте cpqr фиксирует counts; shipped-фикстуры warning-free (правим фикстуры).

### D9. Фикс YpBox/YpBlock/YpSpacer (первое применение)

- **D9a (сервер)**: manifest/version экспортируют input-схему — `z.toJSONSchema(props, {io:"input"})` в `server/components/pipeline.ts`. Регресс-тесты: минимальный `{}`-input валиден; пиксельная эквивалентность `{}` vs явных дефолтов проверяется на фикстуре **с видимым child-контентом** (не пустой YpBox); editor propsForm и screenshot props-валидация не регрессируют.
- **YpBox**: + `gap?/padding?/paddingX?/paddingY?: spaceToken`; px через `token("space."+v)` (после D2 токены всегда синтезированы); `layout={version:1, spacing:[...], flow:{direction:{prop:"mode", vertical:["col"], horizontal:["row"], none:["box"]}, wrap:{prop:"wrap", truthy:[true]}}}`; `layoutNeutral: true`.
- **YpBlock**: + `padding?: spaceToken`; `layout={version:1, spacing:["padding"]}`.
- **YpSpacer**: `layout={version:1, spacer:true}`, описание «prefer gap on the parent».
- **Input-example** YpBox — минимальный (только смысловые overrides, без сериализации дефолтов): дефолты проверяются тестом, а не демонстрируются агенту в каталоге.
- Демонстрация layout — composed prototype-фикстуры «до/после» (cpqr-паттерн). Эталонные исходники — `.claude/skills/author/examples/`.

## Waves

Порядок: **W0 → W1 → (W2a ∥ W2b) → W2-gate → W3 → W4 → W5 → W6 → W7**. W2-gate — интеграционная проверка оркестратором (W2a и W2b меняют части одного definition/catalog-контракта: сквозной publish-цикл + snapshot-тесты до старта W3). W4 и W5 сериализованы (W5 тестирует DOM, который меняет W4). Правила: волна, трогающая `validate.ts`, выносит логику в свой модуль; `server/contracts.ts`, `docs/prototype-format.md`, `docs/server-api.md` — никогда в параллельных задачах одной волны.

### W0 — Baselines и аудит (оркестратор, без Codex)
- Baseline-generations (`driver baseline`) для репрезентативных документов: shadcn/wireframe-фикстуры репо + локальные копии прод-YP (cpqr, ctyp) на dev-сервере с опубликованным YP-каталогом. **Baseline tuple фиксируется**: instance, rev, generation, component pins, theme version, viewport, DPR, browser/build — в манифесте рядом с бейзлайнами; проверка «до/после» гоняется на одной persistent DB/assets.
- **Аудит зарезервированных имён**: проверить прод- и dev-DB на существующие компоненты `Overlay` (и будущие host-имена); зафиксировать результат в плане W4.
**Done**: baseline-sets + tuple-манифест созданы, `driver check` зелёный на нетронутом коде; аудит выполнен.

### W1 — Ядро контракта
**Файлы**: `src/designSystems/types.ts`, `src/catalog/normalize.ts`, новый `src/catalog/zodIntrospect.ts` (+переключение `src/editor/propsForm/introspect.ts` на shared), новый `src/designSystems/spacingScale.ts` (`resolveSpacingScale`, canonical fallback, синтез ключей), `src/designSystems/theme.tsx` (инъекция resolved scale во все поверхности), `server/designSystemsMeta.ts` (валидация `space.*`: px-only, 9 ключей, монотонность, merged-тема, только новые версии), `src/designSystems/shadcn/index.ts` (+`layout.ts`: декларации spacing+flow), `src/designSystems/wireframe/definitions.ts` + `components.tsx` (расширение enum без изменения существующих px), `src/designSystems/fixtures.ts`, `src/catalog/definitions.test.ts`, `docs/prototype-format.md` («Spacing & layout contract v1»: словарь, шкала, семантика, flow).
**Done**: unit-тесты декларации (валид/подмножество/не-enum/spacer+slots/version/flow/пустая декларация/дубликаты); тест «старые wireframe px неизменны»; тест `resolveSpacingScale` (тема/синтез/fallback); test+typecheck зелёные; `validate:prototypes` зелёный; `driver check` против W0 — zero drift.

### W2a — Custom-компоненты plumbing
**Файлы**: `server/components/extract-subprocess.ts`, `server/components/pipeline.ts`, `server/components/types.ts`, `src/customComponents/loader.ts`, `server/components.test.ts`.
**Работа**: metadata/result-схемы + `layoutNeutral` + `layout` (shape на save через shared introspect / corpus-тест); eligibility D4 (включая sentinel-child на publish); passthrough `definitionMeta`; **D9a `{io:"input"}`** + регресс-тесты.
**Done**: publish фикстуры с `layout`+`layoutNeutral`+`flow` проходит; кривые декларации → 422 (по каждому правилу D3/D4); `layoutNeutral` гасит atomic-nesting warning; manifest-схема фикстуры не требует defaulted-поля; sentinel-child негативный тест.

### W2b — Contracts/сериализация/каталог
**Файлы**: `server/contracts.ts`, `server/routes/designSystems.ts`, `server/routes/components.ts` (резервация host-имён), `server/routes/meta.ts` (capabilities + `/api/schemas/component-definition.json`), `server/builtinHash.ts` + `server/builtinHash.test.ts`, `src/api/client.ts`, `scripts/generate-builtin-catalog.ts`, `.claude/skills/author/driver.mjs` (`compactCatalog`), `.claude/skills/author/reference/builtin-catalog.json` (regen), `server/openapi.json` (regen), `docs/server-api.md`.
**Работа**: `layoutContractVersion:1` + `features.layoutContract` + resolved scale per DS; `layout`/`layoutNeutral`/input `propsJsonSchema` во всех DTO до агента; секция host-примитивов в discovery (не в bundle-manifest); builtin hash: props-схемы + layout-метаданные + resolved scale + host-дескрипторы + обязательный `renderContractVersion` (hash — детектор несовместимости, **не pin**: дока формулирует честно); optional `code` в issue-схемах.
**Done**: capabilities/summary/manifest/driver catalog/reference отдают новые поля; snapshot-тесты сериализации + API-схем; drift OpenAPI зелёный; hash-тесты.

### W2-gate (оркестратор)
Сквозной publish-цикл фикстурного компонента с полной декларацией против собранного сервера; сверка сериализации W2a↔W2b.

### W3 — Линты
**Файлы**: новый `src/prototype/layoutLints.ts` (+тест), `src/prototype/validate.ts` (одна строка), `src/prototype/types.ts` (+`code`), `server/validationRecords.ts` (если формат версионируется), `src/editor/docDiff.ts`, фикстуры `src/prototype/__tests__/`.
**Done**: unit-тест на каждый линт (позитив/негатив/порог/slot-группировка/ось/точный-эквивалент-рекомендации); фикстура cpqr-паттерна даёт ожидаемые warnings с кодами; прогон на копии прод-cpqr: errors 0, counts snapshot'ом; shipped-фикстуры warning-free; validate.test.ts контракт не ослаблен.

### W4 — Overlay (host-примитив, все поверхности)
**Файлы**: новый `src/catalog/hostPrimitives/` (definition + реализация + `HostStageSurface`), `src/prototype/runtimeSpec.ts` (`splitHostPrimitives` — обобщение Hotspot-сплиттера), `src/designSystems/index.ts` (merge в registry), `server/designSystems.ts` (host-секция summary), `src/player/ScreenSurface.tsx`, `src/editor/EditorCanvas.tsx` + `src/editor/EditorScreenStrip.tsx`, `src/cjm/CjmScreenTile.tsx`, `src/gallery/GalleryPreview.tsx`, story/library preview, canvas-layers (Hotspot-взаимодействие), новый `src/prototype/overlayRules.ts` (+строка в validate.ts), `/api/schemas/*` (если затронуты), stories, тесты, `docs/prototype-format.md` (Overlay + coordinate truth table).
**Done**: Overlay рендерится в shadcn/wireframe/custom-only DS, flow- и canvas-экраны, **во всех поверхностях** (player/present/capture/editor canvas+strip/CJM/gallery/story — render-тест на каждую); 7 placements + inset (по resolved scale из D2) + scrim; несколько Overlay; stacking по truth table; validate-errors (root/repeat/вложенность/Hotspot-внутри) покрыты; publish `Overlay` → 409 (включая существующие записи — по W0-аудиту); `driver check` против W0 — zero drift на документах без Overlay.

### W5 — Geometry probe
**Файлы**: `scripts/screenshot-worker.mjs`, `server/screenshot/worker-mjs.d.ts`, `server/screenshot/service.ts` (+sessions), `server/routes/screenshots.ts`, `server/routes/meta.ts` (лимит в capabilities), `server/contracts.ts` (discriminated union; +regen openapi), `src/visual/api.ts`, `.claude/skills/author/driver.mjs` (`geometry`), `docs/server-api.md`, contract-тесты worker/service.
**Done**: `driver geometry` — rect'ы, layout context, зазоры/`n/a` с причинами; перекрёстный union-rect тест; e2e: Stack gap:"md" — равные зазоры по resolved px; матрица: repeat/slots/Grid/wrap/hidden/портал/fixed/scroll/clipping/Overlay-layer/truncated; drift зелёный.

### W6 — Применение: yandex-pay fix (dev), SKILL.md, дока
**Файлы**: `.claude/skills/author/SKILL.md` (Layout guide), `.claude/skills/author/examples/*`, composed «до/после»-фикстуры + custom-aware fixture harness (интеграционный прогон против dev-сервера с опубликованным каталогом — `scripts/validate-prototypes.ts` не знает custom-определений), conformance-фикстуры семантики D3, `docs/prototype-format.md` (className advisory).
**Работа**: dev-publish YpBox/YpBlock/YpSpacer по D9 + тема со `space.*`; демо cpqr «до/после»; Playwright-прогон editor/CJM/gallery поверхностей на демо.
**Done**: SKILL.md с гайдом/рецептом/resolved scale; dev-publish проходит, manifest с `layout`+input-схемой; «до» — валиден с ожидаемыми warnings, «после» — без layout-warnings; пиксельная эквивалентность дефолтов на видимом child; `npm run verify` + `npm run e2e` зелёные.

### W7 — Прод-миграция yandex-pay (оркестратор, после приёмки)
Порядок: логический бэкап → CAS PATCH темы (`space.*`, новая meta-версия) → publish новых версий YpBox/YpBlock/YpSpacer → пересохранение выбранных прототипов (новые pins) → проверка старых immutable-ревизий (пины) и новых → **rollback-план**: тема — **новая версия с прежним контентом** (latest выбирается по max-версии — статус не откатывает); компоненты — deprecated/superseded (не `rejected`, пока существуют pins — rejected сделает bundle нерендерируемым); затронутые ревизии прототипов — CAS-restore (`server/repos/prototypes.ts:142`); отдельные сценарии для published и draft. Чек-лист ожидаемых версий — до выполнения.

## Риски

1. **Порталы/fixed в geometry** — обход поддеревом маркера, фильтрация; матрица W5.
2. **Subset-scale** — дока: «доступные значения — в propsJsonSchema», resolved scale в каталоге.
3. **Три реализации introspect** — один модуль + corpus-тест.
4. **Sibling stage-layer** — не оборачиваем legacy flow; layer только при наличии Overlay; W0-бейзлайны — ворота мержа W4 (риск перепривязки существующих absolute-элементов снят выбором sibling-архитектуры, но проверяется бейзлайнами).
5. **Рассинхрон rect-логики** — общий тестовый вектор.
6. **`{io:"input"}` меняет манифест-схемы существующих компонентов** — желаемое; регресс-тесты propsForm/screenshot-валидации.
7. **W7** — immutable-ревизии под пинами; бэкап + rollback по новой схеме (версия-с-прежним-контентом).
8. **Расширение шкалы до 9 токенов** — больше значений для агента; SKILL.md даёт рекомендуемые «обычные» токены (sm/md/lg/xl) и когда брать крупные.

## Верификация (сводная матрица приёмки)

- **Сериализация**: snapshot-тесты manifest/version/summary/driver catalog/reference + host-секции; drift OpenAPI; `/api/schemas/*` актуальны.
- **Совместимость**: старые ревизии рендерятся без drift (W0-tuple, одна DB); wireframe px неизменны; `validate:prototypes` зелёный; `{}`-input валиден и пиксельно эквивалентен явным дефолтам (видимый child).
- **Overlay**: все поверхности (render-тест каждой + Playwright editor/CJM/gallery), custom-only DS, canvas, violations, несколько Overlay, scrim/pointer-events, stacking truth table, 409 (включая существующие записи).
- **Geometry**: discriminated contract, полный контекст результата, матрица кейсов, числовая проверка Stack gap:"md", truncated/total.
- **Линты**: precision/negative-фикстуры, коды стабильны, counts на прод-снапшоте, точный-эквивалент-рекомендации, shipped-фикстуры warning-free.
- **Сквозное**: `npm run verify`, `npm run e2e`, W2-gate publish-цикл, dev-прогон D9, `driver geometry`.

## Процесс

План v3 → повторное Codex-ревью (`--resume`) → триаж → при отсутствии blocking-возражений — исполнение волнами Codex-задачами (`--fresh --write --effort medium`) с независимой верификацией done-критериев перед каждым коммитом. W0, W2-gate и W7 выполняет оркестратор. Прод-republish (W7) — только после полной приёмки W1–W6.
