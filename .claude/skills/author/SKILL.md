---
name: author
description: Add prototypes and custom components to easy-ui over its HTTP API — build a multi-screen prototype JSON flow, author a custom TSX component, publish them to the easy-ui server (prod or local), and screenshot the result in the player. Use when asked to create, add, update, or publish an easy-ui prototype or component.
---

# Authoring prototypes & components in easy-ui (remote API)

easy-ui — просмотрщик кликабельных прототипов на опубликованных custom-компонентах и host-типах `Image`/`Hotspot`/`Overlay`/`@eui/FlowRoot`. Этот скилл работает **только через HTTP API**. Харнес — `driver.mjs` (plain Node ≥18, без зависимостей).

Два сценария, от частого к редкому:

1. **Прототип из активного custom-каталога** — получить exact definitions, написать JSON, отправить драйвером.
2. **Новый React-компонент + прототип** — TSX-модуль публикуется через API, затем используется как обычный тип.

## Setup

```bash
export EASYUI_USERNAME="alice"             # named account
export EASYUI_PASSWORD="account-password"
export EASYUI_LEGACY_BASIC_AUTH="edge:secret" # только пока включён внешний compatibility-барьер
# по умолчанию драйвер ходит на https://easy-ui.pay-offline.ru
# другой инстанс (например локальный): export EASYUI_API="http://127.0.0.1:8787/api"
```

Драйвер логинится named-аккаунтом, сохраняет session cookie и добавляет `Origin` к API-запросам. Если задан `EASYUI_LEGACY_BASIC_AUTH`, Basic-заголовок отправляется и на login, и далее. Проверка доступа:

```bash
node driver.mjs get prototypes
```

## Сценарий 1: прототип из custom/host компонентов

1. Перед авторингом открыть каталог выбранной системы **двумя шагами** (политика — `docs/agent-authoring-policy.md`):

```bash
node driver.mjs catalog list yandex-pay                      # инвентарь: id, name, version, atomicLevel, events, slots, description
node driver.mjs catalog get yandex-pay YpScreen YpBox YpText # exact definitions только выбранных артефактов
```

   `catalog list` даёт имена, `catalog get` — exact definition (props/JSON Schema, examples, payloads) тех компонентов, которые реально нужны экрану. Props валидируются строго: неизвестный ключ = ошибка, поэтому писать документ без `catalog get` нельзя. Полный дамп (`node driver.mjs catalog yandex-pay [catalog.json] [--full]`) примерно на порядок дороже по контексту — запускать только когда нужен весь каталог целиком (инвентаризация, миграция, генерация SDK).
2. Написать документ по грамматике ниже (рабочий образец — `examples/rating-demo.json`, но замените в нём кастомный тип `RatingStars` на встроенный, если компонент не публиковали).
3. Отправить:

```bash
node driver.mjs prototype my-flow.json
# saved my-flow rev 1
# component pins: [...]
# player: https://easy-ui.pay-offline.ru/p/my-flow
```

Сервер валидирует документ сам (422 с точными `issues` при ошибке). Драйвер делает create-or-update: повторный запуск с тем же `doc.id` обновляет драфт (CAS по `headRev` берёт на себя). Ссылку player из вывода можно сразу открыть в браузере (те же basic-auth креды).

### Грамматика документа (format v1, строгий allowlist)

Полное описание — `docs/prototype-format.md` в репо; машинная версия — `GET /api/schemas/prototype-document.json`, сводка возможностей — `GET /api/capabilities` (actions, directives, param sources, лимиты). Ниже — рабочая выжимка.

Корень: `{version: 1, id, name, description?, designSystem, device?, startScreen, state?, computed?, screens[], flows?, architecture?}`. `designSystem` обязателен для новых записей и должен быть slug активной зарегистрированной системы; `id` и все ID — slugs.

Экран: `{id, name, canvas?: {width,height}, note?, stateOverrides?, spec: {root, elements}}`. Элемент: `{type, props, children?, visible?, on?, repeat?, slot?, region?}` — только эти ключи. Элементы образуют одно дерево от `root` (≤500 элементов, глубина ≤50).

`state` — единственный источник начального стейта; пути — абсолютные JSON Pointer (`/path`). `/currentScreen`, `/navStack`, `/_viewer` зарезервированы; сегменты `__proto__`/`prototype`/`constructor` запрещены.

**`computed` — производные числа стейта** (счётчик/сумма/итог; не хранить их в `state` вручную): `{"cartCount": {"op":"count","from":"/cart"}, "cartUnits": {"op":"sum","from":"/cart","field":"qty"}, "cartSubtotal": {"op":"sumProduct","from":"/cart","fields":["price","qty"]}, "cartTotal": {"op":"add","terms":["/cartSubtotal","/shippingFee",-500]}}`. Ключи — **bare** (как в `state`), читаются как обычный стейт: `{"$state":"/cartTotal"}`, `{"$template":"Итого: ${/cartTotal} ₽"}`. Значения read-only: `setState`/`pushState`/`removeState`/`$bindState`/`repeat` по computed-пути — ошибка валидации; терм `add`-пойнтера может ссылаться только на **ранее объявленный** ключ; деньги — целыми единицами (без округления, IEEE-754). Лимиты: 20 записей, 4 поля в `sumProduct`, 8 термов в `add` (`GET /api/capabilities` → `computedOps`, `limits.computed*`). Построчная арифметика («price × qty» в строке repeat) невыразима — кладите готовую строку полем item.

**Директивы** (значение отдельного prop, не весь объект `props`):

- `{"$state": "/path"}` — чтение стейта;
- `{"$bindState": "/path"}` — двусторонняя привязка;
- `{"$template": "Hello ${/name}"}` — интерполяция;
- `{"$cond": {"if": condition, "then": literal, "else": literal}}` — выбор значения (только точно эта форма);
- `{"$asset": "asset_<sha256>"}` — URL загруженного ассета (см. «Ассеты»);
- внутри repeat-поддерева: `{"$item": "field"}` (поле текущего item, shallow) и `{"$index": true}`.

Condition: boolean, truthiness `{"$state":"/path"}`, либо `{"$state":"/path", eq|neq|gt|gte|lt|lte: ..., not?: true}` (максимум один оператор; `gt/gte/lt/lte` — только статические числа); внутри repeat — также `$item`/`$index`. Композиция — `{"$and":[...]}` / `{"$or":[...]}`. `watch` и `$computed` остаются зарезервированными.

**Repeat (списки из стейта)**: `repeat: {statePath: "/items", key?: "id"}` на элементе повторяет его поддерево-шаблон для каждого item массива. Лимиты: вложенный repeat запрещён, ≤20 repeat-элементов на экран, `Hotspot` внутри repeat нельзя, суммарный бюджет раскрытия — 2000 отрендеренных элементов (считается рекурсивно, превышение в initial state — ошибка валидации). Рабочий образец в репо — `prototypes/composition-demo.json`.

**Named slots** (только custom-компоненты с `capabilities.namedSlots`): у ребёнка ставится `slot: "header"` — имя из `definition.slots` родителя; дети без `slot` идут в `default`. На одном элементе `repeat` + слоты-дети несовместимы (repeat на детях слота — можно).

**События и экшены**: имя события объявлено в definition компонента; значение — экшен или последовательный массив. Терминальный экшен максимум один и последний: `navigate {screenId}`, `back {}`, `restart {}`, `openUrl {url}`. Нетерминальные: `setState {statePath, value}`, `pushState {statePath, value, clearStatePath?}`, `removeState {statePath, index}`. Тип `Link` не имеет name-based семантики: URL/interactive metadata объявляется в definition.

**Payload и условные экшены — только события custom-компонентов** (host-типы не получают эту семантику по имени):

- источники значений в params: `{"$event": "/ptr"}` (указатель внутрь payload; `""` — весь payload), `{"$elementId": true}`, `{"$itemIndex": true}` / `{"$itemKey": true}` (внутри repeat; `$itemKey` требует `repeat.key`). Допустимы в `value` state-экшенов, `removeState.index` и `navigate.screenId` (runtime-guard по существующим экранам); `openUrl.url` всегда статический;
- `"$if": condition` на экшене — пропуск при false; condition дополнительно принимает `{"$event":"/ptr"}`-операнд в `eq`/`neq`/truthiness;
- `$event` допустим только на событии с объявленной payload-схемой.

Прочие params — статические литералы.

**URL и Hotspot**: `openUrl.url` — статический `http(s)`; host `Image.src` дополнительно допускает абсолютный путь с `/` (включая `$asset`-резолв). `Hotspot` требует `canvas` у экрана; его прямоугольник — статические числа внутри canvas.

**Warnings**: save возвращает несблокирующие semantic warnings (interactive-элемент без обработчиков, отсутствие accessible label, большой inline base64, экраны без переходов и т.п.) — драйвер печатает их; чистый прототип не шумит.

### Сценарии: `flows` и дерево `parentId`

Опциональный `flows[]` описывает сценарии поверх графа `navigate`: они видны в `/p/<id>/cjm` и в переключателе сценариев плеера. UI редактирования флоу нет — флоу пишутся руками в JSON и уезжают тем же `node driver.mjs prototype doc.json`. Полные правила — `docs/prototype-format.md` («Flows» и «Scenario tree»).

Флоу: `{id, name, description?, parentId?, steps: [{screenId, note?}]}`.

Два вида флоу, и они не симметричны:

- **корневой** (без `parentId`) — дорожка: связный проход по navigate-графу. `flows[0]` — главная линия, её первый шаг обязан быть `startScreen`, экраны в ней уникальны. Корневые флоу обязаны быть связными (иначе warning) и соблюдать правило соседних якорей;
- **дочерний** (`parentId`) — упорядоченная **выборка** экранов, а не цепочка. Дорожки не получает; с него сняты правило соседних якорей (error) и warning'и «разрыв связности» и «флоу из одного шага». Лист из одного экрана — нормальная форма.

Жёсткие правила, которые ловит валидация на записи:

1. **`flows[0]` неприкосновенен** — он всегда корневой и всегда нулевой элемент массива. Не давать ему `parentId`, не сдвигать с индекса 0 (сдвиг молча меняет главную линию и геометрию CJM; `driver.mjs diff` показывает это как смену главного сценария);
2. **родителя объявлять раньше ребёнка** — вставлять детей сразу **после** родителя, массив должен читаться как pre-order. Это единственное правило порядка; из него же следует запрет циклов и самоссылок;
3. глубина ≤ 4, **корень = уровень 1** (актуальное значение — `limits.flowDepth` в `GET /api/capabilities`);
4. лимиты: 24 флоу, 50 шагов на флоу, 320 шагов суммарно; пустой `flows: []` невалиден — поле просто опускается.

Минимальное трёхуровневое дерево, которое можно скопировать (экраны переиспользуются между сценариями — копий не делать):

```json
"flows": [
  { "id": "main-line", "name": "Главная линия",
    "steps": [{ "screenId": "home" }, { "screenId": "transfers" }, { "screenId": "by-phone" }, { "screenId": "amount" }, { "screenId": "receipt" }] },
  { "id": "payments", "name": "Переводы и платежи", "parentId": "main-line",
    "steps": [{ "screenId": "transfers" }, { "screenId": "by-phone" }, { "screenId": "amount" }] },
  { "id": "by-phone-detail", "name": "Перевод по номеру телефона", "parentId": "payments",
    "steps": [{ "screenId": "by-phone" }, { "screenId": "amount" }] },
  { "id": "receipt-leaf", "name": "Квитанция о переводе", "parentId": "payments",
    "steps": [{ "screenId": "receipt" }] }
]
```

Приём авторинга: держать главную линию короткой (5–7 экранов), а полноту уводить в детей. Не использовать `parentId` только чтобы заглушить диагностику на сценарии, который по смыслу является дорожкой, — `parentId` одновременно убирает флоу из дорожек CJM. Рабочий образец в репо — `test/fixtures/flows-tree.json`.

### Дуо-док: флоу через две поверхности (`surfaces`)

Когда история идёт **через два устройства сразу** (КСО ↔ приложение покупателя, касса продавца ↔ телефон) и важно видеть, как меняется состояние второй поверхности, — это дуо-документ. Плеер показывает две живые панели бок о бок, с **одним общим стейтом** на сессию.

Перед авторингом — `GET /api/capabilities`: нужны `features.surfaces` (образ понимает формат) **и** `features.surfacesWrite` (запись разрешена; иначе save отвечает `422 surfaces_disabled` — это не чинится ретраем, включается переменной `EASYUI_SURFACES=1` на сервере). Число поверхностей — `limits.surfaces` (v1 — ровно две).

```json
{
  "designSystem": "app-ds",
  "device": "mobile",
  "startScreen": "app-home",
  "surfaces": [
    { "id": "app", "name": "Приложение", "device": "mobile", "startScreen": "app-home" },
    { "id": "kso", "name": "КСО", "device": "desktop", "designSystem": "kso-ds", "startScreen": "kso-idle" }
  ],
  "state": { "order": { "status": "idle", "statusLabel": "Нет активного заказа", "total": 1290 } },
  "screens": [
    { "id": "app-home", "surface": "app", "name": "…", "spec": { … } },
    { "id": "kso-idle", "surface": "kso", "name": "…", "canvas": { "width": 1280, "height": 800 }, "spec": { … } }
  ]
}
```

Жёсткие правила, которые ловит валидация на записи:

1. **ровно две поверхности**, id уникальны; `surfaces[0]` — primary, и скаляры документа обязаны с ней совпадать: `doc.device === surfaces[0].device`, `doc.startScreen === surfaces[0].startScreen`. `surface.designSystem` опционален и по умолчанию равен `doc.designSystem` (то есть ДС primary);
2. **каждый экран несёт `surface`** с существующим id (и наоборот: `surface` на экране документа без `surfaces` — ошибка). Молчаливых дефолтов нет;
3. **у desktop-поверхности каждый экран обязан иметь `canvas`** — без него desktop-панель не масштабируется. Следствие: canvas-экран **не может** использовать `region`/`@eui/FlowRoot`, поэтому статус-бар и шапку терминала рисуйте прямо в макете экрана. Mobile/tablet-поверхности регионы сохраняют;
4. `surface.startScreen` — экран **этой** поверхности;
5. компонент экрана резолвится в ДС **его поверхности**: тип чужой системы = «unknown component type».

**Выбор primary — не косметика.** `token()` и `Icon` читают глобальный снапшот **primary**-ДС целиком (и токены, и иконки), поэтому иконко/токен-зависимую систему (обычно брендовую, вроде `yandex-pay`) ставьте **первой поверхностью**. Компоненты второй поверхности красьте `color()`/`space()` — они компилируются в `var(--eui-*)` и скоупятся правильно. Сервер вернёт неблокирующий warning при любых двух ДС в документе — это напоминание, а не ошибка. Второй warning — про совпадение `family` шрифтов двух тем: побеждает primary.

**Статусы — через общий стейт, а не вторым `navigate`.** В одном событии допустим **максимум один терминальный экшен**, поэтому «переключить обе панели одним кликом» невыразимо by design. Канон: касса делает `setState /order/status` + `navigate` на свой (или чужой) экран, а вторая панель показывает статус биндингом `{"$state":"/order/statusLabel"}` / `${/order/statusLabel}`. Навигация на экран **другой** поверхности переносит фокус на неё; первая панель остаётся живой и кликабельной.

**Сценарии и объяснение.** У шага флоу есть `companions: {"<surfaceId>": "<screenId>"}` — «что в этот момент на другой поверхности»: ключ — не своя поверхность, значение — её экран. Guided browse и переход из CJM выставляют обе панели, а вид «Сценарии» рисует парный тайл. Текстовое пояснение («что происходит на кассе») — `step.note`; чтобы companion-тайл показывал нужный статус, дайте его экрану `stateOverrides`.

**Ссылки.** Путь несёт сфокусированный экран, query — экраны остальных поверхностей: `/p/<id>/s/<screenId>?on.<surfaceId>=<screenId>`. Поверхность на своём `startScreen` в query не пишется. Такой ссылкой воспроизводится любой corner-кейс (таймаут оплаты, отмена на кассе) — именно так их и показывают человеку. `restart` возвращает обе поверхности на `startScreen` и вычищает `on.*`.

**Съёмка.** `snap`/`baseline`/`geometry` берут вьюпорт и каталог от **поверхности экрана** (десктопный экран — по своему canvas, мобильный — 390×844), кадр — поэкранный, в дефолтном состоянии дока и без второй панели. Композитного дуо-кадра нет: corner-статусы второй поверхности показывают живым плеером или share-ссылкой, не PNG.

**Ограничения v1:** ровно две поверхности; экспорт бандла дуо-дока — `422 surfaces_not_exportable`; композиция допустима только на экранах ДС документа (`422 composition_foreign_design_system`); переключатель девайса в плеере на дуо-доке скрыт, а в редакторе контролы `device`/`startScreen`/ДС документа задизейблены (правка — только через API/этот скилл); поверхности не заводятся в UI редактора. `track: "head"` и share несовместимы (см. «Служебные прототипы»), поэтому демо-док, который открывают человеку по ссылке, трекающим быть не может.

Рабочий образец в репо: `test/fixtures/duo-kso.json` (две ДС, corner-кейсы таймаута/отмены/повторного сканирования) и `test/fixtures/duo-pos.json` (одна ДС). Полные правила — `docs/prototype-format.md#surfaces-docsurfaces`, серверный контракт — `docs/server-api.md#мульти-поверхностные-документы-docsurfaces`.

### Layout guide

Использовать стандартные layout-пропы компонентов вместо служебных элементов и CSS-классов:

- `gap` — промежуток между детьми flow-слота родителя;
- `padding` — внутренний отступ со всех четырёх сторон;
- `paddingX` — внутренний отступ по logical inline axis, перекрывает `padding` на этой оси;
- `paddingY` — внутренний отступ по logical block axis, перекрывает `padding` на этой оси.

Шкала `spaceToken`: `none | xs | sm | md | lg | xl | 2xl | 3xl | 4xl`. Канонические fallback-значения: `0 | 4 | 8 | 12 | 16 | 24 | 32 | 48 | 64px`. Фактические значения дизайн-системы брать из `resolvedSpaceScale` каталога (`node driver.mjs catalog list <system> --json` → `designSystem.resolvedSpaceScale`) или capabilities сервера: тема может переопределять шкалу. `none` всегда равен нулю; отсутствие пропа сохраняет собственный дефолт компонента. Токены `2xl+` оставлять для макроотступов — секций, границ экрана и крупных пустых состояний, а не для обычных интервалов внутри контролов.

Предпочитать `gap` на родительском `YpBox` штабелям `YpSpacer`; spacer оставлять для legacy-композиций, где родитель не поддерживает spacing contract. Например:

```json
{
  "root": { "type": "YpBox", "props": { "mode": "col" }, "children": ["a", "s1", "s2", "b"] },
  "s1": { "type": "YpSpacer", "props": { "size": 8, "axis": "vertical" } },
  "s2": { "type": "YpSpacer", "props": { "size": 8, "axis": "vertical" } }
}
```

После:

```json
{
  "root": { "type": "YpBox", "props": { "mode": "col", "gap": "lg", "paddingX": "lg", "paddingY": "sm" }, "children": ["a", "b"] }
}
```

Полные документы: `examples/yp-spacing-before.json` и `examples/yp-spacing-after.json`; эталонные исходники — `examples/yp-box.tsx`, `examples/yp-block.tsx`, `examples/yp-spacer.tsx`. Для ABI v3 импортировать `space` только из `easy-ui/runtime/v3`; `space("md")` возвращает CSS-ссылку `var(--eui-space-md, 12px)`. Renderer передаёт document props как есть и не применяет Zod-defaults: каждый компонент обязан повторять объявленный default оборонительным fallback в render-коде (`space(props.gap ?? "none")`, tolerant lookup maps). Проверять `{}` против явных defaults пиксельно на видимом child.

`Overlay` использовать для viewport-sticky контента: задать `placement`, при необходимости `inset` и `scrim`. Overlay разрешён только прямым ребёнком root экрана; на desktop без `canvas` запрещён. Не имитировать Overlay абсолютным позиционированием.

Для фиксированных областей мобильного flow-экрана использовать `region: "statusBar" | "header" | "footer"` только на прямых детях root. Такой экран обязан иметь root типа `@eui/FlowRoot`; сам FlowRoot допустим только в root, без `repeat`/`visible`/`on`. Каждый kind встречается не более одного раза, несовместим с `repeat`/`slot`, `Overlay`/`Hotspot` и `Hotspot` в поддереве. Регионные поддеревья должны быть self-contained. Типовая структура:

```json
{
  "root": { "type": "@eui/FlowRoot", "props": {}, "children": ["status", "header", "content", "footer"] },
  "status": { "type": "StatusBar", "props": {}, "region": "statusBar" },
  "header": { "type": "AppHeader", "props": {}, "region": "header" },
  "content": { "type": "Content", "props": {} },
  "footer": { "type": "TabBar", "props": {}, "region": "footer" }
}
```

В mobile fluid present statusBar скрывается, header/footer закрепляются, а content скроллится между ними. На остальных поверхностях структура рендерится inline в авторском порядке.

После сборки экрана запускать численную проверку:

```bash
node driver.mjs geometry <protoId> <screenId>
```

Наблюдаемые зазоры и computed CSS gap должны совпадать с `resolvedSpaceScale` выбранной DS. `gaps: n/a` означает, что flow/wrap/DOM-контекст нельзя доказать, а не нулевой зазор.

Кроме rect'ов вывод содержит роли (`panel`, `frame`, `region:header|footer|statusBar`), `safeArea`, `viewportOwnership` (какую долю фрейма занимает каждая роль) и `issues[]` — структурные предупреждения `content-clipped-by-frame`, `overlapping-regions`, `footer-owns-page`. Это предупреждения, а не ошибки: exit code `geometry` они не меняют.

`className` — best-effort escape hatch: Tailwind-утилита может отсутствовать в собранном CSS. Не применять `className` для позиционирования или spacing между siblings; использовать layout props и Overlay. Статические positioning/inset/z-index/margin utilities дают advisory warning `layout/classname-positioning`.

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

Если внешний барьер отключён, обе опции `-u` следует убрать; named login и cookie остаются обязательными.

Дедуп по sha256 (повторная загрузка вернёт тот же id), лимит 5 MiB, magic-byte проверка типа (png/jpeg/webp/gif/svg/woff2/ttf/otf). Из custom TSX ассет доступен по строковому URL `/api/assets/asset_<sha256>` — такие ссылки пинуются при publish.

### Проверка рендеримости

`node driver.mjs status <id> <screenId>` — машинный `render-status`: `{renderable, status: {document, bundles, route}, resolvedPins, warnings, errors}` (exit 1, если не renderable). `node driver.mjs status <id> --all-screens [--json]` проходит по всем экранам драфта разом и падает списком нерендеримых. Ответ save также содержит канонические URL всех экранов — драйвер их печатает.

### Версии и публикация прототипа

Каждое сохранение — неизменяемая ревизия (драфт). Плеер показывает драфт сразу — publish не обязателен. Зафиксировать версию (v1, v2, …): `node driver.mjs publish <id> --verify` (драйвер сам подставляет `baseRev` головы) или сырым `POST /prototypes/:id/publish` c `{baseRev}` через тот же cookie jar, `Origin` и, если включён, внешний Basic-заголовок. Подробности — «Готовность, публикация, аудит».

## Сценарий 2: кастомный компонент + прототип

### Reuse gate: обязательная остановка перед новым компонентом

Канон политики — **`docs/agent-authoring-policy.md`** (та же политика для агентов без скиллов — `AGENTS.md`); контракт эндпоинтов — `docs/server-api.md`. Ниже — рабочая выжимка.

Перед созданием нового custom-компонента сформулируйте содержательный `intent` — продуктовую задачу, которую он решает. Для нового id `driver.mjs component` требует `--intent <text>`; после trim это 8..500 символов и хотя бы один токен вне стоп-набора `component`, `компонент`, `element`, `элемент`, `ui`. Обновление существующего компонента intent не требует.

Начинайте с компактного каталога и раскрывайте только подходящие артефакты; `--json` удобен для машинного выбора:

```bash
node driver.mjs catalog list yandex-pay
node driver.mjs catalog search yandex-pay --intent "Let a customer rate a product from one to five stars" --limit 5 --json
node driver.mjs catalog get yandex-pay <candidate-id-or-name> --json
```

`catalog list` показывает компактный инвентарь, `catalog search` — кандидатов для intent, а `catalog get` — exact definition только выбранных компонентов. Если кандидат покрывает задачу, переиспользуйте его или расширьте существующий компонент вместо создания дубля.

При создании `driver.mjs component` сам выполняет ранний authoritative discovery с intent, source и метаданными предлагаемого компонента. Это помогает принять решение до мутации, но не обходит гонки: `POST /api/components` заново вычисляет reuse gate на сервере в транзакции.

Любой `409 component_reuse_required`, `canonical_role_conflict` или `catalog_changed` — терминальный **STOP**: драйвер выводит кандидатов и `decisionId` (с `--json` — структурированный отчёт), завершает процесс с exit code `2` и никогда не делает автоматический retry или `force-new`. Нормальный ответ человека — переиспользовать/расширить показанного кандидата. После `catalog_changed` заново выполните discovery и покажите новое решение человеку; старое подтверждение не переносится.

Только явное подтверждение человека для администраторского исключения разрешает повторить create с `--force-new --reason <text>`, где причина содержит 20..500 символов:

```bash
node driver.mjs component rating-stars RatingStars examples/rating-stars.tsx \
  --design-system yandex-pay \
  --intent "Let a customer rate a product from one to five stars" \
  --force-new --reason "Product owner approved a distinct rating interaction for this flow"
```

Для override драйвер использует server-authored `overrideTemplate` из свежего authoritative discovery verbatim: передаёт `catalogRevision` и полный `candidateKeys` без изменений и добавляет подтверждённую человеком причину. Raw HTTP API остаётся допустим для собственных клиентов, но это дополнительный путь; он обязан соблюдать тот же двухфазный STOP/override-контракт. Предпочтительный поддерживаемый путь для агента — `driver.mjs`.

Если задача — собрать экран из уже существующих компонентов, это **композиция**, а не новый компонент: `node driver.mjs composition <id> <doc.json> --design-system yandex-pay`, затем `node driver.mjs composition publish <id>`.

`definition.canonicalFor` объявлять только слагами из `docs/canonical-roles.md` и только если компонент — канонический выбор системы для этой продуктовой роли: роль уникальна внутри дизайн-системы, попытка забрать занятую даёт терминальный `409 canonical_role_conflict` и на create, и на publish.

Контракт TSX-модуля — named export `definition` + default plain function component (`memo`/`forwardRef` нельзя). Образцы: `examples/rating-stars.tsx` (простейший, ABI v1) и `examples/plan-picker.tsx` (typed events + named slots, ABI v2):

- `definition.props` — Zod **strict** схема; `description: string` обязателен; опционально `slots?: string[]`, `example?`, `examples?`, `atomicLevel?`, `capabilities?: {typedEvents?, namedSlots?}` (тип требует литеральные `true` — писать `{...} as const`), семантика для валидатора (`interactive?`, `accessibleLabelProps?`, `urlProps?`). `examples` содержит до 8 именованных наборов props: имя — slug 1–32 символа, `default` зарезервирован; каждый input ≤16 KiB, все examples компонента вместе ≤64 KiB. Сервер сохраняет провалидированный **input**, а не результат Zod transform/default.
- `events` — `string[]` (payload-less, legacy) **или** `Record<name, ZodSchema>` (typed payload). Typed-схема обязана детерминированно конвертироваться в JSON Schema — transform/preprocess дадут 422 `event_schema_not_serializable` на publish.
- Компонент получает `{props, emit, slots}`; для typed/slots-компонентов импортируйте тип `EasyUIComponentProps` из `easy-ui/runtime` — `emit("choose", {id, price})` c payload (валидируется по схеме, `$`-ключи в payload запрещены), `slots.header` — ReactNode именованного слота (`children === slots.default`).
- Импортировать можно: `react`, `react-dom`, `react/jsx-runtime`, `zod`, `@json-render/react`, `easy-ui/runtime` (ABI v2: `token`, `Icon`) и `easy-ui/runtime/v3` (ABI v3: `space`). Value-imports v2 и v3 в одном модуле смешивать нельзя; type-only импорт v2 вместе с value-import v3 разрешён. CSS-импорты и произвольные Tailwind-классы нельзя — стилить inline-стилями и CSS-переменными темы (`var(--border)`, `var(--eui-*)` из tokens системы).
- `hostAbiVersion` вычисляется на publish автоматически: capabilities или импорт `easy-ui/runtime` → 2, иначе 1.
- Лимит source — 256 KiB; JSON-тело запроса — 1 MiB.

```bash
node driver.mjs component rating-stars RatingStars examples/rating-stars.tsx \
  --design-system yandex-pay \
  --intent "Let a customer rate a product from one to five stars"
# saved rating-stars rev 1 in yandex-pay
# published rating-stars version 1 in yandex-pay
```

Систему для компонента выбирает `--design-system`, затем `EASYUI_DESIGN_SYSTEM`; для создания она обязательна, а при обновлении сохраняется текущая система. Флаг имеет приоритет над env. Перенос без изменения source и регистрация новой системы:

```bash
node driver.mjs component-move rating-stars --design-system yandex-pay
node driver.mjs design-system my-system "My Design System" "Components for my product"
```

Перенос создаёт и публикует новую ревизию, но старые published versions остаются в прежней системе. Имя компонента глобально уникально и не может совпадать с зарезервированными host-именами.

Имя — уникальное `^[A-Z][A-Za-z0-9]*$`, не конфликтующее со встроенным каталогом (см. reference), после создания неизменно. Драйвер делает save + publish за один вызов. Save проверяет только синтаксис и контракт; **тип-ошибки ловит publish** — в ответе вывод tsc:

```
publish failed (422): ... "Type check failed: ... error TS2339: Property 'missing' does not exist on type '{ value: number; label: string; }'."
```

Дальше — обычный прототип с этим типом (`examples/rating-demo.json` использует `RatingStars`):

```bash
node driver.mjs prototype examples/rating-demo.json
# component pins: [{"id":"rating-stars","name":"RatingStars","version":1,...}]
```

**Пины фиксируются на момент сохранения прототипа**: последующий publish компонента не меняет уже сохранённый прототип. Чтобы подтянуть новую версию компонента — пересохранить прототип (повторный `driver.mjs prototype`).

Именованные examples становятся вариантами компонента в Library и входят в контракт каталога. Использовать их для нескольких канонических состояний одного компонента; `example` остаётся одиночным legacy-примером.

### Приёмка атома: `preview` без probe-дока

Взглянуть на один компонент можно без сборки probe-прототипа и без пересохранений пинов — в двух режимах:

```bash
node driver.mjs preview rating-stars                       # published head-версия, props по умолчанию ({})
node driver.mjs preview rating-stars --example full        # именованный example из definition
node driver.mjs preview rating-stars props.json --dsf 2 --out shots/stars.png
node driver.mjs preview rating-stars --rev head-draft      # сохранённая, но НЕ опубликованная head-ревизия (W2)
```

`props.json` (JSON-объект props) и `--example` взаимоисключающи. PNG — content-hug: воркер снимает сам элемент, а не вьюпорт. По умолчанию файл пишется в `author-shots/<id>/<id>-v<version>[-<example|props-файл>].png` (драфт: `…-draft-r<rev>[-…].png`), `--out` задаёт путь явно. Вывод всегда сообщает, что отрендерено:

```
preview rating-stars v3 bundleHash=1f9c… designSystemMetaVersion=14 viewport=1280x800 dsf=2 theme=light
author-shots/rating-stars/rating-stars-v3-full.png
preview rating-stars draft rev 7 bundleHash=1f9c… designSystemMetaVersion=14 viewport=1280x800 dsf=1 theme=light
author-shots/rating-stars/rating-stars-draft-r7.png
```

**Итоговый цикл атома:** правка исходника → сохранение ревизии **без публикации** → `preview --rev head-draft` (пиксели) → `preview --rev head-draft --probe geometry` + `expect` (числа) → validate-префлайт (`POST /api/components/:id/validate` — publish-набор проверок без создания версии; неподдерживаемое поле provenance, тип-ошибка или битый asset-ref ловятся здесь) → **`promote` ровно один раз** по итогам приёмки (см. «Приёмка головы: `promote`»). Verb `component` делает save+publish за один вызов, поэтому промежуточные сохранения идут через HTTP (`PUT /api/components/:id` с `baseRev` — гейт создания на PUT не действует); финальная публикация головы — повторный `driver.mjs component` с неизменными source+`--figma` (PUT отвечает no-op `unchanged`, и драйвер публикует голову) либо `POST /api/components/:id/publish`. Драфт-режим снимает head-ревизию через эфемерный candidate-bundle префлайта validate: published-версия не требуется, а провал префлайта (тип-ошибки, битые asset-refs) приезжает тем же кодом, что отдаёт publish, — превью сломанного драфта сообщает причину, а не «нет бандла».

Exit-коды — как у `snap` (0 — PNG, 2 — PNG с product-ошибками, 1 — нет PNG). Честные ограничения (план agent-iteration DX, P1a/P1b):

- Published-режим работает **только по published-версии**: у компонента без неё драйвер предложит `--rev head-draft`. Драфт-режим, наоборот, не требует публикации вообще.
- Драфт-режим идёт под троттлингом validate-префлайта: постановка собирает candidate-bundle (при холодном кэше это заметное время) и может ответить `429 validate_in_flight`, если у той же учётки уже идёт префлайт, — повторить после его завершения; `429 queue_full` ретраится общим бэкоффом (см. ниже).
- Asset-ссылки драфта (`/api/assets/asset_…` в исходнике) обязаны существовать в реестре — иначе 422 `asset_not_found` ещё до сборки кандидата.
- Kill-switch `EASYUI_VALIDATE_DISABLED=1` гасит и draft-preview (`features.componentDraftPreview=false` в `/api/capabilities`); published-режим продолжает работать.
- `--theme` — только режим light/dark; **версия темы не пинуется** — рендер берёт последнюю, фактическая видна в `designSystemMetaVersion` вывода. После PATCH темы ничего пересохранять не нужно, но и воспроизвести старую тему нельзя.
- Лимиты viewport сервера: 64..2000 × 64..4000 и `width × height × dsf² ≤ 20 000 000` — при `--dsf 3` потолок вьюпорта ~2,2 Mpx (1280×800 при dsf 3 = 9,2 Mpx — влезает, 2000×1200 — уже нет).
- Очередь скриншотов на сервере — concurrency 1, cap 5: при занятой очереди enqueue отвечает `429 queue_full`; драйвер ретраит с бэкоффом (до 5 попыток), счётчик — `queueRetries` в `--json`.
- `--probe geometry` вместо PNG возвращает замер компонентной поверхности (`features.componentGeometry`); `--out` кладёт сырой результат джобы на диск — это готовый вход для `expect`. Маркер на компонентной поверхности ровно один: корневой элемент дерева съёмки с ключом `c`.

### Числовая приёмка геометрии: `expect`

Пиксельный дифф говорит «0,4% не совпало», числовая приёмка — «gap expected 8, got 6». Гонять её **до** пиксельной.

```bash
node driver.mjs preview rating-stars --rev head-draft --probe geometry --out actual.json   # компонент
node driver.mjs geometry my-flow checkout --json > actual.json                              # экран прототипа
node driver.mjs expect expected/rating-stars.json actual.json             # ±1px по умолчанию
node driver.mjs expect expected/rating-stars.json actual.json --tolerance 2 --json
```

`expected.json` пишет автор из выписки макета (Figma/дизайн-спека):

```json
{
  "tolerance": 1,
  "elements": [
    { "key": "c",     "size": { "width": 328, "height": 56 } },
    { "key": "stack", "instance": 0, "axis": "row", "gap": 8,
      "padding": { "left": 16, "right": 16 }, "tolerance": 2 }
  ]
}
```

- `key`/`instance` — маркер из замера (`instance` по умолчанию 0); отсутствующий в замере ключ — не «ok по умолчанию», а FAIL с перечнем доступных ключей.
- `size` — `{width?, height?}`; `gap` — число (все зазоры равны) либо массив по порядку; `padding` — число (все стороны) либо объект сторон.
- `gap` меряется как **наблюдаемый зазор** между box'ами прямых видимых детей (может отличаться от CSS gap на margin'ы), `padding` — как отступ между box'ом элемента и bounding box'ом его детей. Ось: `axis` → computed `flexDirection` layout owner'а → вывод из rect'ов.
- Допуск: `tolerance` в файле (по умолчанию 1 px), per-element `tolerance` перекрывает его, `--tolerance N` перекрывает файловый дефолт, но не per-element.
- Exit: 0 — сошлось, 2 — есть расхождения (каждое строкой `FAIL <key>#<instance>: <метрика> expected X, got Y`), 1 — битый файл/формат. Верб оффлайновый: сети не касается.

Пиксельная сверка с эталоном макета — `compare.mjs` из пакета `share/yp-figma-rebuild-skill` (кластеры расхождений, AA-diagnostic, `--region` с бюджетом, отчёт о несовпавших размерах).

### Приёмка головы: `promote`

Один вызов вместо «publish + ручные status-переходы»: `promote` сам делает validate-префлайт, публикует голову **без повторных typecheck/compile** (артефакты берутся из кэша префлайта) и переводит прежние active-версии в `superseded` — в одной транзакции с активацией новой.

```bash
node driver.mjs promote rating-stars                    # validate → promote, auto-supersede
node driver.mjs promote rating-stars --supersede none   # оставить прежние версии active
node driver.mjs promote rating-stars --strict-catalog   # отказать, если каталог сдвинулся после validate
node driver.mjs promote rating-stars --json
```

```
promoted rating-stars version 4 (rev 9) in yandex-pay
fingerprints: sourceHash=8c1f… bundleHash=1f9c… hostAbi=2 themeVersion=14 catalogRevision=cat-…
superseded: v3 (warm candidate: no recompile)
```

- Требует `features.acceptancePromote` в `/api/capabilities` (kill-switch `EASYUI_ACCEPTANCE_DISABLED=1`); на старом сервере верб падает читаемо, `publish` продолжает работать.
- Терминальные отказы (не ретраить автоматически): `409 already_published` — голова уже опубликована, нужна новая ревизия; `409 revision_conflict`/`409 source_hash_mismatch` — голова изменилась между validate и promote, повторить верб целиком; `409 canonical_role_conflict`/`catalog_changed` — обычный reuse-STOP, решение человека; `422` — те же коды, что у publish (кроме компиляционных: их уже отсеял validate).
- Promote **не** обходит каталого-временные проверки: имя host-примитива, каноническая роль, атомарная политика и asset-refs перепрогоняются на публикации.
- `publish` остаётся рабочим и не меняется — это путь для случаев, когда приёмка не нужна (или сервер её погасил).

### Служебные прототипы: галереи, `track: head`, профиль readiness

Probe-прототип (стикершит компонентов) нужен только со стадии молекул — атом принимается `preview`'ом. Если он всё же нужен, объявляй его служебным сразу после создания, **lifecycle-роутом, а не полем документа** (формат документа таких полей не имеет):

```bash
curl … -X POST -d '{"kind":"component-gallery","track":"head"}' \
  https://easy-ui.pay-offline.ru/api/prototypes/<id>/lifecycle
```

- `track: "head"` (`features.prototypeHeadTracking`) — компонентные пины дока резолвятся на последние active-публикации прямо на чтении: пересохранять галерею после каждой публикации компонента больше не нужно. Разрешён только для служебных `kind` и только пока прототип не опубликован (`422 track_requires_service_kind` / `track_requires_unpublished`), а publish/share/visual-baseline/bundle-export такого дока отвечают `422 prototype_head_tracking`.
- Скоуп резолва — **только компонентные пины**: версия темы остаётся пином ревизии, после PATCH темы галерею всё равно пересохранять (список устаревших пинов приходит в `stalePins` ответа PATCH).
- Постановка снапа возвращает разрешённые пины в `components[]` — сверяй их с ожидаемыми версиями вместо гадания.
- **Warnings служебной галереи — не блокер**: readiness служебных `kind` считается с `profile: "service"`, предупреждения не поднимают статус. Не добавляй технические `Hotspot`'ы и `on`-биндинги ради нулевого счётчика предупреждений.
- Перевести в служебный `kind` прототип, у которого уже есть публикации, нельзя (`422 service_kind_requires_unpublished`) — это был бы обход валидаторов задним числом.

## Посмотреть результат

Ссылка `…/p/<id>` из вывода драйвера открывается в браузере под теми же кредами; экраны — `…/p/<id>/s/<screenId>`. Отладка интеракций — добавить `?debug=1`: inspector-панель показывает события с payload, экшены, диффы стейта и статусы шрифтов.

Скриншоты — два способа, **предпочитать `snap`** (серверный рендер, playwright в окружении агента не нужен):

```bash
node driver.mjs snap my-flow ./shots                 # server-side: job API + PNG из asset registry
node driver.mjs snap my-flow ./shots --all-screens --json   # машинный отчёт по всем экранам
node driver.mjs shoot my-flow ./shots                # локальный playwright, если установлен
# ./shots/<screenId>.png на каждый экран
```

**Exit codes `snap`:**

| Код | Значение | Что делать |
|---|---|---|
| `0` | PNG создан на всех экранах, product-ошибок нет | ничего; PNG всё равно смотреть глазами |
| `2` | PNG создан, но прототип логировал ошибки (`productErrors`) | чинить прототип/компонент; PNG уже лежат в `./shots` |
| `1` | PNG не создан (job error/timeout, 5xx, 501) | инфраструктура/окружение; драйвер уже сделал 2 попытки на экран |

Инфраструктурный шум (favicon, расширения браузера, `ERR_NETWORK_CHANGED`, `ResizeObserver loop`, посторонние origin'ы) сервер отдаёт в `infraNoise` и он **не** влияет на exit code. `--json` печатает по экрану `{screenId, path, imageProduced, captureClean, productErrors, infraNoise, runtimeWarnings, attempts}`. Флаг `--json` есть у всех verb'ов; сессия кэшируется на диске между вызовами (`$XDG_STATE_HOME/easyui`, выключатель `EASYUI_SESSION_CACHE=0`, путь переопределяет `EASYUI_SESSION_FILE`), поэтому логин обычно один на серию вызовов; GET'ы и постановка job'а ретраятся на 5xx.

Серверные скриншоты также доступны сырым API (`POST /prototypes/:id/screens/:sid/screenshot {viewport,...}` → 202 `{jobId}` → `GET /screenshot-jobs/:jobId`; параметры theme/deviceScaleFactor/rev/version), включая скриншот одного компонента: `POST /components/:id/versions/:v/screenshot {props? | exampleName?, viewport}` — обёртка над ним: `driver.mjs preview` (см. «Приёмка атома»).

### Визуальная регрессия (evidence loop)

Рабочий цикл: создать эталоны → внести правку → опубликовать компонент → пересохранить прототип, чтобы обновить пины → проверить кандидата.

```bash
node driver.mjs baseline my-flow ./baseline-png
# правка → component/publish → повторный `prototype my-flow.json`
node driver.mjs check my-flow --threshold 0.1
```

`baseline` снимает все экраны одной ревизии и одним атомарным PUT заменяет весь набор. Каждое пере-baseline создаёт новое поколение; частичного обновления нет, и у прототипа активна только одна конфигурация viewport/theme/dsf. При гонке поколений драйвер не повторяет запись автоматически. Если capture оборвался или браузер сообщил ошибки, baseline не коммитится, но уже созданные PNG-ассеты остаются орфанными до будущей очистки.

Viewport выбирается для каждого экрана так: `--viewport` → `screen.canvas` (округление и clamp) → canonical device (`mobile 390×844`, `tablet 834×1112`) → desktop `1280×800`. **Девайс берётся от поверхности экрана** (`screen.surface` → `doc.surfaces[]`), а у обычного документа — от `doc.device`; та же логика у `snap` и `geometry` (`geometry` дополнительно тянет каталог ДС поверхности). Соблюдать лимит 20 Mpx с учётом `dsf²`.

`check` последовательно сравнивает каждый member активного набора с текущей draft-ревизией и завершается с non-zero при любом несовпадении/ошибке. `--json` даёт машинный результат.

## Готовность, публикация, аудит

```bash
node driver.mjs readiness my-flow                    # таблица гейтов; --json — полный отчёт
node driver.mjs publish my-flow --verify             # отказ, если хоть один гейт fail
node driver.mjs publish my-flow --force              # публиковать вопреки блокирующим гейтам
node driver.mjs usages rating-stars --tree           # где компонент используется (head + immutable)
node driver.mjs audit --design-system yandex-pay     # свод по каталогу: версии, deprecated, usages
```

| Verb | Флаги | API | Exit 0 | Exit 2 | Exit 1 |
|---|---|---|---|---|---|
| `readiness <protoId>` | `--json` | `GET /prototypes/:id/readiness` | `publishable: true` | не publishable или есть гейт `fail` | транспорт/404/5xx |
| `publish <protoId>` | `--verify`, `--force`, `--json` | `GET …/readiness` + `POST …/publish` | опубликовано (печатает версию и URL экранов) | `--verify` нашёл `fail`-гейт (публикации не было) или сервер ответил `409 publish_blocked` | транспорт, `revision_conflict`, `already_published` |
| `usages <componentId>` | `--tree`, `--json` | `GET /components/:id/usages[?format=tree]` | всегда при успешном ответе | — | транспорт/404 |
| `audit --design-system <ds>` | `--json` | `GET /catalog/manifest` + `GET /catalog/usages` | deprecated-компонентов в использовании нет | есть deprecated-компоненты, которые всё ещё пинуются головными ревизиями | транспорт, неизвестная дизайн-система |

- `readiness` печатает по строке на гейт (`id`, `status` из `pass|warn|fail|unknown`, `summary`) плюс заголовок `publishable=…`/`blocking=…`. Гейты, при которых publish блокируется, включаются на **сервере** переменной `EASYUI_PUBLISH_GATES` (CSV, `id` — блокировать при `fail`, `id:warn` — уже при `warn`); по умолчанию пусто, и отчёт носит информационный характер. `unknown` не блокирует никогда.
- `publish --verify` — клиентская проверка: она отказывает при любом `fail`-гейте, даже если сервер этот гейт не включил. `--force` уходит в тело как `{force: true}` и переживает серверную блокировку (но не `--verify`: сначала снять `--verify`).
- При `409 publish_blocked` драйвер печатает **отчёт из ответа**, а не сырую ошибку.
- `usages` показывает head-использования (что сломается сейчас) и immutable-использования (пины опубликованных версий — они делают компонент неудаляемым). `--tree` печатает прототип → экран → элемент.
- `audit` показывает по компоненту: версию, `active|deprecated`, `scope`/`canonicalFor` (если объявлены) и число головных использований; отдельными строками — deprecated в использовании и компоненты без использований.

## Инспекция и удаление

```bash
node driver.mjs get prototypes            # список (id, headRev, latestVersion, ...)
node driver.mjs get components my-comp    # один ресурс: headRev, versions
node driver.mjs get design-systems        # реестр активных custom-систем
node driver.mjs get assets                # ассеты и счётчики hard-pin usage
node driver.mjs get assets asset_<sha256> # все удерживающие hard pins и visual-run роли
node driver.mjs delete prototypes my-flow # hard delete (prototypes) / soft (components)
node driver.mjs delete design-system old-ds # ретайр системы: только пустая, иначе 409
```

Тема дизайн-системы правится **sparse-операциями с dry-run** (`PATCH /api/design-systems/:id`, `features.themeDryRun`/`themeSparseOps`): `addTokens`/`addFonts`/`addIcons` поверх `baseVersion` передают только добавляемое (append-only: существующая запись с другим значением → `409 theme_append_conflict`, удаление — только полным PATCH), `dryRun: true` возвращает дифф и итоговый `resolvedSpaceScale` без записи, а патч без фактических изменений версии не создаёт (`noop: true`). В ответе приезжает `stalePins` — прототипы, чья голова пинует старую версию темы: ровно их и надо пересохранить перед снапом (`track: head` тему не резолвит).

`delete <kind> <id>` принимает и единственное число (`component`, `design-system`). Ретайр дизайн-системы — мягкий (`retired=1`): она пропадает из `get design-systems` и из записи, но остаётся читаемой по прямому GET; повторный вызов → `409 design_system_retired`.

Ревью изменений между immutable-ревизиями:

```bash
node driver.mjs diff my-flow              # head против head-1
node driver.mjs diff my-flow 2            # head против rev 2
node driver.mjs diff my-flow 1 3 --json   # rev 3 против rev 1, полный JSON
```

Удаление компонента — soft: он исчезает из списка и недоступен новым сохранениям, но опубликованные bundle и пины существующих прототипов продолжают работать.

Сколько публичных версий стоил каждый компонент — `node driver.mjs audit --versions [--design-system <id>]` (KPI-срез поверх `GET /api/components/:id/versions`): версии, active-счётчик, статусы и даты на компонент плюс сводка `versions per published component`. Exit 2 — если у какого-то компонента не осталось ни одной active-версии.

Жизненный цикл версий компонента: у published-версии есть статус (`active` по умолчанию). Неудачную версию можно пометить, не удаляя: `POST /components/:id/versions/:v/status` c `{status: rejected|deprecated|superseded|archived, reason?, supersededBy?, baseStatusRev}` (CAS по `statusRev` из read-back версии). `rejected`/`archived` перестают исполняться (плеер покажет `bundle_failed` в render-status), `deprecated`/`superseded` продолжают работать с warning'ом. Новые пины и манифест берут только `active`.

Discovery: `GET /api/openapi.json` (полный OpenAPI 3.1), `GET /api/capabilities` (actions/директивы/лимиты/фичи/системы), `GET /api/schemas/prototype-document.json` и `.../component-definition.json` — источник истины, когда этого файла недостаточно. Опционально к компоненту/прототипу можно прикладывать Figma-происхождение: поле `figma: {fileKey, nodeIds[], referenceScreenshots?: [assetId], lastSyncedAt?}` рядом с `doc`/`source` в POST/PUT — сохраняется на ревизии, отдаётся в read-back.

## Gotchas

- Прототип **обновляется, а не создаётся заново**: `doc.id` — ключ. Не занимайте чужие id — `get prototypes` покажет, что уже есть.
- Все мутации требуют `baseRev` (409 при гонке) — драйвер берёт `headRev` сам; при ручном `curl` не забыть.
- Директива не может заменить весь объект `props`; `$cond` принимается только в канонической форме `{"$cond":{if,then,else}}`.
- Показ/скрытие целого элемента — `visible` с condition, не `$cond` в props.
- `$event`/`$if`/`slot` работают по definition custom-компонента; host-типы не получают custom-семантику.
- `$itemKey` требует `repeat.key`; `$item`/`$index` вне repeat-поддерева — ошибка.
- Длинные JSON-тела в шелле не инлайнить (бэктики выполняются как command substitution) — писать payload в файл; драйвер избавляет от этого.
- `shoot` ждёт `networkidle` — на медленном инстансе первый экран может грузить bundle компонента дольше секунды, это нормально. `snap` этим не страдает (серверный readiness-протокол сам ждёт шрифты и изображения), но очередь скриншотов на сервере ограничена (429 при переполнении — повторить).

## Troubleshooting

- `401` на login — неверны `EASYUI_USERNAME`/`EASYUI_PASSWORD` либо, при включённом внешнем барьере, `EASYUI_LEGACY_BASIC_AUTH` (формат `user:pass`). `401` после успешного login обычно означает истёкшую/отозванную cookie-сессию.
- `save failed (422 validation_failed): ...` + строки вида `issue /…: Unrecognized key: "bogus"` — prop отсутствует в exact definition активной custom-версии; заново получить каталог сервера.
- `save failed (400 invalid_request): Component source and design system are unchanged` — nothing to save: исходник идентичен head-ревизии, новой ревизии не создано; правьте source или ничего не делайте.
- `publish failed (409 already_published): ...` — nothing to publish: head-ревизия уже опубликована как есть; повторная публикация неизменённого компонента не нужна.
- `save failed (422) ... "Unknown or unpublished component type: X"` — тип не встроенный и не опубликован как компонент; сначала `driver.mjs component ...`.
- `publish failed (422 validation_failed): ...` + `issue /source: Type check failed` (компонент) — читать вывод tsc в issue; save такие ошибки не ловит.
- `publish failed (422) ... event_schema_not_serializable` — typed-схема события содержит transform/preprocess/custom-логику; упростить до чистых object/string/number/enum-схем.
- `save failed (409)` — параллельное редактирование того же id (CAS-конфликт); повторить запуск драйвера (он перечитает `headRev`).
- `shoot` падает с `Cannot find package 'playwright'` — использовать `snap` (серверные скриншоты, playwright не нужен) либо смотреть прототип в браузере по ссылке player.
- `snap`/`preview` вернул 501 `screenshot_unavailable` — инстанс без `SERVE_DIST`/chromium (например голый локальный `server:dev`); на проде работает. `429 queue_full` у `preview` ретраится драйвером самостоятельно.
- Экран «рендерится, но пусто/не так» — `node driver.mjs status <id> <screen>` (пины/бандлы/маршрут) и `?debug=1` в плеере (события, payload, диффы стейта).
