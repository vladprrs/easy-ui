# План: снятие блокеров EUI-BR-01…10 (фидбэк YP v2 от 2026-08-09)

Статус: **Stage 3 выполнена (волны V0–V5) — см. коммиты ветки `wave/eui-br`. Деплой не производился: merge в `main` (=автодеплой) — после закрытия rollback-window v32–v36 по §13 либо по явной команде. Порядок включения kill-switch'ей, окна инвалидации и go/no-go — `.claude/skills/deploy/SKILL.md` (секция «Wave EUI-BR»); deliverable для координатора миграции — `docs/EASYUI_BLOCKER_REMOVAL_RELEASE_PACKAGE.md`; changelog capability — `docs/server-api.md`.**

Отклонения реализации от плана, зафиксированные по итогам Stage 3 (подробности — в release package и в deploy-скилле):

- **`CASE_FINGERPRINT_ALGO_VERSION` не поднимался** (остался `7`). Планировавшийся bump 7→8 (§0/§13) заменён двумя **условными** входами — `comparisonPolicyVersion` (BR-04, слой сравнения) и `geometryOwnershipPolicyVersion` (BR-05, вердиктный слой): они двигают ровно те случаи, которые теперь судятся по новым правилам, а не обесценивают reuse всего корпуса.
- **BR-01a и BR-01b гасятся одним тумблером** `EASYUI_SCHEMA_RESOLVER_V2_DISABLED` — «включить только 01a» средствами env невозможно (только сборкой).
- **V0 опроверг две формулировки блокеров**: клэмпа канвы 24 px не существует (BR-04 — реальные дефекты: недостижимый fail мелких hug-кейсов и слепота к масштабу эталона), tail не расширяет layout union (BR-05 — ломается `rootBoxOf`). Гипотеза H3 (BR-01) ложна, m18 (BR-06) разрешена как путь B — рестарт процесса.
- **§16 фидбэка закрыт частично**: corpus handoff не получен, before/after — репродукции на синтетических фикстурах; вторая фаза на стороне мигратора (§11 release package).

Исходный статус: v3 — Stage 2 пройден: два адверсариальных ревью (раунд 1) + контрольное ревью (раунд 2), полный триаж в §15; блокирующих возражений не осталось.
Источник требований: `docs/EASYUI_BLOCKER_REMOVAL_REQUIREMENTS_20260809.md` (далее — «фидбэк»).
Дата плана: 2026-08-08. Привязки file:line — по `main@3ccc74e` (проверены ревью выборочно, расхождений нет).

## 0. Контекст и рамки

Фидбэк — проверяемый backlog из 10 требований (EUI-BR-01…10) с capability-именами, JSON-контрактами и acceptance-критериями на **сохранённых** артефактах мигратора. Их байтов в репо нет (`../../artifacts/...` — вне проекта), поэтому:

- **Входной deliverable волны — «corpus handoff» от координатора миграции**: `cset_*`-манифесты, candidate source, raw reference assets и stop-receipts для pay-card-input v21, pay-badge v03, pay-tooltip v02, pay-button-group v07, pay-payment-schedule rev6, CPQR ×2. Импортируем как байты в `test/fixtures/` — только так выполняются §3 («fixtures на сохранённых bytes») и §16 («before/after receipts с прежним blocker code») фидбэка.
- Пока handoff не получен: каждое требование получает синтетическую фикстуру-репродукцию + red-тест, а в release package фиксируется явное ограничение: **мы поставляем capability; подтверждение снятия blocker'а — вторая фаза на стороне мигратора**. Численные AC фидбэка (391×88, 21/29 Card Input, 24/36 Tooltip, 180.5 s) без handoff непроверяемы у нас.

Жёсткие рамки:

- **Ветка, не main.** Push в `main` автодеплоит прод; rollback-window v32–v36 открыт. Вся работа Stage 3 идёт в ветке `wave/eui-br` с поэтапными коммитами по зонам; **единственный merge в `main` — после закрытия окна v32–v36 либо по явной команде пользователя**. Все capability выключены по умолчанию (deploy all-off, §13).
- Fingerprint-ломающие включения управляются kill-switch'ами; выкладка образа кадры не инвалидирует. **Окон инвалидации два** (§13): окно пересъёмки capture/barrier (BR-02/03/04) и окно geometry-семантики (BR-05/09). Изменения **смысла кода** без изменения полей манифеста (канва сравнения, метрики диффа, интерпретация геометрии) инвалидируются bump'ом `CASE_FINGERPRINT_ALGO_VERSION` (7→8) — канонный механизм против молчаливого reuse (`ids.ts:36-40`); он не входит в `frameFingerprint`, поэтому даёт re-diff/recompute без пересъёмки.
- Общие правила §3 фидбэка обязательны для каждой задачи: strict-схемы (неизвестное поле → 422), capability/contract version с сервера, receipts с requested+effective, корректный recompute/rediff/recapture/rebuild, legacy byte-for-byte под kill-switch, `suggestedPolicy` report-only.
- Инварианты кода: новые поля case-set — только `.optional()` **без** `.default()` (контентный адрес `cset_`); каждое новое поле получает слой в `FIELD_LAYERS` (`server/acceptance/ids.ts:621`) — пространство ключей там `PolicyLeaf|CaseLeaf|SurfaceLeaf`, т.е. новые capture-поля живут как `surface.*` в `CaseSurface`, а для **вложенных объектов** (например `comparison.*`) тотальный `satisfies` не работает — обязателен отдельный тест «каждый ключ объекта объявлен в слое»; strict-схемы definition правятся «комплектом» из трёх (`server/components/extract-subprocess.ts:12`); capability-паттерн — `features.*`+`limits.*` в `server/routes/meta.ts`, kill-switch-хелпер в модуле-энфорсере, warn в `server/main.ts:283-311`, схема в `server/contracts.ts` + `contract.test.ts` + `openapi.json` + `docs/server-api.md`.
- `server/acceptance/ids.ts` на протяжении волн V2–V4 правится строго одним агентом за волну, последовательными merge (общая точка конфликтов).

## 1. EUI-BR-01 — единый resolver схемы published component (P0, milestone)

### Диагноз (разведка, подтверждено ревью)

Схема компонента добывается четырьмя путями: save — live-import TSX через `snapshotDefinitions` (`server/validation.ts:184-226`); render/status/snap — `pins()`/`headPin()` (`server/repos/prototypes.ts:145-163`); каталог — `definition_meta.propsJsonSchema`; preview-tree — `definition_meta` (схем props не резолвит). Гипотезы root cause 422:

**Итоги V0-D1** (тесты `server/schema-resolver-diagnosis.test.ts`, 6 pass):

- **H1 — ПОДТВЕРЖДЕНА, точная репродукция симптома**: composition-пины применяются по имени ко всему документу (`server/validation.ts:57,152,199-204`); авторский элемент вне композиции получает 422 `Unrecognized key` от exact-схемы пина; тот же документ без композиции — 201;
- **H2 — ПОДТВЕРЖДЕНА, но как слепота, не ложный fail**: readiness по нераскрытому документу (`server/readiness.ts:174`) не падает (`@eui/Composition` — host-примитив), а **не видит** компоненты внутри раскрытия вовсе (`pins=[]`) — структурно не способен поймать prop-ошибку/расхождение версий;
- **H3 — ЛОЖНАЯ**: `(id, rev)` контентно-иммутабельны через все API-пути (включая re-stage failed-строки); промах кэша `imported` недостижим. **Инвалидация в транзакции promote из дизайна ИСКЛЮЧЕНА**;
- **H4 — ПОДТВЕРЖДЕНА**: перенос компонента в другую DS + publish v2 ⇒ save видит v1 (фильтр DS), `headPin` — v2 (без фильтра, пин перескакивает в чужую DS).

### Дизайн — два этапа

**BR-01a — минимальный фикс подтверждённых гипотез (ранний, отдельная выкатка).**

- Composition-пины применяются **только** к элементам, порождённым раскрытием композиции (`$`-префикс ключей), не по имени. Ограничение структуры: карта определений name-keyed (`custom[name]`, `validation.ts:199-226`) — два разных пина одного имени в ней невыразимы; при конфликте «авторский элемент требует head@N, композиция пинует @M≠N» — типизированный `422 component_pin_conflict` с обеими версиями и путями (не молчаливый выбор одной схемы).
- Readiness переводится на раскрытый документ (H2), фильтр DS согласуется между save-SQL и `headPin` (H4).
- Типизированный issue `component_prop_unknown` с контекстом фидбэка §4: path, componentId, resolvedVersion, sourceHash, `propsSchemaHash`, catalogRevision, acceptedKeys. `propsSchemaHash` — **новая деривация**: sha256 канонизированного `definition_meta.propsJsonSchema`; при отсутствии схемы у компонента — `null` (не отказ). Маппинг zod `unrecognized_keys` → код: `src/prototype/validate.ts:264-316` + `server/http.ts:47-53`.

**BR-01b — единый `ResolvedComponentGraph` (поздний, V4).**

- Модуль `server/components/resolvedGraph.ts`: per-element `{componentId, version, rev, sourceHash, propsSchemaHash, catalogRevision, designSystemMetaVersion, origin}`; ключ кэша — ровно контракт фидбэка §4. Потребители: save, readiness, `screenRenderStatus`/`bundleReadiness`, snap (`server/screenshot/service.ts:706+`), preview-tree. Для `track:head` — версия, которую resolver запишет в pins; fallback на предыдущую active при разрешённой новой — запрещён.
- `resolvedVersion`/`sourceHash`/`propsSchemaHash` добавляются в ответы `status`, save receipt и snap — это правки роутов + `contracts.ts`/`contract.test.ts`/`openapi.json`/`docs/server-api.md` (в зоне владения).
- Дифференциальный тест «старый vs новый резолвер на корпусе фикстур» — done-критерий V4 и CI-артефакт, не только смягчение риска.

Capability: `prototypeSchemaResolverV2` (contract version 2), kill-switch `EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1` → старый путь byte-for-byte (BR-01a-фиксы гейтятся тем же свитчем).

### AC (зеркалят фидбэк §4)

Save копии документа с `@2 {mode:"current-main"}` проходит; `status`/save receipt/snap называют одинаковые resolvedVersion/sourceHash/propsSchemaHash; заведомо неизвестный prop отклоняется с фактической схемой; после promote повторный save не видит старую схему.

Зона: `server/validation.ts`, `server/readiness.ts`, `server/components/{pipeline,resolvedGraph}.ts`, `server/repos/prototypes.ts`, `src/prototype/validate.ts`, `server/http.ts`; в 01b дополнительно `server/routes/{prototypes,renderStatus}.ts`, `server/screenshot/service.ts`, `server/contracts.ts` (+ `promote.ts` — только если H3 подтвердится).

## 2. EUI-BR-02 — per-side paint padding (P0)

### Диагноз

Поле краски — скалярный CSS `padding` (`src/capture/CaptureComponent.tsx:186`), дефолты 64/16, потолок 256 (`server/screenshot/service.ts:194-202,950-953`); в схеме case-set поля нет; гейт геометрии зовёт `captureCase` без `paintMargin` (`gates/geometry2.ts:238`). **Критично (ревью B2):** канва сравнения строится из того же скаляра — `referenceCanvasOf` берёт `facts.paintMargin ?? COMPARISON_PAINT_MARGIN_PX` и кладёт placement `(margin·dsf, margin·dsf)` (`server/acceptance/gates/visual.ts:217-238`); при асимметричном padding эталон уедет.

### Дизайн (`paintCapturePaddingV1`)

- Поле — **per-case**: `caseSetCaseSchema` += `paintPaddingPx?: z.strictObject({top,right,bottom,left: int 0..MAX_PAINT_MARGIN_PX})` (optional, без default). Это отступление от JSON-формы §5 фидбэка (там поле в `capture`-блоке набора) — согласуется с координатором письменно: set-level поле двигало бы кадры **всех** кейсов, нарушая его же AC «recapture только затронутых cases». **Не в `CaseSurface`**: объект `surface` хэшируется во frame целиком (`ids.ts:285`), декларация слоя там ничего бы не решала. Вход отпечатка — явное поле `FrameFingerprintInput.paintPaddingPx` с условным спредом манифестного факта (паттерн `slotBindings`); слой `perCase.paintPaddingPx: ["frame"]`.
- **Канва сравнения от padding не зависит (блокер B3 раунда 2)**: comparison margin остаётся comparison-owned (существующая константа/`referencePlacement`), кандидатный растр кропается до канвы сравнения; `GeometryFacts` несёт capture-padding **отдельно** от comparison margin. AC-тест: «объявлен per-side padding ⇒ визуальные метрики кейса байт-в-байт прежние» (выполняет букву §5: padding влияет на измеримость paint, visual остаётся на `referenceExport`).
- Транспорт: `bootstrap.paint` → `{marginPx} | {paddingPx:{t,r,b,l}}` (`src/capture/protocol.ts:295`); CaptureComponent — четырёхстороннее CSS padding; `geometry2Gate` передаёт per-case значение в `captureCase`.
- **Бюджет кадра**: типизированный 422 `capture_budget_exceeded` по площади `(w+left+right)×(h+top+bottom)×dsf² ≤ 20 Мпикс` (сейчас `validateViewport` считает только вьюпорт — `service.ts:534-543`); лимит публикуется в `limits`.
- Ink clamp → типизированный код `paint_capture_clipped` с требуемым минимумом по стороне; receipt: requested/effective per side, clipping edge, полный paint bounds, raster canvas.
- Семантика: `rootBounds`/`layoutUnion`/`referenceExportDims`/размер raw reference не меняются.

Kill-switch (группа `EASYUI_CAPTURE_V4_DISABLED`, общий с BR-04): поле в манифесте отклоняется типизированным 422 на `case-sets put`/старте рана; манифесты без поля — byte-for-byte.

AC (фидбэк §5): фикстура «root 343×88, декор вправо до 398» — риск-кейсы меряют полный paint при `right:64`; root/layoutUnion/referenceExport неизменны; недостаточный padding → `paint_capture_clipped` с minimum; изменение padding пересобирает только затронутые кейсы (per-case поле → frame-слой).

Зона: `src/acceptance/caseSetSchema.ts`, `src/capture/{protocol,CaptureComponent,receipt,failureCodes,geometryPolicy}.ts`, `server/screenshot/service.ts`, `server/acceptance/{ids,gates/capture,gates/geometry2,gates/visual}.ts`.

## 3. EUI-BR-03 — полный registry-resource barrier (P0)

### Диагноз

`collectResourceManifest` (`src/capture/readiness.ts:589-616`) не видит srcset-кандидаты, псевдоэлементы, шрифты, candidate/overlay-deps и icon-registry. Root cause late images: registry-`<img>` появляется после асинхронного доезда темы (`src/designSystems/theme.tsx:191-207` → `shared.icons`, `server/shims/abi-v4.ts:39-47`). `resource_late_after_barrier` даёт `met:false` → gate **fail** (`gates/readiness.ts:112-124`). Сопутствующий дефект шимов: eval-time захват `shared` **и `React`** (`abi-v4.ts:23-24`); реальная поломка — шим исполнен до `ensureEasyUiShared` либо объект заменён.

### Дизайн (`resourceBarrierV4`, `resourceBarrierPolicyVersion: 4`)

- Фаза `registry` **до** первого манифеста: ожидание применения темы/реестра (`__easyUiShared.icons` заполнен либо темы нет) с собственным дедлайном внутри бюджета барьера — при отсутствии темы фаза завершается мгновенно (без дедлока).
- Каналы манифеста: `img|srcset`, `css-background|mask|content` (+`::before/::after` через `getComputedStyle(el, pseudo)`), `icon-registry`, `font` (`document.fonts`), assets кандидата/overlay. Источник `expected` для последних — named: `draft.assetIds`/`overlayAssetIds` (сегодня питают только allowlist, `draftComponentAllowedUrls`, `service.ts:~942`) прокидываются в bootstrap как ожидаемый манифест.
- Per-resource запись — контракт фидбэка §6 (assetId, ownerElementKey — ближайший `data-eui-key`, ownerComponentId — через slotBindings, channel, discoveredAt, requested/loaded/decoded/completedBeforeStableFrame).
- **Сужение флипа вердикта (ревью M7)**: `indeterminate` с кодом `resource_barrier_incomplete` — **только** для barrier-кодов (`resource_late_after_barrier`, `resource_decode_failed`, `expected≠decoded`); остальные причины `met:false` (шрифты, overflow, таймаут readiness) остаются `fail` как сегодня. Наблюдаемость на уровне рана: run-verdict остаётся `fail` (свёртка `foldRunVerdict` не меняется), но `status_reason` и case-receipt несут `resource_barrier_incomplete` — различие видно мигратору; `server/acceptance/{runner,repo}.ts` — в зоне владения.
- **Инвалидация по содержимому темы (ревью M6)**: при включённом barrier v4 во frame-слой добавляется хэш theme-контента (иконки+шрифты, деривация из `designSystemMetaVersion`+asset-пинов) — иначе смена иконок темы не инвалидирует кадр и §6 не выполняется по букве.
- `preloadAssets?: string[]` — **per-case** поле в `caseSetCaseSchema` (optional; слой `perCase.preloadAssets: ["report-only"]`), не в `CaseSurface` — любой ключ `surface` автоматически стал бы кадровым входом вопреки декларации слоя (ревью M2 раунда 2); hint не освобождает сервер от обнаружения.
- Фикс шимов abi-v2/3/4: `React`, `tokens` и `shared` читаются в call-time; тест «шим импортирован до `ensureEasyUiShared`».
- Kill-switch-иерархия (ревью C6): `EASYUI_RESOURCE_BARRIER_DISABLED=1` (существующий) — барьер выключен целиком (доволновая политика), приоритетнее; `EASYUI_RESOURCE_BARRIER_V4_DISABLED=1` — барьер работает по v3-политике byte-for-byte. Оба **restart required** (политика читается раз на процесс и питает три отпечатка); смоук-ключ — `acceptance.readinessPolicyVersion`.
- **Go/no-go по стоимости — GO (V0-D5, реальный chromium-замер)**: расширенный обход стоит +7…32 мс/кейс против порога 2000 мс (запас 2-3 порядка; пессимистичная верхняя оценка 0.12 с/кейс при сохранённом cap 400). Обязательные решения из замера: (а) pseudo-канал под существующим `ELEMENT_SAMPLE_LIMIT=400` (или отдельный `pseudoSampleLimit`), переполнение типизировано; (б) **документный предикат** — один скан `document.styleSheets`: нет правил `::before/::after` с `content|background-image|mask-image` ⇒ pseudo-канал пропускается целиком (поэлементный предикат некорректен и экономит ~15 %); (в) srcset-кандидаты — report-only записи канала, decode-цель только `currentSrc` (иначе фаза decode ×3 при `perResourceTimeoutMs` до 1000 мс); (г) фаза `registry` — под-дедлайн ≤500 мс, мгновенный выход без темы, исчерпание = `resource_barrier_timeout` с `ref:"registry:…"`; (д) `resourceBarrierBudgetMs`/`maxResources` не трогаем; подтверждающий end-to-end замер `settleResourceBarrier` — на фикстуре барьера в V2 (реальный каскад, фаза registry).

AC (фидбэк §6): на фикстуре с registry-иконками через тему форсированный recapture обнаруживает все direct registry images до первого evidence frame, `expected=decoded`, `lateAfterBarrier=[]`; no-image кейсы без лишних deps; повторный recapture не воспроизводит `missing-late-asset`; недогруженный asset называет assetId/owner/channel/phase. Инвариант-тест (ревью minor раунда 2): barrier-код ⇒ `readinessMet=false` **и** сравнивающие гейты пропущены (`readinessBlocksVisual` — «capture не становится visual evidence» держится именно на этом, не на статусе гейта).

Зона: `src/capture/{readiness,readinessPolicy,receipt,failureCodes}.ts`, `server/acceptance/gates/readiness.ts`, `server/acceptance/{runner,repo,ids}.ts`, `server/capture/resourceBarrier.ts`, `server/shims/abi-v*.ts`, `src/customComponents/shared.ts`, `server/routes/meta.ts`.

## 4. EUI-BR-04 — exact content-hug canvas < 24 px (P0)

### Диагноз

Литерала «минимум 24 px» в коде нет. Кандидаты в источники симптома: **(наиболее вероятный, ревью m19)** пара `padTo = root + 2·64` (`gates/visual.ts:~228`) × допуск `maxDimensionDeltaPx=8` (`scripts/visual-diff-worker.mjs:511-521`) — для 16 px корня канва 144 px против «голого» экспорта даёт `indeterminate` по дельте размеров, что снаружи читается как «нормализовано»; минимальный вьюпорт 64×64; минимум браузера. V0-диагностика обязана развести «минимум канвы» и «допуск сводимости».

### Дизайн (`exactContentHugCanvasV1`) — по итогам V0-D2 (тесты `server/acceptance/gates/hug-canvas-diagnosis.test.ts`, 10 pass)

Развилка разрешена: **клэмпа/минимума канвы нет ни на одном шаге** (проверена сетка вплоть до 1×1). «24» = верхняя граница окна сводимости `16 + maxDimensionDeltaPx(8)` с **молчаливым zero-pad** меньшей картинки до `max(refDims,candDims)` (`visual-diff-worker.mjs:527-528`). Попутно найдены два дефекта хуже заявленного: (а) `rawDiffPct` меряется по всей канве с margin — полностью перекрашенный 16 px компонент даёт 1.23 % < бюджета 2 % ⇒ **fail физически недостижим** для мелких hug-кейсов; (б) эталон не проверяется на масштаб — 1×-экспорт при dsf 2 проходит даже `pixel-strict-v1`. Legacy-ветка без канвы даёт `dimensions_irreconcilable delta 272` — то, что потребитель и читал как «нормализацию».

Правки V2 (все — comparison-слой ⇒ re-diff, покрыты ALGO-bump):

1. при объявленной канве (`padTo !== null`) — **точное** совпадение размеров (delta 0): канва построена сервером по объявленным числам, любая дельта = ошибка декларации;
2. запрет неявного zero-pad до `max(ref,cand)` при непустом `padTo` (legacy `padTo === null` — как есть);
3. `rawDiffPct` — по поверхности сравнения (`layoutRoot × dsf`), не по канве с margin (корневой фикс AC «16 px кейс проходит без per-case допусков»);
4. проверка масштаба эталона: `sourceDims` vs `layoutRoot × dsf` ⇒ типизированный `indeterminate reference_scale_mismatch` (чистая диагностика, вердикт не двигает).

Receipt: `rootBounds`, `comparisonCanvasCssPx`, `deviceScaleFactor`, `comparisonCanvasDevicePx`, отсутствие hidden padding.

Kill-switch — общий `EASYUI_CAPTURE_V4_DISABLED`. AC: шесть синтетических 16 px кейсов без canvas-size indeterminate; остальные visual residuals — re-diff, не подмена вердикта.

Зона: `server/acceptance/gates/visual.ts`, `scripts/visual-diff-worker.mjs`, `server/screenshot/service.ts`, e2e-фикстура.

## 5. EUI-BR-05 — decoration-aware geometry (P0)

### Диагноз

`visit()` безусловно выкидывает transform-узлы из layout-union (`src/capture/geometry.mjs:469`), `effectReachPx` для transform = 0 (`src/capture/geometryPolicy.ts:194`) — источник не может объяснить overflow ⇒ indeterminate. Внутренние узлы компонента не имеют element key (`geometry.mjs:337-342`), различает только `elementPath`.

### Дизайн (`geometryDecorationOwnershipV1`) — без source mutation (ревью B1)

**Итоги V0-D3** (тесты `src/capture/decoration-symptom-diagnosis.test.ts`, 8 pass): буквальный симптом «tail расширяет layoutUnion» опровергнут; реальных маршрутов блокера **четыре**: (1) probe-уровень `rects[]`/`content` без фильтра потока включает tail (391×112) — единственное, что видит автор, отсюда неверные `expectedGeometry` → безусловный `layout-overflow`; (2) при честном `expectedGeometry` — `paint-overflow-not-clipped` fail, снимаемый только отключением контроля краски; (3) `expectedSurfaces` по макету → `surface-mismatch` на `paint`, блокирует безусловно; (4) **tail-сиблинг ломает `rootBoxOf`** (`boxedGeneration` считает боксовых детей без учёта потока, `geometry.mjs:397-421`) → `root: not-measured` → вечный indeterminate — ближайшее к «24/36 roots». Фикс `effectReachPx` **исключён из дизайна** — атрибуция уже работает через пост-transform distance; связка с канвой визуала (`visual.ts:225` строит канву без tail, эталон — с tail) — зона BR-02/04.

Механизмы, по убыванию приоритета:

1. **Автоматическое правило (existing candidates, без правки TSX)**: transform/out-of-flow узел, чья pre-transform коробка вложена в union остального поддерева, — decoration: (а) **прозрачен для `boxedGeneration`/`rootBoxOf`** (снимает маршрут 4); (б) его post-transform вклад в paint — **легитимный, неблокирующий** overflow (снимает маршрут 2 без `allowPaintOverflow`).
2. **Per-case metadata (неоднозначный DOM + маршруты 3/5)**: `geometryOwnership?: Record<selector, {role:"decoration", participatesIn:["paint"]}>` в `caseSetCaseSchema`, адресация `elementKey`+`elementPath`; главный потребитель — `expectedSurfaces.paint`/канва визуала: декларация «tail участвует только в paint» позволяет объявить surfaces по макету без `surface-mismatch`.
3. **Probe-вывод разделяет габариты (маршрут 1)**: `probe:"geometry"`/driver-вывод обязаны различать «paint-габарит» (union post-transform) и «layout-габарит» — иначе авторы продолжат писать декорированные числа в `expectedGeometry`.
4. **`data-eui-part` в TSX + definition meta** — усиление для новых ревизий, не условие снятия blocker'а.

Измерение (аддитивные факты): для каждого transform/out-of-flow узла — `preTransformBounds` (offset-геометрия), transform matrix, `postTransformPaintBounds`, clip chain, причина включения/исключения из каждой surface.

**Версионирование (пересмотрено после раунда 2, блокер B1)**: отпечатки считаются **до съёмки и только из декларативных входов** (`caseFingerprintsOf` зовётся при постановке рана и как ключ reuse — `orchestrator.ts:315,389`, `runner.ts:697`), поэтому условность «по результату измерения» запрещена — она дала бы кейсу два разных fingerprint. Правила:

- новые факты замера (`preTransformBounds`, matrix, …) — вне отпечатка, прецедент W1a (дифференциальный тест «замер расширился ⇒ frame fingerprint не изменился»);
- `geometryContractVersion:3` в отпечаток — **условно только по манифестному факту**: кейс объявил `geometryOwnership` (законный условный спред, известен до съёмки);
- **авто-правило — не кадровый вход вовсе**: оно не меняет пиксели, а меняет интерпретацию фактов ⇒ это verdict-слойное изменение, инвалидируемое bump'ом `CASE_FINGERPRINT_ALGO_VERSION` (§13) — recompute/переоценка без пересъёмки;
- доволновой кадр без `preTransformBounds` при затребованной decoration-семантике ⇒ отказ от recompute, честный recapture кейса (прецедент `expectedSurfaces`, `contracts.ts:2292`).

Кейсы без декораций сохраняют кадры ⇒ AC BR-10 «unchanged → do-not-retry» выживает.

**V0-диагностика BR-05 (обязательная, риск «чиним не то»)**: симптом фидбэка «tail расширяет layout union у 24/36 roots» текущим кодом не воспроизводится — transform-узлы **уже** исключены из union (`geometry.mjs:469`); вероятный реальный маршрут — legacy-ветка/`expectedGeometry`-сравнение или probe-уровень. Репродукция обязана предшествовать дизайн-финализации авто-правила.

Валидация против злоупотребления: audit gate отклоняет метку/авто-классификацию узла, являющегося in-flow контейнером с layout-детьми — код `geometry_ownership_invalid`.

Kill-switch — группа `EASYUI_GEOMETRY_OWNERSHIP_DISABLED` (общая с BR-09).

AC (фидбэк §8): фикстура «tooltip с transform-tail 8×24» — root/layout verdict clean; tail в `paint` и в visual diff; ошибочная метка на in-flow child отклоняется; visual residual остаётся fail.

Зона: `src/capture/{geometry.mjs,geometry.d.mts,geometryPolicy.ts}`, `src/acceptance/caseSetSchema.ts`, `server/acceptance/gates/{geometry2,audit}.ts`, `server/acceptance/ids.ts`, `scripts/screenshot-worker.mjs`, `scripts/screenshot-pool-worker.mjs`, `server/screenshot/worker-mjs.d.ts`; definition-часть (механизм 3): `src/catalog/normalize.ts`, `server/components/extract-subprocess.ts`.

## 6. EUI-BR-06 — resumable acceptance (P0)

### Диагноз

Фаз уровня run нет — только per-case `GATE_ORDER`. **Итоги V0-D4 (m18 разрешена)**: пути «первый кейс упал → весь ран error» в коде нет — цикл кейсов не прерывается, 180.5 s это стоимость одного кейса; наблюдение мигратора почти наверняка **путь B — рестарт процесса**: `sweepNonTerminalRuns` сносит ран в `error`, кейсы залипают `running`/`pending` навсегда, манифест не пишется, in-memory `caseSets`/`surfaces` теряются. Дополнительно установлено: `contract/defaults/audit` «прошли для всех 20» честно — они первые три per-case и капчур не трогают; причина падения кейса (`execution.error`) **не персистится нигде**; у пула `ensure()` нет таймаута; недоступный браузер (501 `screenshot_unavailable`) не считается продуктовым отказом и ретраится, мёртвый рендерер жжёт N×3×60 s без circuit breaker'а; `queue_full` может съесть все попытки всех кейсов за ~15 s без различимого `statusReason`.

### Дизайн (`acceptanceResumeV1`, миграция v37)

- **Под-этап 1 — phase↔gate mapping + per-gate fingerprints (собственные AC до resume).** Публичные фазы фидбэка §9 мапятся на реальность: `resolve`=resolveCandidateSubject, `validate/compile`=contract/defaults/audit, `allocate-renderer`=спавн/ensure воркера (получает **отдельный таймаут**, отличимый от capture), далее гейты. Run-level `lastCompletedPhase` = минимальная фаза по незавершённым кейсам (документируется). Per-gate fingerprints определяются и пишутся в `gates_json` (без них reuse гейтов был бы «молчаливым reuse», запрещённым §3); замер write-амплификации `persistCase`-после-каждого-гейта на 64-кейсовом ране — go/no-go под-этапа.
- **Resume = новый run, не воскрешение (ревью B3/B5 обоих пакетов).** Терминальный ран неизменяем (receipts, `evidence_manifest_hash`, promote-инварианты). `POST /api/acceptance-runs/:id/resume` создаёт новую строку с `resumed_from_run_id`, `attempt`, тем же candidate/case-set/policy; идемпотентность — **детерминированный** `idempotency_key = "resume:<sourceRunId>:<attempt>"` (колонка nullable, NULL-ы в SQLite различны — без формулы дедупликации нет; ревью M3); resume уже-resumed рана → `409` с указанием живого/последнего продолжения; lineage несёт также прежние `statusReason`/`phase` («предыдущая ошибка» из §9 фидбэка); конкуренция — существующий `one_in_flight` (SQLITE_CONSTRAINT маппится в типизированный `409 run_in_flight`); CAS-переходы по образцу `server/migration/commit.ts:540-554`. Completed gates переиспользуются только при совпавших per-gate fingerprints; при несовместимости — `409` с указанием нового рана с `supersedesRunId` (reuse компиляции кандидата и non-render гейтов). Это соответствует §9 фидбэка: lineage `resumedFromRunId` и есть ссылка на прежний ран.
- **Шов `allocate-renderer` — в screenshot-сервисе, не в оркестраторе (V0-D4)**: воркер эмитит веху `{"type":"allocated"}` после `chromium.launch`; до вехи — `ALLOCATE_DEADLINE_MS` (~10-15 s), после — capture-дедлайн (`service.ts:1254` получает оба); у пула — `ensure`-хендшейк с собственным дедлайном, job-дедлайн стартует после подтверждения аллокации. Новые исходы: `renderer_unavailable` (терминальный) и `allocate_timeout`; 501 `screenshot_unavailable` перестаёт ретраиться (`isProductRefusal`); прекондиция `service.available()` один раз до цикла кейсов.
- **Персист причины**: `error_json` (`{outcome, message, attempts, elapsedMs}`) на строке кейса — без него resume не отличит инфраструктурное падение от продуктового (сегодня причина не пишется нигде).
- **Circuit breaker**: N подряд кейсов с исходом класса allocate (`renderer_unavailable`/`allocate_timeout`/`queue_full`) ⇒ терминализация рана со `statusReason` (`renderer_unavailable`|`capture_budget_exhausted`|`queue_starvation`) вместо N×3×60 s без evidence.
- Typed timeout: `CaptureInfraError` несёт `phase`; терминализация — `status:"error", statusReason:"phase_timeout", phase, elapsedMs, lastCompletedPhase, resumable:true, resumeFrom, jobIds`.
- Restart: sweep помечает `error` + `status_reason:"interrupted", resumable:true`; **дизайн resume обязан учитывать путь B**: залипшие `running`/`pending` кейсы считаются незавершёнными по определению (их никто не закрывал), `lastCompletedPhase` не доверяет строкам слепо; реконструкция набора даёт тот же `frame_fingerprint` (`orchestrator.test.ts:687`).
- Write-амплификация per-gate персиста: три дешёвых гейта — одной записью (group-commit), дорогие — по одному.
- Driver: verb `accept-resume <runId>`; `accept-status` показывает lineage/attempt.

Kill-switch `EASYUI_ACCEPTANCE_RESUME_DISABLED`. Capability matrix-зависимая (роуты acceptance живут под `EASYUI_ACCEPTANCE_MATRIX=1`).

AC (фидбэк §9): на фикстуре «run падает на allocate после audit» — resume не переисполняет contract/defaults/audit без fingerprint change; capture стартует либо typed timeout называет фазу/ресурс/queue state; после рестарта сервера `accept-status`+resume сохраняют lineage; второй concurrent run не создаётся.

Зона: `server/acceptance/{orchestrator,runner,repo}.ts`, `server/routes/acceptance.ts`, `server/migrations.ts` (v37), `server/screenshot/{worker-runner,sessions}.ts`, `server/acceptance/gates/capture.ts`, `.claude/skills/author/driver.mjs`.

## 7. EUI-BR-07 — element-level visual attribution + renderer policy (P0)

### Диагноз

Кластеры есть (`diffRegions`), но owner получают только пересёкшиеся с `effectSources` (`dominantElementKey`). **`rects[]` — маркерная гранулярность** (union поддерева на `data-eui-key`; для одиночного компонента карта вырождается в 1 прямоугольник — ревью B4), внутренние узлы ключей не имеют. `pass_with_exceptions` недостижим: `exceptions[]` никто не пишет, оба профиля `allowExceptions:false`, `PROMOTION_POLICY_PROFILES` не расширяем планом v1 (ревью M8). Кластеры усечены `MAX_REGIONS=12` (ревью M12). Координаты: кластеры — device px нормализованной канвы, `rects[]` — CSS px поверхности (ревью m20).

### Дизайн

**S1 — новое измерение per-node element map (не переиспользование `rects[]`).** В `geometry.mjs` — обход поддерева маркера: per-node bbox, путь (`nodePath`-формат), `hasText`, ближайший маркер-владелец; собственный лимит + `truncated`. Узлы без ключа адресуются `elementPath`. `hasText` и вся карта — **аддитивные report-only факты вне отпечатка** (дифференциальный тест «frame fingerprint не изменился» — ревью E3), артефакт `element-map.json` в evidence. `ownerComponentId` — через slotBindings (`server/acceptance/cases.ts:63-93`, уже в `GateContext`).

**`visualAttributionV2`:**

- Явный контракт преобразования координат: element map (CSS px поверхности) → канва диффа (device px): `×dsf`, `+placement`, `−cropRect`; фикстура с известным офсетом.
- **Формула ≥95 % — по пикселям, не по кластерам**: owner-totals считаются проходом по **полной** diff-маске (не по усечённому `regions[]`); исполнимо — воркер уже делает несколько O(total)-проходов; per-pixel owner-растр не строится (канва легально до 20 Мпикс) — только пиксели маски, владелец резолвится по depth-сортированному индексу прямоугольников. `totalRegions`/`truncated` — в receipt; пиксели вне всякого узла element map — в `unknown` total. Tie-break: глубочайший узел; out-of-flow/portal-узлы атрибутируются своему маркеру-владельцу. Транспорт element map в воркер — через опции `spawnNormalizedDiffWorker`/`NormalizedDiffJob` с лимитом узлов в контракте (в зоне владения).
- Форма кластера — контракт фидбэка §10 (bounds, mismatchedPixels, owner*, paintClass, sourceAssetId, raw/aaPct, bestOffset, structural, basis[], confidence). paintClass: live-text — edgeResidual внутри `hasText`-узлов; registry-image — пересечение с ресурсами barrier-receipt v4 (ownerElementKey per asset); geometry — из geometry facts.
- `structural=true` при geometry shift, missing asset, wrong fill/stroke/effect, mismatch вне заявленного owner; per-element totals + full-case totals; негативный тест «structural-кластер + AA-кластер в одном кейсе ⇒ fail» (§16 фидбэка).
- Receipt (перечень полей, не «расширение словами» — ревью E1): reference matte/flattening, color profile, renderer fingerprint, font fingerprints (`fontStackSha256`/`appFontsSha256` из `RendererDeclaration`), comparison policy hash — в `manifestOf` и case-receipt. Конверт драйвера (`receiptEnvelopeVersion:1`) не меняется — это версия агентской квитанции; серверные receipt-контракты версионируются своими capability.
- Расхождение фидбэка «§10-контракт допускает unknown total vs §10-AC требует ≥95 %» — принятое чтение: 95 % цель, `unknown` честно фиксируется; вопрос вынесен координатору письменно в release note (ревью B4 второго пакета).

**`rendererPolicyProfilesV2`:**

- Server-owned реестр: `{profileId, rendererFingerprint, scope:{paintClass, region?}, maxResidualPct, expiry: 5 fingerprints (renderer, fonts, matte, asset, geometry)}`; публикуется в `/capabilities` до рана; не создаётся из одного run; не применяет общий процент к кейсу; никогда не покрывает `unknown`/`structural` (негативные тесты на каждое).
- Применение — «вторая инстанция» в visual gate: первый продюсер `exceptions[]` → `pass_with_exceptions`; **новый именованный профиль политики с `allowExceptions:true` добавляется в `PROMOTION_POLICY_PROFILES`** + тест promote (ревью M8). Внимание: это расширяет множество промоутабельных ранов — операционное правило семей в §13.
- `suggestedPolicy` остаётся report-only.

Kill-switch'и: `EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED` (S1+атрибуция), отдельный `EASYUI_RENDERER_POLICY_PROFILES_DISABLED` (меняет promote-eligibility — своя ось).

AC (фидбэк §10): фикстура с текстовым и структурным кластерами — pixel-ownership ≥95 % либо честный unknown; renderer-only residual под опубликованным профилем → `pass_with_exceptions` с точным scope+expiry; structural → fail с owner; ни один residual не проходит из-за общего budget.

Зона: `src/capture/geometry.mjs` (S1), `scripts/visual-diff-worker.mjs`, `server/visual/causes.ts`, `server/acceptance/{runner,suggest,gates/visual,evidence,orchestrator,policies}.ts`.

## 8. EUI-BR-08 — subject/integration verdict (P1)

### Дизайн (`comparisonOwnershipV1`)

- `comparison` += `ownership?: "subject-and-integration"`, `subjectComponentId?`, `dependencyPolicy?: "require-eligible-acceptance"` (strict, optional, без default). Слой: `comparison` объявлен в `FIELD_LAYERS` целым объектом — тотальный `satisfies` вложенные ключи **не поймает** (ревью A4); обязателен тест «каждый ключ `comparison`-объекта имеет назначенный слой»; `ownership` — слой comparison.
- Ownership mask строится из S1/element map по slot tree (dependency-поддеревья); честная оговорка о гранулярности: маска точна на уровне маркеров/частей, доступных в element map. Visual gate считает два диффа: `subjectVerdict` (маска subject-owned) и `integrationVerdict` (полная канва); исключённые пиксели остаются в integration diff, группируются по dependency component/version/element key.
- Promotion eligibility: subject promote — только при `subjectVerdict=pass` + все runtime deps опубликованы с eligible acceptance evidence + contract/interaction/geometry/determinism полного дерева clean; failing `integrationVerdict` сохраняется в receipt. Врезка в promote перечитывает изменения BR-01 (пересечение по `promote.ts` — ревью A5).
- Mismatch parent background/mask/gap/clipping/interaction — subject failure.

Kill-switch `EASYUI_COMPARISON_OWNERSHIP_DISABLED`. AC — фидбэк §11 на фикстуре «обёртка + 2 dependency-ребёнка с намеренным residual».

Зона: `src/acceptance/caseSetSchema.ts`, `server/acceptance/{gates/visual,runner,ids}.ts`, `server/components/promote.ts`.

## 9. EUI-BR-09 — scroll/overflow ownership для FlowRoot (P1)

### Диагноз

Warning — `content-clipped-by-frame` (union всех маркеров против frame, без осей/владельцев); но агрегаты `frame/content` строятся в `collectGeometry`, а не в `analyzeGeometry` (ревью A1) — ограничение вклада поддерева scrollport'ом правится в том же `visit()`/сборке union, что и BR-05. `overlayScrollOwnership` на FlowRoot/probe не влияет.

### Дизайн (`flowOverflowOwnershipV1`)

- `elementSchema` += `overflowOwnership?: z.strictObject({axis:"x"|"y", mode:"scroll", viewportOwner?: string, expectedContentOverflow?: boolean})`. **Это персистируемая форма в строгом allowlist документа** (ревью M15): документ с полем не читается старым образом ⇒ write-функциональность включается только после закрытия rollback-window нового деплоя (§13, таблица форм); аналогичное объявление в composition layout-токенах (`src/prototype/compositionV3/layout.ts:44-65`).
- Сбор: `collectGeometry` получает декларации через probe bootstrap; вклад поддерева объявленного owner'а по объявленной оси ограничивается scrollport boundary; отдельно записываются `scrollportBounds`, `scrollContentBounds`, clip chain, owned overflow. Прокидка опций — через `scripts/screenshot-worker.mjs` и `server/screenshot/worker-mjs.d.ts` (в зоне).
- Незаявленный overflow, vertical spill, overlap regions, paint вне scroll clip — по-прежнему warning/failure (`unowned-overflow`, `owned-overflow-exceeds-axis`).

Kill-switch — группа `EASYUI_GEOMETRY_OWNERSHIP_DISABLED`. AC — фидбэк §12: «FlowRoot 390 px + два rail 552 px» — top-level warning исчезает, rails сохраняют content bounds, незаявленный overflow остаётся.

Зона: `src/prototype/schema.ts`, `src/capture/geometry.mjs` (после BR-05, последовательно), `server/screenshot/service.ts`, `scripts/screenshot-worker.mjs`, `server/screenshot/worker-mjs.d.ts`, `src/prototype/compositionV3/layout.ts`.

## 10. EUI-BR-10 — blocker fingerprint и retry disposition (P1, cross-cutting)

### Дизайн (`blockerFingerprintV1`) — два этапа (ревью A2)

**BR-10a (V1, ранний):** read-only `GET /api/acceptance-runs/:runId/retry-disposition` + `blockerFingerprint` **в терминальном ответе рана/receipt** (фидбэк: «run MUST возвращать», endpoint — рекомендуемый; ревью M9). Basis — существующие поля (renderer fingerprint, readinessPolicyHash, geometryContractVersion, policy hashes, candidate sourceHash, comparison/verdict fingerprints); per-case-условные версии (BR-05) агрегируются в run-level basis канонизированно — сортированный набор различных per-case значений, не скаляр (ревью minor раунда 2); маппинг дельт через `FIELD_LAYERS`: пусто→`unchanged/do-not-retry`, verdict→`recompute`, comparison→`rediff`, frame→`recapture`, candidate.sourceHash/schema→`rebuild`. Канонизация `blockerFingerprint` (ревью E5): сортированные терминальные gate-коды + канонизированный basis; `runId`/время в хеш не входят — неизменившийся blocker даёт стабильный отпечаток. GC-evicted кандидат: типизированный ответ с `suggestedAction:"do-not-retry"` и причиной неполноты basis.

**BR-10b (V5, после BR-02…07):** basis дополняется `schemaResolverVersion`, `resourceBarrierPolicyVersion`, `capturePolicyVersion`; `suggestedAction:"resume-run"` для resumable-ранов (интеграция с BR-06). AC «rollout меняет только соответствующие поля» проверяется дифференциально при включении каждого switch'а.

Kill-switch `EASYUI_BLOCKER_FINGERPRINT_DISABLED`; matrix-зависимая. Endpoint read-only, не создаёт run, не меняет state.

Зона: `server/routes/acceptance.ts`, `server/acceptance/{ids,repo,orchestrator}.ts` (терминальный ответ), `server/contracts.ts`.

## 11. Что не входит в план (фидбэк §14)

Не платформенные дефекты: отсутствующие Figma references source-blocked lanes; продуктовые решения (actions/navigation/routing/controlled input/animation); current-main Vitrina до сверки source branch; CPQR/Tooltip/Badge residual, если BR-07 докажет structural/source-owned; package sealing чужих lanes; sandbox/DNS локального агента. Проверяемое обязательство (ревью E4): для каждой категории §14 receipt называет owner и next-owner — негативные фикстуры «переадресация, не platform pass» входят в AC BR-07/BR-10.

## 12. Волны исполнения (Stage 3, после контрольного ревью)

Работа в ветке `wave/eui-br`. Отклонение от порядка фидбэка §15 (BR-07 не вторым) — инженерное: атрибуции нужны S1 и barrier v4-каналы; компенсация — BR-07 получает **собственное окно включения** сразу после capture-волны, и это согласуется с координатором явно (ревью E2).

| Волна | Задачи | Владение/порядок |
|---|---|---|
| V0 | Запрос corpus handoff; фикстуры + red-тесты всех BR; диагностики: H1–H4 (блокирующие для дизайна BR-01), клэмп BR-04 (в т.ч. гипотеза `padTo×maxDimensionDeltaPx`), **репродукция симптома BR-05** (union-расширение кодом не воспроизводится — найти реальный маршрут), причина терминализации всего рана BR-06 (m18), перф-замер барьера v4 (C5) | параллельно; `test/fixtures/**`, e2e |
| V1 | BR-01a ∥ BR-06 (v37) ∥ BR-10a | непересекающиеся зоны; `ids.ts` в V1 не трогается |
| V2 | BR-02 + BR-04 (одна зона capture canvas + visual) ∥ BR-03 | `ids.ts`/`caseSetSchema.ts` правит один агент волны |
| V3 | BR-05 → BR-09 **последовательно, одним агентом** (общие `geometry.mjs`, воркеры, d.mts) | зона включает `scripts/screenshot-*.mjs`, `server/screenshot/worker-mjs.d.ts` |
| V4 | S1 → BR-07 → BR-08; BR-01b параллельно visual-цепочке. `promote.ts` на волну владеет **BR-01b**; врезка BR-08 в promote — строго после merge BR-01b (последовательно, не параллельный общий файл) | последовательная цепочка в visual-зоне |
| V5 | BR-10b; release package — чеклист §16×10 capability (таблица «пункт × capability × артефакт × ответственный»); `docker-compose.yml`, `.env.example`, `contract.test.ts`, `openapi.json`, `docs/server-api.md` (changelog волны), `docs/prototype-format.md` (BR-09), `.claude/skills/deploy/SKILL.md` (смоук-ключи, rollback-windows, kill-switches, KPI); migration note для скилла пересборки на стороне мигратора (адресат уточняется у координатора — в нашем репо скилла `yp-figma-rebuild` нет, есть share/-tgz) | один агент |

Каждая волна: субагенты Opus с file ownership, «читай .d.ts, не угадывай», «не коммить»; оркестратор независимо гоняет done-критерии до коммита в ветку. Финал: `npm run verify` + `npm run e2e` + runtime-прогон `/verify`. KPI-проводка волны — baseline до, перемер после (ревью D3).

## 13. Деплой, миграции, окна отката

**Стратегия ветки (C1):** вся волна — в `wave/eui-br`; merge в `main` (=автодеплой) один, после закрытия rollback-window v32–v36 либо по явной команде. Перед merge — именованный бэкап по новому канону (`GET /api/admin/db-snapshot` + поассетный добор, без SSH): `.backups/prod-eui-br-<date>/` — он же вход прод-аудитов `--db` (F6).

**Deploy all-off + поштучное включение (C7):** staging нет, «canary» = порядок снятия kill-switch'ей на задеплоенном образе (redeploy без пересборки): capabilities-смоук → BR-10a → BR-01a → BR-06 → **окно 1**: capture-группа (BR-02/04) + BR-03 + bump `CASE_FINGERPRINT_ALGO_VERSION` 7→8 (re-diff/recompute-инвалидация reuse-кэша — канва BR-04, авто-правило BR-05, метрики BR-07 не переиспользуются молчаливо; ревью B2 раунда 2) → **окно 2**: geometry-группа (BR-05/09-read) → attribution (BR-07) → profiles → ownership (BR-08) → BR-01b/BR-10b. После каждого снятия — смоук `GET /api/capabilities` с сессией + прицельный смоук-ключ; точка отката — вернуть switch. Правило семей (ниже) распространяется и на re-diff-границу ALGO-bump'а, не только на renderer-ось.

**Kill-switch'и (7 вместо 11, C6):** `EASYUI_SCHEMA_RESOLVER_V2_DISABLED` (BR-01) · `EASYUI_CAPTURE_V4_DISABLED` (BR-02+04) · `EASYUI_RESOURCE_BARRIER_V4_DISABLED` (BR-03; подчинён существующему `EASYUI_RESOURCE_BARRIER_DISABLED`; **restart required**) · `EASYUI_GEOMETRY_OWNERSHIP_DISABLED` (BR-05+09) · `EASYUI_ACCEPTANCE_RESUME_DISABLED` (BR-06) · `EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED` (BR-07-S1/атрибуция) · `EASYUI_RENDERER_POLICY_PROFILES_DISABLED` (отдельно: меняет promote-eligibility) · `EASYUI_COMPARISON_OWNERSHIP_DISABLED` (BR-08) · `EASYUI_BLOCKER_FINGERPRINT_DISABLED` (BR-10). Матрица тестирования: «всё выключено» + «каждый включён по одному» — done-критерий V5. Matrix-зависимость (C8): BR-06/07/08/10 — под `EASYUI_ACCEPTANCE_MATRIX`; BR-01/02/03/04/05/09 — безусловные; каждая фича объявляет это в `capabilitiesResponseSchema` (урок W11).

**Rollback-window новых персистируемых форм (C2)** — таблица канона (обновляется в `.claude/skills/deploy/SKILL.md` и `docs/server-api.md#deployment`):

| Форма | Появляется | Запрет в окне отката нового деплоя |
|---|---|---|
| case-set с `surface.paintPaddingPx`/`preloadAssets` | BR-02/03 | не публиковать наборы с полями, пока окно открыто (старый образ даёт 422 на перепубликацию) |
| case-set с `comparison.ownership` | BR-08 | то же |
| документ с `element.overflowOwnership` | BR-09 | write-включение только после закрытия окна (старый сервер не распарсит ревизию — прецедент `region`) |
| definition meta с `geometryOwnership` | BR-05(мех.3) | не публиковать компоненты с метой в окне |
| v37-колонки acceptance (resume lineage) | BR-06 | не запускать resume в окне (аддитивные колонки; откат образа читает строки, но lineage теряется) |

**Corpus-гейт CI — двухпушевая процедура вооружения (C3):** push 1 (изменение, двигающее rendererFingerprint) идёт в bootstrap-режиме — гейт ничего не сравнивает; артефакт bootstrap ревьюится (diff pixel-sha старого и нового отпечатков), adopt отдельным коммитом, push 2 — с вооружённым гейтом. Деплой запрещён, пока в job summary висит `::warning:: bootstrap`.

**Правило семей (C4):** BR-03 двигает `rendererFingerprint` (через readinessPolicyHash) и хэши профилей; BR-07 добавляет профиль с `allowExceptions:true`. Действует канон волны 2026-08-07: **семья промоутится целиком из доволновых артефактов либо целиком пересобирается** (`acceptance_renderer_mismatch` на смешанных наборах); пред-деплойный аудит смешанных семей на восстановленной копии тома — обязательный шаг go/no-go.

**Go/no-go пересъёмки (C5):** до снятия capture/barrier-свитчей — оценка стоимости через `snap-plan`/`impacted` на прод-копии + V0-перф-замер барьера (порог ≤2 с/кейс); владелец шага — оркестратор, результат фиксируется в NOTES бэкапа.

## 14. Риски

1. **BR-01 задевает save-путь всех документов** — kill-switch на весь резолвер, дифференциальный тест на корпусе фикстур как CI-артефакт, ранний отдельный этап 01a.
2. **BR-06 write-амплификация** per-gate персиста — замер до принятия; fallback: чекпоинт после дорогих гейтов (capture+) вместо всех.
3. **BR-07 ≥95 %** может не достигаться на шумных фикстурах — честный `unknown` total, вопрос трактовки AC вынесен координатору.
4. **Барьер v4 дороже бюджета** — go/no-go с числами; смягчение: лимиты/бюджеты в `limits`, обход pseudo с ранним выходом.
5. **Расхождение порядков** (наш V-порядок vs §15 фидбэка) — письменное согласование с координатором в release note; BR-01a доставляет milestone №1 рано.
6. **Handoff может не прийти** — план исполним на синтетике, но §16 закрывается частично; это зафиксировано в §0 и release note.

## 15. Триаж Stage 2 (раунд 1: два ревью — корректность; скоуп/риски)

**Принято (вошло в v2):** корректность B1 (decoration без source mutation — авто-правило + per-case metadata, `data-eui-part` понижен до усиления), B2 (per-side канва сравнения + слой frame+comparison), B3 (условный вклад версий, additive facts вне отпечатка — прецедент W1a), B4 (S1 — новое per-node измерение), B5 (resume новым раном), M6–M16 и m17–m24 целиком (сужение indeterminate-флипа, theme-хэш во frame-слое, PROMOTION_POLICY_PROFILES, blockerFingerprint на ране, `component_pin_conflict`, H3-гейт, owner-totals по полной маске, Мпикс-бюджет, шимы React call-time, отсрочка write BR-09, деривация propsSchemaHash, слои `surface.*`/`comparison.*`, m18-диагностика, m19-гипотеза, координатный контракт, tie-break, re-diff-формулировка, источник expected, владение ids.ts); скоуп A1–A5 (V3 последовательно + зоны воркеров, BR-10a/10b, BR-05→S1→BR-07, слои, promote-пересечение), B1–B5 (01a/01b, phase↔gate под-этап, resume-новый-ран, формула 95 %, развилка BR-04), C1–C8 (ветка, таблица rollback-форм, двухпушевый гейт, правило семей, go/no-go, группировка свитчей до 7+2, включение по одному вместо canary, matrix-декларации), D1–D3 (corpus handoff, чеклист §16, диф-тест как артефакт + KPI), E1–E5, F1–F6.

**Принято частично:** E1 — серверные receipt-контракты перечислены пополь­но, но `receiptEnvelopeVersion` не двигаем: конверт драйвера — отдельный контракт, его форма не меняется (при изменении — своя версия). B3 (корректность) — глобальные bump'ы не отменены, а сделаны switch-управляемыми и условными по кейсам; честный `recapture` в disposition после осознанного включения соответствует второму AC §13 фидбэка.

**Отклонено:** m25 (перепривязка якорей к HEAD) — HEAD и есть план; код в зонах не двигался, якоря остаются по `3ccc74e`.

**Раунд 2 (контрольное ревью v2): 3 blocker + 4 major + minors — все приняты, вошли в v3:**

- **B1** (условный `geometryContractVersion:3` невычислим до съёмки — отпечатки считаются из декларативных входов в точке постановки/reuse): принято — условность только по манифестному `geometryOwnership`; авто-правило переквалифицировано в verdict-слойное изменение под ALGO-bump; правило «доволновой кадр без `preTransformBounds` ⇒ recapture» добавлено (§5).
- **B2** (нет механизма инвалидации семантики кода — плановый silent reuse: канва из констант, `comparisonFingerprint` не сдвигается): принято — bump `CASE_FINGERPRINT_ALGO_VERSION` 7→8 включён в §0/§13 как шаг окна 1.
- **B3** (per-side padding двигал канву сравнения — против §5 фидбэка): принято — capture-padding и comparison margin разведены, кандидат кропается до канвы сравнения, AC «метрики байт-в-байт прежние» (§2).
- **M1** (set-level vs per-case): принято — поле перенесено в `caseSetCaseSchema`, отступление от JSON-формы фидбэка согласуется с координатором (§2).
- **M2** (`surface.*` хэшируется целиком — report-only там недостижим): принято — `preloadAssets` и `paintPaddingPx` живут как per-case поля с явными входами отпечатка (§2, §3).
- **M3** (idempotency resume не определён): принято — формула `resume:<sourceRunId>:<attempt>`, поведение повторного resume, прежняя ошибка в lineage (§6).
- **M4** (окон пересъёмки два, а не одно): принято — §0/§13 переписаны: окно 1 (capture/barrier + ALGO), окно 2 (geometry); правило семей распространено на re-diff-границу.
- Minors: инвариант-тест `readinessMet=false` (§3 AC); owner-резолв по depth-индексу без per-pixel растра + транспорт element map в воркер (§7); агрегация per-case версий в run-level basis (§10); владелец `promote.ts` в V4 — BR-01b (§12); якорь `draftComponentAllowedUrls` исправлен (§3); V0-репродукция симптома BR-05 добавлена (§5, §12) — симптом «tail расширяет union» текущим кодом не воспроизводится, диагностика обязательна.

Ревью подтвердило: слой-паттерн, обратная совместимость `GeometryFacts`, resume-новым-раном против §9, тезис о вложенных `comparison.*`-ключах, диагноз `visit()`/`effectReachPx`, исполнимость 95 %-формулы по полной маске. Блокирующих возражений после v3-правок не остаётся; остаточные вопросы координатору (форма `paintPaddingPx`, трактовка 95 %-AC, адресат migration note) собраны в release note.
