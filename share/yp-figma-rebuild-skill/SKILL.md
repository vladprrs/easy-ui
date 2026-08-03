---
name: yp-figma-rebuild
description: Rebuild the Yandex Pay design system in easy-ui from scratch, atom by atom, pixel-perfect against the Figma source of truth — extract tokens and components via Figma MCP, publish them into a fresh design system over the easy-ui HTTP API, and verify every component with server screenshots diffed against Figma reference exports. Use when asked to recreate or build the Yandex Pay component system from Figma.
---

# Пересборка Yandex Pay: Figma → easy-ui, pixel perfect, атом за атомом

Ты — агент с двумя инструментами: **Figma MCP** (библиотека дизайн-системы Yandex Pay — источник истины) и **HTTP API easy-ui** (харнес `driver.mjs` + `api.mjs` из этого пакета). Существующая в easy-ui система `yandex-pay` собиралась без прямого доступа к Figma и фундаментально расходится с оригиналом. Твоя задача — построить систему компонентов **заново, с нуля**: каждый токен, атом, молекула и организм снимаются с Figma и публикуются в **новую** дизайн-систему, из которой потом собираются кликабельные прототипы, пиксельно совпадающие с макетами.

Это марафон, не спринт: работа идёт строго по уровням (токены → атомы → молекулы → организмы → эталонные экраны), каждый компонент проходит численную и пиксельную приёмку до перехода к следующему. Прогресс фиксируется в файлах (`BUILD_ORDER.md`, `REPORT.md`) — сессию можно прервать и продолжить.

## 0. Незыблемые правила

1. **Старую систему `yandex-pay` не трогать.** Не публиковать в неё, не менять её тему, не архивировать её компоненты, не переиспользовать её `Yp*`-имена. Прод живёт на ней. Читать её можно только как справку по механике easy-ui (как устроен работающий TSX-компонент) — **никогда** как источник визуальных значений.
2. **Figma — единственный источник значений.** Каждый цвет, отступ, радиус, размер, толщина шрифта, тень берётся из Figma (variables, inspect/dev-mode данные ноды), а не «на глаз», не из памяти и не из старой системы. Каждое значение в TSX должно быть прослеживаемо до Figma-ноды.
3. **Атом за атомом.** Компонент не готов, пока не прошёл приёмку (§5). Молекула не начинается, пока не готовы все её атомы. Не публиковать «примерно похожее, доведу потом».
4. **Все повторяющиеся стилевые значения — через токены темы** (`color()` / `space()` из `easy-ui/runtime/v4`). Сырой литерал допустим только как fallback внутри `color(...)` и для метрик конкретного компонента, не покрытых токенами (высота контрола, ширина иконки).
5. **Renderer НЕ применяет Zod-дефолты.** Каждый `.default(X)` схемы обязан дублироваться `?? X` в рендер-коде; каждый массив — `?? []`; каждый lookup по ключу — с fallback-веткой. Это причина №1 поломок старой системы.
6. **Никакого base64.** Иллюстрации, иконки, шрифты — только через реестр ассетов (`api.mjs upload` → `asset_<sha256>`).
7. **Каждый компонент несёт Figma-provenance**: `fileKey` + `nodeIds` + загруженные эталонные скриншоты (`api.mjs figma`). Без provenance компонент не считается готовым.
8. **`409 component_reuse_required | canonical_role_conflict | catalog_changed` — терминальный STOP**: не ретраить, не переименовывать ради обхода, `--force-new` — только человек-админ. Reuse-гейт действует и в новой системе.

## 1. Setup

Пакет самодостаточен, репозиторий easy-ui не нужен. Node ≥ 18. Для пиксельного диффа один раз: `npm i pixelmatch pngjs` (в каталоге пакета).

```bash
export EASYUI_USERNAME="…"    # named-аккаунт easy-ui (нужны права на создание дизайн-системы)
export EASYUI_PASSWORD="…"
# инстанс по умолчанию — https://easy-ui.pay-offline.ru; другой: export EASYUI_API="http://127.0.0.1:8787/api"

node driver.mjs get prototypes          # smoke: API и креды живы
node api.mjs get /capabilities          # actions, лимиты, фаза reuse-гейта, features
```

Цикл ниже опирается на серверные возможности, объявленные в `features` этого инстанса: `componentValidate` (префлайт), `componentDraftPreview` (`preview --rev head-draft`), `componentGeometry` + `geometryPaint` (`preview --probe geometry`, измерение краски на приёмке), `prototypeHeadTracking` (`track: head`), `captureReadiness`, `readinessProfile`, `themeDryRun`/`themeSparseOps`, `acceptancePromote` (`promote`), `acceptanceMatrix`/`acceptanceCandidates`/`acceptanceRuns` (`accept`, §4.8), `compositionV3`/`compositionAnalyze` (§6). Драйвер проверяет их сам и на старом инстансе падает читаемым сообщением («server does not support …»), а не странным 404 — но на старом сервере цикл деградирует до «публикация на итерацию», и это надо учитывать в плане работ. Секция `renderer` того же ответа объявляет идентичность рендерера (версия chromium, sha запускаемого `chrome-headless-shell`, хэши шрифтового стека и флагов запуска, итоговый `fingerprint`) — она входит в отпечаток случая приёмки, поэтому апгрейд браузера на инстансе честно обнуляет накопленный reuse снимков.

Read-only ответы (capabilities, каталог, версии, case-set'ы, **терминальные** раны приёмки) кэшируются локально: `--cache-dir .easyui-cache` (или `EASYUI_CACHE_DIR`) на любом вербе, `--cache-refresh` форсирует промах. Кэш — ускоритель, а не свидетельство: в `--json` каждого ответа едет `cache.status` (`hit|miss|refresh|off`), и в отчёт идёт он, а не «я помню».

Два харнеса:

- **`driver.mjs`** — основной CLI: каталог, компоненты, прототипы, снапы, публикация. Полный справочник по механике (грамматика документа, директивы, версии, troubleshooting) — **`reference/easy-ui-authoring.md`**; здесь он не дублируется. Прочитай его перед началом.
- **`api.mjs`** — то, чего нет в driver: `get <path>`, `send <METHOD> <path> <body.json>`, `upload <file>` (ассеты), `theme <dsId> <theme.json>` (PATCH темы с авто-CAS), `figma <componentId> <figma.json>` (ретроактивное прикрепление provenance; в обычном цикле используй `driver.mjs component --figma`).

**Логин**: auth-клиент кэширует сессию на диске между вызовами (`$XDG_STATE_HOME/easyui`, TTL 24 ч; `EASYUI_SESSION_FILE` переопределяет путь, `EASYUI_SESSION_CACHE=0` выключает) — в норме логин один на серию. Лимит — 5 логинов на аккаунт в минуту: при `HTTP 429 rate_limited` проверь, не выключен ли кэш, подожди минуту и повтори.

**Один аккаунт на всю работу**: тему может менять только владелец системы (или админ), скриншоты — только владелец прототипа. Все шаги делай под одним и тем же аккаунтом. Перед созданием проверь, свободен ли slug: `node api.mjs get /design-systems/yandex-pay-v2` → `404` = свободен; существующая система под чужим владельцем всплывёт не сразу, а `403` на первом PATCH темы.

Смоук Figma MCP: получи корневые страницы файла библиотеки и убедись, что можешь (а) читать структуру и стили нод, (б) экспортировать PNG ноды. Без обоих не начинай.

## 2. Именование и площадка

- Дизайн-система: slug **`yandex-pay-v2`**, имя «Yandex Pay v2». Создание:

```bash
node driver.mjs design-system yandex-pay-v2 "Yandex Pay v2" "Pixel-perfect rebuild of the Yandex Pay design system from Figma"
```

- **Имена компонентов в easy-ui глобально уникальны across дизайн-систем** — `Yp*`/`yp-*` заняты старой системой. Канон новой: id `pay-<kebab>`, имя `Pay<Pascal>` (`pay-button` / `PayButton`, `pay-box` / `PayBox`). Не отступать от префикса.
- Probe-прототипы: `ypv2-probe-<level>` (`ypv2-probe-molecules`, `ypv2-probe-organisms`, …; атомам probe не нужен — §4.6), эталонные экраны: `ypv2-ref-<flow>`. `doc.id` глобальны — не занимать чужие (`node driver.mjs get prototypes`).

## 3. Phase 0 — разведка и фундамент

Результат фазы — закоммиченный в рабочий каталог `BUILD_ORDER.md` и тема v1.

### 3.1 Инвентаризация Figma

1. Обойди библиотеку: страницы → фреймы → published components. Для каждого компонента запиши `nodeId`, имя, варианты (component properties и их значения), зависимость от других компонентов (instances внутри).
2. Собери **`BUILD_ORDER.md`**: таблица `порядок | figma-компонент | nodeId | уровень (atom/molecule/organism) | зависимости | целевой id (pay-*) | статус`. Правило порядка: компонент идёт только после всех своих зависимостей. Первым — служебный layout-атом (§3.4).
3. Экспортируй переменные/стили: цветовые variables (все режимы, минимум light), типографические стили (семейство, размер, интерлиньяж, вес), spacing/radius, тени.

### 3.2 Тема: tokens + fonts

Тема — версионируемые коллекции `{tokens, fonts, icons}`; токены доезжают в runtime как CSS-переменные `--eui-<key с '.'→'-'>`, шрифты — как `@font-face`.

- Грамматика ключа: `^[a-z][a-z0-9]*(\.[a-z0-9-]+)*$`, значение — строка ≤256 без `;{}<>` (число допустимо только вне `space.*`).
- **`space.*` — жёсткие правила**: ровно девятка `space.none|xs|sm|md|lg|xl|2xl|3xl|4xl` (из неё сервер строит `resolvedSpaceScale`), значения — **строки в абсолютных px** (`"4px"`, не `4`), `space.none` — ровно `"0px"`, шкала неубывающая, других `space.*`-ключей быть не может. Нарушение любой из этих норм молча откатывает `resolvedSpaceScale` на каноническую `0/4/8/12/16/24/32/48/64` — именно поэтому §3.3 обязателен.
- **`color.*` — синтаксический allowlist значений**: hex, `rgb(a)/hsl(a)/var()`, named color, `linear-gradient()/radial-gradient()`. `color.shadow-*` — только форма box-shadow `[inset] <x> <y> [blur] [spread] <color>` (список через запятую можно); `color.gradient-*` — только gradient-функция. `drop-shadow(...)`, `blur(...)` и прочие эффекты Figma в токен не лезут (422) — такие эффекты живут в CSS конкретного компонента.
- Пространства ключей: `color.<semantic>` — **все** цвета из Figma variables (семантические имена Figma в kebab: `color.text-primary`, `color.bg-main`, `color.button-primary-bg`, …), тени `color.shadow-*`, градиенты `color.gradient-*`; `radius.*`, `font.*` — по потребности (читаются через `token("radius.m")`).
- Шкала spacing не обязана совпадать с канонической — бери фактическую сетку Figma. Значение Figma вне шкалы (например gutter 20px) — не подгонять под токен, а писать литералом в компоненте.
- Шрифты (YS Text и что ещё использует библиотека): нужны woff2/ttf-файлы. Сначала проверь реестр — `node api.mjs get /design-systems/yandex-pay` → `fonts[]` содержит asset-id уже загруженных начертаний; ассеты глобальны, переиспользуй эти id (это бинарники, не визуальные решения старой DS — можно). Недостающие начертания запроси у владельца и загрузи: `node api.mjs upload YS-Text-Medium.woff2`.
- **Иконки** — тоже коллекция темы: `icons: [{name, assetId, viewBox?, themes?{light,dark}}]`, `name` — kebab-slug, `assetId` — существующий `image/*`-ассет (сначала upload, потом PATCH — ссылка на несуществующий ассет = 422). В компоненте иконка читается `Icon({name})` из `easy-ui/runtime/v4`.

```bash
cat > theme.json <<'EOF'
{ "tokens": { "color.text-primary": "…из Figma…",
              "space.none": "0px", "space.xs": "4px", "space.sm": "8px", "…": "…px" },
  "fonts":  [ { "family": "YS Text", "src": "asset_<sha256>", "weight": 400 },
              { "family": "YS Text", "src": "asset_<sha256>", "weight": 500 } ],
  "icons":  [ { "name": "plus-glyph", "assetId": "asset_<sha256>" } ] }
EOF
node api.mjs theme yandex-pay-v2 theme.json    # версия 1 (baseVersion подставится сам)
```

PATCH-семантика: переданная коллекция **заменяет** предыдущую целиком, опущенная наследуется. Но полный словарь ради двух токенов больше не нужен — правь тему **sparse-операциями с dry-run** (W4):

```bash
# 1. dry-run: валидация + дифф + итоговая resolvedSpaceScale, версия НЕ создаётся
echo '{"addTokens":{"color.button-primary-bg":"#FFDD2D"},"dryRun":true}' > patch.json
node api.mjs theme yandex-pay-v2 patch.json     # baseVersion подставит сам
# 2. тот же файл без "dryRun" — запись
```

- `addTokens`/`addFonts`/`addIcons` — **append-only** поверх `baseVersion`: передаёшь только добавляемое. Существующая запись с другим значением → `409 theme_append_conflict` (тихой перезаписи нет), удаление невозможно — для него остаётся полный PATCH. Sparse-операция и её полный аналог (`tokens`/`fonts`/`icons`) в одном теле взаимоисключающи.
- **No-op не создаёт версию**: патч, результат которого равен `baseVersion`, отвечает `{noop:true, nextVersion:null}` — 13 версий темы за миграцию больше не набегает.
- Ответ несёт `diff` (added/changed/removed), `resolvedSpaceScale`, `spacingResolver` и **`stalePins`** — список прототипов, чья голова пинует старую версию темы. Это точный список того, что надо пересохранить, а не догадка.
- `spacingResolver: 2` у новых версий: spacing-оверрайды мерджатся на базовую шкалу самой DS, а полный token-патч, из которого `space.*` выпали целиком, наследует шкалу базовой версии (наследованные ключи перечислены в `inheritedSpaceTokens`), а не молча уезжает на каноническую.

Пока на токен никто не сослался, значения можно свободно править новой версией; после — каждая правка глобально меняет уже принятые компоненты, фиксируй такие правки в `BUILD_ORDER.md`. **Ревизия прототипа пинует версию темы**: после любого PATCH темы пересохрани каждый probe/ref-прототип из `stalePins` (`driver.mjs prototype <doc>.json`) до пере-снапа, иначе snap покажет старые токены и «фикс не сработал» — `track: head` (§4.6) резолвит только компонентные пины и от этого не спасает. `preview` атома тему не пинует — берёт всегда последнюю, пересохранений не требует (§4.6).

### 3.3 Верификация темы

`node driver.mjs catalog list yandex-pay-v2 --json` → `designSystem.resolvedSpaceScale` совпадает с задуманной девяткой (если вернулась каноническая `0/4/8/…`, которую ты не задавал — тема нарушила правила `space.*` и молча откатилась, чинить). После появления `pay-box` и `pay-text` собери probe-экран-«свотч» (сетка цветов и текстовых стилей) и проверь фактические цвета пикселей snap-PNG против hex из Figma (точное равенство; пипетка — прочитать RGB нужного пикселя из PNG любым способом, хоть `compare.mjs` на однотонном эталоне).

### 3.4 Служебный layout-атом — первым

В новой системе нет layout-примитива (host даёт только `Image`/`Hotspot`/`Overlay`/`@eui/FlowRoot`), поэтому ни probe, ни экран собрать не из чего. Первый компонент — **`pay-box` / `PayBox`**: flex-стек, моделирующий autolayout Figma: `mode: "row"|"col"`, `gap`/`padding`/`paddingX`/`paddingY` (токены шкалы **или** число px — union, как в Figma), `align`/`justify`, `width: "hug"|"fill"|<число>`, `height` аналогично, `background`, `radius`. Семантика hug/fill — точно как в Figma autolayout: **hug по умолчанию** (контейнер обнимает контент; не повторяй ошибку старой системы, где box рос `flex:1` по умолчанию и раздувал вложенные ряды).

В definition `pay-box` укажи layout-метаданные: `layout: { version: 1, spacing: ["gap", "padding", "paddingX", "paddingY"] }` — их читает geometry-probe. Флаг `layoutNeutral: true` ставь только если готов выполнить его жёсткий конформанс-гейт целиком: объявленный слот `default`, непустой `layout`, **никаких** events, `interactive !== true`, `atomicLevel` atom/molecule и SSR-рендер, реально выводящий default-слот; иначе publish упадёт — проще не ставить.

## 4. Phase 1 — цикл атома (основной рабочий цикл)

Для каждого компонента из `BUILD_ORDER.md`, строго по порядку:

### 4.1 Выписка из Figma

Возьми ноду компонента (и каждого варианта) и выпиши **все** значения: размеры фрейма, autolayout (направление, gap, паддинги, hug/fill), fills/strokes с привязкой к variable, радиусы, эффекты (тени с полными параметрами), типографику (семейство/вес/размер/интерлиньяж/letter-spacing), состояния (default/hover/pressed/disabled — что есть в вариантах). Экспортируй **эталонный PNG** каждого варианта: предпочтительно @2x — сверка тогда идёт против `preview --dsf 2` для атома (или `snap --dsf 2` для probe-экрана; субпиксельные детали виднее); если MCP отдаёт только scale 1 — сравнивай со снапом без `--dsf`. Масштабы эталона и снапа обязаны совпадать. Выписку сохрани в `notes/<pay-id>.md` — она же чек-лист сверки.

### 4.2 Reuse-гейт

```bash
node driver.mjs catalog search yandex-pay-v2 --intent "<продуктовая задача компонента>" --json
```

Гейт enforce действует и здесь, и его скоуп — **внутри одной дизайн-системы**: старые `Yp*` никогда не заблокируют создание `pay-*`, но по мере наполнения `yandex-pay-v2` гейт становится реальным для твоих же компонентов. Вариант того же Figma-компонента (size/tone/state) — это **проп существующего** `pay-*`, не новый id. Кандидат почти покрывает — расширь его non-breaking ревизией. `409` — терминальный STOP (правило 8); пересечение по `canonicalFor` блокирует независимо от score. Экран/секция из готовых компонентов — это **composition** (`driver.mjs composition`), не новый компонент.

### 4.3 Схема

- Component properties Figma → zod strict: варианты → `z.enum([...])`, булевы свойства → `z.boolean()`, текстовые слоты → `z.string()`, instance-swap → `z.enum` допустимых значений либо named slot. Имена пропов — нормализованные имена свойств Figma (camelCase).
- Дефолт каждого пропа = дефолтный вариант компонента в Figma.
- Интерактивные компоненты (кнопки, карточки выбора, инпуты, свитчи) обязаны объявлять **typed events** (`events: { press: z.strictObject({}) }`, для выбора — payload с id) и `interactive: true` + `accessibleLabelProps`.
- Контейнерные — `slots` (named slots по слотам Figma) и/или `children`. Имена слотов — **kebab-slug** (не camelCase), и named slots требуют `capabilities: { namedSlots: true } as const` в definition; объявленный слот обязан рендериться.
- `canonicalFor` в этой пересборке **не ставить** без явного согласования с владельцем инстанса: сервер проверяет только форму слага, выдуманная роль молча становится каноном. Список согласованных ролей — `reference/canonical-roles.md`.

### 4.4 Рендер

Шаблон — `templates/atom.tsx`. Требования:

- Импорты значений — только из `easy-ui/runtime/v4` (доступны `token`, `space`, `color`, `Icon`; импортируй нужные). Ровно один value-runtime-специфаер на модуль; тип `EasyUIComponentProps` — type-only из `easy-ui/runtime`, это допустимо.
- Каждый цвет/тень/градиент — `color("<ключ без color.>", "<точный литерал из Figma>")`: fallback держит пиксель-паритет, ключ ведёт в тему.
- Каждый `.default()` схемы → парный `?? <тот же дефолт>`; массивы → `?? []`; lookup-таблицы → fallback-ветка; арифметика — без NaN.
- `fontWeight` — только реально существующие начертания загруженных шрифтов (иначе браузер сделает faux-bold и пиксели уедут).
- Объявленный slot обязан рендериться.
- `examples` в definition обязательны: минимум default-вид + по одному на существенный вариант (это и варианты для `preview --example`, и материал для стикершита, и превью в Library).

### 4.5 Публикация + provenance

```bash
node api.mjs upload figma-refs/pay-button-primary.png     # → asset_<sha256>, на каждый эталонный PNG
cat > pay-button.figma.json <<'EOF'
{ "fileKey": "<из URL Figma-файла>", "nodeIds": ["123:456", "123:789"],
  "referenceScreenshots": ["asset_<sha256>", "asset_<sha256>"], "lastSyncedAt": "<ISO now>" }
EOF
node driver.mjs component pay-button PayButton pay-button.tsx \
  --design-system yandex-pay-v2 --intent "Primary action button for payment flows" \
  --figma pay-button.figma.json
```

**`--figma` — при каждом вызове `component`**: `figma_json` живёт на ревизии и не наследуется — update или `component-move` без флага молча обнуляют provenance head. Держи `<id>.figma.json` рядом с TSX и передавай всегда. `api.mjs figma` остаётся только для ретроактивного прикрепления к уже опубликованному компоненту без правки source (он делает PUT + re-publish — лишняя версия). Лимиты ассетов: 5 MiB и 16 Mpx на файл.

Save проверяет синтаксис, **тип-ошибки ловит publish** (вывод tsc в ответе) — но ловить их publish'ем больше не нужно: перед публикацией прогоняй **validate-префлайт головы** (W2), он гоняет publish-набор проверок без создания версии и без изменения публичного состояния:

```bash
node api.mjs send POST /components/pay-button/validate     # тела не нужно
# {"ok":true,"cached":false,"sourceHash":"…","bundleHash":"…","hostAbiVersion":4,"themeVersion":3,"catalogRevision":"…","warnings":[]}
```

Префлайт проверяет typecheck/compile/import, извлечение definition со smoke-рендером, asset-refs и **поля provenance** (неподдерживаемое поле вроде `pageNodeId` приезжает 422 с указанием поля — а не после всей подготовки к публикации), плюс предупреждает о рассинхроне `.default()` схемы и `??`-fallback рендера. Чего receipt **не** покрывает: canonical-role и reuse-гейт — они каталого-временные и остаются на publish. Результат кэшируется по `sourceHash` и переиспользуется самим publish'ем (второй раз за компиляцию не платим); при занятом слоте — `429 validate_in_flight`, при выключенном префлайте (`EASYUI_VALIDATE_DISABLED=1`) — 404.

Правишь опубликованный — базой правки бери актуальный active-source с сервера (`GET /components/<id>/versions/<v>`), не локальный файл, если сессия прерывалась. Повторный PUT с идентичными `source`+`figma` ревизии не создаёт: ответ `{"unchanged":true,"rev":<head>}` (W2) — это норма, а не ошибка.

### 4.6 Приёмка атома: `preview`; probe — со стадии молекул

Одиночный атом принимается **без probe-дока** — verb `preview` снимает компонент напрямую, в двух режимах: сохранённая head-ревизия без публикации (`--rev head-draft`, W2) и опубликованная head-версия (по умолчанию):

```bash
node driver.mjs preview pay-button --rev head-draft --example primary --dsf 2 --out shots/pay-button.png
# preview pay-button draft rev 4 bundleHash=… designSystemMetaVersion=3 viewport=1280x800 dsf=2 theme=light
node driver.mjs preview pay-button --example primary --dsf 2 --out shots/pay-button.png
# preview pay-button v1 bundleHash=… designSystemMetaVersion=3 viewport=1280x800 dsf=2 theme=light
```

PNG — content-hug (воркер снимает сам элемент, не вьюпорт): размеры эталона и снапа сравниваются напрямую, без canvas-арифметики. `--probe geometry` вместо PNG отдаёт замер той же поверхности (вход для `expect`, §4.7). **Итоговый цикл атома: правка → save ревизии без публикации → `preview --rev head-draft` → `expect` (+`compare` с эталоном Figma) → validate-префлайт → `accept` по семье вариантов (§4.8, если вариантов больше одного) → `promote` ровно один раз (приёмка головы: validate+publish+auto-supersede одной командой, `features.acceptancePromote`; ссылки `candidateId`/`acceptanceRunId` кладут ран приёмки в provenance версии).** Промежуточных публикаций быть не должно: всё, что раньше требовало версии, делается на сохранённой голове. Verb `component` делает save+publish за вызов — он остаётся входом создания (reuse-гейт/discovery) и финальным publish'ем, а промежуточные сохранения идут через `api.mjs` (PUT гейт создания не проходит):

```bash
# промежуточная итерация (без публикации):
node api.mjs get /components/pay-button                     # headRev → baseRev для CAS
jq -n --arg src "$(cat pay-button.tsx)" --argjson figma "$(cat pay-button.figma.json)" \
  '{source:$src, figma:$figma, baseRev:<headRev>, message:"iterate"}' > save.json
node api.mjs send PUT /components/pay-button save.json      # → {"rev": N+1}
node driver.mjs preview pay-button --rev head-draft --example primary --dsf 2 --out shots/pay-button.png
node driver.mjs preview pay-button --rev head-draft --example primary --probe geometry --out actual.json
node driver.mjs expect expected/pay-button.json actual.json          # числовой вердикт (§4.7)
node compare.mjs figma-refs/pay-button@2x.png shots/pay-button.png diff/pay-button.png
# приёмка сошлась → префлайт → единственная публикация:
node api.mjs send POST /components/pay-button/validate
# финал: PUT отвечает no-op unchanged (source+figma без изменений), драйвер публикует голову:
node driver.mjs component pay-button PayButton pay-button.tsx \
  --design-system yandex-pay-v2 --intent "Primary action button for payment flows" --figma pay-button.figma.json
```

Драфт-съёмка идёт через candidate-bundle префлайта validate: провал (тип-ошибки tsc, битые asset-refs) приезжает тем же 422, что отдаёт publish, — итерация ловит те же дефекты, не плодя версий; при холодном кэше постановка собирает кандидата (заметное время) под троттлингом префлайта (429 `validate_in_flight` — повтор после завершения чужого прогона; `queue_full` драйвер ретраит сам). Asset-refs драфта обязаны существовать в реестре (422 `asset_not_found` до сборки), kill-switch `EASYUI_VALIDATE_DISABLED=1` гасит драфт-превью (published-режим работает). Пересохранений ради пинов нет: ревизия драфта — head, тема — всегда последняя (фактическая — в `designSystemMetaVersion` вывода, фиксируй её в REPORT). Честные ограничения: `--theme` — только light/dark, версия темы **не пинуется**; viewport 64..2000 × 64..4000 и `width × height × dsf² ≤ 20 000 000` — при `--dsf 3` потолок вьюпорта ~2,2 Mpx, для @2x-сверки бери `--dsf 2`; очередь скриншотов сервера — concurrency 1, cap 5 → возможен `429 queue_full`, драйвер ретраит сам (счётчик `queueRetries` в `--json`).

Probe-прототип остаётся **со стадии молекул** и для контекстных экранов (`ypv2-probe-molecules`, `ypv2-probe-organisms`, `ypv2-ref-*`), **по экрану на компонент**. Экран — стикершит вариантов, повторяющий раскладку Figma-эталона: `canvas` = размер экспортированного фрейма (допустимый диапазон 64–2000 × 64–4000), фон = фон фрейма, варианты разложены `pay-box`-ами с теми же координатами/gap. Шаблон — `templates/probe.json` (props в нём иллюстративные — сверяй со своей фактической схемой, незнакомый ключ = 422). Контракты host-типов (`Image`/`Hotspot`/`Overlay`/`@eui/FlowRoot`) — `reference/host-catalog.json`.

```bash
node driver.mjs prototype ypv2-probe-molecules.json
node driver.mjs status ypv2-probe-molecules --all-screens
node driver.mjs geometry ypv2-probe-molecules pay-payment-method-card
node driver.mjs snap ypv2-probe-molecules ./shots --all-screens
```

**Probe-док объявляй служебным и трекающим головы — тогда пересохранения после каждой публикации компонента не нужны** (W3). `kind` и `track` — lifecycle-атрибуты прототипа (колонки, не поля документа), ставятся одним роутом сразу после создания дока:

```bash
echo '{"kind":"component-gallery","track":"head"}' > lifecycle.json
node api.mjs send POST /prototypes/ypv2-probe-molecules/lifecycle lifecycle.json
```

- `track: "head"` разрешён только для служебных `kind` (`component-gallery`, `evidence`, `visual-reference`, `composition-fixture`) и только пока прототип не опубликован: иначе `422 track_requires_service_kind` / `track_requires_unpublished`. Для трекающего дока запрещены publish, share-грант, visual-baseline и bundle-export (`422 prototype_head_tracking`) — это цена за подвижные пины; probe-доки всё равно живут драфтами.
- Скоуп резолва — **только компонентные пины**: DTO ревизии отдаёт последние active-публикации и `resolvedAt`, постановка снапа возвращает разрешённые пины в `components[]` (сверяй их с ожидаемыми версиями). **Версия темы остаётся пином ревизии** — после PATCH темы probe пересохранять всё равно нужно (§3.2, `stalePins`).
- Галерея — это `kind: "component-gallery"`, выставленный тем же lifecycle-роутом, а не поле документа: формат документа не менялся.
- **Warnings служебной галереи — не блокер.** У служебных `kind` readiness-отчёт идёт с `profile: "service"`: предупреждения (недостижимый экран, интерактивный компонент без handler) не поднимают статус и не блокируют. Не изобретай технические `Hotspot`'ы и `on`-биндинги ради нулевого warning-счётчика.

Без `track: head` (обычный `pinned`-док, любой `kind`) правило прежнее: **ревизия пинует конкретные версии компонентов и версию темы, publish новой версии пины не двигает**, цикл итерации молекулы — publish компонента → `driver.mjs prototype ypv2-probe-<level>.json` (пере-пин) → `status` → `geometry` → `snap`. Пропустишь пересохранение — будешь гоняться за «диффом», которого уже нет в исходнике.

### 4.7 Сверка

Порядок жёсткий: **числовая приёмка до пиксельной**. Пиксельный дифф говорит «0,4% не совпало», числовая — «gap expected 8, got 6», то есть сразу называет правку.

1. **Численно — `expect`**: замер geometry против выписки §4.1, допуск ±1px.

```bash
# actual: замер компонентной поверхности прямо на draft-ревизии (PNG не создаётся)
node driver.mjs preview pay-button --rev head-draft --example primary --probe geometry --out actual.json
# actual для молекулы/экрана: прототипный geometry-probe
node driver.mjs geometry ypv2-probe-molecules pay-payment-method-card --json > actual.json
node driver.mjs expect expected/pay-button.json actual.json
# expect expected/pay-button.json vs actual.json: 5 checks, 1 mismatch (tolerance ±1px)
# ok   stack#0: width expected 328, got 328
# FAIL stack#0: gap expected 8, got 6
```

`expected.json` пишешь ты из выписки Figma. Формат минимальный:

```json
{
  "tolerance": 1,
  "elements": [
    { "key": "c",     "size": { "width": 328, "height": 56 } },
    { "key": "stack", "instance": 0, "axis": "row", "gap": 8,
      "padding": { "left": 16, "right": 16, "top": 12, "bottom": 12 }, "tolerance": 2 }
  ]
}
```

- `key`/`instance` — ключ маркера в замере (`instance` по умолчанию 0). У компонентной поверхности маркер ровно один — корневой элемент дерева съёмки с ключом `c`, поэтому для атома проверяется `size` (PNG и так content-hug); `gap`/`padding` меряются там, где маркеров несколько, — на probe-экране.
- `size` — `{width?, height?}`, любое из полей опционально.
- `gap` — число (все зазоры между соседними видимыми детьми равны ему) либо массив ожиданий по порядку. Ось берётся из `axis`, иначе из computed `flexDirection` layout owner'а, иначе выводится из самих rect'ов. Меряется **наблюдаемый зазор** между box'ами детей — он может отличаться от CSS gap на величину margin'ов.
- `padding` — число (все четыре стороны) либо объект сторон; это наблюдаемый отступ между box'ом элемента и bounding box'ом его прямых детей.
- `tolerance` — файловый дефолт (1 px), перекрывается per-element; `--tolerance N` перекрывает файловый дефолт, но не per-element.
- Выход: 0 — всё сошлось, 2 — есть расхождения (каждое строкой `FAIL`), 1 — битый файл/формат. Верб оффлайновый, сети не касается.

2. **Пиксельно**: `node compare.mjs figma-refs/pay-button@2x.png shots/pay-button.png diff/pay-button.png` — pixelmatch, порог чувствительности 0.1. Отчёт кроме процента печатает:
   - **кластеры расхождений** — bounding-box'ы связных областей (`cluster 12x3 px @ (208,41) — 36 px differ`): координата и форма кластера говорят, что именно уехало (полоса по краю блока = геометрия, россыпь по буквам = шрифт);
   - **AA-diagnostic** — второй прогон с порогом 0,25 в том же отчёте: сколько расхождения остаётся, если списать антиалиасинг. Если основной процент большой, а AA-диагностический ≈ 0 — это шрифтовой рендер, а не дефект;
   - **отчёт о размерах** при их несовпадении (`size mismatch: candidate 328x56 vs ref 328x58 (dw 0, dh -2)`) — дифф всё равно считается по пересечению (exit 3), а не прерывается без диагностики;
   - `--region x,y,w,h[:maxDiff%]` (повторяемый) — процент по зоне и необязательный бюджет: превышение → exit 1. Так фиксируются локальные исключения (например зона текста) без ослабления общего порога.
   - `--json` отдаёт то же машинно; `--clusters N` меняет число печатаемых кластеров (по умолчанию 10). Raw-эталон никогда не мутируется — записывается только `diff.png`. Снап атома под @2x-эталон — `node driver.mjs preview pay-button --example <вариант> --dsf 2` (content-hug: размер PNG = элемент × dsf); снап probe-экрана — `node driver.mjs snap … --dsf 2` (поверхность = `canvas` экрана). Размеры PNG обязаны совпадать. Для probe-стикершитов бюджет: `surface × dsf² ≤ 16 Mpx` (проверяется до постановки) — очень длинный стикершит при `--dsf 2` дели на несколько экранов. Целевой mismatch ≤ 2% площади, и **весь** остаток объясним антиалиасингом текста (chromium ≠ Figma по субпиксельному рендеру — это единственная легальная разница). Любое расхождение геометрии, цвета заливки, радиуса, тени, межстрочника — дефект: чини компонент/тему и повторяй.
3. **Глазами**: открой diff.png и пару эталон/снап рядом. Кластеры диффа по краям блоков = геометрия, по буквам = шрифт (проверь, что снялся YS Text, а не fallback: ширины строк в geometry совпадают с Figma; если нет — шрифт не доехал, пере-snap или проверь fonts темы).

### 4.8 Семья вариантов: серверная матричная приёмка (`case-set` + `accept`)

Ручной цикл §4.6–4.7 закрывает один кадр. Figma-компонент с несколькими осями вариантов (`family × state × size`) — это **матрица**, и её приёмку считает сервер: `case-set` описывает набор случаев с эталонами, `accept` снимает их все и выносит вердикт по гейтам (`render`, `readiness`, `geometry`, `visual`, `determinism`). Самописных matrix-скриптов писать не нужно.

```bash
node api.mjs upload figma-refs/pay-card-product-default@2x.png   # эталон каждой ячейки → asset_<sha256>
node driver.mjs case-set put pay-payment-card matrix.json        # → caseSetId + coverage
node driver.mjs case-set coverage cset_…                         # какие ячейки матрицы не закрыты
node driver.mjs accept pay-payment-card --case-set cset_…        # кандидат → ран → poll → вердикт
node driver.mjs accept-status acc_… --evidence run.zip           # вердикт + evidence-архив
```

Манифест (`matrix.json`) — точный перенос Figma-матрицы: `dimensions` (оси и их значения), `cases[]` (`id`, `props`, `dims`, `referenceAssetId`, `expectedGeometry`, `cropLineage.rect` — если эталон вырезается из общего фрейма component set), `capture` (`viewport`/`deviceScaleFactor`/`theme` съёмки набора), `policy` (`profile: "pixel-strict-v1"` для pixel-perfect-пересборки + `perCase.<id>.maxRawDiffPct` для осознанных исключений). Правила, на которых спотыкаются:

- `case.id` — `^[A-Za-z0-9._-]{1,64}$`: **Figma node id `54863:9537` не пройдёт**, санитизируй (`54863-9537`).
- Эталон — id ассета реестра, а не байты; несуществующий → `422 asset_not_found`. Два случая с одинаковыми props → `422 duplicate_case_props`; осознанный дубликат помечается `aliasOf` (снимается один кадр).
- `caseSetId` контентный (`cset_<sha256>` манифеста): та же публикация идемпотентна, изменённая — **новый** набор, старые раны остаются воспроизводимыми.
- Профили порогов: `pixel-strict-v1` — `maxRawDiffPct` 0.5 %, расхождение габаритов после crop > 4 px даёт `indeterminate` (метрик нет вовсе, а не выдуманный процент); `default-v1` — 2 % и 8 px, визуальный гейт там необязателен, если в манифесте нет `requireVisual: true`.

Что читать в вердикте (то же приезжает в `--json` и в evidence-архиве):

- **`readiness`** — обязательный гейт: `met:false` (шрифт/иконка/ассет не доехали до кадра) означает, что сравнивающие гейты случая честно отдали `indeterminate`. Чинить ресурс (тема, реестр ассетов), а не компонент; `pendingRequests` в `detail` называет виновника. Наблюдённые `themeResources` кадра — вход импакт-анализа (см. ниже).
- **`geometry`** меряет краску, а не только коробки: `layoutBounds` (union in-flow потомков), `paintBounds` (ink-bbox по альфе), `effectSources[]` (кто красит за коробкой — `filter`/`box-shadow`/`outline`/`transform`/`position:absolute|fixed`), `clipChain[]`. Вердикт `clean | paint-overflow-clipped | paint-overflow-not-clipped | layout-overflow | indeterminate`; `fail` невозможен без названного источника. Ожидаемые тень/свечение и обрезка объявляются допусками случая (`allowPaintOverflow`, `expectedClip`, `expectedGeometry`) — это и есть замена «на глаз, тень вроде так и должна торчать».
- **`visual`** — `rawDiffPct` (вердикт), `aaDiffPct` (структурный остаток), `bestOffset {dx,dy,residualPct}` («съехало на N px» ≠ «перерисовано»), `regions[]`. Провал/`indeterminate` несёт `causes[]`: `surface-tint`, `edge-radius-stroke`, `geometry-shift`, `text-raster-residual`, `missing-late-asset`, `alpha-compositing`, `effect-overflow`, `descendant-outside-mask`, `unclassified`.
- **`remediationGroups`** терминального рана — случаи, сгруппированные по общей причине (виновник `elementKey` либо сигнатура области + `variantFamily` — пересечение `dims`). Одна сломанная иконка в 20 состояниях = **одна** группа с одним `suggestion`: чини по группам, а не по случаям.

Пересъёмка после правки не обязана стоить полной матрицы: `--refresh failed|<id,id2>` перебивает всё вручную, а `--baseline-run acc_…` включает импакт-анализ — `impact <id> --candidate cand_… --baseline-run acc_…` заранее печатает базис (`asset-only` — сменился только ассет, переснимаются случаи с этим ассетом в `themeResources`; `theme-only` — сменилась версия темы, переснимаются применившие изменившиеся токены/иконки, смена шрифта = все; `conservative` — снимается всё, `reason` называет причину). Случай без readiness-evidence всегда считается затронутым.

Приёмка привязывается к публикации: `promote` принимает `candidateId`/`acceptanceRunId` (тело запроса) — ран обязан быть терминальным `pass`/`pass_with_exceptions` **этого же** кандидата, иначе `422 acceptance_run_mismatch`/`acceptance_run_not_passed`; при живом ране — `409 acceptance_run_in_flight` (второй ран не ставить, добирать `accept-status`). Exit `accept`: 0 — `pass`/`pass_with_exceptions`, 2 — `fail`/`error`/`cancelled` и клиентский таймаут (`--timeout-sec`, дефолт 1800; ран продолжается на сервере). Evidence по умолчанию не качается — печатается адрес архива; `--evidence run.zip` сохраняет его (`manifest.json` + `SHA256SUMS` + `paint.png`/`diff.png`/`geometry.json`/`visual.json`/`readiness.json` по случаям), распаковывать только с проверкой имён записей (абсолютные пути и `..` отвергать).

`compare.mjs` остаётся для одиночных сверок и разбора конкретного кадра; для семьи вариантов авторитет — серверный ран (он же единственный воспроизводимый: отпечаток случая включает рендерер, тему, политику readiness и допуски).

### 4.9 Фиксация

В `BUILD_ORDER.md` статус `done` + строка в `REPORT.md`: `pay-button v1 | figma 123:456 | diff 0.8% | probe ypv2-probe-atoms/pay-button`. Только после этого — следующий компонент.

## 5. Приёмка компонента (обязательный чек-лист)

- [ ] выписка §4.1 существует, каждый вариант Figma представлен пропом и примером;
- [ ] reuse-гейт пройден (search до создания; 409 не обходился);
- [ ] каждый `.default()` схемы имеет парный `??` в рендере; `{}` (пустые props) рендерится дефолтным видом Figma;
- [ ] цвета/тени — через `color()` с точным Figma-литералом в fallback; spacing — `space()`/union;
- [ ] атом принят через `preview --rev head-draft` + `expect` (draft rev N, bundleHash/designSystemMetaVersion из вывода зафиксированы в REPORT) **до** первой публикации; validate-префлайт головы зелёный; publish — один раз по итогам приёмки; для молекул и выше — probe с `track: head` (или пересохранён после последней публикации компонента) и обязательно пересохранён после последнего PATCH темы (пины видно в выводе `driver.mjs prototype` и в `components[]` постановки снапа);
- [ ] `expect`: размеры/gap/паддинги ±1px от Figma (0 mismatches); compare: mismatch ≤2%, остаток — только текстовый антиалиасинг (подтверждается AA-diagnostic), кластеры расхождений объяснены;
- [ ] компонент с несколькими вариантами: опубликован `case-set` по Figma-матрице (эталон и `dims` на каждую ячейку, `coverage` без `missingTuples`) и есть терминальный `accept`-ран `pass`/`pass_with_exceptions` по нему; `indeterminate`-случаи разобраны (readiness/габариты), а не списаны; runId и `caseSetId` — в `REPORT.md`, и они же переданы в `promote` (`candidateId`/`acceptanceRunId`);
- [ ] интерактив: typed events объявлены и `emit` работает (проверь в плеере `?debug=1`);
- [ ] definition: честный `atomicLevel`, продуктовый `description`, `examples`, при согласованной роли — `canonicalFor`;
- [ ] Figma-provenance прикреплён (`--figma` при каждом вызове `component`), эталонные PNG в реестре ассетов;
- [ ] запись в `BUILD_ORDER.md`/`REPORT.md`.

## 6. Phase 2 — молекулы и организмы

Тот же цикл §4 с дополнениями. Граница «composition vs TSX» выучена дорого (прод-дедупликация 2026-08: 295 кандидатов, 42 в головах) — соблюдай её с рождения каждого компонента:

- **Composition не умеет владеть CSS.** Её элементы — только host-примитивы и опубликованные компоненты; она — декларативное дерево без собственных стилей. Значит компонент, владеющий хотя бы одним из: скролл-вьюпорт/маска/snap, `position: fixed/sticky`, safe-area, анимация/transition/transform, состояние (`useState`/`useEffect`/`useRef`), измерение DOM, скелетон-анатомия загрузки — это **TSX**. Контент-блок, разложимый готовыми атомами, — **composition**. Спорный случай `overflow: hidden` ради скругления — НЕ владение геометрией: `pay-box` обязан уметь радиус и клип, такой блок — composition.
- **Границу считает сервер, не интуиция**: `node api.mjs send POST /compositions/analyze body.json` c `{doc, designSystem}` отдаёт вердикт `composition` | `extend-component` | `needs-ownership-component`, список `unsupported[]` (`timer`, `async-data`, `scroll`, `dom-measurement`, `custom-action`, `business-state`, `dynamic-directive`, лимиты) и `dependencyImpact`. Ручка read-only и не зависит от kill-switch'а записи — спрашивай её до того, как писать TSX «на всякий случай». Тот же вердикт с указанием готового артефакта даёт workbench: `POST /catalog/candidates` c `proposed.kind:"composition"` и черновым `compositionDoc` → `outcome`/`explanation`/`matches` (для композиций исход рекомендательный, `409` не бывает).
- **Composition v3** (включена на проде) снимает старые ограничения: типизованные параметры (`enum`/`object`/`array`/`action`), `element.when` — необязательные ветки, `{"$switch":{param,cases,default}}` в значении пропа, **`repeatParam`** — клонирование поддерева по элементам `array`-параметра (`{"$item":"field"}`/`{"$index":true}` внутри), слоты с метаданными (`required`/`allowedTypes`/`allowedRoles`/`cardinality`/`fallback`), токенный `layout` (закрытые фасеты `flow`/`gap`/`padding`/`align`/`justify`/`sizing`/`radius`/`clip`/`background` → пропы layout-контракта v1) и `variants` (оси + легальные кортежи, выбор через `props.variant`). Списочный блок больше **не** обязан выражаться фиксированной арностью параметров: `array`-параметр + `repeatParam` — штатная форма, а `repeat` по `doc.state` хоста остаётся отдельным механизмом для настоящего рантайм-списка. Всё v3-ветвление статическое: раскрывается на сохранении прототипа, в сохранённом документе не остаётся ни `when`, ни `$switch`, ни `$param`; рантайм-условия — по-прежнему только `$cond` над `doc.state`.
- Перед записью v3-композиции прогоняй раскрытие: `POST /compositions/:id/preview-tree` c `{params?, variant?}` показывает взятые ветки, выбранные `$switch`-case'ы, число клонов `repeatParam`, привязки слотов, во что скомпилировался `layout`, `expandedTree` и `issues[]` — это тот же экспандер, что в save-пути, а не его копия.
- `@eui/Composition` не принимает `repeat` и `region`; глубина вложенности композиций ≤5; раскрытое дерево экрана — те же 500 элементов и глубина 50.
- Новый TSX уровня molecule/organism обязан нести `ownership: { reason: "<чем он владеет: скролл/sticky/анимация/состояние — почему это не composition>" }` — без него publish падает с `422 atomic_policy_violation`, а с пустой отпиской компонент позже механически попадёт в dedup-аудит как composition-candidate и породит дорогой триаж. Пиши конкретное владение сразу.
- Дети-инстансы в Figma → named slots или композиция в документе; **не** перерисовывай готовый атом внутри молекулы заново.
- Сверка стикершитом — как у атомов; для организмов добавь probe-экран «в контексте» (организм на реальном фоне экрана из Figma).

## 7. Phase 3 — эталонные экраны (acceptance всей системы)

Возьми 2–3 полных пользовательских флоу из Figma (например: чекаут, выбор способа оплаты, успех) и собери их как настоящие кликабельные прототипы `ypv2-ref-<flow>`:

- эталонный экран — **flow-экран без `canvas`** (canvas и `region:` несовместимы — валидация отвергнет): фиксированные области — через `@eui/FlowRoot` + `region: "statusBar"|"header"|"footer"`, snap выйдет каноническим вьюпортом устройства (mobile 390×844) — Figma-фрейм для сверки экспортируй/кропь ровно под этот размер;
- **контракт регионов**: `region` — только на прямых детях root'а типа `@eui/FlowRoot`, не более одного элемента на kind; `region` несовместим с `repeat` и `slot` на самом элементе, запрещён на `Overlay`/`Hotspot`, `Hotspot` внутри region-поддерева нельзя. FlowRoot нейтрален и **ничего не даёт детям** (ни padding, ни цвет, ни шрифт) — каждый бар стилизуется целиком внутри собственного поддерева (self-contained). Следствие для авторинга компонентов: header/footer/tab-bar-компоненты **не делают `position: fixed/sticky` сами** — якорение к вьюпорту принадлежит region-механизму, компонент рисует только содержимое бара;
- **имитацию OS-статус-бара не вшивать в контент**: только атом статус-бара под `region: "statusBar"` — в мобильной презентации он автоматически скрывается (реальный телефон показывает свой), в плеере у зрителя есть тумблер. Вшитый в контент статус-бар будет двоиться на устройстве;
- интерактив по-настоящему: `state`/`$cond`/`repeat`, переходы `navigate`, `flows[]` с главной линией;
- snap каждого экрана против экспорта соответствующего Figma-фрейма через `compare.mjs` — тот же порог; **capture рендерит регионы inline** и складывает контент+футер в один длинный PNG (низ футера может уйти за фолд — артефакт снимка), тогда как плеер и презентация пиннят header/footer к краям телефонного фрейма 390×844, а контент скроллят между ними. Финальную приёмку пиннед-поведения и скролла делай глазами в плеере (`/p/<id>`, `?debug=1`) — десктопный плеер держит фрейм канонического размера даже для длинных canvas-экранов (контент скроллится «внутри телефона»), так что длинный экран — не дефект;
- расхождение на экране, которого не было на стикершите = дефект интеграции (обычно рост/сжатие контейнера) — чинить компонент, не подпирать документ.

Probe- и ref-прототипы живут **драфтами** — snap/geometry/status читают драфт, `publish` прототипа нужен только если человеку нужна стабильная версия-ссылка.

Система готова, когда: все строки `BUILD_ORDER.md` в `done`, эталонные экраны проходят сверку, `node driver.mjs audit --design-system yandex-pay-v2` не находит deprecated-компонентов в использовании, а ручной проход по `catalog list yandex-pay-v2 --json` подтверждает описания/примеры у каждого компонента; `REPORT.md` содержит полную таблицу соответствия Figma → компонент → diff%.

## 8. Грабли (выучены на старой системе — не повторять)

- **Renderer не применяет Zod-дефолты** — см. правило 5. Симптомы: краш на `.map`, NaN-геометрия, неверная ветка варианта при валидном документе.
- **Рост контейнеров**: flex-ребёнок с `flex:1` по умолчанию раздувает ряды на свободную высоту. `PayBox` — hug по умолчанию; проверяй `geometry` (высота ряда = высоте контента).
- **Faux-bold**: вес, которого нет среди загруженных начертаний, браузер синтезирует — жирнее и шире Figma. Только реальные веса.
- **Шрифт-fallback на снапе**: если PNG снят до загрузки YS Text, все ширины врут. Признак — текстовые ширины в geometry ≠ Figma при верных паддингах. На приёмке (§4.8) это ловит гейт `readiness` (`met:false`, `reason`), и такой кадр вообще не получает визуального вердикта — не читай его `indeterminate` как «компонент сломан».
- **`renderer_mismatch` на джобе съёмки** — фактический браузер образа разошёлся с объявленным манифестом рендерера: кадра нет, клиентский ретрай бесполезен, это вопрос к владельцу инстанса. И наоборот: апгрейд браузера меняет `renderer.fingerprint` и честно обнуляет reuse снятых случаев — после него матрицы переснимаются целиком, это не баг.
- **Union-spacing**: если проп принимает и токен, и число px — сохраняй числовой литерал в схеме как есть (пере-вывод типа ломает re-pin существующих документов).
- **Тема append-only после принятия**: правка значения токена задним числом молча меняет все готовые компоненты — пере-проверяй их снапы; и помни, что ревизии прототипов пинуют версию темы — сначала пересохранить probe, потом snap (§3.2).
- **`state` прототипа** — обычный вложенный объект, ключи без слэша; пойнтеры директив — абсолютные (`/method`). Warnings при save = неработающая директива, не игнорировать.
- **Snap с FlowRoot-футером** может срезать низ на capture-поверхности — это артефакт снимка, в плеере регионы пинятся корректно; сверяй такие зоны интерактивно (`?debug=1`) или скриншотом плеера.
- **Login rate-limit 429** — в норме не случается (кэш сессии на диске, §1); если случился — проверь `EASYUI_SESSION_CACHE`, подожди минуту.
- **CAS 409 (`revision_conflict`)** при прерванной сессии — повторить вызов драйвера (перечитает `headRev`).
- Тестовый мусор удалять (`driver.mjs delete prototypes <id>`); probe- и ref-прототипы — не мусор, они живут как визуальный контракт системы.
