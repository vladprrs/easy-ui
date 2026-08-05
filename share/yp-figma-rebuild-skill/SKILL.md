---
name: yp-figma-rebuild
description: Rebuild the Yandex Pay design system in easy-ui from scratch, atom by atom, pixel-perfect against the Figma source of truth — extract tokens and components via Figma MCP, publish them into a fresh design system over the easy-ui HTTP API, and verify every component with server screenshots diffed against Figma reference exports. Use when asked to recreate or build the Yandex Pay component system from Figma.
---

# Пересборка Yandex Pay: Figma → easy-ui, pixel perfect, атом за атомом

Ты — агент с двумя инструментами: **Figma MCP** (библиотека Yandex Pay — источник истины) и **HTTP API easy-ui** (харнес `driver.mjs` + `api.mjs` из этого пакета). Существующая система `yandex-pay` собиралась без доступа к Figma и расходится с оригиналом. Задача — построить систему **заново, с нуля**: каждый токен, атом, молекула и организм снимаются с Figma и публикуются в **новую** дизайн-систему `yandex-pay-v2`.

Это марафон по уровням (токены → атомы → молекулы → организмы → экраны). Прогресс фиксируется в `BUILD_ORDER.md`/`REPORT.md` — сессию можно прервать и продолжить.

Этот файл — рабочий скелет. Детальная механика лежит в `reference/` и читается **по мере надобности** (§9, карта) — не загружай всё разом.

## 0. Незыблемые правила

1. **Прогресс живёт в продукте, а не в локальных файлах.** easy-ui — твой верстак, а не только релизная цель: итерации идут серверными драфтами (save → `preview --rev head-draft`), а не «соберу всё локально и залью потом». Компонент публикуется **сразу**, как только приёмка сошлась; полировка сверх порогов — новыми версиями, а не задержкой публикации. Каждая рабочая сессия обязана оставить видимый след в easy-ui: новые публикации, версию темы, обновлённые probe-галереи. Локальные заметки и PNG без опубликованного результата прогрессом **не считаются**.
2. **Старую систему `yandex-pay` не трогать.** Не публиковать в неё, не менять тему, не архивировать, не переиспользовать `Yp*`-имена. Читать — только как справку по механике easy-ui, никогда как источник визуальных значений.
3. **Figma — единственный источник значений.** Каждый цвет, отступ, радиус, вес, тень — из Figma (variables, inspect), не «на глаз», не из памяти, не из старой системы. Каждое значение в TSX прослеживаемо до Figma-ноды.
4. **Атом за атомом.** Молекула не начинается, пока не опубликованы все её атомы. Если атом не сходится по пикселям после ~3 полировочных итераций — публикуй лучшее состояние, фиксируй остаток диффа в `REPORT.md` как known-gap и иди дальше; возвращение — новой версией.
5. **Повторяющиеся стилевые значения — через токены темы** (`color()` / `space()` из `easy-ui/runtime/v4`). Сырой литерал — только как fallback внутри `color(...)` и для метрик конкретного компонента.
6. **Renderer НЕ применяет Zod-дефолты.** Каждый `.default(X)` схемы дублируется `?? X` в рендере; массивы — `?? []`; lookup — с fallback-веткой. Причина №1 поломок старой системы.
7. **Никакого base64.** Иллюстрации, иконки, шрифты — только через реестр ассетов (`api.mjs upload` → `asset_<sha256>`).
8. **Каждый компонент несёт Figma-provenance**: `fileKey` + `nodeIds` + эталонные скриншоты. Без provenance компонент не готов.
9. **`409 component_reuse_required | canonical_role_conflict | catalog_changed` — терминальный STOP**: не ретраить, не переименовывать ради обхода, `--force-new` — только человек-админ.

## 1. Setup

Пакет самодостаточен, репозиторий easy-ui не нужен. Node ≥ 18. Для пиксельного диффа один раз: `npm i pixelmatch pngjs` (в каталоге пакета).

```bash
export EASYUI_USERNAME="…"    # named-аккаунт (нужны права на создание дизайн-системы)
export EASYUI_PASSWORD="…"
# дефолтный инстанс — https://easy-ui.pay-offline.ru; другой: export EASYUI_API="http://127.0.0.1:8787/api"

node driver.mjs get prototypes          # smoke: API и креды живы
node api.mjs get /capabilities          # actions, features, лимиты, фаза reuse-гейта
```

Цикл опирается на серверные `features` (preflight, draft-preview, geometry, acceptance-матрица, promote, head-tracking…) и числовые `limits` — читай их из `/capabilities` этого инстанса, не из памяти; на старом инстансе драйвер падает читаемым «server does not support …». Полный разбор features/лимитов, кэша драйвера (`--cache-dir`, `cache.status`, семантика «not found») и кэша логина — **`reference/server-features.md`**.

Два харнеса:

- **`driver.mjs`** — основной CLI: каталог, компоненты, прототипы, снапы, публикация, приёмка. Полный справочник по механике easy-ui (грамматика документа, директивы, версии, troubleshooting) — **`reference/easy-ui-authoring.md`**; открывай его секциями по мере надобности, не целиком.
- **`api.mjs`** — то, чего нет в driver: `get <path>`, `send <METHOD> <path> <body.json>`, `upload <file>`, `theme <dsId> <theme.json>` (PATCH темы с авто-CAS).

**Один аккаунт на всю работу** (тему меняет владелец системы, скриншоты — владелец прототипа). Slug свободен? — `node api.mjs get /design-systems/yandex-pay-v2` → `404` = свободен.

Смоук Figma MCP: прочитай структуру/стили нод и экспортируй PNG ноды. Без обоих не начинай.

## 2. Именование и площадка

```bash
node driver.mjs design-system yandex-pay-v2 "Yandex Pay v2" "Pixel-perfect rebuild of the Yandex Pay design system from Figma"
```

- **Имена компонентов глобально уникальны across дизайн-систем** — `Yp*`/`yp-*` заняты. Канон новой: id `pay-<kebab>`, имя `Pay<Pascal>` (`pay-button` / `PayButton`).
- Probe-прототипы: `ypv2-probe-<level>` (`ypv2-probe-atoms`, `ypv2-probe-molecules`, …), эталонные экраны: `ypv2-ref-<flow>`. `doc.id` глобальны — не занимать чужие.

## 3. Phase 0 — разведка и фундамент

Результат фазы **виден в продукте**: тема v1 опубликована, `pay-box` + `pay-text` опубликованы, галерея `ypv2-probe-atoms` создана; локально — `BUILD_ORDER.md`.

### 3.1 Инвентаризация Figma

1. Обойди библиотеку: страницы → фреймы → published components; для каждого — `nodeId`, имя, варианты, зависимости (instances внутри).
2. Собери **`BUILD_ORDER.md`**: `порядок | figma-компонент | nodeId | уровень | зависимости | целевой id (pay-*) | статус`. Компонент идёт только после всех зависимостей; первым — `pay-box` (§3.4).
3. Экспортируй variables/стили: цвета (все режимы, минимум light), типографика, spacing/radius, тени.

### 3.2 Тема: tokens + fonts + icons

Тема — версионируемые коллекции `{tokens, fonts, icons}`; токены доезжают как CSS-переменные, шрифты — как `@font-face`. Жёсткие правила грамматики (`space.*` — ровно девятка строк в px, иначе молчаливый откат шкалы; allowlist значений `color.*`; sparse-патчи `addTokens` с `dryRun`; `stalePins` в ответе) — **`reference/theme.md`**, прочитай его перед первым PATCH.

```bash
node api.mjs upload YS-Text-Medium.woff2        # шрифты: сначала проверь fonts[] старой DS — ассеты глобальны, переиспользуй id
node api.mjs theme yandex-pay-v2 theme.json     # версия 1 (baseVersion подставится сам)
```

**Ревизия прототипа пинует версию темы**: после любого PATCH темы пересохрани каждый probe/ref-прототип из `stalePins` до пере-снапа. `preview` атома тему не пинует — всегда последняя.

### 3.3 Верификация темы

`node driver.mjs catalog list yandex-pay-v2 --json` → `resolvedSpaceScale` совпадает с задуманной девяткой (каноническая `0/4/8/…`, которую ты не задавал, = тема нарушила правила и откатилась — чинить). После `pay-box`/`pay-text` — probe-«свотч» и пиксельная проверка цветов против hex из Figma.

### 3.4 Служебный layout-атом — первым

Первый компонент — **`pay-box` / `PayBox`**: flex-стек, моделирующий autolayout Figma: `mode: "row"|"col"`, `gap`/`padding(X|Y)` (токен шкалы **или** число px), `align`/`justify`, `width`/`height: "hug"|"fill"|<число>`, `background`, `radius`. **Hug по умолчанию** (не повторяй `flex:1`-ошибку старой системы). В definition — `layout: { version: 1, spacing: ["gap","padding","paddingX","paddingY"] }` (читает geometry-probe). `layoutNeutral: true` — только если готов к его жёсткому конформанс-гейту; проще не ставить.

## 4. Phase 1 — цикл атома (основной рабочий цикл)

Для каждого компонента из `BUILD_ORDER.md`, строго по порядку. Ритм: **черновая итерация — на серверных драфтах, публикация — сразу после приёмки, витрина — в галерее.**

### 4.1 Выписка из Figma

Возьми ноду (и каждый вариант), выпиши **все** значения: размеры, autolayout (направление, gap, паддинги, hug/fill), fills/strokes с привязкой к variable, радиусы, тени, типографику, состояния. Экспортируй эталонный PNG каждого варианта, предпочтительно @2x (сверка тогда против `--dsf 2`; масштабы эталона и снапа обязаны совпадать). Выписка — в `notes/<pay-id>.md`, она же чек-лист сверки.

### 4.2 Reuse-гейт

```bash
node driver.mjs catalog search yandex-pay-v2 --intent "<продуктовая задача компонента>" --json
```

Скоуп гейта — внутри одной DS: старые `Yp*` не заблокируют `pay-*`, но по мере наполнения `yandex-pay-v2` гейт реален для твоих же компонентов. Вариант Figma-компонента (size/tone/state) — **проп существующего** `pay-*`, не новый id; кандидат почти покрывает — расширь non-breaking ревизией; экран/секция из готовых компонентов — composition (§6). `409` — STOP (правило 9).

### 4.3 Схема

- Component properties → zod strict: варианты → `z.enum`, булевы → `z.boolean()`, текст → `z.string()`, instance-swap → enum либо named slot. Имена пропов — camelCase от имён свойств Figma; дефолт пропа = дефолтный вариант в Figma.
- Интерактивные компоненты обязаны объявлять **typed events** (`events: { press: z.strictObject({}) }`) + `interactive: true` + `accessibleLabelProps`.
- Контейнерные — `slots` (имена — **kebab-slug**; named slots требуют `capabilities: { namedSlots: true } as const`; объявленный слот обязан рендериться) и/или `children`.
- `canonicalFor` — **не ставить** без согласования с владельцем инстанса (`reference/canonical-roles.md`).

### 4.4 Рендер

Шаблон — `templates/atom.tsx`. Требования:

- Импорты значений — только из `easy-ui/runtime/v4` (`token`, `space`, `color`, `Icon`); ровно один value-специфаер на модуль; `EasyUIComponentProps` — type-only из `easy-ui/runtime`.
- Каждый цвет/тень/градиент — `color("<ключ>", "<точный литерал из Figma>")`; каждый `.default()` → парный `??`; массивы → `?? []`; lookup → fallback-ветка; арифметика без NaN.
- `fontWeight` — только реально загруженные начертания (иначе faux-bold и пиксели уедут).
- `examples` обязательны: default + по одному на существенный вариант (это варианты `preview --example`, стикершит и превью в Library).

### 4.5 Публикация + provenance

```bash
node api.mjs upload figma-refs/pay-button-primary.png     # эталонные PNG → asset_<sha256>
cat > pay-button.figma.json <<'EOF'
{ "fileKey": "<из URL Figma>", "nodeIds": ["123:456"],
  "referenceScreenshots": ["asset_<sha256>"], "lastSyncedAt": "<ISO now>" }
EOF
node driver.mjs component pay-button PayButton pay-button.tsx \
  --design-system yandex-pay-v2 --intent "Primary action button for payment flows" \
  --figma pay-button.figma.json
```

Provenance наследуется между ревизиями; смена/очистка — верб `driver.mjs provenance <id> <figma.json|null>`. Перед публикацией — validate-префлайт головы (полный publish-набор проверок без версии): `node api.mjs send POST /components/pay-button/validate`. Повторный PUT с идентичным содержимым → `{"unchanged":true}` — норма. Правишь опубликованный после разрыва сессии — базой бери active-source с сервера, не локальный файл.

### 4.6 Приёмка атома: драфт-цикл `preview`

Итерация атома идёт на сохранённой голове без публикации:

```bash
# save ревизии без публикации (verb component — только для создания и финального publish):
node api.mjs get /components/pay-button                     # headRev → baseRev для CAS
jq -n --arg src "$(cat pay-button.tsx)" --argjson figma "$(cat pay-button.figma.json)" \
  '{source:$src, figma:$figma, baseRev:<headRev>, message:"iterate"}' > save.json
node api.mjs send PUT /components/pay-button save.json      # → {"rev": N+1}

node driver.mjs preview pay-button --rev head-draft --example primary --dsf 2 --out shots/pay-button.png
node driver.mjs preview pay-button --rev head-draft --example primary --probe geometry --out actual.json
node driver.mjs expect expected/pay-button.json actual.json          # числовой вердикт (§4.7)
node compare.mjs figma-refs/pay-button@2x.png shots/pay-button.png diff/pay-button.png
# сошлось → префлайт → publish (verb component) → promote; вариантов >1 → accept по семье (§4.8) до promote
```

PNG — content-hug (снимается сам элемент): размеры эталона и снапа сравниваются напрямую. Лимиты preview (viewport/dsf/очередь), механика драфт-съёмки через candidate-bundle и honest-ограничения — **`reference/verification.md`**.

**Не крути драфт-цикл бесконечно**: сошлись `expect` и compare в порогах — публикуй немедленно; не сходится после ~3 полировок — правило 4.

**Probe-галерея — витрина прогресса.** С первого атома веди `ypv2-probe-atoms` (стикершит опубликованных атомов), с молекул — `ypv2-probe-<level>` по экрану на компонент (раскладка повторяет Figma-эталон; шаблон — `templates/probe.json`, host-типы — `reference/host-catalog.json`). Объяви док служебным и трекающим головы — тогда пересохранять после каждой публикации компонента не нужно:

```bash
node driver.mjs prototype ypv2-probe-atoms.json
echo '{"kind":"component-gallery","track":"head"}' > lifecycle.json
node api.mjs send POST /prototypes/ypv2-probe-atoms/lifecycle lifecycle.json
node driver.mjs snap ypv2-probe-atoms ./shots --all-screens
```

`track: head` резолвит **только компонентные пины** (версия темы остаётся пином ревизии — после PATCH темы пересохранять всё равно, §3.2); ограничения lifecycle, readiness-профиль `service` (warnings галереи — не блокер) и правила pinned-доков — **`reference/verification.md`**.

### 4.7 Сверка

Порядок жёсткий: **числовая приёмка до пиксельной** (числовая сразу называет правку: «gap expected 8, got 6»).

1. **`expect`** — замер geometry против выписки §4.1, допуск ±1px. `expected.json` пишешь ты; формат (`key`/`size`/`gap`/`padding`/`tolerance`), семантика наблюдаемых зазоров и exit-коды — **`reference/verification.md`**.
2. **`compare.mjs`** — pixelmatch: кластеры расхождений, AA-diagnostic (антиалиасинг ≠ дефект), `--region` с бюджетом, отчёт при несовпадении размеров. Цель: mismatch ≤ 2% и **весь** остаток объясним текстовым антиалиасингом; любое расхождение геометрии/цвета/радиуса/тени — дефект. Детали флагов — там же.
3. **Глазами**: diff.png + пара эталон/снап. Кластеры по краям блоков = геометрия, по буквам = шрифт (проверь, что снялся YS Text, а не fallback).

### 4.8 Семья вариантов: серверная матричная приёмка

Figma-компонент с осями вариантов — матрица, её приёмку считает **сервер**; самописных matrix-скриптов не нужно. Перед первым case-set прочитай **`reference/acceptance.md`** — там манифест, правила эталонов (`referenceSurface: "content-hug"` + `expectedGeometry`, crop-lineage), профили порогов, чтение вердикта (`--summary`, remediation-группы, reuse-квитанции), алгебра `--refresh`/`--recapture` и промоут-линковка.

```bash
node api.mjs upload figma-refs/pay-card-product-default@2x.png   # эталон каждой ячейки
node driver.mjs case-set validate matrix.json                    # dry-run манифеста
node driver.mjs case-set put pay-payment-card matrix.json        # → caseSetId + coverage
node driver.mjs accept pay-payment-card --case-set cset_… --policy pixel-strict-v1 --summary
node driver.mjs accept-status acc_… --case <caseId>              # drill-down одного случая
```

Минимум, чтобы не споткнуться: `case.id` — `[A-Za-z0-9._-]` (Figma `54863:9537` → `54863-9537`); эталон — сырой экспорт узла MCP, руками не паддить и не кропить; sparse-семья — **одна ось** до 64 значений, один набор и один ран; `null` в манифесте не бывает — необязательное поле опускается; лимиты — из `/capabilities → limits`.

### 4.9 Фиксация и каденс

Публикация (`promote` — validate+publish+auto-supersede одной командой, с линковкой acceptance-рана) идёт **сразу** по итогам приёмки — не копи «пачку на потом». После публикации: строка в `REPORT.md` (`pay-button v1 | figma 123:456 | diff 0.8% | gallery ypv2-probe-atoms`), статус `done` в `BUILD_ORDER.md`, атом виден в галерее. Только после этого — следующий компонент.

## 5. Приёмка компонента (обязательный чек-лист)

- [ ] выписка §4.1 существует; каждый вариант Figma представлен пропом и примером;
- [ ] reuse-гейт пройден (search до создания; 409 не обходился);
- [ ] каждый `.default()` имеет парный `??`; `{}` рендерится дефолтным видом Figma;
- [ ] цвета/тени — `color()` с точным Figma-литералом; spacing — `space()`/union;
- [ ] атом принят через `preview --rev head-draft` + `expect` **до** первой публикации; префлайт зелёный; publish по итогам приёмки (или по правилу 4 с зафиксированным known-gap);
- [ ] `expect`: ±1px, 0 mismatches; compare: ≤2%, остаток — только антиалиасинг (AA-diagnostic), кластеры объяснены;
- [ ] вариантов >1: манифест прошёл `case-set validate`, coverage без дыр, терминальный `accept`-ран `pass`/`pass_with_exceptions` под `pixel-strict-v1`; `indeterminate` разобраны, не списаны; runId/caseSetId в `REPORT.md` и переданы в `promote` (`acceptance link: …` в выводе);
- [ ] интерактив: typed events объявлены, `emit` работает (плеер `?debug=1`);
- [ ] definition: честный `atomicLevel`, продуктовый `description`, `examples`;
- [ ] Figma-provenance прикреплён, эталонные PNG в реестре;
- [ ] компонент опубликован и виден в probe-галерее; запись в `BUILD_ORDER.md`/`REPORT.md`.

## 6. Phase 2 — молекулы и организмы

Тот же цикл §4. Граница «composition vs TSX» выучена дорого — соблюдай с рождения; полные правила и composition v3 (параметры, `when`/`$switch`/`repeatParam`, слоты, `layout`, `variants`) — **`reference/composition.md`**. Скелет:

- Компонент, владеющий скроллом/маской, `fixed/sticky`, анимацией, состоянием, измерением DOM или скелетон-анатомией — **TSX** с обязательным `ownership: { reason: "<чем владеет>" }` (без него `422 atomic_policy_violation`). Контент-блок из готовых атомов — **composition**.
- **Границу считает сервер**: `POST /compositions/analyze` с `{doc, designSystem}` → `composition | extend-component | needs-ownership-component` + `unsupported[]`. Спрашивай его до того, как писать TSX «на всякий случай».
- v3-композицию перед записью прогоняй через `POST /compositions/:id/preview-tree`.
- Дети-инстансы Figma → named slots или composition; **не** перерисовывай готовый атом внутри молекулы.
- Сверка стикершитом как у атомов; организмам — плюс probe «в контексте» (на реальном фоне экрана из Figma).

## 7. Phase 3 — эталонные экраны

2–3 полных флоу из Figma (чекаут, выбор способа оплаты, успех) как кликабельные прототипы `ypv2-ref-<flow>`:

- flow-экран **без `canvas`**; фиксированные области — `@eui/FlowRoot` + `region: "statusBar"|"header"|"footer"`; snap — канонический вьюпорт (mobile 390×844), Figma-фрейм кропь под него. Контракт регионов (self-contained бары, без `fixed/sticky` в компонентах, статус-бар только регионом) — `reference/easy-ui-authoring.md`.
- Интерактив по-настоящему: `state`/`$cond`/`repeat`, `navigate`, `flows[]`.
- Snap каждого экрана против Figma-фрейма (`compare.mjs`, тот же порог). Capture рендерит регионы inline (низ футера может уйти за фолд — артефакт снимка); пиннед-поведение и скролл принимай глазами в плеере (`/p/<id>`, `?debug=1`).
- Расхождение, которого не было на стикершите, = дефект интеграции — чини компонент, не подпирай документ.

Probe/ref-прототипы живут драфтами; `publish` прототипа — только если нужна стабильная ссылка для человека.

Система готова: все строки `BUILD_ORDER.md` в `done`, экраны проходят сверку, `driver.mjs audit --design-system yandex-pay-v2` чист, `REPORT.md` — полная таблица Figma → компонент → diff%.

## 8. Грабли — минимальный набор

Полный список — **`reference/gotchas.md`** (читай при любом «странном» симптоме). Всегда держи в голове:

- **Renderer не применяет Zod-дефолты** (правило 6): краш на `.map`, NaN-геометрия при валидном документе.
- **Hug по умолчанию**: `flex:1` раздувает ряды — проверяй geometry.
- **Faux-bold / шрифт-fallback**: несуществующий вес или PNG до загрузки YS Text = все ширины врут; на матричной приёмке это ловит гейт `readiness`.
- **`recapture=0` — не пропущенная работа**: правка порогов → `verdictRecomputed`, эталона → `rediffed`; кадры законно переиспользуются.
- **Эталон руками не готовят**: в реестр — сырой экспорт узла, канву строит сервер.
- **Пины**: ревизия прототипа пинует версии компонентов и темы — пересохраняй probe после PATCH темы (и после publish, если док без `track: head`), иначе гоняешься за «диффом», которого нет.
- **CAS 409** при прерванной сессии — повторить вызов (перечитает `headRev`); тестовый мусор удалять, probe/ref-доки — не мусор.

## 9. Карта справочников (читать по мере надобности)

| Файл | Когда читать |
|---|---|
| `reference/server-features.md` | первый запуск на инстансе; странности кэша/404 |
| `reference/theme.md` | перед первым PATCH темы; 422 темы; откат шкалы |
| `reference/verification.md` | перед первым preview/probe; формат expected.json; флаги compare |
| `reference/acceptance.md` | перед первым case-set; разбор вердикта/reuse; promote-линковка |
| `reference/composition.md` | перед первой молекулой |
| `reference/gotchas.md` | любой «странный» симптом |
| `reference/easy-ui-authoring.md` | грамматика документа, директивы, регионы, troubleshooting — секциями |
| `reference/canonical-roles.md` | если обсуждается `canonicalFor` |
| `templates/`, `examples/` | шаблон атома, probe-док, образцы TSX/доков |
