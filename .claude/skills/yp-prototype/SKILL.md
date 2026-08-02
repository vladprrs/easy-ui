---
name: yp-prototype
description: Build and publish clickable prototypes with the Yandex Pay Design System (yandex-pay) in easy-ui — fetch the yp-* catalog, compose screens from YpScreen/YpBox/Yp* components, wire state/events/repeat, publish via driver.mjs, verify with geometry and snap screenshots. Use when asked to create, build, or publish a prototype in the yandex-pay design system.
---

# Прототипы в Yandex Pay Design System

Скилл — how-to для сборки **прототипов** в дизайн-системе `yandex-pay` (98 активных `Yp*`-компонентов + host `Overlay`/`Image`/`Hotspot`/`@eui/FlowRoot`). Харнес — общий драйвер `.claude/skills/author/driver.mjs` (пути ниже — от корня репо). Разделение обязанностей:

- **Механика публикации/грамматика документа** — `.claude/skills/author/SKILL.md` (директивы, actions, repeat, слоты, лимиты). Не дублируется здесь.
- **Канон DS** (цвета/шкалы/роли компонентов) — `docs/design/yandex-pay.md` и скилл `.claude/skills/yandex-pay/SKILL.md` — это про авторинг *компонентов*; для прототипов важен §3 (роли примитивов).
- Здесь — YP-специфичная композиция прототипа и проверенный рабочий флоу.

Проверенный сквозной пример: **`examples/yp-checkout-demo.json`** (2 экрана: чекаут с repeat-списком заказа, выбором способа оплаты через `$cond`+`setState`, sticky-футером через FlowRoot region и экраном успеха; публиковался на prod, скриншоты сняты `snap`).

## Setup (проверено)

Креды лежат в корневом `.env` (`EASYUI_USERNAME`/`EASYUI_PASSWORD`); драйвер по умолчанию ходит на prod `https://easy-ui.pay-offline.ru`.

```bash
cd .claude/skills/author
set -a && . ../../../.env && set +a
node driver.mjs get prototypes        # smoke-проверка доступа
```

## Рабочий цикл

```bash
node driver.mjs catalog list yandex-pay                        # 1a. инвентарь: имена, версии, events/slots, description
node driver.mjs catalog get yandex-pay YpScreen YpBox YpText   # 1b. exact definitions только тех компонентов, что нужны экрану
# 2. написать doc.json (см. examples/yp-checkout-demo.json)
node driver.mjs prototype my-flow.json                 # 3. create-or-update по doc.id
node driver.mjs status my-flow --all-screens            # 4. renderable + пины/бандлы по всем экранам
node driver.mjs geometry my-flow <screenId>            # 5. численные rect'ы/gap'ы/роли/issues
node driver.mjs snap my-flow ./shots                   # 6. серверные PNG на каждый экран
```

Exit codes `snap`: `0` — PNG на всех экранах и product-ошибок нет, `2` — PNG есть, но прототип логировал ошибки, `1` — PNG не создан (инфраструктура; драйвер уже сделал 2 попытки на экран). Любой verb принимает `--json`.

**Полный дамп каталога не запускать.** `catalog list` — строки `{kind, id, name, version, atomicLevel, deprecated, events[], slots[], description}` без схем; `catalog get <ds> <artifact…>` добирает exact definition (`propsJsonSchema`, `examples`, payloads событий) названных артефактов — вместе это примерно на порядок дешевле по контексту, чем `catalog yandex-pay --full`, и даёт тот же материал для авторинга. Props валидируются строго по `propsJsonSchema` — неизвестный ключ = 422, поэтому `catalog get` по каждому используемому типу обязателен. `designSystem: "yandex-pay"` в корне документа обязателен.

Нужного компонента в каталоге нет — сначала `node driver.mjs catalog search yandex-pay --intent "<продуктовая задача>" --json`, и только потом создание нового (политика — `docs/agent-authoring-policy.md`, механика — скилл `author`). Прототип из существующих компонентов новых публикаций не требует.

### Клик-проверка интерактива (headless, проверено)

`snap` снимает статичные экраны; интерактив (события/стейт/переходы) проверяется скриптом `.claude/skills/yp-prototype/interact.mjs` — headless chromium из devDeps репо, логин теми же кредами, PNG после каждого клика:

```bash
# демо-прототип сначала опубликовать: node ../author/driver.mjs prototype examples/yp-checkout-demo.json
cd .claude/skills/yp-prototype
node interact.mjs yp-skill-demo ./interact-shots
# clicked text=СБП -> 1-select-sbp.png          (селекция переключилась)
# clicked button:has-text("Оплатить") -> 2-press-cta.png   (переход на «Успех»)
```

Для своего прототипа поменять массив `CLICKS` (label + playwright-селектор) в начале скрипта. Смотреть PNG глазами.

## Скелет экрана YP (проверено на снимках)

- **`YpScreen`** — каркас экрана (header title/subtitle, gutter 20px по бокам через `padding: true`). Его `<main>` — **flex row**: давайте ему **ровно одного ребёнка** — колонку `YpBox {mode:"col", width:"full"}`. Два ребёнка встанут рядом по горизонтали (проверено: контент сжался до половины, «футер» уплыл вправо-вверх).
- **Sticky-футер (`YpStickyPaymentFooter`)** — НЕ ребёнок YpScreen. Его definition явно говорит: «viewport anchoring is owned by easy-ui screen regions». Канон:

```json
"root":   { "type": "@eui/FlowRoot", "props": {}, "children": ["screen", "footer"] },
"screen": { "type": "YpScreen", "props": { "title": "Оплата", "fullscreen": true }, "children": ["content"] },
"footer": { "type": "YpStickyPaymentFooter", "region": "footer", "props": { ... }, "on": { "press": { "action": "navigate", "params": { "screenId": "success" } } } }
```

- **`YpBox` растёт по умолчанию**: его CSS — `flex: 1 1 auto` (при `shrink: false`). Вложенные ряды/списки в колонке-контенте **растягиваются на свободную высоту** (наблюдалось: ряд с текстом 20px высотой становился 104–184px). На каждом YpBox, который должен обнимать контент, ставить **`"shrink": true`**. Проверять `geometry` — высоты rect'ов должны соответствовать контенту.
- Строковый проп `footer` у `YpScreen` — просто текст в собственном футере секции, без событий; для CTA с переходом использовать `YpStickyPaymentFooter` (events `press`/`legalPress`) или `YpButton` (event `press`).

## Компоненты для типовых блоков (из каталога, проверены в демо)

| Задача | Компонент | Заметки |
|---|---|---|
| Каркас экрана | `YpScreen` | один ребёнок-колонка; `fullscreen: true` |
| Layout | `YpBox` | `mode: row\|col`, `gap/padding*`: токены `none…4xl`; `justify: between` для строк «название — сумма»; `shrink: true` на вложенных |
| Текст | `YpText` | `size` — enum строк (`"11"…"52"`), `medium`/`bold`, `color: primary\|secondary\|…`; margin-пропы `mt/mb/…` принимают токен шкалы или число |
| Деньги | `YpAmount` | `amount` — **строка**; локализованный формат + знак ₽ |
| Способ оплаты | `YpPaymentMethodCard` | событие `select`; `anatomy: generic\|sbp-bank\|bank-card`; рендерится квадратной плиткой 111×111 (geometry `ctyp`) |
| CTA-футер | `YpStickyPaymentFooter` | через `region: "footer"`, см. выше |
| Кнопка | `YpButton` | обязательный `text`; событие `press` |
| Разделитель | `YpSeparator` | без пропов |
| Экран успеха | `YpSuccessPaymentCard` | `label` + `cardMask` |

Выбор panel/screen/box по ролям — `docs/design/yandex-pay.md` §3. Промо-баннер — только `YpPromoBanner` (`yp-banner-mid` deprecated). Картинки — только реестр ассетов (`{"$asset": ...}`, механика — author §Ассеты).

## Паттерны интерактива (все в examples/yp-checkout-demo.json)

- **Выбор из N карточек**: `selected: {"$cond":{"if":{"$state":"/method","eq":"card"},"then":true,"else":false}}` + `on.select → setState /method`. Селекция реально переключается в плеере.
- **Список из стейта**: `repeat: {statePath:"/items", key:"title"}` на `YpBox`-обёртке, внутри `{"$item":"title"}` / `{"$item":"price"}`.
- **CTA с суммой**: `ctaLabel: {"$template":"Оплатить ${/total} ₽"}`.
- **Считать сумму, а не хранить её**: top-level `computed` (`count`/`sum`/`sumProduct`/`add`) — `"computed": {"cartSubtotal": {"op":"sumProduct","from":"/items","fields":["price","qty"]}, "total": {"op":"add","terms":["/cartSubtotal","/shipping",-500]}}`. Ключи computed — **bare**, правило «ключи стейта БЕЗ слэша» действует и здесь; читаются как обычный стейт (`{"$state":"/total"}`, `${/total}` в `$template`) и пересчитываются сами после `pushState`/`setState`. Писать в них нельзя (setState/`$bindState`/`repeat` по такому пути — ошибка), деньги — целыми числами. Грамматика и лимиты — `docs/prototype-format.md#computed-values`.
- Переходы: `press → navigate {screenId}`; возврат в начало — `restart`.

## Сценарии (`flows`) деревом

Многоэкранный YP-прототип (оплата, выпуск карты, онбординг) стоит сопровождать деревом сценариев: главная линия короткая, детали уезжают в дочерние сценарии. UI редактирования нет — `flows[]` пишется в том же `doc.json` и уезжает через `node ../author/driver.mjs prototype doc.json`. Правила целиком — `docs/prototype-format.md` («Scenario tree»), выжимка — скилл `author` §«Сценарии».

Что обязательно помнить при правке массива:

- **`flows[0]` неприкосновенен**: это главная линия, она всегда корневая (без `parentId`) и всегда нулевой элемент. Не сдвигать её при вставке новых сценариев — сдвиг меняет геометрию дорожек CJM;
- **дети вставляются сразу после родителя**: родитель обязан быть объявлен раньше ребёнка, массив читается как pre-order. Это единственное правило порядка, оно же запрещает циклы;
- глубина ≤ 4, корень = уровень 1; лимиты — 24 флоу / 50 шагов на флоу / 200 суммарно;
- дочерний сценарий — **выборка** экранов, а не цепочка: связность и один-единственный шаг для него законны (лист из одного экрана — норма). Корневой сценарий, наоборот, обязан быть связным проходом по `navigate`.

```json
"flows": [
  { "id": "checkout-main", "name": "Оплата: главная линия",
    "steps": [{ "screenId": "cart" }, { "screenId": "payment" }, { "screenId": "success" }] },
  { "id": "payment-methods", "name": "Выбор способа оплаты", "parentId": "checkout-main",
    "steps": [{ "screenId": "payment" }, { "screenId": "sbp-banks" }] },
  { "id": "sbp-bank-pick", "name": "Выбор банка СБП", "parentId": "payment-methods",
    "steps": [{ "screenId": "sbp-banks" }] }
]
```

## Gotchas (все словлены в этой сессии)

- **`state` — обычный вложенный объект, ключи БЕЗ слэша.** `{"/method": "card"}` сохранится (это только warnings!), но каждый `$state: "/method"` даст «state path is not present in document state» и не будет работать. Правильно: `{"method": "card"}` — пойнтеры резолвятся *внутрь* объекта. Не игнорировать warnings в выводе save.
- **Login rate-limit (429).** Сессия кэшируется на диске между вызовами драйвера (`scripts/easyui-auth.mjs`, кэш в `$XDG_STATE_HOME/easyui`, выключатель `EASYUI_SESSION_CACHE=0`) — в норме логин один на серию. 429 возможен при выключенном кэше или форс-`login()`-скриптах (`interact.mjs`, `shoot`): подождать минуту и повторить.
- **`snap` больше не путает шум с провалом (волна 7.1).** Инфраструктурные ошибки capture-окружения (favicon, расширения, `ERR_NETWORK_CHANGED`, `ResizeObserver loop`, посторонние origin'ы) уходят в `infraNoise` и не меняют exit code; сам драйвер ретраит инфраструктурный сбой один раз. Если exit `2` — смотреть `productErrors` (это реальная ошибка прототипа/компонента), PNG при этом уже записаны. Exit `1` — PNG не создан вообще. Смотреть PNG глазами обязательно в любом случае.
- **`gaps: n/a (flow is not declared)`** — не ошибка нулевого зазора, а «flow-контекст недоказуем»; на exit code `geometry` не влияет. Полезная часть — rect'ы и `issues[]` (`content-clipped-by-frame`, `overlapping-regions`, `footer-owns-page`): по ним ловится и растянутый YpBox, и уехавший футер.
- **Warnings ≠ blocker.** Save проходит с предупреждениями (state path, repeat не-массив) — но каждое из них означает неработающую директиву в рантайме. Чистый прототип не шумит.
- **Snap с FlowRoot-футером режет CTA.** `fullscreen: true` даёт контенту min-height 100vh; capture складывает контент+region-футер (390×955 на вьюпорте 844) — нижняя часть футера уходит за фолд PNG. Это артефакт capture-поверхности: в mobile fluid present футер пинится корректно (проверено interact-скриншотами плеера).

## Уборка

`doc.id` — глобальный ключ (create-or-update): не занимать чужие id (`node driver.mjs get prototypes`). Тестовые прототипы удалять: `node driver.mjs delete prototypes <id>` (hard delete).
