# План v3: `computed` — декларативные производные значения стейта (формат v1, аддитивно)

> Целевое имя в репо после одобрения: `docs/plans/2026-08-02-computed-state.md`.
> Скоуп подтверждён пользователем: **только расширение формата** (schema/validate/runtime/server-surface/доки/тесты). Без новых yp-компонентов и демо в проде; **к разработке после валидации плана не приступать**.
> v3 — после двух раундов адверсариального ревью (2+1 ревьюера, Opus); триаж обоих раундов — в конце файла.

## Контекст

Стейт прототипа (`doc.state`) переживает навигацию внутри сессии плеера: корзину можно наполнять `pushState` и рендерить `repeat`. Но производные данные — количество позиций, сумма, итог чека — в v1 невыразимы: `$template` только подставляет пути, params экшенов статичны, арифметики нет. Хранить сумму императивно — state drift.

Решение: опциональное top-level поле `computed` — закрытый набор операций, значения read-only, читаются обычным `$state`/`$template`/`$cond`:

```json
"computed": {
  "cartCount":    { "op": "count", "from": "/cart" },
  "cartSubtotal": { "op": "sumProduct", "from": "/cart", "fields": ["price", "qty"] },
  "cartTotal":    { "op": "add", "terms": ["/cartSubtotal", "/shippingFee", -500] }
}
```

Ключи — **bare** (как в `doc.state`), чтение — `{"$state": "/cartTotal"}`. Намеренно **без** проп-директивы `$computed` (остаётся зарезервированной, `docs/prototype-format.md:102`): чтение через `$state` не трогает `$defs.propValue` и контрактный assert на его длину.

## Архитектура (ключевые развязки)

- **Вычисление — в воронке записи стора**: `createHardenedStore` (`src/prototype/hardenedStore.ts:51`) пересчитывает computed в `set`/`update` после `guard`, до `state = next; notify()` — атомарный снапшот, покрывает экшены и `$bindState` write-back. Сид при конструировании. Полнота воронки проверена ревью по `.d.ts`/`index.mjs` json-render: все пути записи (`StateProvider.set/update`, builtin executor, `useBoundProp`, uncontrolled-diff-effect) идут через `store.set/update`; `$bindItem` не может адресовать computed (repeatBasePath существует только для путей, разрешившихся в массив).
- **Инертные превью — досев**: чистая `applyComputed(state, spec)` поверх `mergeScreenState(...)` в CJM/редакторе/галерее.
- **Рантайм-путь** (реальный `EasyUiActionRuntime`): PlayerShell, PresentShell, scenarioRunner и **CaptureSurface** (не инертный сид — у него настоящий actionRuntime) получают `computed: doc.computed`.
- Скриншот-пайплайн гоняет реальный плеер в headless Chromium → computed работает автоматически.
- Миграций БД нет: документ — opaque blob, поле optional.

## Дизайн-решения

- **D1. Ключи** — bare, `^[A-Za-z][A-Za-z0-9_-]*$` (первая буква исключает `__proto__`/`_viewer`/`~`-эскейпы по построению). Консистентно с `doc.state`/`stateOverrides` и правилом из скиллов («ключи стейта БЕЗ слэша», `.claude/skills/yp-prototype/SKILL.md:119`); коллизии — сравнение ключ-с-ключом, issue-пути — `/computed/cartTotal/from` без спецслучаев.
- **D2. Операции (закрытый набор v1)**:
  - `count {from}` — длина массива;
  - `sum {from, field?}` — сумма поля по items; без `field` — item сам слагаемое (зеркало `{"$item": ""}`);
  - `sumProduct {from, fields[2..4]}` — сумма произведений полей item;
  - `add {terms[2..8]}` — сумма термов; терм — абсолютный пойнтер (в plain state **или на ранее объявленный computed-ключ**) либо числовой литерал (отрицательный — скидка). Закрывает «чек = subtotal + доставка − скидка».
- **D3. Числовая семантика** (детерминированная, в доку дословно): не-массив в `from` ⇒ 0; поле item читается `getAtRelativePath`, засчитывается только finite number, иначе item даёт 0; в `sumProduct` любое отсутствующее/нечисловое поле ⇒ item даёт 0 (не ×1); терм `add` не-finite ⇒ 0; финальный аккумулятор `Number.isFinite(total) ? total : 0`; **без округления и коэрции строк**. Деньги: дока предписывает целые минорные единицы (копейки) или целые ₽; в фикстуре — целые цены. Явное примечание про IEEE-754.
- **D4. Порядок и ссылки**: записи вычисляются в порядке ключей объекта; `from` не может указывать на/под computed вовсе; пойнтер-терм `add` может ссылаться **только на объявленный ранее** computed-ключ (forward/self-ссылка — ошибка). Ацикличность по построению — канон `flow.parentId` (`docs/prototype-format.md:61`, `schema.ts:174-190`), детекция циклов не нужна.
- **D5. Zod, две ветки** (инвариант «откат читает без потерь», `docs/server-api.md:872`, `schema.ts:116`):
  - **input**: discriminated union по `op` (4 strict-варианта), regex ключа, лимиты (`fields ≤ 4`, `terms ≤ 8`, записей ≤ 20 — в `refinePrototypeDocAuthoring`, **до** early-return `if (!doc.flows) return;` в `schema.ts:244`, с расширением `RefinableDoc`);
  - **stored**: `z.record(z.string(), z.unknown())` — вообще без формы записи (не `looseObject`: тот бросает на `computed: null` / `{"x": 5}` / записи без строкового `op` ⇒ 422 на каждом чтении ревизии). Форма и `op` — забота эвалюатора: `evaluateComputed` обязан принимать **не-объектные** записи (`null`, число, массив) и отдавать 0 без throw — иначе бросок на каждой мутации стейта в плеере. Публичный тип — из input-ветки (прецедент `Flow`, `schema.ts:311`). Двухрелизного правила для новых op **нет**: будущие op и поля записей аддитивны в одном релизе.
  - Корень stored-ветки остаётся `strictObject` как есть: `looseObject` дал бы `PrototypeDoc` индексную сигнатуру и убил excess-property-проверки по всему репо — прямой запрет в `schema.ts:100-104` (класс-фикс из v2-черновика отменён, см. триаж раунда 2).
  - `/api/schemas/prototype-document.json` строится из **input**-ветки (`server/routes/meta.ts:129`) — агенты видят строгую грамматику; послабление stored в discoverability не стоит ничего.
- **D6. Коллизии** (все — bare-сравнения): computed-ключ == top-level ключ `doc.state` → ошибка; == `currentScreen|navStack|_viewer` → ошибка; ключ `stateOverrides` == computed-ключ → ошибка (`reservedOverrideKeys` становится per-doc); `__proto__` невозможен по D1.
- **D7. Запрет записи на трёх слоях** (pointer-форма `/key` — только в `isComputedPath`/`checkPointer`; в сторе `parseJsonPointer` уже отдаёт **bare**-сегменты — сравнение `segments[0]` с `computedKeys(spec)` по bare-именам):
  1) валидация: `statePath`/`clearStatePath` у setState/pushState/removeState и `$bindState` → ошибка `"state path is a computed value and is read-only"` (существующие тексты не трогаем);
  2) стор: `applyOne` отклоняет `segments[0]` ∈ computed (`onError`, зеркало `unsafe state path rejected`);
  3) `dispatchOne`: пре-чек `params.statePath` **и `params.clearStatePath`** с no-op-репортом в инспектор по паттерну removeState-out-of-range (`actionRuntime.ts:203-208`) — ровно один error-репорт, стор записи не видит.
- **D8. `repeat.statePath` на computed — ошибка**, при этом существующая warning-ветка `:313-315` («may be populated dynamically») для computed-пойнтера **подавляется** — тест закрепляет: ошибка есть, warning отсутствует.
- **D9. Диагностика computed — один раз, до цикла по экранам**, по `doc.state` (без N дублей на N экранов).
- **D10. Наблюдаемость — для человека в панели плеера**: записи инспектора `{type:"state"}` мутирующих экшенов дополняются снапшотом computed-значений (`result.computed`) + строка рендера в `src/player/inspector/InspectorPanel.tsx` (state-ветка :59-68 сейчас прячет params — без явной строки значение невидимо). `result.computed` **отсутствует** при пустой/отсутствующей спеке (тесты `inspectorDecoration.test.ts:36-37,81-83` сравнивают `result` целиком). Каналы агента (`driver.mjs`/capture/productErrors) инспектор-лог не читают — отладка агента остаётся на статических warnings валидации; провод в capture-канал не тянем (v1). Per-recompute runtime-warnings не вводим (шум).
- **D11. Без ручного `$defs`**: `computed` полностью типизирован — `z.toJSONSchema` отдаёт `oneOf` из strict-вариантов + `propertyNames.pattern` из regex ключа (проверено ревью на zod 4.4.3); только `.describe()` на record. `propValue.anyOf` не затронут.
- **D12. Capabilities**: `features.computed: true`, `limits.computedEntries|computedFields|computedTerms`, **`computedOps: ["count","sum","sumProduct","add"]`** — импорт из места энфорса (правило `server-api.md:867`).
- **D13. Редактор не авторит computed** (v1), поле переживает round-trip спредами; UI нет. Non-goal в доке: **построчные вычисления** («price × qty» в строке) невыразимы — механизм другой (арифметика над `$item`), фикстура/e2e на них не намекают.
- **Лимиты**: `COMPUTED_ENTRIES_LIMIT = 20`, `COMPUTED_FIELDS_LIMIT = 4`, `COMPUTED_TERMS_LIMIT = 8`.

## Декомпозиция (file ownership, без пересечений)

```
T1 (фундамент) ──┬── T2 (валидация)  ──┐
                 ├── T3 (рантайм)     ──┼── T6 (фикстура + e2e + доки + скиллы)
                 ├── T4 (сервер)      ──┤
                 └── T5 (diff/история)──┘
```
T2–T5 параллелятся после T1; T6 — после мержа T1–T3.

### T1 — Эвалюатор + схема

**Владеет:** `src/prototype/computed.ts` (нов.), `src/prototype/schema.ts`, `src/prototype/__tests__/computed.test.ts` (нов.)

- `computed.ts`: `evaluateComputed(state, spec) → Record<key, number>` — последовательно в порядке ключей, каждая запись видит plain state + ранее вычисленные значения (D4); оборонительно к stored-форме (неизвестная op ⇒ 0). `applyComputed(state, spec)` — **identity-референс при пустой/отсутствующей спеке**. `computedKeys(spec): string[]`, `isComputedPath(pointer, keys)` (префиксный) — единый предикат для validate/store/runtime. Чтение — `getAtPointer`/`getAtRelativePath` из `./pointer`. Doc-comment об инварианте: computed выводится только из закоммиченных записей стора; reference-identical запись (`getByPath(path) === value`, `hardenedStore.ts:76`) не коммитится и не пересчитывает — чистота эвалюатора делает пропуск no-op-записей безопасным (существующее поведение, полноту не заявляем).
- `schema.ts`: константы лимитов; D5-шейпы обеих веток; `computed` в `prototypeDocShape` — **потребует третий generic-параметр** (`schema.ts:152` сейчас `prototypeDocShape<S, F>(screens, flows)`) и правку обоих call-sites (:295, :303); счётчик записей в `refinePrototypeDocAuthoring` **до** `if (!doc.flows) return;` (:244) + `computed?: Record<string, unknown>` в `RefinableDoc` (:165); корень stored-ветки **не трогаем** (остаётся `strictObject`, см. D5); `.describe()` на record.

**Done:** unit-тесты computed.test.ts: все ветки D2/D3/D4 (в т.ч. `add` со ссылкой на ранний ключ, литералами, отрицательным термом; Infinity ⇒ 0; immutability; identity-референс; **не-объектные записи (`null`/число/массив) и неизвестная op ⇒ 0 без throw**). Схема: input принимает валид / режет 21-ю запись **в доке без `flows`** (и корректен при `computed === undefined`), 5 полей, 9 термов, `op:"avg"`, ключи `/cartTotal`|`_x`|`0x`; stored принимает 21 запись, произвольный ключ, `op:"avg"`, `computed: null` и записи-скаляры; **тест порядка: `Object.keys(doc.computed)` после `inputPrototypeDocSchema.parse` совпадает с исходным** (правило «declared earlier» держится на порядке ключей записи — гарантия рантайма zod/JSON, не формата; тест защищает от будущей замены `z.record`). `npm run typecheck`.

### T2 — Валидация

**Владеет:** `src/prototype/validate.ts`, `src/prototype/__tests__/validate.test.ts`

- `forbiddenPaths` (:21) → `RESERVED_STATE_PATHS`; per-doc `computedPaths` (pointer-форма). `checkPointer` (:84) — хвостовой параметр `computedPaths: readonly string[] = []`, read-only-ошибка до missing-warning'а.
- До цикла по экранам — `validateComputedSpec`: D6-коллизии (bare, по сырому `doc.state`); `from` через `checkPointer(..., warnMissing:false, computedPaths)` (unsafe + reserved + запрет computed одним вызовом); `field`/`fields[i]` через `isSafeRelativeFieldPath`; термы `add`: литерал — finite number, пойнтер — safe+не-reserved, ссылка на computed — только на объявленный ранее (forward/self — ошибка), не-computed терм отсутствует в `doc.state` — warning; warning «`from` не массив в initial state» (зеркало :314).
- `effectiveState = applyComputed(mergeScreenState(...), doc.computed)` (:278) — computed-ключи «присутствуют» для warning'а :87 без спецкейса.
- `reservedOverrideKeys` (:261) — per-doc (bare), вынести из цикла.
- `computedPaths` — в call-sites `checkPointer` action-params (:477) и `$bindState` (`checkDynamic` :130) через **опциональное поле** options-объекта `validateElementProps` (обратная совместимость: `server/classify.ts:89` вызывает без него — **осознанно**: classify потребляет только errors (:89-90), missing-warnings там мертвы, `computedPaths` не передаём, расхождения нет т.к. запись в computed режется на save).
- D8 + подавление warning-ветки :309-311 для computed-пойнтера.

**Done:** `describe("computed values")` в стиле репо: все строки D6 (в т.ч. `state: {cartTotal: 0}` + `computed: {cartTotal: …}` → ошибка), D4-forward-ref, D7-валидация (все семь write-целей: 3×statePath, clearStatePath, $bindState + позитив), D8 (ошибка есть, `/may be populated dynamically/` **отсутствует**), warning не-массива, негатив «`$state:/cartTotal` без missing-warning». Свип фикстур (`validate.test.ts:353-361`) зелёный. `server/classify.ts` не редактируется.

### T3 — Рантайм

**Владеет:** `src/prototype/hardenedStore.ts`, `src/player/actionRuntime.ts`, `src/player/inspector/log.ts`, `src/player/inspector/InspectorPanel.tsx`, `src/player/__tests__/inspectorDecoration.test.ts` (+тест панели при необходимости), `src/player/PlayerShell.tsx`, `src/player/PresentShell.tsx`, `src/player/scenarioRunner.ts`, `src/capture/CaptureSurface.tsx` (+ caller в `src/capture/`), `src/cjm/CjmScreenTile.tsx`, `src/editor/EditorCanvas.tsx`, `src/editor/EditorScreenStrip.tsx`, `src/gallery/GalleryPreview.tsx`, `src/editor/InspectorPanel.tsx`, `src/player/__tests__/actionRuntime.test.ts`

- `HardenedStoreOptions.computed?`; сид в конструкторе; пересчёт **через `safeSetBySegments`** (null-prototype-инвариант, без спредов в plain object); `applyOne` — отказ при `segments[0]` ∈ computed; `set`/`update`: guard → пересчёт → commit/notify (порядок закрепить тестом). Частичное применение батча `update` при отклонённой записи — существующая семантика, закрепить тестом как есть.
- `EasyUiActionRuntimeOptions.computed`; пре-чек `dispatchOne` по `statePath` **и `clearStatePath`** (D7-3); в `logAction`-result мутирующих экшенов — `result.computed` (D10, тип в `inspector/log.ts:9`).
- Рантайм-сайты: PlayerShell:71, PresentShell:105, scenarioRunner:158, CaptureSurface:36 (+пропс от caller).
- Сид-сайты: CjmScreenTile:121, EditorCanvas:151, EditorScreenStrip:72, GalleryPreview:104 — `applyComputed(mergeScreenState(...), doc.computed)` + `doc.computed` в deps `useMemo`; `src/editor/InspectorPanel.tsx:130` — обычное выражение (не useMemo), досев обязателен: `effectiveState` идёт в `PropsForm` → `validateElementProps`, без досева редактор показывает живой ложный missing-warning на каждый `$state:/cartTotal`. `server/classify.ts` **не трогаем** (см. T2).
- `instrumentStore` — без изменений (пересчёт внутри store до notify, обёртка читает только пути из update-map вызывающего); чистота лога закрепляется тестом.

**Done:** тесты: сид при конструировании; set/push/removeState по `/cart` — консистентные computed в том же снапшоте, что видит listener (атомарность); `add`-цепочка (subtotal → total) обновляется одной нотификацией; прямой `store.set("/cartTotal", …)` отклонён, `onError` один раз; `dispatchOne` по computed statePath для трёх экшенов — ровно один error + одна `{type:"error"}` запись; `pushState` с computed `clearStatePath` — один error, стор не тронут; `pushState /cart` с логгером — одна запись `logAction`, содержащая `result.computed`; частичное применение `update`; null-prototype после пересчёта. `npm run test -- --run src/player src/editor src/cjm src/gallery` зелёный.

### T4 — Серверная discovery-поверхность

**Владеет:** `server/routes/meta.ts`, `server/contracts.ts`, `server/contract.test.ts`, `server/openapi.json`, новый кейс в bundle-тестах (`server/bundle*.test.ts`)

- `meta.ts`: `limits.computedEntries|computedFields|computedTerms`, `features.computed: true`, `computedOps` — импортом из `src/prototype/schema`.
- `contracts.ts`: `capabilitiesResponseSchema.limits/.features(+computedOps)` (:1767-1783); `prototypeRevisionDiffContract.responseSchema` + `computed` рядом со `state` (:732); **enum `summary.omittedSections` (:742) + `"computed"`**.
- `contract.test.ts`: exact-match объекты :582/:603; assert на схему документа: `computed` присутствует, record с `propertyNames.pattern` и **`oneOf`** из 4 op-вариантов (не anyOf), `propValue.anyOf.length === 6` не изменился (:650), тест аннотаций (:637) не тронут.
- Bundle round-trip: экспорт→импорт дока с computed проходит (`server/bundle/importer.ts:430` перепарсивает **input**-схемой — авторские лимиты применяются на импорте; кейс фиксирует это поведение, абзац — в доку T6).
- `npm run generate:openapi` → коммит `server/openapi.json`.

**Done:** `bun test server/contract.test.ts` + bundle-сьют; `npm run verify:openapi`; `curl /api/capabilities | jq .features.computed` → `true`.

### T5 — Diff / история

**Владеет:** `src/prototype/revisionDiff.ts` (+test), `src/editor/docDiff.ts` (+test), `src/app/strings/editor.ts`, `server/prototype-diff.test.ts`. **Не трогает `server/contracts.ts`** (T4).

- `revisionDiff.ts`: `"computed"` в `OMIT_PRIORITY` (:34) после `"state"`; `mapDiff(from.doc.computed, to.doc.computed, ctx, "computed")` после `state` (:263).
- Строка `diffComputedLabel: "Вычисляемые значения"`; `docDiff.ts`: `diffRecord` рядом со `state` (:146) + ветка `head === "computed"` в `describeDocPath` (:224) — bare-ключи делают адресацию единообразной (zod- и validate-issues совпадают).
- Тест в `prototype-diff.test.ts` с малым `byteBudget`, **форсирующим omission** computed-секции (закрывает риск enum'а T4). Этот тест валидирует ответ контрактом ⇒ **T5 мержится после T4** (enum `omittedSections`); остальное T5 от T4 не зависит. `omitCategory` (`revisionDiff.ts:241`) спецкейса не требует — там общая ветка `Object.hasOwn(response, category)`.

**Done:** три сьюта зелёные; дифф с добавленной computed-записью даёт `computed.added`; конфликт-диалог показывает русский лейбл.

### T6 — Фикстура, e2e, доки, скиллы

**Владеет:** `test/fixtures/cart-computed.json` (нов.), `e2e/dev/computed.spec.ts` (нов.), `docs/prototype-format.md`, `docs/server-api.md`, `docs/authoring-sdk.md`, `.claude/skills/author/SKILL.md`, `.claude/skills/yp-prototype/SKILL.md`

- **Фикстура** — скелет от `checkout.json` (offline-свип `validate.test.ts` работает на stored-дефолте `designSystem`). Целые цены (D3), `/cart` + `/shippingFee` в стейте, `computed` со всеми **четырьмя** ops (total = add), `repeat`, `$template`-итог, ≥2 экранов с cross-navigate, handlers+labels у интерактивных, ноль warnings. **Ограничение стартеризации**: `$template`-итог обязан лежать в `props.text` текстового элемента, у кнопок выживают только `label/disabled` (`e2e/starter-ds.fixture.ts:93` — props схлопываются, `repeat`/`on`/`children` живы).
- **e2e** — публиковать `designSystem: "shadcn"` через API **нельзя**: все builtin DS retired (`server/migrations.ts:341-342`, 422 закреплён тестом `e2e/dev/legacy-archive.spec.ts:22-28`). Путь: `ensureStarterDesignSystem` + `starterizePrototype` от **этой же фикстуры** (`e2e/starter-ds.fixture.ts:133-160`, single source of truth), плеер, два клика add-to-cart, assert итога (включая слагаемое доставки). Оправдан: атомарность снапшота под реальным `notify()` unit-тестами не ловится.
- **Доки:** `prototype-format.md` — :7 (поля корня), :31-35 (cross-ref), новая секция `## Computed values` после `## Repeat` (таблица ops, D2/D3/D4 дословно, D1, D6, D7 read-only, D8, лимиты, деньги/IEEE-754, non-goal построчных вычислений, примечание про импорт бандла и авторские лимиты), :503 чеклист, **:102 согласовать** (зарезервирована проп-директива `$computed`; top-level `computed` — поддерживаемое имя). `server-api.md` — :845-867 limits/features/computedOps + **фикс стейла :845** (schema endpoint строится из input-ветки, не из `prototypeDocSchema`). `authoring-sdk.md` — passthrough через `doc()` (SDK-кода не нужно: спред `...input`).
- **Скиллы:** `.claude/skills/author/SKILL.md:57` — `computed?` в литерал списка корневых полей + 3-4 строки о фиче; `.claude/skills/yp-prototype/SKILL.md` — упоминание в разделе стейта (bare-ключи — правило «без слэша» остаётся верным и для computed).

**Done:** свип `validate.test.ts` зелёный с нулём warnings по новой фикстуре; `npx playwright test e2e/dev/computed.spec.ts` зелёный.

## Верификация (интеграционный гейт оркестратора)

По волнам — точечно: `npx vitest run src/prototype ...` / `bun test server/contract.test.ts` по done-критериям задач.

Финальный гейт (без дублирования — `npm run verify` уже включает typecheck/server:typecheck/lint/test/server:test/validate:templates/verify:openapi/verify:sdk/build/check:css):

```
npm run verify
npx playwright test e2e/dev/computed.spec.ts
npm run e2e            # полный свип один раз, в конце
```

Runtime-приёмка по `.claude/skills/verify/SKILL.md` («do not assume any built-in catalog»): `server:dev` + `dev`, публикация **стартеризованного** варианта cart-фикстуры (той же процедурой, что e2e, либо через живую custom-DS), `node .claude/skills/author/driver.mjs snap <id> ./shots --all-screens --json` — **exit 0 обязателен**; визуально сверить итог (с доставкой) на снапе.

Ручной round-trip (D13): открыть фикстуру в редакторе, поменять несвязанный проп, сохранить, перечитать — `computed` не потерян.

## Риски

| Риск | Sev | Митигация |
|---|---|---|
| **Откат образа на билд ДО фичи**: старый stored-корень `strictObject` (`schema.ts:300`) ⇒ 422 `invalid_stored_revision` на каждое чтение ревизии с computed (`server/repos/prototypes.ts:44`), classify помечает нерендеримой (:35) — прототипы перестают открываться | high | Принято осознанно: откат через границу фичи = откат данных из бэкапа либо roll-forward (кадость деплоя высокая, бэкапы штатны — см. `/deploy`). Класс-фикс looseObject-корня отклонён (индексная сигнатура, запрет `schema.ts:100-104`) |
| Zero-warning-свип фикстур — гейтит только `validate.test.ts:355-361`; `architectureLints.test.ts:158-160` **скипает** невалидную фикстуру (`continue`), это не страховка | high | фикстура от `checkout.json` (warning-clean скелет); свип validate — первым в T6 |
| Enum `omittedSections` (`contracts.ts:742`) без `"computed"` падает только на больших диффах | high | T4 владеет обеими точками; форс-тест с малым `byteBudget` в T5 |
| Exact-match-assert'ы capabilities (`contract.test.ts:582/:603`) | med | единый владелец T4 |
| Сигнатура `validateElementProps` vs `server/classify.ts` | med | опциональное поле options, default `[]`; server:typecheck в гейте |
| Забытый `doc.computed` в deps `useMemo` сид-сайтов | med | identity-референс при пустой спеке; `react-hooks/exhaustive-deps` |
| Деньги во float: `1999.99 × 3 = 5999.9699…` уедет в PNG | med | целые минорные единицы в доке и фикстуре; явное IEEE-754-примечание |
| Reference-identical запись (in-place мутация массива + re-set той же ссылки) не коммитится ⇒ computed не пересчитан — было no-op, станет видимо неверным числом | low | существующее поведение; инвариант зафиксирован doc-comment в `computed.ts`; кастомные компоненты и так обязаны писать иммутабельно |
| Порядок guard/recompute в сторе; null-prototype при пересчёте | low | guard первым + тест; пересчёт через `safeSetBySegments` + тест |
| Импорт бандла применяет авторские лимиты к stored-документу (`importer.ts:430`) | low | существующий класс (как `flows`); round-trip-кейс в T4 + абзац в доке |

## Триаж адверсариального ревью (v1 → v2)

**Принято** (все с правками в плане): корректность — M1 (формы bare/pointer в D6, теперь единая bare-модель), M2 (early-return `refinePrototypeDocAuthoring` + `RefinableDoc`), M3 (подавление warning-ветки при D8), M4 (generic `prototypeDocShape`), M5 (`clearStatePath` в пре-чеке), m1 (дыра reference-identical — инвариант документирован), m2 (`oneOf`, не anyOf), m3 (усиленное обоснование досева InspectorPanel), m4 (classify выброшен из T3 — сид там мёртв), m5 (docDiff — bare-ключи сняли двойную адресацию), m6 (designSystem в фикстуре, e2e импортирует её же), m7 (arch-свип — не гейт, риск переформулирован), m8 (bundle-импорт — тест+дока). Дизайн — B1 (op `add` + ссылки на ранние ключи по канону `flow.parentId`), M2 (**разворот решения**: stored-ветка tolerant — op-string + looseObject, двухрелизное правило удалено; соответствует письменному инварианту `server-api.md:872`), M3 (риск отката до фичи в таблице + looseObject-корень как класс-фикс), M4 (bare-ключи), M5 (видимость в инспекторе — `result.computed`), M6 (целые минорные единицы, без `round` в v1), M7 (non-goal построчных вычислений), m1 (скиллы в T6), m3 (гейт свёрнут), m4 (`computedOps` в capabilities), m5/m6 (bundle, стейл `server-api.md:845`), m7 (classify: `computedPaths` не передаём — зафиксировано), m8 (InspectorPanel — не useMemo), m9 (тест частичного `update`).

**Раунд 2 (верификация v2)** — принято: B1 (builtin DS retired ⇒ e2e/приёмка через стартеризованную фикстуру, ограничения стартеризации в T6), M1 (**отмена** looseObject-корня — индексная сигнатура убила бы excess-property-проверки, запрет `schema.ts:100-104`; риск отката остаётся принятым без класс-фикса), M2 (stored-запись — `z.unknown()`, эвалюатор без throw на не-объектах), M3 (в сторе сравнение bare `segments[0]`, pointer-форма только в validate), M4 (D10 переформулирован: наблюдаемость для человека в панели плеера + строка рендера + ownership тестов; capture-канал не тянем), minors (тест порядка ключей, `result.computed` отсутствует при пустой спеке, дрейф :309-311, порядок мержа T5 после T4, `computed === undefined` в счётчике).

**Отклонено** (с обоснованием): двухфазный ввод самого поля `computed` (stored в N, авторинг в N+1) — цена: релизное окно и задержка фичи; реальный риск отката закрыт бэкапами/roll-forward и классом-фиксом на будущее. Поле `round` на записи — не нужно при дисциплине целых единиц; благодаря tolerant-stored добавляется позже в один релиз. Per-recompute runtime-warnings (не-массив в `from`) — шум на каждый пересчёт; взамен статический warning валидации + `result.computed` в инспекторе. Предикаты/`where` — вне сценария корзины v1, tolerant-stored не запирает.

## Статус процесса

- [x] Stage 1: план составлен (3 Explore + 1 Plan, Opus)
- [x] Stage 2, раунд 1: адверсариальное ревью (2 ревьюера, Opus) — 1 blocker, 12 major, 17 minor; триаж выше, план переработан (v2)
- [x] Stage 2, раунд 2: верификационное ревью v2 (1 blocker, 4 major — все оттриажены, план v3); блокирующих возражений не осталось
- [x] Одобрение пользователя (2026-08-02); перенос в `docs/plans/2026-08-02-computed-state.md` + коммит
- [ ] Stage 3: исполнение (T1 → волна T2–T5 → T6) — **не начинать без отдельной команды пользователя**
