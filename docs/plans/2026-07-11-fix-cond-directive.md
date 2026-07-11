# Fix: директива `$cond` не резолвится в плеере

## Симптом

Формат v1 (`docs/prototype-format.md`) определяет `{"$cond": {"if": <condition>, "then": <literal>, "else": <literal>}}`, и `src/prototype/validate.ts:63-70` эту форму принимает. Но плеер (`src/player/ScreenView.tsx`) передаёт `screen.spec` в `Renderer` из `@json-render/react` без трансформации, а рантайм 0.19.0 ждёт плоскую форму `{$cond: VisibilityCondition, $then, $else}` (`@json-render/core` `PropExpression`). Итог: объект `{$cond: {...}}` попадает в React как child → `Objects are not valid as a React child (found: object with keys {$cond})`, ErrorBoundary элемента показывает ошибку. Воспроизведено 2026-07-11 на прототипе с `Text.text = {$cond: ...}`; ни один seed-прототип `$cond` не использует, поэтому баг был латентным.

## Решение: транслировать на границе рендера

Формат v1 не меняем (он — контракт, задокументирован и задеплоен). Добавляем чистую трансформацию spec из doc-формы в runtime-форму и применяем её в единственной точке рендера прототипов — `ScreenView`.

Обоснование безопасности механической перезаписи:
- грамматика условий v1 (boolean / `{$state,…}` c `eq|neq|gt|gte|lt|lte|not` / `$and` / `$or`) — точное подмножество рантаймной `VisibilityCondition`, менять `if` не нужно;
- валидатор запрещает `$`-ключи в статических литералах (`isStatic`/`checkDynamic`), значит любой объект с ключом `$cond` в props — это именно директива, ложных срабатываний нет;
- ветки `then`/`else` — статические литералы (validate.ts:68-69), рекурсия внутрь веток не нужна.

## Изменения

1. **`src/prototype/runtimeSpec.ts` (новый)** — `toRuntimeSpec(spec)`: глубокий обход `elements[*].props` (объекты и массивы на любой глубине); `{$cond: {if, then, else}}` → `{$cond: if, $then: then, $else: else}`. Вход не мутировать; узлы без `$cond` возвращать структурно без изменений (пересоздание объектов допустимо — мемоизация ниже). `visible`, `on`, `children`, `root` — как есть.
2. **`src/player/ScreenView.tsx`** — `const runtimeSpec = useMemo(() => toRuntimeSpec(screen.spec), [screen.spec])` до `splitCanvasSpec`; все три вызова `Renderer` получают трансформированный spec. `useMemo` сохраняет идентичность spec между рендерами (сейчас non-canvas путь передаёт стабильный объект — не деградировать).
3. **Тесты**:
   - unit `src/prototype/runtimeSpec.test.ts`: перезапись на верхнем уровне, внутри вложенного объекта и массива; отсутствие мутации входа; spec без `$cond` — эквивалентен по значению; `$state`/`$bindState`/`$template` не тронуты.
   - интеграционный в `src/player/PlayerShell.test.tsx` (или рядом): экран с `Text.text = {$cond: {if: {$state:"/flag"}, then, else}}` рендерит `else`-ветку, после экшена `setState /flag=1` — `then`-ветку. Это регрессия на сам баг.
4. **`.claude/skills/author/SKILL.md`** — переписать пункт Gotchas про `$cond`: баг исправлен (дата), директива работает; обход через `visible` оставить упомянутым как альтернативу.

## Вне скоупа

- Изменение формата v1 / валидатора / документации формата — форма `{if, then, else}` остаётся канонической.
- `repeat`/`$computed`/прочие reserved-директивы — по-прежнему v2.
- Editor/конструктор — точка трансформации остаётся на границе doc→Renderer; будущий редактор работает с doc-формой.

## Done-критерии

- Прототип `.claude/skills/author/examples/rating-demo.json`, возвращённый к `$cond`-варианту (Text с `$cond` вместо пары `visible`), рендерится без ошибок консоли; обе ветки переключаются по клику. Проверка драйвером: `node .claude/skills/author/driver.mjs prototype … && … shoot rating-demo` (exit 0 — драйвер падает на console errors).
- `npm run verify` зелёный (typecheck, lint, unit, server tests, validate:prototypes, build, drift).
- Новые тесты из §3 падают до фикса (интеграционный) и проходят после.

## Триаж ревью

_(заполняется после раунда Codex-ревью)_
