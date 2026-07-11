# Редактор прототипов, шаг 1: инспектор настроек компонентов/экранов на базе CJM-вида

Ревизия 3 (после двух раундов адверсариального ревью Codex, триаж — в конце файла).

## Context

Первый шаг роадмапа «редактор»: возможность быстро поменять текст и другие настройки компонентов и экранов прямо в UI, без ручной правки JSON через API. Пользователь выбрал компоновку на базе CJM-вида: лента экранов как навигатор + крупный фокус-экран (клик по элементу = выбор) + панель инспектора справа + явная кнопка «Сохранить».

Вся инфраструктура уже есть, не хватает только UI:
- **Метадата для форм**: у каждого компонента есть Zod-схема props (`ComponentDefinition.props`, `src/catalog/normalize.ts`); zod 4.4.3.
- **Выделение по клику**: json-render оборачивает каждый элемент (включая root и hotspot-руты) в `<span data-jr-key={key} style="display:contents">`, когда активен devtools-флаг; `markDevtoolsActive(): () => void` из `@json-render/core` (возвращает cleanup). Ключи элементов стабильны и совпадают с ключами `screen.spec.elements` (`toRuntimeSpec` сохраняет их 1:1 — подтверждено ревью).
- **Сохранение**: `savePrototype(id, doc, baseRev)` в `src/api/client.ts`; сервер валидирует двухступенчато (schema parse + `validatePrototype`) → 422 `{issues}`; CAS по ревизии → 409 `{currentRev}`.
- **Переиспользуемое**: `PrototypeLoader` (render-prop: `{loaded: PrototypeDraft, custom, runtimeKey, routeBase}`; `custom.definitions` доступны клиенту — подтверждено), `CjmFrame`/`TileErrorBoundary` (`src/cjm/CjmScreenTile.tsx`), `createCjmRegistry`, `mergeScreenState`, `toRuntimeSpec`, `splitCanvasSpec`, canvas-рендер двух слоёв (`ScreenView.tsx:47-52`), no-op nav deps (паттерн `CjmView`).

## Решения (зафиксированы с пользователем + ревизия 2)

- Роут `/p/:protoId/edit`, **только черновик**. Оболочка `EditorShell` по образцу `CjmShell`.
- Выделение: hit-test поверх канваса + дерево элементов в панели.
- Превью на канвасе **инертно и без обработчиков**: рендер под `inert` (блокирует ввод/фокус) + прозрачный hit-test-оверлей + **spec превью строится без `on`-обработчиков** (`stripSpecEvents` после `toRuntimeSpec`) — `emit` компонентов становится no-op, встроенные state-actions недостижимы. Граница гарантий: для built-in каталогов состояние превью равно `initialState`; кастомные компоненты теоретически могут мутировать state программно из эффектов — это документированная граница (тест фиксирует поведение emit-on-mount). Канвас служит только для просмотра и выбора.
- Инспектор: props выбранного элемента (автоформа из Zod) · экран: name, note, stateOverrides (JSON), canvas w/h · документ: name, description, startScreen, device.
- Сохранение: Save → **двухступенчатая пре-валидация** (`prototypeDocSchema.safeParse` → `validatePrototype`) → PUT c baseRev, **отправляется `parsed.data`** (schema применяет trim/defaults), после успеха editor doc заменяется нормализованным `parsed.data`; 422 → issues, 409 → баннер конфликта с «Скопировать локальный JSON» (fallback при недоступном clipboard: модал с выделенным JSON) и «Перезагрузить черновик» (полный remount `PrototypeLoader` — свежие doc + custom runtime + manifest).
- Live-превью: правки props сразу видны на фокус-экране и тайлах ленты (spec — проп `Renderer`); правки state/stateOverrides ремаунтят провайдеры: в `EditorState` — счётчик `stateEpoch` (инкремент при любом изменении `doc.state`/`stateOverrides`), входит в ключи **обоих** превью. Никакого `JSON.stringify(state)` в render (state может быть большим — серверный лимит тела 1 MiB).

**Вне скоупа шага 1**: добавление/удаление/перестановка элементов и экранов, редактирование `on`/`visible`, undo/redo, правка опубликованных версий, drag хотспотов, автосейв, diff при конфликте, редактирование исходников кастомных компонентов.

## Реализация (новый каталог `src/editor/`)

### 0. Подготовка переиспользуемых кусков (модификации существующих модулей)
- `src/prototype/validate.ts`: **экспортировать** state-aware хелпер поэлементной валидации props: `validateElementProps({ definition, props, state, path }): { errors, warnings }` — выделить общий внутренний примитив, которым пользуется и `validatePrototype` (проверки `$state`/`$bindState`/RFC 6901-путей требуют effective state — реализации не должны разойтись), плюс предикат `isDynamicValue`. PropsForm передаёт `mergeScreenState(doc.state, screen.stateOverrides)`.
- `src/editor/stripSpecEvents.ts` (или рядом с runtimeSpec): снять `on` со всех элементов runtime-спека превью — обработчики недостижимы даже программно.
- Canvas-рендер двух слоёв (content + hotspots, рецепт `ScreenView.tsx:47-52`) вынести в общий компонент `src/player/CanvasLayers.tsx` (`{ canvas, specs, registry }`), использовать в `ScreenView` и `EditorCanvas` — hotspot-элементы видны и выбираемы в редакторе (у каждого hotspot-спека root=id элемента, спаны data-jr-key присутствуют). Компонент editor-agnostic (без inert/selection/devtools). **Regression-тесты обязательны**: unit `CanvasLayers` (content+hotspots, hotspot-only root, stacking/pointer-events) + интеграционный `ScreenView` (hotspot по-прежнему вызывает navigate).

### 1. `src/editor/docMutations.ts` — чистые иммутабельные хелперы
```ts
setElementProps(doc, screenId, elementKey, props): PrototypeDoc
patchScreen(doc, screenId, patch: Partial<Pick<Screen,"name"|"note"|"stateOverrides"|"canvas">>): PrototypeDoc
patchDocMeta(doc, patch: Partial<Pick<PrototypeDoc,"name"|"description"|"startScreen"|"device">>): PrototypeDoc
```
`undefined` в patch = удаление ключа; no-op возвращает тот же reference. Тип doc в редакторе — `PrototypeDoc`, но контент считается непроверенным до save (валидирует save-флоу, не типы).

### 2. `src/editor/editorReducer.ts` — состояние редактора
`EditorState { doc, baseRev, dirty, stateEpoch, selection: { screenId, elementKey|null } }`; экшены `select-screen` (сбрасывает elementKey), `select-element`, `set-element-props`, `set-screen-meta` (инкремент `stateEpoch` при изменении `stateOverrides`), `set-doc-meta` (инкремент при изменении `state`), `saved {rev, doc}` (заменяет doc нормализованным `parsed.data`, dirty=false, baseRev=rev). Экшена `reset` нет: восстановление после 409 — полный remount `PrototypeLoader` (см. §7).

### 3. `src/editor/propsForm/introspect.ts` — Zod → описание формы
`describePropsSchema(schema): PropField[] | null` (null = не объект → JSON-редактор всего props).
- Разворачивание обёрток: `ZodOptional`/`ZodNullable`/`ZodDefault`/`ZodReadonly`/`ZodCatch`/`ZodPrefault`; `ZodPipe` → входная схема.
- Маппинг: `ZodString`→text · `ZodEnum`→select (`.options`) · **union литералов → select** (реальный каталог использует `z.union([z.literal(...)])`, в т.ч. числовые — select с типизированными значениями) · `ZodLiteral`→select(1) · `ZodBoolean`→switch · `ZodNumber`→number · всё остальное → `{kind:"json"}`.
- Тест-матрица по **всем** definitions обеих дизайн-систем (см. §9) — фиксирует, какие поля какого kind, чтобы scalar-поля не проваливались в JSON молча.

### 4. `src/editor/propsForm/PropsForm.tsx`
`({ definition, values, onCommit })`.
- Динамические значения (предикат `isDynamicValue` из validate.ts) → JSON-textarea «динамическое значение», независимо от типа поля.
- Коммит: select/switch — on change; text/number — on blur/Enter; JSON — on blur.
- **Валидация целого объекта**: на каждый коммит собирается кандидат всего `props`; проверка через `validateElementProps({definition, props: candidate, state: mergeScreenState(doc.state, screen.stateOverrides), path})` — та же логика, что на save/сервере (strictness, cross-field, `$state`/`$bindState`-пути против effective state); ошибки отображаются по путям у полей; невалидный кандидат не коммитится. Редактор хранит **schema input** (не output `ZodPipe`) — задокументировать, тест с различающимися input/output.
- Все JSON-поля: `JSON.parse` → `jsonValueSchema.safeParse` (гарантия JSON-сериализуемости); ошибка — инлайн, без коммита.
- Ключи values вне схемы → JSON-поле (defensive).

### 5. `src/editor/EditorCanvas.tsx` — фокус-экран
- Runtime: `createPlayerRuntime(noopDeps, custom, doc.designSystem)` с настоящим registry (верный рендер; действия недостижимы — события блокированы).
- `useEffect(() => markDevtoolsActive(), [])` (cleanup при размонтировании; на время работы редактора спаны появятся и в тайлах — визуально нейтрально, display:contents).
- Spec: `stripSpecEvents(toRuntimeSpec(screen.spec))`; при `screen.canvas` — **оба слоя** через `CanvasLayers` (content + hotspots); без canvas — обычный `Renderer`. Пустой/отсутствующий root → плейсхолдер «Нет содержимого» (рецепт CjmScreenTile), инспектор доступен, save заблокируется валидацией.
- `initialState = mergeScreenState(doc.state, screen.stateOverrides)`; ключ провайдера `` `${runtimeKey}:${screen.id}:${stateEpoch}` `` (правки props не ремаунтят, правки state/stateOverrides — ремаунтят через epoch).
- **Изоляция и выбор**: рендер-обёртка с `inert` + спек без `on` + прозрачный оверлей `absolute inset-0`; клик по оверлею → `document.elementsFromPoint(clientX, clientY)` → пропустить оверлей, брать кандидатов **по порядку** (topmost first — приоритет hotspot над контентом сохраняется), фильтр `previewRootRef.current.contains(candidate)` (не frame/оверлей/соседние json-render-деревья — devtools-флаг тегирует и тайлы), для первого подходящего — `.closest("[data-jr-key]")`, и принять только если tagged-предок сам внутри preview root → dispatch. Мимо элементов → снять выбор.
- Рамка выделения: `Range.selectNodeContents(span).getClientRects()` — рендер **набора** ректов. **DOM-инвариант геометрии**: `EditorFrame` = нетрансформированный relative-viewport, внутри — scaled-div (transform: scale, origin top-left) с превью, а hit-test-оверлей и слой рамок — **siblings scaled-div внутри viewport** (вне transform, иначе scale применится дважды); координаты = `rect.left - viewportRect.left` (+ scroll offsets), post-transform ректы масштабно-корректны. Пересчёт в layout-effect по `[selection, doc, screenId]` + ResizeObserver; пустой набор (портал/null/невидимый) → без рамки, выбор виден в дереве. Playwright-проверка рамки при масштабе <1.
- Масштаб: локальный `EditorFrame` по мотивам `DeviceFrame` (нативная ширина = `screen.canvas?.width ?? {mobile:390,tablet:834,desktop:1280}[doc.device]`, scale-to-fit, transformOrigin top left). Error boundary по образцу `ScreenErrorBoundary`.

### 6. `src/editor/ElementTree.tsx` + `src/editor/InspectorPanel.tsx`
- Дерево: обход от `spec.root` по `children` с visited-set; недостижимые элементы — свёрнутая группа «Вне дерева» (выбираемы). Строки-кнопки `type · key`, `aria-current`, `scrollIntoView` при выборе с канваса. Пустой `elements` → пустое состояние с подсказкой.
- Панель, три секции: **Элемент** (дерево + тип + `PropsForm`; неизвестный тип → JSON всего props) · **Экран** (name, note — пустая → удалить ключ, canvas w/h «оба или ничего», stateOverrides JSON: parse → `z.record(z.string(), jsonValueSchema)` + запрет ключей из `FORBIDDEN_STATE_KEYS` и лимит глубины из `src/prototype/stateOverrides.ts` — экспортировать при необходимости) · **Прототип** (name, description, startScreen — select по экранам, device — select).

### 7. `src/editor/EditorShell.tsx` + `EditorView.tsx` + `EditorScreenStrip.tsx`
- `EditorShell`: `useParams().protoId`; локальный `reloadKey` (number) → `<PrototypeLoader key={reloadKey} protoId>` → `EditorView({..., onReload: () => setReloadKey(k => k+1)})`. Перезагрузка после 409 обновляет **всё**: doc, rev, custom runtime, manifest.
- `EditorView`: `useReducer` (init: `doc: loaded.doc, baseRev: loaded.rev, selection.screenId = startScreen ∈ screens ? startScreen : screens[0].id`); memo runtime и `definitions = { ...getDesignSystem(doc.designSystem).definitions, ...custom?.definitions }`. Layout: топбар / лента / flex-ряд: канвас (flex-1) + панель (~360px, overflow-y-auto).
- Топбар: назад → `/p/${doc.id}/cjm`, имя + индикатор dirty, Save + зона статуса. Save-флоу: (1) `prototypeDocSchema.safeParse(doc)` — ошибки → issues, блок; (2) `validatePrototype(parsed.data, {definitions})` — errors → issues, блок; (3) `savePrototype(doc.id, parsed.data, baseRev)` — **отправляется нормализованный `parsed.data`** (trim/defaults) → `saved{rev, doc: parsed.data}` (локальный doc заменяется нормализованным) / 422 → issues / 409 → баннер «Черновик изменён (rev N)» с кнопками «Скопировать локальный JSON» (clipboard; при недоступности/отказе — fallback: модал с textarea и выделенным JSON + статус ошибки) и «Перезагрузить черновик (правки будут потеряны)» → `onReload()`. Отображение issues — единый адаптер, нормализующий оба формата (zod path-массивы и строковые JSON-pointer из `validatePrototype`). `beforeunload` при dirty.
- Лента: `<ol>`-**список экранов без стрелок** (стрелки CJM подразумевают линейный флоу, которого в модели нет; реальная навигация — из actions); тайлы по рецепту `CjmScreenTile` (реюз `CjmFrame`, `TileErrorBoundary`, `createCjmRegistry(registry)`, per-tile `JSONUIProvider` + `inert`), overlay — `<button aria-pressed>` с `select-screen`; спеки тайлов тоже через `stripSpecEvents`; ключ тайла `` `${runtimeKey}:${screen.id}:${stateEpoch}` `` — тайлы обновляются и при правках state/stateOverrides.

### 8. Роутинг и точки входа (модификации)
- `src/app/routes.tsx`: `<Route path="p/:protoId/edit" element={<EditorShell />} />`.
- `src/gallery/GalleryPage.tsx`: ссылка «Редактор» рядом с «CJM» у черновика.
- `src/cjm/CjmShell.tsx` → `CjmView`: проп `editable={version === undefined}`; ссылка «Редактировать» в шапке по нему (не по `routeBase.includes("/v/")`).

### 9. Тесты
- `docMutations.test.ts`: иммутабельность, удаление ключей при `undefined`, no-op на неизвестных id.
- `stripSpecEvents.test.ts` + тест границы гарантий: кастомный компонент с `emit` on mount — зафиксировать, что со снятым `on` state не мутирует.
- `CanvasLayers.test.tsx`: content+hotspots, hotspot-only root (content=null), stacking/pointer-events; интеграционный кейс в `ScreenView.test.tsx`: клик по hotspot вызывает navigate (regression production-плеера).
- `propsForm/introspect.test.ts`: **тест-матрица по всем definitions обеих дизайн-систем** (`getDesignSystem("shadcn"|"wireframe").definitions`) — ожидаемый kind каждого поля (text/select/switch/number/json), union-литералы (в т.ч. числовые) → select, optional/default/nullable, JSON-fallback только там, где ожидается, null для необъектной схемы.
- `PropsForm.test.tsx`: коммит целого объекта через state-aware `validateElementProps` (с effective state), динамическое значение → JSON-поле, невалидный JSON не коммитится, `ZodPipe` с различающимися input/output — редактируется input.
- `EditorShell.test.tsx` (паттерн мока fetch из `CjmShell.test.tsx`): загрузка драфта, выбор в дереве, правка текста → превью обновилось, Save шлёт PUT с baseRev; 409 → баннер, «Перезагрузить» перезапрашивает драфт; 422 обоих форматов → issues; экран без root → плейсхолдер, инспектор работает.
- `e2e/dev/editor.spec.ts`: создать прототип с **уникальным id** (`editor-e2e-<timestamp>`) через `POST /api/prototypes`, открыть `/p/<id>/edit`, клик по текстовому элементу на канвасе, правка текста, Save, проверка в плеере `/p/<id>/s/<screen>`, перезагрузка редактора — сохранилось; проверка рамки выделения при масштабе <1; **teardown в `finally`: запросить свежий draft → `DELETE` с его актуальным `rev`** (после Save исходный baseRev устарел; 404 = успешный cleanup). Не трогать `hello-world` (его мутирует `api.spec.ts`; dev-проект serial — задокументировать зависимость в спеке).

## Риски и митигации
1. `display:contents` без бокса → набор ректов через `Range.getClientRects()`; портал/null/невидимые — выбор через дерево.
2. `markDevtoolsActive` — глобальный флаг: спаны появятся во всех json-render-деревьях, пока редактор смонтирован (визуально нейтрально); cleanup при размонтировании.
3. Изоляция превью: `inert` (ввод/фокус) + спек без `on` (программные emit — no-op) + оверлей. Для built-in каталогов состояние превью = `initialState`; кастомные компоненты могут мутировать state из эффектов — документированная граница, зафиксирована тестом.
4. Пробелы интроспекции zod → JSON-fallback; корректность страхуют `validateElementProps` на коммитах, двухступенчатая пре-валидация на save и сервер.
5. Гонки ревизий → CAS 409 + копия локального JSON + полная перезагрузка loader (включая custom runtime).
6. Ремаунт превью при правках state — через счётчик `stateEpoch` в reducer (без сериализации state в render; `doc.state` может быть большим — лимит тела запроса 1 MiB).

## Верификация
1. `npm run verify` (typecheck, lint, unit, build, validate:prototypes).
2. `npm run e2e` (минимум dev-проект с новой `editor.spec.ts`).
3. Runtime-прогон по `/verify`-скиллу: `/p/checkout/edit` — динамические значения (`$state`/`$bindState`) → JSON-fallback; canvas-экран checkout — виден content **и hotspots**, hotspot выбирается кликом; правка текста → Save → проверка в плеере и CJM; конфликт (параллельный PUT через curl) → баннер; скриншоты.

## Триаж находок ревью (раунд 1)

| # | Severity | Находка | Решение |
|---|---|---|---|
| 1 | blocker | canvas-рендер терял hotspots (`splitCanvasSpec.content`) | **Принято**: общий `CanvasLayers` (рецепт ScreenView:47-52), оба слоя в редакторе, hotspot выбираем (§0, §5) |
| 2 | blocker | `validatePrototype` ≠ полная пре-валидация (нет schema parse) | **Принято**: двухступенчатый save-флоу — `prototypeDocSchema.safeParse` → `validatePrototype` (§7) |
| 3 | major | reset после 409 не перезагружал custom runtime | **Принято**: полный remount `PrototypeLoader` через `reloadKey`; экшен `reset` удалён (§7) |
| 4 | major | тайлы ленты со stale state (initialState — mount-time) | **Принято**: хеш initialState в ключе тайлов, как у фокуса (§7) |
| 5 | major | runtime-state превью мог уплыть от initialState | **Принято через п.6**: превью полностью инертно → состояние не мутирует; отдельный Reset не нужен (§5) |
| 6 | major | `onClickCapture+stopPropagation` не делает runtime read-only (pointerdown/change/keyboard/порталы) | **Принято**: `inert`-обёртка + прозрачный оверлей + `elementsFromPoint` вместо перехвата кликов (§5) |
| 7 | major | интроспекция узка: union-литералы (числовые select), Prefault/Catch/Readonly/Pipe | **Принято**: расширенная матрица разворачивания и маппинга + тесты по всем definitions обеих систем (§3, §9) |
| 8 | major | safeParse одного поля ломает strictness/cross-field | **Принято**: валидация целого props-кандидата через экспортированный `validateElementProps` (§0, §4) |
| 9 | major | JSON-fallback мог пропустить не-JSON значения | **Принято**: все JSON-поля через `jsonValueSchema`; stateOverrides + запрет ключей/глубина (§4, §6) |
| 10 | major | один union-rect ненадёжен для display:contents | **Принято**: `getClientRects()` → набор ректов (§5) |
| 11 | major | не определено поведение пустого elements/отсутствующего root | **Принято**: плейсхолдер, инспектор доступен, save блокируется валидацией; тесты (§5, §6, §9) |
| 12 | major | стрелки ленты утверждают линейный флоу | **Принято**: лента редактора — список экранов без стрелок (§7). В самом CJM-виде стрелки не трогаем — вне скоупа |
| 13 | minor | `routeBase.includes("/v/")` хрупко | **Принято**: проп `editable={version === undefined}` из `CjmShell` (§8) |
| 14 | minor | конфликт-UX только с уничтожением правок | **Принято частично**: кнопка «Скопировать локальный JSON»; diff/save-as-copy — вне скоупа шага 1 (§7) |
| 15 | minor | два формата issues (zod path-массивы vs строковые пути) | **Принято**: единый адаптер отображения + тесты обоих форматов 422 (§7, §9) |
| 16 | minor | e2e: уникальность id и cleanup | **Принято**: уникальный id + DELETE в teardown + комментарий о serial-зависимости (§9) |

## Триаж находок ревью (раунд 2)

| # | Severity | Находка | Решение |
|---|---|---|---|
| 1 | blocker | `inert` не гарантирует детерминизм: effects/таймеры/программный `emit` (особенно custom-компоненты) | **Принято**: спек превью без `on` (`stripSpecEvents`) → emit no-op; граница гарантий для custom задокументирована + тест emit-on-mount (§0, §5) |
| 2 | major | `validateElementProps(definition, props)` без effective state ≠ логика save | **Принято**: state-aware контракт `{definition, props, state, path} → {errors, warnings}`, общий примитив с `validatePrototype` (§0, §4) |
| 3 | major | сохранялся `doc`, а не `parsed.data` (trim/defaults терялись локально) | **Принято**: PUT отправляет `parsed.data`; `saved {rev, doc}` заменяет локальный doc нормализованным (§2, §7) |
| 4 | major | hit-test неспецифицирован: соседние деревья/фрейм/приоритет hotspot | **Принято**: `previewRootRef` + фильтр `contains` кандидата и его tagged-предка, порядок elementsFromPoint (topmost first) сохраняет приоритет hotspot; тесты со scale/hotspot/несколькими деревьями (§5) |
| 5 | major | координатная модель рамок не фиксировала DOM относительно transform | **Принято**: DOM-инвариант — оверлей и рамки siblings scaled-div внутри нетрансформированного viewport; Playwright-проверка при scale <1 (§5) |
| 6 | major | `CanvasLayers` меняет production-плеер без regression-тестов | **Принято**: unit `CanvasLayers` + интеграционный `ScreenView` (hotspot → navigate); компонент editor-agnostic (§0, §9) |
| 7 | major | `JSON.stringify(initialState)` в ключах — state может быть ~1 MiB, stringify на каждый render каждого тайла | **Принято**: счётчик `stateEpoch` в reducer вместо сериализации (§2, §5, §7) |
| 8 | minor | `ZodPipe → input` — семантика input/output | **Принято**: редактор хранит schema input, задокументировано + тест (§4, §9) |
| 9 | minor | e2e teardown с устаревшим rev | **Принято**: `finally` → свежий draft → DELETE с его rev; 404 = успех (§9) |
| 10 | minor | clipboard может быть недоступен | **Принято**: fallback-модал с выделенным JSON + статус ошибки (§7) |

## Процесс (per CLAUDE.md workflow)
Раунды 1–2 ревью пройдены, все находки приняты (см. таблицы триажа). Раунд 3 — подтверждающий (`--resume`): проверить, что ревизия 3 закрывает blocker/major раунда 2. После снятия блокирующих возражений — декомпозиция на `--fresh` Codex-задачи с file ownership: волна A: §0–§3 (validate.ts export + CanvasLayers + docMutations/reducer/introspect — чистые модули, непересекающиеся файлы) → волна B: §4–§7 (PropsForm, EditorCanvas, дерево/панель, shell/view/лента) + §8 (routing) → волна C: §9 тесты + финальная верификация оркестратором (`npm run verify`, `npm run e2e`, `/verify`-скилл).
