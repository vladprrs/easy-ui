---
name: author
description: Add prototypes and custom components to easy-ui over its HTTP API — build a multi-screen prototype JSON flow, author a custom TSX component, publish them to the easy-ui server (prod or local), and screenshot the result in the player. Use when asked to create, add, update, or publish an easy-ui prototype or component.
---

# Authoring prototypes & components in easy-ui (remote API)

easy-ui — просмотрщик кликабельных прототипов: многоэкранные флоу из готовых shadcn-компонентов с навигацией и общим стейтом. Этот скилл самодостаточен и работает **только через HTTP API** — доступ к коду сервера не нужен. Все пути ниже — относительно каталога этого скилла. Харнес — `driver.mjs` (plain Node ≥18, без зависимостей).

Два сценария, от частого к редкому:

1. **Прототип из встроенного каталога** (shadcn — 37 компонентов, wireframe — 12) — написать JSON, отправить драйвером.
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

1. Прочитать справочник каталога `reference/builtin-catalog.json` — по ключу на каждую builtin-систему (`shadcn` — 37 типов, `wireframe` — 12), внутри — типы с JSON Schema props, событиями, atomic-уровнем и примерами. Прототипу доступны только builtins его `designSystem` (плюс опубликованные в этой системе кастомные компоненты); у систем, созданных через API (например `yandex-pay`), builtins нет вообще. Props валидируются строго: неизвестный ключ = ошибка.
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

Корень: `{version: 1, id, name, description?, designSystem?, device?, startScreen, state?, screens[]}`. `designSystem` — slug зарегистрированной системы (default `shadcn`); `id` и все ID — slugs; `device` — `mobile | tablet | desktop` (default `desktop`); `startScreen` существует в `screens`.

Экран: `{id, name, canvas?: {width,height}, note?, stateOverrides?, spec: {root, elements}}`. Элемент: `{type, props, children?, visible?, on?, repeat?, slot?}` — только эти ключи. Элементы образуют одно дерево от `root` (≤500 элементов, глубина ≤50).

`state` — единственный источник начального стейта; пути — абсолютные JSON Pointer (`/path`). `/currentScreen`, `/navStack`, `/_viewer` зарезервированы; сегменты `__proto__`/`prototype`/`constructor` запрещены.

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

**События и экшены**: имя события объявлено в definition компонента; значение — экшен или последовательный массив. Терминальный экшен максимум один и последний: `navigate {screenId}`, `back {}`, `restart {}`, `openUrl {url}`. Нетерминальные: `setState {statePath, value}`, `pushState {statePath, value, clearStatePath?}`, `removeState {statePath, index}`. `Link`, который навигирует, обязан ставить `preventDefault: true`.

**Payload и условные экшены — только события custom-компонентов** (builtin-события payload не несут; на builtin-элементе всё нижеследующее — ошибка валидации):

- источники значений в params: `{"$event": "/ptr"}` (указатель внутрь payload; `""` — весь payload), `{"$elementId": true}`, `{"$itemIndex": true}` / `{"$itemKey": true}` (внутри repeat; `$itemKey` требует `repeat.key`). Допустимы в `value` state-экшенов, `removeState.index` и `navigate.screenId` (runtime-guard по существующим экранам); `openUrl.url` всегда статический;
- `"$if": condition` на экшене — пропуск при false; condition дополнительно принимает `{"$event":"/ptr"}`-операнд в `eq`/`neq`/truthiness;
- `$event` допустим только на событии с объявленной payload-схемой.

Прочие params — статические литералы.

**URL и Hotspot**: `openUrl.url` и `Link.href` — статические `http(s)`; `Image.src` дополнительно допускает абсолютный путь с `/` (включая `$asset`-резолв). `Hotspot` требует `canvas` у экрана; его прямоугольник — статические числа внутри canvas.

**Warnings**: save возвращает несблокирующие semantic warnings (interactive-элемент без обработчиков, отсутствие accessible label, большой inline base64, экраны без переходов и т.п.) — драйвер печатает их; чистый прототип не шумит.

### Ассеты

Картинки/шрифты/иконки не встраивать base64 — загружать в реестр и ссылаться `{"$asset": "<id>"}`:

```bash
curl -u "$EASYUI_AUTH" -X POST -H "Content-Type: image/png" --data-binary @banner.png \
  https://easy-ui.pay-offline.ru/api/assets
# {"id":"asset_<sha256>","url":"/api/assets/asset_...","sha256":"...","mime":"image/png",...}
```

Дедуп по sha256 (повторная загрузка вернёт тот же id), лимит 5 MiB, magic-byte проверка типа (png/jpeg/webp/gif/svg/woff2/ttf/otf). Из custom TSX ассет доступен по строковому URL `/api/assets/asset_<sha256>` — такие ссылки пинуются при publish.

### Проверка рендеримости

`node driver.mjs status <id> <screenId>` — машинный `render-status`: `{renderable, status: {document, bundles, route}, resolvedPins, warnings, errors}` (exit 1, если не renderable). Ответ save также содержит канонические URL всех экранов — драйвер их печатает.

### Версии и публикация прототипа

Каждое сохранение — неизменяемая ревизия (драфт). Плеер показывает драфт сразу — publish не обязателен. Зафиксировать версию (v1, v2, …): `POST /prototypes/:id/publish` c `{baseRev}` — при необходимости через `curl -u "$EASYUI_AUTH"`.

## Сценарий 2: кастомный компонент + прототип

Контракт TSX-модуля — named export `definition` + default plain function component (`memo`/`forwardRef` нельзя). Образцы: `examples/rating-stars.tsx` (простейший, ABI v1) и `examples/plan-picker.tsx` (typed events + named slots, ABI v2):

- `definition.props` — Zod **strict** схема; `description: string` обязателен; опционально `slots?: string[]`, `example?` (обязан проходить props-схему), `atomicLevel?`, `capabilities?: {typedEvents?, namedSlots?}` (тип требует литеральные `true` — писать `{...} as const`), семантика для валидатора (`interactive?`, `accessibleLabelProps?`, `urlProps?`).
- `events` — `string[]` (payload-less, legacy) **или** `Record<name, ZodSchema>` (typed payload). Typed-схема обязана детерминированно конвертироваться в JSON Schema — transform/preprocess дадут 422 `event_schema_not_serializable` на publish.
- Компонент получает `{props, emit, slots}`; для typed/slots-компонентов импортируйте тип `EasyUIComponentProps` из `easy-ui/runtime` — `emit("choose", {id, price})` c payload (валидируется по схеме, `$`-ключи в payload запрещены), `slots.header` — ReactNode именованного слота (`children === slots.default`).
- Импортировать можно: `react`, `react-dom`, `react/jsx-runtime`, `zod`, `@json-render/react` и `easy-ui/runtime` (последний = ABI v2; экспортирует также `token("color.text.primary")` и `Icon` для темы дизайн-системы). CSS-импорты и произвольные Tailwind-классы нельзя — стилить inline-стилями и CSS-переменными темы (`var(--border)`, `var(--eui-*)` из tokens системы).
- `hostAbiVersion` вычисляется на publish автоматически: capabilities или импорт `easy-ui/runtime` → 2, иначе 1.
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

Ссылка `…/p/<id>` из вывода драйвера открывается в браузере под теми же кредами; экраны — `…/p/<id>/s/<screenId>`. Отладка интеракций — добавить `?debug=1`: inspector-панель показывает события с payload, экшены, диффы стейта и статусы шрифтов.

Скриншоты — два способа, **предпочитать `snap`** (серверный рендер, playwright в окружении агента не нужен; падает при ошибках консоли браузера):

```bash
node driver.mjs snap my-flow ./shots     # server-side: job API + PNG из asset registry
node driver.mjs shoot my-flow ./shots    # локальный playwright, если установлен
# ./shots/<screenId>.png на каждый экран
```

Серверные скриншоты также доступны сырым API (`POST /prototypes/:id/screens/:sid/screenshot {viewport,...}` → 202 `{jobId}` → `GET /screenshot-jobs/:jobId`; параметры theme/deviceScaleFactor/rev/version), включая скриншот одного компонента: `POST /components/:id/versions/:v/screenshot {props?, viewport}`. Visual regression (эталоны + diff) — UI `/visual` и `PUT /api/visual-references` / `POST .../check`.

## Инспекция и удаление

```bash
node driver.mjs get prototypes            # список (id, headRev, latestVersion, ...)
node driver.mjs get components my-comp    # один ресурс: headRev, versions
node driver.mjs get design-systems        # реестр систем (builtins + созданные через API)
node driver.mjs delete prototypes my-flow # hard delete (prototypes) / soft (components)
```

Удаление компонента — soft: он исчезает из списка и недоступен новым сохранениям, но опубликованные bundle и пины существующих прототипов продолжают работать.

Жизненный цикл версий компонента: у published-версии есть статус (`active` по умолчанию). Неудачную версию можно пометить, не удаляя: `POST /components/:id/versions/:v/status` c `{status: rejected|deprecated|superseded|archived, reason?, supersededBy?, baseStatusRev}` (CAS по `statusRev` из read-back версии). `rejected`/`archived` перестают исполняться (плеер покажет `bundle_failed` в render-status), `deprecated`/`superseded` продолжают работать с warning'ом. Новые пины и манифест берут только `active`.

Discovery: `GET /api/openapi.json` (полный OpenAPI 3.1), `GET /api/capabilities` (actions/директивы/лимиты/фичи/системы), `GET /api/schemas/prototype-document.json` и `.../component-definition.json` — источник истины, когда этого файла недостаточно. Опционально к компоненту/прототипу можно прикладывать Figma-происхождение: поле `figma: {fileKey, nodeIds[], referenceScreenshots?: [assetId], lastSyncedAt?}` рядом с `doc`/`source` в POST/PUT — сохраняется на ревизии, отдаётся в read-back.

## Gotchas

- Прототип **обновляется, а не создаётся заново**: `doc.id` — ключ. Не занимайте чужие id — `get prototypes` покажет, что уже есть.
- Все мутации требуют `baseRev` (409 при гонке) — драйвер берёт `headRev` сам; при ручном `curl` не забыть.
- Директива не может заменить весь объект `props`; `$cond` принимается только в канонической форме `{"$cond":{if,then,else}}`.
- Показ/скрытие целого элемента — `visible` с condition, не `$cond` в props.
- `$event`/`$if`/`slot` работают только с custom-компонентами: на builtin-элементе это ошибки валидации, а не тихий no-op. Payload у builtin-событий не бывает.
- `$itemKey` требует `repeat.key`; `$item`/`$index` вне repeat-поддерева — ошибка.
- Длинные JSON-тела в шелле не инлайнить (бэктики выполняются как command substitution) — писать payload в файл; драйвер избавляет от этого.
- `shoot` ждёт `networkidle` — на медленном инстансе первый экран может грузить bundle компонента дольше секунды, это нормально. `snap` этим не страдает (серверный readiness-протокол сам ждёт шрифты и изображения), но очередь скриншотов на сервере ограничена (429 при переполнении — повторить).

## Troubleshooting

- `401` на любой запрос — не задан/неверен `EASYUI_AUTH` (формат строго `user:pass`, драйвер сам кодирует base64).
- `save failed (422) ... "Unrecognized key: \"bogus\""` с path `/screens/0/spec/elements/...` — prop, которого нет в схеме компонента; сверить с `reference/builtin-catalog.json` (для кастомных — со своей Zod-схемой).
- `save failed (422) ... "Unknown or unpublished component type: X"` — тип не встроенный и не опубликован как компонент; сначала `driver.mjs component ...`.
- `publish failed (422) ... Type check failed` (компонент) — читать вывод tsc в issue; save такие ошибки не ловит.
- `publish failed (422) ... event_schema_not_serializable` — typed-схема события содержит transform/preprocess/custom-логику; упростить до чистых object/string/number/enum-схем.
- `save failed (409)` — параллельное редактирование того же id (CAS-конфликт); повторить запуск драйвера (он перечитает `headRev`).
- `shoot` падает с `Cannot find package 'playwright'` — использовать `snap` (серверные скриншоты, playwright не нужен) либо смотреть прототип в браузере по ссылке player.
- `snap` вернул 501 `screenshot_unavailable` — инстанс без `SERVE_DIST`/chromium (например голый локальный `server:dev`); на проде работает.
- Экран «рендерится, но пусто/не так» — `node driver.mjs status <id> <screen>` (пины/бандлы/маршрут) и `?debug=1` в плеере (события, payload, диффы стейта).
