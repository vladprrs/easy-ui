# Волна по фидбэку миграции Yandex Pay v2 (v2)

**Дата:** 2026-08-07 · **Источник:** `docs/EASYUI_MIGRATION_RETROSPECTIVE_20260807.md` (итоги миграции yandex-pay-v2: 55 активных компонентов, чистый аудит; 10 улучшений P0.1–P2.2).
**Статус:** v3 — после Stage 2, раунд 1 (3 линзы; 13 blocker + 27 major) и раунд 2 (дельта-верификация: 9/13 закрыто, 2 новых blocker N1/N3 + N2..N16; триаж обоих раундов — §5). Блокирующих возражений не осталось.
**Скоуп:** все 10 пунктов, порядок — §13 ретроспективы (подтверждено пользователем 2026-08-07).

Ретроспектива называет четыре повторяющихся класса потерь: geometry contract не различает четыре поверхности; readiness не гарантирует попадание ресурсов в первый кадр; unpublished dependency tree нельзя принять до первой публикации; publication tail — длинная ручная транзакция.

**Критерий волны (наследуется от feedback-3):** каждый фикс (а) декларативен (schema/capability/fingerprint), (б) инвалидирует ровно один слой каскада (frame → пересъёмка / comparison → re-diff / verdict → recompute), (в) едет с правкой трёх копий драйвера, `registerContract` + openapi + SDK, capability-флагом и changelog-абзацем.

## 0. Карта ретроспектива → волны

| # | Пункт | Волна | Слой инвалидации | Миграция |
|---|---|---|---|---|
| P0.1 | Geometry Contract v3 — четыре поверхности | **W1a** (схема + verdict/comparison) → **W1b** (rootBounds + clipExpectation) | comparison+verdict; кадры **не** инвалидируются (замер аддитивен, §1.1); доволновые кадры без факта → recompute-refuse → пересъёмка только затронутого кейса | v32 (W1a) |
| P0.2 | Deterministic resource barrier | **W2** | frame — профили приёмки, перешедшие на readiness v3 (правка `ACCEPTANCE_POLICIES`, §1.5) | — |
| P0.3 | Candidate dependency overlay | **W3** | frame (только кейсы с overlay; overlay-free — байт-в-байт) | v33 |
| P1.1 | Impact-driven gallery regression | **W5** | нет; `screenFrameFingerprint` — ключ reuse, не вход приёмки | v34 |
| P0.4 | Migration commit transaction | **W4** (после W5 — зависимость односторонняя) | нет (оркестрация поверх существующих мутаций) | v35 |
| P1.2 | Stable agent receipts (envelope) | **W6a** (каркас, первым в очереди driver.mjs) + **W6b** (per-verb summary, `--summary-json`) | нет | — |
| P1.3 | Typed cause + suggested policy | **W7** | нет (report-only) | — |
| P1.4 | Figma Source Package | **W8** | comparison (через `referenceAssetId` зависимых кейсов); `sourcePackageId` — metadata-only, ни в один отпечаток не входит | v36 |
| P2.1 | Runtime schema defaults | **W9** | candidate id двигается **через `sourceHash`** (флаг объявлен в исходнике — §1.6) | — |
| P2.2 | Service capture hygiene | **W10** | нет (receipt аддитивен) | — |
| — | Capabilities, compose, deploy-чеклист, changelog | **W11** | — | — |

Порядок исполнения: **W6a → W1a → W1b → W2 ∥ W10 → W3 → W5 → W4 → W6b → W7 → W8 → W9 → W11**. Миграции: v32 (W1a) → v33 (W3) → v34 (W5) → v35 (W4) → v36 (W8).

## 1. Ключевые решения

### 1.1. (a) `rootBounds` и `referenceExportDims` измеряются **безусловно**; `GEOMETRY_CONTRACT_VERSION` остаётся `2`; отпечатки не трогаются вовсе

Раунд 1 опроверг конструкцию v1 «`surface.rootBounds` как opt-in кадровый ключ» дважды: `CaseSurface` строится один раз на манифест и кладётся на весь ран (`surfaceOfManifest`, `caseSets.ts:76-85`; `orchestrator.ts:315/403/494`) — per-case opt-in через surface невозможен; и сам opt-in нарушал AC §3.4 («изменение только expected surface ⇒ не recapture») ровно на головном кейсе Payment Schedule. Механизм v2:

- **`rootBounds` измеряется всегда** (W1b): один дополнительный замер в `detailOf()` — дешёвый, не меняет PNG и не меняет семантику `layoutBounds` ⇒ `GEOMETRY_CONTRACT_VERSION` остаётся 2, **ни один вход `frameFingerprint` не добавляется**, golden не двигается. Определение (раунд 2, N1/N16; маркер — `span[display:contents]` без собственного бокса, `src/catalog/runtime.ts:25-45`): от маркера спускаемся **сквозь** цепочки `display:contents` (включая вложенные маркеры — та же ловушка, что уже обходит `visit()`, `geometry.mjs:436-446`) до первого поколения **боксовых** потомков; ровно один бокс ⇒ `rootBounds` = его border-box; ноль или ≥2 ⇒ `rootBounds = null` ⇒ вердикт поверхности `not-measured` (нулевой/вырожденный бокс никогда не публикуется как измерение). На viewport-поверхности (`rootSource:"overlay"`, деталь = `[data-eui-overlay-content]` — элемент со своим боксом) `rootBounds` = бокс самого элемента детали, без спуска. Определение фиксируется в контракте и покрывается фикстурами: вложенный маркер, Fragment-корень (≥2 боксов), overlay-деталь.
- **`referenceExportDims` пишутся гейтом геометрии безусловно** (W1b): гейт читает `assets.width/height` через `GateContext.db` (габариты уже в БД, `migrations.ts:93-101`) и кладёт в `metrics` в **CSS px** (= device px ассета ÷ `deviceScaleFactor`; нормализация — одна именованная функция; расхождение неразрешимо ⇒ `dimensions_irreconcilable`). Все `expectedSurfaces` объявляются в CSS px — фиксируется в схеме и docs.
- Доволновые кадры не имеют этих фактов. Точная цепочка (раунд 2, N2): декларация `expectedSurfaces.referenceExport`/`comparisonSurface` сдвигает `comparisonFingerprint` ⇒ строка reuse-кэша не находится вовсе ⇒ пересъёмка кейса приходит шагом 3 каскада (`recapture:policy_delta`, `runner.ts:570`), recompute не участвует. Для verdict-слойных деклараций (`root`/`layoutUnion`/`paint`/`clipExpectation`) работает recompute, и в `recomputeGeometry` вводится **явный новый отказ** «поверхность объявлена, факта в metrics нет ⇒ `null`» (существующий guard `layoutBounds === null` доволновой кадр пропускает насквозь — без нового отказа вердикт был бы выдан по несуществующим фактам; это отдельный AC + golden-тест W1a). Оговорка: per-surface вердикты существуют только при включённом geometry-гейте профиля (`gates.geometry: "not-implemented"` ⇒ поверхности не оцениваются — фиксируется в docs). Все кадры, снятые после W1b, несут факты, и дальнейшие правки ожиданий — чистый recompute/re-diff. AC §3.4 выполняется для всех кадров пост-W1b; для доволновых кадров первая декларация новой поверхности стоит пересъёмку одного кейса — фиксируется в changelog.
- `paint`/`layoutUnion` пересчитываемы из уже сохраняемых метрик (`gates/geometry2.ts:190-215` → `recompute.ts:252-286`) — verdict-слой, подтверждено ревью.

**Легаси-ветка вердикта сохраняется байт-в-байт, дискриминатор — только явная декларация.** Удаление раннего return `geometryPolicy.ts:225-232` меняло бы вердикты существующего корпуса через включённый по умолчанию recompute (`EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE=1` в compose) при замороженном `CASE_FINGERPRINT_ALGO_VERSION = 7` — reuse-кэш и свежая съёмка давали бы разные вердикты на одном отпечатке. Механизм (уточнён раундом 2, N3):
- `evaluateGeometryPolicy` ветвится по наличию `tolerances.expectedSurfaces` — поле заполняется **только** при явной декларации в манифесте; **легаси-вход исполняет прежний код с ранним return** (дифференциальный golden-тест на байт-идентичность результата), новый путь — per-surface вердикты. ALGO остаётся 7 честно: смысл легаси-входов не меняется.
- **Инвариант нормализации:** результат `expectedSurfacesOf` нигде не персистится и не входит ни в один хеш; `expectedSurfaces`/`comparisonSurface`/`clipExpectation` попадают в `VerdictPolicySnapshot`/`comparisonFingerprintOf` только условным спредом **при явной декларации** — доволновой кейс даёт байт-в-байт прежние `verdict_policy_hash`/`comparisonFingerprint` (иначе массовый вердиктный каскад корпуса — воспроизведение C-B3 с другой стороны). Легаси `expectedGeometry` остаётся собственным полем во всех существующих точках; нормализация используется только внутри нового пути (например, дефолт канвы).

**Нормализация** — одна именованная функция в новом `src/acceptance/surfaces.ts` (прецеденты `cropIsApplied`, `referenceSurfaceOf`): `expectedGeometry` → `{layoutUnion}`, `comparisonSurface = "layoutUnion"`. Одновременное объявление обоих — `422 case_surface_conflict`.

**Per-surface вердикты** (новый путь): `GeometryPolicyResult.surfaces: Partial<Record<Surface, {verdict: "clean"|"size-mismatch"|"not-measured", expected, observed, delta, tolerancePx}>>`, `divergingSurfaces[]` (порядок root→layoutUnion→paint→referenceExport), `clipSatisfied: boolean|null`. Классы не переименовываются; новые поверхности — класс `surface-mismatch`; `expectedGeometryDelta` сохраняется как проекция `surfaces.layoutUnion`. `geometryVerdictBlocks` (новая ветка) блокирует по любой расходящейся поверхности; `geometryCodes` — второй код `surface_mismatch` (`ref = <поверхность>`); допуск на поверхность — существующий `sizeDeltaPx` (per-case побеждает профиль), единый для всех поверхностей.

**`clipExpectation`** — только `"root-does-not-clip-layout"` (вариант `"root-clips-layout"` из v1 снят — сценария нет, триаж S-m3); семантика: `layoutUnion` может превышать `rootBounds` при отсутствии клипа по пути (проверка по clip-стеку `detailOf`); слой `["verdict"]` — кадрового эффекта больше нет (замер безусловный).

**Слои (раунд 2, N15 — расщепление по под-полям):** в хеши поле входит двумя проекциями: `expectedSurfaces.referenceExport` + `comparisonSurface` → **comparison** (re-diff); `expectedSurfaces.root|layoutUnion|paint` + `clipExpectation` → **verdict** (дешёвый recompute — правка ожидания root/paint не заставляет re-diff). Декларация `FIELD_LAYERS.expectedSurfaces = ["comparison","verdict"]` (объединение), реализация хеширования — по проекциям, `verdictPolicyDelta` сравнивает только verdict-проекцию; `comparisonSurface: ["comparison"]`, в `VerdictPolicySnapshot` не входит (триаж C-m1); тест каскада — на обе проекции.

**Канва сравнения:** `referenceCanvasOf` выбирает `layoutRoot` по `comparisonSurface` (расширение `layoutRootSource: "surface:<name>"`); для `referenceExport` — от нормализованных CSS-габаритов ассета; выравнивание — существующий `referencePlacement`, дефолт как сегодня; доволновые кейсы идут прежней веткой.

### 1.2. (b) Overlay: durable-приёмка графа — только на component case set; prototype/composition — диагностические поверхности; insertion в прототип не делается

Раунд 1 показал: «prototype-поверхность» v1 была покрыта только по названию — существующий `candidateOverrides` это pin **swap** опубликованного компонента (никогда не публиковавшийся компонент в прототип не вставить: `snapshotDefinitions` требует `status='active'`), и это осознанный отказ feedback-3 §1.1 (`docs/server-api.md:2085`), который **остаётся в силе**. Честный скоуп W3:

1. **Durable (единственная приёмочная поверхность): component case set.** Top-level поле манифеста `candidateOverlay: {"<componentId>": "cand_…"}` (≤ 8 узлов, `.optional()` без `.default()`; имя не коллидирует по коду с `CaptureExpected.candidateOverlay` прототипного пути — разные типы/неймспейсы, отмечено в docs; резолвнутый тип рана — `RunOverlayNode`). AC §5.1 («unpublished parent + unpublished deps одним acceptance run») выполняется так: parent = голова кандидата рана, deps = **overlay-дети в `slotBindings`**. Новая форма slot-ребёнка (раунд 2, N4/N5): `{ overlay: "<componentId>", props?: {...} }` — `props` как у обычного ребёнка (без них зависимость была бы вставима только пустой); резолв идёт **мимо** `publishedPinByNameAndVersion` (та не может вернуть неопубликованное — `caseSets.ts:1035-1057`), напрямую по `componentId` (`components.id`, с проверкой той же design system) + кандидат из `candidateOverlay`. Резолвнутый биндинг — кандидатная форма по образцу прототипного пути (`service.ts:687-698`): `ResolvedSlotBinding`/`FrameSlotBinding` расширяются условным спредом `candidate: {candidateId}`, поле `version` для кандидата **отсутствует** (conditional spread, не сентинел — сентинел исказил бы `slotsHash` и disjointness-проверку мультиран-promote); `bundleHash` — кандидатный; `slotsHash`/дедуп-ключи используют `candidateId` на месте версии. Отказ v1 `candidate_overlay_component_not_in_tree` для case-set-пути снят (триаж C-m9): дерево = голова + slotBindings, overlay-узлы обязаны быть на него замкнуты — незадействованный узел overlay = `422 candidate_overlay_unused` (иначе тихий сдвиг `frameFingerprint` без эффекта).
2. **Резолв в ране (durable):** при `createRun` overlay резолвится в `[{componentId, candidateId, rev, sourceHash, bundleHash}]` → `acceptance_runs.overlay_manifest_json` + `overlay_hash` (v33). **GC-пин:** `pinnedSourceHashes()` (`repo.ts:667-672`) расширяется джойном по `overlay_manifest_json` нетерминальных ранов — пин durable и переживает рестарт (in-memory лизы для этого непригодны — триаж C-M2); лизы остаются только у request-scoped превью. Протухший/выселенный кандидат при `createRun` — `409 candidate_overlay_expired` / `candidate_overlay_evicted` (триаж C-m8; контентная иммутабельность `cset_` не гарантирует живучесть референта — пересоздание кандидата повторной валидацией того же source, id детерминирован).
3. **Ephemeral (диагностика, без приёмки):** component preview, `POST /compositions/:id/preview-tree`, render-status принимают ту же карту как параметр запроса; ответ **эхом** несёт резолв узлов `{componentId, candidateId, rev, sourceHash, bundleHash}` (in-memory, не сохраняется) — частичное покрытие AC §5.2 на диагностических поверхностях. Прототипный `candidateOverrides` не меняется (swap-only, max 2). Composition-целей приёмка не существует в принципе (`server/acceptance/` не знает composition) — фиксируется в changelog как ограничение.

**Fingerprint:** `FrameFingerprintInput.candidateOverlay?` условным спредом; `FIELD_LAYERS.candidateOverlay = ["frame"]`; overlay-free — байт-в-байт, golden не двигается.

**Promote-верификация графа:** фаза A `promoteComponent` — каждый узел overlay каждого зачтённого рана опубликован сейчас с теми же `bundleHash`/`sourceHash` → `409 overlay_dependency_not_published` / `overlay_dependency_diverged`; мультиран — `422 overlay_hash_mismatch`.

**Kill-switch и rollback (триаж O-B3):** `EASYUI_CANDIDATE_OVERLAY_DISABLED=1`; rollback-window v33: пока окно отката открыто — overlay-раны не создавать (старый образ промоутит overlay-ран **без** верификации графа); после первого overlay-рана откат образа только вместе с восстановлением бэкапа тома (канон `docs/server-api.md:2240-2244`).

### 1.3. (c) Saga — серверное состояние + endpoints; идемпотентность и watchdog по существующим примитивам

Форма v1 сохраняется (серверная сага, драйвер — poller), с исправлениями раунда 1:
- **Идемпотентность:** `idempotency_key` — `NOT NULL` (обязателен в API; nullable UNIQUE в SQLite не ограничивает — триаж O-M8); in-flight — **partial unique index по позитивному списку активных фаз** (раунд 2, N10; прецедент `WHERE status IN ('queued','running')`): `migration_commits_one_in_flight ON migration_commits(component_id) WHERE phase IN ('preflight','promote','gallery-save','verify','impacted-regression','audit')`. Состояния `needs-*` — **не** блокируют (сага в них resumable через `advance`, но новый commit того же компонента допустим); добавляется терминальный `cancelled` и `POST /api/migration-commits/:id/cancel` — выход из любого `needs-*`. `maintenance_locks` не используется (одна глобальная строка, per-component lock невыразим — триаж O-M7).
- **Watchdog:** в сервере нет периодических таймеров — sweep зависших фаз исполняется на старте (`main.ts`, рядом с существующими sweep'ами) и на каждом запросе к `/api/migration-commits*` (триаж O-M7).
- Фазы: `preflight → promote → gallery-save → verify (status/geometry затронутых экранов) → impacted-regression → audit → complete` (фаза `verify` добавлена — триаж S-M2). W4 идёт **после** W5 (зависимость односторонняя — триаж S-M3); квитанция несёт `regressionMode: "impacted"|"full"`.
- **Честная граница KPI:** сага закрывает серверный хвост; агентские контрольные документы (`WORKFLOW_STATE.md`/`BUILD_ORDER.md` рабочего пространства координатора) сервер не пишет — драйвер сохраняет receipt-файл, обновление документов остаётся одной агентской операцией. KPI §14 формулируется «1 resumable server workflow + 1 агентская запись receipt», не «ноль ручных действий».
- Роуты гейтятся `EASYUI_ACCEPTANCE_MATRIX` (как остальная приёмка — триаж O-m13); kill-switch `EASYUI_MIGRATION_COMMIT_DISABLED`.

### 1.4. (d) Envelope: W6a (каркас) — первым в очереди driver.mjs; W6b (контракты summary) — после серверных волн

Порядок v1 («W6 целиком последним») перевёрнут наполовину (триаж S-M4): сигнатура `report(lines, payload, envelope)` и каркас envelope — **W6a, до W1** (механическая правка 43 call-site'ов — раунд 2, N12); тогда W3/W4/W5/W8 пишут свои новые verb'ы сразу в новой форме. Контракты `summary` per-verb и `--summary-json` — W6b, после серверных волн.

**Форма — вложенная** (раунд 2, N12: payload'ы уже содержат ключи `warnings`/`artifacts`/`...result` — плоский спред коллидирует): `--json`-вывод получает один новый top-level ключ `envelope: {schemaVersion:1, command, ok, summary, items, artifacts, warnings, nextActions}`; `--summary-json` печатает ровно этот объект — симметрия восстановлена (возражение v1 против вложенности снято). Уточнения N12: общий обработчик отказа (`driver.mjs:558`) берёт `command` из argv-verb'а; envelope существует только в json-режимах (текстовый режим — прежние строки; фиксируется в W6b); `exitCode` во всех verb'ах вычисляется до `report()` — `ok` выводим без переписывания логики (подтверждено ревью).

**Контракт `summary` определяется таблицей (триаж S-M5), минимум:**

| Verb | Обязательные поля summary |
|---|---|
| `accept` / `accept-status` | `runId, verdict, casesTotal, casesFailed, casesReused, topCauses[], revision` |
| `snap` | `captured, reused, cleanScreens, failedScreens, suppressedNoise` |
| `promote` | `version, rev, catalogRevision, candidateId, runsLinked` |
| `status` | `screensTotal, renderable, blocked[]` |
| `geometry` | `verdict, divergingSurfaces[], gaps` |
| `audit` | `exitCode, deprecatedInUse, unused` |
| `migration-commit` | `commitId, phase, phasesDone, regressionMode` |

Остальное как в v1: аддитивные поля рядом с payload; `ok === (exit === EXIT.ok)` тест-таблицей; verb'ы мимо `report()` (`design-system`, `get`) приводятся; `.json` всегда JSON, текст — `.txt` (+ абзац миграции путей существующих текстовых `.json`-квитанций — триаж S-m7).

### 1.5. (e) Readiness v3: точка правки — `ACCEPTANCE_POLICIES`, бюджет барьера суммарный, факт исполнения — эхом

Раунд 1 опроверг механизм v1 «`resolveCaptureMode` выдаёт v3»: acceptance-режим в `modes.ts` несёт лишь **дефолт** (v1!), реальная политика приходит из профиля рана (`server/acceptance/policies.ts:111` — `default-v1` → v1-readiness; `:134` — `pixel-strict-v1` → v2). Механизм v2:

- **Точка правки — `ACCEPTANCE_POLICIES`** (`policies.ts:105-140`): оба профиля получают `BARRIER_READINESS_POLICY` (v3 = strict + barrier). Таблица «профиль → readiness до/после»: `default-v1`: v1 → v3; `pixel-strict-v1`: v2 → v3. Reference-режим (`modes.ts`) — v2 → v3.
- **Последствия для promote — две оси (раунд 2, N7/N8):**
  (а) `policyProfileHash`: strict-режим (`EASYUI_PROMOTE_POLICY_STRICT`, `promote.ts:207`) сравнивает хеш **рана с хешем кандидата**, не с текущим профилем — доволновая пара «кандидат+ран» промоутится и под strict; ломается смешанная пара (доволновой ран + послеволновой кандидат). Правило деплоя: семья либо промоутится целиком по доволновым артефактам, либо целиком пересобирается (кандидат+раны) после W2.
  (б) `rendererFingerprint`: readiness-политика входит в него (`ids.ts:457-464`) ⇒ мультиран-promote, смешивающий до- и послеволновые раны, даст `422 acceptance_renderer_mismatch` — правило то же: набор ранов одной семьи пересъёмывается одной стороной волны. Оба правила — в deploy-чеклист (§W11).
- **Kill-switch:** `EASYUI_RESOURCE_BARRIER_DISABLED=1` возвращает **доволновую политику каждого профиля** (default→v1, strict→v2, reference→v2), не «всем v2».
- **Бюджет:** суммарный `barrierBudgetMs ≤ 8000` внутри страницы, отказ `resource_barrier_timeout` (`ref="<phase>:<resourceId>"`) поднимается **до** дедлайна джобы (`JOB_DEADLINE_MS = 60s` убивает процесс-группу — типизированный код иначе не доедет; триаж O-B2); `perResourceTimeoutMs` — производный.
- **Схема политики:** union `version: 1|2|3` (сейчас `1|2` — `readinessPolicy.ts:41`), ветка v3 в `isReadinessPolicy` (иначе молчаливая деградация в v1 — триаж C-M6), барьерные поля входят в `canonicalReadinessPolicy` (двигают хэш). Факт исполнения барьера едет **эхом** в `readiness.evidence.resourceBarrier` и обязателен для гейта: `readinessMet=true` без evidence-блока при v3-политике — refusal (иначе «флаг не доехал» неотличим от исполнения).
- **Словарь кодов:** `failureCodes.ts` — единственный словарь (расширить union + реестр эмитентов + `wave`); `WORKER_FAILURE_CODES` — три worker-level исхода, **не трогается** (в v1 заявлено несуществующее «зеркало» — триаж C-M5).
- **Галереи (триаж O-M4):** потеря registry-листов воспроизводилась на интерактивном пути (галереи снимаются `interactive` → v1). Прототипный screenshot-запрос получает опциональный `readiness: "barrier"` (v3 для этой джобы); драйверный `snap` шлёт его для service-галерей по умолчанию (`--no-barrier` для отката). Дефолт интерактивного режима (редактор/превью человека) остаётся v1.
- **AC §4.4 («identical resource fingerprint переиспользует barrier result») — сознательно сужен** (триаж S-M1): межкадровый прогретый кэш ресурсов (worker-scoped, с инвалидацией по реестру) — non-goal этой волны, фиксируется в changelog с ценой «барьер исполняется на каждом кадре, стоимость = `durationMs`×N»; смягчение — W5 (реже снимаем) и повторное использование browser-context в пуле. In-page мемо по `resourceManifestHash` — единственное переиспользование внутри кадра.
- **Стоимость и взаимодействие с feedback-3 (триаж O-M10):** после 2026-08-06 корпус приёмки и так ждёт полной пересъёмки (`geometryContractVersion`, deploy-SKILL:68). W2 выкатывается **до** амортизации той пересъёмки — платим один раз. Числовой гейт: 64 кейса × (≈6 с + барьер) < `runDeadlineMs` 30 мин ⇒ барьер ≤ ~20 с/кейс теоретический потолок, целевой ≤ 2 с/кейс; замер — локально на восстановленной копии прод-тома (staging нет; логические бэкапы case-set'ы не несут — триаж O-m15), go/no-go до деплоя.

### 1.6. (f) Defaults: candidate id двигается через `sourceHash`; kill-switch — аварийный и render-affecting

Исправления раунда 1 (триаж C-M9):
- Прецедент событий читается наоборот: `easyUiRuntime.tsx:104-110` на провале `safeParse` **не** делает fall-through — логирует и не доставляет событие. Для props контракт другой и фиксируется явно: провал парса ⇒ **raw props + warning** `runtime_props_parse_failed` в receipt (рендер важнее строгости).
- **`BuildFingerprintInput` не расширяется:** флаг `capabilities.runtimeSchemaDefaults` объявляется в исходнике компонента ⇒ уже учтён `sourceHash` ⇒ candidate id сдвигается сам. AC §11.2 («default semantics входят в candidate fingerprint») выполняется через `sourceHash`; history-блок `ids.ts` получает поясняющую запись без изменения кода.
- **Kill-switch `EASYUI_RUNTIME_DEFAULTS_DISABLED` — render-affecting** (меняет рендер, не входя в отпечатки — триаж O-m16): помечается аварийным; штатный откат флагнутого компонента — только републикация без флага; при включённом kill-switch приёмка флагнутых семей считается недействительной (в `accept-status` — предупреждение).
- Capability доступен серверу из `CandidateEntry.extracted.meta.capabilities` (`candidates.ts:74-94`); протяжка в нужные точки — явная под-задача W9.
- Аудит-warning `runtime_default_drift`: вычисление `safeParse({}).data` сегодня исполняется только для `layoutNeutral`-ветки (`extract-subprocess.ts:43-56`) — для сплошного аудита это **новая** работа в extract-subprocess (не переиспользование), плюс разовый скрипт «сколько компонентов дрейфуют» до волны.
- **Процедура перевода одного компонента (триаж S-M7):** (1) прогнать drift-скрипт по компоненту; (2) добавить флаг в source + удалить дублирующие `??`; (3) publish → новый candidate id (через sourceHash); (4) acceptance run семьи (кадры инвалидированы честно); (5) promote. Регресс «рендер не изменился» доказывается зелёной приёмкой, не PNG-сравнением вручную.

### 1.7. (g) Impact-selection: серверный endpoint; отпечаток экрана — кортеж handshake

Исправление раунда 1 (триаж C-M1): входы v1 не покрывали то, что сервер сам считает кадровым. `screenFrameFingerprint` = sha256 от **кортежа `CaptureExpected`** (`prototypeInstanceId, rev, componentManifestHash по подмножеству пинов экрана, builtinCatalogHash, designSystem, dsMetaVersion`) + `screenSpecHash` + `viewport/dsf/theme` + `readinessPolicyHash` + `rendererFingerprint` + **резолвнутая meta-версия темы per-screen** (раунд 2, N11: отдельного `themeContentHash` нет и не нужно — версии ДС иммутабельны/append-only, вход = `latestMetaVersion` из `getLatestDesignSystemContent` + версия spacing-резолвера; тема резолвится по ДС **поверхности экрана** (`themePinsOf`/`surfaceDesignSystem`), поэтому вход строго per-screen, не per-prototype — иначе мульти-ДС документы дают ложный reuse). Критерий недоказуемости (триаж C-m11): «использование по имени в JSON экрана» не отличает «нет компонента» от «есть транзитивно» — поэтому экран, содержащий хотя бы один элемент, чьё resolved-дерево не разворачивается полностью (композиция без inner-ключей, неразобранный бандл), — всегда `capture`. Retention (триаж O-m12): `prototype_screen_frames` хранит последние **5 ревизий** на прототип (sweep на записи), `receipt_json` ≤ 64 КБ.

## 2. Волны

### W1a. Geometry Contract v3 — схема, нормализация, per-surface вердикты (comparison/verdict слои) — миграция v32

**Контракт** (`src/acceptance/caseSetSchema.ts`, `caseSetCaseSchema`, всё `.optional()` без `.default()`):

```ts
expectedSurfaces: z.strictObject({
  root: surfaceDims.optional(), layoutUnion: surfaceDims.optional(),
  paint: surfaceDims.optional(), referenceExport: surfaceDims.optional(),   // все — CSS px
}).refine(v => Object.keys(v).length > 0).optional(),
comparisonSurface: z.enum(["root","layoutUnion","paint","referenceExport"]).optional(),
clipExpectation: z.literal("root-does-not-clip-layout").optional(),
```

Отказы: `422 case_surface_conflict`; `422 case_comparison_surface_undeclared`; `422 case_clip_expectation_requires_root`.

**Точки:**
1. `src/acceptance/surfaces.ts` — `expectedSurfacesOf`/`comparisonSurfaceOf` (§1.1).
2. `src/capture/geometryPolicy.ts` — ветвление легаси/новый путь (§1.1; легаси-ветка байт-идентична, golden-тест), `surfaces`/`divergingSurfaces`/`clipSatisfied`, новая ветка `geometryVerdictBlocks`.
3. `server/acceptance/gates/geometry2.ts` — проброс нормализованных поверхностей, код `surface_mismatch`, запись поверхностей в `geometry.json` и `metrics`.
4. `src/capture/failureCodes.ts` — `surface_mismatch` в словарь + реестр эмитентов + расширение `wave`-union (триаж C-M3а).
5. `server/acceptance/gates/visual.ts` `referenceCanvasOf` — выбор по `comparisonSurface`, `layoutRootSource: "surface:<name>"`; выравнивание через `referencePlacement`.
6. `server/acceptance/ids.ts` — `comparisonFingerprintOf` (+`expectedSurfaces`/`comparisonSurface` условным спредом), `VerdictPolicySnapshot` (+`expectedSurfaces`/`clipExpectation`; `comparisonSurface` — **не** входит), `FIELD_LAYERS`: `expectedSurfaces: ["comparison","verdict"]`, `comparisonSurface: ["comparison"]`, `clipExpectation: ["verdict"]`.
7. `server/acceptance/recompute.ts` — `VerdictPolicyField` + `verdictPolicyDelta` + `GATES_BY_POLICY_FIELD` (`expectedSurfaces: ["geometry","visual"]`, `clipExpectation: ["geometry"]`; `comparisonSurface` сюда не входит — comparison-слой); `recomputeGeometry` — per-surface из сохранённых метрик, отсутствие фактов ⇒ `null` (fall-through re-diff→recapture); фильтр переносимых кодов — по множеству кодов `geometryCodes`, не по одной строке `surface_overflow` (триаж C-M3б, `recompute.ts:300-302`).
8. `server/acceptance/caseSets.ts` (`buildCasesFromManifest`), `cases.ts`, `repo.ts`; `server/migrations.ts` **v32**: `ALTER TABLE acceptance_cases ADD COLUMN expected_surfaces_json TEXT` (nullable, без backfill; NULL = нормализация из `expectedGeometry`).

**Драйвер/зеркала:** `CASE_SET_CASE_KEYS` (`driver.mjs:2889`) + валидатор около `:2866` × 3 копии (поимённо: `.claude/skills/author/driver.mjs` — канон, `share/easy-ui-authoring-skill/driver.mjs`, `share/yp-figma-rebuild-skill/driver.mjs`; синхронизация `scripts/sync-share-skills.mjs`; `.claude/skills/deploy/` содержит **другой**, несинхронизируемый файл — триаж S-m4) + `driver-mjs.d.ts` + limits в capabilities.

**Тесты:** golden байт-идентичности легаси-ветки `evaluateGeometryPolicy`; Payment Schedule (root 343×88 / export 367×88 / unions 480×88, 558×88) — четыре вердикта; нормализация: доволновые манифесты — прежние `cset_`/`comparisonFingerprint`/`frameFingerprint` байт-в-байт (frame вообще не трогается); recompute per-surface; `422`-отказы; драйвер принимает/отклоняет.

**Done (AC §3, часть):** вердикт называет поверхность; легаси работает; смена ожидания ⇒ recompute/re-diff (для кадров с фактами). Полный AC §3 закрывается W1b.

### W1b. Geometry Contract v3 — безусловные замеры `rootBounds` + `referenceExportDims`, `clipExpectation`

**Точки:**
1. `src/capture/geometry.mjs` — `detailOf()` всегда возвращает `rootBounds` (определение §1.1: единственный элементный потомок маркера; иначе `null`); `GEOMETRY_CONTRACT_VERSION` остаётся 2 (аддитивный факт, семантика `layoutBounds` не меняется — прецедент подтверждён ревью); `geometry.d.mts`.
2. `server/acceptance/gates/geometry2.ts` — `GeometryFacts.rootBounds`; чтение `assets.width/height` через `GateContext.db` → `metrics.referenceExportDims` (CSS px, нормализация одной функцией). Три исхода (раунд 2, N6: колонки nullable): габариты есть ⇒ вердикт; габаритов у ассета нет ⇒ `not-measured`; есть, но неразрешимы против dsf ⇒ `dimensions_irreconcilable`.
3. `src/capture/geometryPolicy.ts` — `clipExpectation`-проверка по clip-стеку.
4. Прод-аудит (до деплоя, триаж O-M5): расширить `scripts/audit-geometry-contract.mjs` классом «expectedGeometry + allowPaintOverflow/expectedClip» и прогнать на восстановленной копии тома — перечень семей, чьи вердикты чувствительны к новой ветке (ожидание: ноль, т.к. легаси-ветка байт-идентична; аудит — доказательство).

**Тесты:** фикстура `display:contents`-маркера с одним корневым боксом — `rootBounds` измерен; с двумя корневыми — `not-measured`; e2e два overflow-кейса Payment Schedule проходят без waiver; корпус детерминизма (12×20) после правки `geometry.mjs`.

**Done (AC §3, полностью):** оба overflow-кейса без правки source и waiver; recompute/re-diff для пост-W1b кадров; доволновый кадр при первой декларации новой поверхности — пересъёмка одного кейса (зафиксировано в changelog).

### W2. Deterministic resource barrier (P0.2)

Механизм фазы `settleResourceBarrier` (manifest из computed styles + inline-SVG, preload, `document.fonts.ready` + decode + 2 стабильных кадра, диф manifest → `lateAfterBarrier[]`) — как в v1. Изменения по триажу:

- **Политики:** union `1|2|3`, ветка v3 в `isReadinessPolicy`, барьер в `canonicalReadinessPolicy`; `BARRIER_READINESS_POLICY`; **точка включения приёмки — `ACCEPTANCE_POLICIES`** (§1.5, таблица до/после); reference — `modes.ts`; галереи — opt-in `readiness:"barrier"` в screenshot-запросе + драйверный дефолт для service-галерей (`--no-barrier`).
- **Бюджет:** суммарный ≤ 8 с, отказ изнутри страницы до `JOB_DEADLINE_MS` (§1.5).
- **Коды:** `resource_barrier_timeout` / `resource_decode_failed` / `resource_late_after_barrier` (error) / `resource_manifest_overflow` — только в `failureCodes.ts` (словарь+реестр+wave); `WORKER_FAILURE_CODES` не трогается.
- **Receipt:** блок `resourceBarrier {expected, decoded, fontsReady, stableFrames, lateAfterBarrier[], durationMs}` в `readiness.evidence` (обязателен для гейта при v3 — §1.5) и в `CaptureReceiptResources`; заполнить `timings.*` + `barrierMs`.
- **Promote-взаимодействие:** правило деплоя про `EASYUI_PROMOTE_POLICY_STRICT` (§1.5) — в deploy-чеклист.
- **Kill-switch:** `EASYUI_RESOURCE_BARRIER_DISABLED` → доволновая политика каждого профиля.

**Файлы:** `readiness.ts`, `readinessPolicy.ts`, `failureCodes.ts`, `receipt.ts`, `scripts/screenshot-worker.mjs` (+pool), `server/capture/modes.ts`, `server/acceptance/policies.ts`, `server/routes/screenshots.ts` (opt-in параметр), `contracts.ts`, openapi, driver ×3 (`--no-barrier`, вывод блока), docs, `main.ts`.

**Тесты:** CSS background + inline-SVG `<image>` видимы барьеру; поздний ассет ⇒ `resource_late_after_barrier`, `met:false`; отказ до дедлайна джобы (суммарный бюджет); v3-политика без evidence-блока ⇒ refusal гейта; политика v3 не проходит старый `isReadinessPolicy` ⇒ тест новой ветки; e2e Card Input forced recapture (галерейный путь с `readiness:"barrier"`).

**Done (AC §4):** п.1–3 — прямые тесты; п.4 — сознательно сужен (§1.5, changelog). Гейт стоимости: замер на копии тома, целевой ≤ 2 с/кейс, go/no-go до деплоя.

### W10 (один PR/деплой-набор с W2). Service capture hygiene (P2.2)

Как v1: вынос capture-маршрутов из-под `AuthProvider` (второй top-level RouteObject рядом с обёрткой `routes.tsx:42-45` — триаж C-m4); `CaptureReceiptConsole.suppressed[{signature,count}]`; `CaptureQuality.suppressedCount`; драйвер — одна сводная строка. Примечание: «один деплой» W2+W10 — организационный (общие файлы), физического skew сервер/воркер не существует (один контейнер — триаж O-m14); реальная матрица совместимости — драйвер×сервер, см. §3.

### W3. Candidate dependency overlay (P0.3) — миграция v33

Контракт и семантика — §1.2. Сводно:
- Манифест: top-level `candidateOverlay` (≤8) + overlay-форма slot-ребёнка `{overlay: "<componentId>"}`; отказы `422 candidate_overlay_duplicate|limit|unused`, `409 candidate_overlay_expired|evicted`, promote `409 overlay_dependency_not_published|diverged`, `422 overlay_hash_mismatch`.
- Резолв мимо `publishedPinByNameAndVersion`; пин GC через `pinnedSourceHashes()`+`overlay_manifest_json`; ephemeral-поверхности — эхо резолва.
- v33: `acceptance_runs.overlay_manifest_json` + `overlay_hash`.
- Kill-switch `EASYUI_CANDIDATE_OVERLAY_DISABLED`; rollback-window правило (§1.2).
- Драйвер: `CASE_SET_TOP_LEVEL_KEYS` (`:2887`) + slot-ребёнок overlay-формы + `accept --overlay` ×3; `limits.caseSetMaxOverlayNodes: 8`.
- Принятая цена (триаж C-m10): overlay учитывается в `frameFingerprint` целиком — узел, не влияющий на конкретный кейс, всё равно сдвигает кадр; дедуп не строится.

**Тесты:** e2e «unpublished parent + 2 unpublished deps (nested slot) ⇒ один зелёный ран, receipt с хешами узлов»; `candidate_overlay_unused`; GC не выселяет overlay-кандидата нетерминального рана (рестарт сервера переживается); promote 409×2/ok/hash-mismatch; overlay-free — байт-в-байт; каталог неизменен; ревизия прототипа с неопубликованным типом — по-прежнему 422.

**Done (AC §5):** п.1 (case-set путь), п.2 (receipt рана; ephemeral — эхо), п.3, п.4 — тесты; ограничение по prototype/composition-поверхностям — явный абзац changelog (§1.2).

### W5. Impact-driven gallery regression (P1.1) — миграция v34

Как v1 плюс триаж: `screenFrameFingerprint` — кортеж `CaptureExpected` + `themeContentHash` (§1.7); критерий «не разворачивается ⇒ capture»; retention 5 ревизий; таблица `prototype_screen_frames` (v34). `POST /api/prototypes/:id/snap-plan` (гейт `EASYUI_ACCEPTANCE_MATRIX` не нужен — работает и без матрицы, но требует `EASYUI_IMPACTED_SNAP` capability-флага; kill-switch `EASYUI_IMPACTED_SNAP_DISABLED`). Драйвер `snap --impacted`/`--full` ×3; сервер деплоится раньше драйвера.

**Тесты:** addition-only ⇒ 1 capture + 42 proven-reuse; изменение PayButton ⇒ только его экраны; смена токена темы (unpinned head) ⇒ все capture (тест на `themeContentHash`); смена renderer ⇒ все capture; неразворачиваемый экран ⇒ capture; `--full` без плана.

**Done (AC §7):** все три пункта; KPI «recaptured ≤ new + impacted».

**Execution-триаж W5 (2026-08-07, принято при реализации):** (1) `rev` НЕ входит в хеш кадра (остался колонкой строки/квитанции) — буквальное вхождение `rev` в кортеж §1.7 противоречило AC волны «addition-only ⇒ 1 capture + N proven-reuse» (любое сохранение делало бы все экраны недоказуемыми); пиксельную информацию покрывают `screenSpecHash` + пин-подмножество + `builtinCatalogHash` + тема; вместо него в кортеж добавлен `screenId`. (2) Отдельного env-гейта `EASYUI_IMPACTED_SNAP` нет — фича включена по умолчанию, объявлена `features.impactedSnap`, выключается `EASYUI_IMPACTED_SNAP_DISABLED=1` (прецедент `EASYUI_VALIDATE_DISABLED`). (3) PK `prototype_screen_frames` включает fingerprint (одна ревизия экрана легитимно снимается в нескольких условиях — light/dark, viewport'ы). (4) `limits.snapPlanMaxScreens = 256`, отказ `snap_plan_too_many_screens`. (5) Kill-switch гейтит и роут, и запись кадров (откат образа в окне v34 не пишет в несуществующую таблицу).

### W4. Migration commit transaction (P0.4) — миграция v35

Как v1 плюс триаж (§1.3): фаза `verify`; `idempotency_key NOT NULL` + partial unique in-flight по `component_id`; watchdog на старте + на запросах; `regressionMode` в квитанции; гейт `EASYUI_ACCEPTANCE_MATRIX`; честная граница KPI. API/фазы/квитанция/dry-run — как v1. v35: таблица `migration_commits` (без nullable-ключа идемпотентности).

**Тесты:** как v1 + «watchdog переводит зависшую фазу в `needs-*` при следующем запросе»; «параллельный commit другого компонента не блокируется» (per-component lock).

### W6a. Envelope-каркас (первым в очереди driver.mjs)

Сигнатура `report(lines, payload, envelope)` (envelope.ok обязателен), каркас `{schemaVersion:1, command, ok, summary:{}, items, artifacts, warnings, nextActions}` аддитивно, механическая правка всех ~44 call-site'ов, приведение `design-system`/`get` к `report()`. Тест-таблица `ok ↔ exit` по всем verb'ам. ×3 копии + `driver-mjs.d.ts` + `driver-cli.test.ts`.

### W6b. Envelope-контракты (P1.2, после серверных волн)

Таблица summary per-verb (§1.4), `--summary-json`, `.json`/`.txt` правило + миграция путей, документация схемы в SKILL.md + зеркалах, `features.receiptEnvelopeVersion: 1`.

**Done (AC §8):** один envelope у 6 verb'ов; summary достаточен (проверяется сценарными тестами по таблице §1.4); версия документирована; exit ↔ ok.

### W7. Typed cause + suggested policy (P1.3)

Как v1 с исправлениями:
- **Размещение:** `suggestPolicy` живёт на стороне приёмки — `server/acceptance/suggest.ts` (не в `causes.ts`: пресеты в `gates/visual.ts` импортируют `CAUSE_THRESHOLDS` из `causes.ts` — цикл; триаж C-M7). `causes.ts` остаётся листом.
- **Reused-строки:** причины у reused-строк **пересчитываются** (`runner.ts:601-604`), не удаляются насовсем — `suggestedPolicy` пересчитывается вместе с ними; тест v1 «reused без suggestedPolicy» снят (триаж C-M8), заменён тестом «suggestedPolicy reused-строки консистентен пересчитанным причинам».
- **Expiry (AC §9.3) — advisory-форма** (триаж S-M8): durable-хранилища принятых исключений не существует (per-case бюджеты живут в контентно-адресованных манифестах); механизм — `accept-status` предупреждает `policy_exception_stale`, когда `renderer_fingerprint` текущего рана ≠ fingerprint рана, в котором кейс с `textAaBudget`/per-case бюджетом впервые прошёл (данные есть: `acceptance_runs.renderer_fingerprint`, v30). **Baseline — только пост-W2 раны** (раунд 2, N8: W2 сдвигает `rendererFingerprint` через readiness-политику — сравнение с доволновым раном дало бы ложный stale на всех кейсах с бюджетом на весь период пересъёмки). AC §9.3 покрывается в advisory-форме — фиксируется в changelog.
- Отказ от предложения при структурной топ-причине; группировка `remediationKey`; report-only; kill-switch — как v1.

### W8. Figma Source Package (P1.4) — миграция v36

Как v1 плюс триаж:
- Валидация provenance (триаж S-m6): согласованность `fileKey`/принадлежность `nodeId` пакету/`componentKeys`; dims/SHA как v1.
- v36: `figma_source_packages.design_system` — `REFERENCES design_systems(id)` + запись в список `assertRegistryIntegrity` (триаж O-m11).
- `figmaSchema.sourcePackageId` — **metadata-only**, ни в один отпечаток не входит (явно; триаж S-M11).
- **Reuse search** (триаж S-M6): под-задача — component key + semantic role из пакета как сигналы `server/catalog/matcher.ts` (ранжирование, не гейт).
- Skeleton, preflight `missing_exact_reference`, дедуп — как v1.

### W9. Runtime schema defaults (P2.1)

Контракт §1.6 (исправленный): без правки `BuildFingerprintInput`; протяжка capability из `CandidateEntry.extracted.meta.capabilities`; drift-аудит — новая работа + разовый скрипт; процедура перевода компонента (5 шагов); kill-switch аварийный render-affecting (Rollback policy).

**Тесты:** `.default("md")` + флаг ⇒ `{}` = contract parse; без флага байт-в-байт; невалидные props ⇒ raw + warning; сдвиг candidate id при добавлении флага (через sourceHash) — дифференциальный тест.

### W11. Capabilities, compose, deploy-чеклист, changelog

- `features`: `geometrySurfacesV3`, `resourceBarrier`, `candidateDependencyOverlay`, `migrationCommit`, `impactedSnap`, `suggestedPolicy`, `figmaSourcePackage`, `runtimeSchemaDefaults`, `captureNoiseSummary`, `receiptEnvelopeVersion: 1`; `acceptance`: `geometryContractVersion: 2` (не 3 — §1.1), `readinessPolicyVersion: 3`, `comparisonSurfaces: [...]`; `limits`: `caseSetMaxOverlayNodes: 8`, `prototypeCandidateOverlayMax: 2`, `sourcePackageMaxExports: 256`, `snapPlanMaxScreens`, `migrationCommitPhaseTimeoutMs`, `resourceBarrierMaxResources: 256`, `resourceBarrierBudgetMs: 8000`.
- **`docker-compose.yml`:** строки `EASYUI_X: ${EASYUI_X:-}` для всех kill-switch'ей волны, поимённо (раунд 2, N14): `EASYUI_GEOMETRY_SURFACES_DISABLED` (W1, новый путь вердикта → легаси-ветка), `EASYUI_RESOURCE_BARRIER_DISABLED`, `EASYUI_CANDIDATE_OVERLAY_DISABLED`, `EASYUI_IMPACTED_SNAP_DISABLED`, `EASYUI_MIGRATION_COMMIT_DISABLED`, `EASYUI_SUGGESTED_POLICY_DISABLED`, `EASYUI_SOURCE_PACKAGE_DISABLED`, `EASYUI_RUNTIME_DEFAULTS_DISABLED` — 8 штук (без compose-строки env в контейнер не попадает — триаж O-M6).
- **`.claude/skills/deploy/SKILL.md`:** секция волны со смоук-ключами (`features.*`, `acceptance.readinessPolicyVersion: 3`, `geometryContractVersion: 2` — «не 3, это не дефект»), правило про `EASYUI_PROMOTE_POLICY_STRICT` (§1.5), rollback-window абзацы по каждой миграции (§3), именованные бэкапы `.backups/prod-<волна>`.
- Changelog `docs/server-api.md`: абзац на capability + таблица флагов + слой инвалидации на поле + три зафиксированных отказа/ограничения: (1) `GEOMETRY_CONTRACT_VERSION` не поднимается; (2) документ прототипа с кандидатным пином недоступен, prototype-overlay — swap-only, composition-приёмки не существует; (3) AC §4.4 — межкадровый barrier-кэш non-goal.
- Верификация: `npm run verify` + `npm run e2e` на каждой волне; runtime `/verify`; корпус детерминизма после W1b/W2; замер барьера (go/no-go).
- **KPI-проводка (§14, скорректирована — триаж S-m1/m2):** revisions → `summary.revisions` (агрегация — скрипт по client-cache links, baseline фиксируется до волны); typedCausePct (W7); `resource_late_after_barrier` при `met:true` недостижим по построению (W2); captured/reused (W5); «1 server workflow + 1 агентская запись» (W4, §1.3); schema-discovery = 0 (`--summary-json`, W6b); невыразимых поверхностей = 0 (W1); KPI «преждевременных публикаций = 0» — прокси-метрика v1 снята, измеряется вручную по BUILD_ORDER координатора (доля lane'ов, где leaf публиковался только ради родителя).

## 3. Параллелизация, сериализация, инварианты деплоя

**Честная параллель одна, с оговоркой по драйверу** (триаж S-B4 + раунд 2, N9): **A** (W6a → W1a → W1b → W3 → W5 → W4 → W6b → W7 → W8 → W9) ∥ **B** (W2 → W10 — капчур-контур, общий `receipt.ts`) — параллельны **только по серверным/капчур-файлам**. Драйверные кусочки W2/W10 (`--no-barrier`, вывод блока барьера, сводная строка шума) выделяются в отдельную мелкую задачу и встают в единую очередь `driver.mjs` (см. таблицу) — сам серверный контур B их не ждёт. Пересечение по `failureCodes.ts` сериализуется W1a → W2. Остальное — очередь; заявленный в v1 «параллелизм группы D» снят.

**Сериализация файлов:**

| Файл | Порядок |
|---|---|
| `driver.mjs` ×3 + `sync-share-skills.mjs` | **W6a** → W1a → W2/W10-драйверная задача → W3 → W5 → W4 → W6b → W7 → W8 |
| `caseSetSchema.ts` | W1a → W3 |
| `server/acceptance/ids.ts` | W1a → W3 (W9 не трогает — §1.6) |
| `server/acceptance/caseSets.ts` | W1a → W3 → W8 |
| `cases.ts` / `repo.ts` | W1a → W3 |
| `recompute.ts` | W1a |
| `src/capture/geometry.mjs` | W1b |
| `src/capture/failureCodes.ts` | W1a → W2 |
| `src/capture/receipt.ts` + схема | W2 → W10 → W9 |
| `server/acceptance/policies.ts` | W2 |
| `promote.ts` | W3 → W4 |
| `runner.ts` | W1a → W7 |
| `server/main.ts` (kill-switch'и, sweep) | по волне за раз: W2 → W3 → W5 → W4 → W7 → W8 → W9 |
| `server/migrations.ts` | v32 → v33 → v34 → v35 → v36, по волне |
| `routes/meta.ts`, `contracts.ts`/openapi/sdk, `docs/server-api.md`, `SKILL.md`+зеркала | по волне за раз; финализирует W11 |

**Совместимость драйвер × сервер** (заменяет вакуумный инвариант v1 «W2+W10 один деплой» — триаж O-m14): сервер всегда деплоится раньше раскатки драйвера той же волны; старый драйвер × новый сервер — работает (поля аддитивны); новый драйвер × старый сервер — новые verb'ы/поля дают `404`/`422 validation_failed` с понятным сообщением (тест на каждый новый verb).

**Инварианты деплоя:**
1. W1a и W1b — можно одним деплоем; прод-аудит W1b (§W1b.4) — до него.
2. W2 — до амортизации пересъёмки feedback-3 (§1.5); замер барьера go/no-go; проверить `EASYUI_PROMOTE_POLICY_STRICT` выключен на окно пересъёмки.
3. W3 — rollback-window правило (§1.2): overlay-раны не создавать, пока откат образа возможен без восстановления тома.
4. W5 — сервер раньше драйвера `--impacted`.
5. Сборка на прод-сервере запрещена; деплой — `/deploy` по явной команде пользователя; перед каждой миграцией — именованный бэкап тома (`.db`+`-wal`+`-shm` + `DATA_DIR/assets/` — один объект).
6. Rollback-window по миграциям (в deploy-чеклист): v32 — не персистить манифесты с `expectedSurfaces` в окне; v33 — §1.2; v34 — безопасна (quитанции игнорируются старым кодом); v35 — не запускать саги в окне; v36 — не загружать пакеты и не ссылаться `sourcePackageId` в окне.

**Сквозные инварианты** — как v1 (без изменений): `.optional()` без `.default()`; conditional spread, `GOLDEN_FRAME` не двигается, ALGO остаётся 7 (легаси-семантика не меняется — §1.1); тест каскада на `caseFingerprintsOf` для каждого нового поля; `src/` не импортирует `server/`, `src`↔`scripts/*.mjs` тест-асертится; драйвер ×3 + d.ts + limits + тест в той же волне; `registerContract`+openapi+SDK+docs в той же волне; kill-switch — `main.ts` + compose-строка.

## 4. Верификация (сводно)

- Каждая волна: `npm run verify` + `npm run e2e`; для схемных волн — регресс байт-идентичности хешей и golden-вердиктов доволновых манифестов.
- Финал: runtime `/verify`; корпус детерминизма после W1b/W2; e2e-сценарии Done-критериев (Payment Schedule W1, Card Input W2, unpublished-граф W3, kill/resume саги W4, 1+42 план W5, смена токена темы W5).
- KPI §14 — проводка §W11.

## 5. Триаж находок Stage 2 (раунд 1)

Ревью: 3 линзы (корректность C, скоуп/AC S, миграции/опс O); 13 blocker, 27 major, 18 minor.

**Принято (вошло в v2):**
- C-B1/C-B2/S-B3 → безусловный замер `rootBounds`, отказ от frame-ключа и от opt-in (§1.1); C-B3 → легаси-ветка вердикта байт-в-байт, ALGO 7 честно; C-B4/C-B5 → `referenceExportDims` в metrics безусловно, CSS px; C-B6 → overlay-форма slot-ребёнка мимо `publishedPinByNameAndVersion`; C-M2 → durable-пин через `pinnedSourceHashes`; C-M3 → `failureCodes.ts` в W1a, фильтр recompute по множеству; C-M4/O-B1 → точка правки `ACCEPTANCE_POLICIES`, таблица до/после, promote-strict правило; C-M5 → словарь единый, WORKER_FAILURE_CODES не трогается; C-M6 → union 1|2|3, ветка isReadinessPolicy, evidence-эхо обязателен; C-M7 → `suggestPolicy` в `server/acceptance/suggest.ts`; C-M8 → reused-строки пересчитывают suggestion; C-M9/O-m16 → отказ от правки BuildFingerprintInput (sourceHash), kill-switch W9 аварийный; C-M1 → кортеж CaptureExpected + themeContentHash; C-m1 → comparisonSurface только comparison; C-m8/m9/m10/m11 → отказы expired/evicted, unused вместо not-in-tree, принятая цена fingerprint, критерий неразворачиваемости; O-B2 → суммарный бюджет барьера ≤8с; O-B3 → kill-switch W3 + rollback-window; O-M4 → галерейный opt-in `readiness:"barrier"`; O-M5 → аудит-класс + доказательство неизменности легаси-вердиктов; O-M6 → compose-строки + deploy-чеклист + смоук-ключи; O-M7/O-M8 → NOT NULL ключ, partial unique per-component, watchdog на старте+запросах; O-M9 → rollback-window по всем миграциям; O-M10 → W2 до амортизации feedback-3, числовой гейт; O-m11..m16 → FK v36, retention v34, гейт матрицей, матрица драйвер×сервер, замер на копии тома, откат W9; S-B1/S-B2 → честный скоуп overlay-поверхностей + эхо-receipt + changelog; S-B4/S-M4 → параллелизация переписана, W6a первым; S-M2 → фаза verify, честная граница KPI; S-M3 → W5 перед W4; S-M5 → таблица summary; S-M6 → reuse-search под-задача W8; S-M7 → процедура перевода W9; S-M8 → expiry advisory; S-M10 → W1a/W1b сплит; S-M11 → доопределены clipExpectation/tolerance/выравнивание/бюджет барьера/screenSpecHash/скелет; S-m1..m7 → KPI-проводка, root-clips-layout снят, копии драйвера поимённо, строки сериализации, provenance-валидация, .txt-миграция; C-m3..m6 → номера строк/ключей исправлены.
- S-M1/M9 (частично): AC §4.4 сужен явно (changelog), shadow-режим W2 отклонён — вместо него явная цена + ранний деплой (§1.5).

**Раунд 2 (дельта-верификация v2; статусы блокеров раунда 1: 9 закрыто, C-B3 и S-B4 закрыты только правками v3 ниже):**
- N1/N16 (blocker) → определение `rootBounds`: спуск сквозь `display:contents`/вложенные маркеры до первого поколения боксовых потомков; overlay-деталь — собственный бокс; вырожденный бокс не публикуется (§1.1).
- N3 (blocker) → инвариант нормализации: `expectedSurfaces` в хеши только условным спредом при явной декларации, результат нормализации не персистится, дискриминатор — `tolerances.expectedSurfaces` (§1.1).
- N2 → точная цепочка каскада (comparison-декларация ⇒ шаг 3 `recapture:policy_delta`; verdict-декларация ⇒ явный новый отказ recompute «поверхность объявлена, факта нет» как AC + golden); оговорка про `gates.geometry: not-implemented` (§1.1).
- N4/N5 → overlay-ребёнок несёт `props`; резолв напрямую по `componentId`; кандидатная форма `FrameSlotBinding` без сентинела версии, `candidateId` в `slotsHash`; имя `RunOverlayNode` (§1.2).
- N6 → третий исход `not-measured` при nullable-габаритах ассета (§W1b.2).
- N7/N8 → две оси promote-правила (пары «кандидат+ран» и `acceptance_renderer_mismatch`), baseline advisory W7 — пост-W2 (§1.5, §W7).
- N9 → параллель A∥B только по серверным файлам; драйверные кусочки W2/W10 — отдельная задача в очереди driver.mjs (§3).
- N10 → позитивный список активных фаз в partial index; `needs-*` не блокирует; `cancelled` + `POST …/cancel` (§1.3).
- N11 → вместо `themeContentHash` — резолвнутая meta-версия per-screen ДС поверхности + версия spacing-резолвера (§1.7).
- N12 → envelope — вложенный объект `envelope:{…}`; `--summary-json` печатает его же (симметрия); command из argv на общем отказе; 43 call-site'а; envelope только в json-режимах (§1.4).
- N14 → kill-switch'и выписаны поимённо, 8 штук, включая новый `EASYUI_GEOMETRY_SURFACES_DISABLED` (§W11).
- N15 → расщепление слоёв `expectedSurfaces` по под-полям: referenceExport→comparison, root/layoutUnion/paint→verdict (§1.1).
- N13 → номера строк исправлены по тексту.

**Отклонено (с обоснованием):**
- S-B3-альтернатива «recapture только по явному `--recapture`» — противоречит автоматическому каскаду (`recapture:policy_delta` — существующий контракт); принят вариант «пересъёмка одного кейса через существующий fall-through».
- O-m14-буквально «отменить один деплой W2+W10» — набор остаётся одним PR-пакетом по общим файлам, но обоснование заменено (организационное, не skew).
- S-M9 «shadow-режим барьера» — двойная стоимость съёмки и третий вариант политики; вместо этого числовой go/no-go гейт и kill-switch.
- C-m2 — снята вместе с причиной (кадрового флага больше нет).

## Риски (сводно)

R1 (W1a) — расхождение легаси-ветки вердикта: golden-тест байт-идентичности — гейт волны. R2 (W1b) — `rootBounds` при множественных корневых боксах: `not-measured`, не угадывание. R3 (W2) — стоимость барьера: замер go/no-go, суммарный бюджет. R4 (W2) — data-URI/внешние URL: cap + `resource_manifest_overflow`. R5 (W3) — GC/рестарт: durable-пин, тест с рестартом. R6 (W3) — overlay × nested slots: лимиты до резолва. R7 (W4) — зависшие фазы: watchdog на запросах. R8 (v33/v35) — rollback-window: правила §3.6. R9 (W5) — ложный reuse: кортеж CaptureExpected + themeContentHash + критерий неразворачиваемости; недоказанный reuse = capture. R10 (W6a) — 44 call-site'а одним механическим коммитом с тест-таблицей. R11 (W9) — kill-switch render-affecting: аварийный, процедура републикации. R12 — пять миграций: своя волна, свой бэкап, свой rollback-абзац.
