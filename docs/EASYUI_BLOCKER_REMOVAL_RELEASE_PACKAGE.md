# easy-ui release package: EUI-BR-01…10

Ответ на `docs/EASYUI_BLOCKER_REMOVAL_REQUIREMENTS_20260809.md` (далее — «фидбэк»). Реализация — план `docs/plans/2026-08-08-blocker-removal-eui-br.md`, ветка `wave/eui-br`, волны V0–V5.

**Статус: код готов, в прод не выкачен.** Ветка не влита в `main`; merge (=автодеплой) — после закрытия rollback-window предыдущей волны (миграции v32–v36) либо по явной команде. Волна выкатывается **all-off**: все девять kill-switch'ей включены на деплое, снимаются по одному в порядке из `.claude/skills/deploy/SKILL.md` (секция «Wave EUI-BR»).

Документ построен по §16 фидбэка: для каждого требования — таблица «пункт чеклиста → артефакт у нас». Ниже таблиц — три секции, которые фидбэк не заказывал, но без которых пакет был бы неполным: ограничение по фикстурам (§11), вопросы координатору (§12) и карта «blocker code → что его снимает» (§13).

---

## 0. Как читать capability

Все флаги живут в `GET /api/capabilities` (за сессией; неавторизованный `curl` вернёт 401, в теле которого флагов просто нет — это выглядит как «фичи не поставили»). Три разных вида полей:

- **`features.<name>: boolean`** — «включено ли **сейчас** на этом инстансе», а не «умеет ли образ». Гаснет своим kill-switch'ем.
- **`features.<name>Version: number`** — «по каким правилам этот инстанс работает прямо сейчас»: `prototypeSchemaResolverVersion`, `resourceBarrierPolicyVersion`, `comparisonPolicyVersion`, `geometryOwnershipPolicyVersion`. Пара «флаг + версия» существует именно потому, что «включено» и «чем именно снято/сведено» — разные вопросы.
- **`limits.<name>`** — потолки, которые клиент обязан проверить **до** запроса.

JSON Schema всех новых форм: `server/contracts.ts` (единственный источник) → сгенерированный `server/openapi.json` → `GET /api/openapi.json` и `GET /api/schemas/*` на живом сервере. Drift между ними не допускается: `server/contract.test.ts` падает, если `openapi.json` не перегенерирован.

Матричная зависимость: BR-06/07/08/10 живут внутри `EASYUI_ACCEPTANCE_MATRIX=1` (без матрицы acceptance-ручек нет вовсе); BR-01/02/03/04/05/09 — безусловные.

---

## 1. EUI-BR-01 — единый resolver схемы published component

| Пункт §16 | Артефакт |
|---|---|
| capability name/version, limits | `features.prototypeSchemaResolverV2: boolean`, `features.prototypeSchemaResolverVersion: 2` (под kill-switch'ем — `1`). Новых `limits` нет |
| JSON Schema контрактов | `server/contracts.ts`: `resolvedComponentsSchema` (блок `components[]` ответа save: `{id, name, resolvedVersion, sourceHash, propsSchemaHash, origin}`), `resolvedSchemaFieldsShape` (те же три поля в `renderStatusResponseSchema.resolvedPins[]` и в `componentPins[]` снапа/geometry-probe). Публичная форма — `server/openapi.json` |
| unit/integration fixtures | `server/components/resolvedGraph.test.ts` (дифференциальный тест «старый vs новый резолвер» на корпусе фикстур с явно перечисленными расхождениями), `server/schema-resolver-diagnosis.test.ts`, `server/prototype-head-tracking.test.ts`, `src/prototype/__tests__/validate.test.ts` |
| before/after receipts | V0 red→green: `server/schema-resolver-diagnosis.test.ts` — репродукция симптома (H1: пин композиции течёт по имени → `422 Unrecognized key` на авторском элементе; H2: readiness не видит компоненты внутри раскрытия; H4: перенос в другую ДС разводит save и headPin), затем те же тесты на зелёном пути |
| fingerprint/invalidation | слоя нет **by design**: путь save/readiness прототипа не входит ни в один приёмочный отпечаток. Наблюдаемость включения — `basis.schemaResolverVersion` ответа `retry-disposition` (`server/acceptance/retry-disposition.test.ts`, «BR-10b/BR-01: резолвер меняет basis, но не даёт ни одного слоя») |
| legacy/kill-switch | `EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1`. Парные тесты в `server/schema-resolver-diagnosis.test.ts` («пин снова течёт по имени», «доволновой issue без кода и контекста», «readiness снова резолвит нераскрытый документ», «headPin снова перескакивает в чужую ДС») и `server/components/resolvedGraph.test.ts` («поля резолвера исчезают из save-ответа и render-status») |
| structural без auto-waiver | неприменимо (требование не про вердикты) |
| migration note | новый `422 component_pin_conflict`: документ, где раскрытие композиции пинует `@M`, а авторский элемент того же типа требует `@N`, больше не выбирает схему молча — отказ называет обе версии и оба пути. Типизированный issue `component_prop_unknown` несёт фактически применённую схему (`propsSchemaHash`, `acceptedKeys`, `catalogRevision`) |

**AC фидбэка §4 закрыты так:** save копии документа с `@2 {mode:"current-main"}` проходит; `status`/save receipt/snap называют **один** резолв одинаковыми полями (единственный источник — `ResolvedComponentGraph`); заведомо неизвестный prop отклоняется с фактической схемой; `track:head` не откатывается на предыдущую active.

**Ловушка выкладки:** 01a и 01b гасятся **одним** тумблером — «включить только минимальный фикс» средствами env невозможно.

---

## 2. EUI-BR-02 — unclipped paint capture с per-side padding

| Пункт §16 | Артефакт |
|---|---|
| capability name/version, limits | `features.paintCapturePaddingV1: boolean`; `limits.captureMaxPaintPaddingPx`, `limits.captureFrameBudgetMpx: 20` |
| JSON Schema контрактов | `src/acceptance/caseSetSchema.ts`: `cases[].paintPaddingPx: {top,right,bottom,left}` (strictObject, все четыре стороны обязательны, `.optional()` **без** `.default()` — набор контентно адресуем). Схема набора публикуется через `GET /api/schemas/*` и `server/openapi.json` |
| unit/integration fixtures | `server/acceptance/caseSets.test.ts` (поле доезжает до случая, неполный объект и превышение потолка отвергаются, `capture_budget_exceeded`), `server/acceptance/gates/visual.test.ts` (метрики байт-в-байт прежние), `server/acceptance/gates/geometry2.test.ts`, `src/capture/failureCodes.test.ts` |
| before/after receipts | V0: `server/acceptance/gates/hug-canvas-diagnosis.test.ts` — доволновая канва и её поведение зафиксированы до правок; те же кейсы после правок судятся по объявленной канве |
| fingerprint/invalidation | `server/acceptance/ids.test.ts`: «BR-02: `paintPaddingPx` — чистый кадровый слой, и его отсутствие байт-в-байт прежнее». Ключевой инвариант: **канва сравнения от поля не зависит** — кандидатский растр приводится к ней окном, поэтому соседние случаи набора не пересобираются |
| legacy/kill-switch | `EASYUI_CAPTURE_V4_DISABLED=1` → `422 capture_padding_disabled` на `case-sets put`; парный тест «поле по сторонам не приводится к канве, и кадр не сводится» |
| structural без auto-waiver | недостаточное поле — типизированный `paint_capture_clipped` с требуемым минимумом по стороне, а не тихий кроп |
| migration note | объявляйте `paintPaddingPx` **пер-кейсово**, а не на набор (отступление от JSON-формы §5 фидбэка — см. §12.1). `rootBounds`/`layoutUnion`/`referenceExportDims`/размер raw reference семантику не меняют |

---

## 3. EUI-BR-03 — полный registry-resource barrier

| Пункт §16 | Артефакт |
|---|---|
| capability name/version, limits | `features.resourceBarrierV4: boolean` + `features.resourceBarrierPolicyVersion: 4` (`3` под v4-свитчём, доволновое значение профиля при выключенном барьере целиком); `acceptance.readinessPolicyVersion: 4` — то же число про профиль приёмки; `limits.caseSetMaxPreloadAssets`, `limits.resourceBarrierMaxResources`, `limits.resourceBarrierBudgetMs` |
| JSON Schema контрактов | `src/capture/readiness.ts` → `ReadinessResourceRecord` (контракт §6 фидбэка: `assetId`, `ownerElementKey`, `ownerComponentId`, `channel`, `discoveredAt`, `requested/loaded/decoded/completedBeforeStableFrame`); `cases[].preloadAssets: string[]` в `src/acceptance/caseSetSchema.ts`; форма receipt'а — в `server/contracts.ts` |
| unit/integration fixtures | `src/capture/readiness.test.ts` (`describe("resource barrier v4 (BR-03)")`: фаза registry, честный ноль без темы, `resource_barrier_timeout` с `ref:"registry:…"`, каналы srcset/font report-only, документный предикат псевдоэлементов, пер-ресурсные имена, перф-бюджет), `server/acceptance/gates/readiness.test.ts` (флип вердикта), `server/capture/modes.test.ts` (иерархия свитчей), `server/shims/abi-v3.test.ts` (call-time чтение хоста в шимах abi-v2/3/4) |
| before/after receipts | до волны недогруженный registry-`<img>` давал `resource_late_after_barrier` → `met:false` → **fail** гейта; после — тот же кейс либо доезжает (фаза registry ждёт применения темы), либо получает `indeterminate` с `resource_barrier_incomplete` и пер-ресурсной записью, называющей `assetId`/владельца/канал/фазу |
| fingerprint/invalidation | `server/acceptance/ids.test.ts`: «BR-03: `themeContentHash` — кадровый слой, и его отсутствие байт-в-байт прежнее». Сама политика барьера входит в `readinessPolicyHash` → `policyProfileHash` → `rendererFingerprint`: включение = **полная пересъёмка** корпуса приёмки |
| legacy/kill-switch | иерархия из двух: `EASYUI_RESOURCE_BARRIER_DISABLED=1` (барьера нет, каждый профиль в свою доволновую политику) старше `EASYUI_RESOURCE_BARRIER_V4_DISABLED=1` (барьер по политике v3 **byte-for-byte**). Оба — **restart required**. Тесты: «политика v3 остаётся байт-в-байт доволновой», «иерархия свитчей: v4-свитч возвращает v3 байт-в-байт, старший приоритетнее» |
| structural без auto-waiver | флип `fail → indeterminate` сужен **только** до барьерных причин (`resource_late_after_barrier`, `resource_decode_failed`, `expected≠decoded`); шрифты, overflow и таймаут readiness остаются `fail`. Инвариант-тест: барьерный код ⇒ `readinessMet: false` **и** сравнивающие гейты пропущены — capture не становится visual evidence |
| migration note | `cases[].preloadAssets` — **hint**, а не декларация: он не освобождает сервер от обнаружения и не входит ни в один отпечаток (слой `report-only`). Смена содержимого темы теперь честно инвалидирует кадр (`themeContentHash`) |

---

## 4. EUI-BR-04 — exact small content-hug canvas

| Пункт §16 | Артефакт |
|---|---|
| capability name/version | `features.exactContentHugCanvasV1: boolean` + `features.comparisonPolicyVersion: 2` (доволново — `1`) |
| JSON Schema контрактов | форма receipt'а сравнения (`rootBounds`, `comparisonCanvasCssPx`, `deviceScaleFactor`, `comparisonCanvasDevicePx`) — `server/contracts.ts`; новых полей запроса требование не вводит |
| unit/integration fixtures | `server/acceptance/gates/hug-canvas-diagnosis.test.ts` (14 тестов: точная канва delta 0, запрет неявного zero-pad, `rawDiffPctOfSurface`, `reference_scale_mismatch`, ветки surfaces-v3) |
| before/after receipts | **V0 разрешил развилку и опроверг формулировку блокера**: клэмпа «минимум 24 px» в коде нет ни на одном шаге (проверена сетка вплоть до 1×1). «24» = верхняя граница окна сводимости `16 + maxDimensionDeltaPx(8)` с **молчаливым zero-pad** меньшей картинки. Попутно найдены два дефекта хуже заявленного и починены: (а) `rawDiffPct` мерился по всей канве с margin — полностью перекрашенный 16 px компонент давал 1.23 % < бюджета 2 %, то есть **fail был физически недостижим**; (б) эталон не проверялся на масштаб — 1×-экспорт при dsf 2 проходил даже `pixel-strict-v1` |
| fingerprint/invalidation | `server/acceptance/ids.test.ts`: «BR-04: `comparisonPolicyVersion` — условный вход слоя сравнения, ALGO не двигается». Включение стоит **re-diff'а**, не пересъёмки |
| legacy/kill-switch | общий `EASYUI_CAPTURE_V4_DISABLED=1`; три парных теста: «тот же 1×-эталон снова проходит pixel-strict с 0.469 % по канве», «тот же полностью неверный 16 px кадр снова проходит default-v1», «та же дельта 1 px снова сводится допуском 4 px профиля» |
| structural без auto-waiver | `reference_scale_mismatch` — **чистая диагностика**: `indeterminate`, вердикт не смягчает и не ужесточает |
| migration note | мелкие hug-кейсы больше не требуют пер-кейсовых допусков; если ваш кейс проходил только за счёт `maxDimensionDeltaPx`, после включения он честно упадёт — это и есть снятие блокера, а не регрессия |

---

## 5. EUI-BR-05 — decoration-aware geometry

| Пункт §16 | Артефакт |
|---|---|
| capability name/version, limits | `features.geometryDecorationOwnershipV1: boolean` + `features.geometryOwnershipPolicyVersion: 1` (доволново — `null`); `limits.caseSetMaxGeometryOwnership: 16` |
| JSON Schema контрактов | `src/acceptance/caseSetSchema.ts`: `cases[].geometryOwnership` — карта `"<elementKey>"`/`"<elementKey>//<elementPath>"` → `{role:"decoration", participatesIn:["paint"]}` (`caseSetGeometryOwnershipSchema`, `GEOMETRY_OWNERSHIP_KEY_PATTERN`) |
| unit/integration fixtures | `src/capture/decoration-symptom-diagnosis.test.ts`, `server/acceptance/gates/geometry2.test.ts`, `server/acceptance/caseSets.test.ts`, `src/capture/geometry.test.ts` |
| before/after receipts | **V0 опроверг буквальный симптом** «tail расширяет layoutUnion» (transform-узлы уже исключались из union) и нашёл **четыре реальных маршрута** блокера, каждый со своим red-тестом: (1) probe-уровень `rects[]` без фильтра потока даёт автору неверные числа для `expectedGeometry`; (2) честный `expectedGeometry` → `paint-overflow-not-clipped` fail; (3) `expectedSurfaces` по макету → `surface-mismatch`; (4) **tail-сиблинг ломает `rootBoxOf`** → `root: not-measured` → вечный `indeterminate` — ближайшее к «24/36 roots» фидбэка. Авто-правило снимает маршруты 1, 2, 4; per-case декларация — маршрут 3 |
| fingerprint/invalidation | `server/acceptance/ids.test.ts`: «BR-05: `geometryOwnership` — слой frame+verdict, и его отсутствие байт-в-байт прежнее» и «`geometryOwnershipPolicyVersion` — вердиктный вход авто-правила, ALGO не двигается». Факты замера (`preTransformBounds`, матрица, post-transform краска) — **вне отпечатка**, доказано дифференциальным тестом «замер расширился, а `layoutBounds`/`effectSources` байт-в-байт легаси» |
| legacy/kill-switch | `EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1` → `422 geometry_ownership_disabled`; `describe("BR-05 · LEGACY (kill-switch)")` (6 тестов) + «kill-switch возвращает доволновой вердикт байт-в-байт» |
| structural без auto-waiver | метка/автоклассификация in-flow контейнера с layout-детьми отвергается кодом `geometry_ownership_invalid`; краска декорации становится **неблокирующим** `paint-overflow-decoration`, но visual residual остаётся fail |
| migration note | доволновой кадр не несёт `preTransformBounds`; при затребованной decoration-семантике сервер **отказывает в recompute** и честно просит пересъёмку этого кейса (прецедент `expectedSurfaces`). Probe/драйвер теперь различают layout- и paint-габарит (`bounds: layout=… paint=…`) — писать в `expectedGeometry` следует **layout** |

---

## 6. EUI-BR-06 — resumable acceptance после timeout

| Пункт §16 | Артефакт |
|---|---|
| capability name/version | `features.acceptanceResumeV1: boolean` (matrix-зависимая) |
| JSON Schema контрактов | `server/contracts.ts`: `resumeAcceptanceRunContract` (`POST /api/acceptance-runs/:runId/resume`), `acceptanceResumeSchema` (`resumable`, `phase`, `lastCompletedPhase`, `elapsedMs`, `resumeFrom`, `jobIds[]`, `resumedFrom{…}`), поля вида рана `resumedFromRunId`/`attempt`/`resume`, per-case `error {outcome, message, attempts, elapsedMs, phase}` |
| unit/integration fixtures | `server/acceptance/resume.test.ts` (11 тестов), `server/acceptance-routes.test.ts` (типизированные 409), `server/acceptance/repo.test.ts`, `server/migrations.test.ts` (v37 + откат) |
| before/after receipts | **V0 разрешил m18**: пути «первый кейс упал → весь ран error» в коде нет; 180.5 s — стоимость одного кейса, а наблюдение мигратора — **рестарт процесса**: `sweepNonTerminalRuns` сносил ран в `error`, кейсы залипали `running`/`pending` навсегда, манифест не писался. Дополнительно найдено и починено: причина падения кейса не персистилась **нигде**; у пула не было таймаута аллокации; `501 screenshot_unavailable` ретраился как продуктовый отказ; `queue_full` съедал все попытки без различимого `statusReason` |
| fingerprint/invalidation | продолжение — **новый ран**, а не воскрешение: терминальный ран неизменяем (на него ссылаются receipts публикаций и promote-инварианты). Завершённые гейты переиспользуются **только** при совпавших per-gate fingerprints (`gates_json`); реконструкция набора даёт тот же `frame_fingerprint` |
| legacy/kill-switch | `EASYUI_ACCEPTANCE_RESUME_DISABLED=1` → `409 acceptance_resume_disabled`; тесты «kill-switch читается по месту вызова» и «resume: kill-switch, неподходящее состояние и повторное продолжение — типизированные 409» |
| structural без auto-waiver | ран, давший вердикт, продолжить нельзя (`409 run_not_resumable` — это `accept --refresh`, а не resume); уже продолженный — `409 run_already_resumed` с указанием наследника; идемпотентность продолжения детерминирована ключом `resume:<runId>:<attempt>` |
| migration note | миграция **v37** (аддитивные колонки + частичный индекс). Драйвер: `driver.mjs accept-resume <runId>`; `accept-status` печатает lineage (`attempt`, `resumedFromRunId`, прежняя причина остановки). Новые терминальные `statusReason`: `interrupted`, `phase_timeout`, `renderer_unavailable`, `capture_budget_exhausted`, `queue_starvation` |

---

## 7. EUI-BR-07 — element-level visual attribution и renderer policy

| Пункт §16 | Артефакт |
|---|---|
| capability name/version | `features.visualAttributionV2: boolean` (карта элементов + атрибуция) и **отдельно** `features.rendererPolicyProfilesV2: boolean` + реестр `acceptance.rendererPolicyProfiles[]` (`profileId`, `rendererFingerprint`, `scope`, `maxResidualPct`, `expiry`); профиль политики `default-v1-exceptions` в `acceptance.promotionPolicyProfiles` |
| JSON Schema контрактов | контракт кластера §10 и `comparisonReceipt` — `server/contracts.ts` (`ownerElementKey`, `ownerComponentId`, `paintClass`, `structural`, `basis[]`, `confidence`, `mismatchedPixels`, `bestOffset`); реестр профилей — в `capabilitiesResponseSchema`; артефакт `element-map.json` в evidence-манифесте |
| unit/integration fixtures | `server/visual/attribution.test.ts` (16), `server/acceptance/gates/visual-attribution.test.ts` (9), `server/acceptance/rendererProfiles.test.ts` (9), `server/visual/causes.test.ts`, `src/capture/geometry.test.ts` (`describe("element map (BR-07 S1)")`) |
| before/after receipts | до волны owner получали только кластеры, пересёкшиеся с `effectSources`, `rects[]` были **маркерной** гранулярности (для одиночного компонента карта вырождалась в один прямоугольник), а `pass_with_exceptions` был недостижим: `exceptions[]` никто не писал и оба профиля стояли с `allowExceptions:false`. После — per-node карта, owner-тоталы по полной маске и первый продюсер исключений |
| fingerprint/invalidation | карта элементов и `hasText` — **аддитивные report-only факты вне отпечатка** (дифференциальный тест «задание без карты элементов оставляет метрики воркера доволновыми byte-for-byte»). Профили публикуются **до** рана и протухают по пяти отпечаткам (renderer, fonts, matte, asset, geometry) |
| legacy/kill-switch | `EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED=1` («карта не уезжает в воркер, метрики и evidence доволновые byte-for-byte», «под kill-switch'ем артефакта карты нет вовсе») и `EASYUI_RENDERER_POLICY_PROFILES_DISABLED=1` («kill-switch гасит и реестр, и применение») |
| **structural без auto-waiver** | **подтверждаем негативными тестами:** «структурный кластер не смягчается профилем — даже рядом с AA-кластером»; «неатрибутированные пиксели профилем не покрываются: у unknown нет класса краски»; «structural-кластер рядом с AA-кластером в одном случае ⇒ fail (§16 фидбэка)»; «scope и потолок остатка проверяются отдельно от истечения»; «истечение по каждому из пяти отпечатков — своя типизированная причина»; «advisory-визуал профиль не рассматривает». Реализация: `clusterIsStructural()` (`server/visual/attribution.ts`) — `geometry`, `registry-image`, `fill`, `stroke`, `effect` и `unknown` **все** структурны |
| migration note | профиль **никогда** не применяет общий процент к кейсу и не создаётся из одного рана; `suggestedPolicy` остаётся report-only. Включение профилей — единственная ось волны, **расширяющая множество промоутабельных ранов**, поэтому у неё своё окно выкладки |

---

## 8. EUI-BR-08 — component-owned comparison в contextual tree

| Пункт §16 | Артефакт |
|---|---|
| capability name/version | `features.comparisonOwnershipV1: boolean` (matrix-зависимая) |
| JSON Schema контрактов | `src/acceptance/caseSetSchema.ts`: `comparison.ownership: "subject-and-integration"`, `comparison.subjectComponentId`, `comparison.dependencyPolicy: "require-eligible-acceptance"` (strict, optional, без `.default()`); квитанция `subjectPromotion[]` в ответе promote и в receipt саги — `server/contracts.ts` |
| unit/integration fixtures | `server/component-promote-subject.test.ts` (6), `server/acceptance/gates/visual-attribution.test.ts` (обёртка + два dependency-ребёнка с намеренным residual, mismatch родительского фона), `server/acceptance/caseSets.test.ts`, `server/acceptance/rendererProfiles.test.ts` (`subjectPromotionEligible`) |
| before/after receipts | до волны компонент, чей собственный растр чист, но чьё окружение в дереве даёт residual, был непромоутабелен вовсе; после — два вердикта одного сравнения, и **интеграционный провал признаётся явно** в квитанции, а не прячется |
| fingerprint/invalidation | `server/acceptance/ids.test.ts`: «BR-08: `ownership`/`subjectComponentId`/`dependencyPolicy` двигают ровно слой сравнения» + **тотальность вложенных ключей**: «каждый ключ объекта `comparison` объявлен в слое — тотальность, которую `satisfies` не ловит» |
| legacy/kill-switch | `EASYUI_COMPARISON_OWNERSHIP_DISABLED=1`: «второго вердикта нет, поле остаётся декларацией без эффекта»; «kill-switch и набор без деклараций: отказ доволновой — `acceptance_run_not_passed`» |
| structural без auto-waiver | вердикт случая остаётся **интеграционным**; subject-promote требует одновременно: чистый `subjectVerdict`, объявленное ownership, eligible-acceptance у **всех** slot-зависимостей и чистые contract/interaction/geometry/determinism полного дерева. Отказы типизированы: `subject_promotion_ownership_missing` / `subject_promotion_subject_failed` / `subject_promotion_dependency_ineligible` (с виновниками и под-причинами `not_published`, `pin_not_renderable`, `no_active_publication`, `no_acceptance_evidence`, `acceptance_not_promotable`). Mismatch родительского фона/маски/gap/клиппинга — **subject failure** |
| migration note | **пустой список зависимостей — отказ, а не проход** (см. §12.4): «нет зависимостей» не доказывает, что unknown-пиксели кому-то принадлежат |

---

## 9. EUI-BR-09 — scroll/overflow ownership для FlowRoot

| Пункт §16 | Артефакт |
|---|---|
| capability name/version | `features.flowOverflowOwnershipV1: boolean` (общий тумблер с BR-05) |
| JSON Schema контрактов | `src/prototype/schema.ts`: `overflowOwnershipSchema` = `{axis:"x"\|"y", mode:"scroll", viewportOwner?, expectedContentOverflow?}` на `elements[]`; тот же токен в composition layout (`src/prototype/compositionV3/layout.ts`). Публичная схема документа — `GET /api/schemas/prototype-document` |
| unit/integration fixtures | `src/prototype/overflowOwnership.test.ts`, `server/prototype-overflow-ownership.test.ts`, `server/screenshot/overflow-ownership.test.ts`, `src/capture/geometry.test.ts` (`describe("BR-09 · overflow ownership")`, включая `unowned-overflow`, `owned-overflow-exceeds-axis`, `viewportOwner`) |
| before/after receipts | до волны `content-clipped-by-frame` поднимался на union всех маркеров против frame — без осей и владельцев, поэтому «FlowRoot 390 px + два rail 552 px» давал top-level warning, который нечем было объяснить. После — вклад поддерева владельца по объявленной оси ограничен границей scrollport'а, rails сохраняют собственные content bounds |
| fingerprint/invalidation | **frame** у документов, объявивших владение (это персистируемая форма строгого allowlist'а документа) |
| legacy/kill-switch | `EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1` → `422 flow_overflow_ownership_disabled` **на записи**; тест «под kill-switch'ем документ с `overflowOwnership` отвергается 422, соседний — нет». **Чтение stored-документов не гейтится никогда** (канон `doc.surfaces`) |
| structural без auto-waiver | незаявленный overflow, vertical spill, overlap-регионы и краска вне scroll-clip остаются warning/failure (`unowned-overflow`, `owned-overflow-exceeds-axis`) |
| migration note | это **персистируемая форма документа**: писать её можно только после закрытия rollback-window нового деплоя — старый образ не распарсит ревизию вовсе (прецедент `region`) |

---

## 10. EUI-BR-10 — blocker fingerprint и retry disposition

| Пункт §16 | Артефакт |
|---|---|
| capability name/version | `features.blockerFingerprintV1: boolean` (matrix-зависимая) — гасит **обе** поверхности сразу: поле `blockerFingerprint` в виде рана и саму ручку |
| JSON Schema контрактов | `server/contracts.ts`: `acceptanceRetryDispositionContract` (`GET /api/acceptance-runs/:runId/retry-disposition`) + `retryDispositionBasisSchema`. Enum'ы: `disposition: unchanged\|recompute\|rediff\|recapture\|rebuild`, `suggestedAction: do-not-retry\|resume-run\|new-run\|update-source`, `cases[].layers: frame\|comparison\|verdict`, `basisIncomplete: candidate_evicted\|case_set_evicted\|case_set_unreconstructible\|case_set_changed\|policy_profile_unknown\|case_fingerprint_layers_missing\|no_cases` |
| unit/integration fixtures | `server/acceptance/retry-disposition.test.ts` (17 тестов: лестница unchanged→recompute→rediff→recapture→rebuild, типизированный неполный basis вместо 500, стабильность отпечатка, совет `resume-run`, kill-switch, **дифференциальный блок BR-10b**), `server/acceptance-routes.test.ts` (один отпечаток в ране, ручке и манифесте; query-параметры — утверждения, а не фильтры) |
| before/after receipts | до волны «изменилось ли что-нибудь» выяснялось чтением нескольких receipts вручную либо новым полным раном. После — один read-only вызов; неизменившийся блокер получает `do-not-retry` и **не расходует очередь рендерера** |
| fingerprint/invalidation | `blockerFingerprint` = `blk_<sha256>` от канонизированного basis + **сортированных** терминальных кодов гейтов; ни `runId`, ни время в пре-образ не входят — один блокер в двух ранах даёт один отпечаток. Дифференциальные AC §13 («rollout меняет только соответствующие поля»): переключение каждого тумблера двигает **ровно своё** поле basis и даёт объявленную глубину — capture-v4 → `rediff`, barrier-v4 → `recapture`, geometry-ownership → `recompute`, resolver → `unchanged` |
| legacy/kill-switch | `EASYUI_BLOCKER_FINGERPRINT_DISABLED=1`; тест «kill-switch читается по месту вызова и гасит отпечаток». Плюс **матрица всех девяти тумблеров волны** — `server/kill-switch-matrix.test.ts`: конфигурация «всё выключено» даёт discovery без единого волнового флага и с доволновыми версиями, а снятие каждого тумблера по одному зажигает ровно его набор |
| structural без auto-waiver | ручка **строго read-only** (`no-store`): не создаёт ран, не трогает state, не пишет в CAS. Неполный basis — типизированный ответ с причиной, а не 500 и не оптимистичное «ничего не изменилось» |
| migration note | четыре версии политик волны в `basis` (`schemaResolverVersion`, `resourceBarrierPolicyVersion`, `comparisonPolicyVersion`, `geometryOwnershipPolicyVersion`) — **производные**, а не сохранённые: в `changed[]` они не появляются никогда, потому что сравнивать их не с чем. Их **значение** и есть сигнал включения серверной фичи; вместе с ним меняется `blockerFingerprint`, поэтому кэшированный блокер после rollout'а обязан быть перечитан. Драйвер: `driver.mjs retry-disposition <runId>` (exit всегда 0 — это вопрос, а не приёмка) |

---

## 11. Ограничение: синтетические фикстуры — §16 закрыт частично

**Что закрыто полностью:** capability, JSON Schema контрактов, unit/integration-тесты, fingerprint/invalidation-тесты, legacy/kill-switch-тесты, подтверждение «structural не получил auto-waiver», migration note. Всё перечисленное выше исполняется в CI и не зависит от чужих артефактов.

**Что закрыто частично:** пункты «server integration fixture на **указанном сохранённом** Yandex Pay case» и «before/after terminal receipts с прежним blocker code». Причина названа прямо: **байтов этих артефактов у нас нет** — фидбэк ссылается на `../../artifacts/...`, то есть на дерево вне этого репозитория. Наши before/after — репродукции симптома на синтетических фикстурах (V0-диагностики), и они честно называются репродукциями, а не сохранёнными кейсами.

**Следствие, которое нельзя обойти:** численные AC фидбэка — «391×88», «21/29 Card Input», «24/36 Tooltip», «180.5 s» — у нас **непроверяемы**. Мы поставляем capability; подтверждение снятия blocker'а на сохранённых байтах — **вторая фаза на стороне мигратора**. Более того, V0 показал, что две формулировки блокеров были неточны (BR-04: клэмпа 24 px не существует; BR-05: tail не расширяет layout union) — то есть проверка на реальных байтах не формальность, а единственный способ убедиться, что вылечено то самое.

**Corpus handoff — что нужно, чтобы закрыть §16 целиком** (§0 плана):

| Артефакт | Зачем |
|---|---|
| `cset_*`-манифесты наборов | воспроизвести ровно ту постановку рана: props, эталоны, `expectedGeometry`/`expectedSurfaces`, политику |
| candidate source (TSX ревизии, с которых снимали) | получить тот же `sourceHash` и тот же кандидат |
| raw reference assets (**байты**, не ссылки) | эталон входит в `comparisonFingerprint`; без байтов ни один визуальный AC не воспроизводим |
| stop-receipts терминальных ранов | «прежний blocker code» в before/after берётся отсюда, а не из пересказа |
| перечень кейсов | pay-card-input v21, pay-badge v03, pay-tooltip v02, pay-button-group v07, pay-payment-schedule rev6, CPQR ×2 |

Импортируем их как байты в `test/fixtures/` и добавим по одному integration-тесту на требование — это единственная форма, в которой §3 («fixtures на сохранённых bytes») и §16 («before/after receipts с прежним blocker code») выполняются буквально.

---

## 12. Вопросы координатору

### 12.1. Форма `paintPaddingPx`: per-case вместо set-level

§5 фидбэка кладёт поле краски в `capture`-блок **набора**. Мы объявили его **пер-кейсово** (`cases[].paintPaddingPx`) и просим это подтвердить письменно.

Причина — в самом же фидбэке: set-level поле двигало бы кадры **всех** кейсов набора, нарушая AC «recapture только затронутых cases». Пер-кейсовое поле входит в `frameFingerprint` условным спредом, поэтому кейс, который его не объявил, остаётся байт-в-байт прежним. Если координатор настаивает на set-level форме, мы можем принять её как **дефолт набора**, раскрываемый в пер-кейсовые значения на входе (тогда изменение дефолта честно переснимет весь набор — и это будет видно в `retry-disposition` как `recapture`).

### 12.2. Трактовка 95 %-AC атрибуции

§10 фидбэка содержит внутреннее расхождение: контракт кластера допускает `unknown` total, а AC требует «pixel-ownership ≥95 %». Наше принятое чтение: **95 % — цель, а `unknown` фиксируется честно**. Сервер считает owner-тоталы по **полной** diff-маске (не по усечённому `regions[]`) и публикует `coveragePct` как **отчётную** величину: ни один вердикт от неё не зависит.

Важное следствие, которое мы просим подтвердить: низкое покрытие **не смягчает** вердикт — неатрибутированные пиксели делают кластер `structural`, а structural не смягчается ничем. То есть «не дотянули до 95 %» никогда не превращается в pass; оно превращается в честный fail с признанием, что владелец неизвестен.

### 12.3. Адресат migration note

§16 просит «короткую migration note для `yp-figma-rebuild` skill/driver». **Скилла `yp-figma-rebuild` в этом репозитории нет** — есть только share-пакет `share/yp-figma-rebuild-skill/` (+`.tgz`), который передавался наружу как архив. Мы обновили то, чем владеем: `.claude/skills/author/SKILL.md` и `driver.mjs` (плюс оба share-зеркала синхронизированы `scripts/sync-share-skills.mjs`). Просим назвать адресата: если скилл сборки живёт на стороне координатора, мы отдадим note текстом (эти таблицы плюс §13) — вписывать её в чужой репозиторий вслепую мы не будем.

### 12.4. Vacuous-truth в subject-promote при пустом списке зависимостей

Формулировка §11 «все runtime-зависимости опубликованы с eligible acceptance evidence» при **пустом** списке зависимостей логически истинна. Мы **отказываем** в этом случае осознанно: пустой список означает не «всё чисто», а «мы не знаем, кому принадлежат unknown-пиксели», и прощать их владельцу, которого не объявили, — ровно тот auto-waiver, против которого написан §16. Если координатор считает, что компонент **без** slot-зависимостей должен проходить subject-promote (например, обёртка над host-примитивами), это отдельное решение — скажите, и мы введём явную декларацию «зависимостей нет по построению», а не будем выводить её из пустоты.

---

## 13. Карта: blocker code фидбэка → что его снимает

| # | Симптом/blocker из фидбэка | Что снимает | Как проверить на живом сервере |
|---|---|---|---|
| EUI-BR-01 | `422` неизвестного prop'а на копии документа `@2 {mode:"current-main"}`; расхождение схем между save, render-status и снапом | единый `ResolvedComponentGraph`: пины композиции — только на её раскрытие, `track:head` без fallback, DS-фильтр согласован; `component_prop_unknown` с фактической схемой; конфликт версий — `422 component_pin_conflict` | `features.prototypeSchemaResolverVersion: 2`; сохранить документ и сверить `resolvedVersion`/`sourceHash`/`propsSchemaHash` в save-ответе, `GET …/render-status` и снапе — три ответа обязаны совпасть |
| EUI-BR-02 | декор обрезан на кадре; риск-кейсы не меряют полный paint | `cases[].paintPaddingPx` по сторонам (frame-слой только своего кейса), бюджет `capture_budget_exceeded`, `paint_capture_clipped` с минимумом | `features.paintCapturePaddingV1: true`; объявить `{right: 64}` и убедиться, что метрики соседних кейсов не сдвинулись |
| EUI-BR-03 | «missing-late-asset» на registry-иконках темы; `resource_late_after_barrier` → fail | фаза `registry` до первого манифеста, каналы srcset/pseudo/font/icon-registry/ожидаемых ассетов, пер-ресурсные записи, `themeContentHash` в кадре | `features.resourceBarrierV4: true`, `resourceBarrierPolicyVersion: 4`, `acceptance.readinessPolicyVersion: 4`; форсированный recapture: `expected=decoded`, `lateAfterBarrier=[]` |
| EUI-BR-04 | «канва нормализуется до 24 px», мелкий hug-кейс не судится честно | точное сведение объявленной канвы (delta 0, без zero-pad), `rawDiffPctOfSurface`, `reference_scale_mismatch`. **NB:** клэмпа 24 px не существовало — реальными дефектами были недостижимый fail и слепота к масштабу эталона | `features.exactContentHugCanvasV1: true`, `comparisonPolicyVersion: 2`; 16 px кейс без пер-кейсовых допусков |
| EUI-BR-05 | «tail расширяет layout union у 24/36 roots», вечный `indeterminate` | авто-правило decoration (прозрачность для `rootBoxOf`, неблокирующая краска) + per-case `geometryOwnership` + разведение layout/paint габаритов в probe. **NB:** union tail'ом не расширялся — ломался `rootBoxOf` | `features.geometryDecorationOwnershipV1: true`, `geometryOwnershipPolicyVersion: 1`; tooltip с transform-tail: root/layout clean, tail в `paint` |
| EUI-BR-06 | ран встал без вердикта (180.5 s, рестарт сервера), нет способа доиграть | `POST …/resume` новым раном с lineage, шов `allocate-renderer`, circuit breaker, `error_json`, per-gate fingerprints | `features.acceptanceResumeV1: true`; `driver.mjs accept-resume <runId>` — contract/defaults/audit не переисполняются |
| EUI-BR-07 | residual нечем атрибутировать; renderer-only остаток нечем легализовать | per-node карта элементов, owner-тоталы по полной маске, контракт кластера §10, server-owned профили политики рендерера с `expiry` | `features.visualAttributionV2: true`, `rendererPolicyProfilesV2: true`, `acceptance.rendererPolicyProfiles[]` непуст; `element-map.json` в evidence |
| EUI-BR-08 | чистый компонент непромоутабелен из-за окружения в дереве | `comparison.ownership: subject-and-integration`, два вердикта, subject-promote при eligible-зависимостях, типизированные отказы | `features.comparisonOwnershipV1: true`; квитанция `subjectPromotion` в ответе promote |
| EUI-BR-09 | top-level warning `content-clipped-by-frame` у FlowRoot с rails | `elements[].overflowOwnership` + ограничение вклада поддерева scrollport'ом по оси; `unowned-overflow`/`owned-overflow-exceeds-axis` | `features.flowOverflowOwnershipV1: true`; «FlowRoot 390 + два rail 552»: warning исчезает, rails сохраняют content bounds |
| EUI-BR-10 | stale blocker требует ручного аудита; неизменившийся блокер жжёт очередь | `blockerFingerprint` в терминальном ране + read-only `retry-disposition` с глубиной и советом | `features.blockerFingerprintV1: true`; `driver.mjs retry-disposition <runId>` на неизменившемся блокере → `unchanged` / `do-not-retry` |

**Категории §14 фидбэка (что easy-ui не снимает) остаются за своими владельцами** и получают не «platform pass», а **переадресацию**: receipt называет owner и next-owner. Негативные фикстуры «переадресация, а не platform pass» входят в AC BR-07/BR-10 — в частности, CPQR/Tooltip/Badge residual, признанный structural или source-owned, остаётся `fail` с названным владельцем.
