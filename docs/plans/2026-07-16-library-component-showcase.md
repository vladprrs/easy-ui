# Витрина custom-компонентов в Library: страница компонента с живым превью, контролами и доками

Дата: 2026-07-16 · Статус: v4 после раундов 1–3 Codex-ревью (триаж в §6)

## 1. Контекст и цель

Фокус продукта — пользовательские дизайн-системы и компоненты (создаваемые через `POST /api/design-systems` / `POST /api/components`, хранимые в SQLite, компилируемые сервером в браузерные ESM-бандлы). Сейчас у builtin-систем (shadcn/wireframe) есть полноценная витрина — Storybook с Controls и Docs, а custom-компоненты показываются в Library только meta-карточкой с capture-iframe (`src/library/LibraryPage.tsx`, `ComponentMetadata`). Асимметрия принципиальна: Storybook — build-time артефакт и не может показывать runtime-данные из БД.

**Цель:** сделать custom-компоненты первосортными гражданами продукта — страница компонента в Library с:
1. живым превью (тот же рантайм, что у плеера);
2. панелью контролов, сгенерированной из схемы props (аналог Storybook Controls);
3. докстраницей из `definition_meta` (props-таблица, события, слоты, примеры) и вкладкой с исходником (аналог Storybook Docs).

**Не цель (out of scope):** паритетная миграция builtin-компонентов на эту витрину; markdown-доки в publish-контракте; изменение publish-пайплайна и `definition_meta`; sandbox-изоляция недоверенного кода (D1); content-versioned shim ABI (компенсация — W0.5); namespace-инг font-family custom-тем (принятое ограничение, D6).

Рассмотренные и отклонённые альтернативы:
- **Storybook composition (refs):** даёт дерево+рендер, но Controls/Docs для ref-историй не работают — а они прямое требование.
- **Отдельный storybook-проект с пересборкой по кнопке:** настоящие Controls/Docs, но минутная задержка publish→витрина ломает основной цикл (роадмап: AI-генерация), второй рантайм требует синхронизации с плеером (ABI, `wrapCustomComponent`, темы), сборка от пользовательских данных хрупка, инфраструктурный хвост (сборка на прод-сервере запрещена).

## 2. Ключевые решения

### D1. Превью рендерится инлайн; precondition — published-код доверен

**Модель доверия (явный precondition):** published-код компонентов доверен как repository-equivalent код в single-user workspace либо authenticated deployment (реальная trust-модель проекта: single-user loopback без auth по умолчанию, BasicAuth обязателен для non-loopback — `docs/server-api.md`). Инлайн-рендер **не является** security boundary: компонент исполняется в realm SPA уже на `import()` (до всякого error boundary) и технически может обращаться к `window`/`fetch`/DOM; module-level side effects живут после ухода со страницы. Существующий same-origin capture-iframe без атрибута `sandbox` — тоже не boundary, инлайн не ослабляет текущую позицию. Недоверенный/мультитенантный контент потребует sandbox на отдельном origin — prerequisite той фазы, не MVP.

**Инженерное обоснование инлайна:** плеер и редактор уже рендерят custom-компоненты инлайн (`loadCustomComponents` → `Renderer`/`CaptureSurface` + `ThemeStyle` + `SurfaceSpacingScope`); живые контролы = React-стейт, без межфреймового протокола. Новая страница первая совмещает app-header `Layout` и runtime-компонент — containment-политика в D6/W0.2.

Capture-shell не трогаем — он остаётся контрактом скриншот-воркера и visual regression.

### D2. Контролы — из живой zod-схемы через вынесенное ядро PropsForm

Форма редактора (`src/editor/propsForm/PropsForm.tsx` + `describePropsSchema`) уже schema-driven и работает с custom-компонентами; живая zod-схема доступна из загруженного бандла (`definitions[name].props`). Полный API выноса — W1. Отклонено: рендерер форм из `propsJsonSchema` — второй параллельный механизм.

Известные ограничения (приняты): (а) persisted `propsJsonSchema` и live-схема — результаты двух исполнений definition, могут разойтись; контролы/превью — только live, docs-таблица — только persisted, точки смешения нет; (б) **async-валидация zod не запрещена publish-контрактом** (`.parse()` на publish проверяет только examples): синхронный `safeParse` схемы с async refinement бросает `$ZodAsyncError` — все исключения схемы конвертируются в form-level ошибку «схема требует асинхронной валидации, живые контролы недоступны», страница не падает, docs/код работают (W1).

### D3. Docs-таблица props — из `propsJsonSchema`, не из zod-интроспекции

`describePropsSchema` теряет `.describe()` и min/max; `propsJsonSchema` (тип `unknown`, best-effort) несёт descriptions, enum'ы, дефолты, required. Поддерживаемый subset и fallback — W2.

### D4. Роут `/library/c/:componentId`, версия — query `?v=<n>`; манифест не является источником версии

Custom entry идентифицируется парой `(componentId, designSystem)` — один id может жить в нескольких системах. Поэтому:

- разрешение версии: `GET /api/components/:id` (`ComponentMeta`, no-store; поле `publishedVersion` добавляется в клиентский тип — W0.4). Сервер считает `publishedVersion` только по `active`-версиям, поэтому его отсутствие означает «нет active-версии», **не** «нет опубликованных». Правило выбора без `?v`: `publishedVersion` → иначе новейшая renderable-версия (`deprecated | superseded`) → иначе страница со списком версий/статусов и docs недоступны («нет исполняемых версий»). Тест-кейсы: deprecated-only, superseded-only;
- `?v=<n>`: строгая грамматика — ровно один параметр, `^[1-9][0-9]*$`, `Number.isSafeInteger`; нарушение → «некорректный адрес» (отличается от «версия не найдена» = 404 API);
- дизайн-система и тема — из **выбранной версии** (`ComponentVersion.designSystem`);
- все ссылки из Library — с явной версией `?v=${component.version}`;
- смена версии сбрасывает контролы к initial-состоянию новой версии, сохраняет активную вкладку.

### D5. Превью-состояние: `previewProps: none | valid(rawProps)`; черновик формы отделён

Два уровня:
- `draftProps` — содержимое полей; накапливается всегда, в том числе при ошибках других полей (иначе компонент с несколькими required-props незаполняем);
- `previewProps` — `none` либо последний **schema-valid** raw-снапшот. Initial candidate (`example` версии, если есть, иначе `{}`) прогоняется через live `safeParse`: успех → `valid(candidate)`, неуспех → `none` — превью показывает «заполните обязательные props», компонент **не монтируется** (невалидные props не попадают в рендер никогда; это же снимает противоречие с error-boundary-тестом). Каждый коммит поля → whole-schema `safeParse(draftProps)`: успех продвигает снапшот, ошибка — inline/form-level ошибки, превью остаётся на прежнем состоянии (`none` или прежний valid).

Пресеты из `examples` перед применением проходят тот же safeParse; невалидный для версии пресет дизейблится с подсказкой. Publish допускает компоненты без example (smoke-warning, не ошибка) — состояние `none` обязательное, не корнеркейс.

### D6. Тема — латест темы DS выбранной версии; без `.dark`, без мутаций `<html>`; font leakage — принятое ограничение

Загрузка как в capture: `getDesignSystemById(version.designSystem)` → тема через централизованный theme-manager (W0.2) + `SurfaceSpacingScope`. **`useCaptureTheme` не переиспользуется** (он вешает `.dark` на `<html>`, перекрашивая shadcn-переменные всего шелла). Переключатель «светлый/тёмный» меняет только фон превью-области локальным классом (семантика «посмотреть на тёмном фоне», не theme simulation). Тест-инвариант: страница не мутирует `<html>`.

Containment честно: `--eui-*`-токены app-шеллом не потребляются (тест: computed-style header по цветам/отступам не меняется при монтировании темы). **Ограничение (принято):** `@font-face` глобален, сервер допускает произвольные family-имена, включая совпадающие с app-шеллом (`YS Text`, `Coil`) — коллизия family/weight может подменить фактический шрифт header при неизменной строке computed-style. Не маскируем: фиксируем как известное ограничение inline-подхода (as-is оно есть и у Gallery-превью). Follow-up вне MVP: namespace-инг font-family. Запрет системных имён на сервере отклонён: сломал бы существующие prod-темы (yandex-pay использует YS Text намеренно).

### D7. Гейт исполнения по статусу — UX-гейт по свежему snapshot meta, не security-механизм

Исполняемое превью строится только для версий `active | deprecated | superseded` **по данным no-store `ComponentMeta` на момент загрузки страницы**. Для `rejected | archived | failed | staging` бандл не запрашивается и не импортируется; страница показывает docs/код и блок «исполнение запрещено статусом». Честные границы: статус изменяем, bundle URL immutable-кешируется на год, ранее загруженный модуль неотзываем — гонка «meta → import» возможна и принята (это UX-гейт для доверенного контента, см. D1, не защита). Проверка живёт **на странице**, не в общем loader'е: плеер по контракту рендерит пины `deprecated/superseded` и не должен получить новый гейт. Полные статусные лейблы — на странице (`statusBadge.ts` сознательно неполон).

### D8. Превью рендерит raw input props; дефолты схемы — только подсказки

Паритет с плеером: json-render передаёт компоненту raw `element.props` без `parse()`, компоненты по контракту оборонительны. Превью рендерит raw-снапшот `previewProps.valid`, не `safeParse(...).data`. Дефолты схемы показываются как **подсказки** (docs-таблица; hint у контрола), но не материализуются в raw candidate — включая select/boolean без нативного placeholder (для них — явное состояние «не задано», W1). Тесты: defaulted string/number/enum/boolean — UI показывает hint, untouched raw props остаются `{}`; reset поля удаляет ключ. Пресеты: legacy `example` (в UI — существующее имя `default`) + именованные `examples`; отдельного пресета «дефолты схемы» нет.

## 3. Декомпозиция работ и file ownership

DAG: **(W0 ∥ W1 ∥ W2) → W3 → (W4 ∥ W5a) → W5b**. Каждая задача — отдельный `--fresh` диспатч Codex `--write --effort medium`; коммиты — оркестратор после независимой проверки done-критериев.

### W0. Foundation: shared runtime, theme-manager, loader, API-типы, пины

**Владение:** `src/customComponents/shared.ts`, `src/customComponents/loader.ts`, `src/designSystems/theme.tsx`, `src/gallery/GalleryPreview.tsx` (адаптация к theme-manager'у), `src/api/client.ts`, `package.json` + `package-lock.json`, `server/shims/**` (только тесты), tracked-фикстуры compiled-бандлов, тесты всех перечисленных.

1. **`ensureEasyUiShared()`** — идемпотентно дозаполняет core-модули в `globalThis.__easyUiShared` даже при частичной инициализации; вызывается из `shared.ts`, loader'а перед `import()`, theme-manager'а вместо `??= {}`. Баг воспроизводим уже сегодня: `loader.ts` подключает `shared.ts` только динамическим импортом, `theme.tsx` — только типами, так что `ThemeStyle`, смонтированный до первой загрузки бандла (Gallery), создаёт пустой объект, который `shared.ts` (`??=`) не дозаполнит. Юнит-тест проверяет реальный порядок модулей (theme-эффект до динамического импорта shared).
2. **Централизованный theme-manager вместо независимых `ThemeStyle`.** Semantics: **single active theme на document** (честная фиксация фактического поведения: `:root`-переменные и так глобальны, «мульти-темность» Gallery — иллюзия каскада). Manager держит реестр владельцев и управляет **одним** style-узлом и runtime-снапшотом (`tokens`/`icons`) атомарно — CSS и `token()`/`Icon()` не могут разойтись (сейчас победителя CSS определяет DOM-порядок style-тегов, а снапшота — порядок эффектов; при асинхронных Gallery-превью они различаются). **Приоритет владельца детерминирован и не зависит от сети:** владелец регистрируется на mount (до асинхронной загрузки content) со стабильным order-key (порядок регистрации mount-эффектов = порядок дерева), активен последний зарегистрированный владелец с непустым `content`; поздний resolve сети не переставляет приоритет (в Gallery порядок карточек, а не гонка загрузок draft'ов, определяет победителя между перезагрузками). `ThemeStyle` становится тонким клиентом manager'а с тем же props-API; `GalleryPreview.tsx` — во владении W0 (адаптация к регистрации-до-content). Покрыть: не-LIFO unmount (A→B→unmount A), противоположные порядки resolve A/B → один и тот же победитель, обновление `content` владельца без смены порядка, `content=null`, StrictMode double-effect, HMR-переживаемость, восстановление baseline после последнего unmount; A/B-тесты сверяют одновременно CSS-переменную и `token()`.
3. **Loader = только shared transport/retry, без generation.** Rejected import: запись удаляется из `moduleCache` **только если всё ещё содержит тот же rejected promise**, а повторная попытка использует новый URL `bundle.js?retry=<n>` (канонический первый URL — без суффикса): браузер кеширует неуспешный ESM-load по URL, повторный `import()` того же URL не делает сетевого запроса (воспроизведено в ревью). **Граница retry-механизма:** суффикс bust'ит только корневой модуль — статически импортируемые `/api/shims/vN/*.js` при своём отказе остаются отравленными в module map независимо от суффикса (воспроизведено в ревью). Политика: SPA-retry покрывает отказ верхнего bundle; отказ зависимости (shim) детектируется по URL в ошибке импорта и предлагает **full-document reload** (новый module map) вместо бессмысленного повторного `import()`. Generation/отмена — ответственность потребителя (W3): у loader'а общий кеш, abort одного потребителя не должен ронять другого ждущего тот же URL. Тесты: retry bundle после 500 → новый сетевой запрос и успех; отказ shim → предлагается reload, повторный SPA-retry не выполняется; два concurrent-потребителя одного URL, отмена одного не мешает второму.
4. **`ComponentMeta.publishedVersion`** — добавить в клиентский тип (сервер отдаёт).
5. **Пины shim-backed зависимостей + ABI-гейт.** Exact-pin по **фактическому lockfile**: `zod` 4.4.3 (не `^4.3.6` из манифеста — иначе тихий downgrade), `react`/`react-dom` — точные версии из lock. Тест, превращающий ABI-drift shim'ов из console-warning в падение `npm run verify`. Compat-прогон исторических бандлов: в репозиторий коммитятся **зафиксированные скомпилированные байты** бандлов ABI v1–v3 (tracked test-фикстуры), и тест исполняет именно их против текущих shim'ов — не перекомпиляцию исходников текущим toolchain'ом (она маскировала бы дрейф). Content-versioned shim ABI остаётся follow-up — при таком upgrade-gate это компенсировано.

Done-критерии: юнит-тесты 1–3, 5 зелёные; `npm run verify` зелёный; grep-инвариант: нет `__easyUiShared ??=` вне `ensureEasyUiShared`; e2e плеера/галереи не регрессят.

### W1. Вынос ядра PropsForm из редактора

**Владение:** `src/editor/propsForm/**`, новый `src/propsForm/**`, `src/app/strings/propsForm.ts` (новый). `src/catalog/zodIntrospect.ts` — только чтение.

Развязываемая сцепленность: `validateElementProps`/`isDynamicValue`, `DocEpochContext`, `uploadAsset`/`EditorAsset`, строки `editor.*`, `jsonValueSchema`, form-level ошибки/path-маппинг, `JsonWholeProps`-fallback.

Контракт ядра:
- **`onCandidate(candidate, validation)`** — вызывается на каждый синтаксически разобранный коммит поля, включая невалидные по схеме: `validation = { ok: true } | { ok: false; fields: Record<string,string>; form?: string }`. Editor-адаптер диспатчит в документ только `ok`; showcase-адаптер всегда сохраняет candidate как draft и отдельно продвигает valid-снапшот (реализация D5). Текущее поведение «не вызывать `onCommit` при ошибке» остаётся особенностью editor-адаптера, не ядра;
- `validate(candidate) => validation` — синхронный инжектируемый валидатор; **все исключения** валидатора/схемы (в т.ч. `$ZodAsyncError` от async refinement) перехватываются и конвертируются в form-level ошибку (D2b), не в падение. **Перехват покрывает и интроспекцию, не только валидацию candidate:** `describePropsSchema` сам вызывает `safeParse(undefined/null)` при извлечении дефолтов/контролов и бросает на async-схеме — описание полей, извлечение defaults и выбор контролов исполняются внутри того же защитного контура; при исключении интроспекции — form-level ошибка + JSON-fallback формы;
- отображаемое значение поля — **не** `values[name] ?? defaultValue`: дефолт — hint (placeholder/подпись), у select/boolean — явное состояние «не задано»; явный `null` отличим от отсутствия ключа;
- optional/nullable: unset для optional любых типов (включая boolean/string), выбор `null` для nullable; reset удаляет ключ;
- `renderAssetField?`, `epoch?`, строки — инжект (редактор передаёт своё; витрина — нет/константы/`strings/propsForm.ts`).

`src/editor/propsForm/PropsForm.tsx` — тонкая обёртка с прежним публичным API; поведение инспектора не меняется.

Done-критерии:
- `npm run verify` зелёный; тесты propsForm/инспектора проходят (правки — только пути импортов);
- grep-инварианты: в `src/propsForm/**` нет импортов из `src/editor/**`, `src/api/client`, `src/app/strings/editor`;
- юнит-тесты ядра: два required из `{}` последовательно (черновик накапливается, `onCandidate` получает оба шага); defaulted string/number/enum/boolean → hint виден, raw candidate пуст; optional boolean/string unset vs пустая строка; nullable+default и явный `null`; root-ошибка strict-object → form-level; вложенный issue-path → поле; схема с async refinement на whole-object → form-level ошибка без падения; **field-схема `z.any().refine(async …)` → интроспекция не роняет форму** (JSON-fallback + form-level ошибка).

### W2. Docs-модель: рендер `propsJsonSchema`/событий/слотов (чистые компоненты)

**Владение:** новый `src/library/componentDocs/**`, тесты.

- `PropsTable({ schema })` — поддерживаемый subset: object с `properties`/`required`; string/number/integer/boolean + `enum`/`const`, `default`, `description`, базовые constraints как текст; массивы с примитивным `items`. Вне subset (anyOf/oneOf, `$ref`/`$defs`, вложенные объекты, tuple, boolean-схема, нет `type`) — fallback: имя поля + сворачиваемый raw-JSON. Cap глубины/размера. Нет схемы → «схема недоступна»/raw-JSON;
- `EventsSection({ events, eventPayloads })`, `SlotsSection({ slots })`, `MetaSection`;
- `SourceView({ source })` — `<pre>{source}</pre>`; **инвариант: никакого raw-HTML** (XSS-тесты); подсветка — не в MVP, будущая — только токенизацией в React-ноды;
- a11y: caption/`th scope`, скролл в контейнере.

Done-критерии: юнит-тесты — enum+default; optional+description; вложенный объект→fallback; anyOf/nullable-union→fallback; `$ref`/`$defs`→fallback; boolean-схема; нет схемы; массив примитивов; depth-cap; старые строки без `propsJsonSchema`/`examples`/`capabilities` (не падает); XSS-фикстуры. `npm run verify` зелёный; без API-обращений.

### W3. Страница компонента `/library/c/:componentId`

**Владение:** новый `src/library/componentPage/**`, `src/app/routes.tsx` (добавление роута), `src/app/strings/componentPage.ts` (новый).

**State machine загрузки** — независимые состояния `meta` → `version` → (`theme` ∥ `bundle`), каждое со своим loading/error/retry; **каждое состояние хранится вместе со своим request-key `(componentId, version)` и не рендерится при несовпадении с текущим выбором** (первый рендер после смены версии не показывает данные прежнего ключа — `useApi` переводит ready→loading только из эффекта, полагаться на него нельзя). Ошибка бандла/темы не трогает docs/код (им нужны meta+version). Правило выбора версии без `?v` — по D4. Бандл запрашивается только при разрешающем статусе (D7).

**Превью:** инлайн по образцу `LoadedComponentCapture` (`SurfaceSpacingScope` → theme-manager → `CaptureSurface`, single-element `toRuntimeSpec`); состояние `previewProps: none | valid` по D5. Error boundary: **key `(componentId, version)`** — валидные изменения props НЕ ремоунтят subtree (локальный state/фокус компонента живут при обычной смене props); при ошибке boundary сбрасывается сменой `validPropsGeneration` **только из error-состояния**. Тесты: фикстура с локальным счётчиком — обычная смена props сохраняет счётчик; schema-valid props, на которых компонент бросает → boundary → исправление контролами → subtree восстановлен.

**Слоты:** preview-only Placeholder — in-memory custom-тип с именем, невозможным по серверной грамматике (`__preview_placeholder__`), инжектируется в runtime-набор страницы. Правила инжекции детей (форма runtime-объекта ≠ декларация поддержки детей: adapter всегда создаёт `slots.default` структурно, но json-render считает компонент child-принимающим только при непустом `definition.slots`):
- `slots.length === 0` → детей не инжектировать вообще (бессотовые компоненты типа `rating-stars`);
- непустые `slots` → один unslotted Placeholder в default;
- Placeholder'ы в объявленные non-default слоты — **только при `capabilities.namedSlots`** (без него slot-разметка схлопывается в legacy default).

**Контролы:** ядро W1 (`onCandidate`-адаптер витрины) от live zod-схемы; пресеты по D8; не-object схема → whole-object JSON fallback ядра.

**Обвязка:** вкладки «Компонент»/«Документация»/«Код» (`tablist/tab/tabpanel`, стрелки, focus-management); селектор версий с полными статусными лейблами; переключатель фона (`aria-pressed`); ошибки полей ↔ поля (`aria-describedby`); статусные смены — `aria-live=polite`.

Done-критерии:
- страница fixture-компонента: превью, live-изменение контрола без перезагрузки и без потери локального state компонента;
- компонент без example с required-props: превью в состоянии «заполните обязательные props», компонент не монтируется; после заполнения — монтируется;
- недоступный бандл: docs/код работают, retry после восстановления делает новый сетевой запрос и успешен;
- `rejected`-версия: нет запроса bundle.js, блок о запрете; deprecated-only компонент: превью работает, «нет active-версии» не показывается;
- `?v`-грамматика: дубль/`0`/`01`/не-число → «некорректный адрес»; несуществующая → «не найдена»;
- смена версии: сброс контролов, вкладка сохранена, ни одного кадра с данными чужого ключа;
- `<html>` не мутируется; computed-style header (цвета/отступы) неизменен при монтировании темы;
- named-slots фикстура (`capabilities.namedSlots`): default + все объявленные слоты видимы как Placeholder; бессотовая фикстура (`slots: []`): Placeholder не инжектируется;
- `npm run verify` зелёный.

### W4. Интеграция в Library

**Владение:** `src/library/LibraryPage.tsx`, `src/library/libraryModel.ts`, `src/library/statusBadge.ts` (при необходимости), `src/app/strings/library.ts`.

- Карточка custom-компонента: явная ссылка-кнопка «Страница компонента» → `/library/c/:id?v=${component.version}` (версия из manifest-entry карточки; каждая `(componentId, designSystem)`-запись ведёт на свою версию). Доступна с клавиатуры, без double-click-жестов;
- сброс selection при возврате в Library — принятое ограничение MVP (selection в React-стейте; URL-state — follow-up).

Done-критерии: ссылка ведёт на страницу с корректной версией; `npm run verify` зелёный; builtin-ветки не изменены (diff-инвариант).

### W5a. Фикстуры и page-level e2e (параллельно W4)

**Владение:** `e2e/**` (новый spec, кроме Library-интеграции), `server/fixtures/**` (новые фикстуры), seed-шаги.

Фикстуры (публикуются через API в e2e-setup):
- **props-driven** (`props-badge`: рендерит `props.label`/`props.tone` напрямую) — live-props тест; существующий `typed-events-stars` не годится (`useState(props.value)` фиксирует значение на mount);
- **local-state** (счётчик в `useState` + отображение prop) — тест «смена props не ремоунтит» и recovery boundary;
- `typed-events-stars` — ошибки валидации (min/max), docs событий;
- **named slots** — переиспользовать существующую `server/fixtures/named-slots-panel.tsx` (`header`/`items` + default, `capabilities.namedSlots`), не создавать одноимённую новую;
- **бессотовая child-sensitive** (`slots: []`, видимо реагирует на наличие детей) и **legacy-слотовая без `capabilities.namedSlots`** — приёмка правил инжекции Placeholder;
- **required×2 без example/default** — приёмка D5;
- фикстура в custom-DS без builtin provider — registry-only путь.

E2E: прямое открытие `/library/c/<id>?v=`; live-props; сохранение локального state при смене props; ошибка поля не ломает превью; заполнение required×2 из «заполните обязательные props» до живого превью; Docs/Код (экранирование HTML); `?v`-переключение и грамматика; rejected без запроса bundle.js; retry бандла = два сетевых запроса; отказ shim → предложение reload; слоты (все три фикстуры); keyboard-навигация вкладок. Переход Gallery → страница здесь не проверяется (маршрут пользователя появляется только с W4) — он в W5b.

### W5b. Library-интеграционный e2e и финальная приёмка (после W4)

**Владение:** `e2e/**` (Library-интеграционный spec).

E2E: Library → карточка custom-компонента → «Страница компонента» → корректная версия → Back браузером в Library; Gallery → Library → страница компонента SPA-навигацией без full reload (порядок ThemeStyle/loader — приёмка W0.1). Финальная приёмка оркестратором: `npm run verify` + `npm run e2e` + runtime-прогон `.claude/skills/verify/SKILL.md` (Library → карточка → страница → контролы/доки/код; регресс инспектора редактора — все типы контролов, включая select/switch/asset; регресс плеера и галереи после W0).

## 4. Риски

| Риск | Митигция |
|---|---|
| Вынос ядра PropsForm регрессит инспектор | W1 сохраняет публичный API; расширенный регресс инспектора в W5b |
| Частично инициализированный `__easyUiShared` (воспроизводимо сегодня) | W0.1 + юнит-тест порядка модулей + e2e Gallery→страница |
| Рассинхрон CSS-темы и runtime-снапшота; не-LIFO unmount | W0.2 централизованный manager: один style-узел + снапшот атомарно |
| Font-family коллизия custom-темы с app-шеллом | Принятое ограничение D6 (существует и в Gallery as-is); follow-up: namespacing |
| Компонент без валидного initial незаполняем/падает | D5 `previewProps: none` + фикстура required×2 |
| Async refinement в схеме роняет safeParse | D2b/W1: исключения → form-level ошибка |
| Браузер кеширует неудачный ESM-import по URL | W0.3 retry-URL `?retry=<n>` + e2e двух сетевых запросов |
| Дрейф host-версий против immutable-бандлов | W0.5: exact-pin по lockfile + ABI-drift = падение verify + compat-прогон v1–v3 фикстур |
| `propsJsonSchema` отсутствует/вне subset | W2 fallback + тесты старых строк |
| `examples` версии не проходят live-схему | D5 safeParse, дизейбл пресета |
| Гонка «meta → import» вокруг статуса | Принято: D7 — UX-гейт по свежему snapshot, не security (доверенный код по D1) |
| Stale-данные при быстрой смене версии | W3: состояния с request-key, рендер только при совпадении ключа |
| Module-level side effects после ухода со страницы | Принято в рамках D1 |

## 5. Верификация (итог)

1. `npm run verify` — после каждой волны.
2. `npm run e2e` — после W5a и W5b (полные сценарные списки в задачах).
3. Runtime-прогон `/verify` — в W5b.

## 6. Триаж ревью

### Раунд 1 (Codex gpt-5.6-sol, max) — 4 blocker / 16 major / 4 minor

| # | Находка | Вердикт | Реакция |
|---|---|---|---|
| B1 | D1 без trust boundary | Принято | D1: явный precondition; уточнён в v3 по R2-m2 (loopback/BasicAuth) |
| B2 | `__easyUiShared` инициализируется пустым | Принято | W0.1; v2-оговорка «сегодня не воспроизводится» снята в v3 (R2-m1: loader тянет shared только динамически — воспроизводимо) |
| B3 | Версия не разрешается из manifest; `publishedVersion` потерян типом | Принято | D4 + W0.4; семантика null уточнена в v3 (R2-13) |
| B4 | D5 неразрешима для required×2 | Принято | D5; доработана в v3 (R2-1: состояние `none`) |
| M1–M16 | (см. историю v2) | Принято (M7 частично) | Разнесено по D6–D8, W0–W5; M7 доусилен в v3 (R2-10) |

### Раунд 2 (resume того же треда) — 2 blocker / 11 major / 2 minor

| # | Находка | Вердикт | Реакция |
|---|---|---|---|
| B1 | D5/D8: initial `example ?? {}` может быть невалиден — «последнего валидного» не существует; тест recovery противоречил D5 | **Принято** | D5 переписан: `previewProps: none \| valid(rawProps)`, initial через safeParse, компонент не монтируется при `none`; recovery-тест — на schema-valid props, бросающих в компоненте (W3) |
| B2 | Браузер кеширует неудачный ESM-import по URL — retry чисткой Map недостижим (воспроизведено в Chromium) | **Принято** | W0.3: retry-URL `bundle.js?retry=<n>`, канонический URL без суффикса; удаление из Map только при том же rejected promise; e2e: 500→200, два сетевых запроса |
| 3 | Стек ThemeStyle не согласует CSS (DOM-порядок style-тегов) и снапшот (порядок эффектов); мульти-темности всё равно нет | **Принято** | W0.2 переработан: single-active-theme, централизованный manager с одним style-узлом и атомарным снапшотом; расширенный тест-лист (update, null, StrictMode, HMR, baseline) |
| 4 | Computed-style не ловит font leakage; запрет имён сломал бы prod-темы | **Принято** (ветвь «признать ограничением») | D6: font leakage — зафиксированное ограничение inline MVP (есть и в Gallery); computed-style тест скоуплен до цветов/отступов; namespacing — follow-up |
| 5 | W1 без API для draft/valid; `values[name] ?? defaultValue` материализует дефолты | **Принято** | W1: контракт `onCandidate(candidate, validation)`; дефолты — hints, select/boolean с явным «не задано»; тесты untouched-raw-`{}` |
| 6 | «Схемы синхронны по publish-контракту» — неверно; async refinement роняет safeParse (`$ZodAsyncError`) | **Принято** | D2b: исключения схемы → form-level ошибка, страница живёт; запрет в publish-пайплайне не вводим (вне скоупа) |
| 7 | Reset-key по `validPropsGeneration` ремоунтит на каждый валидный коммит | **Принято** | W3: key `(componentId, version)`; сброс generation только из error-состояния; local-state фикстура в W5a |
| 8 | D7 — snapshot-гейт, не гарантия; не тащить в общий loader | **Принято** | D7 переформулирован как UX-гейт по свежему meta; проверка page-local; гонка meta→import принята (доверенный код); statusRev-URL не вводим |
| 9 | Generation не место в loader'е; `useApi` может отдать stale на первом рендере | **Принято** | W0.3: loader = transport/retry; W3: состояния с request-key, рендер при совпадении ключа; тесты concurrent-потребителей |
| 10 | Exact-pin без владения package.json — и с риском downgrade (lock = zod 4.4.3); react тоже caret; ABI-warning не ломает verify | **Принято** | W0.5: владение package.json+lock; пины по lockfile (zod 4.4.3, react/react-dom exact); ABI-drift → падение verify; compat-прогон v1–v3 |
| 11 | Default-слот implicit (не в `definition.slots`); фикстура named-slots-panel уже существует | **Принято** | W3: unslotted default Placeholder всегда + по одному на объявленный слот; имя `__preview_placeholder__` вне серверной грамматики; W5a переиспользует существующую фикстуру |
| 12 | DAG: W5 зависит от W4 | **Принято** | W5 разделён: W5a (фикстуры+page e2e, ∥ W4) и W5b (Library-интеграция+приёмка, после W4) |
| 13 | `publishedVersion === null` ≠ «нет опубликованных» (deprecated/superseded-only) | **Принято** | D4: «нет active-версии», fallback на новейшую renderable, кейсы deprecated-only/superseded-only |
| m1 | Обоснование B2-триажа v2 неверно (loader тянет shared динамически) | **Принято** | Триаж исправлен; юнит-тест W0.1 проверяет реальный порядок модулей; Gallery→page e2e — SPA-навигация без reload |
| m2 | D1: default — loopback без auth, не BasicAuth | **Принято** | D1: precondition переформулирован («repository-equivalent код в single-user workspace либо authenticated deployment») |

### Раунд 3 (resume того же треда) — 0 blocker / 5 major

Блокирующих возражений нет; D5, D7, request-key, recovery boundary, version fallback, exact pins признаны закрытыми.

| # | Находка | Вердикт | Реакция |
|---|---|---|---|
| 1 | `?retry=` не bust'ит транзитивные shim'ы — их failed module-map entry отравлен (воспроизведено) | **Принято** | W0.3: SPA-retry ограничен отказом верхнего bundle; отказ shim → предложение full-document reload; тест-сценарий shim-500 |
| 2 | Стек theme-manager'а делает победителя зависимым от сети (Gallery регистрирует владельца после загрузки draft) | **Принято** | W0.2: регистрация владельца на mount со стабильным order-key, до загрузки content; `GalleryPreview.tsx` во владении W0; тесты противоположных порядков resolve |
| 3 | `describePropsSchema` сам бросает `$ZodAsyncError` на интроспекции (до validate) | **Принято** | W1: защитный контур покрывает интроспекцию/defaults/выбор контролов; тест `z.any().refine(async …)` как field-схема |
| 4 | «Default Placeholder всегда» неверно: `slots: []` = нет детей; non-default — только при `capabilities.namedSlots` | **Принято** | W3: правила инжекции по slots/capabilities; W5a: фикстуры no-slots child-sensitive и legacy без namedSlots |
| 5 | W5a скрыто зависит от W4 (Gallery→page нужен UI-маршрут) | **Принято** | Сценарий Gallery→страница перенесён в W5b |
| — | Compat v1–v3 должен исполнять зафиксированные скомпилированные байты, не перекомпиляцию | **Принято** | W0.5: tracked compiled-фикстуры бандлов в репозитории |
