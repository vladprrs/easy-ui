# easy-ui: предложения по ускорению design-system migration и повышению качества результата

Дата анализа: **2026-08-03**, обновлено после циклов `pay-card-input`, `pay-action-button` и 38 draft-ревизий `pay-payment-card`  
Статус: **актуализированное предложение для продуктовой и инженерной команды easy-ui**  
Источник: практический опыт переноса Yandex Pay Design System из Figma в `yandex-pay-v2`, локальные API-ответы, OpenAPI, server snapshots, acceptance logs, visual evidence и накопленные артефакты.

## Executive summary

После первого фидбэка easy-ui заметно улучшилась: появились validate-префлайт, preview непубличной головы, единый promote, service gallery с `track: head`, sparse theme operations, `stalePins` и более безопасный component lifecycle. На `pay-card-input` это позволило довести компонент через draft-итерации и опубликовать один принятый head; `pay-payment-card` дошёл до rev38 без создания публичного мусора.

Теперь главное ограничение сместилось. Узким местом стала не публикация, а массовая приёмка сложного семейства и слабая выразительность compositions:

- 49 состояний `pay-payment-card` требуют отдельных capture/geometry/diff операций и локальных resumable-скриптов;
- screenshot, geometry, visual bounds, asset/font readiness и pixel policy существуют как разрозненные сигналы;
- CSS blur расширил измеряемые visual bounds 32 карточек до 175px при корректном layout-root `140×96`, и это обнаружилось только после полного прогона;
- проверяемая draft-голова может измениться между отдельными запросами, если acceptance не закрепляет immutable candidate fingerprint;
- composition не может выразить условную структуру, typed parameters, repeat по входным данным, локальный layout/clip и прозрачное связывание событий — поэтому простые продуктовые блоки преждевременно превращаются в TSX;
- ответы, screenshots и evidence по-прежнему приходится раскладывать по локальному кэшу и связывать SHA-манифестом вручную.

Новый максимальный прирост даст следующий слой:

1. **Matrix Acceptance Run** — один resumable job для десятков props cases с immutable candidate pin.
2. **Geometry Contract 2.0** — раздельные layout bounds, paint bounds и overflow verdict.
3. **Composition Workbench / Composition v3** — typed params, conditions, repeat, slots, event wiring и ограниченный token-based layout без произвольного кода.
4. **Reference Mapping** — Figma node/crop → props case → geometry/pixel policy как серверная сущность.
5. **Deterministic Capture** — обязательное ожидание fonts/assets/effects и renderer fingerprint.
6. **Content-addressed Evidence Cache** — автоматическое сохранение и дедупликация всех tool responses и результатов acceptance.

Практическая цель следующего этапа: семейство из 49 вариантов должно приниматься одной командой и требовать ручной итерации только для тех состояний, где сервер показал конкретный structural/visual defect.

### Что из исходного предложения уже реализовано

| Возможность | Статус по фактическому workflow | Эффект |
|---|---|---|
| Validate до публикации | реализовано | compile/type/provenance ошибки ловятся на draft |
| Head-draft preview/geometry | реализовано | визуальные итерации не создают public versions |
| Promote принятой головы | реализовано | публикация отделена от промежуточных сохранений |
| `component-gallery/track:head` | реализовано | component repin churn почти устранён |
| Service validation profile | реализовано | warnings галереи не требуют фиктивной flow-логики |
| Sparse theme operations + dry-run | реализовано | маленькие theme delta не требуют полного payload |
| `stalePins` | реализовано | понятен список документов для theme repin |
| Единый matrix acceptance | не реализовано | главный текущий источник команд и локальных скриптов |
| Geometry layout/paint split | не реализовано | blur/shadow overflow смешивается с размером компонента |
| Полноценные compositions | не реализовано | слишком много layout/control-flow уходит в TSX |
| Server interaction runner | не подтверждено | browser evidence остаётся неполным |
| Автоматический evidence bundle/cache | не реализовано | manifests и связи evidence собираются локально |

Разделы ниже сохраняют исходный baseline и подробные RFC-наброски. При планировании реализации уже закрытые пункты следует считать историей, а новый приоритетный пакет описан в разделе 19.

### Исходная гипотеза 2026-08-02

Ниже сохранена исходная гипотеза, на основании которой уже появились draft lifecycle и более безопасная публикация. Оставшиеся части — acceptance orchestration и evidence bundle — по-прежнему актуальны.

Максимальный прирост должен был дать переход easy-ui от набора отдельных операций к управляемой системе приёмки:

```text
draft revision
    → validate
    → immutable candidate bundle
    → acceptance run
    → promote to active version
```

Публичная версия должна появляться один раз — после автоматической проверки непубличного кандидата. Сейчас typecheck, compile, preview, probe pinning, geometry, screenshots, visual diff, interaction verification, regression и audit распределены между разными API и локальными скриптами. Из-за этого исправления геометрии, provenance или acceptance metadata создают публичные версии и дополнительные probe revisions.

Главные предложения:

1. Непубличный component/theme candidate с полной проверкой до публикации.
2. Единый атомарный acceptance run с одним evidence bundle.
3. Формальный Visual Diff Contract с raw, geometry, ROI, AA и exception lifecycle.
4. Отдельный validation profile для component gallery/probe.
5. Изолированный server-side interaction runner.
6. Sparse theme operations, impact graph и batch repin.
7. Автоматическое применение schema defaults и безопасное наследование provenance.
8. Verification matrix для вариантов, negative cases и автогенерации probes.
9. Content-addressed Figma Source Package и offline rebuild.
10. Семантический reuse gate, persistent decisions и dependency workbench.

## 1. Количественный baseline на 2026-08-02

### 1.1. Component и version churn

В `yandex-pay-v2` принято 15 компонентов, которым соответствует 36 опубликованных версий:

| Component | Accepted head |
|---|---:|
| `pay-box` | v4 |
| `pay-text-item` | v3 |
| `pay-divider` | v1 |
| `pay-badge` | v2 |
| `pay-page-indicator` | v2 |
| `pay-checkbox` | v1 |
| `pay-radio` | v3 |
| `pay-switch` | v1 |
| `pay-button` | v3 |
| `pay-chip` | v2 |
| `pay-tooltip` | v1 |
| `pay-segmented-control` | v1 |
| `pay-button-group` | v6 |
| `pay-banner` | v1 |
| `pay-timer` | v5 |

Итого:

- среднее — **2,4 опубликованные версии на accepted head**;
- медиана — **2**;
- 9 из 15 компонентов завершили работу выше v1;
- верхняя оценка лишнего version churn — 21 версия сверх минимальной одной на компонент.

Не все дополнительные версии были ошибками: часть — осознанные non-breaking extensions. Но подтверждены два особенно дорогих случая:

- `PayButtonGroup`: v1–v5 были superseded, принята v6;
- `PayTimer`: v1–v4 были pre-acceptance итерациями, принята v5.

Это 11 публикаций ради двух принятых runtime heads. При наличии candidate lifecycle публичных версий было бы две, то есть на **82% меньше** для этих двух компонентов.

На server snapshots в момент работы все шесть ButtonGroup versions и все пять Timer versions были `active`; отдельный lifecycle cleanup выполнялся позднее или оставался долгом:

- [`components/pay-button-group/v06/component-response.json`](./artifacts/easy-ui/components/pay-button-group/v06/component-response.json)
- [`components/pay-timer/v05/component-response.json`](./artifacts/easy-ui/components/pay-timer/v05/component-response.json)
- [`notes/pay-button-group.md`](./notes/pay-button-group.md)
- [`notes/pay-timer.md`](./notes/pay-timer.md)

### 1.2. Probe и theme churn

Текущие probe heads:

- `ypv2-probe-atoms@41` — 16 экранов;
- `ypv2-probe-molecules@16` — 14 экранов.

То есть два probe-документа дошли суммарно до 57 revision numbers при текущей поверхности в 30 экранов.

Theme дошла до v14. Последнее изменение добавило два typography-токена, но было выполнено как `full-theme-replacement` с полным payload:

- 104 tokens;
- 3 fonts;
- 15 icons;
- 25 старых экранов пересняты и оказались byte-identical.

Evidence: [`themes/v14/acceptance.json`](./artifacts/easy-ui/themes/v14/acceptance.json).

Для Theme v13 и v14 вместе было выполнено как минимум 43 legacy captures, которые в итоге оказались byte-identical. Консервативный dependency/impact graph позволил бы избежать большинства из них для доказанно additive изменений.

### 1.3. Стоимость ручной evidence-сборки

В `artifacts/easy-ui` накоплено:

- 1 629 файлов;
- 824 PNG;
- 24 специальных `.mjs`/`.cjs` verifier или compare scripts;
- 32 `SHA256SUMS` manifest.

Сохранение evidence — полезная и обязательная часть процесса. Проблема заключается в том, что значительная часть структуры, verifier scripts, acceptance summaries и hash manifests собирается вручную за пределами продукта.

### 1.4. Visual acceptance не сводится к одному проценту

Как минимум семь из 15 принятых компонентов потребовали дополнительных visual policies:

- TextItem и Divider — content ROI;
- SegmentedControl и Tooltip — opaque/alpha normalization;
- ButtonGroup — weighted policy и diagnostic host contexts;
- Banner — wrapper ROI;
- Timer — alpha composite и AA diagnostic.

Timer показывает недостаточность одного глобального diff-процента:

- canonical pixelmatch, threshold `0.1`: **3,5526%**;
- AA diagnostic, threshold `0.25`: **1,4342%**;
- structural region mismatch: **0%**;
- geometry всех topology exact.

Evidence: [`prototypes/ypv2-probe-molecules/rev-16/acceptance.json`](./artifacts/easy-ui/prototypes/ypv2-probe-molecules/rev-16/acceptance.json).

### 1.5. Probe documents содержат техническую логику

Чтобы sticker sheets прошли flow-oriented validators, в текущих документах появились:

- 30 технических `Hotspot`;
- 256 `on`-bindings;
- минимум три warning-only revisions.

Примеры:

- rev5: независимый экран считался недостижимым;
- rev21: Switch probe не имел фиктивных typed handlers/navigation edge;
- rev28: terminal Skeleton variants считались интерактивными без handlers.

Evidence:

- [`rev-05/response.txt`](./artifacts/easy-ui/prototypes/ypv2-probe-atoms/rev-05/response.txt)
- [`rev-21/iteration.json`](./artifacts/easy-ui/prototypes/ypv2-probe-atoms/rev-21/iteration.json)
- [`rev-28/publication-summary.json`](./artifacts/easy-ui/prototypes/ypv2-probe-atoms/rev-28/publication-summary.json)

### 1.6. Browser interaction evidence неполно

Пользовательский Safari оказался связан с orphan WebDriver session. Сессию корректно не перехватывали и не завершали. Для ряда интерактивных компонентов пришлось проверять compiled bundle через собственные VM/verifier scripts вместо реального player interaction.

Это сохранило честность acceptance, но evidence слабее browser-level проверки pointer, keyboard, focus и ARIA.

### 1.7. Reuse gate даёт семантические false positives

`PayCheckbox` был заблокирован против `PayRadio` с score `0.8422` из-за одинаковой props/events/slots signature и 89% normalized source similarity. Продуктово это разные атомы:

- Checkbox — независимый boolean, допускает self-deselect;
- Radio — взаимоисключающий выбор, active item не self-deselect.

Для решения потребовалось явное вмешательство владельца.

Evidence:

- [`pay-checkbox/v01/reuse-block.txt`](./artifacts/easy-ui/components/pay-checkbox/v01/reuse-block.txt)
- [`pay-checkbox/v01/reuse-decision.json`](./artifacts/easy-ui/components/pay-checkbox/v01/reuse-decision.json)

## 2. Что уже хорошо реализовано

Предложения не требуют переписывать easy-ui с нуля. В продукте уже есть сильные primitives:

- CAS через `baseRev`/`baseVersion`;
- immutable source revisions и published versions;
- content-addressed assets;
- component/prototype screenshots;
- visual references и visual runs;
- prototype readiness;
- prototype repin с dry-run;
- reuse search и catalog revision;
- component usages и catalog audit;
- server-side screenshot jobs;
- lifecycle statuses;
- interaction scenario storage.

Основной недостающий слой — orchestration и возможность направить эти проверки на непубличный draft candidate.

Авторитетный API snapshot: [`openapi-20260801.json`](./artifacts/easy-ui/openapi-20260801.json).

## 3. P0. Непубличный candidate и атомарный promote

### 3.1. Текущая проблема

Сейчас component save проверяет синтаксис и definition extraction, а `publish` выполняет typecheck, compile, import verification и сразу активирует следующую версию.

Следствия:

- compile/render ошибки проявляются слишком поздно;
- визуально проверить draft bundle нельзя;
- каждое исправление после screenshot/geometry создаёт версию;
- acceptance metadata и provenance могут создавать runtime version даже без изменения bundle;
- промежуточные версии временно становятся active;
- cleanup требует отдельных status transitions.

Реальный 422, который можно было поймать локальным/OpenAPI preflight: provenance `pageNodeId` оказался неподдерживаемым полем.

Evidence: [`pay-page-indicator/v01/publish-attempt-01-response.json`](./artifacts/easy-ui/components/pay-page-indicator/v01/publish-attempt-01-response.json).

### 3.2. Предлагаемый lifecycle

```text
draft revision
    ├── failed validation
    └── validated candidate
            ├── rejected / expired
            └── accepted candidate
                    └── promoted active version
                            └── superseded, but executable for immutable pins
```

Candidate — content-addressed immutable artifact, но не component version и не часть latest-active resolution.

### 3.3. Validate API

```http
POST /api/components/{id}/revisions/{rev}/validate
Content-Type: application/json
```

```json
{
  "themeVersion": 14,
  "catalogRevision": "…",
  "checks": {
    "typecheck": true,
    "compile": true,
    "importVerify": true,
    "renderExamples": true,
    "schemaDefaults": true,
    "accessibility": true,
    "assets": true,
    "provenance": true,
    "reuse": true,
    "dependencies": true
  },
  "policyProfile": "figma-rebuild-v1",
  "idempotencyKey": "component-pay-timer-rev-5"
}
```

Пример ответа:

```json
{
  "validationId": "val_…",
  "status": "ready",
  "componentId": "pay-timer",
  "rev": 5,
  "sourceHash": "…",
  "bundleHash": "…",
  "themeVersion": 14,
  "catalogRevision": "…",
  "candidateBundle": {
    "url": "/api/candidate-bundles/…/bundle.js",
    "expiresAt": "…"
  },
  "checks": [],
  "warnings": [],
  "errors": []
}
```

Требования:

- повтор с тем же input hash и `idempotencyKey` возвращает тот же результат;
- diagnostics имеют стабильный code, JSON pointer, source location и suggestion;
- результат можно использовать для component preview и prototype overlay;
- validate ничего не меняет в public catalog;
- validate receipt становится недействительным при изменении source, theme, catalog или policy fingerprints.

### 3.4. Promote API

```http
POST /api/components/{id}/revisions/{rev}/promote
```

```json
{
  "validationId": "val_…",
  "acceptanceRunId": "acc_…",
  "baseRev": 5,
  "expectedThemeVersion": 14,
  "expectedCatalogRevision": "…",
  "idempotencyKey": "promote-pay-timer-rev-5"
}
```

Promote должен атомарно:

1. Проверить fingerprints и acceptance gates.
2. Создать одну immutable public version.
3. Сделать её preferred active head.
4. Перевести прежний active head в `superseded`, если не запрошен explicit parallel-support режим.
5. Сохранить ссылки на validation и acceptance evidence.
6. Не менять immutable pins существующих published prototypes.

### 3.5. Отдельная история provenance/evidence

Runtime version не должна меняться, если source, definition и bundle hash не изменились.

Нужен отдельный CAS endpoint:

```http
PUT /api/components/{id}/provenance
```

или отдельная evidence revision внутри component revision.

Практические случаи:

- ButtonGroup v2 и v3 имеют одинаковый bundle hash, но разный набор references;
- Timer v2 и v3 имеют одинаковый bundle hash, но была скорректирована provenance/reference selection.

Такие изменения должны обновлять evidence history, а не создавать runtime version и не требовать repin.

### 3.6. Целевые метрики

- first-public-version acceptance rate: **≥80%**;
- среднее число public versions на новый accepted component: **≤1,2**;
- active versions без успешного acceptance: **0**;
- publish-time 422 после успешного validation receipt: **0**;
- ручные status transitions для обычного supersede: **0**;
- same-bundle duplicate versions: **0**.

## 4. P0. Единый acceptance run

### 4.1. Цель

Одна серверная операция должна превратить validated candidate в воспроизводимый verdict, не изменяя public state при failed gate.

### 4.2. API

```http
POST /api/acceptance-runs
```

```json
{
  "subject": {
    "kind": "component-revision",
    "componentId": "pay-timer",
    "rev": 5,
    "validationId": "val_…"
  },
  "policyProfile": "yandex-pay-pixel-perfect-v1",
  "references": "from-provenance",
  "probeTargets": "auto-impact",
  "browsers": ["chromium", "webkit"],
  "checks": [
    "contract",
    "defaults",
    "render",
    "geometry",
    "visual",
    "interactions",
    "regression",
    "determinism",
    "audit"
  ],
  "idempotencyKey": "accept-pay-timer-rev-5"
}
```

### 4.3. Pipeline

Acceptance worker выполняет:

1. Проверку validation receipt.
2. Создание временного component overlay поверх выбранных prototype revisions.
3. Вычисление dependency closure и impacted screens.
4. Render status и bundle readiness.
5. Geometry capture.
6. Font/asset readiness.
7. Screenshot capture.
8. Visual reference checks.
9. Interaction scenarios.
10. Regression только затронутых screens либо full regression при unknown dependencies.
11. Повторный capture для determinism.
12. Catalog/usages/audit checks.
13. Сбор единого evidence bundle.

### 4.4. Acceptance artifact

Итоговый immutable bundle должен содержать:

- request и resolved fingerprints;
- source и compiled bundle hashes;
- exact theme/catalog/component pins;
- provenance и reference hashes;
- status и geometry;
- raw reference/candidate/diff assets;
- interaction traces и DOM/ARIA snapshots;
- regression и determinism summaries;
- browser/renderer/font fingerprints;
- product errors, runtime warnings и deduplicated infra noise;
- policy profile и exception records;
- автоматически созданный SHA256 manifest;
- команду или API payload для воспроизведения.

Одинаковый infrastructure noise должен агрегироваться по fingerprint, а не копироваться в каждый screen result. В текущих артефактах запрос `127.0.0.1:8787/api/auth/me` повторяется 124 раза в 44 файлах.

### 4.5. CLI

```bash
easyui accept component pay-timer \
  --rev 5 \
  --policy yandex-pay-pixel-perfect-v1 \
  --out artifacts/easy-ui/components/pay-timer/v05
```

CLI должен сам сохранять все ответы и не требовать pipelines с `tee`, дополнительного `curl` или ручной сборки manifests.

### 4.6. UI

На component draft page нужен блок Acceptance:

- текущая последовательность gates;
- progress и resumable jobs;
- impact list;
- visual overlay;
- interaction trace;
- blocking errors и suggestions;
- exceptions;
- кнопка Promote, доступная только при выполненной policy.

### 4.7. Целевые метрики

- client commands на один acceptance: **5–8 → 1**;
- stale-pin incidents: **0**;
- affected screens выбираются автоматически: **100%**;
- bespoke verifier/compare scripts для новых компонентов: **−90% или больше**;
- accepted artifacts с полным evidence bundle: **100%**;
- время от source-ready до verdict, без human product decisions: **<10 минут**.

## 5. P0. Visual Diff Contract 2.0

### 5.1. Требования к reference

Reference должен содержать не только PNG и threshold, но формальный contract:

```json
{
  "target": {
    "scope": "component",
    "componentId": "pay-timer",
    "candidateRev": 5,
    "elementKey": "timer"
  },
  "capture": {
    "crop": "element-bounds",
    "transparent": true,
    "deviceScaleFactor": 1,
    "waitForFonts": true
  },
  "geometry": {
    "expected": {"width": 190, "height": 40},
    "tolerancePx": 1
  },
  "metrics": [
    {
      "name": "pixelmatch-v1",
      "threshold": 0.1,
      "role": "canonical",
      "maxDiffPercent": 2
    },
    {
      "name": "pixelmatch-v1",
      "threshold": 0.25,
      "role": "aa-diagnostic"
    }
  ],
  "regions": [
    {
      "id": "structure",
      "rect": [0, 24, 190, 4],
      "maxDiffPercent": 0
    }
  ],
  "backgroundComposites": ["transparent", "#ffffff", "#1a1a1a"]
}
```

### 5.2. Обязательные свойства

- raw Figma reference сохраняется неизменным;
- любые clean/opaque derivatives имеют lineage и pixel-change manifest;
- canonical threshold нельзя тихо повысить;
- AA metric всегда диагностическая, если policy не утверждает иное;
- geometry и structural regions оцениваются отдельно от text rasterization;
- host context может быть помечен как diagnostic и исключён из component-owned gate;
- editor artifacts оформляются typed masks с причиной;
- reference, candidate и diff assets content-addressed и не копируются между runs;
- font readiness и renderer fingerprint являются частью результата.

### 5.3. Exception lifecycle

```json
{
  "status": "accepted-with-exception",
  "gate": "visual.canonical",
  "owner": "design-system-team",
  "reason": "browser/Figma font raster residual",
  "rawMetric": 3.5526,
  "diagnosticMetric": 1.4342,
  "structuralMetric": 0,
  "expiresAt": "2026-10-01",
  "reviewIssue": "EUI-…"
}
```

Exceptions должны быть видны в catalog audit и release dashboard.

### 5.4. Целевые метрики

- accepted components с raw full-frame metric: **100%**;
- скрытые threshold overrides: **0**;
- visual exceptions без owner/expiry: **0**;
- ручные ad-hoc compare scripts для новых компонентов: **0**;
- необъяснённые residual pixels вне declared regions: **0**.

## 6. P0. Component gallery/probe validation profile

### 6.1. Текущая проблема

Component gallery — не пользовательский flow. Независимые screens не обязаны быть достижимы через navigation, а terminal visual variants не обязаны иметь event handlers.

Сейчас validators заставляют добавлять фиктивную логику, которая:

- увеличивает document size;
- маскирует реальные interaction gaps;
- создаёт предупреждения и revision churn;
- загрязняет screenshots и geometry деревья техническими nodes.

### 6.2. Предложение

Использовать существующий lifecycle `kind: "component-gallery"` и добавить validation profile:

```json
{
  "kind": "component-gallery",
  "validationProfile": {
    "requireScreenReachability": false,
    "requireNavigationGraph": false,
    "requireHandlersForEnabledInteractiveExamples": true,
    "allowTerminalStatesWithoutHandlers": true,
    "screenIndex": "generated"
  }
}
```

Правила:

- `Disabled`, `Skeleton`, `Loading` и unfocusable cases не требуют handlers;
- enabled interactive example без handler по-прежнему предупреждает;
- player автоматически предоставляет screen/variant switcher;
- gallery может генерироваться из verification matrix;
- flow-only readiness gates не применяются к gallery;
- visual, geometry, accessibility и determinism gates остаются строгими.

### 6.3. Целевые метрики

- технические Hotspot в новых galleries: **0**;
- фиктивные event bindings: **0**;
- warning-only gallery revisions: **0**;
- автоматическая генерация gallery из verification matrix: **≥80% структуры**.

## 7. P0. Изолированный interaction runner

### 7.1. Текущая проблема

Easy-ui хранит interaction scenarios, но в текущем OpenAPI отсутствует server-side run endpoint. Реальная проверка зависит от внешнего браузера или custom VM harness.

### 7.2. API

```http
POST /api/prototypes/{id}/revisions/{rev}/interaction-runs
```

```json
{
  "screenId": "pay-radio",
  "browser": "webkit",
  "steps": [
    {"action": "click", "target": {"elementKey": "radio-off"}},
    {"expectEvent": {"name": "change", "payload": {"active": true}}},
    {"action": "key", "target": {"elementKey": "radio-off"}, "key": "Space"},
    {"expectAria": {"elementKey": "radio-off", "checked": false}}
  ],
  "captureAfterSteps": [1, 3]
}
```

Нужен также component-level target:

```http
POST /api/components/{id}/candidate-bundles/{validationId}/interaction-runs
```

с `props` или `verificationCase` без обязательного prototype.

### 7.3. Поддерживаемые проверки

- click, hover, pressed, pointer cancel;
- Enter/Space/Arrow keys;
- focus order и focus visibility;
- typed event name и payload;
- отсутствие события;
- state transitions;
- disabled/unfocusable state;
- ARIA role/name/checked/pressed/selected;
- DOM snapshot;
- screenshot после шага;
- одинаковое поведение минимум в Chromium и WebKit.

### 7.4. Целевые метрики

- interactive accepted components с live-player evidence: **100%**;
- блокировки из-за пользовательских browser sessions: **0**;
- custom VM interaction scripts для новых компонентов: **0**;
- cross-browser event payload parity: **100%**.

## 8. P1. Theme plan, sparse operations и impact graph

### 8.1. Sparse theme API

```http
POST /api/design-systems/{id}/theme/plans
```

```json
{
  "baseVersion": 14,
  "operations": {
    "addTokens": {
      "font.new-token": "0px"
    },
    "addFonts": [],
    "addIcons": []
  },
  "policy": {
    "appendOnly": true,
    "allowExistingValueChange": false
  }
}
```

Plan должен вернуть:

- normalized semantic diff;
- no-op detection;
- added/changed/deleted objects;
- token/icon/font usage impact;
- affected component versions;
- affected prototype screens;
- unknown/dynamic dependencies;
- recommended regression plan;
- validation fingerprints.

Отдельный apply endpoint создаёт immutable theme version только после успешного validation/acceptance.

### 8.2. Dependency extraction

При component validation сервер должен извлекать:

- `token()`/`color()`/`space()` references;
- icon registry names;
- asset IDs;
- component and composition dependencies;
- named-slot type constraints;
- host ABI;
- dynamic/unknown lookups.

Unknown dependency всегда расширяет impact до консервативного full scope.

### 8.3. Draft probe pinning

Для published prototypes exact pins остаются неизменяемыми.

Для `component-gallery`/`evidence` drafts допустим режим:

```text
latestCompatible(contractFingerprint)
```

или transient overlay, материализуемый только внутри acceptance run. Это убирает pure-pinning revisions, не жертвуя воспроизводимостью published artifacts.

### 8.4. Целевые метрики

- theme updates с impact report: **100%**;
- accidental omission старых token/icon/font records: **0**;
- no-op theme versions: **0**;
- additive updates, затрагивающие 2 объекта из 122, передают только эти 2 объекта;
- legacy recaptures для доказанно unaffected screens: **−80–100%**;
- breaking updates, автоматически подтянутые compatible pins: **0**.

## 9. P1. Schema defaults и provenance inheritance

### 9.1. Schema defaults

Сейчас renderer передаёт document props как есть и не применяет результат Zod parsing/defaults. Поэтому каждый component повторяет default в schema и render-коде.

В активных component heads найдено:

- 80 `.default(...)` declarations;
- 124 `??` runtime fallbacks.

Предложение:

- host выполняет `definition.props.parse(inputProps)` один раз;
- Render получает normalized parsed props;
- exact input сохраняется отдельно для diagnostics и diff;
- compiler добавляет `render({})` contract test;
- validator проверяет default serializability и отсутствие side effects;
- migration flag позволяет старым ABI сохранить прежнее поведение.

Если runtime parsing невозможно в текущем ABI, минимальный вариант — compile-time rule, который доказывает parity schema defaults и render fallbacks.

### 9.2. Provenance inheritance

Новая семантика:

- поле отсутствует — inherit предыдущую provenance;
- `figma: null` — явная очистка;
- изменённый `fileKey/nodeIds/references` — отдельный provenance diff;
- byte-identical reference asset переиспользуется по SHA;
- source и provenance могут изменяться одной CAS-транзакцией, но имеют разные hashes/history.

### 9.3. Целевые метрики

- расхождения schema default/runtime default: **0**;
- случайные потери provenance: **0**;
- повторные загрузки byte-identical references: **0**;
- metadata-only runtime versions: **0**.

## 10. P1. Verification matrix

### 10.1. Назначение

Catalog examples должны оставаться короткими и человекочитаемыми. Для полного тестового покрытия нужна отдельная сущность с большим количеством cases.

```json
{
  "schemaVersion": 1,
  "componentId": "pay-button",
  "source": {
    "kind": "figma-variant-matrix",
    "fileKey": "…",
    "componentSetNodeId": "186:12093"
  },
  "allowedCases": [],
  "forbiddenCases": [],
  "defaults": {},
  "geometry": {},
  "referenceMap": {}
}
```

Easy-ui должен:

- проверить, что каждый allowed case проходит schema;
- проверить, что forbidden cases отклоняются;
- render каждую комбинацию;
- автоматически создать component gallery;
- связать cases с reference assets и Figma nodes;
- выявить cases, отсутствующие в schema или reference set;
- не строить фиктивный Cartesian product для неполных Figma matrices.

Практический масштаб уже перенесённых компонентов:

- Button — 87 cases;
- Tooltip — 36;
- Badge — 30;
- Switch — 24;
- Radio и Checkbox — по 16.

### 10.2. Целевые метрики

- source tuples, представленные schema и verification: **100%**;
- несуществующие combinations, прошедшие validation: **0**;
- вручную созданная структура probe: **−80% или больше**;
- missing-reference cases обнаруживаются до promote: **100%**.

## 11. P1. Content-addressed Figma Source Package

### 11.1. Зачем это easy-ui

Figma имеет ограниченные квоты, временные asset URLs и различия между remote/local sources. После первоначального cache harvest несколько компонентов были реализованы с нулём новых Figma-вызовов. Это нужно сделать продуктовой возможностью, а не локальной дисциплиной одного агента.

### 11.2. Package format

```text
source-package/
  manifest.json
  raw-responses/
  variables/
  screenshots/
  assets/
  crops/
  transforms/
  SHA256SUMS
```

Manifest фиксирует:

- actual `fileKey` и source kind `remote|local|imported`;
- node IDs и source revision/fingerprint;
- tool name и normalized request parameters;
- raw response hashes;
- decoded image/SVG hashes;
- crop/alpha/cleanup lineage;
- timestamps и expiration information;
- cache status и reason for refresh.

### 11.3. Поведение

- lookup по `fileKey + nodeId + tool + params + source fingerprint` до внешнего вызова;
- SHA-deduplication assets и screenshots;
- materialization временных URLs;
- offline rebuild;
- import/export package;
- quota counters и cache hit rate;
- запрет смешивать provenance разных Figma revisions без явного reconciliation record.

### 11.4. Целевые метрики

- cache hit после первого extraction: **≥95%**;
- повторные Figma-вызовы для известного source fingerprint: **<5%**;
- rebuild accepted components без Figma network: **100%**;
- failures из-за expired asset URL: **0**.

## 12. P1. Semantic reuse gate и persistent decisions

### 12.1. Semantic contract

Добавить в component definition:

```json
{
  "semanticRole": "checkbox",
  "a11yRole": "checkbox",
  "selectionModel": "independent-boolean",
  "interactionInvariant": [
    "enabled activation toggles value",
    "active item may self-deselect"
  ]
}
```

Для Radio:

```json
{
  "semanticRole": "radio",
  "a11yRole": "radio",
  "selectionModel": "mutually-exclusive",
  "interactionInvariant": [
    "active item does not self-deselect"
  ]
}
```

Matcher должен применять hard semantic separation до structural similarity score.

### 12.2. Persistent decision

После human review easy-ui выдаёт signed decision:

```json
{
  "reuseDecisionId": "reuse_…",
  "decision": "distinct-component",
  "subjectFingerprint": "…",
  "candidateFingerprint": "…",
  "policyVersion": 2,
  "reason": "different selection semantics"
}
```

Decision автоматически применяется к non-breaking revisions/imports. Повторный review нужен только при изменении semantic/source fingerprints или policy version.

Reuse search также может выдавать короткоживущий lease на catalog revision, чтобы `catalog_changed` между review и promote не заставлял повторять весь цикл.

### 12.3. Целевые метрики

- false semantic blocks Checkbox ↔ Radio class: **0**;
- repeated owner interruptions после принятого решения: **0**;
- повторные blocked attempts по той же паре fingerprints: **0**;
- adjudication API round trips: **1**.

## 13. P2. Design-system change set

После реализации candidate и acceptance infrastructure следующим уровнем должен стать атомарный change set:

```text
theme delta
  + component/composition candidates
  + promotion policy
  + impacted probes
  + visual references
  + interaction scenarios
  → plan
  → validate
  → acceptance
  → atomic apply
```

Change set устраняет внешне видимые partial states между theme publish, component activation, status changes и probe repin.

### Требования

- immutable plan fingerprints;
- dry-run impact report;
- candidate closure без public mutation;
- единый acceptance verdict;
- atomic commit либо отсутствие изменений;
- automatic supersede;
- rollback metadata;
- полный evidence bundle.

## 14. P2. Flow-level release gate

Component galleries доказывают атомы и молекулы, но не интеграцию. Для release-ready design system нужны reference flows:

- navigation и back/restart;
- state transitions;
- slots и regions;
- sticky/footer behavior;
- keyboard/focus;
- full-screen Figma diff;
- accessibility smoke;
- regression across flow steps.

Целевой system-level gate:

- минимум три reference flows;
- все основные переходы и события проверены;
- каждый экран проходит принятую visual policy;
- integration geometry regressions отсутствуют;
- flow evidence входит в release bundle системы.

## 15. P2. Dependency и migration workbench

Нужен read model/интерфейс:

```text
Figma source
    → token/icon/asset
    → component or composition
    → template
    → product flow
```

Workbench показывает:

- blocking dependencies;
- next unblocked build units;
- component/composition/template boundary;
- reuse/merge/separate decisions;
- semantic ADR;
- source cache completeness;
- missing exact masters/references;
- impacted components/screens при изменении;
- acceptance и exception status.

Это уменьшит ручное ведение `BUILD_ORDER.md` и позволит easy-ui стать авторитетным источником dependency status, не подменяя product decisions.

## 16. Рекомендуемый порядок внедрения

### Этап 1 — предотвратить публикационный churn

1. `validate` для component head revision.
2. Ephemeral draft bundle и component/prototype overlay.
3. `promote` с validation receipt и idempotency.
4. Automatic preferred-active/supersede lifecycle.
5. Provenance inheritance и metadata-only evidence revisions.

### Этап 2 — собрать существующие primitives в pipeline

1. `acceptance-runs` orchestration.
2. Единый evidence bundle и CLI `--out`.
3. Impact selection и transient probe overlays.
4. Component gallery validation profile.
5. Deduplication infrastructure noise.

### Этап 3 — усилить качество evidence

1. Visual Diff Contract 2.0.
2. Element-bounds transparent capture.
3. Region/AA/exception lifecycle.
4. Server interaction runner.
5. Browser/renderer/font fingerprints.

### Этап 4 — масштабировать на всю design system

1. Sparse theme plans и dependency graph.
2. Verification matrix.
3. Figma Source Package.
4. Semantic reuse decisions.
5. Design-system change sets.
6. Flow-level release gate и migration workbench.

## 17. Основные KPI

| KPI | Baseline | Цель |
|---|---:|---:|
| Public versions на accepted component | 2,4 | ≤1,2 для новых компонентов |
| First-public-version acceptance | не формализовано | ≥80% |
| Unaccepted preferred-active versions | встречались | 0 |
| Commands на component acceptance | 5–8 и более | 1 |
| Stale-pin acceptance runs | возможны | 0 |
| Bespoke verifier/compare scripts | 24 в текущем easy-ui evidence | −90% для новых работ |
| Accepted artifacts с полным evidence bundle | собирается вручную | 100% |
| Interactive components с browser evidence | неполное покрытие | 100% |
| Visual exceptions без owner/expiry | возможно | 0 |
| Theme updates с impact report | вручную | 100% |
| Figma cache hit после extraction | локальная дисциплина | ≥95% |
| Warning-only gallery revisions | минимум 3 | 0 |

Главный product KPI:

> Доля компонентов, которые из одного validated candidate получили строгий contract, geometry, canonical visual diff, live interaction proof, impacted regression и immutable acceptance bundle, после чего были атомарно promoted.

Целевое значение для новых компонентов — **100%**.

## 18. Предлагаемый первый RFC

Название: **Candidate Acceptance Pipeline**.

RFC должен зафиксировать:

1. State machine draft → candidate → accepted → active → superseded.
2. `validate`, `acceptance-runs` и `promote` API.
3. Content/fingerprint/idempotency model.
4. Draft bundle preview и prototype overlay.
5. Policy profiles и blocking gates.
6. Evidence bundle schema.
7. Совместимость с текущим `publish`.
8. Migration strategy для существующих versions/statuses.
9. Automatic preferred-active/supersede behavior.
10. P0 KPI и telemetry.

Рекомендуемая совместимость:

- текущий `publish` временно оставить;
- реализовать его как legacy shortcut;
- в strict design systems требовать successful validation/acceptance receipt;
- позже перевести CLI на `validate → accept → promote`;
- immutable historical versions и prototype pins не изменять.

## 19. Новый приоритетный пакет после rev38

### 19.1. P0 — Matrix Acceptance Run

Нужна серверная сущность, принимающая immutable candidate и полный набор verification cases:

```http
POST /api/components/{id}/acceptance-runs
```

```json
{
  "candidate": {
    "rev": 38,
    "sourceHash": "4c8990bb…",
    "bundleHash": "f3dbbfb2…",
    "themeVersion": 33
  },
  "cases": {
    "manifestAssetId": "asset_<sha256>",
    "concurrency": 1,
    "resume": true
  },
  "checks": ["render", "geometry", "visual", "determinism"],
  "policy": "yandex-pay-pixel-perfect-v1"
}
```

Run обязан:

- закрепить один source/bundle/theme/renderer fingerprint на все cases;
- дедуплицировать одинаковые props и references;
- идти resumable очередью и повторять только infrastructure failures;
- выдавать progress `completed/total`, ETA и список failed cases;
- сохранять screenshot, geometry и diff content-addressed;
- ранжировать состояния по raw, AA, geometry и structural severity;
- позволять перезапустить только выбранные cases после новой ревизии;
- завершаться единым immutable acceptance report и SHA manifest;
- не считать weighted average заменой обязательного per-case gate.

На текущем масштабе это сокращает цикл `49 screenshots + 49 geometry + compare + summary` примерно со 100–150 клиентских операций до одной постановки и нескольких status polls.

### 19.2. P0 — Geometry Contract 2.0

Текущий geometry verdict должен разделиться минимум на три измерения:

```json
{
  "layoutBounds": {"width": 140, "height": 96},
  "paintBounds": {"width": 175, "height": 130},
  "overflow": {
    "left": 18,
    "right": 17,
    "top": 17,
    "bottom": 17,
    "sources": [
      {"elementKey": "highlight", "cause": "filter:blur(68px)"}
    ]
  },
  "clipChain": ["card-skin"],
  "policyVerdict": "paint-overflow-not-clipped"
}
```

Размер компонента проверяется по `layoutBounds`. `paintBounds` и overflow проверяются отдельной политикой: разрешены тени/эффекты, которые принадлежат source anatomy, но незапланированный overflow или отсутствие ожидаемого clip остаются блокером. Диагностика должна указывать конкретный descendant и CSS property. Это исключит ложный вывод «карточка имеет ширину 175px» и одновременно не спрячет реальную утечку эффекта.

### 19.3. P0 — Deterministic Capture Readiness

Каждый capture должен возвращать и проверять:

- `document.fonts.ready` и список реально использованных font faces;
- завершение загрузки всех theme icons и image assets;
- отсутствие pending network requests для component-owned resources;
- два стабильных animation frames после layout;
- отключение animations/transitions либо фиксированное capture time;
- browser, OS, renderer, DPR, color profile и font-raster fingerprint;
- `captureClean`, `productErrors`, `runtimeWarnings`, `infraWarnings` раздельно.

Нужна declarative readiness policy вместо локальных задержек. `pay-action-button` показал, что ранний draft screenshot может сниматься до появления theme icon; такой PNG не должен попадать в visual verdict вообще.

### 19.4. P0 — Composition Workbench и Composition v3

Главная задача — не превратить composition в произвольный JavaScript, но дать ей выразить безопасную структуру, которая сейчас вынужденно публикуется как TSX.

Минимальная модель:

1. **Typed parameters**: string, number, boolean, enum, object и bounded arrays со schema/defaults.
2. **Условия**: `$if`, `$switch`, optional branch и variant mapping по параметрам, а не только по глобальному `doc.state`.
3. **Repeat по параметру**: bounded `repeat` для массива composition input, с key expression и лимитом элементов.
4. **Slots**: required/optional named slots, allowed child roles, fallback и cardinality.
5. **Event wiring**: child typed event → composition output либо state/action binding без event proxy в TSX.
6. **Token-based layout**: row/column, gap, padding, alignment, sizing, radius, clip и background через ограниченную декларативную схему.
7. **Responsive branches**: container-width breakpoints и host region context без `window`/DOM measurement.
8. **Composition variants**: одна сущность с legal tuples и defaults, совместимая с verification matrix.
9. **Static analyzer**: объясняет, почему конструкция помещается в composition или требует TSX ownership.
10. **Inline preview/debug tree**: resolved params, chosen branches, slots, events и layout owner видны до публикации.

Граница должна остаться строгой:

- composition не владеет таймером, async lifecycle, произвольным DOM measurement, scroll position или бизнес-состоянием;
- carousel со scroll/snap, input, skeleton animation и timed story остаются TSX;
- FAQ list, Benefit list, Payment schedule, Card details и большинство screen content blocks должны собираться декларативно.

Workbench должен начинаться с `catalog search` и показывать три результата: «собрать composition», «расширить существующий component», «нужен новый ownership component» — с объяснением и dependency impact.

### 19.5. P1 — Figma Reference Mapping как сущность easy-ui

Вместо неформальной связи PNG ↔ props нужен manifest:

```json
{
  "componentId": "pay-payment-card",
  "source": {"fileKey": "…", "componentSetNodeId": "54863:9518"},
  "cases": [
    {
      "id": "54863:9537",
      "props": {"family": "Product", "product": "SuperSplit", "state": "Default"},
      "referenceAssetId": "asset_<sha256>",
      "expectedGeometry": {"width": 140, "height": 96},
      "cropLineage": {"parentNodeId": "54863:9518", "rect": [0, 0, 140, 96]},
      "policy": {"maxRawDiffPct": 2}
    }
  ]
}
```

Сервер валидирует полноту tuples, SHA references, дубликаты props, crop lineage и соответствие schema. Из manifest автоматически строятся gallery, acceptance cases и provenance coverage report.

### 19.6. P1 — Visual diagnostics, которые предлагают следующую правку

Помимо diff percentage нужны классифицированные причины:

- whole-surface tint/fill mismatch;
- edge/radius/stroke mismatch;
- geometry shift;
- text-only raster residual;
- missing/late asset;
- alpha/compositing mismatch;
- effect overflow;
- unexpected descendant outside ownership mask.

Отчёт должен группировать одинаковую причину по variant family. Если 20 состояний расходятся из-за одного shared icon или highlight, агент должен получить одну remediation group, а не 20 независимых failures.

### 19.7. P1 — Content-addressed tool/evidence cache

CLI/API SDK должен уметь `--cache-dir` и автоматически сохранять:

- нормализованный request без секретов;
- raw response;
- ETag/source fingerprint;
- decoded assets;
- job receipts и polling history;
- links между candidate, cases, screenshots, diffs и reports;
- SHA manifest и cache hit/miss reason.

Повтор идентичного read/capture при совпадающих fingerprints возвращает cache hit. Принудительное обновление требует явного `--refresh` и записывает причину. Это важно и для easy-ui rate/latency, и для ограниченной квоты Figma.

### 19.8. P1 — Draft change set и compare-between-revisions

Перед полным recapture новой ревизии сервер должен вычислять structural impact между candidate bundles:

- changed render branches/cases;
- changed asset/token dependencies;
- cases с byte-identical computed render plan;
- минимальный safe recapture set;
- возможность подтвердить unaffected cases через fingerprint, не копируя PNG.

Для `pay-payment-card` замена одного BalanceHidden asset не должна требовать 49 screenshot jobs, если сервер может доказать, что остальные 48 render branches и dependencies не изменились. При dynamic/unknown dependency система консервативно расширяет scope.

### 19.9. Рекомендуемый порядок реализации

| Приоритет | Deliverable | Почему первым |
|---|---|---|
| P0.1 | Immutable Matrix Acceptance Run | сразу убирает основной объём запросов и локальной оркестрации |
| P0.2 | Geometry layout/paint/overflow split | предотвращает ложные geometry failures и пропущенные clip defects |
| P0.3 | Capture readiness contract | делает visual evidence воспроизводимым |
| P0.4 | Composition typed params/conditions/slots/events | разблокирует большую часть Wave 3–5 без TSX proliferation |
| P1.1 | Reference Mapping | связывает Figma, props и gates в одну модель |
| P1.2 | Visual cause grouping | сокращает число pixel-fix итераций |
| P1.3 | Evidence cache | исключает повторные запросы и ручные SHA manifests |
| P1.4 | Revision impact/partial recapture | резко ускоряет последующие правки больших families |

### 19.10. KPI следующего этапа

| KPI | Текущий наблюдаемый baseline | Цель |
|---|---:|---:|
| Клиентские операции для family 49 cases | около 100–150 + локальная агрегация | 1 job + status polling |
| Ручные matrix scripts на сложный component | 2–4 | 0 |
| Cases, снятые до font/asset readiness | возможны | 0 |
| Geometry failures без названного descendant/cause | возможны | 0 |
| Product blocks, ушедшие в TSX только из-за ограничений composition | регулярно | <10% |
| Повторные captures неизменившихся cases | до полного family rerun | <10%, кроме unknown impact |
| Acceptance runs с автоматически собранным SHA evidence | 0% | 100% |
| Время source-ready → actionable family verdict | десятки ручных шагов | <10 минут |

## 20. Карта evidence

### Общий статус

- [`MIGRATION_HANDOFF.md`](./MIGRATION_HANDOFF.md)
- [`REPORT.md`](./REPORT.md)
- [`BUILD_ORDER.md`](./BUILD_ORDER.md)

### API и capabilities

- [`artifacts/easy-ui/openapi-20260801.json`](./artifacts/easy-ui/openapi-20260801.json)
- [`artifacts/easy-ui/capabilities-latest.json`](./artifacts/easy-ui/capabilities-latest.json)

### Component churn

- [`notes/pay-button-group.md`](./notes/pay-button-group.md)
- [`notes/pay-timer.md`](./notes/pay-timer.md)
- [`artifacts/easy-ui/components/pay-button-group/v06/component-response.json`](./artifacts/easy-ui/components/pay-button-group/v06/component-response.json)
- [`artifacts/easy-ui/components/pay-timer/v05/component-response.json`](./artifacts/easy-ui/components/pay-timer/v05/component-response.json)

### Theme и probes

- [`artifacts/easy-ui/themes/v14/acceptance.json`](./artifacts/easy-ui/themes/v14/acceptance.json)
- [`artifacts/easy-ui/prototypes/ypv2-probe-atoms/rev-41/status-summary.json`](./artifacts/easy-ui/prototypes/ypv2-probe-atoms/rev-41/status-summary.json)
- [`artifacts/easy-ui/prototypes/ypv2-probe-molecules/rev-16/acceptance.json`](./artifacts/easy-ui/prototypes/ypv2-probe-molecules/rev-16/acceptance.json)

### Visual и interaction evidence

- [`notes/pay-button-group.md`](./notes/pay-button-group.md)
- [`notes/pay-banner.md`](./notes/pay-banner.md)
- [`notes/pay-timer.md`](./notes/pay-timer.md)
- [`artifacts/easy-ui/components/pay-banner/v01/interaction.json`](./artifacts/easy-ui/components/pay-banner/v01/interaction.json)
- [`artifacts/easy-ui/components/pay-timer/v05/contract-report.json`](./artifacts/easy-ui/components/pay-timer/v05/contract-report.json)

### Последний сложный family cycle

- [`MIGRATION_HANDOFF.md`](./MIGRATION_HANDOFF.md) — актуальная точка rev38 и ограничения acceptance
- [`artifacts/easy-ui/components/pay-payment-card/v00/draft-r37/acceptance-report.json`](./artifacts/easy-ui/components/pay-payment-card/v00/draft-r37/acceptance-report.json) — последняя полная 49-root pixel matrix
- [`artifacts/easy-ui/components/pay-payment-card/v00/draft-r37/geometry`](./artifacts/easy-ui/components/pay-payment-card/v00/draft-r37/geometry) — evidence blur-driven paint overflow
- [`artifacts/easy-ui/components/pay-payment-card/v00/props/manifest.json`](./artifacts/easy-ui/components/pay-payment-card/v00/props/manifest.json) — ручная связь 49 props cases с references/captures
- [`tools/verify-pay-payment-card-pixels.mjs`](./tools/verify-pay-payment-card-pixels.mjs) — локальная оркестрация, которую должен заменить matrix acceptance
- [`artifacts/easy-ui/components/pay-payment-card/v00/SHA256SUMS`](./artifacts/easy-ui/components/pay-payment-card/v00/SHA256SUMS) — вручную поддерживаемый evidence manifest

### Validation/reuse problems

- [`artifacts/easy-ui/components/pay-page-indicator/v01/publish-attempt-01-response.json`](./artifacts/easy-ui/components/pay-page-indicator/v01/publish-attempt-01-response.json)
- [`artifacts/easy-ui/components/pay-checkbox/v01/reuse-block.txt`](./artifacts/easy-ui/components/pay-checkbox/v01/reuse-block.txt)
- [`artifacts/easy-ui/components/pay-checkbox/v01/reuse-decision.json`](./artifacts/easy-ui/components/pay-checkbox/v01/reuse-decision.json)

---

Документ описывает product/DX changes на основе реального migration workflow. Он не предлагает ослаблять immutable versioning, reuse protection или visual gates. Цель — перенести проверку до активации, автоматизировать доказательства и сделать каждый accepted result воспроизводимым одной продуктовой операцией.
