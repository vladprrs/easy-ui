# Платформенные capabilities по фидбэку feedback-3 (v3)

**Дата:** 2026-08-06 · **Источник:** `docs/feedback-3.md` (10 строк-требований от разработчиков renderer/acceptance/Composition v3/Overlay; ссылки 3.x/5.x/D.x — на внешний отчёт миграции, в репо его нет, таблица самодостаточна).
**Статус:** v3 — после Stage 2 (раунд 1: 3 линзы + верификация, 22 находки; раунд 2: дельта-ревью v2, находки V1–V14; триаж — §5).

Критерий из фидбэка: «для каждого platform fix достаточно новой capability/schema или renderer fingerprint и короткого changelog. Coordinator сам переиспользует сохранённые candidates/references и запускает только затронутые cases» — каждый фикс обязан быть (а) декларативным (schema/capability), (б) корректно инвалидировать только затронутый слой каскада (frame / comparison / verdict).

## 0. Карта фидбэка → пакеты работ

| # | Требование фидбэка | Пакет | Слой инвалидации |
|---|---|---|---|
| 1 | Nested slot bindings (глубже 1 уровня) **либо** first-publish overlay | W6 | frame (только кейсы с вложенными слотами) |
| 2 | First-publish candidate overlay (fixture ссылается на unpublished candidate) | **осознанно не покрыт** — §1.1, отказ фиксируется в changelog | — |
| 3 | Multi-file Figma provenance | W1 | нет (metadata) |
| 4 | Paint extraction не теряет live text | W2 (диагностика-сначала, §W2-T0) | frame (`geometryContractVersion` — §1.3) |
| 5 | Canonical live-text raster policy (пресет `live-text-v1`) | W4 | comparison (re-diff) |
| 6 | Intentional paint overflow (декларативный budget) | W3 | verdict (recompute) |
| 7 | Comparison matte / transparent-root normalization | W4 | comparison (re-diff) |
| 8 | Geometry tolerances per-case | W3 | verdict (recompute) |
| 9 | Content-hug clipped carousel (clip-aware layout root) | W2 | frame (`geometryContractVersion`) |
| 10 | Overlay inset + modal scroll ownership | W5 | frame (только новые props/кейсы) |

## 1. Ключевые решения

### 1.1. Строки 1–2: **nested slotBindings**; строка 2 — осознанный отказ, зафиксированный для координатора

Фидбэк в строке 1 даёт альтернативу («либо») — выбираем nested slotBindings:

- Рантайм уже поддерживает произвольную глубину слотов (`src/prototype/runtimeSpec.ts:227-256`); depth-1 — ограничение контура case-set→капчур (`src/acceptance/caseSetSchema.ts:195-201`; плоские `resolveSlotBindings`/`slotsHashOf`/`slotCaptureOf`/`captureRuntimeTree`), а не рендерера.
- Проверяемый результат строки 1 («Lead Block acceptance получает реальное содержимое вложенной кнопки») достигается компонентным acceptance-путём: unpublished parent **candidate** + опубликованные дети уже работают (Feature A 2026-08-05), не хватает только глубины.

Строка 2 («prototype/fixture ссылается на кандидата неопубликованного компонента») — самостоятельное требование, и оно **не реализуется в этом пакете** (триаж S4): документ прототипа не сохраняется с неопубликованным типом (`server/validation.ts:184-215`, `snapshotDefinitions` требует `component_publishes.status='active'` + серверная материализация из опубликованной ревизии); обход означает draft-документы прототипов с кандидатными пинами — отдельный проект. В changelog W7 фиксируем формулировку обхода для координатора: *«fixture-путь для unpublished компонента недоступен; сценарий 3.6 проверяется case-set'ом со слотами (включая вложенные), а прототипная регрессия — prototypeCandidateOverlay после первой публикации»*. Кандидат на будущее (не в скоупе): ephemeral fixture-джоба без сохранения документа, с резолвом типов из candidate-бандлов.

### 1.2. Строка 5 (Timer): именованный платформенный пресет, а не свободная ручка

В acceptance эталон — Figma-ассет: у него нет renderer fingerprint (сверка fingerprint существует только в visual-runs, `server/visual/service.ts:161-200`), «один renderer/font fingerprint» для пары Figma-PNG ↔ живой капчур недостижим. Реализуем вторую ветку фидбэка — «документированный scoped profile»: per-case поле `textAaBudget: "live-text-v1"` — **именованный пресет, пороги которого владеет сервер** (не автор манифеста): `maxRawDiffPct` и `minEdgeResidualPct` зашиты в профиль и версионируются его именем (триаж S5 — свободные числа отклонены, иначе «официальность» теряется). Тюнинг порогов = новый пресет `live-text-v2`.

### 1.3. Инвалидация W2: `geometryContractVersion` — кадровый вход, а не ALGO bump

Раунд 1 доказал (F1, blocker): `CASE_FINGERPRINT_ALGO_VERSION` **не входит** в frameFingerprint — его bump не инвалидирует кадры; после «ALGO 7→8» прод тихо перенёс бы вердикты со старой семантикой layoutBounds. Механизм v2:

- Константа `GEOMETRY_CONTRACT_VERSION = 2` (рядом с семантикой `geometry.mjs`) применяется **внутри `frameFingerprint`** (не на call-site — выбор зафиксирован по V8), через conditional spread `...(v > 1 ? {geometryContractVersion: v} : {})` — все новые fingerprints включают поле → все старые кадры честно инвалидируются (полная пересъёмка, это цель).
- Golden `GOLDEN_FRAME` (`f29b0c49…`) при этом сдвигается — **единственный санкционированный сдвиг**, в паре с дифференциальным тестом «смена GEOMETRY_CONTRACT_VERSION ⇒ другой frame_fingerprint» (триаж M6 + F1). Обновляются оба затронутых места `server/acceptance/ids.test.ts` (golden-вызов и ручная сборка входа `:234-238`). ALGO не бампается (он про состав/форму case_fingerprint, форма не меняется).
- Прод-последствие: полная пересъёмка затронутых наборов при первом ране (честная стоимость; RECOMPUTE-каскад не участвует — frame-слой).

### 1.4. Matte (строка 7): декларативный контракт сравнения, без изменения капчура

Капчур остаётся прозрачным (`omitBackground:true` — frame-слой, не трогаем). Matte применяется **только при сравнении** в visual-diff-worker: обе картинки компонуются над объявленным цветом после placement/pad, до метрик. Один flatten, без повторного crop. Поле — comparison-слой → каскад re-diff сохранённых paint.png без пересъёмки.

### 1.5. Сквозное правило: локальный валидатор драйвера — гейт каждой волны схемы

`driver.mjs` несёт **собственный** локальный валидатор манифеста (закрытые allowlist'ы и лимиты, включая локальный `caseSetIdOfManifest`, `driver.mjs:2879`), копий три (`.claude/skills/author/driver.mjs`, `share/easy-ui-authoring-skill/`, `share/yp-figma-rebuild-skill/`). Любое новое поле манифеста без правки драйвера делает легальный манифест неотправляемым (отказ до сети). Поэтому **каждая волна W3/W4/W5/W6 включает под-задачу**: правка трёх копий драйвера + `server/driver-mjs.d.ts` (при новых экспортах) + публикация новых лимитов в `/api/capabilities.limits` + тест «драйвер локально принимает манифест с новым полем» (триаж S6/F6).

## 2. Пакеты работ

Порядок: W1 ∥ W6 (не пересекаются) → W2 → W3 → W4 → W5 → W7. **Жёсткий инвариант деплоя: W2 и W3 едут одним деплоем** (иначе окно ложных fail на кейсах с точным `expectedGeometry` — триаж F8/R1). Сериализация файлов (по одной волне за раз, в порядке исполнения волн): `caseSetSchema.ts` и `server/acceptance/caseSets.ts`/`cases.ts` — W6→W3→W4→W5; `ids.ts` — W6→W2→W3→W4→W5; `src/capture/geometry.mjs` — W2 (владелец семантики) → W5 (overlay-ветка; поэтому W5 строго после W2 — триаж V11).

### W1. Multi-source Figma provenance (строка 3)

**Контракт.** `figmaSchema` (`server/figma.ts:12-18`) получает опциональное поле:

```ts
sources: z.array(z.strictObject({
  fileKey: <тот же regex>,
  nodeIds: z.array(nodeId).min(1).max(50),
  role: z.string().min(1).max(64).optional(), // "core" | "pay-app" | произвольная метка
})).min(1).max(8).optional()
```

Семантика: `fileKey`/`nodeIds` верхнего уровня — primary-документ (обратная совместимость); `sources[]` — дополнительные источники lineage. Дубликат `fileKey` внутри `sources` или совпадение с primary — 422 `validation_failed`. `referenceScreenshots` общие.

**Файлы:** `server/figma.ts` (схема + refine), `server/contracts.ts`, `server/openapi.json` (регенерация, drift-гейт), `server/components/validate.ts` (тест «PayCard extension с Core + Pay App» → publish-префлайт зелёный), `scripts/check-provenance-resolver.ts` (пины), `src/api/client.ts`, **проекция каталога расширяется одним полем `sourceCount`** (set-based запрос сохраняется; `server/routes/libraryCatalog.ts:113-120`, `server/contracts.ts:2508`) + тултип `src/app/strings/library.ts:137-138` «primary fileKey · +N источников» (триаж S8 — противоречие v1 снято выбором «расширить проекцию»), `docs/server-api.md`, `.claude/skills/author/SKILL.md` + зеркала.

**Не делаем:** case-set `source` остаётся одиночным; `cropLineage` не трогаем; миграций БД нет; `driver.mjs` figma не валидирует — правок кода драйвера нет.

**Done:** validate принимает primary + 2 sources; 422 на дубликат; `npm run verify:provenance` зелёный; openapi без drift; существующие записи читаются; `sourceCount` в проекции и тултипе.

### W2. Layout bounds v2: live text + clip-aware root (строки 4, 9)

**T2-0. Диагностика-сначала (гейт волны, триаж M7).** До любых правок: фикстура, воспроизводящая потерю текстовых строк типа Chart Info (текст в `display:contents`/непосредственно в маркере), прогон paint-капчура, зафиксировать фактические `layoutBounds`/`paintBounds`/параметры нормализации канвы и **точное место потери** (ink-bbox текст не теряет — alpha>0 считается краской; кандидаты: канва content-hug из заниженного layoutBounds, crop, padTo). Механизм T2a применяется только после подтверждения; если потеря окажется в другом месте — фикс смещается туда же, инвалидация пересматривается (стоп-точка: доложить оркестратору).

**T2a. Текст в layoutBounds.** `visit()` (`src/capture/geometry.mjs:328-399`) дополнительно обходит текстовые узлы in-flow элементов: для каждого непустого (trimmed) текстового ребёнка — union client rects через `Range.getClientRects()`. Элементы `display:contents` перестают терять свой текст. `isHidden`-фильтр действует как раньше.

**T2b. Clip-aware union.** Механизм — **новый, нисходящий** (триаж M4; `clipChain` — восходящая диагностика от маркера, клипающий контейнер-потомок она не видит, а её флаг `effective` вычисляется из `painted` — циклическая зависимость при фильтрации): `visit()` несёт вниз стек clip-прямоугольников предков **внутри поддерева** (элементы с `overflow:hidden|clip`/`clip-path`, встреченные по пути от маркера); бокс каждого узла и его текстовых узлов пересекается с этим стеком до union. `clipChain` остаётся отдельной восходящей структурой для политики. Suggest даёт `350×40` с сохранённым clip.

**Инвалидация:** `GEOMETRY_CONTRACT_VERSION = 2` как кадровый вход (§1.3). Дифференциальный тест на frame_fingerprint; `GOLDEN_FRAME` обновляется одним осознанным коммитом с обоснованием; пин `CASE_FINGERPRINT_ALGO_VERSION` остаётся `7` (тест не трогается — триаж M6).

**Файлы:** `src/capture/geometry.mjs` (один владелец), `server/acceptance/ids.ts` (константа внутри `frameFingerprint`, conditional spread), `server/acceptance/ids.test.ts` (golden + ручная сборка входа `:234-238` — оба обновляются осознанно), тесты geometry, фикстуры (display:contents-текст; клипнутая карусель), `docs/server-api.md`.

**Риски:** whitespace-узлы — фильтр по trimmed-тексту; рост layoutBounds у кейсов с выступающим текстом — by design, в changelog; корпус детерминизма (12×20) после правки.

**Done:** T2-0-отчёт с названным местом потери; юнит-тесты обеих семантик; корпус детерминизма 0 mismatches; дифференциальный fingerprint-тест; фикстуры дают ожидаемые размеры; деплой только вместе с W3.

### W2-audit. Инвентаризация существующих case-sets (триаж S7, F8)

Скрипт `scripts/audit-geometry-contract.mjs`: перечисляет case-sets с `expectedGeometry`/`referenceSurface:"content-hug"`, прогоняет измерение на новой семантике (dev, dry-run) и печатает дельты layoutBounds по кейсам. Прогон на прод-данных (read-only, через бэкап/копию БД) — **до** деплоя W2+W3; по каждому семейству с дельтой — решение: перевыпуск манифеста (новый `cset_` id, `tolerancePx`/пересъёмка эталонов) силами координатора, список — в changelog. План не берёт на себя автоматическую миграцию манифестов (контентная адресация делает её невозможной by design) — только инструмент и список.

### W3. Per-case geometry-допуски и overflow-бюджет (строки 6, 8)

**Контракт** — оба поля в `caseSetCasePolicySchema` (`policy.perCase` — это `z.record(caseId, caseSetCasePolicySchema)`; триаж B2/M8/F2 — внутрь `expectedGeometry` не лезем, он comparison-слой и источник padTo):

- `sizeDeltaPx?: int 0..64` — per-case допуск |Δw|,|Δh| к `expectedGeometry`; побеждает `policy.geometry.sizeDeltaPx` профиля. Имя — по существующей семантике `sizeTolerancePx`/`geometry.sizeDeltaPx` (не «tolerancePx», занято смыслом per-side).
- `overflowBudgetPx?: {top?, right?, bottom?, left?} (0..256)` — декларативный допуск paint-overflow по сторонам: overflow стороны ≤ бюджета → pass; больше → блокирующий. `allowPaintOverflow` сохраняется; одновременное задание — 422 `case_policy_conflict`.

Оба — строго `.optional()` без `.default()`.

**Проброс (7 точек, триаж M8/F3 + V7):** (1) `VerdictPolicySnapshot.perCase` (`server/acceptance/ids.ts`, литеральный тип; узкие литеральные типы `casePolicy` в `cases.ts:101` и `ids.ts:302` расширяются — runtime-spread уже тотальный); (2) `VerdictPolicyField` + `verdictPolicyDelta` + `GATES_BY_POLICY_FIELD` (`server/acceptance/recompute.ts:51-105`); (3) построение `tolerances` в `recomputeGeometry`; (4) `geometryTolerancesOf` (`server/acceptance/gates/geometry2.ts:46-56`) — per-case поверх профиля; (5) `evaluateGeometryPolicy` (`src/capture/geometryPolicy.ts`) — `sizeTolerancePx` per-case при наличии, **вердикт-классы сохраняются в фактах** (бюджет не превращает overflow в `clean`); (6) `geometryVerdictBlocks` и `geometryCodes` расширяются величинами overflow по сторонам (сигнатура вида `blocks(verdict, overflow, tolerances)`) — иначе per-side бюджет невыразим; (7) **оба** call-site: `gates/geometry2.ts` и `recompute.ts:245-251`. `FIELD_LAYERS` не расширяется точечно — per-case поля идут через verdictPolicy-контур.

**Драйвер (§1.5):** три копии + лимиты в capabilities.

**Done:** юнит-тесты политики (внутри/на границе/за бюджетом; конфликт полей); регресс-тест «новые поля не меняют `comparisonFingerprint`»; recompute-тест «смена `overflowBudgetPx` → пересчёт без recapture» (verdict-контур); существующие манифесты — байт-в-байт те же `cset_` id и вердикты; драйвер принимает новые поля.

### W4. Comparison matte + пресет live-text (строки 5, 7)

**T4a. Matte.** Схема case: `comparison?: { matte?: "none" | "#RRGGBB" }` (`.optional()`, default-семантика «none» у потребителя). visual-diff-worker компонует обе картинки над цветом (straight-alpha over) после placement/pad, до метрик; альфа после matte = 255. Порядок: crop → place/pad → matte → метрики.

**T4b. Пресет `live-text-v1`.** Двухходовка:
1. Edge-сигнал в acceptance: `server/acceptance/gates/visual.ts` передаёт воркеру `edge: true` (опция, не env), кладёт `edgeResidual` в метрики гейта и в `causeInputOf` (`server/acceptance/runner.ts:261-303`) — классификатор `text-raster-residual` работает по маске.
2. Поле `policy.perCase.textAaBudget?: "live-text-v1"` — именованный пресет (§1.2): сервер владеет порогами (`maxRawDiffPct` ≤ 0.75, `minEdgeResidualPct` 95 — стартовые из калибровки T=95 R7a; уточняются на реальном Timer до фиксации, изменение = новый пресет). Вердикт: `rawDiffPct ≤ пресет` **и** `edgeResidual.insidePct ≥ пресет` → visual pass, факт применения пресета — в метриках гейта (не в causes — их контракт «только fail/indeterminate» не трогаем).

**Инвалидация (триаж F4 + V5 + V6):** оба поля — на уровне кейса (`caseSetCaseSchema.comparison`, `caseSetCaseSchema.textAaBudget` — не в policy.perCase), слой **comparison** (`matte` меняет входы сравнения; `textAaBudget` требует `edgeResidual`, которого нет в старых метриках, — comparison-каскад честно даёт re-diff сохранённых paint.png, где edge считается заново). Декларации FIELD_LAYERS **недостаточно** — полный проброс по 6 точкам: (1) `ComparisonFingerprintInput` (`ids.ts:229-243`); (2) `comparisonFingerprintOf` (`ids.ts:248-265`); (3) conditional spread в `caseFingerprintsOf` (`ids.ts:384-393`); (4) `CaseFingerprintCase` (`ids.ts:296-315`); (5) маппинг манифест→кейс `buildCasesFromManifest` (`caseSets.ts:818-830`) + тип `AcceptanceCase` (`cases.ts:76-145`); (6) FIELD_LAYERS (`comparison`→comparison, `textAaBudget`→comparison+verdict). Дифференциальный тест — на уровне `caseFingerprintsOf` (не FIELD_LAYERS): добавление поля к кейсу меняет `comparisonFingerprint` при неизменном frame.

Кроме того (V6): `textAaBudget` входит в `VerdictPolicySnapshot` (+`VerdictPolicyField`, `verdictPolicyDelta`, `GATES_BY_POLICY_FIELD: ["visual"]`), а `recomputeVisual` (`recompute.ts:149-201`) учитывает пресет; если в сохранённых метриках нет `edgeResidual` — явный `refuse` (каскад уходит в re-diff), не тихий пересчёт без пресета.

**Драйвер (§1.5):** три копии + capabilities.

**Файлы:** `scripts/visual-diff-worker.mjs`, `server/visual/diff-runner.ts` (тип `NormalizedDiffJob.options.edge` + комментарий про `edgeResidual` — V12), `server/acceptance/gates/visual.ts`, `server/acceptance/runner.ts` (`causeInputOf`), `server/visual/causes.ts` (порог из пресета, если задан), `src/acceptance/caseSetSchema.ts`, `server/acceptance/ids.ts`, `server/acceptance/cases.ts`, `server/acceptance/caseSets.ts`, `server/acceptance/recompute.ts`, `server/contracts.ts`, `docs/server-api.md`.

**Риски:** edge-опция добавляет ключи метрик всем новым диффам — вердикт без `textAaBudget` не меняется (тест); стоимость Sobel — замер (<10% ожидание).

**Done:** юнит-тесты воркера (matte over opaque/semi-transparent, идемпотентность); интеграционный «прозрачный кандидат + opaque эталон + matte → pass»; тест пресета (глиф-AA проходит, перекраска блока — нет); re-diff-тест; существующие вердикты неизменны; драйвер принимает поля.

### W5. Overlay inset + scroll ownership (строка 10)

**T5a. Контракт Overlay v2** (`src/catalog/hostPrimitives/overlay.definition.ts`, `Overlay.tsx`):
- Все placement-ветки получают `maxHeight: calc(100% - <вертикальные insets>)`.
- Новый prop `scroll: z.boolean().default(false)`: true → контентная обёртка `overflow-y:auto; overscroll-behavior:contain`; false → `overflow:hidden` (clip; изменение против текущего вытекания — единственное живое употребление Overlay на проде — hug-sheet ниже вьюпорта, не затронут; аудит на прод-данных перед деплоем).
- Truth table в `docs/prototype-format.md` дополняется высотным инвариантом.

**T5b. Composition v3 layout-токены** (`src/prototype/compositionV3/layout.ts`): `sizing.maxHeight?: "viewport"` (компилируется в `maxHeight:100%` от stage-контейнера, без window/DOM measurement — граница §19 сохранена) и `scroll?: boolean`. Обновить `COMPOSITION_LAYOUT_PROPS`, `layoutSupportIssues`, контракты/доки.

**T5c. Capture-поверхность `capture.surface:"viewport"` + контракт измерения overlay (триаж S2 blocker, S3, M9/F5; переписан по V1–V4, V10, V14).**

1. *Поверхность (V2).* `capture.surface?: "hug" | "viewport"` в case-set. `#eui-capture-surface` **остаётся внешним padded-элементом** (кадр — element-screenshot именно его; системы координат ink-bbox и layoutBounds завязаны на него — не переносить id). При `"viewport"` внутрь него добавляется **новый вложенный узел** точного размера `capture.viewport` (`position:relative`) — он же stage host для `HostStageSurface` (Overlay рендерится); паддинг-маргин остаётся на внешнем элементе → общий кадр = `(viewport + 2×margin)×dsf`, краска прижатого шита не касается границы кадра (S3). Тест: размер PNG viewport-кейса ровно `(viewport + 2×margin)×dsf`.
2. *Кадровый хеш (V10).* Поле проводится в `CaseSurface` (`ids.ts:152-156`), `surfaceOfManifest` (`caseSets.ts:74-79`), `FIELD_LAYERS` (`surface.*`, иначе тест тотальности не соберётся) — conditional spread, отсутствие = hug, хеши существующих кейсов не сдвигаются.
3. *Измерение (V3, V14).* Контентная обёртка Overlay **уже несёт** `data-eui-overlay-content` (`Overlay.tsx:31`) — атрибут объявляется стабильным контрактом и покрывается тестом. При `surface:"viewport"` geometry-сбор использует ветку «overlay-aware root» (едет по существующему пути опций `geometryDetailKeys`: `service.ts:1074` → `gates/capture.ts:151`): если в поверхности ровно один `[data-eui-overlay-content]` — он становится layout root, причём **его собственные `position:absolute`/`transform` корень не дисквалифицируют** (visit стартует с `inFlow=true` на корне; out-of-flow/transform фильтруются только у потомков; `effectSources` для корня пишутся как обычно) — иначе union даст null (V3). `expectedGeometry` кейса описывает бокс контента оверлея. Popup-hug остаётся на `surface:"hug"` без Overlay. Юнит-тесты: `placement:"center"` (transform) и `"bottom"` (absolute).
4. *Scrim (V4).* Scrim рисует весь stage → ink-bbox покрывает viewport и геометрия честно даст paint-overflow. Geometry-кейсы шеллов снимаются со `scrim:false` (контракт измеряет контент-бокс); scrim-варианты — предмет visual-кейсов либо объявляют `allowPaintOverflow`/`overflowBudgetPx`. Это ограничение фиксируется в `docs/server-api.md`.
5. *Сравнение (V1).* Для `surface:"viewport"` — **своя формула канвы**: `padTo = (viewport + 2×margin)×dsf`, `placement = margin×dsf + offset(layout root внутри viewport)`; `layoutRoot` остаётся входом только вердикта геометрии. Ветка `referenceCanvasOf` (`gates/visual.ts:99-134`) расширяется на viewport-поверхность **независимо от** `referenceSurface`; неразрешимый root → `indeterminate reference_canvas_unresolved` (тест — M9/F5), сводимость размеров гарантируется формулой (тест «viewport-кейс + эталон → осмысленная канва, не `dimensions_irreconcilable`»).
6. *Проброс до браузера:* `server/acceptance/gates/capture.ts` → `server/screenshot/service.ts` (bootstrap-поле) → `src/capture/protocol.ts` → `scripts/screenshot-worker.mjs` + `screenshot-pool-worker.mjs` (echo) → `src/capture/CaptureComponent.tsx`; geometry-ветка — `src/capture/geometry.mjs` (после W2, см. сериализацию §2).

**Драйвер (§1.5):** три копии + capabilities.

**Done:** DOM-тесты Overlay (maxHeight все 7 placement, scroll/clip, стабильность `data-eui-overlay-content`); e2e 4 shells — fixed-sheet, fixed-popup, popup-hug (hug-поверхность), scroll-sheet (viewport-поверхность), все со `scrim:false`: ненулевой layoutBounds и geometry pass у каждого; тест размера кадра `(viewport+2×margin)×dsf`; тест канвы сравнения; юнит-тесты overlay-root (center/bottom); composition-токены компилируются и линтуются; verify зелёный.

### W6. Nested slotBindings (строка 1)

**Контракт схемы** (`src/acceptance/caseSetSchema.ts`): `caseSetSlotChildSchema` получает рекурсивное опциональное поле `slotBindings` (`z.lazy`; рекурсивный тип аннотируется вручную — `z.strictObject`+`z.lazy` теряет инференс, экспортируемый `CaseSetSlotChild` объявляется явно; прецедент `z.lazy` с `z.ZodType` — `server/contracts.ts:1392-1393`, OpenAPI-генератор переживает цикл через `$defs`/`$ref` — V13). Лимиты (триаж B1/F7 — существующие смыслы не меняются): `CASE_SET_MAX_SLOT_CHILDREN = 12` **остаётся per-slot**; новые константы `CASE_SET_MAX_SLOT_DEPTH = 3` (уровней от корня кейса) и `CASE_SET_MAX_SLOT_NODES = 96` — тотал по дереву **равен** сегодняшнему максимуму 8×12, поэтому проверка строго `≤` (V13; иначе граничный широкий манифест перестанет читаться). Ключ `default` работает на любом уровне с exempt-семантикой.

**Валидация** (`server/acceptance/caseSets.ts`, grep только `-a` — NUL в `:259`): `validateSlotBindings` рекурсивен; membership/namedSlots вложенных детей — по `definitionMeta` их родителя (`PublishedSlotPin.definitionMeta` уже читается); коды `slot_*` получают path; `slot_self_reference` — цикл по всему пути; новые коды `slot_depth_exceeded`, `slot_nodes_exceeded`.

**Хеши:** `slotsHashOf` и `FrameSlotBinding` — поле `children?` через conditional spread (`definedOnly`): depth-1 наборы дают байт-в-байт прежние slots_hash и frame-хеши; `GOLDEN_FRAME` в этой волне не трогается (если W6 едет после W2 — golden уже v2-семантики, тест «depth-1 хеши не сдвигаются волной W6» обязателен). ALGO не бампается.

**Капчур:** `slotCaptureOf` (`server/screenshot/service.ts:866-891`) — `tree[]` с `children?: number[]` (индексы), дедуп бандлов по (componentId, version) по всему дереву; `draftComponentAllowedUrls` — URL всех уровней; `captureRuntimeTree` (`src/capture/CaptureComponent.tsx:82-99`) строит вложенный runtimeSpec. Протокол/воркер — аддитивные поля.

**Драйвер (§1.5):** три копии (локальный валидатор `slotBindingIssues` — `.claude/skills/author/driver.mjs:2737-2775` и зеркала — вложенность + новые лимиты), `caseSetMaxSlotDepth`/`caseSetMaxSlotNodes` в `/api/capabilities.limits`, `server/driver-mjs.d.ts` при новых экспортах.

**Done:** e2e «parent candidate → published child → published кнопка во вложенном слоте» — кадр содержит контент кнопки; юнит: depth-1 манифест — прежний slots_hash; **тест «манифест 8 слотов × 12 детей, записанный до волны, читается `manifestOfRow` без ошибки»** (B1); 422 на глубину/тотал/цикл; замер стоимости depth-3 (R4); `docs/server-api.md` §slotBindings обновлён.

### W7. Capabilities, changelog, финальная верификация

- `/api/capabilities`: `features.figmaMultiSource`, `features.geometryContractV2` (+ `acceptance.geometryContractVersion: 2`), `features.geometryCaseTolerances`, `features.comparisonMatte`, `features.textAaPresets: ["live-text-v1"]`, `features.overlayScrollOwnership`, `features.captureViewportSurface`, `features.nestedSlotBindings`; `limits.caseSetMaxSlotDepth/…SlotNodes` и прочие новые лимиты.
- Changelog в `docs/server-api.md`: абзац на capability + явный пункт об отказе по строке 2 (§1.1) с формулировкой обхода.
- Прогон W2-audit на прод-данных, список семейств на перевыпуск.
- Финальная верификация: `npm run verify` + `npm run e2e` + runtime-прогон `/verify`; корпус детерминизма; замер edge-стоимости; прогон одной прод-семьи до/после (F8).

## 3. Инварианты (проверяются на ревью каждой волны)

1. Новые поля манифеста — строго `.optional()` без `.default()` (контентная адресация `cset_`).
2. Conditional spread/`definedOnly` для всех новых fingerprint-входов; slot-free и depth-1 кейсы дают прежние хеши. Единственный санкционированный сдвиг golden — W2 (`geometryContractVersion`), с дифференциальным тестом. `CASE_FINGERPRINT_ALGO_VERSION` остаётся 7.
3. Слои каскада: per-case вердиктные ручки — через verdictPolicy-контур (5 точек, §W3); comparison-поля — re-diff; frame-поля — recapture. Для каждого нового поля — тест каскада.
4. `scripts/check-provenance-resolver.ts` — пины при любом касании `figma_json`.
5. Капчур-фон прозрачный; matte — только на сравнении.
6. Существующие манифесты/вердикты без новых полей не меняются: в каждой волне регресс-тесты на `cset_` id, `comparisonFingerprint`, читаемость старых манифестов.
7. `server/acceptance/caseSets.ts` — только `grep -a` (NUL в `:259`).
8. Драйвер: три копии + `driver-mjs.d.ts` + capabilities.limits — в той же волне, что и правка схемы (§1.5).
9. Сборка на прод-сервере запрещена; деплой — `/deploy` по явной команде пользователя; W2+W3 — один деплой.

## 4. Риски

- **R1 (W2/W3):** окно ложных fail закрыто инвариантом «один деплой» + W2-audit до деплоя.
- **R2 (W4):** пороги `live-text-v1` фиксируются после прогона на реальном Timer-подобном кейсе; изменение — новым пресетом.
- **R3 (W5):** clip при переполнении Overlay — поведенческое изменение; аудит употреблений на проде перед деплоем.
- **R4 (W6):** стоимость depth-3 — замер (база 2026-08-05: 12 и 24 ребёнка ≈3.7 с, кривая плоская).
- **R5:** `caseSetSchema.ts` (W3/W4/W5/W6) и `ids.ts` (W2/W3/W4/W5) — по одной волне за раз, оркестратор сериализует.
- **R6 (W2):** T2-0 может показать иное место потери текста — стоп-точка с пересмотром T2a/инвалидации.

## 5. Триаж адверсариального ревью (раунд 1: 3 линзы, 22 подтверждённые находки, 3 опровергнуты верификаторами)

Принято (вошло в v2): **B1/F7** (лимиты слотов — отдельные константы, старые смыслы нетронуты, тест читаемости широких манифестов — §W6); **B2/M8/F2/F3** (per-case допуски — в `caseSetCasePolicySchema` через verdictPolicy-контур, 5 точек проброса, имя `sizeDeltaPx` — §W3); **M4** (нисходящий clip-стек вместо «той же логики clipChain» — §W2 T2b); **M6+F1** (инвалидация через `geometryContractVersion` как кадровый вход; golden сдвигается один раз осознанно; ALGO остаётся 7 — §1.3); **M7** (диагностика-сначала T2-0 — §W2); **M9/F5/S3/S2** (полный контракт viewport-поверхности: наружный маргин, overlay-aware root по `data-eui-overlay-content`, канва от корректного root, e2e на 4 shells — §W5 T5c); **S4** (строка 2 — осознанный отказ, зафиксирован в §0/§1.1/changelog); **S5** (textAaBudget — именованный пресет, свободные числа отклонены — §1.2); **S6/F6** (драйвер — под-задача каждой волны — §1.5); **S7/F8** (W2-audit + инвариант одного деплоя — §W2-audit, §3.9); **S8** (`sourceCount` в проекции — §W1); **F4** (textAaBudget/comparison-слой, т.к. fallback recompute→re-diff в каскаде отсутствует — §W4).

Отклонено (с обоснованием верификаторов): **B3** (утверждение «HostStageSurface не монтирует ни один капчур» опровергнуто — CapturePrototype монтирует; W5 добавляет паритет компонентному пути); **M5** (пресет фиксируется в метриках гейта, контракт causes «только fail/indeterminate» не нарушается — уточнено в §W4); **S1** (утверждение «текст теряется в растре, а не в layoutBounds» не подтверждено кодом; вопрос закрывается T2-0 диагностикой).

**Раунд 2 (дельта-ревью v2, находки V1–V14) — все приняты в v3:** **V1** (своя формула канвы для viewport-поверхности + расширение ветки `referenceCanvasOf` независимо от referenceSurface — §W5 T5c.5); **V2** (`#eui-capture-surface` остаётся внешним padded-элементом, внутренний бокс — новый узел — §W5 T5c.1); **V3** (собственные position/transform overlay-root не дисквалифицируют корень — §W5 T5c.3); **V4** (geometry-кейсы шеллов со `scrim:false`, scrim — visual/бюджет — §W5 T5c.4); **V5** (инвалидация W4 — 6 точек до `comparisonFingerprint`, дифференциальный тест на `caseFingerprintsOf` — §W4); **V6** (`textAaBudget` в `VerdictPolicySnapshot` + `recomputeVisual` с явным refuse без `edgeResidual` — §W4); **V7** (7 точек W3, `geometryVerdictBlocks`/`geometryCodes` с величинами overflow — §W3); **V8** (константа внутри `frameFingerprint`, golden двигается, `ids.test.ts:234-238` — §1.3/§W2); **V9** (подтверждение выбора отдельного кадрового поля); **V10** (`capture.surface` → CaseSurface/surfaceOfManifest/FIELD_LAYERS; geometry.mjs в файлах W5 — §W5 T5c.2/6); **V11** (сериализация geometry.mjs/caseSets.ts/cases.ts, W5 после W2 — §2); **V12** (`diff-runner.ts` в файлах W4); **V13** (лимит 96 строго `≤`, ручная аннотация рекурсивного типа, `slotBindingIssues` драйвера — §W6); **V14** (`data-eui-overlay-content` уже существует — контракт стабильности вместо «выдачи» — §W5 T5c.3).

После v3 blocking-возражений не осталось (вердикт раунда 2 закрыт правками §W5 T5c и §W4). Раунд 3 — точечная верификация переписанных §W5 T5c/§W4 перед стартом их волн (не блокирует W1/W6/W2/W3).
