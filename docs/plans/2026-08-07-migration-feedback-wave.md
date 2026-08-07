# Волна по фидбэку миграции Yandex Pay v2 (v1)

**Дата:** 2026-08-07 · **Источник:** `docs/EASYUI_MIGRATION_RETROSPECTIVE_20260807.md` (итоги миграции yandex-pay-v2: 55 активных компонентов, чистый аудит; 10 улучшений P0.1–P2.2).
**Статус:** v1 — до Stage 2 (адверсариальное ревью).
**Скоуп:** все 10 пунктов, порядок — §13 ретроспективы (подтверждено пользователем 2026-08-07).

Ретроспектива называет четыре повторяющихся класса потерь: geometry contract не различает четыре поверхности; readiness не гарантирует попадание ресурсов в первый кадр; unpublished dependency tree нельзя принять до первой публикации; publication tail — длинная ручная транзакция.

**Критерий волны (наследуется от feedback-3):** каждый фикс (а) декларативен (schema/capability/fingerprint), (б) инвалидирует ровно один слой каскада (frame → пересъёмка / comparison → re-diff / verdict → recompute), (в) едет с правкой трёх копий драйвера, `registerContract` + openapi + SDK, capability-флагом и changelog-абзацем.

## 0. Карта ретроспектива → волны

| # | Пункт | Волна | Слой инвалидации | Миграция |
|---|---|---|---|---|
| P0.1 | Geometry Contract v3 — четыре поверхности | **W1** | comparison+verdict у объявивших; frame только у кейсов с `expectedSurfaces.root`/`clipExpectation` | v32 |
| P0.2 | Deterministic resource barrier | **W2** | frame — только профили `readiness.version:3` (acceptance/reference) | — |
| P0.3 | Candidate dependency overlay | **W3** | frame (только кейсы/превью с overlay; overlay-free — байт-в-байт) | v33 |
| P0.4 | Migration commit transaction | **W4** | нет (оркестрация поверх существующих мутаций) | v34 |
| P1.1 | Impact-driven gallery regression | **W5** | нет; `screenFrameFingerprint` — ключ reuse, не вход приёмки | v35 |
| P1.2 | Stable agent receipts (envelope) | **W6** | нет (только вывод CLI, аддитивно) | — |
| P1.3 | Typed cause + suggested policy | **W7** | нет (report-only производная сохранённых метрик) | — |
| P1.4 | Figma Source Package | **W8** | comparison (через `referenceAssetId` зависимых кейсов) | v36 |
| P2.1 | Runtime schema defaults | **W9** | candidate fingerprint — только у компонентов с флагом | — |
| P2.2 | Service capture hygiene | **W10** | нет (receipt аддитивен) | — |
| — | Capabilities, changelog, финальная верификация | **W11** | — | — |

Порядок исполнения: **W1 → W2 ∥ W10 → W3 → W4 → W5 → W6 → W7 → W8 → W9 → W11** (детали параллелизации — §3).

## 1. Ключевые решения

### 1.1. (a) Поверхности — opt-in, `GEOMETRY_CONTRACT_VERSION` остаётся `2`

Bump до 3 = полная пересъёмка прод-корпуса (feedback-3 W2 платил её потому, что менялась семантика существующего `layoutBounds`; здесь она не меняется: `layoutUnion` = сегодняшний `layoutBounds`, `paint` = сегодняшний ink-bbox). Прецедент opt-in без bump — `overlayAwareRoot` (W5 feedback-3).

Разделение по цене замера:
- **`paint`** — уже в фактах → verdict-слой, recompute без пересъёмки;
- **`referenceExport`** — не браузерная величина: габариты эталонного ассета (уже в `sourceDims`/`refDims` visual-гейта) → comparison-слой (re-diff);
- **`layoutUnion`** — сегодняшний `layoutBounds` → verdict-слой;
- **`root`** — единственный новый браузерный замер: узкий кадровый ключ `surface.rootBounds?: true` условным спредом в `CaseSurface`, **только** когда кейс объявил `expectedSurfaces.root` или `clipExpectation`. Такой кейс пересъёмывается один раз; остальные — байт-в-байт прежние `frameFingerprint`.

AC «изменение только expected surface ⇒ recompute/rediff, не recapture» выполняется буквально: меняются числа ожиданий (verdict/comparison), не набор измеряемых поверхностей (frame).

**Легаси-нормализация — одна именованная функция** (прецеденты `cropIsApplied`, `referenceSurfaceOf`) в новом `src/acceptance/surfaces.ts`:

```ts
expectedSurfacesOf({expectedSurfaces?, expectedGeometry?}): NormalizedSurfaces
comparisonSurfaceOf(input): "root" | "layoutUnion" | "paint" | "referenceExport"
```

Легаси: `expectedGeometry` → `{layoutUnion}`, `comparisonSurface = "layoutUnion"`. Одновременное объявление `expectedGeometry` **и** `expectedSurfaces` — `422 case_surface_conflict`.

**Per-surface вердикты.** `GeometryPolicyResult` расширяется (`surfaces: Partial<Record<Surface, {verdict: "clean"|"size-mismatch"|"not-measured", expected, observed, delta, tolerancePx}>>`, `divergingSurfaces[]` в порядке root→layoutUnion→paint→referenceExport, `clipSatisfied: boolean|null`); ранний return по `expectedGeometry` в `geometryPolicy.ts:~215` удаляется. Классы вердикта не переименовываются (лежат в сохранённых `geometry.json`): для новых поверхностей — новый класс `surface-mismatch`; `expectedGeometryDelta` сохраняется как проекция `surfaces.layoutUnion` (доволновые читатели не ломаются). `geometryVerdictBlocks` блокирует по любой расходящейся поверхности; `geometryCodes` — второй код `surface_mismatch` c `ref = <поверхность>`.

**Разрыв связки канвы с layout union:** `referenceCanvasOf` (`server/acceptance/gates/visual.ts:~179`, сейчас `layoutRoot = expectedGeometry ?? facts.layoutBounds`) выбирает источник по `comparisonSurface`; `layoutRootSource` расширяется значениями `"surface:<name>"`, доволновые кейсы идут прежней веткой. Поэтому `expectedSurfaces`/`comparisonSurface` — двухслойные поля, как `expectedGeometry`.

### 1.2. (b) Overlay: иммутабельный inline-манифест в case set + материализованный резолв в ране; request-scoped — только превью

Отдельная сущность `ovl_<sha>` отвергнута: case-set'ы контентно-адресованы (`cset_` = хеш `parsed.data`) → inline-overlay иммутабелен по построению; второй реестр = дублирование жизненного цикла и второе место GC-пинов.

Три уровня:
1. **Декларация (durable):** top-level поле манифеста (не per-case — overlay описывает граф зависимостей цели): `"candidateOverlay": {"<componentId>": "cand_…"}`, ≤ 8 узлов. Ключ — `componentId` (имя не уникально между DS). Строго `.optional()`, без `.default()`.
2. **Резолв (durable, в ране):** при `createRun` overlay резолвится в `[{componentId, candidateId, rev, sourceHash, bundleHash}]` (сортировка по componentId) → `acceptance_runs.overlay_manifest_json` + `overlay_hash` (v33). Это читает receipt и верифицирует promote.
3. **Request-scoped (ephemeral):** component preview, `POST /compositions/:id/preview-tree`, render-status и существующий `candidateOverrides` прототипа принимают ту же карту как параметр запроса; лизы + TTL из `server/components/candidates.ts`; ничего не сохраняется.

**Запрет в опубликованной ревизии сохраняется:** `snapshotDefinitions` (`server/validation.ts`) не трогается; осознанный отказ feedback-3 §1.1 (`docs/server-api.md:2085`) остаётся в силе и переформулируется в changelog.

**Fingerprint:** `FrameFingerprintInput.candidateOverlay?` условным спредом (как `slotBindings`); `FIELD_LAYERS.candidateOverlay = ["frame"]`; overlay-free кейсы — прежние хеши, golden не двигается.

**Promote-верификация графа** (`server/components/promote.ts`, фаза A): каждый узел overlay каждого зачтённого рана должен быть сейчас опубликован с теми же `bundleHash`/`sourceHash` → иначе `409 overlay_dependency_not_published` / `409 overlay_dependency_diverged`. Мультиран: `overlay_hash` всех ранов должен совпадать → `422 overlay_hash_mismatch` (аргумент как у `renderer_fingerprint` v30). Активный каталог не меняется by construction.

### 1.3. (c) Saga — серверное состояние + endpoints; драйвер только poller

Драйвер-оркестрация отвергнута: (1) обрыв процесса агента не должен требовать выяснения commit point — это и есть проблема из §6; (2) idempotency-примитив уже серверный (`UNIQUE(candidate_id, idempotency_key)` + partial unique in-flight); (3) receipt о серверных мутациях должен быть подписан сервером.

Таблица `migration_commits` (v34) с журналом фаз, CAS на переходах, sweep/watchdog по существующему образцу. Фазы: `preflight → promote → gallery-save → impacted-regression → audit → complete`. Провал фазы никогда не откатывает предыдущую (promote необратим by design), оставляет типизированное `needs-gallery-commit` / `needs-regression` / `needs-audit`. Dry-run — отдельный `POST …/plan` без создания строки саги.

### 1.4. (d) Envelope — аддитивные поля поверх существующего payload + `--summary-json`

`report()` — единственная точка (`driver.mjs:53`, 38 call-site'ов). Аддитивное расширение (`{schemaVersion:1, command, ok, summary, items, artifacts, warnings, nextActions}` рядом с существующими ключами) позволяет мигрировать call-site'ы по одному, не ломая `eui-cache-v1` и существующие рецепты. `--summary-json` печатает только envelope — «компактный стабильный contract» из §8. Согласованность `ok ↔ exit` — сигнатурой `report(lines, payload, envelope)` (envelope.ok обязателен) + тест-таблица по всем verb'ам. Verb'ы мимо `report()` (`design-system`, `get`) приводятся к нему. `.json` всегда JSON; текст — `.txt`.

### 1.5. (e) Readiness: новая `version: 3`, барьер получают только strict-профили

«v2 с барьером» против «v2 без» — версия под другим именем (hash и так меняется); номер обязан называть семантику. `DEFAULT_READINESS_POLICY` (v1, интерактив) не трогается; `STRICT_READINESS_POLICY` (v2) сохраняется для отката; новая `BARRIER_READINESS_POLICY` (v3) = strict + `resourceBarrier`; `resolveCaptureMode` выдаёт её acceptance/reference. Следствие: `readinessPolicyHash` меняется → `FIELD_LAYERS.readiness = ["frame"]` → пересъёмка корпуса приёмки при первом ране (честная цена гарантии `readinessMet=true` ⇒ нет late-asset). Kill-switch `EASYUI_RESOURCE_BARRIER_DISABLED=1` возвращает v2 без деплоя.

**Переиспользование результата барьера (AC 4):** отдельный кэш не строится — межджобное переиспользование уже обеспечено слоем выше (совпал `frameFingerprint` ⇒ кадр из CAS ⇒ барьер не исполняется). Внутри page-context — мемо по `resourceManifestHash`. Иное прочтение = кэш с инвалидацией по реестру ассетов — отдельный проект, non-goal в changelog.

### 1.6. (f) Defaults: per-component capability-флаг, fingerprint — только у согласившихся

`safeParse` меняет наблюдаемый рендер 55 опубликованных компонентов — глобально включать нельзя. Прецедент в трёх строках: payload событий уже проходит `safeParse` с fall-through на raw (`easyUiRuntime.tsx:105`).
- Флаг `ComponentDefinition.capabilities.runtimeSchemaDefaults?: true` + `features.runtimeSchemaDefaults`.
- `const effective = parsed?.success ? parsed.data : props` — никогда не бросает; провал парса ⇒ raw + warning `runtime_props_parse_failed` в receipt.
- `BuildFingerprintInput` — условный спред `runtimeSchemaDefaults: true` ⇒ candidate id сдвигается только у флагнутых; запись в history-блок `ids.ts` обязательна.
- Publish-аудит: `server/components/extract-subprocess.ts:45` уже считает `safeParse({}).data`; для компонентов без флага сравнение с рендером `{}` даёт warning `runtime_default_drift`.
- Kill-switch `EASYUI_RUNTIME_DEFAULTS_DISABLED=1`.

### 1.7. (g) Impact-selection — серверный endpoint

Reverse-index уже серверный (`server/usageGraph.ts` `currentHeadUsages[].screens[]`); «доказанный reuse» обязан быть подписанной сервером квитанцией. Новый примитив `screenFrameFingerprint` (входы существуют: подмножество пинов экрана = ревизионные пины ∩ дерево экрана, viewport/dsf/theme, `readinessPolicyHash`, `rendererFingerprint`, хеш спеки экрана); per-screen пины в БД **не заводятся**. `POST /prototypes/:id/snap-plan` возвращает план `action: "capture"|"reuse"` с причиной; `snap --impacted` исполняет план, `snap --full` его не запрашивает. Конкурентность рендерера (hard 1 / пул с дедлайновой оговоркой `worker-runner.ts:117-122`) не трогается.

## 2. Волны

### W1. Geometry Contract v3 (P0.1) — миграция v32

**Контракт** (`src/acceptance/caseSetSchema.ts`, `caseSetCaseSchema`, всё `.optional()` без `.default()` — C6/C25):

```ts
expectedSurfaces: z.strictObject({
  root: surfaceDims.optional(), layoutUnion: surfaceDims.optional(),
  paint: surfaceDims.optional(), referenceExport: surfaceDims.optional(),
}).refine(v => Object.keys(v).length > 0).optional(),
comparisonSurface: z.enum(["root","layoutUnion","paint","referenceExport"]).optional(),
clipExpectation: z.enum(["root-does-not-clip-layout","root-clips-layout"]).optional(),
```

Отказы: `422 case_surface_conflict` (вместе с `expectedGeometry`); `422 case_comparison_surface_undeclared`; `422 case_clip_expectation_requires_root`.

**Проброс (8 точек):**
1. `src/acceptance/surfaces.ts` — нормализация (§1.1); живёт в `src/`, импортируется сервером (как `caseSetSchema.ts`).
2. `src/capture/geometry.mjs` — `detailOf()` измеряет `rootBounds` (border-box маркера в координатах `#eui-capture-surface`) **только** при bootstrap-флаге; `GEOMETRY_CONTRACT_VERSION` остаётся 2; условный спред.
3. `src/capture/protocol.ts` + `scripts/screenshot-worker.mjs` + `screenshot-pool-worker.mjs` + `CaptureComponent.tsx` — bootstrap-поле `measureRootBounds`, вне `expected`/`readyToExpected` (паттерн `paint.marginPx`).
4. `src/capture/geometryPolicy.ts` — `surfaces`/`divergingSurfaces`/`clipSatisfied`, удаление раннего return ~:215, расширенный `geometryVerdictBlocks`.
5. `server/acceptance/gates/geometry2.ts` — `GeometryFacts.rootBounds`, проброс нормализованных поверхностей, код `surface_mismatch`, запись поверхностей в `geometry.json`.
6. `server/acceptance/gates/visual.ts` `referenceCanvasOf` — выбор `layoutRoot` по `comparisonSurface`; для `referenceExport` канва от габаритов ассета.
7. `server/acceptance/ids.ts` — `CaseSurface.rootBounds?: true` (условный спред в `surfaceOfManifest`); `comparisonFingerprintOf`/`VerdictPolicySnapshot`; **`FIELD_LAYERS`**: `expectedSurfaces: ["comparison","verdict"]`, `comparisonSurface: ["comparison"]`, `clipExpectation: ["verdict"]`, `"surface.rootBounds": ["frame"]` (тотальность — compile-гейт).
8. `server/acceptance/recompute.ts` — `VerdictPolicyField` + `verdictPolicyDelta` + `GATES_BY_POLICY_FIELD` (`expectedSurfaces: ["geometry","visual"]`, `clipExpectation: ["geometry"]`, `comparisonSurface: ["visual"]`); `recomputeGeometry` читает сырые метрики поверхностей, при отсутствии — честный `null` с fall-through на re-diff (механизм W4 feedback-3).

Плюс `server/acceptance/caseSets.ts` (`buildCasesFromManifest`), `cases.ts`, `repo.ts` (`:124/:204/:520`), `server/migrations.ts` (v32: `ALTER TABLE acceptance_cases ADD COLUMN expected_surfaces_json TEXT`, nullable, без backfill; NULL = нормализация из `expectedGeometry`), `contracts.ts`, openapi, sdk, `docs/server-api.md`.

**Драйвер/зеркала:** allowlist ключей кейса `driver.mjs:2894` + валидатор около `:2863` (диапазоны, взаимоисключение, enum) × 3 копии + `sync-share-skills.mjs` + `driver-mjs.d.ts` + `limits` в capabilities.

**Тесты:** unit `geometryPolicy.test.ts` — кейс Payment Schedule (root 343×88, export 367×88, unions 480×88/558×88): четыре вердикта, ни один не глотает другой; нормализация: доволновые манифесты — байт-в-байт прежние `cset_`/`comparisonFingerprint`; дифференциальный: `expectedSurfaces.paint` двигает comparison, не frame; `expectedSurfaces.root` двигает frame; recompute без пересъёмки; e2e — два overflow-кейса Payment Schedule без waiver; driver-cli — локальный валидатор принимает/отклоняет.

**Done (AC §3):** оба overflow-кейса Payment Schedule проходят без правки source и waiver; `reasons[]`/`divergingSurfaces` называют поверхность; легаси через `expectedSurfacesOf`; смена ожидания ⇒ recompute/re-diff.

**Риски:** R1 — смена канвы у объявивших `comparisonSurface` (доволновые идут прежней веткой, регресс-тест); R2 — недоступный ассет для `referenceExport` ⇒ `not-measured`/`indeterminate reference_dims_unresolved`, не тихий pass.

### W2. Deterministic resource barrier (P0.2)

**Политика** (`src/capture/readinessPolicy.ts`): `version: 1|2|3`; `resourceBarrier?: {preload, decodeBackgrounds, manifestDiff, maxResources: 256, perResourceTimeoutMs: 4000}` — только при v3; `BARRIER_READINESS_POLICY` = strict + barrier.

**Механизм** (`src/capture/readiness.ts`): новая фаза `settleResourceBarrier` между `elementsOf` и `settleFonts`:
1. manifest: `collectThemeAssets` + `collectThemeTokens` + `themeIconUrls` + `ownedResourceUrls` + `assetIdOf` **плюс** новый сбор из computed styles (`background-image`, `mask-image`, `border-image`, `list-style-image`) и inline-SVG `<image href>` — это и есть дыра (сегодня `settleImages` смотрит только `<img>`);
2. preload (`Image.decode()`/fetch, дедуп по `assetIdOf`);
3. `document.fonts.ready` + decode всех + два стабильных layout-кадра;
4. повторный сбор → diff → `lateAfterBarrier[]`;
5. далее существующая цепочка.

**Коды** (`failureCodes.ts` + зеркало `WORKER_FAILURE_CODES`, равенство тест-асертится): `resource_barrier_timeout` (`ref="<phase>:<resourceId>"`), `resource_decode_failed`, `resource_late_after_barrier` (**error** — делает `readinessMet=true` честной гарантией), `resource_manifest_overflow`.

**Receipt** (`src/capture/receipt.ts` + `captureReceiptSchema`): блок `resourceBarrier {expected, decoded, fontsReady, stableFrames, lateAfterBarrier[], durationMs}`; **заполнить** `timings.fontsMs/imagesMs/networkMs/framesMs/stabilizeMs` (сегодня всегда null — без них «timeout называет phase» недоказуем) + `barrierMs`.

**Кто получает:** `resolveCaptureMode` — acceptance/reference → v3; interactive → v1.

**Файлы:** `readiness.ts`, `readinessPolicy.ts`, `failureCodes.ts`, `receipt.ts`, `scripts/screenshot-worker.mjs`, `screenshot-pool-worker.mjs`, `server/capture/modes.ts`, `contracts.ts`, openapi, `docs/server-api.md`, `main.ts` (kill-switch). Полей манифеста нет ⇒ правок валидатора драйвера нет; capabilities: `acceptance.readinessPolicyVersion: 3`, `features.resourceBarrier`.

**Тесты:** фикстура с CSS background + inline-SVG image → барьер видит; поздний ассет после барьера → `resource_late_after_barrier`, `met:false`; таймаут называет ресурс+фазу; равенство зеркал кодов; e2e Card Input forced recapture — registry-листья на месте; таймингы не null.

**Done (AC §4):** forced recapture не теряет registry leaves; `readinessMet=true` ⇒ нет late-asset в кадре; timeout называет id+phase; reuse — через CAS по `frameFingerprint` + in-page мемо (non-goal зафиксирован).

**Риски:** R3 — стоимость барьера на 43 экранах (обязательный замер, `durationMs` — KPI); R4 — data-URI/внешние URL ⇒ cap + `resource_manifest_overflow`, не тихое усечение.

### W10 (один деплой с W2). Service capture hygiene (P2.2)

**Вариант A — устранение запроса:** capture-маршруты (`src/app/routes.tsx:43-49`) выносятся из-под `AuthProvider` → `getMe()` не вызывается, `/api/auth/me` не запрашивается, console-ошибки нет. Причина, не симптом.

**Страховка:** `CaptureReceiptConsole.suppressed: [{signature, count}]` (агрегат по `INFRA_NOISE_PATTERNS`), сырые строки инфрашума в `errors[]` не дублируются; `CaptureQuality.suppressedCount`; драйвер (`runSnap`) — одна сводная строка на прогон вместо строки на экран.

**Файлы:** `routes.tsx`, `receipt.ts`, `server/screenshot/noise.ts`, `service.ts`, `contracts.ts`, driver ×3, `server/screenshot.test.ts:237-262`.

**Done (AC §12):** нет 43 одинаковых строк; неожиданные ошибки блокируют как раньше; suppressed — одним summary.

### W3. Candidate dependency overlay (P0.3) — миграция v33

**Контракт:** `candidateOverlaySchema = z.record(componentId, candidateId)` (1..8 узлов, `CASE_SET_MAX_OVERLAY_NODES = 8`; `prototypeCandidateOverlayMax = 2` не меняется — другая ручка, расхождение объяснено в capabilities). Точки приёма — §1.2 (таблица: case set durable / ран durable / preview + preview-tree + render-status + candidateOverrides ephemeral / сохранённая ревизия — запрещено).

**Отказы:** `422 candidate_overlay_duplicate` / `candidate_overlay_limit` / `candidate_overlay_component_not_in_tree`; `409 candidate_overlay_superseded`; promote: `409 overlay_dependency_not_published` / `overlay_dependency_diverged`, `422 overlay_hash_mismatch`.

**Fingerprint/receipt:** условный спред `candidateOverlay` в `frameFingerprint`; `FIELD_LAYERS.candidateOverlay = ["frame"]`; квитанция рана перечисляет `{componentId, candidateId, rev, sourceHash, bundleHash}` по узлам.

**Миграция v33:** `ALTER TABLE acceptance_runs ADD COLUMN overlay_manifest_json TEXT` + `overlay_hash TEXT` (nullable; NULL = ран без overlay).

**Файлы:** `caseSetSchema.ts`, `server/acceptance/caseSets.ts` (`publishedPinByNameAndVersion` получает overlay-ветку — резолв кандидата вместо опубликованного пина), `cases.ts`, `ids.ts`, `repo.ts`, `orchestrator.ts`, `server/components/candidates.ts` (лизы/GC-пины на весь ран), `promote.ts`, `server/screenshot/service.ts`, `routes/compositions.ts`, `routes/screenshots.ts`, `migrations.ts`, `contracts.ts`, openapi, sdk, docs. Драйвер: allowlist top-level ключа + валидатор (формат `cand_…`, лимит, дубликаты) ×3; `limits.caseSetMaxOverlayNodes`; флаг `accept --overlay <componentId>=<candidateId>` (повторяемый).

**Тесты:** e2e «unpublished parent + 2 unpublished deps ⇒ один зелёный ран»; регресс «overlay-free — байт-в-байт прежние хеши/golden»; promote 409×2/ok; «активный каталог не изменился»; «сохранение ревизии с неопубликованным типом по-прежнему 422».

**Done (AC §5):** один ран для unpublished-графа; receipt с точными хешами узлов; каталог неизменен; promote верифицирует граф.

**Риски:** R5 — лизы должны жить весь ран (продление на постановке, снятие в терминале, watchdog); R6 — overlay × nested slots комбинаторика (лимиты публикуются и проверяются до резолва).

### W4. Migration commit transaction (P0.4) — миграция v34

**API:** `POST /api/migration-commits` (`{componentId, candidateId, acceptanceRunIds[], galleryPrototypeId, screenFragment, auditDesignSystem, idempotencyKey}` → `201 {commitId, phase}`); `POST /api/migration-commits/plan` (dry-run, ничего не пишет, → `{plan[], impact, mutations[]}`); `GET /api/migration-commits/:id`; `POST /api/migration-commits/:id/advance`.

**Фазы:** `preflight → promote → gallery-save → impacted-regression → audit → complete`; терминальные провалы типизированы и не откатывают: `needs-promote` / `needs-gallery-commit` / `needs-regression` / `needs-audit` / `failed-preflight`. Конкурентный второй commit того же компонента ⇒ `409 migration_commit_in_flight` (через `maintenance_locks`).

**Квитанция:** `{before/after: {catalogRev, galleryRev}, acceptanceRunIds, overlayHash, impact, auditResult, phases[{phase, startedAt, endedAt, status, idempotentReplay}]}`.

**Миграция v34:** таблица `migration_commits` (`commit_id PK, component_id, candidate_id, design_system, phase, phases_json, request_json, receipt_json, idempotency_key, owner_key, created_at, updated_at, UNIQUE(candidate_id, idempotency_key)`) + partial index по незавершённым фазам. Мягкие ссылки без FK (кандидаты вымываются GC — сага отвечает `candidate_evicted` в фазе, не падает на чтении).

**Переиспользуется, не переписывается:** CAS, `maintenance_locks`, sweep/watchdog, `computeImpact`, `runAudit`/`auditCatalog`, `PUT /prototypes/:id` (gallery-save), `snap-plan` W5 (impacted-regression; если W5 не готова — деградация в full-regression с warning).

**Файлы:** новые `server/migration/commit.ts` + `server/routes/migrationCommits.ts`; `migrations.ts`, `promote.ts`, `contracts.ts`, openapi, sdk, docs; драйвер verb `migration-commit` (`--candidate/--acceptance-run/--gallery/--screen-fragment/--audit-design-system/--receipt/--dry-run/--resume`) ×3; `main.ts` (`EASYUI_MIGRATION_COMMIT_DISABLED`).

**Тесты:** повтор с тем же ключом ⇒ тот же commitId, ноль новых ревизий; kill между promote и gallery-save + advance ⇒ продолжение с gallery-save; провал gallery ⇒ `needs-gallery-commit` при живом promote; dry-run ⇒ ноль мутаций; конкурентный ⇒ 409.

**Done (AC §6):** все четыре пункта — прямые тесты. Риски: R7 — фазовые дедлайны + watchdog (в `needs-regression`, не висеть); R8 — откат образа с v34: зависшие саги доигрываются вручную, зафиксировать в Rollback policy.

### W5. Impact-driven gallery regression (P1.1) — миграция v35

**API:** `POST /api/prototypes/:id/snap-plan` `{rev?, viewport, dsf, theme, mode: "impacted"|"full", changedComponents?}` → `{planId, screens[{screenId, action: "capture"|"reuse", reason: "new-screen"|"pin-changed"|"renderer-changed"|"readiness-policy-changed"|"proven-reuse", screenFrameFingerprint, reuseReceipt?}]}`.

**Примитив:** `screenFrameFingerprint = sha256({screenId, screenSpecHash, pins[{componentId, version, bundleHash}] sorted, viewport, dsf, theme, readinessPolicyHash, rendererFingerprint})`; пины экрана = ревизионные пины ∩ дерево экрана (как `currentHeadUsages`); per-screen пинов в БД нет. Reuse-квитанция подписана сервером (образец `reuseReceiptOf` + `reuse_receipt_json` v29): `{screenId, screenFrameFingerprint, previousRev, previousPngSha256, provenAt}`.

**Миграция v35:** таблица `prototype_screen_frames (prototype_id, rev, screen_id, screen_frame_fingerprint, png_sha256, receipt_json, created_at, PK(prototype_id, rev, screen_id))` + индекс по fingerprint.

**Драйвер:** `snap --impacted` (план → снимает только capture, reuse-квитанции в receipt) и `snap --full` (план не запрашивается). `buildSnapPlan` — второй источник плана; последовательность и `SNAP_ATTEMPTS` не меняются.

**Файлы:** новый `server/prototypes/screenFrames.ts`; `usageGraph.ts` (per-screen проекция), `routes/prototypes.ts`, `migrations.ts`, `contracts.ts`, openapi, sdk, driver ×3, docs, `main.ts` (`EASYUI_IMPACTED_SNAP_DISABLED`).

**Тесты:** addition-only Connect Card на 43-экранной галерее ⇒ 1 capture + 42 proven-reuse; изменение PayButton ⇒ capture только у экранов с PayButton в resolved tree; смена `rendererFingerprint` ⇒ все capture (`renderer-changed`); `--full` игнорирует план; **недоказанный reuse деградирует в capture** (R9: если резолв не даёт транзитивные зависимости — консервативно capture, тест обязателен).

**Done (AC §7):** все три пункта; KPI «recaptured ≤ new + impacted».

### W6. Receipt envelope (P1.2)

Контракт §1.4. `report(lines, payload, envelope)`; `--summary-json`; verb'ы мимо `report()` приводятся; `writeReceiptFile` — `.json` всегда JSON, текст `.txt`; инвариант `ok === (exit === EXIT.ok)`.

**Файлы:** driver ×3, `server/driver-mjs.d.ts` (типизированный фасад envelope), `driver-cli.test.ts`, `cache.mjs` (envelope в квитанции `eui-cache-v1`), `SKILL.md` + зеркала (схема envelope), `sync-share-skills.mjs`, `docs/server-api.md` (`features.receiptEnvelopeVersion: 1`).

**Тесты:** тест-таблица по всем verb'ам (envelope присутствует, `ok ↔ exit`); `--summary-json` — только envelope; существующие ключи payload не исчезли (регресс на 6 verb'ов из AC); `.json`/`.txt` receipt.

**Done (AC §8):** один envelope у status/geometry/snap/accept/promote/audit; summary без `keys`-проб; версия документирована, обратная совместимость доказана регресс-тестом; exit ↔ ok. Риск R10 — 38 call-site'ов, миграция по одному, каждый коммит зелёный.

### W7. Typed cause + suggested policy (P1.3)

**Контракт:** `suggestedPolicy {kind: "textAaBudget"|"maxRawDiffPct"|"overflowBudgetPx", textAaBudget?, maxRawDiffPct?, basis, scope: "case-id"|"remediation-group", remediationKey?, evidence {topCause, confidence, edgeResidualInsidePct, bestOffset, geometryUnchanged, affectedElementKeys, rendererFingerprint}, expiry {trigger: "renderer-or-source-fingerprint-change", rendererFingerprint, referenceAssetId}, requiresHumanJudgement: true}`.

**Продюсер** — чистая функция `suggestPolicy(input, causes, observed): SuggestedPolicy | null` рядом с `classifyVisualCauses` (`server/visual/causes.ts`), питается `CauseInput` + `CAUSE_THRESHOLDS` + `TEXT_AA_PRESETS`; `CLASSIFIERS` и 9 кодов не трогаются. **Обязательный отказ**, если топ-причина структурная (`geometry-shift`/`descendant-outside-mask`/`effect-overflow`/`missing-late-asset`) → `null` (AC + тест).

**Привязка:** `annotateCauses` в `runner.ts`; на `:602` причины удаляются у reused-строк — `suggestedPolicy` удаляется там же. Группировка — существующий `remediationKey` (`server/acceptance/grouping.ts`): одна причина ⇒ одна группа ⇒ одно предложение. Слой — report-only, не входит в fingerprints, никогда не применяется автоматически.

**Файлы:** `causes.ts`, `grouping.ts`, `runner.ts`, `contracts.ts` (`acceptanceGateResultSchema`), `routes/acceptance.ts`, openapi, sdk, driver ×3 (рендер в `accept-status`), docs, `main.ts` (`EASYUI_SUGGESTED_POLICY_DISABLED`).

**Тесты:** глиф-AA ⇒ `live-text-v1`; сдвиг геометрии ⇒ null; два кейса, одна причина ⇒ один `remediationKey`, одно предложение; смена рендерера ⇒ протухание принятого исключения; reused-строка без `suggestedPolicy`.

**Done (AC §9):** группировка между кейсами; structural residual никогда не waiver; expiry по renderer/source fingerprint; `requiresHumanJudgement: true` всегда.

### W8. Figma Source Package (P1.4) — миграция v36

**API:** `POST /api/figma-source-packages` (контентно-адресован `fsp_<sha256(manifest)>`: `{designSystem, fileKey, sourceRevision, nodes[], exports[], instanceProperties[], textRuns[], effects[], usageContexts[], missing[], anomalies[]}` → `{packageId, exports[{nodeId, assetId, width, height, sha256, deduped}]}`); `GET …/:id`; `POST …/:id/case-set-skeleton` → черновик манифеста (не сохраняется).

- Валидация: объявленные dims/SHA сверяются с байтами ⇒ `422 source_package_export_dimension_mismatch` / `source_package_export_sha_mismatch`; дубликаты дедуплицируются в реестр `asset_<sha256>`; повтор nodeId ⇒ `422 source_package_duplicate_node`; `limits.sourcePackageMaxExports = 256`. Байты живут только в реестре ассетов, таблица хранит manifest.
- Provenance: `figmaSchema` получает `sourcePackageId?` (пакет той же DS); `check-provenance-resolver.ts` — пины обновляются.
- **Typed preflight:** пакет объявил `missing[]` с ролью `exact-reference` для узла компонента ⇒ `422 missing_exact_reference` в publish-префлайте (`server/components/validate.ts`) с nodeId — до сохранения компонента.
- **Skeleton:** генератор у `coverageOf`/`buildCasesFromManifest`; заполняет `expectedSurfaces.referenceExport` из dims экспорта + `referenceAssetId` — синергия с W1. Skeleton обязан проходить локальный валидатор драйвера (гейт наоборот).
- **Инвалидация — только comparison:** смена `sourceRevision` ⇒ новый пакет, новые assetId ⇒ у зависимых кейсов меняется `referenceAssetId` (`["comparison"]` в `FIELD_LAYERS`), пересъёмки нет.

**Миграция v36:** `figma_source_packages (package_id PK, design_system, file_key, source_revision, manifest_json, created_at)` + индекс `(design_system, file_key)`.

**Файлы:** новые `server/figma/sourcePackage.ts` + `routes/figmaSourcePackages.ts`; `figma.ts`, `components/validate.ts`, `caseSets.ts`, `check-provenance-resolver.ts`, `migrations.ts`, `contracts.ts`, openapi, sdk, driver ×3 (verb `source-package upload|show|skeleton`), docs, `main.ts` (`EASYUI_SOURCE_PACKAGE_DISABLED`).

**Тесты:** расходящиеся dims ⇒ 422; повторный экспорт ⇒ `deduped:true`, один asset; `missing_exact_reference` до сохранения; skeleton проходит валидатор драйвера; смена `sourceRevision` ⇒ двигается `comparisonFingerprint`, не `frameFingerprint`.

**Done (AC §10):** все четыре пункта.

### W9. Runtime schema defaults (P2.1)

Контракт §1.6. **Файлы:** `src/player/easyUiRuntime.tsx`, тип `ComponentDefinition.capabilities` (`src/catalog/normalize.ts`), `server/components/extract-subprocess.ts` (`capabilitiesSchema` + warning `runtime_default_drift`), загрузчик (`src/customComponents/loader.ts` copy-through), `server/acceptance/ids.ts` (history + `BuildFingerprintInput`), `server/components/validate.ts`, `routes/meta.ts`, `main.ts`, docs, скилл yandex-pay (правило «не дублировать `??`» для флагнутых).

**Тесты:** `.default("md")` + флаг ⇒ `{}` рендерится как contract parse; без флага — байт-в-байт доволновое; невалидные props ⇒ raw без throw; candidate id не меняется у компонентов без флага (регресс по корпусу).

**Done (AC §11):** `{}` = contract parse; default-семантика в candidate fingerprint (у флагнутых); постепенный перевод через capability-флаг.

### W11. Capabilities, changelog, финальная верификация

- `features`: `geometrySurfacesV3`, `resourceBarrier`, `candidateDependencyOverlay`, `migrationCommit`, `impactedSnap`, `suggestedPolicy`, `figmaSourcePackage`, `runtimeSchemaDefaults`, `captureNoiseSummary`, `receiptEnvelopeVersion: 1`.
- `acceptance`: `geometryContractVersion: 2` (**не 3** — §1.1, объяснено в changelog), `readinessPolicyVersion: 3`, `comparisonSurfaces: [...]`.
- `limits`: `caseSetMaxOverlayNodes: 8`, `prototypeCandidateOverlayMax: 2`, `sourcePackageMaxExports: 256`, `snapPlanMaxScreens`, `migrationCommitPhaseTimeoutMs`, `resourceBarrierMaxResources: 256`.
- Changelog `docs/server-api.md`: абзац на capability + таблица флагов/kill-switch'ей + слой инвалидации на каждое поле + два зафиксированных отказа: (1) `GEOMETRY_CONTRACT_VERSION` не поднимается; (2) документ прототипа с кандидатным пином по-прежнему недоступен.
- Верификация: `npm run verify` + `npm run e2e` на каждой волне; runtime-прогон по `/verify`; корпус детерминизма после W1/W2; замер стоимости барьера; прогон одной прод-семьи до/после W1.

**KPI-проводка (§14):** revisions → envelope `summary.revisions` (W6); typedCausePct (W7); `resource_late_after_barrier` при `met:true` недостижим по построению (W2); captured/reused в snap-plan (W5); 1 resumable workflow (W4); schema-discovery = 0 через `--summary-json` (W6); невыразимых поверхностей = 0 (W1); преждевременных публикаций = 0 — доля ранов с overlay (W3).

## 3. Параллелизация, сериализация, инварианты деплоя

**Группы:**
- **A (ядро схем/отпечатков, строго последовательно):** W1 → W3 → W5 (общие `ids.ts`/`caseSetSchema.ts`/`caseSets.ts`).
- **B (капчур):** W2 ∥ W10, внутри W2 → W10 (общий `receipt.ts`). Независима от A.
- **C:** W4 — после W3 (overlay-верификация в promote) и W5 (фаза impacted-regression; при задержке — деградация в full с warning).
- **D (независимые):** W6, W7, W9 — параллельно A/B; W8 — после W1 (skeleton заполняет `expectedSurfaces.referenceExport`).

**Сериализация файлов:**

| Файл | Порядок |
|---|---|
| `caseSetSchema.ts` | W1 → W3 |
| `server/acceptance/ids.ts` | W1 → W3 → W9 |
| `server/acceptance/caseSets.ts` | W1 → W3 → W8 |
| `cases.ts` / `repo.ts` | W1 → W3 |
| `recompute.ts`, `src/capture/geometry.mjs` | W1 |
| `src/capture/receipt.ts` + схема | W2 → W10 → W9 |
| `promote.ts` | W3 → W4 |
| `runner.ts` | W1 → W7 |
| `driver.mjs` ×3 | W1 → W3 → W4 → W5 → W6 → W7 → W8 |
| `routes/meta.ts`, `contracts.ts`/openapi | по волне за раз; финализирует W11 |

W6 намеренно после серверных волн в очереди driver.mjs: он рефакторит `report()`, а не per-verb валидаторы — обратный порядок заставил бы каждую серверную волну переписывать свежие call-site'ы.

**Инварианты деплоя:**
1. W2 + W10 — один деплой (общая схема квитанции).
2. W3 + W4 — один деплой, если W4 включает overlay-верификацию (иначе promote примет непроверяемый граф).
3. W1 — деплой в одиночку, до первого прод-прогона с `expectedSurfaces`; окна ложных fail нет (волна опциональна по построению).
4. W5: сервер (`snap-plan`) деплоится раньше драйверного `--impacted`; старый драйвер работает как раньше.
5. Сборка на прод-сервере запрещена; деплой — `/deploy` по явной команде пользователя.
6. Прод-аудит: перед W2 — замер стоимости барьера на копии галереи; перед W1 — список семейств, где `expectedSurfaces.root` вызовет пересъёмку (переиспользовать `scripts/audit-geometry-contract.mjs`).

**Миграции:** v32 (W1) → v33 (W3) → v34 (W4) → v35 (W5) → v36 (W8); одна на волну; аддитивные nullable / новые таблицы; читатели `SELECT *`; FK-аудит; номера выдаёт оркестратор (параллельная разработка миграций в ветках запрещена — R12).

**Сквозные инварианты (ревью каждой волны):**
1. Новые поля манифеста — `.optional()` без `.default()` (контентная адресация `cset_`).
2. Conditional spread для каждого нового входа отпечатка; `GOLDEN_FRAME` не двигается ни разу; `CASE_FINGERPRINT_ALGO_VERSION` остаётся 7.
3. Каждое новое поле — тест каскада на уровне `caseFingerprintsOf`, не только декларация в `FIELD_LAYERS`.
4. `src/` не импортирует `server/`; дублирование `src` ↔ `scripts/*.mjs` тест-асертится.
5. Драйвер: 3 копии + `driver-mjs.d.ts` + `capabilities.limits` + тест «драйвер принимает манифест с новым полем» — в той же волне, что схема.
6. `registerContract` + регенерация openapi (drift-гейт) + SDK + секция в `docs/server-api.md` — в той же волне.
7. Kill-switch резолвится один раз в `main.ts`.

## 4. Верификация (сводно)

- Каждая волна: `npm run verify` + `npm run e2e` зелёные; для схемных волн — регресс байт-идентичности хешей доволновых манифестов (golden).
- Финал: runtime-прогон по `.claude/skills/verify/SKILL.md` (скилл `/verify`); корпус детерминизма после W1/W2; e2e-сценарии из Done-критериев волн (Payment Schedule W1, Card Input forced recapture W2, unpublished-граф W3, kill/resume саги W4, 1+42 план W5).
- KPI §14 ретроспективы измеримы из квитанций (проводка в W11).

## Риски (сводно)

R1/R2 (W1) — канва и `referenceExport` без ассета → `indeterminate`, не тихий pass. R3/R4 (W2) — стоимость барьера, переполнение манифеста. R5/R6 (W3) — лизы на длинном ране, overlay × nested slots. R7/R8 (W4) — зависшие фазы, откат образа с v34. R9 (W5) — недоказанный reuse = capture. R10 (W6) — 38 call-site'ов по одному. R11 (W9) — `safeParse` только под флагом. R12 — пять миграций: каждая своим деплоем, номера централизованы.
