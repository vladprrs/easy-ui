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
node driver.mjs catalog yandex-pay /tmp/catalog.json   # 1. актуальные exact definitions
# 2. написать doc.json (см. examples/yp-checkout-demo.json)
node driver.mjs prototype my-flow.json                 # 3. create-or-update по doc.id
node driver.mjs status my-flow <screenId>              # 4. renderable + пины/бандлы
node driver.mjs geometry my-flow <screenId>            # 5. численные rect'ы/gap'ы
node driver.mjs snap my-flow ./shots                   # 6. серверные PNG на каждый экран
```

Записи каталога: `{id, name, version, atomicLevel, description, events[], slots[], example, propsJsonSchema}`. Props валидируются строго по `propsJsonSchema` — неизвестный ключ = 422. `designSystem: "yandex-pay"` в корне документа обязателен.

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
- Переходы: `press → navigate {screenId}`; возврат в начало — `restart`.

## Gotchas (все словлены в этой сессии)

- **`state` — обычный вложенный объект, ключи БЕЗ слэша.** `{"/method": "card"}` сохранится (это только warnings!), но каждый `$state: "/method"` даст «state path is not present in document state» и не будет работать. Правильно: `{"method": "card"}` — пойнтеры резолвятся *внутрь* объекта. Не игнорировать warnings в выводе save.
- **Login rate-limit (429).** Драйвер логинится при **каждом** вызове (cookie живёт в памяти процесса, `scripts/easyui-auth.mjs`). 3+ вызова подряд → `HTTP 429 rate_limited`. Между вызовами делать паузы (30–60 с) либо объединять проверки; при 429 подождать минуту и повторить.
- **`snap` флакает по-экранно.** Печатает `browser errors: [... 127.0.0.1:8787/assets/shadcn-v1-compat.css ... /api/auth/me]` и `one or more screenshots failed`, при этом часть PNG пишется, часть нет. Эти ошибки — шум capture-окружения сервера, не ошибка прототипа. Проверять, какие PNG реально появились (`ls -la shots/`), недостающие — повторным `snap`. Смотреть PNG глазами обязательно.
- **`geometry` exit 2 + `gaps: n/a (flow is not declared)`** — не ошибка нулевого зазора, а «flow-контекст недоказуем». Полезная часть — rect'ы: по ним ловится и растянутый YpBox, и уехавший футер.
- **Warnings ≠ blocker.** Save проходит с предупреждениями (state path, repeat не-массив) — но каждое из них означает неработающую директиву в рантайме. Чистый прототип не шумит.
- **Snap с FlowRoot-футером режет CTA.** `fullscreen: true` даёт контенту min-height 100vh; capture складывает контент+region-футер (390×955 на вьюпорте 844) — нижняя часть футера уходит за фолд PNG. Это артефакт capture-поверхности: в mobile fluid present футер пинится корректно (проверено interact-скриншотами плеера).

## Уборка

`doc.id` — глобальный ключ (create-or-update): не занимать чужие id (`node driver.mjs get prototypes`). Тестовые прототипы удалять: `node driver.mjs delete prototypes <id>` (hard delete).
