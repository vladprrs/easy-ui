# Платформенные capabilities по фидбэку feedback-3 (v1)

**Дата:** 2026-08-06 · **Источник:** `docs/feedback-3.md` (10 строк-требований от разработчиков renderer/acceptance/Composition v3/Overlay; ссылки 3.x/5.x/D.x — на внешний отчёт миграции, в репо его нет, таблица самодостаточна).
**Статус:** v1 — Stage 1, до адверсариального ревью.

Критерий из фидбэка: «для каждого platform fix достаточно новой capability/schema или renderer fingerprint и короткого changelog. Coordinator сам переиспользует сохранённые candidates/references и запускает только затронутые cases» — то есть каждый фикс обязан быть (а) декларативным (schema/capability), (б) корректно инвалидировать только затронутый слой fingerprint-каскада (frame / comparison / verdict).

## 0. Карта фидбэка → пакеты работ

| # | Требование фидбэка | Пакет | Слой инвалидации |
|---|---|---|---|
| 1 | Nested slot bindings (глубже 1 уровня) **либо** first-publish overlay | W6 | frame (только кейсы с вложенными слотами) |
| 2 | First-publish candidate overlay (fixture ссылается на unpublished candidate) | W6 (закрывается выбором nested slots — §1.1) | — |
| 3 | Multi-file Figma provenance | W1 | нет (metadata) |
| 4 | Paint extraction не теряет live text | W2 | frame (ALGO bump) |
| 5 | Canonical live-text raster policy (scoped AA budget) | W4 | comparison + verdict |
| 6 | Intentional paint overflow (декларативный budget) | W3 | verdict (recompute) |
| 7 | Comparison matte / transparent-root normalization | W4 | comparison (re-diff) |
| 8 | Geometry tolerances per-case | W3 | verdict (recompute) |
| 9 | Content-hug clipped carousel (clip-aware layout root) | W2 | frame (ALGO bump) |
| 10 | Overlay inset + modal scroll ownership | W5 | frame (только новые props/кейсы) |

## 1. Ключевые решения (обсуждать на ревью в первую очередь)

### 1.1. Строки 1–2: выбираем **nested slotBindings**, а не first-publish prototype overlay

Фидбэк явно даёт альтернативу («либо»). Аргументы за nested slots:

- Рантайм уже поддерживает произвольную глубину слотов (`src/prototype/runtimeSpec.ts:227-256`); depth-1 — ограничение контура case-set→капчур (`src/acceptance/caseSetSchema.ts:195-201` strictObject без поля детей; плоские `resolveSlotBindings`/`slotsHashOf`/`slotCaptureOf`/`CaptureComponent.captureRuntimeTree`), а не рендерера.
- Проверяемый результат строки 1 («Lead Block acceptance получает реальное содержимое вложенной кнопки») достигается компонентным acceptance-путём: unpublished parent **candidate** + опубликованные дети уже работают (Feature A 2026-08-05), не хватает только глубины.
- Проверяемый результат строки 2 («fixture с unpublished Lead Block рендерится без каталожной публикации») — это ровно component-candidate capture с slotBindings: кандидат не публикуется, кадры снимаются. Прототипный first-publish overlay упирается в фундамент: документ прототипа вообще не сохраняется с неопубликованным типом (`server/validation.ts:184-215`, `snapshotDefinitions` требует `component_publishes.status='active'` + серверная материализация из опубликованной ревизии). Обойти это — значит завести draft-документы прототипов с кандидатными пинами: отдельный большой проект с новой моделью данных, не оправданный, пока case-set-путь закрывает потребность.
- Решение плана 2026-08-05 («first-publish = Feature A», §B1) сохраняется; prototypeCandidateOverlay остаётся pin-swap-only. В `docs/server-api.md` это уже задокументировано (`:1327`, `:1352`) — оставляем, дополняем ссылкой на nested slots.

**Отвергнутая альтернатива:** first-publish prototype overlay (вставка кандидата в ревизию без пина). Причины: барьер `snapshotDefinitions` — инвариант целостности документов; вставка ломает `componentManifestHashOf`-handshake и allowlist-модель; ценность дублирует case-set-путь.

### 1.2. Строка 5 (Timer): выбираем **documented scoped profile**, а не общий renderer fingerprint эталона

В acceptance эталон — Figma-ассет из asset-store: у него нет и не может быть renderer fingerprint (`server/acceptance/gates/visual.ts:61-70`; сверка fingerprint существует только в visual-runs, `server/visual/service.ts:161-200`). «Один renderer/font fingerprint» для пары Figma-PNG ↔ живой капчур недостижим по построению. Реализуем вторую ветку фидбэка: компонентно-ограниченный AA-бюджет для live text, объявляемый в case-set и работающий на edge-маске (§W4).

### 1.3. Изменение семантики layoutBounds (строки 4 и 9) — один координированный ALGO bump 7→8

Обе правки (учёт текстовых узлов; clip-aware union) меняют результат измерения `layoutBounds`, от которого зависят geometry-вердикт и каноническая канва content-hug. Переиспользованный кадр хранит `geometry.json` со старой семантикой — reuse обязан инвалидироваться. Механизм: `CASE_FINGERPRINT_ALGO_VERSION` 7→8 (`server/acceptance/ids.ts:66`), обе правки едут **одной волной W2**, чтобы bump был один. Прод-последствие: первый ран после деплоя холодный (~6 с/case, замер 2026-08-04); `EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE=1` не спасает (frame-слой). Это осознанная цена; второй bump в других волнах запрещён (W3/W4 — verdict/comparison-слои, W6 — conditional spread без сдвига хешей slot-free кейсов).

### 1.4. Matte (строка 7): декларативный контракт сравнения, без изменения капчура

Капчур остаётся прозрачным (`omitBackground:true` — это frame-слой, не трогаем). Matte применяется **только при сравнении** в visual-diff-worker: обе картинки (нормализованный эталон и кандидат) компонуются над объявленным цветом до вычисления метрик. Один flatten, без повторного crop. Поле — comparison-слой fingerprint → каскад делает re-diff сохранённых paint.png без пересъёмки.

## 2. Пакеты работ

Порядок: W1 ∥ W5 ∥ W6 (не пересекаются) → W2 → W3 → W4 (W3/W4 зависят от полей схемы и recompute; W2 до W3, чтобы geometry-политика была одна на новой семантике). Финал — W7 (доки/capabilities/верификация). Каждый пакет — отдельные коммиты по зонам владения.

### W1. Multi-source Figma provenance (строка 3)

**Контракт.** `figmaSchema` (`server/figma.ts:12-18`) получает опциональное поле:

```ts
sources: z.array(z.strictObject({
  fileKey: <тот же regex>,
  nodeIds: z.array(nodeId).min(1).max(50),
  role: z.string().min(1).max(64).optional(), // "core" | "pay-app" | произвольная метка
})).min(1).max(8).optional()
```

Семантика: `fileKey`/`nodeIds` верхнего уровня — primary-документ (обратная совместимость, обязательность не меняется); `sources[]` — дополнительные источники lineage. Дубликат `fileKey` внутри `sources` и совпадение с primary — 422 `validation_failed` (issue с path). `referenceScreenshots` остаются общими.

**Файлы:** `server/figma.ts` (схема + refine на дубликаты), `server/contracts.ts` (`figmaResponseSchema` и все места включения), `server/openapi.json` (регенерация, drift-гейт), `server/components/validate.ts` (проходит автоматически — validateStoredFigma парсит той же схемой; добавить тест «PayCard extension с Core + Pay App» → 200), `scripts/check-provenance-resolver.ts` (обновить пины количества упоминаний), `src/api/client.ts` (тип), `src/app/strings/library.ts:137-138` + `server/routes/libraryCatalog.ts:113-120` (тултип: primary fileKey + `+N источников`; проекция каталога не расширяется — перф-путь), `docs/server-api.md` §Figma provenance, `.claude/skills/author/SKILL.md` + зеркала `share/*/SKILL.md` (формат JSON).

**Не делаем:** case-set `source` остаётся одиночным `{fileKey, componentSetNodeId?}` (провенанс продукта один; расширение не требуется фидбэком). `cropLineage` не трогаем. Миграций БД нет (`figma_json` — блоб). Драйвер не валидирует — правок в `driver.mjs` нет (только доки).

**Done:** тест validate принимает компонент с primary + 2 sources; 422 на дубликат fileKey; `npm run verify:provenance` зелёный; openapi без drift; существующие записи читаются без изменений.

### W2. Layout bounds v2: live text + clip-aware root (строки 4, 9)

Обе правки — в чистой функции `detailOf` (`src/capture/geometry.mjs:328-399`), юнит-тестируемой.

**T2a. Текст в layoutBounds.** `visit()` дополнительно обходит **текстовые узлы** in-flow элементов: для каждого непустого текстового ребёнка берётся `Range.getBoundingClientRect()` (union client rects через `Range.getClientRects()` для многострочных), координаты попадают в `boxes` наравне с border-box'ами. Элементы `display:contents` перестают «терять» свой текст (сейчас они не дают коробки, а их текстовые дети не обходятся вовсе). `isHidden`-фильтр действует как раньше (текст скрытого элемента не считается). Результат: канва content-hug и `expectedGeometry`-сверка перестают отрезать живые текстовые строки → Chart Info сохраняет обе строки (проверяемый результат строки 4).

**T2b. Clip-aware union.** При union'е коробка потомка пересекается с прямоугольниками **effective** clip-предков из его цепочки (та же логика, что `clipChain`, `geometry.mjs:366-392`, но применённая к каждому box до union). Скрытый overflow карусели больше не расширяет layout root → Suggest даёт ожидаемое `350×40` с сохранённым clip (строка 9). `effectSources`/`paintBounds` не меняются (ink-bbox по альфе как был). Поле `scroll` остаётся информационным.

**Инвалидация:** `CASE_FINGERPRINT_ALGO_VERSION` 7→8 (`server/acceptance/ids.ts:66`, история `:50-53` дополняется). Golden-тест frame-хеша обновляется осознанно (это и есть цель — старые кадры невалидны). Прод-чеклист деплоя: предупредить о холодном ране.

**Файлы:** `src/capture/geometry.mjs` (владелец — одна задача), `server/acceptance/ids.ts` (bump + история), тесты `src/capture/geometry*.test.*`, фикстуры с display:contents-текстом и клипнутой каруселью; `docs/server-api.md` (семантика layoutBounds).

**Риски:** (1) `Range.getClientRects` у пустых/whitespace-узлов — фильтровать по непустому trimmed-тексту; (2) рост layoutBounds у существующих кейсов, где текст выступал за родительские border-box'ы (line-height) — это by design фидбэка, но упомянуть в changelog; (3) детерминизм — прогнать корпус детерминизма (12×20) после правки.

**Done:** юнит-тесты обеих семантик; корпус детерминизма 0 mismatches; фикстура «текст в display:contents» даёт layoutBounds, включающий текст; фикстура «клипнутая карусель» даёт размер clip-рамки; ALGO=8, golden обновлён одним осознанным коммитом.

### W3. Per-case geometry-допуски и overflow-бюджет (строки 6, 8)

**Контракт схемы** (`src/acceptance/caseSetSchema.ts`, все поля строго `.optional()` без `.default()` — инвариант cset_):

- `expectedGeometry` расширяется полем `tolerancePx?: int 0..64` — per-case допуск на |Δw|,|Δh| вместо глобального `policy.geometry.sizeDeltaPx` (per-case побеждает профиль).
- `policy.perCase.overflowBudgetPx?: {top?, right?, bottom?, left?} (0..256)` — декларативный допуск paint-overflow по сторонам. Семантика: overflow стороны ≤ бюджета → не блокирует и вердикт остаётся `pass` (в отличие от blanket `allowPaintOverflow`, который глушит блокировку целиком); overflow > бюджета → блокирующий как раньше. `allowPaintOverflow` сохраняется (совместимость), при одновременном задании — 422 `case_policy_conflict`.

**Политика:** `src/capture/geometryPolicy.ts` — `evaluateGeometryPolicy` принимает новые допуски; `layout-overflow` перестаёт быть безусловно блокирующим только в пределах `tolerancePx` (сам вердикт-класс сохраняется в фактах). Payment Schedule описывает точный layout box (`expectedGeometry` + tolerancePx) и отдельно paint (`overflowBudgetPx`) — проверяемый результат строки 8; Image Loader chips объявляют edge-overflow бюджетом — строка 6.

**Инвалидация:** оба поля — verdict-слой (`server/acceptance/ids.ts` FIELD_LAYERS: `verdict`), добавить в recompute-список (`server/acceptance/recompute.ts:52-105`) → смена бюджета пересчитывает вердикт без пересъёмки.

**Файлы:** `src/acceptance/caseSetSchema.ts`, `src/capture/geometryPolicy.ts` (+юнит-тесты), `server/acceptance/gates/geometry2.ts` (`geometryTolerancesOf`), `server/acceptance/ids.ts` (FIELD_LAYERS, conditional spread — отсутствие поля не сдвигает существующие хеши), `server/acceptance/recompute.ts`, `server/acceptance/caseSets.ts` (валидация конфликта, warnings), `server/contracts.ts`, `docs/server-api.md`.

**Done:** юнит-тесты политики (внутри/на границе/за бюджетом; конфликт полей); recompute-тест «смена overflowBudgetPx → пересчёт без recapture»; существующие манифесты без новых полей дают байт-в-байт те же cset_ id и вердикты.

### W4. Comparison matte + scoped live-text AA budget (строки 5, 7)

**T4a. Matte.** Схема case: `comparison?: { matte?: "none" | "#RRGGBB" }` (default-семантика «none» у потребителя, не в схеме). При задании matte visual-diff-worker (`scripts/visual-diff-worker.mjs`) компонует **обе** картинки над цветом (straight-alpha over) после placement/pad, до всех метрик; альфа-канал после matte = 255 → `alphaDominantPct`-шум исчезает. Opaque Figma-leaf ↔ transparent candidate сравниваются в одной surface-семантике (строка 7: Arrow Button, Payment Schedule). Один flatten, crop не повторяется (порядок: crop → place/pad → matte → метрики).

**T4b. Scoped AA budget для live text.** Двухходовка:
1. Прокинуть edge-сигнал в acceptance: гейт `server/acceptance/gates/visual.ts` передаёт воркеру опцию `edge: true` (не env), кладёт `edgeResidual` в метрики гейта и в `causeInputOf` (`server/acceptance/runner.ts:261-303`) — классификатор `text-raster-residual` начинает работать по маске, а не по AA-эвристике.
2. Поле схемы `policy.perCase.textAaBudget?: { maxRawDiffPct: 0..5, minEdgeResidualPct?: int 80..100 (default-семантика 95 у потребителя) }`. Вердикт: если `rawDiffPct ≤ maxRawDiffPct` **и** `edgeResidual.insidePct ≥ minEdgeResidualPct` (расхождения сосредоточены на глифовых рёбрах эталона) → visual pass с зафиксированной причиной `text-raster-residual` в метриках. Это и есть «документированный scoped profile» (§1.2): бюджет объявляется per-case, área действия ограничена edge-маской. Timer проходит с ним; произвольная перекраска/сдвиг контента бюджетом не пролезает (расхождения вне маски).

**Инвалидация:** `comparison.matte` и `textAaBudget` — comparison/verdict-слои (FIELD_LAYERS: matte → `comparison` (меняет метрики) — каскад re-diff сохранённых paint.png; textAaBudget → `verdict` + требует `edgeResidual` в метриках: если метрики старые (без edge) — recompute невозможен, честный fallback re-diff). Прописать в `server/acceptance/recompute.ts`.

**Файлы:** `scripts/visual-diff-worker.mjs` (matte-композит; edge уже есть — включение по опции), `server/acceptance/gates/visual.ts`, `server/acceptance/runner.ts` (causeInput), `server/visual/causes.ts` (порог берётся из бюджета, если задан), `src/acceptance/caseSetSchema.ts`, `server/acceptance/ids.ts`, `server/acceptance/recompute.ts`, `server/contracts.ts`, `docs/server-api.md`.

**Риски:** включение edge-опции меняет состав метрик у **всех** новых диффов — метрики аддитивны (новые ключи), вердикт без textAaBudget не меняется (проверить тестом «старый манифест — тот же вердикт»); стоимость Sobel — замерить (в visual-runs уже живёт, ожидание <10% на дифф).

**Done:** юнит-тесты воркера (matte over opaque/semi-transparent; идемпотентность); интеграционный тест «прозрачный кандидат + opaque эталон + matte → identical»; тест textAaBudget (глиф-AA проходит, перекраска блока — нет); recompute/re-diff тесты; существующие вердикты без новых полей неизменны.

### W5. Overlay inset + scroll ownership (строка 10)

**T5a. Контракт Overlay v2** (`src/catalog/hostPrimitives/overlay.definition.ts`, `Overlay.tsx`):
- Все placement-ветки получают вертикальное ограничение: `maxHeight: calc(100% - <top inset> - <bottom inset>)` (для top/bottom — одиночный inset с соответствующей стороны + противоположный inset как отступ до края).
- Новый prop `scroll: z.boolean().default(false)`: при true контентная обёртка получает `overflow-y: auto; overscroll-behavior: contain`. При false поведение при переполнении — clip (`overflow: hidden`) — **изменение против текущего «вытекания»**; зафиксировать в truth table.
- Инвариант фидбэка «inset ограничивает hug content» выполняется для всех 7 placement.

**T5b. Composition v3 layout-токены** (`src/prototype/compositionV3/layout.ts`): `sizing.maxHeight?: "viewport"` (компилируется в `maxHeight: 100%` от stage-контейнера — без window/DOM measurement, граница §19 сохранена: скролл-позицией композиция не владеет, CSS-overflow — владеет) и `scroll?: boolean` (overflow-y auto). Обновить `COMPOSITION_LAYOUT_PROPS`, `layoutSupportIssues`, контракты/доки.

**T5c. Capture-поверхность для overlay/shell-кейсов.** Компонентный капчур сейчас (а) не монтирует `HostStageSurface` → Overlay = null, (б) surface всегда hug → viewport-aware max-height нечем мерить. Добавить в case-set `capture.surface?: "hug" | "viewport"`: при `"viewport"` `#eui-capture-surface` получает точные размеры `capture.viewport` (не inline-block), и `CaptureComponent` монтирует `HostStageSurface` со stage host = surface (паритет с CapturePrototype). Поле — frame-слой (conditional spread; отсутствие = hug, существующие хеши не сдвигаются, отдельного ALGO bump не нужно — едет вместе или после W2). Это даёт «все 4 Sheet/Popup shells, включая popup-hug, проходят geometry»: fixed-shell'ы меряются на viewport-поверхности, popup-hug — на hug как раньше.

**Файлы:** `src/catalog/hostPrimitives/overlay.definition.ts|Overlay.tsx`, `src/prototype/compositionV3/layout.ts`, `src/capture/CaptureComponent.tsx`, `src/acceptance/caseSetSchema.ts` (`capture.surface`), `server/acceptance/gates/capture.ts` (проброс), `server/screenshot/service.ts` (bootstrap-поле), `src/capture/protocol.ts`, `scripts/screenshot-worker.mjs` (echo), `server/acceptance/ids.ts` (frame-слой), `docs/prototype-format.md` (truth table + Overlay contract), `docs/plans/2026-07-16-overlay-truth-table.md` не правим (исторический), e2e overlay-кейс.

**Риски:** (1) смена поведения переполнения Overlay (вытекание → clip) может изменить вид существующих прототипов — единственное живое употребление Overlay в данных (`magnit-loyalty-july`) — hug-sheet ниже вьюпорта, не затронут; проверить на прод-данных при деплое; (2) `HostStageSurface` в компонентном капчуре легализует Overlay в случаях компонентов — обновить `hostPrimitivesAllowed`-логику осознанно (allowlist только при `surface:"viewport"`).

**Done:** юнит/DOM-тесты Overlay (maxHeight при всех placement, scroll-контейнер); e2e компонентный кейс с `capture.surface:"viewport"` и переполняющим контентом: geometry pass с точным layout box; composition-токены компилируются и линтуются; verify зелёный.

### W6. Nested slotBindings (строки 1–2)

**Контракт схемы** (`src/acceptance/caseSetSchema.ts`): `caseSetSlotChildSchema` получает рекурсивное опциональное поле `slotBindings` (тот же record-shape, `z.lazy`). Лимиты: глубина ≤ 3 (включая корень кейса), суммарно детей на кейс ≤ 12 (существующий `CASE_SET_MAX_SLOT_CHILDREN` становится total-cap по дереву), слотов на узел ≤ 8. Ключ `default` работает на любом уровне с той же exempt-семантикой.

**Валидация** (`server/acceptance/caseSets.ts`, grep только с `-a` — NUL-байт в `:259`): `validateSlotBindings` становится рекурсивным; для вложенных детей membership/namedSlots проверяются по `definitionMeta` **родителя-ребёнка** (`PublishedSlotPin.definitionMeta` уже читается — `publishedPinByNameAndVersion:162-163`); коды `slot_*` получают path до узла; `slot_self_reference` — проверка цикла по всему пути.

**Хеши:** `slotsHashOf` и `FrameSlotBinding` расширяются полем `children?` через conditional spread (`definedOnly`): плоские (depth-1) наборы дают **байт-в-байт прежние** slots_hash и frame-хеши — golden `f29b0c49…` не сдвигается, ALGO не бампается. Дедуп-ключи (`dedupSlotsKeyOf`) учитывают дерево.

**Капчур:** `slotCaptureOf` (`server/screenshot/service.ts:866-891`) строит дерево: `tree[]` получает `children?: number[]` (индексы), `children: CapturePin[]` — дедуп бандлов по (componentId, version) по всему дереву; `draftComponentAllowedUrls` — URL бандлов/ассетов всех уровней. `CaptureComponent.captureRuntimeTree` (`src/capture/CaptureComponent.tsx:82-99`) строит вложенный runtimeSpec (рантайм уже умеет). Протокол (`src/capture/protocol.ts`, `scripts/screenshot-worker.mjs`) — аддитивные поля.

**Зеркала:** `server/driver-mjs.d.ts` при новых экспортах; `.claude/skills/author/driver.mjs` + `share/*/driver.mjs` — если case-set валидируется локально (`case-set validate` локально-первый — проверить, использует ли схему из `src/acceptance/caseSetSchema.ts`; если да — правка одна).

**Done:** e2e: кейс «parent candidate → published child → published кнопка во вложенном слоте» — кадр содержит контент кнопки (проверка по geometry/визуальному факту); юнит: depth-1 манифест даёт прежний slots_hash (golden); 422-коды на превышение глубины/лимитов/цикл; `docs/server-api.md` §slotBindings обновлён (снятие «Глубина 1», новая формулировка «дерево — композиция, место глубоких структур в прототипе» смягчается до лимита 3).

### W7. Capabilities, changelog, финальная верификация

- `server/routes/meta.ts` (`/api/capabilities`): `features.figmaMultiSource`, `features.geometryLayoutBoundsV2` (+`acceptance.caseFingerprintAlgo: 8`), `features.geometryCaseTolerances`, `features.comparisonMatte`, `features.textAaBudget`, `features.overlayScrollOwnership`, `features.captureViewportSurface`, `features.nestedSlotBindings` (+лимиты). Discovery — фаза гейта для координатора.
- Короткий changelog в `docs/server-api.md` (раздел изменений) — по одному абзацу на capability, как требует фидбэк.
- Финальный прогон: `npm run verify` + `npm run e2e` + runtime-прогон `/verify`; корпус детерминизма после W2; замер стоимости edge-сигнала (W4).

## 3. Инварианты (нарушать нельзя, проверяются на ревью каждой волны)

1. Новые поля манифеста case-set — строго `.optional()` без `.default()` (контентная адресация `cset_`).
2. frameFingerprint не версионируется; новые поля — только через conditional spread/`definedOnly`; slot-free и depth-1 кейсы дают прежние хеши (golden-тесты). Единственный сдвиг — осознанный ALGO 7→8 в W2.
3. Recompute-каскад: каждое новое поле обязано попасть в правильный слой `FIELD_LAYERS` и в `recompute.ts`; NULL-слои ⇒ recapture (не молчаливый pass).
4. `scripts/check-provenance-resolver.ts` — обновлять пины при любом касании `figma_json`.
5. Капчур-фон остаётся прозрачным; matte — только на сравнении.
6. Существующие манифесты/вердикты без новых полей не меняются (регресс-тесты в каждой волне).
7. `server/acceptance/caseSets.ts` грепать только `grep -a` (NUL-байт в `:259`).
8. Зеркала драйвера (`share/*`) и `server/driver-mjs.d.ts` синкать в той же волне, что и правку.
9. Сборка на прод-сервере запрещена; деплой — по `/deploy` после явной команды пользователя.

## 4. Риски и открытые вопросы

- **R1 (W2):** рост layoutBounds от текстовых узлов может поломать существующие прод-case-sets с точным `expectedGeometry` — смягчается W3 (`tolerancePx`), но порядок деплоя: W2+W3 вместе, иначе окно ложных fail.
- **R2 (W4):** пороги `textAaBudget` — стартовые значения (insidePct 95, из калибровки T=95 R7a) могут требовать подстройки на реальном Timer; вынести оба в per-case поля (сделано) — тюнинг без релиза.
- **R3 (W5):** clip при переполнении Overlay — поведенческое изменение; аудит употреблений на проде перед деплоем (сейчас одно, не затронуто).
- **R4 (W6):** рост стоимости капчура с деревом детей — замер (2026-08-05: 12 и 24 ребёнка ≈3.7 с, кривая плоская) — повторить для depth-3.
- **R5:** параллельность волн — W1/W5/W6 не пересекаются по файлам, кроме `caseSetSchema.ts` (W3/W4/W5/W6) и `ids.ts` (W2/W3/W4/W5) — эти два файла правит только одна волна за раз; оркестратор сериализует.

## 5. Триаж адверсариального ревью

_(заполняется после Stage 2)_
