# Нелинейные прототипы: `doc.flows` + дорожки-ветки в CJM + сценарии в плеере (v2)

## Контекст

Сейчас модель прототипа плоская: `screens[]` + `startScreen`; CJM (`src/cjm/CjmView.tsx`) — линейная лента тайлов в порядке массива, стрелки между соседями декоративные («does not encode a flow edge»). Реальный граф переходов существует только неявно — через `navigate`-действия — и материализуется лишь как reachability-проверка в валидаторе (`src/prototype/validate.ts:244,455-462,505-513`). Нелинейные прототипы (ветвления: happy path / отказ / возврат) невозможно ни выразить, ни увидеть.

Решения, согласованные с пользователем:
- **Гибридная модель**: рёбра выводятся из `navigate`-действий, автор поверх задаёт именованные сценарии `doc.flows` — пути по экранам, валидируемые против графа.
- **CJM — дорожки-ветки**: главная лента = первый flow, ответвления на дорожках ниже с точками расхождения/возврата.
- **Охват**: формат + валидация + server API, CJM-рендер, плеер (индикатор/навигация по шагам). Редактор-UI — вне объёма (инспектор actions остаётся read-only), но целостность данных редактора (docDiff) — в объёме.

## Семантика (уточнено после ревью r1)

**Flows — авторская аннотация-путеводитель поверх прототипа, не исполняемый сценарий.**
- Рёбра поведения по-прежнему задаются только `navigate`-действиями. Flows ничего не добавляют в runtime.
- **ScenarioBar в плеере — guided browse**: prev/next делают тот же browse-прыжок (`goToScreen`), что и существующий `ScreensSidebar`, который уже позволяет открыть любой экран напрямую. Плейбек action-цепочек (setState перед navigate) сознательно не воспроизводится — за презентабельность экрана «сам по себе» отвечают `screen.stateOverrides` (существующий механизм, компоненты оборонительные). Это фиксируется в `docs/prototype-format.md` и в UI-копирайте («перейти к шагу», не «выполнить переход»).
- **Верификация ребра шага — трёхсостоянийная**: `static` (есть статическое navigate-ребро) | `dynamic` (источник имеет navigate с динамическим `screenId` — непроверяемо) | `missing`. `missing` → validation warning И визуально отличимое ребро в CJM (пунктир, приглушённый цвет, `data-verified="false"`, aria «переход не подтверждён navigate-действием»). CJM не выдаёт неподтверждённое ребро за реальное.

**Ограничения модели v1 (явное сужение, ошибки валидации):**
- `flows[0]` — главный сценарий; `flows[0].steps[0].screenId === doc.startScreen` (**error**).
- Внутри `flows[0]` все `screenId` уникальны (**error**) — главная дорожка ациклична, edge kind `loop-back` не существует.
- Ветки (flows[1..]) якорятся **только** на экраны главного flow; шаг ветки, совпадающий с экраном другой ветки, всегда рендерится собственным тайлом (конвергенция между ветками не визуализируется — осознанное упрощение v1). Branch-from-branch не выражается — расширение отложено (потребует `forkFrom`/идентичности вхождения).
- `step.note` отображается только на шагах, создающих собственный тайл; на якорных шагах игнорируется (документируется; на будущее — аннотации на рёбрах).

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

В `refinePrototypeDoc` (schema.ts:71) — структурные ошибки:
- уникальность `flow.id`;
- `step.screenId ∈ screens`;
- соседние шаги не равны;
- `flows[0].steps[0].screenId === startScreen`;
- уникальность `screenId` внутри `flows[0]`;
- `Σ steps ≤ FLOW_TOTAL_STEPS_LIMIT` (лимиты снижены после ревью: каждый неякорный шаг = отдельный CjmScreenTile с изолированным store, см. риски).

Экспорт `Flow`, `FlowStep`, лимитов. Документация: `docs/prototype-format.md` — раздел «Flows (named scenarios)»: семантика guided-browse, трёхсостоянийная верификация, ограничения v1, лимиты, совместимость; `docs/server-api.md` — пример capabilities + **rollback-заметка** (см. §3).

## 2. Статический navigate-граф — новый `src/prototype/navigationGraph.ts`

Явно именуется «статически выведенный navigate-граф» (не «реальный граф навигации»: `back`/`restart`/динамические таргеты в него не входят — это фиксируется в doc-комментарии модуля).

```ts
export interface NavigationGraph {
  edges: ReadonlyMap<string, ReadonlySet<string>>;   // статические navigate-рёбра (включая под $if — потенциальные)
  dynamicSources: ReadonlySet<string>;               // экраны с navigate с динамическим screenId
}
export function buildNavigationGraph(doc: PrototypeDoc): NavigationGraph;
export type EdgeVerification = "static" | "dynamic" | "missing";
export function verifyEdge(graph: NavigationGraph, from: string, to: string): EdgeVerification;
```

Рефакторинг `validate.ts`: убрать инлайновое накопление `navigation` (строки 244, 457-461), reachability-блок (505-513) перевести на `buildNavigationGraph` — сообщения/paths не меняются, существующие тесты валидатора проходят без правок. `getCjmTransitions` в `CjmScreenTile.tsx` не трогаем.

### Валидация flows (в `validatePrototype`)

- **warning** «flow step is not connected to the previous step by a navigate action» — для пар с `verifyEdge === "missing"` (`dynamic` не warning'уется, но и не считается подтверждением); path `["flows", i, "steps", j, "screenId"]`.
- **warning** «flow has a single step».
- **warning** «flow step note on a main-flow anchor is not displayed» — note на якорном шаге ветки.
- (startScreen/уникальность в main — errors на уровне схемы, здесь не дублируются.)

## 3. Server / API

- `server/validationRecords.ts:6` — `VALIDATOR_VERSION = "v3"`. **Явно фиксируется: это audit-метаданные записей валидации, не механизм ревалидации** — `latestValidatedRev` не фильтрует по версии, и это сохраняемое поведение (общая версия prototype/component; ревалидация старых записей вне объёма).
- `server/routes/meta.ts` `capabilities()` (:41-67): `features.flows: true`; `limits.flows/flowSteps/flowTotalSteps`.
- **`server/contracts.ts`** (по ревью): `capabilitiesResponseSchema` (:997) перечисляет limits/features вручную — добавить новые поля туда И в exact-assertions `server/contract.test.ts` (:205), иначе контрактный parse молча отбросит поля. Схемы create/save подхватят flows из `inputPrototypeDocSchema` автоматически.
- **`src/prototype/revisionDiff.ts`** (:235) и его контракт в `contracts.ts` (:603): добавить секцию diff по flows (added/removed/renamed flow, изменение steps — компактно: «flow "happy": steps changed»), иначе ревизии с изменёнными flows дают `docIdentical: false` без объяснения.
- OpenAPI: `npm run generate:openapi`, закоммитить `server/openapi.json`; дрифт держит `verify:openapi`.
- Миграций нет. **Rollback-политика (по ревью)**: optional-поле на strict-парсинге означает, что откат образа на версию до flows сделает нечитаемыми ревизии, опубликованные с flows, — так же, как все прошлые аддитивные поля v1 (`note`, `canvas`, `stateOverrides`). Фиксируется абзацем в `docs/server-api.md#deployment`: откат ниже этой версии требует отката данных на бэкап или отсутствия flows-публикаций.

## 4. Целостность данных редактора — `src/editor/docDiff.ts` (по ревью, blocker)

`diffDocs` перечисляет корневые поля вручную (`DOC_FIELD_LABELS`, :88) — изменения `flows` сейчас невидимы: CAS-конфликт, где remote поменял только flows, показал бы «изменений нет», и overwrite затёр бы их. Правка:
- `flows` в `DOC_FIELD_LABELS` + компактная секция diff (по аналогии со screens): добавлен/удалён/переименован flow, изменены шаги.
- Тест: CAS-конфликт с расхождением только по flows → diff непустой.

## 5. CJM-дорожки

### 5.1 Раскладка — новый чистый модуль `src/cjm/lanesLayout.ts` (без DOM)

```ts
export interface CjmNode { key: string; screenId: string; note?: string; column: number; lane: number; anchor: boolean }
export interface CjmEdge { key: string; from: string; to: string; kind: "main" | "fork" | "branch" | "return"; verified: EdgeVerification }
export interface CjmLane { key: string /* "flow:<id>" | "synthetic:main" | "synthetic:unassigned" */; name: string | null; description?: string; nodes: CjmNode[] }
export interface CjmLayout { lanes: CjmLane[]; edges: CjmEdge[]; columns: number; linear: boolean }
export function computeCjmLanes(doc: PrototypeDoc, graph: NavigationGraph): CjmLayout;
```

Precondition: только распарсенный `PrototypeDoc` (schema-инварианты гарантированы; «пустой main» невозможен и не обрабатывается).

**Формальный алгоритм размещения (по ревью, детерминированный, без коллизий):**
1. Без flows → `linear: true`, lane `synthetic:main` = `doc.screens`, рёбра `main` — точная деградация.
2. Lane 0 = `flows[0]`: node на каждый шаг, `column = stepIndex` (шаги уникальны — коллизий нет), рёбра `main`.
3. Каждый flows[k>0] — lane k. Один проход по шагам с **монотонным курсором**: `cursor = -1`; шаг-якорь (screenId ∈ main) → `cursor = max(cursor, anchorColumn)`, тайл не создаётся; неякорный шаг → `cursor += 1`, тайл в `column = cursor`. Инварианты: колонки внутри lane строго возрастают, `(lane, column)` уникальна, ведущий сегмент без fork начинается с column 0, flow без якорей — columns 0..n-1.
4. Рёбра ветки: `fork` (якорь → следующий неякорный шаг), `branch` (тайл → тайл), `return` (тайл → якорь). Каждое ребро несёт `verified` из `verifyEdge`. Возврат к якорю левее текущей колонки — стрелка назад-вверх (осознанно, колонки main не раздвигаются).
5. Экраны вне всех flows — lane `synthetic:unassigned`, без рёбер.

Unit-инварианты: уникальность `(lane,column)` и node keys, существование endpoints всех рёбер, детерминизм, кейсы: ведущий сегмент, flow без якорей, несколько сегментов, шаг = экрану другой ветки (свой тайл), note на якоре не создаёт node-note.

### 5.2 Рендер — `src/cjm/CjmView.tsx` + новый `src/cjm/CjmEdgesOverlay.tsx`

- `layout.linear` → текущая разметка `<ol className="cjm-list">` + `CjmConnector` без изменений (существующие e2e `cjm.spec.ts` — без правок).
- С flows — **плоский grid** (по ревью, без subgrid): один grid-контейнер, каждый тайл-обёртка получает inline `gridRow`/`gridColumn` (+1 колонка под sticky-лейблы дорожек: имя flow + `description` подзаголовком). Атрибуты: `data-cjm-node="<key>"`, `data-screen-id`, `data-testid="cjm-lane-label"`.
- `CjmScreenTile` переиспользуется; единственное расширение — проп `noteOverride?: string` (`step.note ?? screen.note` для тайл-создающих шагов).
- `CjmEdgesOverlay`: один absolute-SVG на grid-контейнер, координаты по `querySelectorAll('[data-cjm-node]')` через общий ResizeObserver (обобщение паттерна `CjmConnector`, CjmView.tsx:26-69). Стили рёбер: `verified: "static"` — сплошная (как сейчас), `"dynamic"`/`"missing"` — пунктир + приглушение (missing дополнительно с warning-цветом). Атрибуты `data-testid="cjm-edge"`, `data-edge-kind`, `data-verified`, `data-from/to`.
- **Ссылки тайлов** (по ревью): тайл дорожки k открывает плеер с `?flow=<flowId>`; linear-режим — без query. `src/styles/index.css`: print-стили знают только `.cjm-list` (:171) — добавить print-правила для grid/overlay (T4 ownership).
- Строки `src/app/strings/cjm.ts`: лейблы дорожек, `unassignedLaneName`, `flowsCount(n)`, aria неподтверждённого ребра; чип «N сценариев» в metadata.

## 6. Плеер — ScenarioBar (guided browse)

`navigation.tsx`, `flowDepth`, `entryReason` не трогаем.

- Новый `src/player/ScenarioBar.tsx`:
  - активный сценарий — query `?flow=<id>`; невалидный id = отсутствие; `doc.flows === undefined` → `null`;
  - **обновление query сохраняет location.state** (по ревью: голый `setSearchParams` даёт `state: null` → провайдер примет за bootstrap и сбросит сессию): helper делает `routerNavigate({search}, { replace: true, state: location.state })`; интеграционный тест с реальным `PlayerNavigationProvider`;
  - селект сценариев, «шаг X из N», prev/next → `goToScreen(steps[target].screenId)`;
  - **индекс шага** (по ревью): состояние ключуется `${revisionKey}:${flowId}` и хранит `{ lastConfirmed: number | null, pendingTarget: number | null }`. Prev/next выставляют `pendingTarget` явно — эвристика не участвует; при смене экрана: если `pendingTarget` совпадает по screenId → подтвердить его; иначе внешняя навигация → поиск вперёд от `lastConfirmed`, затем `indexOf`, иначе `null` («вне сценария» + кнопка «к шагу 1»; `lastConfirmed` сохраняется для возврата). Смена `?flow` сбрасывает состояние (новый ключ).
- Встраивание: `src/player/ScreenView.tsx` рядом с `FlowResetBanner` (~:256). `PrototypeChrome.tsx` (:47): ссылка Player↔CJM переносит `?flow` (T5 ownership).
- **Границы объёма (по ревью, явно)**: `?flow` живёт только в аутентифицированном player-виде. Desktop/mobile Present (`PresentShell` листает по `doc.screens`) и share-ссылки (whitelist query в `server/share/repo.ts:189` пропускает только `mobile`) flow не переносят — зафиксированный follow-up, не баг этой итерации.

## 7. Тесты и фикстуры

- **Unit**: schema-flows (лимиты вкл. total, дубли id, несуществующий экран, соседние дубли, startScreen-правило, уникальность в main); `navigationGraph.test.ts` (static/dynamic/missing, `$if`-рёбра как static); validate (warnings missing-ребра, подавление dynamic, note-на-якоре; регресс reachability); `lanesLayout.test.ts` (инварианты и кейсы из §5.1 + linear-деградация); `ScenarioBar.test.tsx` (pendingTarget/Prev при повторах, смена flow, «вне сценария», сохранение location.state); `docDiff` CAS-тест; CjmShell — дорожки, `data-verified`.
- **Server (bun test)**: POST/PUT с flows → 200/201 + warnings; 422 на битые flows (вкл. startScreen-правило); `contract.test.ts` exact-assertions capabilities; schema `prototype-document.json` содержит flows; revisionDiff по flows; `verify:openapi`.
- **Фикстура**: `test/fixtures/branching-checkout.json` — 3 flows (happy / отмена с возвратом / ошибка оплаты) с реальными navigate-рёбрами; done-критерий: `validatePrototype` errors И warnings пусты (фикстуры автоматически попадают в fixture-glob suites `validate.test.ts:353`, `layoutLints.test.ts:194`); регистрация в `provisionStarterFixtures` (`e2e/starter-ds.fixture.ts:142`).
- **e2e**: существующий `cjm.spec.ts` без правок; `cjm-flows.spec.ts`: дорожки, рёбра fork/return присутствуют И геометрия осмысленна (bounding box ребра пересекает оба тайла-endpoint'а), дубль-тайл ветки; `flow-scenario.spec.ts`: `?flow=`, «шаг 1 из 3», next → шаг 2 и сессия не сброшена (нет FlowResetBanner), «вне сценария», переход CJM-тайл → плеер с активным flow.

## 8. Исполнение (workflow CLAUDE.md)

Волны Codex-задач (`--fresh --write --effort medium`, без коммитов; коммитит оркестратор после независимой верификации):

**Волна 1:**
- **T1 Формат+граф+валидация+docDiff** — `src/prototype/schema.ts`, `src/prototype/navigationGraph.ts`, `src/prototype/validate.ts`, `src/editor/docDiff.ts`, их тесты, `docs/prototype-format.md`. Done: typecheck + unit зелёные; reachability-тесты без правок; CAS-тест flows.

**Волна 2 (после T1):**
- **T2 Фикстура** — `test/fixtures/branching-checkout.json`, `e2e/starter-ds.fixture.ts`. Done: `validatePrototype` errors+warnings пусты; fixture-glob suites зелёные. (Сдвинута после T1: фикстура с flows не парсится схемой до T1.)
- **T3 Server/API** — `server/validationRecords.ts`, `server/routes/meta.ts`, `server/contracts.ts`, `server/contract.test.ts`, `src/prototype/revisionDiff.ts` (+тесты), `server/openapi.json` (regen), `docs/server-api.md`. Done: `server:test` + `verify:openapi` зелёные.
- **T4 CJM** — `src/cjm/lanesLayout.ts(+test)`, `CjmEdgesOverlay.tsx`, `CjmView.tsx`, `CjmScreenTile.tsx` (`noteOverride` + flow-query в ссылке), `CjmShell.test.tsx`, `src/app/strings/cjm.ts`, `src/styles/index.css` (grid+print). Done: unit-инварианты layout; `e2e/dev/cjm.spec.ts` без правок зелёный.
- **T5 Плеер** — `src/player/ScenarioBar.tsx(+test)`, `ScreenView.tsx`, `src/app/PrototypeChrome.tsx`, `src/app/strings/player.ts`. Done: unit вкл. state-preservation тест; документы без flows — DOM без изменений.

**Волна 3 (после T2+T4+T5):**
- **T6 e2e** — `e2e/dev/cjm-flows.spec.ts`, `e2e/dev/flow-scenario.spec.ts`. Done: Playwright dev-проект зелёный; `npm run verify` целиком.

Пересечений внутри волн нет (cjm-строки/стили → T4; player/chrome → T5; contracts/revisionDiff → T3). Финальная верификация оркестратором: `npm run verify` + `npm run e2e` + runtime-прогон по `/verify`.

## Триаж ревью r1 (Codex gpt-5.6-sol, 2026-07-16)

| # | Находка | Решение |
|---|---|---|
| B1 | flows — второй источник правды; missing-рёбра рисуются как реальные | **Принято частично**: трёхсостоянийный `verifyEdge`, missing/dynamic визуально отличимы (`data-verified`); severity остаётся warning — flows аннотация, публикацию не блокирует; ScenarioBar = browse (см. B2). Error отклонён: заблокировал бы легитимное авторинг-состояние |
| B2 | ScenarioBar не воспроизводит state (setState перед navigate) | **Принято через переопределение семантики**: guided browse, эквивалент прыжков существующего ScreensSidebar; презентабельность экрана — зона `screen.stateOverrides`. Плейбек action-цепочек отклонён (несоразмерная сложность v1) |
| B3 | branch-from-branch, повторы main-экранов, неоднозначные якоря | **Принято**: сужение v1 — main ацикличен (error), якоря только на main, cross-branch = свой тайл; `loop-back` удалён |
| B4 | коллизии колонок, недоопределённый placement | **Принято**: формальный monotonic-cursor алгоритм + unit-инварианты |
| B5 | docDiff слеп к flows — тихая потеря при CAS | **Принято**: flows в docDiff + revisionDiff + контракты, CAS-тест; в T1/T3 |
| M6 | flows[0] может не начинаться со startScreen | **Принято**: error на уровне схемы |
| M7 | индекс ScenarioBar некорректен для Prev/смены flow | **Принято**: явный `pendingTarget`, ключевание по flowId |
| M8 | смена query сбрасывает player-сессию (state: null → bootstrap) | **Принято**: navigate с сохранением `location.state`, интеграционный тест |
| M9 | flow-query теряется между CJM и плеером | **Принято**: тайлы дорожек несут `?flow=`, PrototypeChrome переносит query |
| M10 | Present/share игнорируют flow | **Принято как граница объёма**: `?flow` только в player-виде; Present/share — зафиксированный follow-up. Расширение объёма отклонено |
| M11 | capabilitiesResponseSchema/contract.test не обновятся сами | **Принято**: contracts.ts + contract.test.ts в T3 |
| M12 | bump VALIDATOR_VERSION ничего не меняет / общий с components | **Принято частично**: версия явно объявлена audit-метаданными; фильтрация/ревалидация отклонена (вне объёма, отдельная задача) |
| M13 | strict-парсинг ломает rollback | **Принято частично**: rollback-заметка в docs/server-api.md; bump до v2 отклонён — прецедент аддитивных полей v1 (note/canvas/stateOverrides) шёл так же, политика формата задокументирована |
| M14 | граф ≠ реальная навигация (back/restart, $if, dynamic-wildcard) | **Принято**: имя «статически выведенный navigate-граф», dynamic ≠ подтверждение (трёхсостоянийность), $if-рёбра — потенциальные static |
| M15 | grid/subgrid/print недоопределены | **Принято**: плоский grid с inline row/col, styles+print в T4 |
| M16 | note на якоре теряется; description не используется | **Принято**: note только на тайл-шагах + warning; description — подзаголовок лейбла дорожки |
| M17 | лимиты 24×100 нереалистичны для eager-рендера | **Принято**: 12×50 + суммарный лимит 200 шагов (error). Lazy-mount/виртуализация отклонены (v2 при необходимости) |
| m18 | коллизия lane id с пользовательскими slug | **Принято**: namespace `flow:` / `synthetic:` |
| m19 | «пустая main» — невозможное состояние | **Принято**: precondition в контракте computeCjmLanes, тест `flows:[]` в schema |
| m20 | фикстура T2 попадает в glob-suites T1 | **Принято**: T2 сдвинута в волну 2, done = validate полностью чист |

## Риски

- Длинная ветка «правее» точки возврата — стрелка назад-вверх; раздвижение колонок main — фаза 2.
- Конвергенция между ветками не визуализируется (свой тайл) — осознанное сужение v1.
- Rollback ниже этой версии при опубликованных flows-документах требует отката данных (см. §3).
- List API (`headScreens`) не включает flows — осознанно (YAGNI).
