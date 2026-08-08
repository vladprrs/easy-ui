# План: снятие блокеров EUI-BR-01…10 (фидбэк YP v2 от 2026-08-09)

Статус: **v1 — черновик, Stage 2 (адверсариальное ревью) не пройден.**
Источник требований: `docs/EASYUI_BLOCKER_REMOVAL_REQUIREMENTS_20260809.md` (далее — «фидбэк»).
Дата плана: 2026-08-08. Разведка кода выполнена пятью read-only агентами; все привязки file:line — по состоянию `main@9f697a8`.

## 0. Контекст и рамки

Фидбэк — проверяемый backlog из 10 требований (EUI-BR-01…10), каждое с capability-именем, JSON-контрактами и acceptance-критериями на **сохранённых** артефактах мигратора. Мы не имеем их артефактов в репо (`../../artifacts/...` — вне проекта), поэтому:

- каждое требование получает **синтетическую фикстуру-репродукцию** в `test/fixtures/` + red-тест до реализации;
- финальная проверка «blocker снят» — на стороне мигратора по release package (§16 фидбэка); мы поставляем before/after receipts на своих фикстурах.

Жёсткие рамки:

- **Rollback-window v32–v36 открыт** (деплой волны W1–W11 2026-08-08). Новые миграции (v37+) и деплой этого плана — только после закрытия окна либо по явной команде пользователя. Реализация и тесты окна не ждут.
- `acceptance.geometryContractVersion` сейчас **2** — план поднимает его до 3 (EUI-BR-05), это инвалидирует все frame fingerprints ⇒ пересъёмка корпуса. Все fingerprint-ломающие изменения (BR-02/03/05) сводим в **одно** окно пересъёмки.
- Общие правила §3 фидбэка обязательны для каждой задачи: strict-схемы (неизвестное поле → 422), capability/contract version с сервера, receipts с requested+effective, корректный recompute/rediff/recapture/rebuild вместо молчаливого reuse, legacy byte-for-byte под kill-switch, `suggestedPolicy` report-only.
- Инварианты кода: новые поля case-set — только `.optional()` **без** `.default()` (контентный адрес `cset_`); каждое новое поле обязано попасть в `FIELD_LAYERS` (`server/acceptance/ids.ts:621`, тотальный `satisfies`); strict-схемы definition правятся «комплектом» из трёх (`server/components/extract-subprocess.ts:12`); capability-паттерн — `features.*`+`limits.*` в `server/routes/meta.ts`, kill-switch-хелпер в модуле-энфорсере, warn-строка в `server/main.ts:283-311`, схема в `server/contracts.ts` + `server/contract.test.ts` + `openapi.json` + `docs/server-api.md`.

## 1. EUI-BR-01 — единый resolver схемы published component (P0, milestone)

### Диагноз (разведка)

Схема компонента сегодня добывается **четырьмя** разными путями: save-валидация — live-import TSX через `snapshotDefinitions` (`server/validation.ts:184-226`); render/status/snap — `pins()`/`headPin()` (`server/repos/prototypes.ts:145-163`); каталог — `definition_meta.propsJsonSchema` (`server/routes/components.ts:154`); preview-tree — `definition_meta` через `componentCanonicalRoles`/`componentLayoutContracts` (схем props не резолвит вовсе). Наиболее вероятный root cause наблюдаемого 422:

- **H1**: composition-пины применяются по **имени ко всему документу** (`server/validation.ts:57,152,199-204`) — exact-версия из manifest'а опубликованной композиции перекрывает active-версию для авторских элементов вне композиции;
- **H2**: readiness зовёт `snapshotDefinitions` по **нераскрытому** документу (`server/readiness.ts:174`) — save и status валидируют разными схемами;
- **H3**: кэш модулей `imported` с ключом `id@rev` (`server/components/pipeline.ts:27,120-128`) **никогда не инвалидируется** при promote/supersede (`server/components/promote.ts:421-554` кэш не трогает);
- **H4**: save-SQL фильтрует по `cr.design_system`, `headPin` — нет.

### Дизайн

Новый модуль `server/components/resolvedGraph.ts` — единственный резолвер:

- `resolveComponentGraph(db, doc, {expansion, dataDir})` → per-element `{componentId, version, rev, sourceHash, propsSchemaHash, catalogRevision, designSystemMetaVersion, origin: "head-active"|"pinned"|"composition-pin"}`;
- composition-пины применяются **только** к элементам, порождённым раскрытием композиции (ключи с `$`-префиксом раскрытия), не по имени;
- для `track:head` — та версия, которую resolver запишет в resolved pins (тот же SQL, что `headPin`, + фильтр DS согласован); для pinned — exact; fallback на предыдущую active при успешно разрешённой новой — запрещён;
- ключ кэша схем — ровно контракт фидбэка §4 (designSystemId, designSystemMetaVersion, catalogRevision, componentId, componentVersion, sourceHash, propsSchemaHash); кэш `imported` получает экспортируемую `invalidateComponent(componentId)`; promote/supersede/catalog-migration вызывают её в фазе B транзакции.

Потребители переводятся на graph: `snapshotDefinitions` (save), `server/readiness.ts:174` (по **раскрытому** документу), `screenRenderStatus`/`bundleReadiness`, `server/screenshot/service.ts:706+` (snap), preview-tree (если в дереве тот же pin).

Ошибка unknown prop — новый типизированный issue `component_prop_unknown` c контекстом из фидбэка (path, componentId, resolvedVersion, sourceHash, propsSchemaHash, catalogRevision, acceptedKeys) — маппинг zod `unrecognized_keys` → диагностический код в `src/prototype/validate.ts:264-316` + `server/http.ts:47-53`; `acceptedKeys` — из ключей props-схемы.

Capability: `prototypeSchemaResolverV2` (contract version 2), kill-switch `EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1` → старый путь byte-for-byte.

### Задачи и критерии

1. Red-тесты на H1/H2/H3/H4 (фикстура: компонент v1→v2 с новым prop, документ с композицией, пинующей v1; promote в живом процессе). Подтверждённая гипотеза фиксируется в плане при ревизии.
2. `resolvedGraph.ts` + перевод потребителей + инвалидация + типизированная ошибка.
3. AC (зеркалят фидбэк §4): save копии документа с `@2 {mode:"current-main"}` проходит; `status`/save receipt/snap называют одинаковые resolvedVersion/sourceHash/propsSchemaHash; заведомо неизвестный prop отклоняется с фактической схемой; после promote повторный save не видит старую схему.

Зона владения: `server/validation.ts`, `server/readiness.ts`, `server/components/{pipeline,promote,resolvedGraph}.ts`, `server/repos/prototypes.ts`, `src/prototype/validate.ts`.

## 2. EUI-BR-02 — per-side paint padding (P0)

### Диагноз

Поле краски — скалярный CSS `padding` capture-surface (`src/capture/CaptureComponent.tsx:186`), дефолты `DEFAULT_PAINT_MARGIN_PX=64` / `VIEWPORT_SURFACE_PAINT_MARGIN_PX=16`, потолок 256 (`server/screenshot/service.ts:194-202,950-953`). В схеме case-set поля нет (`src/acceptance/caseSetSchema.ts:110-125`), и гейт геометрии зовёт `captureCase` **без** `paintMargin` (`server/acceptance/gates/geometry2.ts:238`), хотя опция существует (`gates/capture.ts:108`). Упирание ink в край даёт indeterminate без типизированного кода (`src/capture/geometryPolicy.ts:303-308`).

### Дизайн

- `caseSetCaptureSchema` += `paintPaddingPx?: z.strictObject({top,right,bottom,left: int 0..MAX_PAINT_MARGIN_PX})` (optional, без default);
- транспорт: `bootstrap.paint` расширяется до `{marginPx} | {paddingPx:{t,r,b,l}}` (`src/capture/protocol.ts:295`), CaptureComponent — четырёхстороннее CSS padding; воркеры без изменений (element-screenshot поверхности);
- `geometry2Gate` передаёт per-case значение в `captureCase`; per-side клэмп к server-owned limit (existing `MAX_PAINT_MARGIN_PX`, публикуется в `limits`);
- семантика: `rootBounds`/`layoutUnion`/`referenceExportDims`/размер raw reference не меняются; comparison canvas (`COMPARISON_PAINT_MARGIN_PX`, `server/acceptance/ids.ts:119`) не трогаем — visual остаётся на `referenceExport`;
- ink clamp → новый типизированный код `paint_capture_clipped` (в `src/capture/failureCodes.ts`) с требуемым минимумом по стороне (из факта касания края);
- receipt: requested/effective per side, clipping edge, полный paint bounds, raster canvas (`src/capture/receipt.ts:170-173`, `geometry.json` в `gates/geometry2.ts:280-320`);
- `FIELD_LAYERS` += `capture.paintPaddingPx` → слой **frame** ⇒ изменение padding пересобирает только затронутые кейсы (существующий каскад `runner.ts:484-600`).

Capability `paintCapturePaddingV1`; kill-switch `EASYUI_PAINT_PADDING_DISABLED=1` — поле в манифесте отклоняется типизированным 422 на `case-sets put`/старте рана (byte-for-byte для манифестов без поля).

AC (фидбэк §5): фикстура «root 343×88, декор вправо до 398» — оба риск-кейса меряют полный paint при `right:64`; root/layoutUnion/referenceExport неизменны; недостаточный padding → `paint_capture_clipped` с minimum, не geometry mismatch.

Зона: `src/acceptance/caseSetSchema.ts`, `src/capture/{protocol,CaptureComponent,receipt,failureCodes,geometryPolicy}.ts`, `server/screenshot/service.ts`, `server/acceptance/{ids,gates/capture,gates/geometry2}.ts`.

## 3. EUI-BR-03 — полный registry-resource barrier (P0)

### Диагноз

`collectResourceManifest` (`src/capture/readiness.ts:589-616`) видит только `img.currentSrc`, 6 CSS-свойств и inline-SVG `<image>`; не видит srcset-кандидаты, псевдоэлементы, шрифты, candidate-overlay deps и **icon-registry**. Root cause «late images»: registry-`<img>` появляется в DOM только после асинхронного доезда темы (`src/designSystems/theme.tsx:191-207` → `shared.icons`, `server/shims/abi-v4.ts:39-47`) — т.е. между двумя снятиями манифеста или после второго. `settleNetwork` ждёт только начавшиеся запросы (`readiness.ts:419-432`). `resource_late_after_barrier` сегодня даёт `met:false` → gate **fail** (`server/acceptance/gates/readiness.ts:112-124`), фидбэк требует `indeterminate:resource_barrier_incomplete`. Receipt без owner/channel/phase (`readiness.ts:536-547`). Сопутствующий дефект: шимы захватывают `shared` по значению на eval (`abi-v4.ts:23`) — при гонке иконки не отрендерятся никогда.

### Дизайн (`resourceBarrierV4`, отдельный `resourceBarrierPolicyVersion: 4`)

- Новая фаза `registry` **до** первого манифеста: барьер ждёт применения темы/реестра (`__easyUiShared.icons` заполнен либо темы нет) — закрывает главный канал late assets;
- манифест расширяется каналами: `img|srcset`, `css-background|mask|content` (+ `::before/::after` через `getComputedStyle(el, pseudo)`), `icon-registry` (URL реестра, на которые ссылаются отрендеренные `[data-eui-icon]` и предзаявленные иконки поддерева), `font` (`document.fonts`), assets unpublished candidate и overlay-deps (из bundle/resolved tree — сервер знает их до кадра);
- per-resource запись — контракт фидбэка §6: `{assetId, ownerElementKey (ближайший data-eui-key), ownerComponentId (через slotBindings), channel, discoveredAt: bundle|resolved-tree|dom|computed-style|request, requested, loaded, decoded, completedBeforeStableFrame}`;
- `expected !== decoded`, decode failure, новый ресурс после stable frame → gate `readiness` = **indeterminate** с кодом `resource_barrier_incomplete` (новый код в `failureCodes.ts`; поведение переключается `resourceBarrierPolicyVersion`), кадр не становится visual evidence (существующий `readinessBlocksVisual`);
- reuse barrier receipt — только вместе с кадром: `readinessPolicyHash` уже входит в `frameFingerprint` (`ids.ts:278-299`); поднятие версии политики ⇒ честный recapture;
- опциональный `preloadAssets?: string[]` (assetId) в `caseSetCaptureSchema` — hint, не освобождающий сервер от обнаружения;
- фикс шимов abi-v2/3/4: читать `globalThis.__easyUiShared` в call-time (семантически эквивалентно при инициализированном shared).

AC (фидстка §6): фикстура «компонент с N registry-иконками через тему» — при форсированном recapture все direct registry images обнаружены до первого evidence frame, `expected=decoded`, `lateAfterBarrier=[]`; no-image кейсы без лишних deps; повторный recapture не воспроизводит `missing-late-asset`; недогруженный asset называет `assetId`/`ownerElementKey`/channel/phase.

Зона: `src/capture/{readiness,readinessPolicy,receipt,failureCodes}.ts`, `server/acceptance/gates/readiness.ts`, `server/capture/resourceBarrier.ts`, `server/shims/abi-v*.ts`, `server/routes/meta.ts`.

## 4. EUI-BR-04 — exact content-hug canvas < 24 px (P0)

### Диагноз

Литерала «минимум 24 px» в кодовой базе **нет** (проверено). Реальные кандидаты в источники симптома: минимальный вьюпорт воркера 64×64 (`server/screenshot/service.ts:539-540`, к hug-канве прямо не применяется), нормализация comparison canvas `padTo = root + 2·margin` (`server/acceptance/gates/visual.ts:217-238`), допуск `maxDimensionDeltaPx` и `Math.max(refDims, candDims)` в воркере диффа (`scripts/visual-diff-worker.mjs:513-529`), либо минимум на стороне браузера/скриншота. Диагноз обязателен до дизайна.

### Дизайн

1. **Диагностическая фикстура**: hug-компонент 16×16 CSS px, e2e-прогон полного пути (capture → geometry → visual) с фиксацией фактических размеров канв на каждом шаге; найденный клэмп фиксируется в плане при ревизии.
2. Требуемое поведение (фидбэк §7): crop/comparison canvas exact вплоть до 1 CSS px независимо от внутреннего вьюпорта браузера; единый normalization path для reference и candidate (сегодня уже один — `normalizeAndCompare`; убедиться, что crop по `rootBounds` точен и не расширяется paint-полем); receipt: `rootBounds`, `comparisonCanvasCssPx`, `deviceScaleFactor`, `comparisonCanvasDevicePx`, отсутствие hidden padding.
3. `sizeDeltaPx` не используется как обход: тест, что 16 px кейс проходит без per-case допусков.

Capability `exactContentHugCanvasV1`; kill-switch → прежняя нормализация byte-for-byte. AC: шесть синтетических 16 px кейсов не получают canvas-size indeterminate; остальные visual residuals пересчитываются отдельно (rollout сам по себе не выдаёт pass — прогоняется recompute, не подмена вердикта).

Зона: `server/acceptance/gates/visual.ts`, `scripts/visual-diff-worker.mjs`, `server/screenshot/service.ts`, e2e-фикстура.

## 5. EUI-BR-05 — decoration-aware geometry (P0)

### Диагноз

`visit()` безусловно выкидывает transform-узлы из layout-union (`src/capture/geometry.mjs:469`), кладя их в `effectSources` с `cause:"transform:…"`, но `effectReachPx` для transform = 0 (`src/capture/geometryPolicy.ts:194`) — источник не может «объяснить» overflow, вердикт деградирует в indeterminate. Внутренние узлы компонента не имеют element key — `elementKey` в effectSources это ключ ближайшего маркера (`geometry.mjs:337-342`), различает только `elementPath`. Мест для строгой metadata два: definition-allowlist (`extract-subprocess.ts:13/23/108`) и per-case (`caseSetSchema.ts`).

### Дизайн (`geometryDecorationOwnershipV1`)

- **Адресация внутренних узлов**: компонент помечает узел `data-eui-part="tail"` в своём TSX; допустимые part-имена и их роли объявляются в definition meta:
  `geometryOwnership?: Record<partName, {role: "decoration", participatesIn: ["paint"]}>` — строгая схема, правится «комплектом» трёх strict-схем + `src/catalog/normalize.ts`;
- **Измерение** (geometry contract v3): для каждого transform/out-of-flow узла записываются `preTransformBounds` (offset-геометрия до трансформа), transform matrix, `postTransformPaintBounds`, clip chain и причина включения/исключения из каждой surface;
- **Семантика**: узел, объявленный decoration, исключается из `layoutUnion`, но остаётся в `paint` (ink уже его видит) и в visual diff; его post-transform rect становится валидным «объяснением» paint overflow (фикс `effectReachPx` для transform-декораций);
- **Валидация против злоупотребления**: audit gate отклоняет метку на узле, который является in-flow контейнером с layout-детьми (доказуемо влияет на раскладку) — код `geometry_ownership_invalid`;
- **`geometryContractVersion: 2 → 3`** — входит в frame fingerprint (`ids.ts:297`), публикуется в `acceptance.geometryContractVersion`; поднимается один раз, в одном деплой-окне с BR-02/03 (одна пересъёмка корпуса).

AC (фидбэк §8): фикстура «tooltip c transform-tail 8×24» — root/layout verdict clean во всех кейсах; tail в `paint` и в visual diff; ошибочная метка на in-flow child отклоняется; visual residual остаётся fail (закрывается только geometry-часть).

Зона: `src/capture/{geometry.mjs,geometry.d.mts,geometryPolicy.ts}`, `src/catalog/normalize.ts`, `server/components/extract-subprocess.ts`, `server/acceptance/gates/{geometry2,audit}.ts`, `server/acceptance/ids.ts`.

## 6. EUI-BR-06 — resumable acceptance (P0)

### Диагноз

Фаз уровня run нет — есть `GATE_ORDER` per-case (`server/acceptance/gates/index.ts:28`). Источник «~180.5 s» найден точно: 3 попытки × `JOB_DEADLINE_MS=60_000` + 2×250 backoff (`server/screenshot/sessions.ts:39`, `gates/capture.ts:19,112-118`, `policies.ts:107`) → `CaptureInfraError` без фазы. «Allocate renderer» не отдельная фаза — spawn/`ensure()` без собственного таймаута (`worker-runner.ts:17-39,56-150`). Durable-состояния фаз нет; на рестарте все `queued|running` сносятся в `error` (`orchestrator.ts:10-12`); props кейсов в памяти, набор восстановим только при `case_set_id != null`. Готовый паттерн саги с фазами/CAS/sweep — migration-commit (`server/migration/commit.ts:57-60,524,540-554`; роуты `server/routes/migrationCommits.ts:196-206`).

### Дизайн (`acceptanceResumeV1`, миграция v37)

- **Durable checkpoints**: per-case прогресс гейтов персистится инкрементально — `persistCase` после **каждого** гейта (сегодня после кейса), в `gates_json` добавляются `startedAt/finishedAt/fingerprint` фазы; run-уровень: колонки `resumed_from_run_id`, `supersedes_run_id`, `attempt`, `status_reason`;
- **Typed timeout**: отдельный таймаут аллокации (spawn/pool `ensure`) и capture; `CaptureInfraError` несёт `phase`; терминализация — `status:"error", statusReason:"phase_timeout", phase, elapsedMs, lastCompletedPhase, resumable:true, resumeFrom` (контракт фидбэка §9);
- **Restart-поведение**: sweep помечает пережившие раны `error` + `status_reason:"interrupted", resumable:true` (реконструкция набора из case-set уже даёт тот же `frame_fingerprint` — `orchestrator.test.ts:687`);
- **`POST /api/acceptance-runs/:id/resume`** (идемпотентный): открывает продолжение того же candidate/case-set/policy — новый attempt того же run (status error→running под guard'ом `one_in_flight`); переиспользует completed gates только при совпавших fingerprints (расширение `attemptReuse` до гейт-грануляции для contract/defaults/audit); продолжает с первой незавершённой фазы; lineage (`resumedFromRunId`, attempt, прежняя ошибка) — в `refresh_json`/receipt; при несовместимости — `409` с указанием создать новый run с `supersedesRunId` (reuse компиляции кандидата и non-render гейтов);
- второй concurrent run того же candidate не создаётся (существующий unique index);
- driver: verb `accept-resume <runId>` (5 точек по паттерну `runAccept`), `accept-status` показывает checkpoint lineage.

AC (фидбэк §9): фикстура «run падает на allocate после audit» — resume не переисполняет contract/defaults/audit без fingerprint change; capture стартует либо новый typed timeout называет фазу/ресурс; после рестарта сервера `accept-status`+resume сохраняют lineage.

Зона: `server/acceptance/{orchestrator,runner,repo}.ts`, `server/routes/acceptance.ts`, `server/migrations.ts` (v37), `server/screenshot/worker-runner.ts`, `server/acceptance/gates/capture.ts`, `.claude/skills/author/driver.mjs`.

## 7. EUI-BR-07 — element-level visual attribution + renderer policy (P0)

### Диагноз

Кластеры уже есть (`diffRegions`, `scripts/visual-diff-worker.mjs:208-236`), причинность — 9 кодов `causes[]` (`server/visual/causes.ts`), но owner назначается только кластерам, пересёкшимся с `effectSources` (`dominantElementKey`, `causes.ts:253-266`). При этом **полное дерево element bounds уже персистится** — `rects[]` (key, parentKey, bbox) лежит в `geometry.json` (`gates/geometry2.ts:306`), но не доезжает до метрик. `pass_with_exceptions` фактически недостижим: ни один гейт не пишет `exceptions[]`, оба профиля `allowExceptions:false` (`runner.ts:184-188`, `policies.ts:108`). Единственный server-owned пресет `live-text-v1` не привязан к renderer fingerprint и не ограничен регионом (`gates/visual.ts:76-101`).

### Дизайн

**`visualAttributionV2`:**

- общий инфра-блок **S1 «element ownership map»**: `rects[]` + `slotBindings` (`server/acceptance/cases.ts:63-93`, уже в `GateContext`) → карта `elementKey → {bboxDevicePx, ownerComponentId, depth, hasText}` (`hasText` — новое поле замера в `geometry.mjs`); артефакт `element-map.json` в evidence;
- атрибуция кластера: глубочайший элемент, покрывающий ≥ порога кластера; ≥95 % mismatched pixels обязаны получить owner либо явно попасть в `unknown` total;
- `paintClass` (live-text|vector-edge|registry-image|fill|stroke|effect|geometry|unknown): live-text — edgeResidual внутри text-элементов; registry-image — пересечение с ресурсами barrier-receipt (BR-03 даёт ownerElementKey per asset); geometry — из geometry facts; форма кластера — ровно контракт фидбэка §10 (bounds, mismatchedPixels, owner*, paintClass, sourceAssetId, raw/aaPct, bestOffset, `structural`, basis[], confidence);
- `structural=true` при geometry shift, missing asset, wrong fill/stroke/effect или mismatch вне заявленного owner; итог — per-element totals + full-case totals (большой structural-кластер не прячется за AA другого элемента);
- reference matte/flattening, color profile, renderer/font fingerprints, comparison policy — в receipt (расширение `manifestOf`, `orchestrator.ts:775-824`).

**`rendererPolicyProfilesV2`:**

- server-owned реестр профилей (расширение паттерна `TEXT_AA_PRESETS`): `{profileId, rendererFingerprint, scope: {paintClass, region?}, maxResidualPct, expiry: fingerprints}`; публикуется в `/capabilities` **до** рана;
- профиль не создаётся из одного run (только код/конфиг сервера), не применяет общий процент к кейсу, ограничен paint class/element region, никогда не покрывает `unknown`/`structural`;
- применение — «вторая инстанция» в visual gate: пишет `exceptions[]` (первый продюсер) → `pass_with_exceptions` через существующий `foldRunVerdict`; новый профиль политики с `allowExceptions: true`;
- истечение: несовпадение renderer/fonts/matte/asset/geometry fingerprint → профиль неприменим (typed reason);
- `suggestedPolicy` остаётся report-only.

AC (фидбэк §10): фикстура с текстовым и структурным кластерами — ownership ≥95 %; renderer-only residual под опубликованным профилем → `pass_with_exceptions` с точным scope+expiry; structural residual → fail с указанием owner; ни один residual не проходит из-за общего budget.

Зона: `scripts/visual-diff-worker.mjs`, `server/visual/causes.ts`, `server/acceptance/{runner,suggest,gates/visual,evidence,orchestrator}.ts`, `src/capture/geometry.mjs` (hasText), `server/acceptance/policies.ts`.

## 8. EUI-BR-08 — subject/integration verdict (P1)

### Диагноз

Рекурсивное resolved-дерево (`ResolvedSlotBinding[]`) уже в `ctx.case` и evidence, но visual его не использует; `caseSetComparisonSchema` содержит только `matte` (`caseSetSchema.ts:366-371`).

### Дизайн (`comparisonOwnershipV1`)

- `comparison` += `ownership?: "subject-and-integration"`, `subjectComponentId?`, `dependencyPolicy?: "require-eligible-acceptance"` (strict, optional, без default); `FIELD_LAYERS` → слой comparison;
- ownership mask строится сервером из S1 (элементы dependency-поддеревьев по slot tree), не из ручного crop; visual gate считает **два** диффа: `subjectVerdict` (маска subject-owned pixels) и `integrationVerdict` (полная канва, как сегодня); исключённые пиксели остаются в integration diff, группируются по dependency component/version/element key;
- promotion eligibility: subject promote допустим только при `subjectVerdict=pass` + все runtime deps опубликованы с eligible acceptance evidence + contract/interaction/geometry/determinism полного дерева clean; failing `integrationVerdict` явно сохраняется в receipt; врезка — в существующую проверку promote (`PROMOTABLE_RUN_STATUSES`, `policies.ts:174` + promote-гейт);
- mismatch parent background/mask/gap/clipping/interaction — subject failure (маска не покрывает parent-owned пиксели).

AC — фидбэк §11 на фикстуре «carousel-обёртка + 2 dependency-ребёнка с намеренным residual».

Зона: `src/acceptance/caseSetSchema.ts`, `server/acceptance/{gates/visual,runner,ids}.ts`, `server/components/promote.ts`.

## 9. EUI-BR-09 — scroll/overflow ownership для FlowRoot (P1)

### Диагноз

Warning — `content-clipped-by-frame` в probe-анализе (`src/capture/geometry.mjs:106-117`): union всех маркеров против frame, без осей и владельцев. `overlayScrollOwnership` покрывает только Overlay-prop `scroll` + composition-токены и одну ветку `scrollClipOf` для overlay-корня — на FlowRoot/probe не влияет.

### Дизайн (`flowOverflowOwnershipV1`)

- `elementSchema` += `overflowOwnership?: z.strictObject({axis: "x"|"y", mode: "scroll", viewportOwner?: string, expectedContentOverflow?: boolean})` (`src/prototype/schema.ts:79-90`, рядом с `region`; documentVersion не меняем — поле optional в allowlist, ревизия схемы фиксируется в `capabilities.documentVersion` note);
- `analyzeGeometry` получает декларации (через probe bootstrap из документа): для объявленного owner'а вклад его поддерева по объявленной оси ограничивается scrollport boundary; отдельно записываются `scrollportBounds`, `scrollContentBounds`, clip chain, owned overflow;
- незаявленный overflow, vertical spill, overlap FlowRoot regions, paint вне scroll clip — по-прежнему warning/failure (новые issue-коды `unowned-overflow`, `owned-overflow-exceeds-axis`);
- составные компоненты/composition: аналогичное объявление в composition layout-токенах (`src/prototype/compositionV3/layout.ts:44-65`) — компилируется в то же runtime-поле.

AC — фидбэк §12: фикстура «FlowRoot 390 px + два rail 552 px» — top-level warning исчезает, rails сохраняют content bounds, незаявленный overflow продолжает давать warning.

Зона: `src/prototype/schema.ts`, `src/capture/geometry.mjs`, `server/screenshot/service.ts` (bootstrap probe), `src/prototype/compositionV3/layout.ts`.

## 10. EUI-BR-10 — blocker fingerprint и retry disposition (P1, cross-cutting)

### Диагноз

Refresh algebra уже машиночитаема на уровне полей (`FIELD_LAYERS`, `ids.ts:621-703`; каскад `attemptReuse` c причинами `recompute:*`/`rediff:*`/`recapture:*`). Нет: `blockerFingerprint`, endpoint, маппинга в `unchanged|recompute|rediff|recapture|rebuild`, типизированных `blocked:*` (это конвенция агентских stop-receipts, в сервере кодов нет).

### Дизайн (`blockerFingerprintV1`)

- **Read-only** `GET /api/acceptance-runs/:runId/retry-disposition?candidateId=&caseSetId=` (врезка рядом с `cases`/`evidence`, `server/routes/acceptance.ts:793-861`); не создаёт run, не меняет state;
- вычисление: сохранённые fingerprints терминального рана (frame/comparison/verdictPolicy per case) сравниваются с «would-be» fingerprints тех же кейсов под текущим состоянием сервера (текущий rendererFingerprint, resourceBarrierPolicyVersion, geometryContractVersion, schemaResolverVersion, policy hashes); дельта полей → слои `FIELD_LAYERS` → disposition: пусто→`unchanged`, verdict→`recompute`, comparison→`rediff`, frame→`recapture`, candidate.sourceHash/schema→`rebuild`;
- `blockerFingerprint = "blk_" + sha256(терминальные gate-коды + basis)`; basis — ровно контракт фидбэка §13; `suggestedAction`: `resume-run` (если run resumable по BR-06), `new-run`, `update-source`, `do-not-retry`;
- ответы для unchanged runs — `do-not-retry`; после rollout BR-02…07 меняются только соответствующие basis-поля.

Зона: `server/routes/acceptance.ts`, `server/acceptance/{ids,repo}.ts` (чтение), `server/contracts.ts`. Может идти параллельно всем остальным (read-only).

## 11. Что не входит в план (фидбэк §14)

Не платформенные дефекты и не наша зона: отсутствующие Figma references source-blocked lanes; продуктовые решения (actions/navigation/routing/controlled input/animation); current-main Vitrina до сверки source branch; CPQR/Tooltip/Badge residual, если BR-07 докажет structural/source-owned; package sealing чужих lanes; sandbox/DNS локального агента. Наша обязанность — точное evidence для переадресации, не платформенный pass.

## 12. Волны исполнения (Stage 3, после ревью плана)

Порядок фидбэка §15 скорректирован инженерными зависимостями: BR-07 требует S1 (element map) и выигрывает от BR-03 (registry-каналы в barrier receipt), поэтому идёт после capture-волны; BR-10 read-only и параллелится.

| Волна | Задачи | Параллельность / владение |
|---|---|---|
| V0 | Фикстуры-репродукции + red-тесты всех BR; диагностика BR-04 (поиск фактического клэмпа) и подтверждение H1–H4 (BR-01) | параллельно, `test/fixtures/**`, e2e |
| V1 | BR-01 (resolver) ∥ BR-06 (resume, миграция v37) ∥ BR-10 (endpoint) | непересекающиеся зоны: validation/pipeline · orchestrator/repo/routes · routes/ids-read |
| V2 | BR-02 + BR-04 (одна зона capture canvas) ∥ BR-03 (readiness/barrier) | schema/`ids.ts` — правит один агент (общая точка `FIELD_LAYERS`) |
| V3 | BR-05 (geometry contract v3 — bump последним в capture-зоне) ∥ BR-09 (probe-уровень) | geometry.mjs общая — BR-05 владеет `detailOf`, BR-09 — `analyzeGeometry`; при конфликте — worktree-изоляция |
| V4 | S1 (element map) → BR-07 → BR-08 | последовательная цепочка в visual-зоне |
| V5 | Capabilities/contracts/openapi/docs/driver-сводка; release package §16 фидбэка по каждой capability; changelog в `server-api.md` | один агент |

Каждая волна: субагент(ы) Opus с явным file ownership, «читай .d.ts, не угадывай», «не коммить»; оркестратор независимо гоняет done-критерии (unit + `bun test server` + прицельные e2e) до коммита. Финал: `npm run verify` + `npm run e2e` + runtime-прогон `/verify`.

## 13. Миграции, флаги, деплой

- Миграции: **v37** (resume lineage + phase checkpoints). Остальное — без схемы БД (профили BR-07 — код; retry-disposition — read-only).
- Новые kill-switch env (все с warn-строкой в `main.ts` и compose-строкой при деплое): `EASYUI_SCHEMA_RESOLVER_V2_DISABLED`, `EASYUI_PAINT_PADDING_DISABLED`, `EASYUI_RESOURCE_BARRIER_V4_DISABLED`, `EASYUI_EXACT_HUG_DISABLED`, `EASYUI_GEOMETRY_OWNERSHIP_DISABLED`, `EASYUI_ACCEPTANCE_RESUME_DISABLED`, `EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED`, `EASYUI_RENDERER_POLICY_PROFILES_DISABLED`, `EASYUI_COMPARISON_OWNERSHIP_DISABLED`, `EASYUI_FLOW_OVERFLOW_OWNERSHIP_DISABLED`, `EASYUI_BLOCKER_FINGERPRINT_DISABLED`.
- Fingerprint-ломающие изменения (geometryContractVersion 3, resourceBarrierPolicyVersion 4, новые capture-поля) — **одно деплой-окно, одна пересъёмка корпуса** (полная пересъёмка прод-корпуса всё ещё не амортизирована — см. память feedback3).
- Деплой в прод — после закрытия rollback-window v32–v36 либо по явной команде; canary-порядок: capabilities-смоук → BR-10 (read-only) → BR-01 → остальное.
- Гейт `renderer-corpus` в CI: изменения barrier/geometry могут сдвинуть outcome-ожидания — адопт только CI-артефактом, pixel-sha не адоптировать без разбора.

## 14. Риски

1. **Пересъёмка корпуса** (contract v3 + barrier v4): стоимость и окно — считать через `impacted`-план до деплоя; смягчение: батч в одно окно, `EASYUI_PROMOTE_POLICY_STRICT` выключен на окно.
2. **BR-01 затрагивает save-путь всех документов**: регресс здесь ломает авторинг; смягчение — kill-switch на весь resolver + дифференциальный тест «старый vs новый резолвер на корпусе фикстур» до включения.
3. **BR-04 без подтверждённого клэмпа**: возможно, «минимум 24» — артефакт на стороне мигратора; V0-диагностика обязана либо воспроизвести, либо зафиксировать evidence-ответ (release note вместо кода).
4. **BR-06 resume поверх `one_in_flight`**: гонки resume/новый run; смягчение — CAS-переходы статуса по образцу migration-commit.
5. **BR-07 ≥95 % ownership** — амбициозный порог; если на шумных фикстурах не достигается, честный `unknown` total (контракт это допускает), не ослабление structural-правил.
6. **Rollback-window**: до закрытия не персистить на проде сущности v37; локальная разработка не затронута.

## 15. Триаж ревью

(Заполняется после Stage 2: принято/отклонено с обоснованием.)
