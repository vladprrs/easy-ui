# Платформенные capabilities по фидбэку feedback-3 (v2)

**Дата:** 2026-08-06 · **Источник:** `docs/feedback-3.md` (10 строк-требований от разработчиков renderer/acceptance/Composition v3/Overlay; ссылки 3.x/5.x/D.x — на внешний отчёт миграции, в репо его нет, таблица самодостаточна).
**Статус:** v2 — после Stage 2 (раунд 1: 3 линзы + адверсариальная верификация, 22 подтверждённые находки; триаж — §5).

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

- В `FrameFingerprintInput` добавляется `geometryContractVersion` (константа `GEOMETRY_CONTRACT_VERSION = 2` рядом с семантикой `geometry.mjs`), через conditional spread `...(v > 1 ? {geometryContractVersion: v} : {})` — форма прообраза для гипотетического v1 не меняется, но фактически все новые fingerprints включают поле → все старые кадры честно инвалидируются (полная пересъёмка, это цель).
- Golden `GOLDEN_FRAME` (`f29b0c49…`) при этом сдвигается — **единственный санкционированный сдвиг**, в паре с дифференциальным тестом «смена GEOMETRY_CONTRACT_VERSION ⇒ другой frame_fingerprint» (триаж M6 + F1). ALGO не бампается (он про состав/форму case_fingerprint, форма не меняется).
- Прод-последствие: полная пересъёмка затронутых наборов при первом ране (честная стоимость; RECOMPUTE-каскад не участвует — frame-слой).

### 1.4. Matte (строка 7): декларативный контракт сравнения, без изменения капчура

Капчур остаётся прозрачным (`omitBackground:true` — frame-слой, не трогаем). Matte применяется **только при сравнении** в visual-diff-worker: обе картинки компонуются над объявленным цветом после placement/pad, до метрик. Один flatten, без повторного crop. Поле — comparison-слой → каскад re-diff сохранённых paint.png без пересъёмки.

### 1.5. Сквозное правило: локальный валидатор драйвера — гейт каждой волны схемы

`driver.mjs` несёт **собственный** локальный валидатор манифеста (закрытые allowlist'ы и лимиты, включая локальный `caseSetIdOfManifest`, `driver.mjs:2879`), копий три (`.claude/skills/author/driver.mjs`, `share/easy-ui-authoring-skill/`, `share/yp-figma-rebuild-skill/`). Любое новое поле манифеста без правки драйвера делает легальный манифест неотправляемым (отказ до сети). Поэтому **каждая волна W3/W4/W5/W6 включает под-задачу**: правка трёх копий драйвера + `server/driver-mjs.d.ts` (при новых экспортах) + публикация новых лимитов в `/api/capabilities.limits` + тест «драйвер локально принимает манифест с новым полем» (триаж S6/F6).

## 2. Пакеты работ

Порядок: W1 ∥ W5 ∥ W6 (не пересекаются) → W2 → W3 → W4 → W7. **Жёсткий инвариант деплоя: W2 и W3 едут одним деплоем** (иначе окно ложных fail на кейсах с точным `expectedGeometry` — триаж F8/R1). Файлы `caseSetSchema.ts` и `ids.ts` правит только одна волна за раз; оркестратор сериализует.

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

**Файлы:** `src/capture/geometry.mjs` (один владелец), `server/acceptance/ids.ts` (`geometryContractVersion` в FrameFingerprintInput, conditional spread), тесты geometry + ids, фикстуры (display:contents-текст; клипнутая карусель), `docs/server-api.md`.

**Риски:** whitespace-узлы — фильтр по trimmed-тексту; рост layoutBounds у кейсов с выступающим текстом — by design, в changelog; корпус детерминизма (12×20) после правки.

**Done:** T2-0-отчёт с названным местом потери; юнит-тесты обеих семантик; корпус детерминизма 0 mismatches; дифференциальный fingerprint-тест; фикстуры дают ожидаемые размеры; деплой только вместе с W3.

### W2-audit. Инвентаризация существующих case-sets (триаж S7, F8)

Скрипт `scripts/audit-geometry-contract.mjs`: перечисляет case-sets с `expectedGeometry`/`referenceSurface:"content-hug"`, прогоняет измерение на новой семантике (dev, dry-run) и печатает дельты layoutBounds по кейсам. Прогон на прод-данных (read-only, через бэкап/копию БД) — **до** деплоя W2+W3; по каждому семейству с дельтой — решение: перевыпуск манифеста (новый `cset_` id, `tolerancePx`/пересъёмка эталонов) силами координатора, список — в changelog. План не берёт на себя автоматическую миграцию манифестов (контентная адресация делает её невозможной by design) — только инструмент и список.

### W3. Per-case geometry-допуски и overflow-бюджет (строки 6, 8)

**Контракт** — оба поля в `caseSetCasePolicySchema` (`policy.perCase` — это `z.record(caseId, caseSetCasePolicySchema)`; триаж B2/M8/F2 — внутрь `expectedGeometry` не лезем, он comparison-слой и источник padTo):

- `sizeDeltaPx?: int 0..64` — per-case допуск |Δw|,|Δh| к `expectedGeometry`; побеждает `policy.geometry.sizeDeltaPx` профиля. Имя — по существующей семантике `sizeTolerancePx`/`geometry.sizeDeltaPx` (не «tolerancePx», занято смыслом per-side).
- `overflowBudgetPx?: {top?, right?, bottom?, left?} (0..256)` — декларативный допуск paint-overflow по сторонам: overflow стороны ≤ бюджета → pass; больше → блокирующий. `allowPaintOverflow` сохраняется; одновременное задание — 422 `case_policy_conflict`.

Оба — строго `.optional()` без `.default()`.

**Проброс (все 5 точек, триаж M8/F3):** `VerdictPolicySnapshot.perCase` (`server/acceptance/ids.ts`, литеральный тип), `VerdictPolicyField` + `verdictPolicyDelta` + `GATES_BY_POLICY_FIELD` (`server/acceptance/recompute.ts:51-105`), построение `tolerances` в `recomputeGeometry`; `FIELD_LAYERS` не расширяется точечно — per-case поля идут через verdictPolicy-контур (в плане это явная замена формулировке v1 «добавить в FIELD_LAYERS»); `geometryTolerancesOf` (`server/acceptance/gates/geometry2.ts:46-56`) читает per-case поверх профиля.

**Политика:** `src/capture/geometryPolicy.ts` — `sizeTolerancePx` берётся per-case при наличии; overflow сверяется с бюджетом по сторонам (вердикт-классы сохраняются в фактах).

**Драйвер (§1.5):** три копии + лимиты в capabilities.

**Done:** юнит-тесты политики (внутри/на границе/за бюджетом; конфликт полей); регресс-тест «новые поля не меняют `comparisonFingerprint`»; recompute-тест «смена `overflowBudgetPx` → пересчёт без recapture» (verdict-контур); существующие манифесты — байт-в-байт те же `cset_` id и вердикты; драйвер принимает новые поля.

### W4. Comparison matte + пресет live-text (строки 5, 7)

**T4a. Matte.** Схема case: `comparison?: { matte?: "none" | "#RRGGBB" }` (`.optional()`, default-семантика «none» у потребителя). visual-diff-worker компонует обе картинки над цветом (straight-alpha over) после placement/pad, до метрик; альфа после matte = 255. Порядок: crop → place/pad → matte → метрики.

**T4b. Пресет `live-text-v1`.** Двухходовка:
1. Edge-сигнал в acceptance: `server/acceptance/gates/visual.ts` передаёт воркеру `edge: true` (опция, не env), кладёт `edgeResidual` в метрики гейта и в `causeInputOf` (`server/acceptance/runner.ts:261-303`) — классификатор `text-raster-residual` работает по маске.
2. Поле `policy.perCase.textAaBudget?: "live-text-v1"` — именованный пресет (§1.2): сервер владеет порогами (`maxRawDiffPct` ≤ 0.75, `minEdgeResidualPct` 95 — стартовые из калибровки T=95 R7a; уточняются на реальном Timer до фиксации, изменение = новый пресет). Вердикт: `rawDiffPct ≤ пресет` **и** `edgeResidual.insidePct ≥ пресет` → visual pass, факт применения пресета — в метриках гейта (не в causes — их контракт «только fail/indeterminate» не трогаем).

**Инвалидация (триаж F4):** оба поля — **comparison-слой** (`matte` меняет входы сравнения; `textAaBudget` требует `edgeResidual`, которого нет в старых метриках — recompute невозможен, а fallback recompute→re-diff в каскаде отсутствует; comparison честно даёт re-diff сохранённых paint.png, где edge считается заново). FIELD_LAYERS: новые top-level поля кейса `comparison`, `textAaBudget`… — `textAaBudget` живёт в perCase → чтобы получить comparison-каскад, поле поднимается на уровень кейса: `caseSetCaseSchema.textAaBudget?: "live-text-v1"` (не в policy.perCase). Регресс-тест: манифест без новых полей → прежний `comparisonFingerprint`.

**Драйвер (§1.5):** три копии + capabilities.

**Файлы:** `scripts/visual-diff-worker.mjs`, `server/acceptance/gates/visual.ts`, `server/acceptance/runner.ts`, `server/visual/causes.ts` (порог из пресета, если задан), `src/acceptance/caseSetSchema.ts`, `server/acceptance/ids.ts` (FIELD_LAYERS: `comparison`→comparison, `textAaBudget`→comparison+verdict), `server/acceptance/recompute.ts`, `server/contracts.ts`, `docs/server-api.md`.

**Риски:** edge-опция добавляет ключи метрик всем новым диффам — вердикт без `textAaBudget` не меняется (тест); стоимость Sobel — замер (<10% ожидание).

**Done:** юнит-тесты воркера (matte over opaque/semi-transparent, идемпотентность); интеграционный «прозрачный кандидат + opaque эталон + matte → pass»; тест пресета (глиф-AA проходит, перекраска блока — нет); re-diff-тест; существующие вердикты неизменны; драйвер принимает поля.

### W5. Overlay inset + scroll ownership (строка 10)

**T5a. Контракт Overlay v2** (`src/catalog/hostPrimitives/overlay.definition.ts`, `Overlay.tsx`):
- Все placement-ветки получают `maxHeight: calc(100% - <вертикальные insets>)`.
- Новый prop `scroll: z.boolean().default(false)`: true → контентная обёртка `overflow-y:auto; overscroll-behavior:contain`; false → `overflow:hidden` (clip; изменение против текущего вытекания — единственное живое употребление Overlay на проде — hug-sheet ниже вьюпорта, не затронут; аудит на прод-данных перед деплоем).
- Truth table в `docs/prototype-format.md` дополняется высотным инвариантом.

**T5b. Composition v3 layout-токены** (`src/prototype/compositionV3/layout.ts`): `sizing.maxHeight?: "viewport"` (компилируется в `maxHeight:100%` от stage-контейнера, без window/DOM measurement — граница §19 сохранена) и `scroll?: boolean`. Обновить `COMPOSITION_LAYOUT_PROPS`, `layoutSupportIssues`, контракты/доки.

**T5c. Capture-поверхность `capture.surface:"viewport"` + контракт измерения overlay (триаж S2 blocker, S3, M9/F5).** Полный контракт, а не только монтаж:

1. *Поверхность.* `capture.surface?: "hug" | "viewport"` в case-set (frame-слой, conditional spread — отсутствие = hug, хеши существующих кейсов не сдвигаются). При `"viewport"`: `#eui-capture-surface` — внутренний бокс **точного размера `capture.viewport`** (не inline-block), а паддинг-поле маргина добавляется **снаружи** него (общий кадр = viewport + 2×margin) — краска прижатого к краю шита не касается границы кадра и не даёт `paintClamped` (S3). `CaptureComponent` монтирует `HostStageSurface` со stage host = внутренний бокс (паритет со сценой: Overlay рендерится).
2. *Измерение.* Контент Overlay портируется в stage host и лежит out-of-flow — текущий `detailOf` его не видит (S2). Контракт: контентная обёртка Overlay получает атрибут `data-eui-overlay-content`; при `surface:"viewport"` geometry-сбор для корневого маркера использует ветку «overlay-aware root»: если в поверхности ровно один `[data-eui-overlay-content]` — его бокс становится layout root (union его in-flow поддерева по обычным правилам + T2a/T2b), иначе — обычный корень. `expectedGeometry` кейса описывает бокс контента оверлея. Popup-hug остаётся на `surface:"hug"` без Overlay (компонент меряется как раньше).
3. *Сравнение.* Канва сравнения при `surface:"viewport"` строится от того же layout root («layout + 2×margin», формула не меняется — root теперь корректный); кейсы с эталоном при неразрешимом root — честный `indeterminate reference_canvas_unresolved`, не `dimensions_irreconcilable` (тест — M9/F5).
4. Проброс: `server/acceptance/gates/capture.ts` → `server/screenshot/service.ts` (bootstrap-поле) → `src/capture/protocol.ts` → `scripts/screenshot-worker.mjs` (echo) → `src/capture/CaptureComponent.tsx`.

**Драйвер (§1.5):** три копии + capabilities.

**Done:** DOM-тесты Overlay (maxHeight все 7 placement, scroll/clip); e2e 4 shells — fixed-sheet, fixed-popup, popup-hug (hug-поверхность), scroll-sheet (viewport-поверхность): ненулевой layoutBounds и geometry pass у каждого (переформулировка done по S2); тест «viewport-кейс + эталон → осмысленная канва»; тест отсутствия `paintClamped` на прижатом шите; composition-токены компилируются и линтуются; verify зелёный.

### W6. Nested slotBindings (строка 1)

**Контракт схемы** (`src/acceptance/caseSetSchema.ts`): `caseSetSlotChildSchema` получает рекурсивное опциональное поле `slotBindings` (`z.lazy`). Лимиты (триаж B1/F7 — существующие смыслы не меняются): `CASE_SET_MAX_SLOT_CHILDREN = 12` **остаётся per-slot**; новые константы `CASE_SET_MAX_SLOT_DEPTH = 3` (уровней от корня кейса) и `CASE_SET_MAX_SLOT_NODES = 96` (тотал по дереву, ≥ текущего максимума 8×12 — ни один легальный сегодня манифест не становится нечитаемым). Ключ `default` работает на любом уровне с exempt-семантикой.

**Валидация** (`server/acceptance/caseSets.ts`, grep только `-a` — NUL в `:259`): `validateSlotBindings` рекурсивен; membership/namedSlots вложенных детей — по `definitionMeta` их родителя (`PublishedSlotPin.definitionMeta` уже читается); коды `slot_*` получают path; `slot_self_reference` — цикл по всему пути; новые коды `slot_depth_exceeded`, `slot_nodes_exceeded`.

**Хеши:** `slotsHashOf` и `FrameSlotBinding` — поле `children?` через conditional spread (`definedOnly`): depth-1 наборы дают байт-в-байт прежние slots_hash и frame-хеши; `GOLDEN_FRAME` в этой волне не трогается (если W6 едет после W2 — golden уже v2-семантики, тест «depth-1 хеши не сдвигаются волной W6» обязателен). ALGO не бампается.

**Капчур:** `slotCaptureOf` (`server/screenshot/service.ts:866-891`) — `tree[]` с `children?: number[]` (индексы), дедуп бандлов по (componentId, version) по всему дереву; `draftComponentAllowedUrls` — URL всех уровней; `captureRuntimeTree` (`src/capture/CaptureComponent.tsx:82-99`) строит вложенный runtimeSpec. Протокол/воркер — аддитивные поля.

**Драйвер (§1.5):** три копии (локальный валидатор — вложенность + новые лимиты), `caseSetMaxSlotDepth`/`caseSetMaxSlotNodes` в `/api/capabilities.limits`, `server/driver-mjs.d.ts` при новых экспортах.

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

Открытых blocker-возражений не осталось: оба blocker'а (F1, S2) закрыты изменением механизма (§1.3, §W5 T5c) — это существенные правки, поэтому перед исполнением проводится **дельта-ревью** v2 (один верификационный ревьюер по дельте v1→v2).
