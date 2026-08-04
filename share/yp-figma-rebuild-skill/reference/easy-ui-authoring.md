
# Авторинг компонентов и прототипов в easy-ui (remote API)

easy-ui — мультиюзерный просмотрщик и редактор кликабельных прототипов. Каталог **custom-only**: компоненты публикуются через HTTP API, host runtime поставляет `Image`/`Hotspot`/`Overlay`/`@eui/FlowRoot`. Этот скилл работает **только через HTTP API**. Харнес — `driver.mjs` из этого пакета (plain Node ≥ 18, без зависимостей; `easyui-auth.mjs` должен лежать рядом).

Два сценария, от частого к редкому:

1. **Прототип из активного custom-каталога** — получить exact definitions, написать JSON, отправить драйвером.
2. **Новый React-компонент + прототип** — TSX-модуль публикуется через API, затем используется как обычный тип.

Пакет самодостаточен: репозиторий easy-ui не нужен. Источники истины, доступные с любого инстанса: `GET /api/capabilities` (actions, директивы, лимиты, фаза reuse-гейта, дизайн-системы), `GET /api/openapi.json` (полный OpenAPI 3.1), `GET /api/schemas/prototype-document.json` и `.../component-definition.json` (машинные схемы).

## Setup

```bash
export EASYUI_USERNAME="alice"               # named account
export EASYUI_PASSWORD="account-password"
export EASYUI_LEGACY_BASIC_AUTH="edge:secret" # только пока включён внешний compatibility-барьер
# по умолчанию драйвер ходит на https://easy-ui.pay-offline.ru
# другой инстанс (например локальный): export EASYUI_API="http://127.0.0.1:8787/api"
```

Драйвер логинится named-аккаунтом, держит session cookie в памяти процесса и добавляет `Origin` к API-запросам. Если задан `EASYUI_LEGACY_BASIC_AUTH`, Basic-заголовок отправляется и на login, и далее. Проверка доступа:

```bash
node driver.mjs get prototypes
```

Любой verb принимает `--json`. Сессия кэшируется на диске между вызовами (`$XDG_STATE_HOME/easyui` либо `~/.cache/easyui`, TTL 24 ч; путь переопределяет `EASYUI_SESSION_FILE`, выключатель `EASYUI_SESSION_CACHE=0`) — в норме логин один на серию вызовов. Если 429 всё же случился (кэш выключен/сброшен, лимит 5 логинов на аккаунт в минуту) — подождать минуту и повторить.

## Главное правило: переиспользуй, прежде чем создавать

Каталог работает в режиме **enforce**: создание дубликата блокируется сервером. Порядок действий обязателен.

### 1. Дешёвый цикл открытия каталога

```bash
node driver.mjs catalog list yandex-pay
node driver.mjs catalog search yandex-pay --intent "Let a customer rate a product from one to five stars" --limit 5 --json
node driver.mjs catalog get yandex-pay yp-box YpText --json
```

- `catalog list` — компактный инвентарь (`id`, `name`, `version`, `atomicLevel`, `events[]`, `slots[]`, `description`); имена берутся отсюда.
- `catalog search` — кандидаты матчера под продуктовую задачу (`intent`).
- `catalog get` — exact definitions (`propsJsonSchema`, examples, payload-схемы событий) **только** названных артефактов.

Props валидируются строго по `propsJsonSchema`: неизвестный ключ = 422, поэтому писать документ без `catalog get` по каждому используемому типу нельзя. Полный дамп (`node driver.mjs catalog <ds> [out.json] [--full]`) примерно на порядок дороже по контексту — запускать только когда нужен весь каталог целиком (инвентаризация, миграция).

### 2. Прежде чем создавать компонент

1. Сформулируй `intent` — продуктовую задачу, 8..500 символов после trim, минимум один токен вне стоп-набора `component`/`компонент`/`element`/`элемент`/`ui`. Для **нового** id `--intent` обязателен; обновление существующего компонента intent не требует.
2. Прогони `catalog search` и прочитай кандидатов.
3. Кандидат покрывает — используй его; почти покрывает — **расширь новой ревизией** non-breaking (обновление гейт создания не проходит); не подходит — создавай и объясни отличие в `intent`.
4. Задача «собрать экран из существующего» решается **композицией**, а не новым компонентом:

```bash
node driver.mjs composition <id> <doc.json> --design-system <ds>
node driver.mjs composition publish <id>
```

Границу «композиция или компонент» считает сервер: `POST /api/compositions/analyze` c телом `{doc, designSystem?}` (read-only, `features.compositionAnalyze`) отвечает `composition` | `extend-component` | `needs-ownership-component` плюс `unsupported[]` (`timer`, `async-data`, `scroll`, `dom-measurement`, `custom-action`, `business-state`, `dynamic-directive`, лимиты) и `dependencyImpact`. Тот же вердикт печатает workbench: `POST /api/catalog/candidates` c `proposed.kind:"composition"` и черновым `compositionDoc` → `outcome`/`explanation`/`matches`. Для композиции гейт ничего не блокирует — исход рекомендательный.

**Composition v3** (`features.compositionV3`, запись включается `EASYUI_COMPOSITION_V3=1`; на проде включена) снимает прежние ограничения формата: типизованные параметры (`enum`/`object`/`array`/`action`), `element.when` — необязательные ветки, `{"$switch":{param,cases,default}}` в значении пропа, **`repeatParam`** — клонирование поддерева по элементам `array`-параметра (`{"$item":"field"}`/`{"$index":true}` внутри), слоты с метаданными (`required`/`allowedTypes`/`allowedRoles`/`cardinality`/`fallback`), токенный `layout` (закрытый набор фасетов, компилируется в пропы layout-контракта v1) и `variants` (оси + легальные кортежи, выбор через `props.variant` у ссылки). Всё это раскрывается **на момент сохранения прототипа** — в сохранённом документе не остаётся ни `when`, ни `$switch`, ни `$param`; рантайм-ветвление по-прежнему только `$cond` над `doc.state`. Проверить раскрытие до записи: `POST /api/compositions/:id/preview-tree` c `{params?, variant?, rev?}` — это тот же `expandCompositions` с трассировкой (взятые ветки, выбранные case'ы, число клонов repeat, привязки слотов, во что скомпилировался `layout`, `expandedTree`, `issues[]`).

### 3. `409` — терминальный STOP

`component_reuse_required`, `canonical_role_conflict`, `catalog_changed` приходят с `retryable: false`. **Не ретраить, не переименовывать ради обхода, не звать `--force-new` автоматически** — драйвер печатает кандидатов и `decisionId` и выходит с кодом `2`. Нормальный ответ — переиспользовать/расширить показанного кандидата. После `catalog_changed` заново выполни discovery и покажи новое решение человеку; старое подтверждение не переносится.

Обход существует только как двухфазное действие человека и только у администратора:

```bash
node driver.mjs component rating-stars RatingStars examples/rating-stars.tsx \
  --design-system yandex-pay \
  --intent "Let a customer rate a product from one to five stars" \
  --force-new --reason "Product owner approved a distinct rating interaction for this flow"
```

`--reason` — 20..500 символов; не-администратор получает `403 admin_required`; каждый обход попадает в append-only аудит (`node driver.mjs audit reuse --design-system <ds>`, только админ). Для override драйвер берёт server-authored `overrideTemplate` из свежего discovery verbatim.

### 4. Фаза гейта

`GET /api/capabilities` → `reuseGate {mode, intentRequired, policyVersion}`. `intentRequired` истинно ровно в `enforce`. Пиши поведение, которое умеет обе фазы: `intent` слать всегда, на успех создания дубликата не рассчитывать. В `shadow` блокирующее совпадение возвращается в `warnings[]` — читать, а не глушить.

### 5. Метаданные

Новый компонент обязан нести содержательный `description`, незавышенный `atomicLevel`, при применимости `scope`. `canonicalFor` объявлять только если компонент действительно канонический для продуктовой роли и слаг роли согласован с владельцами каталога: роль уникальна внутри дизайн-системы, попытка забрать занятую даёт терминальный `409 canonical_role_conflict` и на create, и на publish. Пустая мета готовит следующий дубликат.

## Сценарий 1: прототип из custom/host компонентов

1. Открыть каталог дешёвым циклом (выше), получить `catalog get` по каждому типу экрана.
2. Написать документ по грамматике ниже (рабочие образцы в `examples/`).
3. Отправить:

```bash
node driver.mjs prototype my-flow.json
# saved my-flow rev 1
# component pins: [...]
# player: https://easy-ui.pay-offline.ru/p/my-flow
```

Сервер валидирует документ сам (422 с точными `issues` при ошибке). Драйвер делает create-or-update: повторный запуск с тем же `doc.id` обновляет драфт (CAS по `headRev` берёт на себя). Ссылку player из вывода можно сразу открыть в браузере.

### Грамматика документа (format v1, строгий allowlist)

Машинная версия — `GET /api/schemas/prototype-document.json`, сводка возможностей — `GET /api/capabilities`. Ниже — рабочая выжимка.

Корень: `{version: 1, id, name, description?, designSystem, device?, startScreen, state?, computed?, screens[], flows?, architecture?, surfaces?}`. `designSystem` обязателен для новых записей и должен быть slug активной зарегистрированной системы; `id` и все ID — slugs.

**`computed` — производные числа стейта** (счётчик/сумма/итог; не держать их в `state` руками): `{"cartCount":{"op":"count","from":"/cart"}, "cartUnits":{"op":"sum","from":"/cart","field":"qty"}, "cartSubtotal":{"op":"sumProduct","from":"/cart","fields":["price","qty"]}, "cartTotal":{"op":"add","terms":["/cartSubtotal","/shippingFee",-500]}}`. Ключи — bare (как в `state`), читаются как обычный стейт (`{"$state":"/cartTotal"}`, `${/cartTotal}`). Значения read-only: `setState`/`pushState`/`removeState`/`$bindState`/`repeat` по computed-пути — ошибка валидации; терм `add`-пойнтера ссылается только на **ранее объявленный** ключ; деньги — целыми единицами. Лимиты и список операций — `GET /api/capabilities` (`computedOps`, `limits.computed*`). Построчная арифметика внутри repeat невыразима — кладите готовую строку полем item.

`surfaces?` — дуо-документ (история через два устройства сразу, общий стейт, две живые панели плеера; ровно две поверхности, каждый экран несёт `surface`, у desktop-поверхности обязателен `canvas`). Нужны `features.surfaces` **и** `features.surfacesWrite`; полные правила — `docs/prototype-format.md#surfaces-docsurfaces` на инстансе. Для одноповерхностной пересборки ДС поле не нужно.

Экран: `{id, name, canvas?: {width,height}, note?, stateOverrides?, spec: {root, elements}}`. Элемент: `{type, props, children?, visible?, on?, repeat?, slot?, region?}` — только эти ключи. Элементы образуют одно дерево от `root` (≤500 элементов, глубина ≤50).

`state` — единственный источник начального стейта; **обычный вложенный объект, ключи без слэша** (`{"method": "card"}`), пути директив — абсолютные JSON Pointer (`/method`), резолвятся внутрь объекта. `/currentScreen`, `/navStack`, `/_viewer` зарезервированы; сегменты `__proto__`/`prototype`/`constructor` запрещены.

**Директивы** (значение отдельного prop, не весь объект `props`):

- `{"$state": "/path"}` — чтение стейта;
- `{"$bindState": "/path"}` — двусторонняя привязка;
- `{"$template": "Hello ${/name}"}` — интерполяция;
- `{"$cond": {"if": condition, "then": literal, "else": literal}}` — выбор значения (только точно эта форма);
- `{"$asset": "asset_<sha256>"}` — URL загруженного ассета (см. «Ассеты»);
- внутри repeat-поддерева: `{"$item": "field"}` (поле текущего item, shallow) и `{"$index": true}`.

Condition: boolean, truthiness `{"$state":"/path"}`, либо `{"$state":"/path", eq|neq|gt|gte|lt|lte: ..., not?: true}` (максимум один оператор; `gt/gte/lt/lte` — только статические числа); внутри repeat — также `$item`/`$index`. Композиция — `{"$and":[...]}` / `{"$or":[...]}`.

**Repeat (списки из стейта)**: `repeat: {statePath: "/items", key?: "id"}` на элементе повторяет его поддерево-шаблон для каждого item массива. Лимиты: вложенный repeat запрещён, ≤20 repeat-элементов на экран, `Hotspot` внутри repeat нельзя, суммарный бюджет раскрытия — 2000 отрендеренных элементов (превышение в initial state — ошибка валидации).

**Named slots** (только custom-компоненты с `capabilities.namedSlots`): у ребёнка ставится `slot: "header"` — имя из `definition.slots` родителя; дети без `slot` идут в `default`. На одном элементе `repeat` + слоты-дети несовместимы (repeat на детях слота — можно).

**События и экшены**: имя события объявлено в definition компонента; значение — экшен или последовательный массив. Терминальный экшен максимум один и последний: `navigate {screenId}`, `back {}`, `restart {}`, `openUrl {url}`. Нетерминальные: `setState {statePath, value}`, `pushState {statePath, value, clearStatePath?}`, `removeState {statePath, index}`.

**Payload и условные экшены — только события custom-компонентов** (host-типы не получают эту семантику по имени):

- источники значений в params: `{"$event": "/ptr"}` (указатель внутрь payload; `""` — весь payload), `{"$elementId": true}`, `{"$itemIndex": true}` / `{"$itemKey": true}` (внутри repeat; `$itemKey` требует `repeat.key`). Допустимы в `value` state-экшенов, `removeState.index` и `navigate.screenId`; `openUrl.url` всегда статический;
- `"$if": condition` на экшене — пропуск при false; condition дополнительно принимает `{"$event":"/ptr"}`-операнд;
- `$event` допустим только на событии с объявленной payload-схемой.

**URL и Hotspot**: `openUrl.url` — статический `http(s)`; host `Image.src` дополнительно допускает абсолютный путь с `/`. `Hotspot` требует `canvas` у экрана; его прямоугольник — статические числа внутри canvas.

**Warnings**: save возвращает несблокирующие semantic warnings (interactive-элемент без обработчиков, отсутствие accessible label, state path вне документа и т.п.) — драйвер печатает их; каждое означает неработающую директиву в рантайме. Чистый прототип не шумит.

### Сценарии: `flows` и дерево `parentId`

Опциональный `flows[]` описывает сценарии поверх графа `navigate`: они видны в `/p/<id>/cjm` и в переключателе сценариев плеера. UI редактирования нет — флоу пишутся руками в JSON и уезжают тем же `node driver.mjs prototype doc.json`.

Флоу: `{id, name, description?, parentId?, steps: [{screenId, note?}]}`.

Два вида флоу, и они не симметричны:

- **корневой** (без `parentId`) — дорожка: связный проход по navigate-графу. `flows[0]` — главная линия, её первый шаг обязан быть `startScreen`, экраны в ней уникальны. Корневые флоу обязаны быть связными;
- **дочерний** (`parentId`) — упорядоченная **выборка** экранов, а не цепочка. Дорожки не получает; лист из одного экрана — нормальная форма.

Жёсткие правила, которые ловит валидация на записи:

1. **`flows[0]` неприкосновенен** — всегда корневой и всегда нулевой элемент массива. Не давать ему `parentId`, не сдвигать с индекса 0 (сдвиг молча меняет главную линию и геометрию CJM);
2. **родителя объявлять раньше ребёнка** — вставлять детей сразу после родителя, массив читается как pre-order; из этого же следует запрет циклов;
3. глубина ≤ 4, корень = уровень 1 (актуальное значение — `limits.flowDepth` в `GET /api/capabilities`);
4. лимиты: 24 флоу, 50 шагов на флоу, 320 шагов суммарно; пустой `flows: []` невалиден — поле просто опускается.

Приём авторинга: держать главную линию короткой (5–7 экранов), а полноту уводить в детей. Экраны переиспользуются между сценариями — копий не делать.

### Layout guide

Использовать стандартные layout-пропы компонентов вместо служебных элементов и CSS-классов:

- `gap` — промежуток между детьми flow-слота родителя;
- `padding` — внутренний отступ со всех четырёх сторон; `paddingX`/`paddingY` перекрывают его на своей оси.

Шкала `spaceToken`: `none | xs | sm | md | lg | xl | 2xl | 3xl | 4xl`. Канонические fallback-значения: `0 | 4 | 8 | 12 | 16 | 24 | 32 | 48 | 64px`. Фактические значения дизайн-системы брать из `resolvedSpaceScale` каталога (`catalog list <ds> --json` → `designSystem.resolvedSpaceScale`) или capabilities: тема может переопределять шкалу. Токены `2xl+` — для макроотступов (секции, границы экрана), не для интервалов внутри контролов.

Предпочитать `gap` на родителе штабелям spacer-компонентов. `className` — best-effort escape hatch: Tailwind-утилита может отсутствовать в собранном CSS; не применять для позиционирования или spacing между siblings.

`Overlay` — для viewport-sticky контента (`placement`, при необходимости `inset` и `scrim`): только прямым ребёнком root экрана; на desktop без `canvas` запрещён. Не имитировать Overlay абсолютным позиционированием.

Для фиксированных областей мобильного flow-экрана — `region: "statusBar" | "header" | "footer"` только на прямых детях root. Такой экран обязан иметь root типа `@eui/FlowRoot`; сам FlowRoot допустим только в root, без `repeat`/`visible`/`on`. Каждый kind встречается не более одного раза. Типовая структура:

```json
{
  "root": { "type": "@eui/FlowRoot", "props": {}, "children": ["status", "header", "content", "footer"] },
  "status": { "type": "StatusBar", "props": {}, "region": "statusBar" },
  "header": { "type": "AppHeader", "props": {}, "region": "header" },
  "content": { "type": "Content", "props": {} },
  "footer": { "type": "TabBar", "props": {}, "region": "footer" }
}
```

В mobile fluid present statusBar скрывается, header/footer закрепляются, content скроллится между ними.

После сборки экрана запускать численную проверку:

```bash
node driver.mjs geometry <protoId> <screenId>
```

Вывод — rect'ы, computed CSS gap'ы, роли (`panel`, `frame`, `region:*`), `safeArea`, `viewportOwnership` и `issues[]` (`content-clipped-by-frame`, `overlapping-regions`, `footer-owns-page`). `gaps: n/a` означает «flow-контекст недоказуем», а не нулевой зазор; issues — предупреждения, exit code не меняют.

### Ассеты

Картинки/шрифты/иконки не встраивать base64 — загружать в реестр и ссылаться `{"$asset": "<id>"}`:

```bash
curl -u "$EASYUI_LEGACY_BASIC_AUTH" -c /tmp/easyui.cookies \
  -H "Origin: https://easy-ui.pay-offline.ru" -H "Content-Type: application/json" \
  -d '{"name":"'"$EASYUI_USERNAME"'","password":"'"$EASYUI_PASSWORD"'"}' \
  https://easy-ui.pay-offline.ru/api/auth/login
curl -u "$EASYUI_LEGACY_BASIC_AUTH" -b /tmp/easyui.cookies -X POST \
  -H "Origin: https://easy-ui.pay-offline.ru" -H "Content-Type: image/png" --data-binary @banner.png \
  https://easy-ui.pay-offline.ru/api/assets
# {"id":"asset_<sha256>","url":"/api/assets/asset_...","sha256":"...","mime":"image/png",...}
```

Если внешний барьер отключён, обе опции `-u` убрать; named login и cookie остаются обязательными. Дедуп по sha256, лимит 5 MiB, magic-byte проверка типа (png/jpeg/webp/gif/svg/woff2/ttf/otf).

### Проверка рендеримости

`node driver.mjs status <id> <screenId>` — машинный `render-status`: `{renderable, status: {document, bundles, route}, resolvedPins, warnings, errors}` (exit 1, если не renderable). `node driver.mjs status <id> --all-screens [--json]` проходит по всем экранам драфта разом.

### Версии и публикация прототипа

Каждое сохранение — неизменяемая ревизия (драфт). Плеер показывает драфт сразу — publish не обязателен. Зафиксировать версию: `node driver.mjs publish <id> --verify` (драйвер сам подставляет `baseRev` головы).

## Сценарий 2: кастомный компонент + прототип

Сначала — reuse gate (раздел выше): search → решение → только потом создание.

Контракт TSX-модуля — named export `definition` + default plain function component (`memo`/`forwardRef` нельзя). Образцы: `examples/rating-stars.tsx` (простейший, ABI v1) и `examples/plan-picker.tsx` (typed events + named slots, ABI v2):

- `definition.props` — Zod **strict** схема; `description: string` обязателен; опционально `slots?: string[]`, `example?`, `examples?` (до 8 именованных наборов props, имя — slug 1–32 символа, `default` зарезервирован), `atomicLevel?`, `capabilities?: {typedEvents?, namedSlots?}` (литеральные `true` — писать `{...} as const`), семантика для валидатора (`interactive?`, `accessibleLabelProps?`, `urlProps?`). Сервер сохраняет провалидированный **input**, а не результат Zod transform/default.
- `events` — `string[]` (payload-less, legacy) **или** `Record<name, ZodSchema>` (typed payload). Typed-схема обязана детерминированно конвертироваться в JSON Schema — transform/preprocess дадут 422 `event_schema_not_serializable` на publish.
- Компонент получает `{props, emit, slots}`; для typed/slots-компонентов импортируйте тип `EasyUIComponentProps` из `easy-ui/runtime` — `emit("choose", {id, price})` c payload (валидируется по схеме, `$`-ключи в payload запрещены), `slots.header` — ReactNode именованного слота (`children === slots.default`).
- Импортировать можно: `react`, `react-dom`, `react/jsx-runtime`, `zod`, `@json-render/react`, `easy-ui/runtime` (ABI v2: `token`, `Icon`) и `easy-ui/runtime/v3` (ABI v3: `space`). Value-imports v2 и v3 в одном модуле смешивать нельзя; type-only импорт v2 вместе с value-import v3 разрешён. CSS-импорты и произвольные Tailwind-классы нельзя — стилить inline-стилями и CSS-переменными темы (`var(--border)`, `var(--eui-*)`).
- Renderer передаёт document props как есть и не применяет Zod-defaults: каждый компонент обязан повторять объявленный default оборонительным fallback в render-коде (`space(props.gap ?? "none")`).
- `hostAbiVersion` вычисляется на publish автоматически: capabilities или импорт `easy-ui/runtime` → 2, иначе 1.
- Лимит source — 256 KiB; JSON-тело запроса — 1 MiB.

```bash
node driver.mjs component rating-stars RatingStars examples/rating-stars.tsx \
  --design-system yandex-pay \
  --intent "Let a customer rate a product from one to five stars" \
  --figma figma.json   # опционально: provenance {fileKey, nodeIds, referenceScreenshots?, lastSyncedAt?}
# saved rating-stars rev 1 in yandex-pay
# published rating-stars version 1 in yandex-pay
```

`--figma` кладёт provenance одним вызовом вместе с source и **опционален**: provenance **наследуется** между ревизиями (резолв при чтении по последней записи среди ревизий `≤ rev`), поэтому update или `component-move` без флага её больше не обнуляют. Слать флаг при каждом вызове не нужно — он нужен ровно там, где ссылку задают сразу при создании.

Смена или очистка ссылки — отдельный верб, **без** новой ревизии и версии:

```bash
node driver.mjs provenance rating-stars figma.json            # provenance головы
node driver.mjs provenance rating-stars figma.json --rev 7    # provenance конкретной ревизии
node driver.mjs provenance rating-stars null                  # явная очистка (tombstone)
```

Требует `features.acceptanceProvenance` в `/api/capabilities` (на старом сервере верб падает читаемо, `--figma` продолжает работать). Повтор идентичного значения дедуплицируется (`unchanged: true`). Provenance опубликованной версии сознательно мутабельна: `--rev` опубликованной ревизии меняет то, что отдаёт `GET /api/components/:id/versions/:v`; иммутабельна только байтовая часть версии. Доступ — владелец компонента или админ (`share`/`capture` — 403).

Систему для компонента выбирает `--design-system`, затем `EASYUI_DESIGN_SYSTEM`; для создания она обязательна, при обновлении сохраняется текущая. Имя — уникальное `^[A-Z][A-Za-z0-9]*$`, после создания неизменно. Драйвер делает save + publish за один вызов. Save проверяет только синтаксис и контракт; **тип-ошибки ловит publish** — в ответе вывод tsc.

Дальше — обычный прототип с этим типом (`examples/rating-demo.json` использует `RatingStars`).

**Пины фиксируются на момент сохранения прототипа**: последующий publish компонента не меняет уже сохранённый прототип. Чтобы подтянуть новую версию компонента — пересохранить прототип (повторный `driver.mjs prototype`).

Перенос без изменения source и регистрация новой системы:

```bash
node driver.mjs component-move rating-stars --design-system yandex-pay
node driver.mjs design-system my-system "My Design System" "Components for my product"
```

## Дизайн-система yandex-pay: скелет экрана и паттерны

Основная DS инстанса — `yandex-pay` (компоненты `Yp*` + host `Overlay`/`Image`/`Hotspot`/`@eui/FlowRoot`). Проверенный сквозной пример — `examples/yp-checkout-demo.json` (2 экрана: чекаут с repeat-списком заказа, выбором способа оплаты через `$cond`+`setState`, sticky-футером через FlowRoot region и экраном успеха).

- **`YpScreen`** — каркас экрана. Его `<main>` — **flex row**: давайте ему **ровно одного ребёнка** — колонку `YpBox {mode:"col", width:"full"}`. Два ребёнка встанут рядом по горизонтали.
- **Sticky-футер (`YpStickyPaymentFooter`)** — НЕ ребёнок YpScreen; канон — через region:

```json
"root":   { "type": "@eui/FlowRoot", "props": {}, "children": ["screen", "footer"] },
"screen": { "type": "YpScreen", "props": { "title": "Оплата", "fullscreen": true }, "children": ["content"] },
"footer": { "type": "YpStickyPaymentFooter", "region": "footer", "props": { ... }, "on": { "press": { "action": "navigate", "params": { "screenId": "success" } } } }
```

- **`YpBox` растёт по умолчанию** (`flex: 1 1 auto`): вложенные ряды в колонке-контенте растягиваются на свободную высоту. На каждом YpBox, который должен обнимать контент, ставить **`"shrink": true`**. Проверять `geometry` — высоты rect'ов должны соответствовать контенту.
- Строковый проп `footer` у `YpScreen` — просто текст без событий; для CTA с переходом — `YpStickyPaymentFooter` (events `press`/`legalPress`) или `YpButton` (event `press`).

Типовые блоки:

| Задача | Компонент | Заметки |
|---|---|---|
| Каркас экрана | `YpScreen` | один ребёнок-колонка; `fullscreen: true` |
| Layout | `YpBox` | `mode: row\|col`, `gap/padding*` токенами; `justify: between`; `shrink: true` на вложенных |
| Текст | `YpText` | `size` — enum строк (`"11"…"52"`), `medium`/`bold`, `color` |
| Деньги | `YpAmount` | `amount` — **строка**; локализованный формат + знак ₽ |
| Способ оплаты | `YpPaymentMethodCard` | событие `select`; `anatomy: generic\|sbp-bank\|bank-card` |
| CTA-футер | `YpStickyPaymentFooter` | через `region: "footer"` |
| Кнопка | `YpButton` | обязательный `text`; событие `press` |
| Разделитель | `YpSeparator` | без пропов |
| Экран успеха | `YpSuccessPaymentCard` | `label` + `cardMask` |

Паттерны интерактива (все в `examples/yp-checkout-demo.json`):

- **Выбор из N карточек**: `selected: {"$cond":{"if":{"$state":"/method","eq":"card"},"then":true,"else":false}}` + `on.select → setState /method`.
- **Список из стейта**: `repeat: {statePath:"/items", key:"title"}` на `YpBox`-обёртке, внутри `{"$item":"title"}`.
- **CTA с суммой**: `ctaLabel: {"$template":"Оплатить ${/total} ₽"}`.
- Переходы: `press → navigate {screenId}`; возврат в начало — `restart`.

## Посмотреть результат

Ссылка `…/p/<id>` из вывода драйвера открывается в браузере под теми же кредами; экраны — `…/p/<id>/s/<screenId>`. Отладка интеракций — добавить `?debug=1`: inspector-панель показывает события с payload, экшены, диффы стейта и статусы шрифтов.

Скриншоты снимает **только сервер** — один рендерер на всех (тот же браузер, шрифты и readiness-протокол, что у эталонов и приёмки); локальный playwright не нужен и драйвером не запускается. Верб — **`snap`** (`shoot` — его deprecated-алиас, разворачивается в `snap --all-screens`):

```bash
node driver.mjs snap my-flow ./shots                 # server-side: job API + PNG из asset registry
node driver.mjs snap my-flow ./shots --all-screens --json   # машинный отчёт по всем экранам
node driver.mjs snap my-flow ./shots --dsf 2 --theme dark   # ретина-масштаб и тёмная тема
# ./shots/<screenId>.png на каждый экран
```

Вьюпорт по умолчанию — canvas-aware (canvas экрана, иначе канонический вьюпорт устройства — паритет с `geometry`/`baseline`); переопределяется `--viewport WxH`. PNG = capture-поверхность × dsf; бюджет `surface × dsf² ≤ 16 Mpx` (лимит ингеста ассетов) проверяется до постановки job'а — крупный canvas при `--dsf 2` может не влезть.

Перед съёмкой драйвер сверяет `GET /api/capabilities` → секцию `renderer` и пишет на stderr предупреждение, если у сборки нет renderer-манифеста (`source: "fallback"` — dev-инстанс) или секции нет вовсе: кадры такого сервера несопоставимы с эталонами. Предупреждение съёмку не прерывает и на exit code не влияет.

**Exit codes `snap`:**

| Код | Значение | Что делать |
|---|---|---|
| `0` | PNG создан на всех экранах, product-ошибок нет | PNG всё равно смотреть глазами |
| `2` | PNG создан, но прототип логировал ошибки (`productErrors`) | чинить прототип/компонент; PNG уже лежат в `./shots` |
| `1` | PNG не создан (job error/timeout, 5xx, 501) | инфраструктура; драйвер уже сделал 2 попытки на экран |

Инфраструктурный шум (favicon, расширения браузера, `ERR_NETWORK_CHANGED`, `ResizeObserver loop`, посторонние origin'ы) сервер отдаёт в `infraNoise` и он **не** влияет на exit code.

### Скриншот одного компонента: `preview`

Взгляд на один компонент без probe-прототипа и пересохранений пинов — опубликованная head-версия (по умолчанию) или сохранённая head-ревизия без публикации (`--rev head-draft`, W2):

```bash
node driver.mjs preview rating-stars                       # props по умолчанию ({})
node driver.mjs preview rating-stars --example full        # именованный example из definition
node driver.mjs preview rating-stars props.json --dsf 2 --out shots/stars.png
node driver.mjs preview rating-stars --rev head-draft      # сохранённая, но не опубликованная head-ревизия
```

`props.json` (JSON-объект props) и `--example` взаимоисключающи. PNG — content-hug: воркер снимает сам элемент, а не вьюпорт. По умолчанию файл пишется в `author-shots/<id>/<id>-v<version>[-<example|props-файл>].png` (драфт: `…-draft-r<rev>[-…].png`), `--out` задаёт путь явно. Вывод всегда сообщает, что отрендерено: `preview <id> v<N>` / `preview <id> draft rev <N> bundleHash=… designSystemMetaVersion=… viewport=… dsf=… theme=…` (в `--json` те же поля). Exit-коды — как у `snap` (0 — PNG, 2 — PNG с product-ошибками, 1 — нет PNG).

Ограничения: published-режим работает **только по published-версии**; драфт-режим published-версии не требует, но идёт под троттлингом validate-префлайта (сборка candidate-bundle при холодном кэше; 429 `validate_in_flight` — повтор после завершения чужого прогона) и проверяет asset-refs драфта (422 `asset_not_found` до сборки); kill-switch `EASYUI_VALIDATE_DISABLED=1` гасит драфт-превью (published-режим работает). Цикл итерации без публикаций (W2): save ревизии через `PUT /api/components/:id` (verb `component` делает save+publish за вызов) → `preview --rev head-draft`; publish — один раз по итогам (повторный `component` с неизменным source, `--figma` передавать не нужно: PUT отвечает no-op `unchanged`, и драйвер публикует голову). `--theme` — только light/dark, **версия темы не пинуется** (берётся последняя, фактическая — в `designSystemMetaVersion` вывода); viewport 64..2000 × 64..4000 и `width × height × dsf² ≤ 20 000 000` (при `--dsf 3` потолок ~2,2 Mpx); очередь скриншотов concurrency 1, cap 5 — при `429 queue_full` драйвер ретраит с бэкоффом (до 5 попыток, счётчик `queueRetries` в `--json`).

### Числовая приёмка геометрии: `expect`

Числовой вердикт до пиксельного: `preview … --probe geometry --out actual.json` (компонентная поверхность, `features.componentGeometry`) либо `driver.mjs geometry <protoId> <screenId> --json > actual.json` (экран прототипа), затем

```bash
node driver.mjs expect expected.json actual.json                  # ±1px по умолчанию
node driver.mjs expect expected.json actual.json --tolerance 2 --json
# expect expected.json vs actual.json: 5 checks, 1 mismatch (tolerance ±1px)
# FAIL stack#0: gap expected 8, got 6
```

`expected.json` пишет автор из выписки макета: `{"tolerance":1,"elements":[{"key":"c","size":{"width":328,"height":56}},{"key":"stack","instance":0,"axis":"row","gap":8,"padding":{"left":16,"right":16},"tolerance":2}]}`. `key`/`instance` — маркер замера (у компонентной поверхности он один, ключ `c`); `size` — `{width?,height?}`; `gap` — число (все зазоры равны) или массив по порядку, меряется как наблюдаемый зазор между box'ами прямых видимых детей; `padding` — число или объект сторон, меряется как отступ между box'ом элемента и bounding box'ом детей. Ось: `axis` → computed `flexDirection` layout owner'а → вывод из rect'ов. Допуск: файловый `tolerance` (по умолчанию 1 px) < per-element `tolerance`; `--tolerance N` перекрывает файловый дефолт. Exit: 0 — сошлось, 2 — расхождения, 1 — битый файл. Верб оффлайновый.

**Итоговый цикл атома:** правка → save ревизии без публикации → `preview --rev head-draft` (пиксели) → `expect` (числа) → `POST /api/components/:id/validate` (publish-набор проверок без создания версии: typecheck/compile/import, definition, asset-refs, поля provenance; receipt не покрывает canonical-role и reuse-гейт) → **`accept`** (матричная приёмка всех состояний, если у компонента их больше одного) → **`promote` ровно один раз** (см. «Приёмка головы: `promote`», ссылки `candidateId`/`acceptanceRunId` — в «Матричной приёмке»).

### Приёмка головы: `promote`

Один вызов вместо «publish + ручные status-переходы»: `promote` делает validate-префлайт, публикует голову **без повторных typecheck/compile** (артефакты берутся из кэша префлайта) и переводит прежние active-версии в `superseded` — в одной транзакции с активацией новой.

```bash
node driver.mjs promote rating-stars                    # validate → promote, auto-supersede
node driver.mjs promote rating-stars --supersede none   # оставить прежние версии active
node driver.mjs promote rating-stars --strict-catalog   # отказать, если каталог сдвинулся после validate
```

- Требует `features.acceptancePromote` в `/api/capabilities` (kill-switch `EASYUI_ACCEPTANCE_DISABLED=1`); на старом сервере верб падает читаемо, `publish` продолжает работать.
- Терминальные отказы (не ретраить): `409 already_published` — голове нужна новая ревизия; `409 revision_conflict`/`source_hash_mismatch` — голова изменилась между validate и promote, повторить верб целиком; `409 canonical_role_conflict`/`catalog_changed` — обычный reuse-STOP; `422` — те же коды, что у publish.
- Каталого-временные проверки (host-имя, каноническая роль, атомарная политика, asset-refs) promote перепрогоняет — он их не обходит.
- KPI-срез по версиям: `node driver.mjs audit --versions [--design-system <id>]` (версии/active/статусы/колонка `acceptance`/даты на компонент; exit 2, если у компонента не осталось active-версии). Колонка `acceptance` — «есть/нет acceptance-evidence»: `<версий с непустым acceptanceRunId>/<всего>` плюс `active=yes|no`; нули по всему каталогу — норма, evidence появляется только у версий, опубликованных `promote` с пройденным раном. Тот же признак в библиотеке — `status.accepted` в `GET /api/catalog/library` (независим от `status.verified`, вне `catalogRevision`).

### Матричная приёмка семейства: `accept`

Приёмка всех состояний компонента одной командой вместо самописных matrix-скриптов: `POST /components/:id/candidates` (иммутабельный кандидат по head-ревизии) → `POST /acceptance-runs` → poll до терминального вердикта. Набор случаев, гейты (`render`, `readiness`, `geometry`, `visual`, `determinism`), severity, reuse и evidence считает **сервер**.

```bash
node driver.mjs accept pay-payment-card                       # кандидат → ран → poll → вердикт
node driver.mjs accept pay-payment-card --case-set cset_…     # ран по набору случаев вместо examples
node driver.mjs accept pay-payment-card --refresh failed      # переснять только упавшие случаи
node driver.mjs accept pay-payment-card --refresh alpha,beta  # переснять перечисленные case id
node driver.mjs accept pay-payment-card --baseline-run acc_…  # частичная пересъёмка по импакту
node driver.mjs accept pay-payment-card --evidence run.zip    # + скачать evidence-архив
node driver.mjs accept-status acc_…                           # вердикт уже поставленного рана
node driver.mjs impact pay-payment-card --candidate cand_… --baseline-run acc_…   # dry-run: что придётся переснять
```

- Требует `features.acceptanceMatrix` в `/api/capabilities` (opt-in `EASYUI_ACCEPTANCE_MATRIX=1`; на проде включено). Без него верб падает читаемо, `promote` продолжает работать.
- Прогресс (`completed/total`, `reused`, ETA) идёт в **stderr** — stdout принадлежит `--json`. Exit: 0 — `pass`/`pass_with_exceptions`, 2 — `fail`/`error`/`cancelled` и клиентский таймаут (`--timeout-sec`, дефолт 1800; ран на сервере продолжается, добирать вердикт — `accept-status <runId>`).
- Байты evidence по умолчанию не качаются: печатается адрес архива; `--evidence <file.zip>` сохраняет zip (`manifest.json` + `SHA256SUMS` + артефакты случаев). Распаковывать только с проверкой имён записей (абсолютные пути и `..` отвергать).
- `409 acceptance_run_in_flight` — у кандидата уже есть живой ран: не ставить второй, дождаться его через `accept-status`.
- **Гейты случая.** `readiness` (обязателен в обоих профилях) судит тот же кадр, что снял `render`: `met:false` — продуктовый провал (шрифт/иконка/ассет не доехали, `pendingRequests` в `detail`), и по инварианту D5 сравнивающие гейты такого случая дают `indeterminate`, а не обвиняют компонент. `geometry` меряет **краску**: `layoutBounds` (union in-flow потомков), `paintBounds` (ink-bbox по альфе), `effectSources[]` (кто красит за коробкой: `filter`, `box-shadow`, `outline`, `transform`, `position:absolute|fixed`), `clipChain[]`; вердикт — `clean | paint-overflow-clipped | paint-overflow-not-clipped | layout-overflow | indeterminate`, а `fail` невозможен без названного источника. Допуски случая — `allowPaintOverflow`/`expectedClip`/`expectedGeometry` манифеста.
- **Визуальный гейт** сравнивает `paint.png` с эталоном случая (`referenceAssetId`), обрезав эталон по `cropLineage.rect` и добив обе картинки прозрачным до общего холста; расхождение габаритов больше `maxDimensionDeltaPx` профиля (`default-v1` — 8 px, `pixel-strict-v1` — 4 px) даёт `indeterminate`, а не выдуманный процент. Метрики: `rawDiffPct` (порог 0.1, по нему вердикт), `aaDiffPct` (порог 0.25 — структурный остаток), `maxChannelDelta`, `regions[]`, `bestOffset {dx,dy,residualPct}`. Бюджет — `policy.perCase.<id>.maxRawDiffPct`, иначе профильный (`default-v1` — 2 %, `pixel-strict-v1` — 0.5 %). Обязателен только в `pixel-strict-v1` или при `requireVisual: true` манифеста.
- **Причины и ремедиации.** Провалившийся/`indeterminate` визуальный случай несёт `causes[]` (`{code, confidence, detail, elementKey?, region?}`): `surface-tint`, `edge-radius-stroke`, `geometry-shift`, `text-raster-residual`, `missing-late-asset`, `alpha-compositing`, `effect-overflow`, `descendant-outside-mask`, `unclassified`. Терминальный ран несёт `remediationGroups` — случаи, сгруппированные по общей причине (виновник `elementKey` или сигнатура области + `variantFamily` — пересечение `dims` участников): одна сломанная иконка в 20 состояниях = одна группа с одним `suggestion`, а не 20 отдельных находок. Классификация — диагностика поверх вердикта, на pass/fail не влияет.
- **Частичная пересъёмка (`--baseline-run <runId>`).** `impact` считает базис заранее: `asset-only` (форма исходника побайтово та же, тема не менялась — переснимаются случаи, чьи наблюдённые `themeResources` содержат изменившийся ассет), `theme-only` (сменилась версия темы — переснимаются случаи, применившие изменившиеся токены/иконки; смена шрифта действует документ-широко → все), `conservative` (всё остальное, `reason` называет причину). Случай без readiness-evidence всегда считается затронутым — молчаливого reuse не бывает; явный `--refresh` перебивает импакт.
- **Ссылка приёмки на публикацию**: `promote` принимает `candidateId`/`acceptanceRunId` (в теле запроса, не флагами верба) — ран обязан быть терминальным `pass`/`pass_with_exceptions` этого же кандидата, иначе `422 acceptance_run_mismatch`/`acceptance_run_not_passed`; при живом ране — `409 acceptance_run_in_flight`. Обе ссылки записываются в строку опубликованной версии как provenance.

### Набор случаев семьи: `case-set`

Именованных `examples` хватает атому, но не семье из 49 состояний с эталонами из макета. Такой набор описывается **манифестом** и публикуется как сущность: сервер валидирует его целиком и адресует контентно (`caseSetId = "cset_" + sha256` канонизованного манифеста), поэтому повторная публикация того же манифеста идемпотентна, а изменённый манифест — **новый** набор (старые раны остаются воспроизводимыми).

```jsonc
{
  "manifestVersion": 1,
  "componentId": "pay-payment-card",
  "source": { "fileKey": "…", "componentSetNodeId": "54863:9518" },
  "capture": { "viewport": { "width": 390, "height": 844 }, "deviceScaleFactor": 2, "theme": "light" },
  "dimensions": { "family": ["Product", "Split"], "state": ["Default", "Disabled"] },
  "policy": { "profile": "pixel-strict-v1", "perCase": { "split-disabled": { "maxRawDiffPct": 2 } } },
  "cases": [
    { "id": "product-default", "props": { "family": "Product", "state": "Default" },
      "dims": { "family": "Product", "state": "Default" },
      "referenceAssetId": "asset_<sha256>", "expectedGeometry": { "width": 140, "height": 96 },
      "cropLineage": { "parentNodeId": "54863:9518", "rect": [0, 0, 140, 96] } },
    { "id": "product-default-copy", "props": { "family": "Product", "state": "Default" }, "aliasOf": "product-default" }
  ]
}
```

```bash
node driver.mjs case-set put pay-payment-card matrix.json   # публикация манифеста → caseSetId + coverage
node driver.mjs case-set coverage cset_…                    # чего не хватает в матрице
node driver.mjs case-set get cset_…                         # манифест обратно
```

- `case.id` — charset `^[A-Za-z0-9._-]{1,64}$` (из него строятся имена записей evidence-архива), поэтому **node id макета вида `54863:9537` не пройдёт** — санитизировать на своей стороне.
- Эталон — **id ассета реестра** (`asset_<sha256>`, загрузить через `POST /api/assets`), а не байты: несуществующий ассет — `422 asset_not_found`. Эталоны потребляются визуальным гейтом (см. выше), `cropLineage.rect` обязателен, если эталон вырезается из общего фрейма матрицы.
- Два случая с одинаковыми props — `422 duplicate_case_props`; осознанный дубликат помечается `aliasOf` (снимается один кадр, вердикт наследуется). Алиас обязан повторять props цели и не может ссылаться на другой алиас.
- Покрытие: `expectedTuples` — декартово произведение `dimensions`, `missingTuples` — незакрытые ячейки, `duplicates` — ячейки с двумя случаями. Манифест без `dimensions` получает тривиальный coverage.
- Неполные `dims` и расхождение props со схемой опубликованного компонента — **`warnings`**, а не отказ.
- `capture` манифеста задаёт поверхность съёмки набора, `policy.perCase` входит в `case_policy_hash` случая: правка допуска одного случая инвалидирует reuse ровно его.

### Клиентский кэш ответов: `--cache-dir`

Глобальные флаги любого верба: `--cache-dir <dir>` (или `EASYUI_CACHE_DIR`) включает локальный кэш read-only ответов, `--cache-refresh` (или `EASYUI_CACHE_REFRESH=1`) форсирует промах.

```bash
node driver.mjs catalog list yandex-pay --cache-dir .easyui-cache --json
node driver.mjs accept pay-payment-card --case-set cset_… --cache-dir .easyui-cache --json
```

- **Кэш — ускоритель, а не свидетельство**: доказательство остаётся серверным, а в отчёт всегда идёт `cache.status` (`hit|miss|refresh|off`; в `--json` — поле, иначе строка в stderr).
- Кэшируются только read-only GET'ы (capabilities, каталог, версии компонентов, кандидаты, case-set'ы, **терминальные** раны приёмки и их evidence). Мутации, auth и нетерминальные раны — никогда.
- Ключ включает идентичность (`sha256(baseUrl + "\n" + username)`): общий каталог не отдаёт ответы чужой учётки. Токены и куки в кэш не пишутся, каталог создаётся с правами `0700`, blob'ы сверяются с `SHA256SUMS` (подмена = промах). При `EASYUI_LEGACY_BASIC_AUTH` кэш выключен.

### Отпечаток рендерера

`GET /api/capabilities` → `renderer` и `GET /api/health` → `renderer` объявляют идентичность рендерера **до съёмки**: `browserName`/`browserVersion`, `launchedExecutable` (фактически это `chrome-headless-shell`, а не полный `chrome`), sha запускаемого бинаря, хэши шрифтового стека, флагов запуска и readiness-политики, и итоговый `fingerprint`. Он входит в отпечаток случая приёмки, поэтому апгрейд браузера честно инвалидирует накопленный reuse, а `provenance` (buildSha/imageRef) в отпечаток **не** входит — иначе каждый коммит обнулял бы приёмку.

Практическое следствие: если фактическая версия браузера воркера разошлась с объявленной, capture-джоба терминализуется `{"status":"error","error":{"code":"renderer_mismatch"}}` и кадра нет вовсе. Это не дефект компонента и не ретраится клиентом — сообщать владельцу инстанса (образ разъехался с манифестом).

### Служебные прототипы: галереи, `track: head`, профиль readiness

Probe-прототип нужен только со стадии молекул. Служебность объявляется **lifecycle-роутом, а не полем документа**: `POST /api/prototypes/:id/lifecycle {"kind":"component-gallery","track":"head"}`. `track: "head"` (`features.prototypeHeadTracking`) резолвит компонентные пины дока на последние active-публикации прямо на чтении — пересохранять галерею после каждой публикации компонента не нужно; разрешён только для служебных `kind` непубликованного дока (`422 track_requires_service_kind`/`track_requires_unpublished`), а publish/share/visual-baseline/bundle-export такого дока → `422 prototype_head_tracking`. Версия темы остаётся пином ревизии: после PATCH темы пересохранить (список — в `stalePins` ответа PATCH). Постановка снапа возвращает разрешённые пины в `components[]`. Warnings служебной галереи — **не блокер**: readiness служебных `kind` считается с `profile: "service"`, предупреждения не поднимают статус; технические `Hotspot`'ы и `on`-биндинги ради нулевого счётчика не нужны. Тема правится sparse-операциями `addTokens`/`addFonts`/`addIcons` поверх `baseVersion` с `dryRun: true` (append-only, конфликт значения → `409 theme_append_conflict`; патч без изменений → `noop: true` без новой версии).

### Визуальная регрессия (evidence loop)

Рабочий цикл: создать эталоны → внести правку → опубликовать компонент → пересохранить прототип, чтобы обновить пины → проверить кандидата.

```bash
node driver.mjs baseline my-flow ./baseline-png
# правка → component/publish → повторный `prototype my-flow.json`
node driver.mjs check my-flow --threshold 0.1
```

`baseline` снимает все экраны одной ревизии и атомарно заменяет весь набор. `check` сравнивает каждый member активного набора с текущей draft-ревизией и завершается с non-zero при любом несовпадении.

## Готовность, публикация, аудит

```bash
node driver.mjs readiness my-flow                    # таблица гейтов; --json — полный отчёт
node driver.mjs publish my-flow --verify             # отказ, если хоть один гейт fail
node driver.mjs publish my-flow --force              # публиковать вопреки блокирующим гейтам
node driver.mjs usages rating-stars --tree           # где компонент используется (head + immutable)
node driver.mjs audit --design-system yandex-pay     # свод по каталогу: версии, deprecated, usages
```

- `readiness` печатает по строке на гейт (`id`, `status` из `pass|warn|fail|unknown`, `summary`). Блокирующие гейты включаются на **сервере**; по умолчанию отчёт информационный.
- `publish --verify` — клиентская проверка: отказывает при любом `fail`-гейте. `--force` переживает серверную блокировку (но не `--verify`).
- `usages` показывает head-использования (что сломается сейчас) и immutable-использования (пины опубликованных версий делают компонент неудаляемым).

## Инспекция и удаление

```bash
node driver.mjs get prototypes            # список (id, headRev, latestVersion, ...)
node driver.mjs get components my-comp    # один ресурс: headRev, versions
node driver.mjs get design-systems        # реестр активных custom-систем
node driver.mjs get assets                # ассеты и счётчики hard-pin usage
node driver.mjs delete prototypes my-flow # hard delete (prototypes) / soft (components)
node driver.mjs diff my-flow              # head против head-1; `diff my-flow 1 3 --json` — полный JSON
```

Удаление компонента — soft: опубликованные bundle и пины существующих прототипов продолжают работать. Неудачную версию можно пометить статусом (`rejected|deprecated|superseded|archived`) через `POST /components/:id/versions/:v/status`; `rejected`/`archived` перестают исполняться, `deprecated`/`superseded` работают с warning'ом, новые пины берут только `active`.

## Gotchas

- Прототип **обновляется, а не создаётся заново**: `doc.id` — глобальный ключ. Не занимайте чужие id — `get prototypes` покажет, что уже есть. Тестовые прототипы удалять: `node driver.mjs delete prototypes <id>`.
- Все мутации требуют `baseRev` (409 при гонке) — драйвер берёт `headRev` сам; при ручном `curl` не забыть.
- Директива не может заменить весь объект `props`; `$cond` принимается только в канонической форме `{"$cond":{if,then,else}}`.
- Показ/скрытие целого элемента — `visible` с condition, не `$cond` в props.
- `$event`/`$if`/`slot` работают по definition custom-компонента; host-типы не получают custom-семантику.
- `$itemKey` требует `repeat.key`; `$item`/`$index` вне repeat-поддерева — ошибка.
- Длинные JSON-тела в шелле не инлайнить (бэктики выполняются как command substitution) — писать payload в файл; драйвер избавляет от этого.
- `state` — обычный объект без слэшей в ключах: `{"/method": "card"}` сохранится с warning'ом, но каждый `$state: "/method"` не будет работать.
- Очередь скриншотов на сервере ограничена (429 при переполнении — повторить).

## Troubleshooting

- `401` на login — неверны `EASYUI_USERNAME`/`EASYUI_PASSWORD` либо, при включённом внешнем барьере, `EASYUI_LEGACY_BASIC_AUTH` (формат `user:pass`). `401` после успешного login — истёкшая/отозванная cookie-сессия.
- `HTTP 429 rate_limited` — rate-limit на логин (5/мин на аккаунт); в норме не случается благодаря кэшу сессии — проверить, не задан ли `EASYUI_SESSION_CACHE=0`; подождать минуту и повторить.
- `save failed (422) ... "Unrecognized key: \"bogus\""` — prop отсутствует в exact definition активной custom-версии; заново `catalog get`.
- `save failed (422) ... "Unknown or unpublished component type: X"` — тип не встроенный и не опубликован как компонент; сначала `driver.mjs component ...`.
- `publish failed (422) ... Type check failed` (компонент) — читать вывод tsc в issue; save такие ошибки не ловит.
- `publish failed (422) ... event_schema_not_serializable` — typed-схема события содержит transform/preprocess; упростить до чистых object/string/number/enum-схем.
- `save failed (409)` — параллельное редактирование того же id (CAS-конфликт); повторить запуск драйвера (он перечитает `headRev`).
- `409 component_reuse_required` / `canonical_role_conflict` / `catalog_changed` — терминальный STOP, см. «Главное правило».
- `snap` вернул 501 `screenshot_unavailable` — инстанс без `SERVE_DIST`/chromium (голый локальный сервер); на проде работает.
- Джоба съёмки завершилась `renderer_mismatch` — фактический браузер образа разошёлся с объявленным манифестом рендерера; кадра нет, клиентский ретрай не поможет (см. «Отпечаток рендерера»).
- `unknown flag ... --local-browser` или ожидание локального playwright — локальной съёмки в драйвере нет: снимает серверный рендерер, `shoot` — алиас `snap --all-screens`.
- На stderr `renderer: server renderer has no manifest (source: fallback…)` — снимает dev-сборка своим браузером; PNG получите, но сравнивать их с эталонами и приёмкой прода нельзя.
- `409 acceptance_run_in_flight` — у кандидата уже идёт ран приёмки: не ставить второй, дождаться через `accept-status <runId>`.
- Случай приёмки провалил `readiness` (`met:false`) — кадр снят до того, как доехали шрифт/иконка/ассет: сравнивающие гейты этого случая честно отдают `indeterminate`. Чинить ресурс (тема, реестр ассетов), а не компонент.
- Экран «рендерится, но пусто/не так» — `node driver.mjs status <id> <screen>` (пины/бандлы/маршрут), `node driver.mjs geometry <id> <screen>` (rect'ы/issues) и `?debug=1` в плеере (события, payload, диффы стейта).
