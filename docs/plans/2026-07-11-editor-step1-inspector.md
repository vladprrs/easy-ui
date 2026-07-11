# Редактор прототипов, шаг 1: инспектор настроек компонентов/экранов на базе CJM-вида

## Context

Первый шаг роадмапа «редактор»: возможность быстро поменять текст и другие настройки компонентов и экранов прямо в UI, без ручной правки JSON через API. Пользователь выбрал компоновку на базе CJM-вида: лента экранов как навигатор + крупный фокус-экран (клик по элементу = выбор) + панель инспектора справа + явная кнопка «Сохранить».

Вся инфраструктура уже есть, не хватает только UI:
- **Метадата для форм**: у каждого компонента есть Zod-схема props (`ComponentDefinition.props`, `src/catalog/normalize.ts`); zod 4.4.3, интроспекция через `instanceof z.ZodObject` / `.shape` / `.unwrap()` — паттерн уже используется в `normalize.ts`.
- **Выделение по клику**: json-render оборачивает каждый элемент в `<span data-jr-key={key} style="display:contents">`, когда активен devtools-флаг; `markDevtoolsActive(): () => void` экспортируется из `@json-render/core` (возвращает cleanup). Ключи элементов стабильны и совпадают с ключами `screen.spec.elements` (`toRuntimeSpec` сохраняет их 1:1).
- **Сохранение**: `savePrototype(id, doc, baseRev)` в `src/api/client.ts` уже есть, нигде не используется; сервер валидирует (422 `{issues}`) и держит CAS по ревизии (409 `{currentRev}`). Клиентская пре-валидация — `validatePrototype(doc, {definitions})` из `src/prototype/validate.ts`.
- **Переиспользуемое**: `PrototypeLoader` (render-prop, отдаёт `{loaded: PrototypeDraft, custom, runtimeKey, routeBase}`; `loaded.rev` = baseRev; `custom.definitions` доступны клиенту), `CjmFrame`/`TileErrorBoundary` (экспортированы из `src/cjm/CjmScreenTile.tsx`), `createCjmRegistry`, `mergeScreenState`, `toRuntimeSpec`, `splitCanvasSpec`, no-op nav deps (паттерн `CjmView`).

## Решения (зафиксированы с пользователем)

- Роут `/p/:protoId/edit`, **только черновик** (без `/v/:version/edit`). Оболочка `EditorShell` по образцу `CjmShell`.
- Выделение: клик по канвасу через `data-jr-key` + дерево элементов в панели (fallback для невидимых/вложенных).
- Инспектор: props выбранного элемента (автоформа из Zod) · экран: name, note, stateOverrides (JSON), canvas w/h · документ: name, description, startScreen, device.
- Сохранение: явная кнопка Save → пре-валидация → PUT c baseRev; показ 422 issues и 409-конфликта (баннер с «Перезагрузить черновик»).
- Live-превью: правки props сразу видны на фокус-экране и в тайлах ленты (spec — обычный проп `Renderer`, ремаунт не нужен).

**Вне скоупа шага 1**: добавление/удаление/перестановка элементов и экранов, редактирование `on`/`visible`, undo/redo, правка опубликованных версий, drag хотспотов, автосейв, кастомные компоненты (их props редактируются, если у definition объектная схема; иначе JSON-fallback).

## Реализация (новый каталог `src/editor/`)

### 1. `src/editor/docMutations.ts` — чистые иммутабельные хелперы
```ts
setElementProps(doc, screenId, elementKey, props): PrototypeDoc
patchScreen(doc, screenId, patch: Partial<Pick<Screen,"name"|"note"|"stateOverrides"|"canvas">>): PrototypeDoc
patchDocMeta(doc, patch: Partial<Pick<PrototypeDoc,"name"|"description"|"startScreen"|"device">>): PrototypeDoc
```
`undefined` в patch = удаление ключа (strictObject-схемы); no-op возвращает тот же reference.

### 2. `src/editor/editorReducer.ts` — состояние редактора
`EditorState { doc, baseRev, dirty, selection: { screenId, elementKey|null } }`; экшены `select-screen` (сбрасывает elementKey), `select-element`, `set-element-props`, `set-screen-meta`, `set-doc-meta`, `saved {rev}` (dirty=false, baseRev=rev), `reset {doc, rev}` (восстановление после 409).

### 3. `src/editor/propsForm/introspect.ts` — Zod → описание формы
`describePropsSchema(schema): PropField[] | null` (null = не объект → JSON-редактор всего props). Разворачивание `ZodOptional`/`ZodNullable`/`ZodDefault` (паттерн из `normalize.ts`), маппинг: `ZodString`→text, `ZodEnum`→select (`.options`), `ZodBoolean`→switch, `ZodNumber`→number, `ZodLiteral`→select(1); **всё остальное → `{kind:"json"}`** (гарантия редактируемости любого пропа).

### 4. `src/editor/propsForm/PropsForm.tsx`
`({ definition, values, onCommit })`. Динамические значения (`$state/$bindState/$template/$cond` — предикат как `isDynamic` в `validate.ts`) → JSON-textarea с меткой «динамическое значение», независимо от типа поля. Коммит: select/switch — on change; text/number — on blur/Enter; JSON — on blur после `JSON.parse` (ошибка парса — инлайн, без коммита). Коммитим только валидные по схеме поля (safeParse одного поля); бэкстоп — `validatePrototype` + сервер. Ключи из values вне схемы → JSON-поле (defensive).

### 5. `src/editor/EditorCanvas.tsx` — фокус-экран
- Runtime: `createPlayerRuntime(noopDeps, custom, doc.designSystem)` с **настоящим** registry (не CJM-заглушки — рендер должен быть верным; действия не сработают: no-op deps + перехват кликов).
- `useEffect(() => markDevtoolsActive(), [])` — включает `data-jr-key` (работает и в prod-сборке; cleanup при размонтировании).
- Spec: `toRuntimeSpec(screen.spec)` + `splitCanvasSpec(...).content` при `screen.canvas`; `initialState = mergeScreenState(doc.state, screen.stateOverrides)`.
- Ключ `JSONUIProvider`: `` `${runtimeKey}:${screen.id}:${JSON.stringify(initialState)}` `` — правки props НЕ ремаунтят (живое превью + сохранение runtime-состояния), правки state/stateOverrides и смена экрана — ремаунтят.
- Клик-выделение: обёртка `<div onClickCapture>` → `preventDefault/stopPropagation` → `(e.target as Element).closest("[data-jr-key]")` → dispatch. Без `inert` (он бы съел и наши клики).
- Рамка выделения: спан `display:contents` не имеет бокса → rect через `Range.selectNodeContents(span).getBoundingClientRect()` (объединяет детей, учитывает transform); overlay — absolute в relative-контейнере **вне** масштабируемого div; пересчёт в layout-effect по `[selection, doc, screenId]` + ResizeObserver; нулевой rect → без рамки (выбор остаётся виден в дереве).
- Масштаб: локальный `EditorFrame` по мотивам `DeviceFrame` (нативная ширина = `screen.canvas?.width ?? {mobile:390,tablet:834,desktop:1280}[doc.device]`, scale-to-fit, `transformOrigin: top left`). Error boundary по образцу `ScreenErrorBoundary`.

### 6. `src/editor/ElementTree.tsx` + `src/editor/InspectorPanel.tsx`
- Дерево: обход от `spec.root` по `children` с visited-set (защита от циклов); недостижимые элементы — свёрнутая группа «Вне дерева» (тоже выбираемы). Строки-кнопки `type · key`, `aria-current`, `scrollIntoView` при выборе с канваса.
- Панель, три секции: **Элемент** (дерево + заголовок типа + `PropsForm` по `definitions[type]`; неизвестный тип → JSON всего props) · **Экран** (name, note textarea — пустая → удалить ключ, canvas w/h парой «оба или ничего», stateOverrides JSON с валидацией `z.record(z.string(), jsonValueSchema)`) · **Прототип** (name, description, startScreen — select по экранам, device — select).

### 7. `src/editor/EditorShell.tsx` + `EditorView.tsx` + `EditorScreenStrip.tsx`
- `EditorShell`: `useParams().protoId` → `<PrototypeLoader protoId>` (без version — драфт по построению) → `EditorView`.
- `EditorView`: `useReducer` (init: `doc: loaded.doc, baseRev: loaded.rev, selection.screenId = startScreen ∈ screens ? startScreen : screens[0].id`); memo runtime и `definitions = { ...getDesignSystem(doc.designSystem).definitions, ...custom?.definitions }`. Layout: топбар / лента / flex-ряд: канвас (flex-1) + панель (~360px, overflow-y-auto).
- Топбар: назад → `/p/${doc.id}/cjm`, имя + индикатор dirty, Save + зона статуса. Save-флоу: `validatePrototype` → при errors список issues (блок); иначе `savePrototype(doc.id, doc, baseRev)` → `saved{rev}` (без перезагрузки) / 422 → issues / 409 → баннер «Черновик изменён (rev N)» с кнопкой «Перезагрузить черновик (правки будут потеряны)» → `getPrototypeDraft` → `reset`. `beforeunload` при dirty.
- Лента: `<ol>` тайлов по рецепту `CjmScreenTile` (реюз `CjmFrame`, `TileErrorBoundary`, `createCjmRegistry(registry)`, per-tile `JSONUIProvider` + `inert`), но overlay — `<button aria-pressed>` с `select-screen` вместо `Link`; ключ `${runtimeKey}:${screen.id}`, spec — текущий из редактируемого doc (тайлы тоже живые).

### 8. Роутинг и точки входа (модификации)
- `src/app/routes.tsx`: `<Route path="p/:protoId/edit" element={<EditorShell />} />`.
- `src/gallery/GalleryPage.tsx`: ссылка «Редактор» рядом с «CJM» у черновика.
- `src/cjm/CjmView.tsx`: ссылка «Редактировать» в шапке, только для черновика (`!routeBase.includes("/v/")`).

### 9. Тесты
- `docMutations.test.ts`: иммутабельность, удаление ключей при `undefined`, no-op на неизвестных id.
- `propsForm/introspect.test.ts`: на реальных нормализованных definitions (`getDesignSystem("shadcn").definitions`) — маппинг text/select/boolean/number, optional/default, JSON-fallback, null для необъектной схемы.
- `EditorShell.test.tsx` (паттерн мока fetch из `CjmShell.test.tsx`): загрузка драфта, выбор в дереве, правка текста → превью обновилось, Save шлёт PUT с baseRev; кейс 409 → баннер.
- `e2e/dev/editor.spec.ts`: **создать свой прототип** через `POST /api/prototypes` (не трогать `hello-world` — его мутирует `api.spec.ts`), открыть `/p/<id>/edit`, клик по текстовому элементу на канвасе, правка текста, Save, переход в плеер `/p/<id>/s/<screen>` — новый текст, перезагрузка редактора — сохранилось.

## Риски и митигации
1. `display:contents` без бокса → rect через Range; невидимые элементы выбираются деревом.
2. `markDevtoolsActive` — глобальный флаг: пока редактор смонтирован, спаны появятся в любых json-render-деревьях (визуально нейтрально: `display:contents`); cleanup при размонтировании.
3. Интерактивные компоненты и клики: `onClickCapture` + `stopPropagation` глушат React-onClick в том же руте; навигация невозможна (no-op deps).
4. Пробелы интроспекции zod (union/record/lazy/refine) → JSON-fallback; корректность страхуют `validatePrototype` и сервер.
5. Гонки ревизий → уже решены CAS: 409 + явный reset, без auto-merge.

## Верификация
1. `npm run verify` (typecheck, lint, unit, build, validate:prototypes — редактор не добавляет stories, drift-check не задет).
2. `npm run e2e` (минимум dev-проект с новой `editor.spec.ts`).
3. Runtime-прогон по `/verify`-скиллу: открыть `/p/checkout/edit` (там `$state`/`$bindState` — проверить JSON-fallback динамических значений), прототип с canvas/hotspot — рендер и выбор; правка текста → Save → проверка в плеере и CJM; скриншоты.

## Процесс (per CLAUDE.md workflow)
После утверждения: план сохраняется в `docs/plans/2026-07-11-editor-step1-inspector.md` и коммитится → адверсариальное ревью Codex gpt-5.6-sol (max) → триаж находок в плане → декомпозиция на `--fresh` Codex-задачи с file ownership (естественные зоны: §1–3 чистые модули ‖ §4–6 UI-компоненты ‖ §7–8 shell/routing ‖ §9 тесты после), независимая верификация done-критериев, поэтапные коммиты.
