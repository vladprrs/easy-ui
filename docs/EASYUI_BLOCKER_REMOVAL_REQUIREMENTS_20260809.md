# Требования к easy-ui для снятия актуальных блокеров Yandex Pay v2

Дата: **2026-08-09**  
Статус: требования к платформе; миграция остаётся на пользовательской паузе.

## 1. Цель и границы

Цель этого документа — дать команде easy-ui проверяемый backlog изменений, после которых существующие unpublished candidates можно повторно принять без изменения source, ручной подготовки эталонов и необоснованных visual waivers.

Документ опирается на [полный аудит реестра](../../REGISTRY_AUDIT_20260809.md), последний сохранённый [capability receipt](../../../artifacts/workflows/wf-20260804-01/capabilities-live-next-20260808.json) и component-scoped stop receipts. Он не разрешает easy-ui/Figma mutations и не снимает текущую пользовательскую паузу.

Последний сохранённый capability receipt уже подтверждает `geometrySurfacesV3`, `resourceBarrier`, `candidateDependencyOverlay`, `migrationCommit`, `impactedSnap`, `suggestedPolicy`, `figmaSourcePackage`, `runtimeSchemaDefaults`, `captureNoiseSummary` и `receiptEnvelopeVersion:1`. Поэтому ниже нет повторного запроса на эти возможности как на отсутствующие. Требования описывают конкретные пробелы, обнаруженные после их rollout.

### Что считается снятым blocker

Blocker считается снятым только когда:

1. новая capability видна в свежем `/capabilities` целевого instance;
2. сохранённый candidate, case-set и raw reference можно использовать повторно без source mutation;
3. сервер возвращает воспроизводимый terminal outcome и полный receipt;
4. прежний typed blocker либо превращается в `pass`/`pass_with_exceptions` применимой политики, либо точно переадресуется source/product owner с element-level evidence;
5. structural failure не превращается в pass через общий diff budget;
6. изменение входит в fingerprints и имеет ограниченный kill switch или безопасный legacy fallback.

## 2. Приоритеты

| ID | Priority | Требование | Непосредственно затронутые lanes |
|---|---|---|---|
| EUI-BR-01 | P0 milestone | Единый resolver схемы published component | Pay App Main / `pay-product-widget.mode` |
| EUI-BR-02 | P0 correctness | Настраиваемая и unclipped paint-capture поверхность | Payment Schedule |
| EUI-BR-03 | P0 correctness | Полный registry-resource barrier | Card Input |
| EUI-BR-04 | P0 correctness | Exact content-hug canvas меньше 24 px | Badge |
| EUI-BR-05 | P0 correctness | Раздельная геометрия layout и transformed decoration | Tooltip |
| EUI-BR-06 | P0 reliability | Resumable acceptance после pre-capture timeout | Button Group |
| EUI-BR-07 | P0 milestone | Element-level visual attribution и renderer-owned policy | CPQR Banner, CPQR Promo Banner; затем Timer/Lead Block |
| EUI-BR-08 | P1 | Component-owned comparison внутри context/dependency tree | Payment Method Carousel |
| EUI-BR-09 | P1 | Scroll/overflow ownership для FlowRoot и compositions | Representative Pay App Main |
| EUI-BR-10 | P1 cross-cutting | Blocker fingerprint и retry disposition | Все stop-classified lanes |

## 3. Общие требования к реализации

Для EUI-BR-01…10 действуют общие правила:

- новые поля должны проходить strict schema validation; неизвестное поле остаётся `422`;
- capability и её contract version должны приходить с сервера, а не определяться по версии skill/driver;
- receipts должны сохранять входные fingerprints и фактически применённые значения, а не только requested values;
- любое изменение capture, schema resolution или renderer policy должно корректно вызывать `recompute`, `rediff`, `recapture` или `rebuild`, а не молчаливый reuse;
- legacy path при выключенной capability должен сохранить текущую семантику byte-for-byte;
- `suggestedPolicy` остаётся report-only; публикация допустима только по терминальному eligible acceptance run;
- тестовые fixtures ниже должны выполняться на сохранённых source/candidate/reference bytes. Повторный Figma read не является условием теста.

## 4. P0 — единый resolver схемы published component

### Проблема

В Pay App Main head-tracked prototype корректно разрешает active `PayProductWidget@2`, а live component source и catalog schema содержат `mode: "canonical" | "current-main"`. При этом prototype-save validator дважды возвращает `422 ... Unrecognized key: mode`. Composition wrapper не является обходом: analyzer возвращает `extend-component`.

Evidence: [component integration attempt](../../../artifacts/migration-workspaces/product-scope/pay-app-cpqr-v01/pay-app-main-20260808/component-integration-attempt-20260808.json).

### Требование EUI-BR-01

easy-ui MUST использовать один authoritative `ResolvedComponentGraph` для:

- prototype-save validation;
- component pinning;
- `status` и render;
- geometry/snap;
- composition preview-tree, если дерево содержит тот же component pin.

Для `track:head` schema берётся из версии, которую тот же resolver собирается записать в resolved pins. Для pinned document schema берётся из exact version. Запрещён fallback на предыдущую active version при наличии успешно разрешённой новой версии.

Ключ schema cache MUST включать минимум:

```json
{
  "designSystemId": "yandex-pay-v2",
  "designSystemMetaVersion": 37,
  "catalogRevision": "<opaque>",
  "componentId": "pay-product-widget",
  "componentVersion": 2,
  "sourceHash": "<sha256>",
  "propsSchemaHash": "<sha256>"
}
```

Promote, supersede и catalog migration MUST атомарно инвалидировать несовместимые validator entries.

Ошибка неизвестного prop MUST возвращать diagnostic context:

```json
{
  "code": "component_prop_unknown",
  "path": "/screens/0/spec/elements/product-widget/props/mode",
  "componentId": "pay-product-widget",
  "resolvedVersion": 2,
  "sourceHash": "<sha256>",
  "propsSchemaHash": "<sha256>",
  "catalogRevision": "<opaque>",
  "acceptedKeys": ["mode", "accessibleLabel"]
}
```

### Capability и acceptance criteria

Предлагаемая capability: `prototypeSchemaResolverV2`, contract version `2`.

- Сохранение копии Main rev12 с `PayProductWidget@2` и `{mode:"current-main"}` проходит validation и save.
- `status`, save receipt и snap называют одинаковые `resolvedVersion`, `sourceHash` и `propsSchemaHash`.
- Заведомо неизвестный prop по-прежнему отклоняется и показывает фактически применённую schema.
- После promote новой версии повторный save не использует schema предыдущей active version.

Результат: снимается `blocked:platform:prototype-prop-schema-stale:pay-product-widget.mode`; host Image можно заменить component-native surface без изменения Figma source.

## 5. P0 — unclipped paint capture с per-side padding

### Проблема

Geometry surfaces v3 уже разделяет `root`, `layoutUnion`, `paint` и `referenceExport`, но capture worker всё ещё обрезает paint фиксированным service margin. Для Payment Schedule rev6 viewport v10 совпадает с reference canvas `399×120`, однако paint обрезан на 24 px: `367/374` вместо ожидаемых `391/398`. Root, layout union, reference export, resources и fonts при этом чистые.

Evidence: [viewport hypotheses v09/v10](../../../artifacts/easy-ui/components/pay-payment-schedule/draft-v01/server-stage-v01/viewport-capture-hypothesis-v09-v10-20260808.json).

### Требование EUI-BR-02

Case-set MUST позволять задавать geometry-capture padding по сторонам в CSS px независимо от visual reference canvas:

```json
{
  "capture": {
    "surface": "viewport",
    "viewport": {"width": 367, "height": 88},
    "paintPaddingPx": {"top": 16, "right": 64, "bottom": 16, "left": 16}
  },
  "expectedSurfaces": ["root", "layoutUnion", "paint", "referenceExport"],
  "comparison": {"surface": "referenceExport"}
}
```

Требования к семантике:

- `paintPaddingPx` влияет на возможность измерить полный paint, но не меняет `rootBounds`, `layoutUnion`, `referenceExportDims` и размер raw reference;
- visual comparison может оставаться на `referenceExport`, пока geometry измеряет unclipped `paint`;
- каждая сторона ограничена существующим server-owned overflow limit;
- receipt хранит requested/effective padding, clipping edge, полный paint bounds и raster canvas;
- изменение padding меняет frame/geometry fingerprint и вызывает recapture только затронутых cases;
- недостаточный padding возвращает `paint_capture_clipped` с требуемым minimum, а не ложный geometry mismatch.

### Capability и acceptance criteria

Предлагаемая capability: `paintCapturePaddingV1`.

- На существующем rev6/candidate и raw references оба risk cases измеряют paint `391×88` и `398×88`.
- `root=343×88`, layout unions `480×88`/`558×88` и `referenceExport=367×88` остаются неизменными.
- Visual comparison остаётся привязан к exact `367×88` export; полный paint не подменяет source export.
- Шесть исходных cases получают terminal geometry verdict без waiver и source mutation.

Результат: снимается `blocked:platform:geometry-capture-paint-margin-not-configurable` и разблокируются зависящие Split Payment/Card Details lanes.

## 6. P0 — полный registry-resource barrier

### Проблема

`resourceBarrier` включён, но Card Input rev27 после cold run и forced recapture стабильно теряет direct registry images в 21 случае. Восемь cases без изображений проходят. Объединение двух MIR leaves в один registry SVG не изменило результат, поэтому это не source-shape hypothesis.

Evidence: [Card Input handoff](../../../artifacts/implementation-packages/pay-card-input/v21/handoff.json) и [stop classification](../../../artifacts/implementation-packages/pay-card-input/v21/diagnostics/stop-classification.json).

### Требование EUI-BR-03

Resource barrier MUST строить frame-scoped dependency manifest и ждать не только уже начавшиеся HTTP requests, но и все registry resources, разрешённые для конкретного case:

- `<img src>` и `srcset`;
- CSS `background-image`, `mask-image`, `content` и nested pseudo-elements;
- registry `Icon`/image helpers;
- assets unpublished candidate и candidate overlay dependencies;
- conditional assets, появившиеся после props/slot resolution;
- fonts и последующие image decode.

Receipt на каждый ресурс MUST содержать:

```json
{
  "assetId": "asset_<sha256>",
  "ownerElementKey": "card-logo",
  "ownerComponentId": "pay-card-input",
  "channel": "img|css-background|css-mask|icon-registry|font",
  "discoveredAt": "bundle|resolved-tree|dom|computed-style|request",
  "requested": true,
  "loaded": true,
  "decoded": true,
  "completedBeforeStableFrame": true
}
```

`expected !== decoded`, decode failure или новый resource после stable frame MUST давать `indeterminate:resource_barrier_incomplete`, а capture не должен становиться visual evidence. Повторный run может reuse barrier receipt только при полном совпадении candidate, resolved dependency graph, case props, theme resources и resource-barrier policy fingerprint.

Опциональный author hint `preloadAssets` MAY ускорять barrier, но отсутствие hint не освобождает сервер от обнаружения registry assets.

### Capability и acceptance criteria

Предлагаемая capability: `resourceBarrierV4` с отдельным `resourceBarrierPolicyVersion`.

- Existing Card Input rev27 forced recapture обнаруживает все direct registry images до первого evidence frame.
- Для 21 affected cases `expected=decoded`, `lateAfterBarrier=[]`; восемь no-image cases не получают лишних dependencies.
- Повторный forced recapture не воспроизводит `missing-late-asset`.
- Если конкретный asset действительно не загружается, receipt называет `assetId`, `ownerElementKey`, channel и phase.

Результат: снимается `blocked:platform:card-input-direct-registry-images-remain-late-after-forced-recapture` без новой source revision.

## 7. P0 — exact small content-hug canvas

### Проблема

Badge rev6 проходит contract/readiness/geometry для 30/30, но шесть truthful 16 px cases становятся visual `indeterminate`: comparison canvas нормализуется до внутреннего minimum 24 px. `sizeDeltaPx` не исправляет саму поверхность и не должен использоваться как waiver.

Evidence: [Badge handoff](../../../artifacts/implementation-packages/pay-badge/v03/handoff.json).

### Требование EUI-BR-04

Content-hug capture MUST сохранять измеренный размер subject root вплоть до 1 CSS px независимо от минимального viewport renderer worker. Внутренний browser viewport MAY оставаться крупнее, но crop/comparison canvas должен быть exact:

```json
{
  "capture": {"surface": "hug"},
  "observed": {
    "rootBounds": {"height": 16},
    "comparisonCanvasCssPx": {"height": 16},
    "deviceScaleFactor": 2,
    "comparisonCanvasDevicePx": {"height": 32}
  }
}
```

Никакой минимальный hit target, line box или 24 px renderer canvas не должен расширять visual surface без отдельного element-level paint evidence. Размер reference и candidate canvas рассчитывается одним normalization path.

### Capability и acceptance criteria

Предлагаемая capability: `exactContentHugCanvasV1`.

- Те же шесть 16 px Badge cases больше не получают canvas-size `indeterminate`.
- Receipt показывает exact CSS/device dimensions и отсутствие hidden padding.
- Остальные visual residuals Badge пересчитываются отдельно; rollout этой capability сам по себе не выдаёт им pass.

Результат: снимается platform-часть `blocked:platform:badge-16px-content-hug-normalizes-to-24px-canvas`.

## 8. P0 — decoration-aware geometry

### Проблема

В Tooltip transformed tail `8×24` расширяет layout union для 24 из 36 roots, хотя tail является paint decoration. Root, in-flow content и Low-shadow policy уже исправлены; попытка clip tail ухудшила visual result.

Evidence: [Tooltip stop classification](../../../artifacts/implementation-packages/pay-tooltip/v02/diagnostics/stop-classification.json).

### Требование EUI-BR-05

Geometry engine MUST различать:

- pre-transform in-flow layout bounds;
- out-of-flow/decoration bounds;
- post-transform paint bounds;
- clipped visible paint bounds.

CSS `transform` не должен автоматически превращать decoration в layout overflow. Для неоднозначного DOM component author должен иметь строго валидируемый способ пометить element key как decoration/paint-only, например через platform metadata, а не произвольный visual waiver:

```json
{
  "geometryOwnership": {
    "tail": {"role": "decoration", "participatesIn": ["paint"]}
  }
}
```

Receipt MUST показывать исходный element key, `preTransformBounds`, transform matrix, `postTransformPaintBounds`, clip chain и причину включения/исключения из каждой surface. Decoration всё равно участвует в visual gate и paint overflow policy.

### Capability и acceptance criteria

Предлагаемая capability: `geometryDecorationOwnershipV1`.

- Existing Tooltip candidate получает корректный root/layout verdict во всех 36 cases.
- Tail остаётся измеренным в `paint` и видимым в visual diff; он не исчезает из evidence.
- Ошибочная метка, скрывающая реальный in-flow child, отклоняется validation/audit gate.
- Visual residual Tooltip остаётся fail до EUI-BR-07 либо source/renderer trigger; geometry blocker при этом закрыт отдельно.

Результат: снимается geometry-часть `blocked:acceptance:tooltip-transformed-tail-layout-and-live-vector-raster`.

## 9. P0 — resumable acceptance после timeout

### Проблема

Button Group rev7 имеет полный 20-case set. Terminal run прошёл contract/default/audit для всех 20 случаев, затем примерно через 180.5 s завершился до capture/readiness/geometry/visual и не оставил frame artifacts. Повтор идентичного run сейчас только повторит дорогой pre-capture path.

Evidence: [Button Group handoff](../../../artifacts/implementation-packages/pay-button-group/v07/handoff.json).

### Требование EUI-BR-06

Acceptance run MUST иметь durable phase checkpoints:

```text
resolve → validate → compile → allocate-renderer → capture
        → readiness → geometry → visual → determinism → verdict
```

Для каждого case/job сервер хранит completed phases, artifacts и phase fingerprint. Timeout возвращает typed status, например:

```json
{
  "status": "error",
  "statusReason": "phase_timeout",
  "phase": "allocate-renderer",
  "elapsedMs": 180500,
  "lastCompletedPhase": "audit",
  "resumable": true,
  "resumeFrom": "capture",
  "candidateId": "cand_...",
  "caseSetId": "cset_...",
  "jobIds": ["job_..."]
}
```

Нужен idempotent resume surface (`POST /acceptance-runs/:id/resume` или эквивалентный driver verb). Resume MUST:

- переиспользовать completed gates только при совпавших fingerprints;
- не создавать второй concurrent run того же candidate/case-set/policy;
- продолжать с первой незавершённой phase;
- сохранять lineage `resumedFromRunId`, attempt count и предыдущую ошибку;
- при несовместимом старом run разрешать новый run с `supersedesRunId`, но reuse candidate compilation и completed non-render gates.

### Capability и acceptance criteria

Предлагаемая capability: `acceptanceResumeV1`.

- Button Group использует тот же candidate и case-set; новая component revision не нужна.
- Contract/default/audit не исполняются повторно без fingerprint change.
- Capture либо успешно стартует, либо новый typed timeout точно называет phase/resource/queue state.
- После server restart `accept-status` и resume сохраняют checkpoint lineage.

Результат: снимается `blocked:server-state:acceptance-pre-capture-timeout` и становится возможен честный visual verdict rev7.

## 10. P0 — element-level visual attribution и renderer policy

### Проблема

`causes[]` и `suggestedPolicy` уже существуют, но текущей детализации недостаточно для terminal решения по CPQR:

- QR Banner M: geometry clean, raw около 7%, AA около 4%; PNG/SVG leaf strategies проверены и отвергнуты;
- Promo/Authorized Banner: все non-visual gates clean, residual для promo существенно выше live-text budget, а typed owner конкретных pixels отсутствует;
- похожий ambiguity остаётся в modern Timer, Lead Block и visual-части Tooltip/Badge.

Evidence: [CPQR Banner stop](../../../artifacts/easy-ui/components/pay-cpqr-banner/draft-v01/stop-classification-after-rev14.json) и [CPQR Promo Banner stop](../../../artifacts/easy-ui/components/pay-cpqr-promo-banner/draft-v01/stop-classification-after-rev5.json).

### Требование EUI-BR-07

Visual pipeline MUST атрибутировать mismatch clusters к paint owner и причине. Для каждого cluster нужны:

```json
{
  "boundsDevicePx": [0, 0, 100, 24],
  "mismatchedPixels": 412,
  "ownerElementKey": "headline",
  "ownerComponentId": "pay-cpqr-banner-shell",
  "paintClass": "live-text|vector-edge|registry-image|fill|stroke|effect|geometry|unknown",
  "sourceAssetId": null,
  "rawDiffPct": 3.1,
  "aaResidualPct": 0.8,
  "bestOffset": {"dx": 0, "dy": 0, "residualPct": 0.8},
  "structural": false,
  "basis": ["geometry-unchanged", "font-fingerprint-match", "edge-contained"],
  "confidence": 0.97
}
```

Минимальный контракт классификации:

- не менее 95% mismatched pixels должны иметь owner либо явно попасть в `unknown` total;
- `structural=true` при geometry shift, missing asset, wrong fill/stroke/effect или mismatch вне заявленного paint owner;
- text/vector renderer residual доказывается только при zero/bounded offset, unchanged geometry, загруженных exact fonts/assets и стабильном renderer fingerprint;
- итог содержит per-element totals и full-case totals, чтобы большой structural cluster нельзя было спрятать за AA другого элемента;
- reference matte/flattening, color profile, renderer/font fingerprints и comparison policy входят в receipt.

Если все остаточные pixels доказанно renderer-only, easy-ui MAY предоставить именованный server-owned policy profile, привязанный к renderer fingerprint. Такой профиль:

- не создаётся автоматически из одного run;
- не применяет общий процент ко всему case;
- ограничен paint class/element region и выдаёт максимум `pass_with_exceptions`;
- истекает при изменении renderer, fonts, matte, asset или geometry fingerprint;
- никогда не покрывает `unknown` или `structural=true`.

`suggestedPolicy` остаётся рекомендацией; promotion eligibility появляется только после запуска acceptance под заранее опубликованным profile.

### Capability и acceptance criteria

Предлагаемая capability: `visualAttributionV2`; при наличии новых профилей — отдельная версия `rendererPolicyProfilesV2`.

- Existing CPQR Banner M и два Promo Banner cases возвращают per-element ownership не менее чем для 95% mismatched pixels.
- Если residual renderer-only, повторный run под server-owned profile даёт `pass_with_exceptions` с точным scope и expiry fingerprint.
- Если residual structural/source-owned, verdict остаётся fail, но receipt называет element/source region и следующий owner; повтор source-agnostic экспериментов больше не нужен.
- Ни один текущий residual не становится pass только из-за общего 3–14% budget.

Результат: снимается platform-неопределённость для двух незавершённых CPQR banner families. Publication разблокируется только если сервер докажет renderer-only residual; иначе blocker честно переходит к source owner.

## 11. P1 — component-owned comparison в contextual tree

### Проблема

В Carousel corrected references показывают exact wrapper geometry и нулевой mismatch в padding/margins/gaps, но весь residual находится внутри dependency-owned payment-method children. Full contextual verdict поэтому блокирует первую ревизию Carousel, хотя parent-owned pixels уже доказанно clean.

Evidence: [Carousel dependency-v2 rerun](../../../artifacts/migration-workspaces/pay-payment-method-carousel/wf-20260804-01/carousel-v01/dependency-v2-rerun-20260806.json).

### Требование EUI-BR-08

Acceptance MUST различать два verdict:

1. `subjectVerdict` — pixels и geometry, которыми владеет принимаемый component;
2. `integrationVerdict` — полная contextual surface вместе с host/dependencies.

Case-set должен позволять запросить ownership-aware comparison:

```json
{
  "comparison": {
    "ownership": "subject-and-integration",
    "subjectComponentId": "pay-payment-method-carousel",
    "dependencyPolicy": "require-eligible-acceptance"
  }
}
```

Сервер строит ownership mask из resolved component/slot tree, а не из ручного crop. Все исключённые pixels остаются в integration diff и группируются по dependency component/version/element key. Subject promotion допустим только если:

- `subjectVerdict=pass`;
- все runtime dependencies опубликованы и имеют eligible acceptance evidence;
- contract, interaction, geometry и determinism полного дерева clean;
- receipt явно сохраняет failing `integrationVerdict`, если он есть.

### Capability и acceptance criteria

Предлагаемая capability: `comparisonOwnershipV1`.

- На текущих Carousel references wrapper-owned pixels получают strict pass.
- Полный contextual residual остаётся видимым и атрибутируется конкретным payment-method instances.
- Carousel component может получить собственный terminal verdict без ложного заявления, что product integration pixel-perfect.
- Любой mismatch parent background, mask, gap, clipping или interaction остаётся subject failure.

Результат: снимается component-level `blocked:acceptance:carousel-context-v2-pixel-strict`; product-flow blocker сохраняется до contextual source reconciliation.

## 12. P1 — scroll/overflow ownership для FlowRoot

### Проблема

Representative Pay App Main имеет viewport 390 px, а намеренные горизонтальные Savers/Loans rails дают layout union 552 px. Geometry probe поднимает общий FlowRoot warning, хотя rail должен владеть horizontal overflow. Существующий `overlayScrollOwnership` эту composition/FlowRoot ситуацию не закрывает.

Evidence: [Main geometry receipt](../../../artifacts/migration-workspaces/product-scope/pay-app-cpqr-v01/pay-app-main-20260808/raw/geometry-live-rev8.json).

### Требование EUI-BR-09

Host/composition schema MUST позволять объявить scroll owner и ось на конкретном узле. Geometry engine должен ограничивать вклад descendants scrollport boundary и отдельно сохранять scroll content bounds:

```json
{
  "overflowOwnership": {
    "axis": "x",
    "mode": "scroll",
    "viewportOwner": "savers-rail",
    "expectedContentOverflow": true
  }
}
```

Receipt показывает `scrollportBounds`, `scrollContentBounds`, clip chain, owned overflow и неожиданный overflow за пределами owner. Объявление не должно скрывать vertical overflow, overlap FlowRoot regions или paint вне scroll clip.

### Capability и acceptance criteria

Предлагаемая capability: `flowOverflowOwnershipV1`.

- Main остаётся `390px` viewport, rails сохраняют `552px` content bounds.
- Top-level FlowRoot больше не получает layout-overflow warning от двух объявленных horizontal rails.
- Незаявленный overflow и vertical spill продолжают давать failure/warning.

Результат: закрывается `known-gap:geometry:composition-layout-union-and-flowroot-viewport`; это улучшает integration evidence, но не заменяет component-native Vitrina/source work.

## 13. P1 — blocker fingerprint и retry disposition

### Проблема

Сейчас stop receipts вручную перечисляют trigger: renderer, schema, source, capture policy или resource readiness. Без server-owned comparison агент должен читать несколько receipts, чтобы понять, создаст ли retry новое знание.

### Требование EUI-BR-10

Terminal fail/error/indeterminate run MUST возвращать `blockerFingerprint` и machine-readable retry disposition. Рекомендуемый read-only endpoint:

```text
GET /acceptance-runs/:runId/retry-disposition?candidateId=<id>&caseSetId=<id>
```

Пример ответа:

```json
{
  "blockerFingerprint": "blk_<sha256>",
  "disposition": "unchanged|recompute|rediff|recapture|rebuild",
  "changed": ["renderer.fingerprint", "resourceBarrierPolicyVersion"],
  "unchanged": ["candidate.sourceHash", "caseSetId", "referenceAssets"],
  "suggestedAction": "resume-run|new-run|update-source|do-not-retry",
  "basis": {
    "schemaResolverVersion": 2,
    "rendererFingerprint": "<sha256>",
    "capturePolicyVersion": 4,
    "resourceBarrierPolicyVersion": 4,
    "geometryContractVersion": 3,
    "candidateSourceHash": "<sha256>",
    "comparisonFingerprint": "<sha256>",
    "verdictPolicyFingerprint": "<sha256>"
  }
}
```

### Capability и acceptance criteria

Предлагаемая capability: `blockerFingerprintV1`.

- Для unchanged Badge/Tooltip/Card Input/Button Group/CPQR runs ответ равен `do-not-retry`.
- Rollout EUI-BR-02…07 меняет только соответствующие fingerprint fields и выдаёт правильную глубину retry.
- Disposition согласован с существующей refresh algebra: policy-only → recompute, reference-only → rediff, capture/renderer → recapture, source/schema → rebuild.
- Endpoint read-only, не создаёт run и не меняет server state.

Результат: stale blocker больше не требует ручного аудита, а неизменившийся blocker не расходует renderer queue.

## 14. Что easy-ui не может снять самостоятельно

Следующие категории не должны попадать в platform backlog как easy-ui defects:

- отсутствующие exact Figma references/leaves у Details Card, Task Item, Product Card, Empty State, Product Header, Education и других source-blocked lanes;
- продуктовые решения по actions, navigation, routing, controlled input ownership и animation/reduced-motion;
- current-main Vitrina, пока source branch не сопоставлен с component contract;
- CPQR/Tooltip/Badge residual, если EUI-BR-07 докажет structural или source-owned pixels;
- package sealing незавершённых implementation lanes;
- sandbox/DNS/permission shape локального агента.

easy-ui должен возвращать достаточно точное evidence, чтобы такие случаи автоматически переходили к правильному owner, но не должен превращать их в platform pass.

## 15. Рекомендуемый rollout

1. **EUI-BR-01** — кратчайший путь к component-native Pay App Main.
2. **EUI-BR-07** — terminal классификация двух оставшихся CPQR направлений.
3. **EUI-BR-02, 03, 04, 05** — независимые correctness fixes capture/geometry.
4. **EUI-BR-06** — надёжное завершение дорогих matrix runs.
5. **EUI-BR-08, 09** — корректное разделение component и integration ownership.
6. **EUI-BR-10** — единый server-owned механизм invalidation для всех перечисленных blockers; его можно внедрять параллельно с предыдущими пунктами.

## 16. Release checklist easy-ui

Для каждой capability команда easy-ui должна приложить:

- capability name/version и limits в `/capabilities`;
- JSON Schema нового request/receipt contract;
- unit tests и server integration fixture на указанном сохранённом Yandex Pay case;
- before/after terminal receipts с прежним blocker code;
- fingerprint/invalidation test;
- legacy/kill-switch test;
- подтверждение, что structural failures не получили auto-waiver;
- короткую migration note для `yp-figma-rebuild` skill/driver.

После получения такого release package миграционный coordinator сможет cache-first проверить новый trigger, выполнить один fresh authoritative capability/head read после явного resume и повторить только затронутые cases.
