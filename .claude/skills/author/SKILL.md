---
name: author
description: Add prototypes and custom components to easy-ui over its HTTP API — build a multi-screen prototype JSON flow, author a custom TSX component, publish them to the easy-ui server (prod or local), and screenshot the result in the player. Use when asked to create, add, update, or publish an easy-ui prototype or component.
---

# Authoring prototypes & components in easy-ui (remote API)

easy-ui — просмотрщик кликабельных прототипов: многоэкранные флоу из готовых shadcn-компонентов с навигацией и общим стейтом. Этот скилл самодостаточен и работает **только через HTTP API** — доступ к коду сервера не нужен. Все пути ниже — относительно каталога этого скилла. Харнес — `driver.mjs` (plain Node ≥18, без зависимостей).

Два сценария, от частого к редкому:

1. **Прототип из встроенного каталога** (37 компонентов) — написать JSON, отправить драйвером.
2. **Кастомный React-компонент + прототип на нём** — TSX-модуль публикуется через API, затем используется в прототипе как обычный тип.

## Setup

```bash
export EASYUI_AUTH="user:pass"     # basic-auth креды инстанса (выдаёт владелец)
# по умолчанию драйвер ходит на https://easy-ui.pay-offline.ru
# другой инстанс (например локальный): export EASYUI_API="http://127.0.0.1:8787/api"
```

Проверка доступа (список прототипов; без корректного `EASYUI_AUTH` будет 401):

```bash
node driver.mjs get prototypes
```

## Сценарий 1: прототип из встроенных компонентов

1. Прочитать справочник каталога `reference/builtin-catalog.json` — все 37 типов с JSON Schema props, событиями и примерами. Props валидируются строго: неизвестный ключ = ошибка.
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

Корень: `{version: 1, id, name, description?, designSystem?, device?, startScreen, state?, screens[]}`. `designSystem` — slug зарегистрированной системы (default `shadcn`); `id` и все ID — slugs; `device` — `mobile | tablet | desktop` (default `desktop`); `startScreen` существует в `screens`.

Экран: `{id, name, canvas?: {width,height}, spec: {root, elements}}`. Элемент: `{type, props, children?, visible?, on?}` — только эти ключи. Элементы образуют одно дерево от `root` (≤500 элементов, глубина ≤50).

`state` — единственный источник начального стейта; пути — абсолютные JSON Pointer (`/path`). `/currentScreen`, `/navStack`, `/_viewer` зарезервированы.

**Директивы** (значение отдельного prop, не весь объект `props`):

- `{"$state": "/path"}` — чтение стейта;
- `{"$bindState": "/path"}` — двусторонняя привязка (редактируемые значения читать только так — события без payload);
- `{"$template": "Hello ${/name}"}` — интерполяция;
- `{"$cond": {"if": condition, "then": literal, "else": literal}}` — выбор значения (только точно эта форма).

Condition: boolean, truthiness `{"$state":"/path"}`, либо `{"$state":"/path", eq|neq|gt|gte|lt|lte: ..., not?: true}` (максимум один оператор; `gt/gte/lt/lte` — только статические числа). Композиция — `{"$and":[...]}` / `{"$or":[...]}`. `repeat`, `watch`, `$computed`, `$item`, `$index`, `$bindItem` — зарезервированы и невалидны.

**События и экшены**: имя события объявлено в definition компонента; значение — экшен или последовательный массив. Терминальный экшен максимум один и последний: `navigate {screenId}`, `back {}`, `restart {}`, `openUrl {url}`. Нетерминальные: `setState {statePath, value}`, `pushState {statePath, value, clearStatePath?}`, `removeState {statePath, index}`. Params — только статические литералы. `Link`, который навигирует, обязан ставить `preventDefault: true` на navigation-экшене.

**URL и Hotspot**: `openUrl.url` и `Link.href` — статические `http(s)`; `Image.src` дополнительно допускает абсолютный путь с `/`. `Hotspot` требует `canvas` у экрана; его прямоугольник — статические числа внутри canvas.

### Версии и публикация прототипа

Каждое сохранение — неизменяемая ревизия (драфт). Плеер показывает драфт сразу — publish не обязателен. Зафиксировать версию (v1, v2, …): `POST /prototypes/:id/publish` c `{baseRev}` — при необходимости через `curl -u "$EASYUI_AUTH"`.

## Сценарий 2: кастомный компонент + прототип

Контракт TSX-модуля — named export `definition` + default plain function component (`memo`/`forwardRef` нельзя). Рабочий образец: `examples/rating-stars.tsx`:

- `definition.props` — Zod **strict** схема; `description: string` обязателен; опционально `events?: string[]`, `slots?: string[]`, `example?` (обязан проходить props-схему).
- Компонент получает один аргумент `{props, emit}`; `emit("eventName")` без payload.
- Импортировать можно только: `react`, `react-dom`, `react/jsx-runtime`, `zod`, `@json-render/react`. CSS-импорты и произвольные Tailwind-классы нельзя — стилить inline-стилями и CSS-переменными темы (`var(--border)` и т.п.).
- Лимит source — 256 KiB; JSON-тело запроса — 1 MiB.

```bash
node driver.mjs component rating-stars RatingStars examples/rating-stars.tsx --design-system yandex-pay
# saved rating-stars rev 1 in yandex-pay
# published rating-stars version 1 in yandex-pay
```

Систему для компонента выбирает `--design-system`, затем `EASYUI_DESIGN_SYSTEM`; если не заданы оба, при создании сервер использует `shadcn`, а при обновлении сохраняет текущую систему. Флаг имеет приоритет над env. Перенос без изменения source и регистрация новой системы:

```bash
node driver.mjs component-move rating-stars --design-system yandex-pay
node driver.mjs design-system my-system "My Design System" "Components for my product"
```

Перенос создаёт и публикует новую ревизию, но старые published versions остаются в прежней системе. Поэтому один component ID может одновременно появляться в каталогах обеих систем: прототип каждой системы получает последнюю опубликованную версию именно для своей системы. Имя компонента при этом глобально уникально и не может совпадать с builtin-именем любой системы с builtin provider.

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

## Посмотреть результат

Ссылка `…/p/<id>` из вывода драйвера открывается в браузере под теми же кредами; экраны — `…/p/<id>/s/<screenId>`. Если в окружении агента есть playwright, драйвер снимет каждый экран сам и **упадёт при ошибках консоли браузера** (валидный по схеме прототип всё ещё может не отрендериться):

```bash
node driver.mjs shoot my-flow ./shots
# ./shots/<screenId>.png на каждый экран
```

## Инспекция и удаление

```bash
node driver.mjs get prototypes            # список (id, headRev, latestVersion, ...)
node driver.mjs get components my-comp    # один ресурс: headRev, versions
node driver.mjs delete prototypes my-flow # hard delete (prototypes) / soft (components)
```

Удаление компонента — soft: он исчезает из списка и недоступен новым сохранениям, но опубликованные bundle и пины существующих прототипов продолжают работать.

## Gotchas

- Прототип **обновляется, а не создаётся заново**: `doc.id` — ключ. Не занимайте чужие id — `get prototypes` покажет, что уже есть.
- Все мутации требуют `baseRev` (409 при гонке) — драйвер берёт `headRev` сам; при ручном `curl` не забыть.
- Директива не может заменить весь объект `props`; `$cond` принимается только в канонической форме `{"$cond":{if,then,else}}`.
- Показ/скрытие целого элемента — `visible` с condition, не `$cond` в props.
- Длинные JSON-тела в шелле не инлайнить (бэктики выполняются как command substitution) — писать payload в файл; драйвер избавляет от этого.
- `shoot` ждёт `networkidle` — на медленном инстансе первый экран может грузить bundle компонента дольше секунды, это нормально.

## Troubleshooting

- `401` на любой запрос — не задан/неверен `EASYUI_AUTH` (формат строго `user:pass`, драйвер сам кодирует base64).
- `save failed (422) ... "Unrecognized key: \"bogus\""` с path `/screens/0/spec/elements/...` — prop, которого нет в схеме компонента; сверить с `reference/builtin-catalog.json` (для кастомных — со своей Zod-схемой).
- `save failed (422) ... "Unknown or unpublished component type: X"` — тип не встроенный и не опубликован как компонент; сначала `driver.mjs component ...`.
- `publish failed (422) ... Type check failed` (компонент) — читать вывод tsc в issue; save такие ошибки не ловит.
- `save failed (409)` — параллельное редактирование того же id (CAS-конфликт); повторить запуск драйвера (он перечитает `headRev`).
- `shoot` падает с `Cannot find package 'playwright'` — окружению агента нужен playwright (`npm i playwright && npx playwright install chromium`) либо смотреть прототип в браузере по ссылке player.
