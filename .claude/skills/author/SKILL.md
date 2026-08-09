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

Собираетесь завести **композицию** — спросите тем же поиском, стоит ли:

```bash
node driver.mjs catalog search yandex-pay --intent "Строка заказа с иконкой, названием и ценой" --kind composition --doc composition.json --json
```

Ответ добавляет `outcome` — один из трёх: `build-composition` (собирать; если дубль найден, в `explanation` названа существующая композиция — переиспользуйте её), `extend-component` (в каталоге уже есть компонент с этим контрактом — расширьте его) и `new-ownership-component` (тело требует поведения, которого в раскрытии композиции нет — в `analysis.unsupported` перечислено, какого). Без `--doc` сервер видит только intent: ни дубль по структуре тела, ни вердикт анализатора не считаются. **Исход рекомендательный** — `409 component_reuse_required` на композиции сервер не выдаёт, решение остаётся за вами.

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

- `definition.props` — Zod **strict** схема; `description: string` обязателен; опционально `slots?: string[]`, `example?`, `examples?`, `atomicLevel?`, `capabilities?: {typedEvents?, namedSlots?, runtimeSchemaDefaults?}` (тип требует литеральные `true` — писать `{...} as const`; `runtimeSchemaDefaults` заставляет хост применять Zod-дефолты схемы к props — процедура перевода из пяти шагов в `docs/agent-authoring-policy.md` §6), семантика для валидатора (`interactive?`, `accessibleLabelProps?`, `urlProps?`). `examples` содержит до 8 именованных наборов props: имя — slug 1–32 символа, `default` зарезервирован; каждый input ≤16 KiB, все examples компонента вместе ≤64 KiB. Сервер сохраняет провалидированный **input**, а не результат Zod transform/default.
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

**Итоговый цикл атома:** правка исходника → сохранение ревизии **без публикации** → `preview --rev head-draft` (пиксели) → `preview --rev head-draft --probe geometry` + `expect` (числа) → validate-префлайт (`POST /api/components/:id/validate` — publish-набор проверок без создания версии; неподдерживаемое поле provenance, тип-ошибка или битый asset-ref ловятся здесь) → **`promote` ровно один раз** по итогам приёмки (см. «Приёмка головы: `promote`»). Verb `component` делает save+publish за один вызов, поэтому промежуточные сохранения идут через HTTP (`PUT /api/components/:id` с `baseRev` — гейт создания на PUT не действует); финальная публикация головы — повторный `driver.mjs component` с неизменным source (`--figma` передавать не нужно — provenance наследуется; PUT отвечает no-op `unchanged`, и драйвер публикует голову) либо `POST /api/components/:id/publish`. Драфт-режим снимает head-ревизию через эфемерный candidate-bundle префлайта validate: published-версия не требуется, а провал префлайта (тип-ошибки, битые asset-refs) приезжает тем же кодом, что отдаёт publish, — превью сломанного драфта сообщает причину, а не «нет бандла».

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
# приёмочная линковка: версия получает provenance «кандидат + ран»
node driver.mjs promote rating-stars --candidate cand_… --acceptance-run acc_…
node driver.mjs promote rating-stars --acceptance-runs acc_a,acc_b --expected-cases 49   # шардированная семья (W7)
# без флагов связка выбирается автоматически: единственный promotionEligible-ран кандидата головы
```

```
acceptance link: candidate=cand_… (rev 9, validated) run=acc_… (pass, policy default-v1)
promoted rating-stars version 4 (rev 9) in yandex-pay
acceptance: candidate=cand_… run=acc_…
fingerprints: sourceHash=8c1f… bundleHash=1f9c… hostAbi=2 themeVersion=14 catalogRevision=cat-…
superseded: v3 (warm candidate: no recompile)
```

- Требует `features.acceptancePromote` в `/api/capabilities` (kill-switch `EASYUI_ACCEPTANCE_DISABLED=1`); на старом сервере верб падает читаемо, `publish` продолжает работать.
- Терминальные отказы (не ретраить автоматически): `409 already_published` — голова уже опубликована, нужна новая ревизия; `409 revision_conflict`/`409 source_hash_mismatch` — голова изменилась между validate и promote, повторить верб целиком; `409 canonical_role_conflict`/`catalog_changed` — обычный reuse-STOP, решение человека; `422` — те же коды, что у publish (кроме компиляционных: их уже отсеял validate).
- **Линковка с приёмкой (флаги верба):** `--candidate <candidateId>` и `--acceptance-run <runId>` уезжают в тело promote как `candidateId`/`acceptanceRunId` и записываются в строку версии как provenance. Драйвер сверяет связку **локально, до мутации**: кандидат обязан описывать ту же сборку, что и validate-receipt (`sourceHash` + `rev` головы), а ран — принадлежать этому компоненту и этому кандидату; расхождение = ошибка CLI без POST. Выбранная связка печатается строкой `acceptance link: …` **до** публикации, оба id есть и в человеческом выводе (`acceptance: candidate=… run=…`), и в `--json`. Флаги требуют `features.acceptanceMatrix`; без них promote публикует голову без линковки (как раньше). **Шардированная семья (W7):** если приёмка шла несколькими ранами (не влезли в один ран или осознанное шардирование light/dark), передавай **набор** — повторяемый `--acceptance-run a --acceptance-run b` либо `--acceptance-runs a,b` (до 8; требует `features.acceptanceMultiRunPromote`, иначе локальная ошибка до POST). Шарды обязаны быть дизъюнктны по `(propsHash, slotsHash, surface)` — одинаковые props на **разных** поверхностях (light/dark) законны, как и одинаковые props с разными `slotBindings`; пересечение внутри одной поверхности → `422 acceptance_coverage_overlap`; повтор `caseKey` между шардами — только warning. Все раны — одного кандидата, все `pass`, один и тот же профиль политики и один и тот же рендерер (`422 acceptance_policy_mismatch`/`acceptance_renderer_mismatch`). `--expected-cases N` включает сверку суммарного покрытия (`422 acceptance_coverage_incomplete`; кадры, а не строки: алиасы дублей считаются один раз). Порядок флагов не важен — сервер сортирует набор по `(created_at, run_id)` и кладёт его в `acceptanceRunIds` строки версии, а легаси `acceptanceRunId` = первый элемент.
- **Автовыбор связки (без флагов):** на сервере с `features.acceptanceMatrix` `promote <id>` сам ищет доказательную базу. Кандидат головы читается идемпотентным `POST /api/components/:id/candidates` (подсказка из link-store кэша — только чтобы назвать кандидата; всё, что решает исход, перечитывается с сервера), его `runs[]` — **прямым сетевым** запросом candidate-view мимо клиентского кэша: ответ мутабелен, и «свежий по TTL» вполне может не знать о ране минутной давности. Кандидат обязан описывать validate-receipt (`sourceHash` + `rev` головы), ран берётся только из `runs[].promotionEligible === true`. Исходы: ровно один подходящий ран — связка печатается строкой `acceptance link: … (auto-selected from the candidate runs)` до мутации; ноль — `warning` и публикация без линковки (прежнее поведение); **два и больше — терминальная локальная ошибка** со списком `runId/status/policy/finished` и без POST: выбирать за агента, какое свидетельство приписать версии, нельзя. Скалярный `candidate.acceptanceRunId` источником не является — это **последний поставленный** ран, а не принятый. В `--json` источник связки виден полем `acceptanceLinkSource: "flags"|"auto"|"none"`.
- Promote **не** обходит каталого-временные проверки: имя host-примитива, каноническая роль, атомарная политика и asset-refs перепрогоняются на публикации.
- `publish` остаётся рабочим и не меняется — это путь для случаев, когда приёмка не нужна (или сервер её погасил).

### Правка Figma-происхождения: `provenance`

Ссылка на Figma живёт отдельно от runtime-версий (append-only история с резолвом при чтении), поэтому её правка **не создаёт ни ревизии, ни версии** — раньше ради неё приходилось выпускать metadata-only версию.

```bash
node driver.mjs provenance rating-stars figma.json            # правка provenance головы
node driver.mjs provenance rating-stars figma.json --rev 7    # правка provenance конкретной ревизии
node driver.mjs provenance rating-stars null                  # явная очистка (tombstone)
node driver.mjs provenance rating-stars figma.json --json
```

- Требует `features.acceptanceProvenance` в `/api/capabilities`; на старом сервере верб падает читаемо, а `--figma` у верба `component` продолжает работать.
- Provenance **наследуется** ревизиями: обычный save без `--figma` её больше не обнуляет (резолв идёт по последней записи среди ревизий `≤ rev`). Очистка выражается только литералом `null`.
- Повтор идентичного значения дедуплицируется: ответ `unchanged: true`, `seq: null`, новой записи в истории нет.
- Provenance **опубликованной** версии сознательно мутабельна: `--rev` опубликованной ревизии меняет то, что отдаёт `GET /api/components/:id/versions/:v`. Иммутабельна только байтовая часть версии (`bundleHash`/бандл/`definition_meta`).
- Владелец компонента или админ; `share`/`capture`-принципалы — 403.
- Старый канон «слать `--figma` при каждом вызове `component`» **отменён**: флаг опционален и нужен только чтобы задать provenance одним вызовом при создании. Смена и очистка ссылки — верб `provenance`; сам флаг продолжает работать (тот же write-путь, та же seq-строка).

### Матричная приёмка семейства: `accept`

`accept` — серверная приёмка всех состояний компонента одной командой вместо самописных matrix-скриптов: `POST /candidates` (иммутабельный кандидат по head-ревизии) → `POST /acceptance-runs` → poll до терминального вердикта. Набор случаев строит **сервер** (в этой волне — именованные `examples` определения), он же считает reuse, severity и evidence.

```bash
node driver.mjs accept pay-payment-card                       # кандидат → ран → poll → вердикт
node driver.mjs accept pay-payment-card --refresh failed      # обновить только упавшие случаи (вердикт, кадр может быть переиспользован)
node driver.mjs accept pay-payment-card --refresh failed --recapture   # те же случаи, но с принудительной пересъёмкой
node driver.mjs accept pay-payment-card --refresh alpha,beta  # обновить перечисленные case id
node driver.mjs accept pay-payment-card --evidence run.zip    # + скачать evidence-архив
node driver.mjs accept pay-payment-card --summary             # компактный отчёт (канон для агента)
node driver.mjs accept-status acc_… --summary                 # вердикт уже поставленного рана, компактно
node driver.mjs accept-status acc_… --case disabled-dark      # drill-down: гейты, причины и квитанция одного случая
node driver.mjs accept-resume acc_…                           # продолжить ран, вставший без вердикта (рестарт сервера, phase_timeout, breaker аллокации)
node driver.mjs retry-disposition acc_…                       # стоит ли повторять: отпечаток блокера, глубина (unchanged/recompute/rediff/recapture/rebuild) и совет — ничего не снимает
node driver.mjs reject cand_… --reason "межстрочный интервал не по макету"  # отклонить сборку (терминально)
node driver.mjs impact pay-payment-card --candidate cand_… --baseline-run acc_…   # dry-run: что придётся переснять
node driver.mjs accept pay-payment-card --baseline-run acc_…  # частичная пересъёмка: снять только затронутое
```

```
acceptance pay-payment-card run acc_8f1c… verdict fail
cases: 49/49 reused=41 frameReused=47 recomputed=6 rediffed=0 failed=2
gates: contract[pass:49] geometry[pass:47 fail:2] visual[pass:49]
refresh: requested=verdict:failed impact=none effective=verdict:failed
failed cases (worst first):
  disabled-dark geometry raw=-% aa=-%: paint overflow 12px, source .highlight
remediation 4f1ab2c9d0e1: effect-overflow ×2: disabled-dark, disabled-light
evidence: GET /api/acceptance-runs/acc_8f1c…/evidence (pass --evidence <file.zip> to download)
drill down: driver.mjs accept-status acc_8f1c… --case <caseId>
```

- Требует `features.acceptanceMatrix` в `/api/capabilities` (opt-in `EASYUI_ACCEPTANCE_MATRIX=1`); без него верб падает читаемо, а путь `promote` продолжает работать.
- Прогресс (`completed/total`, `reused`, ETA) идёт в **stderr** — stdout принадлежит `--json`. Exit: 0 — `pass`/`pass_with_exceptions`, 2 — `fail`/`error`/`cancelled` и клиентский таймаут (`--timeout-sec`, дефолт 1800; ран на сервере продолжается, добирать вердикт — `accept-status <runId>`).
- Байты evidence по умолчанию **не** качаются: печатается адрес архива; `--evidence <file.zip>` сохраняет zip (`manifest.json` + `SHA256SUMS` + артефакты).
- **Алгебра refresh: `--refresh` выбирает случаи, `--recapture` — глубину.** `--refresh none|failed|all|id,id2` отвечает на вопрос «какие случаи обновить», и по умолчанию это **переоценка вердикта**: если сравнение и политика позволяют, сервер переиспользует уже снятый кадр и пересчитывает вердикт (смена только порога больше не стоит съёмки семьи). `--recapture` поднимает скоуп тех же случаев до **кадра** — принудительная пересъёмка (флейк рендера, подозрение на протухший кадр). `--refresh none --recapture` — противоречие и ошибка аргументов. Что именно применилось, видно строкой `refresh: requested=… impact=… effective=…` (и полем `refresh` в `--json`): агент просит скоуп, импакт может его расширить, решает сервер. Сервер без алгебры refresh строку не отдаёт — это не ошибка, а старая сборка.
- **`--summary` — канон для агента, `--json` без него не меняется.** Полный отчёт failed-рана на 25 случаев — около 1800 строк (в каждом провале повторяются `metrics`/`regions`); `--summary` печатает ту же приёмку меньше чем в 100 строк: `progress` со всеми счётчиками уровней reuse, `gates` строкой на гейт, `failedCases [{caseId, gate, raw, aa, cause}]`, группы ремедиаций и адрес evidence. Полный вид (`--json` без `--summary`) остаётся инструментом отладки и по-прежнему отдаёт ран целиком — смысл `--json` флаг `--summary` не меняет. Источник сводки: `?view=summary` сервера при `features.acceptanceSummaryView`, иначе — та же форма, сведённая локально (`summarySource: "client"` в `--json`). Записи кэша (link/receipt) в обоих случаях строятся из **полного** рана.
- **Drill-down: `accept-status <runId> --case <caseId>`.** После сводки за подробностями одного случая идти сюда, а не за полным раном: печатаются его гейты с `detail`, классифицированные причины, артефакты и **квитанция reuse** по уровням (`candidate/frame/readiness/geometry/visualMetrics/verdict` — `hit`/`miss`). Именно квитанция отвечает, пересчитывался ли вердикт: `reused` в прогрессе этого по построению не различает. Exit 2, если случай упал.
- `409 acceptance_run_in_flight` — у кандидата уже есть живой ран: не ставить второй, дождаться его через `accept-status`.
- **`retry-disposition <runId>` — спросить, прежде чем переснимать (BR-10).** Терминальный `fail`/`error`/`indeterminate` не означает «повтори и посмотри»: ручка сравнивает **сохранённые** отпечатки случаев с would-be отпечатками той же функции под текущим состоянием сервера и отвечает глубиной — `unchanged` (ничего не изменилось, повтор не создаст знания), `recompute` (двинулась вердиктная политика), `rediff` (двинулось сравнение), `recapture` (двинулся кадр), `rebuild` (голова компонента больше не хэшируется в кандидата). `blocker: blk_…` — отпечаток самого блокера: он не зависит ни от `runId`, ни от времени, поэтому по нему дедуплицируются стопы между ранами. Строка `policies:` печатает версии политик волны (`schemaResolver`/`barrier`/`comparison`/`geometryOwnership`/`geometryContract`) — их **значения** и есть то, чем видно включение серверной фичи; в `changed[]` они не появляются никогда, потому что сервер их не хранит и сравнивать их не с чем. `basis incomplete: …` — кандидата вытеснил GC либо набор больше не восстановим: это факт о данных, а не сбой, и он объясняет, почему глубина `unchanged` тут **не** значит «всё в порядке». Exit всегда 0: это вопрос, а не приёмка.
- **Частичная пересъёмка (`--baseline-run <runId>`).** Правка одного ассета в семье из 49 состояний не обязана стоить 49 капчуров. `impact` считает это заранее и печатает **базис**:
  - `asset-only` — форма исходника побайтово та же (все литералы `asset_<sha256>` заменены плейсхолдером и хэш совпал), тема не менялась: пересъёмке подлежат случаи, чьи **наблюдённые** ресурсы (readiness-evidence кадра) содержат изменившийся ассет;
  - `theme-only` — исходник тот же, сменилась версия темы ДС: пересъёмке подлежат случаи, применившие изменившиеся токены/иконки (смена шрифта действует документ-широко → все);
  - `conservative` — всё остальное (изменилось и то и другое, правка не-литерала, нет доказательств формы, нетерминальный baseline): снимается всё, `reason` называет причину.
  Случай **без** readiness-evidence (динамический URL, вычищенный артефакт, старый шелл) всегда считается затронутым — молчаливого reuse не бывает. Незатронутые случаи получают вердикт baseline (`reuseReason: "impact:<basis>"`) и его артефакты; явный `--refresh` всегда перебивает импакт. Отчёт приезжает и в ответе на постановку рана, и в `impact` терминального рана.
- **Отклонение кандидата: `reject <candidateId> --reason <text>`** (владелец или админ). Пишет append-only надгробие: кандидат отдаётся с `rejected: true` и `decision {reason, actor, createdAt}`, сам `status` не меняется.
  - **Решение терминально и снимается только новой ревизией.** `unreject` не существует. Отклонение блокирует promote **всей ревизии** (`409 candidate_rejected` — на обоих путях promote, с `candidateId` и без него), переживает TTL кандидата (свипер такого кандидата не удаляет) и не сбрасывается повторным `accept`: тот вернёт **того же** кандидата с `rejected: true`.
  - `409 candidate_already_rejected` — уже отклонён (в `details` — чьё и какое решение); `409 candidate_promoted` — сборка уже опубликована, отклонять нечего (не путать с `candidate_already_promoted` — это CAS саги promote).
  - Reject **не** отменяет живой ран приёмки и не освобождает in-flight-слот кандидата.
- Ссылки приёмки на публикации: `promote` принимает `candidateId`/`acceptanceRunId` — флагами верба (`--candidate`, `--acceptance-run`; см. «Приёмка головы: `promote`»), которые драйвер сверяет локально и кладёт в тело запроса, либо автовыбором по `runs[]` кандидата головы, когда флаги не заданы. Ран обязан быть терминальным `pass`/`pass_with_exceptions` этого же кандидата, иначе `422 acceptance_run_mismatch`/`acceptance_run_not_passed`; при живом ране — `409 acceptance_run_in_flight`. Обе ссылки записываются в строку опубликованной версии как provenance; шардированная семья публикуется набором ранов (`acceptanceRunIds`, см. «Приёмка головы: `promote`»), и `acceptanceRunId` версии — первый элемент отсортированного набора.

### Набор случаев семьи: `case-set`

Именованных `examples` хватает атому, но не семье из 49 состояний с эталонами из Figma. Такой набор описывается **манифестом** и публикуется как сущность: сервер валидирует его целиком и адресует контентно (`caseSetId = "cset_" + sha256` канонизованного манифеста), поэтому повторная публикация того же манифеста идемпотентна, а изменённый манифест — **новый** набор (старые раны остаются воспроизводимыми).

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
node driver.mjs case-set validate matrix.json               # dry-run: проверка без записи (локально → сервер)
node driver.mjs case-set put pay-payment-card matrix.json   # публикация манифеста → caseSetId + coverage
node driver.mjs case-set coverage cset_…                    # чего не хватает в матрице
node driver.mjs case-set get cset_…                         # манифест обратно
node driver.mjs accept pay-payment-card --case-set cset_…   # ран по набору вместо examples
```

- `case.id` — charset `^[A-Za-z0-9._-]{1,64}$` (из него строятся имена записей evidence-архива), поэтому **Figma node id вида `54863:9537` не пройдёт** — санитизировать на своей стороне.
- Эталон — **id ассета реестра** (`asset_<sha256>`, загрузить через `POST /api/assets`), а не байты: несуществующий ассет — `422 asset_not_found`.
- Два случая с одинаковыми props — `422 duplicate_case_props`; осознанный дубликат помечается `aliasOf` (снимается один кадр, вердикт наследуется). Алиас обязан повторять props цели и не может ссылаться на другой алиас.
- Покрытие: `expectedTuples` — декартово произведение `dimensions`, `missingTuples` — незакрытые ячейки (в ответе — **не больше 64**, полное число в `missingCount`, признак усечения — `truncated`), `duplicates` — ячейки с двумя случаями. Манифест без `dimensions` получает тривиальный coverage: фиктивное произведение по неполной Figma-матрице не выдумывается.
- **Sparse-семья — одна каноническая ось.** Если состояния семьи не раскладываются в честную решётку (Figma-матрица с дырами), объявляй **одну** ось с перечислением состояний (`dimensions: {state: [… 49 значений …]}`), а не произведение осей, половина ячеек которого пустует. Ось держит до `limits.caseSetMaxDimensionValues` (64) значений — это ≥ ёмкости рана, поэтому **семья из 49 состояний — один case-set и один ран**; шардировать вручную не нужно (два набора = два `cset_`, два рана и ручная сшивка provenance).
- Лимиты не запоминай — читай из `GET /api/capabilities → limits`: `caseSetManifestVersion`, `caseSetMaxCases` (512), `caseSetMaxDimensions` (8), `caseSetMaxDimensionValues` (64), `caseSetMaxExpectedTuples` (4096) и `acceptanceMaxCasesPerRun` (ёмкость одного рана). Декартово произведение осей выше потолка — `422 case_set_coverage_too_large` (считается перемножением длин, до построения ячеек).
- Две подсказки схемы, на которых теряют round-trip: `componentId` **обязателен** и обязан совпадать с id в пути; `null` схема не принимает **нигде** — необязательное поле надо **опускать**, а не занулять (`"cropLineage": null` — это `422 validation_failed`, а не «нет lineage»).
- `case-set validate <manifest.json>` — dry-run: структура, charset, `null`-поля и все лимиты проверяются **локально, до сети** (битый манифест не стоит ни одного запроса), затем сервер повторяет полную валидацию без записи и отдаёт `caseSetId`, `cases {count, ids}`, `coverage`, `warnings` и `wouldBeCached` (такой набор уже опубликован — `put` был бы идемпотентным повтором). Ручка живёт под `capabilities.features.caseSetValidate`; на сервере без неё команда честно печатает «проверено локально», а не подменяет проверку публикацией.
- Неполные `dims` и расхождение props со схемой опубликованного компонента — **`warnings`**, а не отказ.
- `capture` манифеста задаёт поверхность съёмки набора, `policy.perCase` входит в вердиктный слой отпечатка случая: правка допуска одного случая инвалидирует reuse ровно его (и стоит **пересчёта вердикта**, а не пересъёмки — см. «Приёмка семьи»).
- **Чем является ассет эталона — говорит манифест, а не догадка сервера.** `referenceSurface: "paint"` (дефолт) значит «ассет уже каноническая канва случая: прозрачное поле `margin` вокруг компонента»; `referenceSurface: "content-hug"` — «ассет обрезан по содержимому» (штатный экспорт узла Figma), и тогда паддинг до канвы делает **сервер** (`referencePlacement` — смещение внутри канвы, device px, по умолчанию `margin × dsf`). Ручной PNG-паддинг больше не нужен. `cropLineage.sourceSurface` отвечает на второй вопрос — в координатах какой поверхности записан `rect`: `figma-node` (или отсутствие поля) = «резать», `content-hug`/`paint` = «уже вырезано, rect — provenance». Именно повторный crop превращал эталон `136×32` в `116×12`.
- **Дети слотов: `slotBindings`** (`capabilities.features.caseSetSlotBindings`). Случай, который отличается от соседа **содержимым слота**, а не props, описывается `slotBindings` — иначе сервер снимет обе карточки с пустыми слотами и схлопнет их в один кадр:
  ```jsonc
  { "id": "sms-two-fields", "props": { "state": "input" },
    "slotBindings": { "fields": [{ "type": "PaySmsField", "version": 3, "props": { "filled": true } }] } }
  ```
  Ребёнок пиннится **точной опубликованной версией** (`version` обязателен; «последняя активная» сделала бы контентный адрес набора зависимым от момента прогона). Глубина — 1: ребёнок своих детей не несёт. Ключ `default` зарезервирован и легален — им биндится **неявный** слот `children` (это и есть путь для каруселей и списков); проверка членства в `definition.slots` и гейт `capabilities.namedSlots` относятся только к **именованным** ключам. Потолки — `limits.caseSetMaxSlotChildren` (12) и `limits.caseSetMaxSlotsPerCase` (8); кардинальность самого слота сервер не проверяет.
- **Отказы слотов: где какой.** Опубликованные факты про ребёнка — `422` уже на `put`/`validate`: `slot_component_not_published` (нет компонента/версии, версия в `archived|rejected|staging|failed`), `slot_component_design_system_mismatch`, `slot_self_reference`, `slot_props_invalid` (props ребёнка не по схеме его версии), `slot_props_dynamic` (`$state`/`$cond`/`__eui`-ключи — props случая это литеральный JSON). Факты **головы кандидата** на `put` только `warnings`, а `422` на старте рана: `slot_unknown` (нет такого именованного слота), `slot_bindings_unsupported` (компонент не объявил `capabilities.namedSlots`). Ребёнок на `deprecated`/`superseded` версии проходит с warning'ом `slot_pin_deprecated`/`slot_pin_superseded` — иначе promote, авто-суперсидящий детей, ломал бы идемпотентный повтор `put`.
- **Дедуп теперь по (props, slots).** Одинаковые props с **разными** `slotBindings` — два законных случая и два кадра (раньше это был `422 duplicate_case_props`, а после обхода — молчаливое схлопывание в один кадр). Одинаковые props **и** одинаковые биндинги — по-прежнему `422 duplicate_case_props`; `aliasOf` обязан повторять и props, и биндинги. `validate` печатает `frames` — сколько кадров действительно снимется; это же число идёт в `promote --expected-cases`.
- **Слоты в отпечатке.** `slotBindings` входят во **frame**-слой отпечатка случая (`CASE_FINGERPRINT_ALGO_VERSION` 6 → 7): смена версии, порядка или props ребёнка — это пересъёмка, а не пересчёт. Бесслотовые случаи хешируются побайтово как раньше, но общий bump алгоритма один раз инвалидирует накопленный **вердиктный** reuse на всём инстансе.
- **`content-hug` объявляется вместе с `expectedGeometry`.** Корень канвы берётся из `expectedGeometry`, а без него — из `layoutBounds`, измеренного **в этом же ране**. Случай, кадр которого приехал из кэша (re-diff), свежих `layoutBounds` не приносит, и гейт честно отдаёт `indeterminate` с `reason: "reference_canvas_unresolved"`. Набор без `expectedGeometry` пройдёт на холодном кэше и упадёт на первом повторе; PUT предупреждает об этом в `warnings[]`, но не отказывает.

### Пакет исходников Figma: `source-package`

Половина потерь миграции — про доступ к источнику: какой именно мастер, какие override'ы инстанса, каких экспортов вовсе нет. Пакет делает источник **проверяемым**: манифест несёт узлы (`nodeId` + `componentKey` + семантическая роль), экспорты **ссылками на ассеты реестра** (байтов в пакете нет никогда — PNG уезжают обычным `POST /api/assets`) и честные `missing[]`/`anomalies[]`.

```bash
node driver.mjs source-package upload package.json --design-system yandex-pay   # → packageId + deduplicated
node driver.mjs source-package list --design-system yandex-pay --file-key PayAppCore
node driver.mjs source-package show fsp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa                                       # пакет + манифест
node driver.mjs source-package skeleton fsp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --component pay-payment-card \
  --nodes 54863:9518,54863:9537 --out matrix.json                               # черновик case-set
```

```jsonc
{
  "designSystem": "yandex-pay", "fileKey": "PayAppCore", "sourceRevision": "2026-08-07-rev12",
  "nodes": [
    { "nodeId": "54863:9518", "name": "PaymentCard", "componentKey": "key-payment-card", "role": "payment-card", "kind": "componentSet" }
  ],
  "exports": [
    { "nodeId": "54863:9518", "assetId": "asset_<sha256>", "width": 280, "height": 192, "sha256": "<sha256>", "scale": 2 }
  ],
  "missing": [{ "role": "exact-reference", "nodeId": "54863:9537", "note": "pressed state is not exported" }]
}
```

- **Адрес пакета — контентный** (`fsp_<sha256>` канонизованного манифеста): повторная загрузка того же манифеста идемпотентна и отвечает `deduplicated: true` (HTTP 200 вместо 201). Смена `sourceRevision` — это **новый** пакет, а не правка старого.
- **Форма проверяется до сети.** Обязательные поля, url-safe `fileKey`, потолок `exports[] ≤ limits.sourcePackageMaxExports` (256) и замкнутость ссылок (любой `nodeId`, упомянутый в `exports`/`missing`/`textRuns`/…, обязан быть объявлен в `nodes[]`) — локально; байтовые инварианты (существование `assetId`, совпадение `sha256` и габаритов с реестром) проверяет сервер: `422 source_package_export_sha_mismatch` / `source_package_export_dimension_mismatch` / `asset_not_found`.
- `--design-system` **дополняет** манифест, но не переписывает: флаг, называющий другую систему, чем поле в файле, — отказ, а не тихий выбор.
- **`skeleton` — черновик, он ничего не сохраняет** (`saved: false`). Один случай на экспорт: `referenceAssetId` — экспортированный ассет, `expectedSurfaces.referenceExport` — его габариты, **пересчитанные из `scale` в CSS px**. `props` остаются пустыми, а `expectedGeometry` не выдумывается — пакет знает только свои экспорты. `--out file.json` пишет черновик готовым входом для `case-set put` (только `.json`: это машинный артефакт).
- **Связка с компонентом — `figma.sourcePackageId`, metadata-only.** Ссылка не входит **ни в один** отпечаток приёмки; она лишь говорит «этот компонент собран из этого пакета». Пакет с `missing[{role:"exact-reference"}]` на узле компонента даёт префлайт-**warning** (`missing_exact_reference`) до сборки набора, а не проваленное сравнение после.
- **Reuse search.** `componentKey` и роли из пакета едут сигналом ранжирования в поиск кандидатов — они поднимают компонент из того же мастера Figma, но гейтом переиспользования не являются.
- Набора роутов может не быть (сборка до волны W8 или `EASYUI_SOURCE_PACKAGE_DISABLED=1`) — команда отвечает `server has no figma-source-packages (deploy newer server)`, а не «пакет не найден».

### Клиентский кэш ответов: `--cache-dir`

Глобальные флаги (работают с любым вербом): `--cache-dir <dir>` (или `EASYUI_CACHE_DIR`) включает локальный кэш read-only ответов, `--cache-refresh` (или `EASYUI_CACHE_REFRESH=1`) форсирует промах и перезапись записи с `refreshReason`.

```bash
node driver.mjs catalog list yandex-pay --cache-dir .easyui-cache            # первый вызов — miss
node driver.mjs accept pay-payment-card --case-set cset_… --cache-dir .easyui-cache --json
node driver.mjs catalog search yandex-pay --intent "карточка оплаты" --cache-dir .easyui-cache --cache-refresh
```

- **Кэш — ускоритель, а не свидетельство.** Приёмочное доказательство остаётся серверным (`GET /api/acceptance-runs/:id/evidence` + CAS/SHA256SUMS). В отчёт агента всегда идёт поле `cache.status` (`hit|miss|refresh|off`) — читатель обязан видеть, откуда взята цифра. В `--json` оно есть в каждом ответе, в человекочитаемом режиме печатается строкой в stderr.
- Кэшируются только read-only GET'ы: `capabilities`, каталог (`manifest`/`candidates`/`design-systems`), версии компонентов, `component-candidates/:id`, `case-sets/:id` (+`coverage`), **терминальные** раны и их evidence-архив (blob). Нетерминальный ран, мутации и auth не кэшируются никогда — poll идущего рана всегда идёт на сервер.
- Ключ содержит идентичность (`sha256(baseUrl + "\n" + username)`), метод, путь, отсортированный query, хэш тела и `apiVersion`. Общий каталог кэша **не** отдаёт ответы чужой учётки; токены и куки в ключ не входят и на диск не пишутся. Каталог создаётся с правами `0700`.
- Целостность: `SHA256SUMS` проверяется при каждом чтении, подменённый blob = промах (а не тихая отдача). Раскладка: `requests/<sha256(key)>.json`, `blobs/<sha256>`, `receipts/<verb>/<key>.json`, `links.json` (candidate → run → cases → artifacts → report), `SHA256SUMS`, `meta.json`.
- Кэш выключен при legacy-Basic (`EASYUI_LEGACY_BASIC_AUTH`): общий барьер не даёт различить учётку — `cache.status: "off"`, каталог не создаётся.
- Скачанный evidence-архив распаковывать только с проверкой имён записей: абсолютные пути и `..` внутри zip отвергать (zip-slip).

**Existence lookup: откуда взялось «not found»** (план 2026-08-04 §W4). Вывод «ресурса нет» дороже вывода «есть»: на нём агент останавливается. Поэтому у каждого такого вывода назван источник — поле `existence {source, refreshed, status}` в `--json` команд, которые проверяют существование (`accept`, `promote`, `case-set put`, `component`, `component-move`, `delete`, `preview`, `catalog get`):

- `direct-network` — прямой `GET /<kind>/<id>` к серверу в этом вызове. Только такой 404 терминален.
- `direct-cache` — прямой `GET`, отданный клиентским кэшем.
- `list-cache` — вывод сделан из агрегированного **списка** (каталожный манифест, `fresh`-окно 5 минут). Отсутствие в списке ≠ 404 конкретного id: манифест перечисляет только опубликованные версии, драфта в нём нет никогда.

Правило: отрицательный результат с `source ≠ direct-network` не объявляется «not found» — драйвер делает **ровно один** принудительный прямой сетевой перезапрос (в логе — строка `existence: <kind>/<id> re-checked directly`, в JSON — `refreshed: true`) и только его ответ считает вердиктом. Мутационные пути (`accept`, `promote`, `case-set put`, save/publish/delete) читают ресурс мимо кэша всегда: из того же ответа берётся `headRev` для CAS, и «свежий по TTL» их не устраивает. Практический вывод: **свежесохранённый драфт доступен мутациям при тёплом `--cache-dir` и без `--cache-refresh`**; если команда всё же сказала `not found`, это ответ сервера — проверять надо идентичность (`EASYUI_USERNAME`) и адрес API, а не кэш.

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

Скриншоты снимает **только сервер** — один рендерер на всех (тот же браузер, шрифты и readiness-протокол, что у эталонов и приёмки). Локального playwright драйвер не требует и не запускает:

```bash
node driver.mjs snap my-flow ./shots                 # server-side: job API + PNG из asset registry
node driver.mjs snap my-flow ./shots --all-screens --json   # машинный отчёт по всем экранам
node driver.mjs shoot my-flow ./shots                # deprecated: алиас `snap --all-screens`
# ./shots/<screenId>.png на каждый экран
```

Перед съёмкой драйвер сверяет `GET /api/capabilities` → секцию `renderer` и пишет на stderr предупреждение, если сборка сервера без renderer-манифеста (`source: "fallback"`, dev-инстанс) или секции нет вовсе — кадры такого сервера несопоставимы с эталонами. Само предупреждение съёмку не прерывает и на exit code не влияет.

**Exit codes `snap`:**

| Код | Значение | Что делать |
|---|---|---|
| `0` | PNG создан на всех экранах, product-ошибок нет | ничего; PNG всё равно смотреть глазами |
| `2` | PNG создан, но прототип логировал ошибки (`productErrors`) | чинить прототип/компонент; PNG уже лежат в `./shots` |
| `1` | PNG не создан (job error/timeout, 5xx, 501) | инфраструктура/окружение; драйвер уже сделал 2 попытки на экран |

Инфраструктурный шум (favicon, расширения браузера, `ERR_NETWORK_CHANGED`, `ResizeObserver loop`, посторонние origin'ы) сервер отдаёт в `infraNoise` и он **не** влияет на exit code. `--json` печатает по экрану `{screenId, path, imageProduced, captureClean, productErrors, infraNoise, runtimeWarnings, attempts, receiptSha256, renderer, codes}`.

**Чем снят кадр (capture receipt).** `--json` у `snap`/`shoot`/`preview` несёт `receiptSha256` (адрес доказательства), `renderer.rendererFingerprint` (объявленный рендерер джобы) и `codes[]` — типизированные коды капчура (`font_face_missing`, `image_load_failed`, `layout_unstable`, `renderer_mismatch`, …). Сам документ скачивается флагом `--receipt <file.json>`:

```bash
node driver.mjs snap my-flow ./shots --receipt ./receipts/my-flow.json --json     # запись на каждый экран
node driver.mjs preview rating-stars --receipt ./receipts/stars.json --json       # receipt одной джобы
```

В нём — рендерер и его отпечаток, манифест ресурсов (шрифты темы со статусом загрузки, декодированные картинки), консоль, идентичность PNG (`output.pngSha256`, `surfaceRect`), тайминги и вердикт readiness. Это первый инструмент при вопросе «почему кадр другой»: сравнивать receipt'ы дешевле, чем пиксели. Если receipt'ы на сервере выключены или вытеснены, файл честно пишет `null`, а причина уходит на stderr — exit code от этого не меняется. Флаг `--json` есть у всех verb'ов; сессия кэшируется на диске между вызовами (`$XDG_STATE_HOME/easyui`, выключатель `EASYUI_SESSION_CACHE=0`, путь переопределяет `EASYUI_SESSION_FILE`), поэтому логин обычно один на серию вызовов; GET'ы и постановка job'а ретраятся на 5xx.

**Кандидат внутри композитного экрана: `snap --candidate`** (`capabilities.features.prototypeCandidateOverlay`). Флаг подменяет пин компонента в снимаемой ревизии бандлом acceptance-кандидата — так новая ревизия проверяется в живом окружении экрана до публикации:

```bash
node driver.mjs snap checkout ./shots --candidate cand_… --json    # кадр с кандидатским бандлом
```

- Это **свап пина, а не вставка**: компонент обязан быть уже опубликован и запиннут в ревизии (иначе `422 candidate_component_not_in_prototype`). Первая публикация компонента через overlay не проверяется — для неё есть `slotBindings`.
- Кадр **байтовый**: ассета, `imageUrl`, визуального эталона и capture receipt'а у него нет; PNG драйвер качает из `GET /screenshot-jobs/:id/bytes` (живёт 10 минут) и сверяет с объявленным `pngSha256`. Документ прототипа не меняется ничем.
- Overlay **ничего не доказывает** для приёмки: ни вердикта, ни evidence, ни promote. Доказательство публикации — `accept`/`promote`.
- Подмен на кадр — до `limits.prototypeCandidateOverlayMax` (2), по одной на компонент; чужой и несуществующий `candidateId` дают один и тот же `404`. Если сервер применил не все подмены (старая сборка, выключенная фича), драйвер падает, а не отдаёт published-кадр под видом кандидатского.

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

Сколько публичных версий стоил каждый компонент — `node driver.mjs audit --versions [--design-system <id>]` (KPI-срез поверх `GET /api/components/:id/versions`): версии, active-счётчик, статусы, колонка `acceptance` и даты на компонент плюс сводка `versions per published component`. Колонка `acceptance` — «есть/нет acceptance-evidence»: `<версий с непустым acceptanceRunId>/<всего версий>` и `active=yes|no` про саму активную версию; в `--json` это `acceptanceEvidence`/`acceptedActive` на строке и `versionsWithEvidence`/`acceptedComponents`/`withoutEvidence` в `findings`. Evidence появляется только у версий, опубликованных `promote` с кандидатом и пройденным acceptance-раном, поэтому нули по всему каталогу — нормальное состояние, а не сбой. Exit 2 — если у какого-то компонента не осталось ни одной active-версии.

Тот же признак виден в библиотеке: `GET /api/catalog/library` отдаёт `status.accepted` (у активной версии есть acceptance-evidence). Он **независим** от `status.verified` (визуальные эталоны) и не входит в `catalogRevision`.

Жизненный цикл версий компонента: у published-версии есть статус (`active` по умолчанию). Неудачную версию можно пометить, не удаляя: `POST /components/:id/versions/:v/status` c `{status: rejected|deprecated|superseded|archived, reason?, supersededBy?, baseStatusRev}` (CAS по `statusRev` из read-back версии). `rejected`/`archived` перестают исполняться (плеер покажет `bundle_failed` в render-status), `deprecated`/`superseded` продолжают работать с warning'ом. Новые пины и манифест берут только `active`.

Discovery: `GET /api/openapi.json` (полный OpenAPI 3.1), `GET /api/capabilities` (actions/директивы/лимиты/фичи/системы), `GET /api/schemas/prototype-document.json` и `.../component-definition.json` — источник истины, когда этого файла недостаточно. Опционально к компоненту/прототипу можно прикладывать Figma-происхождение: поле `figma: {fileKey, nodeIds[], sources?: [{fileKey, nodeIds[], role?}], referenceScreenshots?: [assetId], lastSyncedAt?}` рядом с `doc`/`source` в POST/PUT (верхний `fileKey`/`nodeIds` — primary-документ, `sources` — 1..8 дополнительных документов lineage, дубликат `fileKey` → `422`) — сохраняется на ревизии, отдаётся в read-back; отдельная правка без новой ревизии/версии — `PUT /api/components/:id/provenance` (верб `provenance`).

## Миграционный коммит: `migration-commit`

Перевод одного компонента из «кандидат принят» в «версия опубликована, экран галереи сохранён, регрессия спланирована, каталог отревизован» — шесть мутаций подряд. Их последовательность живёт **на сервере** (`capabilities.features.migrationCommit`, нужен `EASYUI_ACCEPTANCE_MATRIX=1`), а драйвер — poller над ней: он ничего не компенсирует и ничего не переигрывает сам.

```bash
node driver.mjs migration-commit start pay-payment-card --dry-run --json          # план: фазы и мутации, ноль записей
node driver.mjs migration-commit start pay-payment-card \
  --gallery pay-gallery --screen fragment.json --candidate cand_… --acceptance-run acc_… \
  --receipt receipts/pay-payment-card.json                                        # сага до complete или до первого needs-*
node driver.mjs migration-commit --status mig_…                                   # чтение состояния (watchdog идёт на каждом запросе)
node driver.mjs migration-commit --advance mig_… --json                           # продолжить из needs-<фаза>
node driver.mjs migration-commit --cancel mig_… --reason "миграция отменена"       # выйти из needs-* в cancelled
```

- **Фазы:** `preflight → promote → gallery-save → verify → impacted-regression → audit → complete`. Провал фазы — **не** ошибка HTTP: сага встаёт в `needs-<фаза>`, драйвер печатает журнал фаз и выходит с кодом `2`. Дальше — либо `--advance` (после устранения причины), либо `--cancel`. Компенсаций нет: promote необратим, и «откат» означал бы депубликацию живой версии.
- **Идемпотентность.** Ключ по умолчанию детерминирован — `driver-<componentId>-r<headRev>-<sourceHash[0:12]>`: повтор той же команды после обрыва возвращает **ту же** сагу (`idempotent replay`, ноль мутаций), а не начинает вторую. Свой ключ — `--idempotency-key <key>`.
- **`--dry-run`** не пишет ничего: префлайт исполняется по-настоящему (он read-only), в ответе — список фаз, список мутаций, которые сага бы сделала, и превью плана регрессии. Это предмет ревью человеком.
- **Галерея** — отдельный ресурс с отдельным владельцем: `--gallery <prototypeId>` (+ `--screen <fragment.json>` — фрагмент экрана, вставляется по `id`), поверхность плана регрессии задают `--viewport/--theme/--dsf`, барьер ресурсов включён по умолчанию (`--no-barrier` — откат). Без `--gallery` фаза регрессии честно рапортует `regressionMode: "full"`: доказать, что какие-то экраны можно не снимать, нечем.
- **`--receipt <file.json|file.txt>`** — та самая «1 агентская запись» KPI: единственный файл, который харнес пишет сам. Серверные документы координатора (`WORKFLOW_STATE.md` и прочее) сервер не пишет и писать не будет.
- Сервер без саги (старая сборка, выключенный kill-switch `EASYUI_MIGRATION_COMMIT_DISABLED=1`) — понятный отказ до всякой мутации, а не серия 404 по ручкам.

## Квитанция агента: `envelope` и `--summary-json`

Любой `--json`-вывод несёт **один** дополнительный ключ `envelope` — стабильную квитанцию верба. Форма не зависит от глагола, поэтому агент читает результат, не изучая payload конкретной команды:

```json
{
  "envelope": {
    "schemaVersion": 1,
    "command": "snap",
    "ok": true,
    "summary": { "captured": 3, "reused": 5, "cleanScreens": 3, "failedScreens": 0, "suppressedNoise": 2 },
    "items": [],
    "artifacts": ["./shots/home.png"],
    "warnings": [],
    "nextActions": []
  }
}
```

- `ok === (exit code === 0)` — всегда; конверт не считает успех сам, он его публикует. Отказ запроса (любой 4xx/5xx) в `--json` тоже приезжает конвертом: `ok: false`, `command` — верб из командной строки, `nextActions` — шаги из ответа сервера.
- `items` — строки результата (экраны, случаи, кандидаты, фазы), `artifacts` — пути к тому, что верб записал на диск, `warnings` — то, что читатель обязан увидеть, `nextActions` — команды, которые имеет смысл выполнить дальше.
- Версия схемы конверта — `GET /api/capabilities` → `features.receiptEnvelopeVersion` (сейчас `1`). Растёт только при **несовместимом** изменении самого конверта; новые ключи внутри `summary` версию не двигают.
- **Конверт живёт только в json-режимах.** Человекочитаемый вывод не изменился ни на строку.

**`--summary-json`** — глобальный флаг любого верба: stdout получает **ровно** объект `envelope` и ничего больше (ни payload, ни блока `cache`). Это симметрия к `--json`, где тот же объект лежит вложенным ключом, и способ не выяснять форму ответа каждой команды:

```bash
node driver.mjs snap my-flow ./shots --all-screens --summary-json | jq '.summary.failedScreens'
node driver.mjs accept pay-payment-card --case-set cset_… --summary-json | jq '.summary.topCauses'
```

**Контракт `summary` по вербам** (минимум; поля добавляются аддитивно):

| Verb | Поля `summary` |
|---|---|
| `accept` / `accept-status` | `runId`, `verdict`, `casesTotal`, `casesFailed`, `casesReused`, `topCauses[{code,cases}]`, `revision` |
| `snap` | `captured`, `reused`, `cleanScreens`, `failedScreens`, `suppressedNoise` |
| `promote` | `version`, `rev`, `catalogRevision`, `candidateId`, `runsLinked` |
| `status` | `screensTotal`, `renderable`, `blocked[]` |
| `geometry` | `verdict` (`clean\|warn\|error`), `divergingSurfaces`, `gaps` |
| `audit` | `exitCode`, `deprecatedInUse`, `unused` |
| `migration-commit` | `commitId`, `phase`, `phasesDone[]`, `regressionMode` |
| `source-package` | `packageId`, `deduplicated`, `exports`, `missing` |
| `retry-disposition` | `runId`, `blockerFingerprint`, `disposition`, `suggestedAction`, `changed[]`, `basisIncomplete`, `casesMoved` |

Честные `null` в этих полях — не пробел, а отсутствие факта, и подставлять вместо них догадку драйвер не будет: `accept-status` не знает ревизию кандидата (вид рана её не содержит, а голова компонента могла уйти вперёд), `accept-status --case` не знает счётчиков рана (читался один случай), а `geometry` не считает пер-поверхностные вердикты — `divergingSurfaces` там всегда `null`, потому что поверхности (`root`/`layoutUnion`/`paint`/`referenceExport`) живут в приёмке случая, и `[]` читалось бы как «поверхности сошлись». По той же причине у `source-package list` три поля из четырёх — `null` (список манифестов не тащит), а `deduplicated` есть только у `upload`: это свойство загрузки, а не пакета.

**Правило файлов: `.json` — всегда JSON, текст — `.txt`.** Расширение — единственное, что видно до открытия файла, поэтому формат выводится из него, а незнакомое расширение отвергается **до** работы (`--receipt r.receipt` — ошибка аргументов, а не потерянная съёмка). У `migration-commit --receipt` оба формата законны: `.json` — квитанция сервера как есть, `.txt` — те же строки, что напечатаны человеку; у `snap`/`preview --receipt` — только `.json` (это документ capture receipt).

**Миграция существующих путей.** Квитанции прошлых волн, записанные текстом в файл с расширением `.json` (рабочие журналы координатора миграции, «receipt» из ручных прогонов), переименовать в `.txt` — их содержимое не JSON, и любой машинный шаг над каталогом квитанций на них спотыкается. Ничего конвертировать не нужно: правило про имя, а не про содержимое. Новые записи харнес пишет уже по правилу.

## Gotchas

- Прототип **обновляется, а не создаётся заново**: `doc.id` — ключ. Не занимайте чужие id — `get prototypes` покажет, что уже есть.
- Все мутации требуют `baseRev` (409 при гонке) — драйвер берёт `headRev` сам; при ручном `curl` не забыть.
- Директива не может заменить весь объект `props`; `$cond` принимается только в канонической форме `{"$cond":{if,then,else}}`.
- Показ/скрытие целого элемента — `visible` с condition, не `$cond` в props.
- `$event`/`$if`/`slot` работают по definition custom-компонента; host-типы не получают custom-семантику.
- `$itemKey` требует `repeat.key`; `$item`/`$index` вне repeat-поддерева — ошибка.
- Длинные JSON-тела в шелле не инлайнить (бэктики выполняются как command substitution) — писать payload в файл; драйвер избавляет от этого.
- Ждать загрузки самому не нужно: серверный readiness-протокол `snap` сам дожидается шрифтов и изображений. Очередь скриншотов на сервере ограничена (429 при переполнении — повторить).

## Troubleshooting

- `401` на login — неверны `EASYUI_USERNAME`/`EASYUI_PASSWORD` либо, при включённом внешнем барьере, `EASYUI_LEGACY_BASIC_AUTH` (формат `user:pass`). `401` после успешного login обычно означает истёкшую/отозванную cookie-сессию.
- `save failed (422 validation_failed): ...` + строки вида `issue /…: Unrecognized key: "bogus"` — prop отсутствует в exact definition активной custom-версии; заново получить каталог сервера.
- `save failed (400 invalid_request): Component source and design system are unchanged` — nothing to save: исходник идентичен head-ревизии, новой ревизии не создано; правьте source или ничего не делайте.
- `publish failed (409 already_published): ...` — nothing to publish: head-ревизия уже опубликована как есть; повторная публикация неизменённого компонента не нужна.
- `save failed (422) ... "Unknown or unpublished component type: X"` — тип не встроенный и не опубликован как компонент; сначала `driver.mjs component ...`.
- `publish failed (422 validation_failed): ...` + `issue /source: Type check failed` (компонент) — читать вывод tsc в issue; save такие ошибки не ловит.
- `publish failed (422) ... event_schema_not_serializable` — typed-схема события содержит transform/preprocess/custom-логику; упростить до чистых object/string/number/enum-схем.
- `save failed (409)` — параллельное редактирование того же id (CAS-конфликт); повторить запуск драйвера (он перечитает `headRev`).
- `unknown flag ... --local-browser` / ожидание локального playwright — локальной съёмки в драйвере больше нет (один рендерер, план renderer-contract-2 R8a): снимает `snap`, `shoot` — его алиас. Если сервер снимать не может, смотреть прототип в браузере по ссылке player.
- На stderr `renderer: server renderer has no manifest (source: fallback…)` — снимает dev-сборка своим браузером; PNG получите, но сравнивать их с эталонами/приёмкой прода нельзя.
- `snap`/`preview` вернул 501 `screenshot_unavailable` — инстанс без `SERVE_DIST`/chromium (например голый локальный `server:dev`); на проде работает. `429 queue_full` у `preview` ретраится драйвером самостоятельно.
- Экран «рендерится, но пусто/не так» — `node driver.mjs status <id> <screen>` (пины/бандлы/маршрут) и `?debug=1` в плеере (события, payload, диффы стейта).
