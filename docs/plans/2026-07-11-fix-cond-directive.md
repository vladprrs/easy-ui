# Fix: директива `$cond` не резолвится в плеере

## Симптом

Формат v1 (`docs/prototype-format.md`) определяет `{"$cond": {"if": <condition>, "then": <literal>, "else": <literal>}}`, и `src/prototype/validate.ts:63-70` эту форму принимает. Но плеер (`src/player/ScreenView.tsx`) передаёт `screen.spec` в `Renderer` из `@json-render/react` без трансформации, а рантайм 0.19.0 ждёт плоскую форму `{$cond: VisibilityCondition, $then, $else}` (`@json-render/core` `PropExpression`). Итог: объект `{$cond: {...}}` попадает в React как child → `Objects are not valid as a React child`, ErrorBoundary элемента показывает ошибку. Воспроизведено 2026-07-11; ни один seed-прототип `$cond` не использует — баг был латентным.

## Решение: адаптер на границе prototype doc → Renderer

Формат v1 не меняем (контракт, задокументирован и задеплоен). Добавляем чистый адаптер spec из doc-формы в runtime-форму и применяем его в `ScreenView` — единственной границе, где **prototype documents** попадают в `Renderer` (Debug/SmokeSpec и Storybook story-utils рендерят core-native `Spec` и адаптации не подлежат; gallery/library спеки не рендерят).

Обоснование грамматики условий: v1-грамматика (`checkCondition`) — **намеренно более узкое** подмножество рантаймной `VisibilityCondition`: `SingleCondition[]`, `$item`, `$index` и `{$state}`-операнды сравнений запрещены осознанно (пока v1 запрещает `repeat`). Условие `if` адаптер передаёт без изменений.

## Изменения

1. **`src/prototype/runtimeSpec.ts` (новый)** — `toRuntimeSpec(spec)`: глубокий обход `elements[*].props` (объекты и массивы на любой глубине, без захода внутрь веток). Переписывается **только точная doc-форма**: внешний объект с единственным own-ключом `$cond`, значение которого — объект с ровно ключами `if`, `then`, `else` → `{$cond: if, $then: then, $else: else}`. Любой другой объект с ключом `$cond` (legacy-данные из старых ревизий, core-форма, lookalike) остаётся нетронутым — политика leave-untouched. Вход не мутировать. `visible`, `on`, `children`, `root` — как есть.
2. **`src/player/ScreenView.tsx`** — объединённая мемоизация `adapt → split`. Rules of Hooks: `useMemo` вызывается **безусловно и до** раннего возврата «Screen not found» — `useMemo(() => screen ? toRuntimeSpec(screen.spec) : null, [screen?.spec])` (сейчас `return` на строке 47 стоит раньше места, где понадобится spec; добавить хук после него нельзя — при переходе существующий↔несуществующий screenId изменится число вызванных хуков). Альтернатива — вынести рендер существующего экрана в дочерний компонент. Не обещаем сохранение identity в canvas-ветке (`splitCanvasSpec` и сейчас пересоздаёт объекты каждый рендер) — критерий: canvas-ветка не хуже текущего поведения, non-canvas ветка сохраняет стабильность spec между рендерами за счёт useMemo.
3. **Ужесточение валидатора (`src/prototype/validate.ts`)** — сопутствующие дыры, вскрытые ревью:
   - операнды `gt`/`gte`/`lt`/`lte` обязаны быть числами (сейчас проходят `{gt:"10"}`, `{lte:null}`, `{gte:{foo:1}}`, которые рантайм молча вычисляет в `false`); `eq`/`neq` — любые статические литералы, как раньше;
   - директивы запрещены на корне `element.props` (сейчас `props: {$cond: ...}` целиком проходит валидацию, но core резолвит expressions только в значениях отдельных props).
4. **`docs/prototype-format.md`** — два уточнения: числовые операнды сравнений; директива не может быть всем объектом `props`.
5. **Тесты**:
   - unit `src/prototype/runtimeSpec.test.ts`: точная форма на верхнем уровне / во вложенном объекте / в массиве; falsey-ветки (`then: false`, `else: 0`); отсутствие мутации входа; lookalike (`{$cond: {...}, other: 1}`, `{$cond: {if, then}}`), core-форма `{$cond,$then,$else}` — нетронуты; `$state`/`$bindState`/`$template` не тронуты;
   - validate: negative-тесты на нечисловой операнд `gt` и на директиву в корне `props`;
   - интеграционный (PlayerShell/ScreenView): экран с `Text.text = {$cond: ...}` рендерит `else`-ветку, после `setState` — `then`-ветку; варианты canvas и non-canvas;
   - e2e (playwright): прототип с `$cond`, созданный через API (полный путь API → DB → loader → ScreenView), переключение ветки кликом.
6. **`.claude/skills/author/SKILL.md`** — Gotcha про `$cond` переписать: исправлено (дата), директива работает; `visible` упомянуть как альтернативу. Пример `examples/rating-demo.json` вернуть на `$cond`.

## Вне скоупа (триаж-решения)

- Изменение формата v1 (форма `{if,then,else}` остаётся канонической); разрешение `SingleCondition[]`/`$item`/`$index`/`{$state}`-операндов — v2 вместе с `repeat`.
- Общая Zod-схема `V1Condition`, разделяемая валидатором и адаптером, — отклонено: адаптер условия не интерпретирует, а `checkCondition` остаётся единственным местом валидации; дублирование грамматики не нужно.
- Аудит старых ревизий БД и повторная семантическая валидация на restore/publish — отклонено для этого фикса: все ревизии проходили `validatePrototypeForSave` при сохранении, а от «до-ужесточения» форм рантайм защищён политикой leave-untouched адаптера. Отдельная задача, если появятся реальные legacy-данные.
- API round-trip тесты для warning-draft и restore-policy — не относятся к багу.

## Done-критерии

- `.claude/skills/author/examples/rating-demo.json` (возвращённый к `$cond`) рендерится без ошибок консоли, ветки переключаются: `node .claude/skills/author/driver.mjs prototype … && … shoot rating-demo` → exit 0.
- Новый интеграционный тест падает до фикса, проходит после.
- `npm run verify` **и** `npm run e2e` зелёные.

## Триаж ревью (Codex gpt-5.6-sol, раунд 1, сессия 019f500f-ba1e-7722-91df-d1730bcca9a4)

| # | Severity | Вердикт | Как учтено |
|---|---|---|---|
| 1 | blocker | Частично принято | Формулировку «точное подмножество» заменили на «намеренно более узкое подмножество»; запреты `SingleCondition[]`/`$item`/`$index` зафиксированы как осознанные (§«Решение»). Принято ужесточение числовых операндов (§3). Общая V1Condition-схема — отклонено (см. «Вне скоупа»). |
| 2 | blocker | Принято (ядро), аудит отклонён | Адаптер распознаёт только точную doc-форму, всё прочее leave-untouched (§1). Аудит legacy/restore/publish — вне скоупа с обоснованием. |
| 3 | major | Принято | Запрет директив на корне `props` + negative test + docs (§3–5). |
| 4 | major | Принято | Объединённая мемоизация `adapt → split`, ослабленное performance-утверждение, порядок хуков (§2). |
| 5 | major | Принято частично | Расширенное покрытие: pure-adapter (falsey, lookalike, core-form), интеграция canvas/non-canvas, e2e через API, `npm run e2e` в done. Round-trip warning-draft/restore — отклонено. |
| 6 | minor | Принято | Формулировка сужена до «единственная граница для prototype documents»; таблица поверхностей учтена — Debug/Storybook остаются core-native. |
