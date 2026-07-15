# Spacing/Layout Contract v1 + Agent-DX (2026-07-15)

## Context

Анализ реальных прод-прототипов показал: на yandex-pay (единственная «живая» агентская DS, 78 компонентов) **33% всех элементов документа — это `YpSpacer`** (54 из 165 в cpqr-scenario), потому что `YpBox` — флекс-контейнер без `gap`/`padding`/`margin`. Enum размеров спейсера (4–24) не покрывает нужные значения → агенты штабелируют спейсеры (24+24+16 = 64px тремя элементами), 2×2 сетки строятся вложенными боксами с gutter-спейсерами, magic numbers (`8`×21, `24`×31) без токенов, все 9 пропов YpBox сериализуются даже в дефолтах. У формата нет общего spacing-контракта; единственный «лаз» — недокументированный `className` на shadcn Stack/Grid/Card. У агента нет численного фидбэка по layout — только пиксельный дифф.

Решения пользователя: (1) общий spacing-контракт на уровне формата, YpBox/YpBlock — первое применение, `layoutNeutral` разрешить custom-компонентам; (2) позиционирование = поток (flex/grid) + узкий overlay-примитив, без свободных координат; (3) agent-DX: spacing-линты + геометрический фидбэк + layout-гайд в SKILL.md (codemod не делаем).

## Архитектурные решения

### D1. Форма контракта: конвенция «имя + канонический enum» + метаданный блок `layout` в definition

Компонент-контейнер объявляет пропы из стандартного словаря (`gap`, `padding`, `paddingX`, `paddingY`), типизированные каноническим token-enum'ом, и декларирует это блоком `layout` в definition-метаданных (тем же additive-паттерном, что `atomicLevel`/`interactive` — `src/catalog/normalize.ts:17-41`). Сервер на publish проверяет декларацию против реальной Zod-схемы (fail-closed 422). Грамматика документа не меняется, старые документы валидны (новые пропы optional).

Отвергнуто: зарезервированный `layout`-блок в грамматике (styleContract v2, хрупкий рендер поверх `display:contents`-маркеров, не понимается pinned json-render 0.19) и серверный mixin в схемы (инжектированные пропы компонент не рендерит — контракт-фикция).

### D2. Token scale

```
spaceToken = none | xs | sm | md | lg | xl | 2xl   → канонические px: 0/4/8/12/16/24/32
```

- Подмножество канонического enum — валидно (shadcn Stack/Grid `none..xl` соответствуют as-is, npm-схемы @json-render не трогаем).
- Дизайн-система переопределяет px через theme tokens `space.*`; custom TSX резолвит существующим shim'ом `token("space.md")` (ABI v2, `server/shims/abi-v2.ts`) с fallback на канонические значения. Новый ABI не нужен.
- yandex-pay: маппинг YpSpacer 4/8/12/16/20/24 → xs..2xl в теме; числовые значения остаются валидными (backward compat), линт подсказывает gap.

### D3. Спецификация метаданных

```ts
// ComponentDefinition
layout?: {
  version: 1;
  spacing?: ("gap" | "padding" | "paddingX" | "paddingY")[]; // пропы, принимающие spaceToken
  spacer?: true;  // компонент — чистый спейсер (питает линты)
}
```
Валидация декларации (extraction + normalizeDefinitions): каждый проп из `spacing` существует в схеме и является enum-подмножеством канонического scale (optional/nullable/default допустимы); `spacer:true` несовместим с `slots`/`spacing`; нарушение = 422 / throw при сборке builtin-каталога. Capabilities: `layoutContractVersion: 1`, `features.layoutContract`.

### D4. layoutNeutral для custom-компонентов

Добавить в strict-схемы `server/components/extract-subprocess.ts` (metadata L21 + resultSchema L10), пропустить через `definitionMeta` (pipeline) → manifest → `src/customComponents/loader.ts` (клиент уже читает). Анти-abuse: extraction-warning (не error) при `layoutNeutral && atomicLevel ∈ {organism,template,page}`.

### D5. Overlay-примитив (builtin, host-side как Hotspot)

```
Overlay { placement: top|bottom|center|top-left|top-right|bottom-left|bottom-right,
          inset: spaceToken = "md", scrim: boolean = false }
slots: [default], atomicLevel: atom, layoutNeutral: true
```
Рендер `position:absolute` относительно stage экрана (ScreenSurface получает relative-контейнер); z-index ниже Dialog/Sheet. Validate-errors: только прямой ребёнок root экрана; запрещён на canvas-экранах и внутри repeat. Кейсы: badge, FAB, sticky-футер, scrim; модалки — по-прежнему Sheet/Dialog.

### D6. className: document-and-constrain

Не убираем (npm-схема + прод-документы). Документируем в prototype-format.md как escape hatch «не для позиционирования/спейсинга между сиблингами» + warning-линт `layout/classname-positioning` по regex `/\b(absolute|fixed|sticky|z-\d|top-|bottom-|left-|right-|translate-|-?m[ltrbxy]?-\d)/`.

### D7. Geometry probe в существующем screenshot-воркере

После `__EUI_CAPTURE_READY__` воркер (`scripts/screenshot-worker.mjs`) делает `page.evaluate`: обход `[data-eui-key]`, union-rect потомков (логика `unionMarkerRect` из `src/player/ScreenSurface.tsx:40`, продублированная в сериализуемой функции с перекрёстным тестом), координаты относительно capture-surface → `{key, instance, x, y, width, height}[]`. Порталы (Dialog в body) и fixed-элементы вне surface — отфильтровать.

API: флаг `geometry: true` в POST `/api/prototypes/:id/screens/:screenId/screenshot`; результат в job (`geometry?: GeometryRect[]`). Driver: команда `geometry <protoId> <screenId>` — JSON rect'ов + расчёт зазоров между сиблингами по children-order (`parent → child gaps: [24, 24, 16]`). SKILL.md-рецепт: «собрал экран → geometry → зазоры равны токенам, а не 23/25px».

### D8. Линты (non-blocking warnings, отдельный модуль `src/prototype/layoutLints.ts`)

Спейсер = `definition.layout?.spacer === true`, fallback — имя типа `/spacer/i` (работает на прод-документах до republish). Пороги — экспортируемые константы.

| Код | Эвристика | Порог |
|---|---|---|
| `layout/spacer-chain` | ≥2 спейсеров подряд среди children | 2 |
| `layout/spacer-heavy` | доля спейсеров на экране | >25% и ≥8 |
| `layout/spacer-vs-gap` | родитель декларирует gap, а среди детей спейсер | 1 |
| `layout/default-props-noise` | ≥N статических пропов равны default'ам схемы (`safeParse({})`) | N=5 |
| `layout/magic-number-repetition` | одно числовое значение в size-пропах повторяется по экрану | ≥5, ∉{0,1} |
| `layout/classname-positioning` | regex из D6 | — |

Сообщения с конкретной рекомендацией («replace 3 consecutive YpSpacer with gap:"xl" on the parent»).

### D9. Фикс YpBox/YpBlock/YpSpacer (первое применение; прод-publish — отдельно, оркестратором)

- **YpBox**: + `gap?/padding?/paddingX?/paddingY?: spaceToken` (optional — старые документы валидны); px через `token("space."+v)` + fallback; `layout={version:1, spacing:[...]}`; `layoutNeutral: true`; явные `.default()` на 9 существующих пропов.
- **YpBlock**: + `padding?: spaceToken`; `layout={version:1, spacing:["padding"]}`.
- **YpSpacer**: `layout={spacer:true}`, описание «prefer gap on the parent».
- Named examples (`gap-list`, `two-column`, `padded-card`) на fixed-компоненты; эталонные исходники в `.claude/skills/author/examples/`.

## Waves (Codex-задачи, file ownership без пересечений внутри волны)

Порядок: **W1 → (W2 ∥ W3) → (W4 ∥ W5) → W6**. Правило: каждая волна, трогающая `validate.ts`, выносит логику в свой модуль (в validate.ts — одна строка вызова); `server/contracts.ts` и `prototype-format.md` — никогда в параллельных задачах одной волны.

### W1 — Ядро контракта
**Файлы**: `src/designSystems/types.ts`, `src/catalog/normalize.ts`, `src/designSystems/shadcn/index.ts` (+соседний `layout.ts`), `src/designSystems/wireframe/definitions.ts`, `src/catalog/definitions.test.ts`, `docs/prototype-format.md`.
**Работа**: `SpaceToken`/`SPACE_TOKENS`/`CANONICAL_SPACE_PX`; `ComponentDefinition.layout` + `validateLayoutDeclaration` (вызов из `normalizeDefinitions`, throw); декларации на shadcn Stack/Grid и wireframe Stack (wireframe наш — расширить gap до полного scale + рендер); раздел «Spacing & layout contract v1» в prototype-format.md.
**Done**: unit-тесты декларации (валид/подмножество/не-enum/spacer+slots); test+typecheck зелёные; `validate:prototypes` без изменений.

### W2a — Custom-компоненты plumbing
**Файлы**: `server/components/extract-subprocess.ts`, `server/components/pipeline.ts`, `src/customComponents/loader.ts`, `src/api/client.ts`, `server/components.test.ts`.
**Работа**: metadata/result-схемы + `layoutNeutral` + `layout` (проверка spacing-пропов против enum — разворачивать optional/nullable/default до ZodEnum по образцу `normalizeSchema`); passthrough в `definitionMeta`; abuse-warning D4; DTO.
**Done**: publish фикстуры с `layout`+`layoutNeutral` проходит; кривая декларация → 422 с внятным сообщением; `layoutNeutral` гасит atomic-nesting warning (интеграционный тест).

### W2b — Contracts/OpenAPI
**Файлы**: `server/contracts.ts`, `server/routes/meta.ts` (если capabilities там), `server/openapi.json` (regen), `docs/server-api.md`.
**Работа**: `layoutContractVersion:1` + `features.layoutContract`; manifest/version схемы + `layout`/`layoutNeutral`.
**Done**: `/api/capabilities` и manifest отдают поля; drift-check OpenAPI зелёный.

### W3 — Линты
**Файлы**: новый `src/prototype/layoutLints.ts` (+тест), `src/prototype/validate.ts` (одна строка вызова).
**Done**: unit-тест на каждый линт; фикстура cpqr-паттерна (цепочка 24+24+16, 33% спейсеров, 9 default-пропов) даёт ожидаемые warnings; ни один существующий валидный документ не получает errors.

### W4 — Overlay
**Файлы**: новые `src/catalog/overlay.definition.ts`/`overlay.tsx` (или per-system), `src/player/ScreenSurface.tsx` (relative stage), новый `src/prototype/overlayRules.ts` (+ строка вызова в validate.ts — после мержа W3), stories, тесты, `docs/prototype-format.md` (отдельный раздел Overlay).
**Done**: 7 placements + inset + scrim в обеих builtin-системах (storybook + capture); validate-errors покрыты; существующие visual-бейзлайны не дрейфуют (`driver check`).

### W5 — Geometry probe
**Файлы**: `scripts/screenshot-worker.mjs`, `server/screenshot/service.ts` (+sessions при необходимости), `server/routes/screenshots.ts`, `server/contracts.ts` (+regen openapi; W2b уже смержен), `.claude/skills/author/driver.mjs` (`geometry`-команда + sibling-gaps таблица), `docs/server-api.md`, тесты.
**Done**: `driver geometry` печатает rect'ы + зазоры; unit-тест union-rect хелпера; e2e: Stack gap:"md" даёт равные зазоры по px-маппингу; тест с Dialog (портал не ломает rect'ы); drift зелёный.

### W6 — Применение: yandex-pay fix (dev), SKILL.md, дока
**Файлы**: `.claude/skills/author/SKILL.md` (Layout guide: словарь, gap vs padding vs Overlay, анти-паттерн спейсеров, geometry-loop), `.claude/skills/author/examples/*` (эталонные yp-box.tsx и т.п.), `reference/builtin-catalog.json` (regen), `docs/prototype-format.md` (className-политика D6), фикстуры.
**Работа**: dev-publish исправленных YpBox/YpBlock/YpSpacer по D9; демо «до/после» cpqr-паттерна.
**Done**: SKILL.md с гайдом и рецептом; «до»-документ валиден с warnings, «после» — без layout-warnings; `npm run verify` + `npm run e2e` зелёные.

## Риски

1. **Порталы в geometry**: union-rect может захватить Dialog (рендер в body) — ограничить обход поддеревом маркера, фильтровать fixed вне surface; тест обязателен.
2. **shadcn-scale — подмножество** (нет xs/2xl): дока обязана говорить «доступные значения — в propsJsonSchema компонента», иначе агенты шлют xs → 422.
3. **Extraction-проверка `layout`** по живой Zod-инстанции: аккуратно разворачивать optional/nullable/default (по образцу normalizeSchema), иначе false-negative 422.
4. **Overlay и capture-детерминизм**: relative-контейнер stage не должен сдвинуть пиксели — `driver check` по существующим прототипам до мержа W4.
5. **default-props-noise** молчит, если дефолты в TSX, а не в Zod (приемлемо; D9 добавляет `.default()` явно).
6. **Дублирование rect-логики** (ScreenSurface vs worker) — общий тестовый вектор.

## Верификация

- Пер-волна: `npm run test`, server-тесты, `npm run typecheck`/`server:typecheck`, drift OpenAPI.
- Финал: `npm run verify`, `npm run e2e`; `driver baseline`/`check` (visual non-regression); `driver geometry` на Stack-фикстуре (числовая проверка gap); publish-цикл фикстурного custom-компонента с `layout`+`layoutNeutral`; прогон `validatePrototype` на копии прод-документа cpqr — errors: 0, ожидаемые layout-warnings есть.

## Процесс (по workflow проекта)

После одобрения: сохранить план в `docs/plans/2026-07-15-spacing-layout.md`, закоммитить → адверсариальное Codex-ревью (max effort, `--resume`-итерации) → триаж находок в плане → исполнение волнами Codex-задачами (`--fresh --write --effort medium`) с независимой верификацией done-критериев перед каждым коммитом. Прод-republish yandex-pay компонентов — отдельный шаг оркестратора после приёмки (как YP-миграции ранее).
