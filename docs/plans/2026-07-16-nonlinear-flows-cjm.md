# Нелинейные прототипы: `doc.flows` + scenario lanes в CJM + guided browse в плеере (v3)

## Контекст

Сейчас модель прототипа плоская: `screens[]` + `startScreen`; CJM (`src/cjm/CjmView.tsx`) — линейная лента тайлов в порядке массива, стрелки между соседями декоративные («does not encode a flow edge»). Реальный граф переходов существует только неявно — через `navigate`-действия — и материализуется лишь как reachability-проверка в валидаторе (`src/prototype/validate.ts:244,455-462,505-513`). Нелинейные прототипы (ветвления: happy path / отказ / возврат) невозможно ни выразить, ни увидеть.

Решения, согласованные с пользователем:
- **Гибридная модель**: рёбра выводятся из `navigate`-действий, автор поверх задаёт именованные сценарии `doc.flows`, валидируемые против графа.
- **CJM — дорожки-ветки**; **охват**: формат + валидация + server API, CJM-рендер, плеер. Редактор-UI вне объёма, целостность данных редактора (docDiff) — в объёме.

**Позиционирование (по ревью r2): это «scenario lanes относительно канонического главного сценария», а не общая модель произвольного нелинейного CJM.** Идентичность якоря по `screenId` — конвенция v1; `forkFrom`/идентичность вхождения — отложенное расширение.

## Семантика

**Flows — авторская аннотация-путеводитель поверх прототипа, не исполняемый сценарий.**
- Рёбра поведения задаются только `navigate`-действиями; flows ничего не добавляют в runtime.
- **ScenarioBar — guided browse**: prev/next делают тот же browse-прыжок (`goToScreen`), что и существующий `ScreensSidebar`. **Экран открывается в текущем session state плеера; промежуточные actions (напр. `setState` перед `navigate`) не исполняются, `screen.stateOverrides` плеер не применяет** (это честная фиксация ограничения — по ревью r2; поведение закрепляется тестом: flow-переход, которому предшествует setState, открывает экран без него). Фиксируется в `docs/prototype-format.md` и UI-копирайте («перейти к шагу»).
- **Верификация ребра — трёхсостоянийная** с приоритетом `static > dynamic > missing`: `static` — статическое navigate-ребро объявлено (в т.ч. под `$if` — потенциальное); `dynamic` — у источника есть navigate с динамическим `screenId` (непроверяемо); `missing` — не найдено. UX (по ревью r2): три различимых стиля линий (сплошная / пунктир / пунктир warning-цвета), **легенда рёбер** в CJM, `<title>` на каждом SVG-ребре + visually-hidden текстовый список рёбер дорожки для скринридеров; формулировки «navigate объявлен / невозможно проверить статически / navigate не найден».

**Ограничения модели v1 (ошибки на уровне схемы, если не сказано иное):**
1. `flows[0]` — главный сценарий; `flows[0].steps[0].screenId === doc.startScreen`.
2. Внутри `flows[0]` все `screenId` уникальны (главная дорожка ациклична; `loop-back` не существует).
3. «Якорь» = шаг ветки, чей `screenId` входит в `flows[0]`. В ветках (по ревью r2, тотальность layout):
   - два соседних якорных шага запрещены (anchor→anchor adjacency не выражается);
   - каждая ветка содержит ≥1 неякорный шаг (иначе пустая дорожка без тайлов);
   - неякорные `screenId` уникальны внутри одного flow (идентичность тайла и URL однозначны);
   - якорные шаги идут в **неубывающем порядке их индексов в main** (запрещает длинные backward-рёбра через всю ленту; возврат к тому же якорю — например `checkout → declined → checkout` — разрешён: индексы не убывают).
4. `step.note` отображается только на шагах с собственным тайлом; на якорных шагах — warning «не отображается».
5. Branch-from-branch и конвергенция между ветками не выражаются (шаг = экрану другой ветки → собственный тайл).

## 1. Формат — `src/prototype/schema.ts`

```ts
export const FLOWS_LIMIT = 12;
export const FLOW_STEPS_LIMIT = 50;
export const FLOW_TOTAL_STEPS_LIMIT = 200; // сумма шагов всех flows

const flowStepSchema = z.strictObject({
  screenId: slugSchema,
  note: z.string().trim().min(1).max(500).optional(),
});
const flowSchema = z.strictObject({
  id: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  steps: z.array(flowStepSchema).min(1).max(FLOW_STEPS_LIMIT),
});
// в prototypeDocShape после screens:
flows: z.array(flowSchema).min(1).max(FLOWS_LIMIT).optional(),
```

`refinePrototypeDoc` (schema.ts:71) — все ошибки из «Ограничений v1» + уникальность `flow.id`, `step.screenId ∈ screens`, соседние шаги не равны, `Σ steps ≤ FLOW_TOTAL_STEPS_LIMIT`. Все проверки вычислимы на уровне схемы (нужен только `flows[0]` как референс якорей). Тест `flows: []` отклоняется `min(1)`.

Экспорт `Flow`, `FlowStep`, лимитов. Документация: `docs/prototype-format.md` — раздел «Flows (scenario lanes)»; `docs/server-api.md` — capabilities + rollback-заметка (§3).

## 2. Статический navigate-граф — новый `src/prototype/navigationGraph.ts`

Doc-комментарий модуля: «статически выведенный navigate-граф»; `back`/`restart`/динамические таргеты не входят.

```ts
export interface NavigationGraph {
  edges: ReadonlyMap<string, ReadonlySet<string>>;   // статические navigate-рёбра (включая под $if)
  dynamicSources: ReadonlySet<string>;
}
export function buildNavigationGraph(doc: PrototypeDoc): NavigationGraph;
export type EdgeVerification = "static" | "dynamic" | "missing"; // precedence: static > dynamic > missing
export function verifyEdge(graph: NavigationGraph, from: string, to: string): EdgeVerification;
```

Рефакторинг `validate.ts`: инлайновое накопление `navigation` (:244, 457-461) → `buildNavigationGraph`; reachability (:505-513) без изменения сообщений/paths — существующие тесты проходят без правок. `getCjmTransitions` не трогаем.

### Валидация flows (warnings в `validatePrototype`)

- «flow step is not connected to the previous step by a navigate action» — пары с `verifyEdge === "missing"`; path `["flows", i, "steps", j, "screenId"]`.
- «flow has a single step».
- «flow step note on a main-flow anchor is not displayed».

## 3. Server / API

- `server/validationRecords.ts` — `VALIDATOR_VERSION = "v3"`; **комментарий переписать под audit-only семантику** (по ревью r2: текущий текст противоречит `latestValidatedRev`, который не фильтрует по версии) + тест, закрепляющий, что записи старых версий остаются учтёнными.
- `server/routes/meta.ts` `capabilities()` (:41-67): `features.flows: true`; `limits.flows/flowSteps/flowTotalSteps`.
- `server/contracts.ts`: `capabilitiesResponseSchema` (:997) и exact-assertions `server/contract.test.ts` (:205) — добавить поля вручную (контрактный parse иначе молча отбросит). Схемы create/save подхватят flows из `inputPrototypeDocSchema`.
- `src/prototype/revisionDiff.ts` (:235): flows — **отдельный diff-блок, исключённый из generic root-цикла** (без дублирующего «flows changed»); интеграция с `OMIT_PRIORITY`, leaf accounting и enum `omittedSections` в контракте (:603,675) — по ревью r2.
- OpenAPI: `npm run generate:openapi` + коммит `server/openapi.json`; `verify:openapi`.
- Миграций нет. **Rollback-политика**: откат образа ниже этой версии делает нечитаемыми ревизии с flows (strict-парсинг) — как все прошлые аддитивные поля v1. Эксплуатационное правило в `docs/server-api.md#deployment`: не публиковать flows-документы до подтверждения стабильности деплоя (первые часы rollback-window); дальше откат = откат данных на бэкап.

## 4. Целостность данных редактора — `src/editor/docDiff.ts`

`diffDocs` перечисляет корневые поля вручную (`DOC_FIELD_LABELS`, :88) — flows невидимы: CAS-конфликт с изменёнными только flows покажет «изменений нет» и overwrite их затрёт. Правка: **отдельный diff-блок flows, поле исключено из generic-цикла** (без двойного репорта); строки — `src/app/strings/editor.ts` (T1 ownership). Тесты: CAS-конфликт только по flows → diff непустой; smoke — редактирование несвязанного поля сохраняет flows нетронутыми (round-trip).

## 5. CJM: scenario lanes

### 5.1 Раскладка — новый чистый модуль `src/cjm/lanesLayout.ts` (без DOM)

```ts
export interface CjmNode { key: string; screenId: string; note?: string; column: number; lane: number; anchor: boolean }
export interface CjmEdge { key: string; from: string; to: string; kind: "main" | "fork" | "branch" | "return"; verified: EdgeVerification }
export interface CjmLane { key: string /* "flow:<id>" | "synthetic:main" | "synthetic:unassigned" */; name: string | null; description?: string; nodes: CjmNode[]; collapsed?: boolean }
export interface CjmLayout { lanes: CjmLane[]; edges: CjmEdge[]; columns: number; linear: boolean; tileCount: number }
export function computeCjmLanes(doc: PrototypeDoc, graph: NavigationGraph): CjmLayout;
```

Precondition: только распарсенный `PrototypeDoc` (schema-инварианты v1 гарантированы).

**Алгоритм (тотальный для всех schema-valid документов — по ревью r2):**
1. Без flows → `linear: true`, lane `synthetic:main` = `doc.screens`, рёбра `main`.
2. Lane 0 = `flows[0]`: node на шаг, `column = stepIndex`, рёбра `main`.
3. flows[k>0] — lane k, монотонный курсор: `cursor = -1`; якорный шаг → `cursor = max(cursor, anchorColumn)`; неякорный → `cursor += 1`, тайл в `column = cursor`. Схемные ограничения гарантируют: соседние пары шагов исчерпываются тремя случаями — якорь→тайл (`fork`), тайл→тайл (`branch`), тайл→якорь (`return`); anchor→anchor невозможен. **Инвариант: каждая пара соседних шагов даёт ровно одно ребро.** Благодаря неубыванию якорных индексов `return` ведёт к якорю с колонкой ≤ cursor, но ≥ колонки последнего пройденного якоря — backward-рёбра локальны.
4. Lane `synthetic:unassigned`: экраны вне всех flows, `column = 0..n-1` в порядке `doc.screens`, без рёбер; `collapsed: true` по умолчанию в flows-режиме (см. 5.2).
5. `tileCount` = все node (main + неякорные + unassigned) — для перф-бюджета.

Unit-инварианты: уникальность `(lane,column)` и node keys; каждое соседство шагов → ровно одно ребро с существующими endpoints; детерминизм; кейсы: ведущий сегмент без fork, flow без якорей (все тайлы 0..n-1), несколько сегментов, повтор якоря (`checkout→declined→checkout`), шаг = экрану другой ветки, note на якоре.

### 5.2 Рендер — `CjmView.tsx` + новые `CjmEdgesOverlay.tsx`, легенда

- `linear` → текущая разметка + `CjmConnector` без изменений (e2e `cjm.spec.ts` — без правок).
- С flows — **плоский grid**: один контейнер, тайлы с inline `gridRow`/`gridColumn`, колонка 0 — sticky-лейблы дорожек (имя + `description`). `data-cjm-node`, `data-screen-id`, `data-testid="cjm-lane-label"`.
- **Unassigned-дорожка collapsed по умолчанию** (заголовок с числом экранов, разворачивание монтирует тайлы) — ограничивает дефолтный рендер `Σ steps ≤ 200` (по ревью r2: unassigned не входит в лимит шагов). Перф-фикстура на верхней границе — в T6.
- `CjmScreenTile` переиспользуется; проп `noteOverride?: string`.
- `CjmEdgesOverlay`: absolute-SVG, координаты по `[data-cjm-node]` через общий ResizeObserver. **Маршрутизация (по ревью r2): рёбра начинаются/заканчиваются на границах тайлов (не центрах); fork/return идут ортогонально через межрядные/межколоночные жёлобы (gutters), не пересекая bounds чужих тайлов** (схемное неубывание якорей делает backward-сегменты короткими). `main`/`branch` — прямые между соседями (как сейчас). Стили по `verified` + легенда + `<title>`/hidden-список (см. «Семантика»). Атрибуты `data-edge-kind`, `data-verified`, `data-from/to`.
- **Ссылки тайлов**: тайл шага n дорожки k → плеер с `?flow=<flowId>&step=<n>` (идентичность вхождения — по ревью r2); linear-режим — без query.
- `src/styles/index.css`: grid + print-правила (текущий print знает только `.cjm-list`, :171).
- Строки `src/app/strings/cjm.ts`: лейблы дорожек, легенда, `unassignedLaneName`, `flowsCount(n)`, aria.

## 6. Плеер — ScenarioBar (guided browse)

`navigation.tsx`, `flowDepth`, `entryReason` не трогаем.

- Новый `src/player/ScenarioBar.tsx`:
  - активный сценарий — query `?flow=<id>`; опциональный `&step=<n>` задаёт начальный индекс, если `steps[n].screenId` совпадает с текущим экраном (иначе игнорируется); невалидный flow-id = отсутствие; `doc.flows === undefined` → `null`;
  - **обновление query сохраняет `location.state`** (голый `setSearchParams` даёт `state: null` → провайдер примет за bootstrap и сбросит сессию): helper `routerNavigate({search}, {replace: true, state: location.state})`; интеграционный тест с реальным `PlayerNavigationProvider`;
  - селект сценариев, «шаг X из N», prev/next → `goToScreen(steps[target].screenId)`;
  - индекс шага: состояние ключуется `${runtimeKey}:${flowId}` (`runtimeKey` уже есть в `PlayerShell` — пробросить через outlet context; `PlayerShell.tsx` в T5 ownership) и хранит `{lastConfirmed, pendingTarget}`. Prev/next выставляют `pendingTarget` явно; `&step=` инициализирует `lastConfirmed`; внешняя навигация — поиск вперёд от `lastConfirmed`, затем `indexOf`, иначе `null` («вне сценария», `lastConfirmed` сохраняется). Схемная уникальность неякорных шагов сводит остаточную неоднозначность к повторным якорям — детерминированное forward-правило документируется (индикация «неоднозначно» отклонена, см. триаж).
- Встраивание: `ScreenView.tsx` рядом с `FlowResetBanner` (~:256). `PrototypeChrome.tsx` (:47): ссылка Player↔CJM переносит `?flow` (без `step`).
- **Границы объёма + фактический срез (по ревью r2)**: `presentPath` в `ScreenView.tsx:102` сегодня переносит весь `location.search` — T5 добавляет query-helper, **удаляющий `flow`/`step` при входе в Present** (остальные параметры сохраняются); тест Player→Present→Esc. Share-whitelist (`server/share/repo.ts:189`) уже фильтрует — не трогаем. Present/share со сценариями — follow-up.

## 7. Тесты и фикстуры

- **Unit**: schema-flows (все ошибки v1-ограничений вкл. неубывание якорей, anchor-adjacency, total-лимит, `flows:[]`); `navigationGraph.test.ts` (static/dynamic/missing, `$if`); validate (missing-warning, подавление dynamic, note-на-якоре, регресс reachability); `lanesLayout.test.ts` (§5.1); `ScenarioBar.test.tsx` (pendingTarget/Prev при повторных якорях, `&step=`, смена flow, «вне сценария», сохранение location.state, **flow-переход с предшествующим setState открывает экран в текущем session state**); `docDiff` (CAS-тест + round-trip несвязанного редактирования); CjmShell (дорожки, `data-verified`, легенда, collapsed unassigned).
- **Server (bun test)**: POST/PUT с flows → 200/201 + warnings; 422 на каждое v1-ограничение; `contract.test.ts` exact-assertions; schema discovery содержит flows; revisionDiff по flows (отдельный блок, omit-priority); audit-only тест validationRecords; `verify:openapi`.
- **Capture-smoke**: скриншот экрана документа с flows идентичен документу без flows (`src/capture/CapturePrototype.tsx` flows не читает — закрепить).
- **Фикстура**: `test/fixtures/branching-checkout.json` — 3 flows (happy / отмена с возвратом к якорю / ошибка оплаты), удовлетворяет всем v1-ограничениям, реальные navigate-рёбра; done: `validatePrototype` errors И warnings пусты (fixture-glob suites: `validate.test.ts:353`, `layoutLints.test.ts:194`); регистрация в `provisionStarterFixtures` (`e2e/starter-ds.fixture.ts:142`).
- **e2e**: существующий `cjm.spec.ts` без правок; `cjm-flows.spec.ts`: дорожки, рёбра fork/return, **геометрия через `getPointAtLength(0/len)` — концы ребра лежат на границах тайлов-endpoints** (по ревью r2, bounding-box-пересечение недостаточно), дубль-тайл ветки, collapsed unassigned; `flow-scenario.spec.ts`: `?flow=&step=`, «шаг 1 из 3», next → шаг 2 без сброса сессии (нет FlowResetBanner), «вне сценария», CJM-тайл → плеер с активным flow и верным шагом, Player→Present→Esc без `flow` в Present-URL; перф-фикстура на границе лимитов рендерится без таймаута.

## 8. Исполнение (workflow CLAUDE.md)

Волны Codex-задач (`--fresh --write --effort medium`, без коммитов; коммитит оркестратор после независимой верификации).

**Волна 1:**
- **T1 Формат+граф+валидация+docDiff** — `src/prototype/schema.ts`, `src/prototype/navigationGraph.ts`, `src/prototype/validate.ts`, `src/editor/docDiff.ts`, `src/app/strings/editor.ts`, их тесты, `docs/prototype-format.md`. Done: typecheck + unit; reachability-тесты без правок; CAS + round-trip тесты.

**Волна 2 (после T1):**
- **T2 Фикстура** — `test/fixtures/branching-checkout.json`, `e2e/starter-ds.fixture.ts`. Done: validate полностью чист; fixture-glob suites зелёные.
- **T3 Server/API** — `server/validationRecords.ts`, `server/routes/meta.ts`, `server/contracts.ts`, `server/contract.test.ts`, `src/prototype/revisionDiff.ts` (+тесты), `server/openapi.json`, `docs/server-api.md`. Done: `server:test` + `verify:openapi`.
- **T4 CJM** — `src/cjm/lanesLayout.ts(+test)`, `CjmEdgesOverlay.tsx`, `CjmView.tsx`, `CjmScreenTile.tsx` (`noteOverride` + ссылка `flow&step`), `CjmShell.test.tsx`, `src/app/strings/cjm.ts`, `src/styles/index.css`. Done: unit-инварианты; `cjm.spec.ts` без правок зелёный.
- **T5 Плеер** — `src/player/ScenarioBar.tsx(+test)`, `ScreenView.tsx` (встраивание + present-query-helper), `PlayerShell.tsx` (runtimeKey в context), `src/app/PrototypeChrome.tsx`, `src/app/strings/player.ts`. Done: unit вкл. state-preservation и present-strip; документы без flows — DOM без изменений.

**Волна 3 (после T2+T3+T4+T5 — по ревью r2, T6 гоняет полный verify и зависит и от T3):**
- **T6 e2e + перф** — `e2e/dev/cjm-flows.spec.ts`, `e2e/dev/flow-scenario.spec.ts`, перф-фикстура. Done: Playwright dev-проект зелёный; `npm run verify` целиком.

Пересечений внутри волн нет. Финальная верификация оркестратором: `npm run verify` + `npm run e2e` + runtime-прогон по `/verify`.

## Триаж ревью r1 (Codex gpt-5.6-sol, 2026-07-16)

| # | Находка | Решение |
|---|---|---|
| B1 | flows — второй источник правды | Принято частично: verifyEdge + визуальное различие; severity warning (flows — аннотация). r2 подтвердил при guided-browse семантике |
| B2 | ScenarioBar не воспроизводит state | Принято через переопределение: guided browse. r2 указал на ложное обоснование через stateOverrides — исправлено в v3 (честная фиксация: текущий session state) |
| B3 | branch-from-branch, повторы, неоднозначные якоря | Принято: сужение v1; в v3 дожато схемными ошибками (см. триаж r2 №1,2,4) |
| B4 | коллизии колонок | Принято: monotonic cursor; в v3 дожато тотальностью и маршрутизацией (r2 №1,3) |
| B5 | docDiff слеп к flows | Принято: docDiff+revisionDiff+contracts; в v3 — отдельные diff-блоки без дублей (r2 №10) |
| M6–M9, M11, M14–M16, m18–m20 | — | Принято, r2 подтвердил закрытие |
| M10 | Present/share | Граница объёма; в v3 добавлен фактический срез `flow` из presentPath (r2 №8) |
| M12 | VALIDATOR_VERSION | Audit-only; в v3 — правка комментария + тест (r2 №11) |
| M13 | rollback при strict-парсинге | Без v2-bump; в v3 — эксплуатационное правило rollback-window (r2 №11) |
| M17 | лимиты | 12×50/Σ200; в v3 — collapsed unassigned + tileCount + перф-фикстура (r2 №7) |

## Триаж ревью r2 (resume того же треда, 2026-07-17)

| # | Находка | Решение |
|---|---|---|
| 1 (blocker) | layout не тотален: anchor→anchor, anchor-only ветки, columns unassigned | **Принято**: схемные ошибки (соседние якоря запрещены, ≥1 неякорный шаг) + columns unassigned 0..n-1 + инвариант «пара шагов → ровно одно ребро». Edge kind для anchor→anchor отклонён (аддитивно выразимо позже) |
| 2 (blocker) | `?flow=` не идентифицирует повторное вхождение | **Принято**: `&step=<n>` в ссылках тайлов + схемная уникальность неякорных шагов внутри flow. Индикация «вхождение неоднозначно» отклонена: остаточная неоднозначность только у повторных якорей при внешней навигации, детерминированное forward-правило документируется |
| 3 (major) | backward-рёбра пересекают тайлы, нет routing | **Принято**: схемное неубывание якорных индексов (длинный backward невозможен) + ортогональная маршрутизация в жёлобах, старт/финиш на границах тайлов, инвариант непересечения чужих bounds |
| 4 (major) | «любой main-screen — якорь» неявно и узко | **Принято частично**: переименовано в «scenario lanes относительно канонического main», конвенция задокументирована; `anchorRef`/`forkFrom` отклонены (v2-расширение) |
| 5 (major) | обоснование через stateOverrides ложно | **Принято**: текст исправлен (текущий session state), закрепляющий тест добавлен |
| 6 (major) | UX verifyEdge недообъяснён | **Принято**: precedence, легенда, три стиля, `<title>` + hidden-список, пользовательские формулировки |
| 7 (major) | Σ200 не ограничивает тайлы (unassigned) | **Принято**: collapsed unassigned по умолчанию + `tileCount` + перф-фикстура. Глобальный лимит screens отклонён (сломал бы legacy) |
| 8 (major) | presentPath утекает `flow` в Present | **Принято**: query-helper среза в T5 + тест Player→Present→Esc |
| 9 (major) | DAG/ownership: T6 без T3; runtimeKey; editor strings | **Принято**: T6 после T2–T5; `PlayerShell.tsx` в T5 (runtimeKey через context); `strings/editor.ts` в T1 |
| 10 (minor) | дубль generic+секция в diff; omit-plumbing | **Принято**: flows исключены из generic-цикла; интеграция с OMIT_PRIORITY/leaf/enum |
| 11 (minor) | комментарий validationRecords; rollback-критерий | **Принято**: комментарий+тест audit-only; правило rollback-window вместо «отката на бэкап» |
| 12 (minor) | e2e-геометрия слаба; capture/editor smoke | **Принято**: `getPointAtLength`-проверка концов; editor round-trip; capture-smoke |

## Риски

- Конвергенция между ветками не визуализируется; branch-from-branch не выражается — осознанное сужение v1 (аддитивно расширяемо: `forkFrom`, edge-аннотации).
- Rollback ниже этой версии при опубликованных flows-документах — правило rollback-window (§3).
- List API (`headScreens`) не включает flows — YAGNI.
