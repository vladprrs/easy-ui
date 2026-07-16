# Витрина custom-компонентов в Library: страница компонента с живым превью, контролами и доками

Дата: 2026-07-16 · Статус: v2 после раунда 1 Codex-ревью (триаж в §6)

## 1. Контекст и цель

Фокус продукта — пользовательские дизайн-системы и компоненты (создаваемые через `POST /api/design-systems` / `POST /api/components`, хранимые в SQLite, компилируемые сервером в браузерные ESM-бандлы). Сейчас у builtin-систем (shadcn/wireframe) есть полноценная витрина — Storybook с Controls и Docs, а custom-компоненты показываются в Library только meta-карточкой с capture-iframe (`src/library/LibraryPage.tsx`, `ComponentMetadata`). Асимметрия принципиальна: Storybook — build-time артефакт и не может показывать runtime-данные из БД.

**Цель:** сделать custom-компоненты первосортными гражданами продукта — страница компонента в Library с:
1. живым превью (тот же рантайм, что у плеера);
2. панелью контролов, сгенерированной из схемы props (аналог Storybook Controls);
3. докстраницей из `definition_meta` (props-таблица, события, слоты, примеры) и вкладкой с исходником (аналог Storybook Docs).

**Не цель (out of scope):** паритетная миграция builtin-компонентов на эту витрину; markdown-доки в publish-контракте; изменение publish-пайплайна и `definition_meta`; sandbox-изоляция недоверенного кода (см. D1); content-versioned shim ABI (см. §6, R1-M8).

Рассмотренные и отклонённые альтернативы:
- **Storybook composition (refs):** даёт дерево+рендер, но Controls/Docs для ref-историй не работают (ограничение модели composition) — а они прямое требование.
- **Отдельный storybook-проект с пересборкой по кнопке:** настоящие Controls/Docs, но минутная задержка publish→витрина ломает основной цикл (роадмап: AI-генерация компонентов), второй рантайм требует синхронизации с плеером (ABI, `wrapCustomComponent`, темы), сборка от пользовательских данных хрупка, плюс инфраструктурный хвост (сборка на прод-сервере запрещена).

## 2. Ключевые решения

### D1. Превью рендерится инлайн; precondition — published-код доверен

**Модель доверия (явный precondition):** published-код компонентов в easy-ui доверен на уровне владельца инстанса — это существующая модель проекта (см. trust-модель в `docs/server-api.md`; инстанс за basicAuth, авторы = владелец/авторизованные агенты). Инлайн-рендер **не является** security boundary и не претендует: компонент исполняется в realm SPA уже на `import()` бандла (до всякого error boundary) и технически может обращаться к `window`/`fetch`/DOM. Существующий same-origin capture-iframe без атрибута `sandbox` — тоже не boundary, так что инлайн не ослабляет текущую позицию. Если продукт пойдёт в недоверенный/мультитенантный контент — потребуется sandbox на отдельном origin; это зафиксированный prerequisite такой фазы, не часть MVP.

**Инженерное обоснование инлайна:** плеер (`/p/:id`) и редактор (`/p/:id/edit`) уже рендерят custom-компоненты инлайн — `loadCustomComponents` → `Renderer`/`CaptureSurface` + `ThemeStyle` + `SurfaceSpacingScope`. Живые контролы = React-стейт → ре-рендер, без межфреймового протокола и перезагрузок iframe. Отличие новой страницы от прецедентов: она первая совмещает app-header `Layout` и runtime-компонент на одном экране (плеер скрывает header) — containment-риски темы закрываются в W0/W3 (см. D6, W0.2) и проверяются тестами «тема не влияет на header/body до/во время/после превью».

Capture-shell не трогаем — он остаётся контрактом скриншот-воркера и visual regression.

### D2. Контролы — из живой zod-схемы через вынесенное ядро PropsForm

В редакторе уже есть schema-driven форма: `src/editor/propsForm/PropsForm.tsx` + `describePropsSchema` (`src/catalog/zodIntrospect.ts`). Живая zod-схема компонента доступна на странице бесплатно: `loadCustomComponents` возвращает `definitions[name].props` (настоящий `z.ZodType` из бандла) — тот же объект, на котором форма уже работает в инспекторе редактора. Полный API выноса — в W1.

Отклонено: новый рендерер форм из `propsJsonSchema` (JSON Schema) — второй параллельный механизм; бандл на странице превью всё равно загружен.

Известное ограничение (принято): persisted `propsJsonSchema` и live-схема из бандла — результаты двух исполнений definition и теоретически могут разойтись; контролы и превью работают только от live-схемы, docs-таблица — только от persisted (D3), точки смешения нет. Пресеты защищены safeParse (D5).

### D3. Docs-таблица props — из `propsJsonSchema`, не из zod-интроспекции

`describePropsSchema` теряет `.describe()` и min/max; в `propsJsonSchema` (`CatalogComponent.propsJsonSchema`, тип `unknown`, best-effort) есть descriptions, enum'ы, дефолты, required. Контролы — из zod (D2), props-таблица — из `propsJsonSchema`. Поддерживаемый subset и fallback — в W2.

### D4. Роут `/library/c/:componentId`, версия — query `?v=<n>`; манифест не является источником версии

Custom entry в Library идентифицируется парой `(componentId, designSystem)` — один id может присутствовать в манифесте в нескольких системах (перенос компонента; покрыто тестом `LibraryPage.test.tsx`). Поэтому:

- разрешение версии на странице: `GET /api/components/:id` (`ComponentMeta`, no-store) — сервер отдаёт `publishedVersion`, клиентский тип его теряет → добавить поле в `ComponentMeta` (W0.4). Без `?v` открывается `publishedVersion`; его отсутствие (ни одной published-версии) — явное состояние «нет опубликованных версий» с docs по head-ревизии недоступными (страница показывает список версий и статусы);
- `?v=<n>`: строгая грамматика — ровно один параметр (`getAll("v").length === 1`), `^[1-9][0-9]*$`, `Number.isSafeInteger`; нарушение грамматики — ошибка «некорректный адрес» (отличается от «версия не найдена» = 404 от API);
- дизайн-система и тема определяются **выбранной версией** (`ComponentVersion.designSystem`), а не манифестом;
- все ссылки из Library ведут с явной версией: `/library/c/:id?v=${component.version}`;
- смена версии сбрасывает контролы/пресет к initial props новой версии; активная вкладка сохраняется.

### D5. Черновик формы отделён от валидного снапшота превью

Два состояния: `draftProps` (что в полях; может быть невалидным/неполным) и `lastValidPreviewProps` (что рендерит превью). Поля накапливают черновик всегда — в том числе при ошибках других полей (иначе компонент с двумя required-props без дефолтов невозможно заполнить последовательно). Whole-schema `safeParse(draftProps)` после каждого коммита поля: успех → снапшот продвигается в превью; ошибка → inline-ошибки у полей (маппинг по path), превью остаётся на последнем валидном снапшоте. Пресеты из `examples` перед применением проходят тот же safeParse; невалидный для выбранной версии пресет дизейблится с подсказкой.

### D6. Тема — латест темы дизайн-системы выбранной версии; без `.dark`, без мутаций `<html>`

Загрузка как в capture: `getDesignSystemById(version.designSystem)` → `ThemeStyle` + `SurfaceSpacingScope`. **`useCaptureTheme` не переиспользуется**: он вешает `.dark` на `document.documentElement`, что перекрашивает shadcn-переменные всего app-шелла (`src/styles/index.css`). Переключатель «светлый/тёмный» на странице меняет только фон превью-области локальным классом контейнера, **не** `.dark` (у custom-тем нет dark-варианта токенов; семантика — «посмотреть компонент на тёмном фоне», не theme simulation). Тест-инвариант: `<html>` не мутируется страницей.

Containment-факт: `serializeThemeCss` пишет токены в `:root` (глобально), `@font-face` глобален по своей природе — но это `--eui-*`-переменные, которые app-шелл не потребляет; `SurfaceSpacingScope` скоупит `space.*`. Мульти-инстанс `ThemeStyle` — W0.2.

### D7. Статус версии гейтит исполнение до `import()`

Исполняемое превью разрешено только для версий в статусе `active | deprecated | superseded`. Для `rejected | archived | failed | staging` бандл **не запрашивается и не импортируется** (rejected по контракту сервера потенциально вреден); страница показывает docs/код и явный блок «исполнение запрещено статусом N». Актуальный статус берётся из no-store `ComponentMeta.versions`, не из version DTO (его `status` изменяем несмотря на immutable-контент). `statusBadge.ts` недостаточен (сознательно не показывает `failed/staging`) — странице нужен полный статусный лейбл.

### D8. Превью рендерит raw input props; дефолты схемы не применяются автоматически

Паритет с плеером: json-render передаёт компоненту raw `element.props` без `schema.parse()`, publish хранит raw input examples, компоненты по контракту проекта оборонительны к отсутствующим значениям. Поэтому превью рендерит raw-снапшот (`lastValidPreviewProps`), а не `safeParse(...).data` — иначе витрина показывала бы не то, что покажет плеер. Дефолты схемы показываются в docs-таблице и в placeholder'ах контролов, но не материализуются в props. Initial props версии: `example` версии, если есть → иначе `{}`. Пресеты: legacy `example` (в UI — под существующим именем `default`, как в Library сейчас) + именованные `examples`. Отдельного пресета «дефолты схемы» нет.

## 3. Декомпозиция работ и file ownership

DAG: **(W0 ∥ W1 ∥ W2) → W3 → (W4 ∥ W5)**. Каждая задача — отдельный `--fresh` диспатч Codex `--write --effort medium`; коммиты делает оркестратор после независимой проверки done-критериев.

### W0. Foundation: shared runtime, тема, loader, API-типы

**Владение:** `src/customComponents/shared.ts`, `src/customComponents/loader.ts`, `src/designSystems/theme.tsx`, `src/api/client.ts`, их тесты. (Никто другой эти файлы не трогает.)

1. **`ensureEasyUiShared()`**: единая функция, идемпотентно заполняющая core-модули (`react`, `zod`, `json-render-react`, …) в `globalThis.__easyUiShared` даже если объект уже создан частично. Вызывается из `shared.ts` (module scope), из loader перед `import()` и из `ThemeStyle` вместо `??= {}`. Сейчас инвариант держится на случайности (весь роутинг статически импортирован → `shared.ts` исполняется на бутстрапе): `theme.tsx` импортирует из `shared.ts` только типы, и `ThemeStyle` первым создал бы пустой объект, который `shared.ts:29` (`??=`) уже не дозаполнит. Тест: порядок «ThemeStyle до loader» и «частично инициализированный shared» → загрузка бандла работает.
2. **Мульти-инстанс `ThemeStyle`**: текущий restore-on-cleanup ломается при не-LIFO unmount (mount A → mount B → unmount A → A затирает активную тему B; unmount B восстановит stale A). Ввести стек владельцев (registry): активна тема верхнего живого владельца; unmount из середины удаляет запись без затирания. Тесты: A/B mount + оба порядка cleanup; Gallery-превью (уже сейчас монтируют несколько `ThemeStyle`) не регрессят.
3. **Loader: retry и отмена**: rejected import-promise удаляется из `moduleCache` (сейчас закеширован навсегда → кнопка «повторить» бессмысленна); после `import()` результат сверяется с поколением запроса (AbortSignal/generation), чтобы быстрое переключение версий не применяло stale-бандл.
4. **`ComponentMeta.publishedVersion`**: добавить поле в клиентский тип (сервер уже отдаёт, `server/repos/components.ts`).
5. **Пин zod**: `zod` в `package.json` — exact (сейчас `^4.3.6`), в русле политики пиновки проекта: shims проксируют host-zod в immutable-бандлы, минорный дрейф хоста — источник несовместимости.

Done-критерии: юнит-тесты пунктов 1–3 зелёные; `npm run verify` зелёный; grep-инвариант: в `theme.tsx`/`loader.ts` нет `__easyUiShared ??=` мимо `ensureEasyUiShared`; e2e плеера/галереи не регрессят.

### W1. Вынос ядра PropsForm из редактора

**Владение:** `src/editor/propsForm/**`, новый `src/propsForm/**` (shared), `src/app/strings/propsForm.ts` (новый — общие строки формы; строки редактора остаются в `strings/editor.ts`). `src/catalog/zodIntrospect.ts` — только чтение.

Полная карта сцепленности, подлежащая развязке: `validateElementProps`/`isDynamicValue` (динамические `$`-значения и state прототипа), `DocEpochContext` (undo/redo), `uploadAsset`/`EditorAsset`/`useSyncExternalStore` (ассеты), строки `editor.*`, `jsonValueSchema`, form-level ошибки и path-маппинг, whole-object JSON fallback (`JsonWholeProps`).

Контракт ядра (`src/propsForm/`):
- модель: `drafts` (per-field текст/значение), `errors: { fields: Record<string,string>; form?: string }` — form-level канал обязателен (root-ошибки refinement/strict-object не привязаны к полю);
- `validate(candidate) => { fields, form? }` — синхронный инжектируемый валидатор; редактор передаёт обёртку `validateElementProps`, витрина — обёртку zod `safeParse` с конверсией issues→field/form (async-валидация вне контракта — политика: не поддерживается, zod-схемы компонентов синхронны по publish-контракту);
- optional/nullable семантика: явный unset для optional-полей всех типов (в т.ч. boolean/string через тристейт/кнопку «сбросить»), выбор `null` для nullable; отображение значения не через `values[name] ?? defaultValue` (скрывает явный `null`);
- `renderAssetField?` — инжект (редактор передаёт свой `AssetField`; витрина не передаёт — asset-props рендерятся текст/JSON-контролом);
- `epoch?` — инжект сброса черновиков (редактор — из `DocEpochContext`; витрина — смена `(componentId, version)`);
- строки — параметром/из `strings/propsForm.ts`, без импорта `strings/editor.ts` в ядре.

`src/editor/propsForm/PropsForm.tsx` становится тонкой обёрткой с прежним публичным API — поведение инспектора редактора не меняется.

Done-критерии:
- `npm run verify` зелёный; тесты propsForm/инспектора проходят (правки — только пути импортов);
- grep-инварианты: в `src/propsForm/**` нет импортов из `src/editor/**`, `src/api/client`, `src/app/strings/editor`;
- новые юнит-тесты ядра: optional boolean unset; optional string unset vs пустая строка; nullable с default и явный `null`; root-ошибка strict-object (лишний ключ) → form-level; вложенный issue-path → корректное поле; два required-поля из `{}` заполняются последовательно (черновик накапливается — приёмка D5 на уровне формы).

### W2. Docs-модель: рендер `propsJsonSchema`/событий/слотов (чистые компоненты)

**Владение:** новый `src/library/componentDocs/**`, его тесты.

Чистые presentational-компоненты без загрузки данных:
- `PropsTable({ schema })` — **поддерживаемый subset** JSON Schema: object c `properties`/`required`; поля типов string/number/integer/boolean + `enum`/`const`, `default`, `description`, базовые constraints (min/max/length/pattern — как текстовые аннотации); массивы с примитивным `items`. Всё вне subset'а (anyOf/oneOf, `$ref`/`$defs`, вложенные объекты, tuple, boolean-схема, отсутствующий `type`) — честный fallback: имя поля + сворачиваемый raw-JSON фрагмент схемы. Ограничение глубины/размера рендера (cap + «показать как JSON»). Отсутствующая/не-object схема → целиком raw-JSON блок либо «схема недоступна»;
- `EventsSection({ events, eventPayloads })`, `SlotsSection({ slots })`, `MetaSection` (description, atomicLevel, capabilities, designSystem);
- `SourceView({ source })` — readonly `<pre>{source}</pre>`; **инвариант: никакого raw-HTML/`dangerouslySetInnerHTML`** (тест с `</pre><img onerror=…>` и `<script>` в source); подсветка — не в MVP, будущая реализация только токенизацией в React-ноды;
- a11y: таблица с `caption`/`th scope`, горизонтальный скролл в контейнере.

Done-критерии: юнит-тесты — enum+default; optional+description; вложенный объект → fallback; `anyOf`/nullable-union → fallback; `$ref`/`$defs` → fallback; boolean-схема; отсутствующая схема; массив примитивов; превышение depth-cap; XSS-фикстуры SourceView. `npm run verify` зелёный; нет обращений к API из модулей.

### W3. Страница компонента `/library/c/:componentId`

**Владение:** новый `src/library/componentPage/**`, `src/app/routes.tsx` (только добавление роута), `src/app/strings/componentPage.ts` (новый — все строки страницы: вкладки, ошибки, загрузка, статусы, пресеты, переключатель фона).

**State machine загрузки (независимые состояния, не единый `Promise.all`):**
1. `meta` — `getComponentMeta(id)`: имя, версии+статусы, `publishedVersion`. Ошибка → страница целиком в error-state («компонент не найден» / retry);
2. `version` — `getComponentVersion(id, v)` для выбранной версии (D4): source, examples, designSystem, definition-мета. Ошибка → error-state вкладок, зависящих от версии;
3. `theme` — best-effort (как в capture): ошибка → превью без темы, warning;
4. `bundle` — только если статус разрешает исполнение (D7): `loadCustomComponents`. Ошибка → error-block в превью с retry (работает благодаря W0.3), **вкладки «Документация» и «Код» полностью функциональны** (им нужны только meta+version);

каждое состояние — свои loading/error/retry UI; переключение версии инвалидирует по generation (stale-результаты отбрасываются).

**Превью:** инлайн-рендер по образцу `LoadedComponentCapture` (`SurfaceSpacingScope` → `ThemeStyle` → `CaptureSurface`, single-element `toRuntimeSpec`); error boundary вокруг превью с reset по key `(componentId, version, validPropsGeneration)` — тест «initial throw → исправление контролами → превью восстановилось»; boundary не заявляется как containment для module-level/глобальных side effects (D1).

**Слоты:** preview-only Placeholder — локальный компонент страницы, инжектируемый в runtime как дополнительный custom-тип (in-memory definition, не с сервера; не через builtin-registry — у custom-DS fallback-система с пустым registry). Для каждого объявленного слота (`default` и именованные) строится child-элемент Placeholder в spec (named slots — через существующую разметку slot-детей, `runtimeSpec`/`slotIndices`).

**Контролы:** ядро W1 от live zod-схемы; черновик/снапшот по D5; пресеты (D8) — чипы, невалидные для версии дизейблятся; непустой набор контролов при не-object схеме → whole-object JSON fallback ядра.

**Обвязка:** вкладки «Компонент»/«Документация»/«Код» (roles `tablist/tab/tabpanel`, стрелочная навигация, focus-management); селектор версии (все версии из meta со статусными лейблами по D7 — полными, не через `statusBadge.ts`); переключатель фона превью (D6, `aria-pressed`); ошибки полей связаны с полями (`aria-describedby`), статусные смены — `aria-live=polite`.

Done-критерии:
- роут в dev: страница fixture-компонента показывает превью; изменение контрола меняет рендер без перезагрузки;
- при недоступном бандле (подменённый URL) docs/код работают; retry после восстановления работает;
- версия в статусе `rejected` не вызывает загрузку бандла (проверка: нет сетевого запроса bundle.js), показывает блок о запрете;
- невалидный `?v` (дубль, `0`, `01`, не-число) → «некорректный адрес»; несуществующая версия → «не найдена»;
- смена версии сбрасывает контролы, не теряет вкладку, stale-переключение не мигает чужими данными;
- `<html>` не мутируется (тест-инвариант D6); тема не меняет стили header (снапшот computed-style header до/во время/после);
- `npm run verify` зелёный.

### W4. Интеграция в Library

**Владение:** `src/library/LibraryPage.tsx`, `src/library/libraryModel.ts`, `src/library/statusBadge.ts` (при необходимости), `src/app/strings/library.ts`.

- Карточка custom-компонента (`ComponentMetadata`) получает явную ссылку-кнопку «Страница компонента» → `/library/c/:id?v=${component.version}` (версия — из manifest-entry карточки; отдельная запись на каждую `(componentId, designSystem)` ведёт на свою версию). Обычная ссылка/кнопка, доступная с клавиатуры; никаких double-click-жестов;
- сброс выбранной системы/фильтра при возврате в Library — допустимое поведение MVP (selection живёт в React-стейте); фиксируется в done-критерии как известное ограничение.

Done-критерии: переход из карточки на страницу и назад браузером работает (e2e-шаг в W5); `npm run verify` зелёный; builtin-ветки Library не изменены (diff-инвариант).

### W5. Фикстуры, e2e и приёмка

**Владение:** `e2e/**` (новый spec), `server/fixtures/**` (новые фикстуры), seed-шаги e2e.

Фикстуры (публикуются через API в e2e-setup, `.e2e-data/dev`):
- **props-driven** компонент (например `props-badge`: рендерит `props.label`/`props.tone` напрямую, без локального state) — для live-props теста. Существующий `typed-events-stars` не годится: `useState(props.value)` фиксирует значение при mount, ре-рендер с новым prop не меняет вид;
- `typed-events-stars` — для теста ошибок валидации (min/max) и docs событий;
- **named-slots** фикстура (например `named-slots-panel` со слотами `header`/`default`) — для проверки placeholder'ов;
- фикстура с **двумя required-props без example/default** — приёмка D5 на странице;
- фикстура в custom-DS **без builtin provider** (как yandex-pay) — registry-only путь.

E2E-сценарии (vite+API dev): открыть `/library/c/<id>` из карточки Library; live-props (изменение контрола → видимое изменение превью); ошибка поля не ломает превью; заполнение двух required с нуля; вкладки Docs (props-таблица с полем) и Код (содержит исходник, HTML экранирован); `?v=` переключение; переход Gallery → страница компонента (порядок ThemeStyle/loader — приёмка W0.1); rejected-версия без запроса bundle.js; named slots видимы; keyboard-навигация по вкладкам.

Финальная приёмка оркестратором: `npm run verify` + `npm run e2e` + runtime-прогон по `.claude/skills/verify/SKILL.md` (Library → карточка → страница → контролы/доки/код; регресс инспектора редактора после W1 — включая select/switch/asset-поля, не только text; регресс плеера и галереи после W0).

## 4. Риски

| Риск | Митигция |
|---|---|
| Вынос ядра PropsForm регрессит инспектор редактора | W1 сохраняет публичный API; расширенный регресс инспектора в W5 (все типы контролов) |
| Частично инициализированный `__easyUiShared` ломает загрузку бандлов | W0.1 `ensureEasyUiShared` + тесты порядка; e2e Gallery→страница |
| Не-LIFO unmount `ThemeStyle` затирает активную тему | W0.2 стек владельцев + тесты порядков |
| Тема/шрифты custom-DS протекают в app-header | `--eui-*`-токены app-шеллом не потребляются; тест computed-style header (W3); `.dark`/`<html>` не мутируются (D6) |
| Компонент с required props без дефолтов «незаполняем» | D5 черновик/снапшот + фикстура и тесты W1/W5 |
| Дрейф host-zod против immutable-бандлов | W0.5 exact-pin; глубже (versioned shim ABI) — принятое ограничение, follow-up |
| `propsJsonSchema` отсутствует/вне subset | W2 fallback-рендер, тесты старых строк без schema/examples/capabilities |
| `examples` версии не проходят live-схему | D5 safeParse, дизейбл пресета с подсказкой |
| Побочные эффекты модуля компонента живут после ухода со страницы | Принято в рамках D1 (доверенный код); не маскируется error boundary |
| Быстрое переключение версий применяет stale-бандл | W0.3 generation/AbortSignal + тест W3 |

## 5. Верификация (итог)

1. `npm run verify` — после каждой волны.
2. `npm run e2e` — после W5 (полный сценарный список §W5).
3. Runtime-прогон `/verify`: Library → карточка → страница компонента → контролы/доки/код → регресс редактора (все типы контролов), плеера, галереи.

## 6. Триаж ревью

### Раунд 1 (Codex gpt-5.6-sol, max) — 4 blocker / 15 major / 4 minor

| # | Находка | Вердикт | Реакция |
|---|---|---|---|
| B1 | D1 не определяет trust boundary; инлайн ≠ безопасное превью | **Принято** | D1 переписан: явный precondition «published-код доверен» (существующая модель проекта); same-origin iframe тоже не boundary; sandbox на отдельном origin — prerequisite недоверенной фазы, вне MVP |
| B2 | `__easyUiShared` может быть необратимо инициализирован пустым до loader | **Принято** (с уточнением: сегодня не воспроизводится — статический import-graph гарантирует `shared.ts` на бутстрапе; `theme.tsx` импортирует только типы, инвариант хрупкий) | W0.1 `ensureEasyUiShared` + тесты порядка + e2e Gallery→страница |
| B3 | `componentId` не определяет версию; manifest — не источник; `ComponentMeta` теряет `publishedVersion` | **Принято** | D4 переписан: разрешение через `publishedVersion` (W0.4), ссылки Library всегда с `?v=`, DS — из version DTO |
| B4 | D5 неразрешима для нескольких required без defaults | **Принято** | D5 переписан: draft/lastValid разделены; тесты в W1 и фикстура в W5 |
| M1 | Изоляция темы не подтверждена прецедентами (первая страница header+runtime) | **Принято** | D1/D6 уточнены; тесты containment в W3 |
| M2 | `ThemeStyle` не переживает не-LIFO unmount | **Принято** | W0.2 стек владельцев |
| M3 | D6 неверно описывал dark mode (`.dark` глобален) | **Принято** | D6 переписан: без `useCaptureTheme`, без `.dark`, только фон превью; инвариант `<html>` |
| M4 | Загрузку разделить: meta/version vs theme vs bundle | **Принято** | W3 state machine, docs/код без бандла |
| M5 | Статус должен гейтить исполнение до import; `statusBadge` неполон | **Принято** | Новое D7; полные статусные лейблы в W3 |
| M6 | Кеш loader'а прячет отсутствие retry; нет отмены | **Принято** | W0.3 |
| M7 | Zod ABI drift (`^4.3.6`, shim проксирует host) | **Принято частично** | Exact-pin в W0.5; content-versioned shim ABI — отклонено для MVP (несоразмерный объём), зафиксировано как ограничение в «не цели»/рисках |
| M8 | Семантика raw input vs parsed/defaults не определена; коллизия имени `default` | **Принято** | Новое D8: raw props, дефолты не материализуются (паритет с плеером, компоненты оборонительны), пресета «дефолты схемы» нет |
| M9 | W1 недоописывает сцепленность и API ядра (root-errors, unset, null) | **Принято** | W1 переписан: полный контракт + список тестов; async-валидация — вне контракта (политика) |
| M10 | Slot placeholder не универсален (named slots, пустой registry custom-DS) | **Принято** | W3: preview-only Placeholder как in-memory custom-тип; фикстуры named-slots и registry-only DS в W5 |
| M11 | `typed-events-stars` не доказывает live-props (`useState(props.value)`) | **Принято** | W5: новая props-driven фикстура; stars — для валидации |
| M12 | Error boundary без recovery-контракта | **Принято** | W3: reset по `(id, version, validPropsGeneration)` + тест |
| M13 | W2 тестирует узкий subset JSON Schema | **Принято** | W2: явный subset + fallback + расширенный список тестов |
| M14 | Ownership/DAG не покрывают shared/theme/loader/strings | **Принято** | Новая W0; строки страницы — во владении W3 (`strings/componentPage.ts`); DAG обновлён |
| M15 | A11y/локализация/loading UX вне критериев; double-click недоступен | **Принято** | W3/W4: роли вкладок, keyboard, aria-live, инвентарь строк; double-click заменён явной ссылкой |
| M16 | Верификация не покрывает рискованные обещания | **Принято** | W5: сценарный список расширен (Gallery→page, bundle failure, rejected, required×2, slots, `?v`-грамматика, keyboard) |
| m1 | Грамматика `?v=` недоопределена | **Принято** | D4: строгая грамматика, invalid ≠ 404 |
| m2 | Возврат в Library теряет selection | **Принято как ограничение** | W4: зафиксировано известным ограничением MVP (selection в React-стейте; URL-state — follow-up) |
| m3 | Source XSS — только при будущем raw-HTML | **Принято** | W2: инвариант «no raw HTML» + XSS-тесты |
| m4 | Backward-compat старых строк без schema/examples | **Принято** | W2/риски: тесты неполных данных |
