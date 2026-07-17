# Нелинейные прототипы: `doc.flows` + scenario lanes в CJM + guided browse в плеере (v4)

## Контекст

Сейчас модель прототипа плоская: `screens[]` + `startScreen`; CJM (`src/cjm/CjmView.tsx`) — линейная лента тайлов, стрелки декоративные. Реальный граф переходов существует только неявно — через `navigate`-действия — и материализуется лишь как reachability-проверка в валидаторе (`src/prototype/validate.ts:244,455-462,505-513`). Нелинейные прототипы (happy path / отказ / возврат) невозможно ни выразить, ни увидеть.

Решения, согласованные с пользователем: **гибридная модель** (рёбра из `navigate`, авторские `doc.flows` поверх, валидируемые против графа), **CJM — дорожки-ветки**, охват: формат+валидация+API, CJM, плеер; редактор-UI вне объёма, целостность docDiff — в объёме.

**Фундаментальное решение (r3): flows — полные end-to-end сценарии** («Успешная оплата»: `catalog → cart → payment → success`; «Отказ банка»: `cart → checkout → declined → checkout`), а не фрагменты отклонений. Общие с main участки, возвраты на предыдущие этапы и retry-петли выразимы. Позиционирование: «scenario lanes относительно канонического главного сценария»; идентичность якоря по `screenId` — конвенция v1, `forkFrom` — отложенное расширение.

## Семантика

**Flows — авторская аннотация-путеводитель, не исполняемый сценарий.**
- Рёбра поведения задаются только `navigate`-действиями; flows ничего не добавляют в runtime.
- **ScenarioBar — guided browse**: prev/next — тот же browse-прыжок (`goToScreen`), что у `ScreensSidebar`. **Экран открывается в текущем session state плеера; промежуточные actions не исполняются, `screen.stateOverrides` плеер не применяет** (закрепляется тестом: flow-переход с предшествующим setState). Фиксируется в `docs/prototype-format.md` и UI-копирайте.
- **Верификация ребра**: `static` (navigate объявлен, в т.ч. под `$if`) | `dynamic` (динамический `screenId` — непроверяемо) | `missing`; precedence `static > dynamic > missing`. UX: три канала различия — сплошная линия / пунктир `6 4` / пунктир `2 4` + warning-цвет + маркер «!» на середине ребра (не только цвет — по ревью r3); легенда рёбер; `<title>` на SVG-рёбрах + visually-hidden список рёбер дорожки.

**Ограничения модели v1 (ошибки на уровне схемы):**
1. `flows[0]` — главный сценарий; `flows[0].steps[0].screenId === doc.startScreen`; внутри `flows[0]` все `screenId` уникальны (канонический ацикличный хребет).
2. «Якорь» = шаг ветки, чей `screenId` ∈ `flows[0]`. Соседние якорные шаги **разрешены, только если их экраны соседние в main в прямом направлении** (индексы `i → i+1`); репрезентация такой пары — существующее main-ребро (нового ребра не рисуется). Прямой anchor→anchor shortcut между несоседними по main экранами и прямой backward anchor→anchor — **error** («вставьте промежуточный экран или измените main»). Это единственное структурное ограничение против невыразимой геометрии.
3. Повторы неякорных `screenId` внутри flow **разрешены** (идентичность вхождения — `(flowId, stepIndex)`, в URL `&step=`); запрещены только равные соседние шаги.
4. `step.note` отображается на шагах с собственным тайлом; на якорных шагах — warning «не отображается».
5. Branch-from-branch и конвергенция между ветками не выражаются (шаг = экрану другой ветки → собственный тайл).

Валидность канонических сценариев (проверка от r3): checkout-declined `catalog,cart,delivery,payment,declined,payment,success` ✓; KYC-коррекция `profile,documents,review,missing-document,documents,review,approved` ✓ (backward-возврат через тайл); MFA-retry `password,otp,invalid-code,otp,dashboard` ✓ (повтор неякоря).

## 1. Формат — `src/prototype/schema.ts`

```ts
export const FLOWS_LIMIT = 12;
export const FLOW_STEPS_LIMIT = 50;
export const FLOW_TOTAL_STEPS_LIMIT = 200;

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

`refinePrototypeDoc` (schema.ts:71): уникальность `flow.id`; `step.screenId ∈ screens`; равные соседние шаги; правила 1–2 из «Ограничений v1» (все вычислимы против `flows[0]`); `Σ steps ≤ FLOW_TOTAL_STEPS_LIMIT`; `flows: []` отклоняется `min(1)`. Экспорт `Flow`, `FlowStep`, лимитов. Документация: `docs/prototype-format.md` («Flows (scenario lanes)»), `docs/server-api.md` (capabilities + rollback, §3).

## 2. Статический navigate-граф — новый `src/prototype/navigationGraph.ts`

Doc-комментарий: «статически выведенный navigate-граф»; `back`/`restart`/динамические таргеты не входят.

```ts
export interface NavigationGraph {
  edges: ReadonlyMap<string, ReadonlySet<string>>;
  dynamicSources: ReadonlySet<string>;
}
export function buildNavigationGraph(doc: PrototypeDoc): NavigationGraph;
export type EdgeVerification = "static" | "dynamic" | "missing";
export function verifyEdge(graph: NavigationGraph, from: string, to: string): EdgeVerification;
```

Рефакторинг `validate.ts`: инлайновая `navigation` (:244,457-461) → `buildNavigationGraph`; reachability (:505-513) без изменения сообщений/paths (существующие тесты — без правок). `getCjmTransitions` не трогаем.

Warnings flows в `validatePrototype`: «flow step is not connected…» (`missing`), «flow has a single step», «note on a main-flow anchor is not displayed».

## 3. Server / API

- `server/validationRecords.ts` — `VALIDATOR_VERSION = "v3"`; комментарий переписать под audit-only (текущий противоречит `latestValidatedRev`) + закрепляющий тест.
- `server/routes/meta.ts` (:41-67): `features.flows: true`; `limits.flows/flowSteps/flowTotalSteps`.
- `server/contracts.ts` (:997) + exact-assertions `server/contract.test.ts` (:205) — поля вручную.
- `src/prototype/revisionDiff.ts` (:235): flows — отдельный diff-блок вне generic-цикла; интеграция с `OMIT_PRIORITY`, leaf accounting, enum `omittedSections` (:603,675).
- OpenAPI: `npm run generate:openapi` + коммит; `verify:openapi`.
- Миграций нет. **Rollback-политика** (уточнено r3: POST/PUT персистят ревизию до publish): в течение rollback-window не **персистить любую ревизию** с flows (create/save/restore) — иначе старый образ не прочитает документ; правило в `docs/server-api.md#deployment`, после окна откат = откат данных на бэкап.

## 4. Целостность данных редактора — `src/editor/docDiff.ts`

`diffDocs` перечисляет корневые поля вручную (:88) — flows невидимы: CAS-конфликт только по flows покажет «изменений нет», overwrite затрёт. Правка: отдельный diff-блок flows вне generic-цикла; строки — `src/app/strings/editor.ts`. Тесты: CAS-конфликт по flows; round-trip несвязанного редактирования сохраняет flows.

## 5. CJM: scenario lanes

### 5.1 Раскладка — чистый модуль `src/cjm/lanesLayout.ts` (без DOM)

```ts
export interface CjmNode { key: string /* "<laneKey>:<stepIndex>" */; screenId: string; note?: string; column: number; lane: number; anchor: boolean }
export interface CjmEdge { key: string; from: string; to: string; kind: "main" | "fork" | "branch" | "return"; verified: EdgeVerification }
export interface CjmLane { key: string /* "flow:<id>" | "synthetic:main" */; name: string | null; description?: string; nodes: CjmNode[] }
export interface CjmLayout {
  lanes: CjmLane[]; edges: CjmEdge[]; columns: number; linear: boolean;
  unassigned: string[]; // screenIds вне flows — отдельная секция, НЕ колонки grid (по ревью r3)
  tileCount: number;
}
export function computeCjmLanes(doc: PrototypeDoc, graph: NavigationGraph): CjmLayout;
```

Precondition: только распарсенный `PrototypeDoc`.

**Алгоритм (тотальный; вставка колонок — по ревью r3, сегменты живут между якорями):**
1. Без flows → `linear: true`, lane `synthetic:main` = `doc.screens`, рёбра `main`.
2. Разбор веток на **сегменты**: максимальные последовательности неякорных шагов; сегмент имеет fork-якорь (предыдущий шаг; отсутствует у ведущего сегмента) и return-якорь (следующий шаг; отсутствует у хвостового).
3. **Ширина промежутков main**: сегмент приписывается к промежутку `(i, i+1)` после main-индекса `i` его fork-якоря (ведущий сегмент — к промежутку перед main-индексом return-якоря; flow без якорей — к промежутку перед колонкой 0). Ширина промежутка = max длины приписанных сегментов (минимум 0). Колонка main-экрана `m` = `m + Σ ширин промежутков левее`.
4. Lane 0 = `flows[0]`: node на шаг в вычисленных колонках, рёбра `main` между соседями.
5. Lane k>0: якорный шаг → node не создаётся (референс на main-node); неякорный шаг s-го сегмента, приписанного к промежутку после якорной колонки `c` → `column = c + 1 + offsetInSegment`. Соседние пары шагов исчерпываются: якорь→якорь соседние в main (репрезентация — main-ребро, нового нет), якорь→тайл (`fork`), тайл→тайл (`branch`), тайл→якорь (`return`, в т.ч. backward к более раннему якорю — длинное ребро, маршрутизация в жёлобах). **Инвариант: каждая пара соседних шагов имеет ровно одну репрезентацию (своё ребро или общее main-ребро).**
6. `(lane, column)` уникальна по построению: сегменты одной lane приписаны к разным вхождениям якорей (соседние шаги не равны), внутри промежутка сегменты разных lane живут в своих рядах.
7. `unassigned` — просто список screenId (порядок `doc.screens`); в grid не участвует и колонок не расширяет.
8. `tileCount` = main nodes + неякорные nodes (без unassigned).

Unit-инварианты: уникальность `(lane,column)`/keys; каждое соседство → ровно одна репрезентация; существование endpoints; детерминизм; ширины промежутков; кейсы: ведущий/хвостовой сегмент, flow без якорей, повтор неякоря (MFA), backward-возврат (KYC), retry-петля к тому же якорю, шаг = экрану другой ветки, note на якоре, main-adjacency якорей (checkout-declined).

### 5.2 Рендер — `CjmView.tsx` + `CjmEdgesOverlay.tsx` + легенда

- `linear` → текущая разметка + `CjmConnector` без изменений (e2e `cjm.spec.ts` — без правок).
- С flows — плоский grid: тайлы с inline `gridRow`/`gridColumn`, колонка 0 — sticky-лейблы дорожек (имя + `description`). `data-cjm-node`, `data-screen-id`, `data-testid="cjm-lane-label"`.
- **Unassigned — отдельная секция-полоса под grid** (не колонки grid — по ревью r3), collapsed по умолчанию (заголовок «Вне сценариев, N»); раскрытие монтирует тайлы **батчами по 20** («показать ещё») — ограничен и initial render, и раскрытие.
- `CjmScreenTile` переиспользуется; проп `noteOverride?: string`.
- `CjmEdgesOverlay`: absolute-SVG, координаты по `[data-cjm-node]` через общий ResizeObserver. **Формальная маршрутизация (по ревью r3)**: рёбра — ортогональные полилинии; горизонтальные участки идут в **межрядных жёлобах** (зазор между рядами lane), вертикальные — в **межколоночных жёлобах**; порты — середины сторон тайлов (fork: низ/право якоря; return: верх/лево якоря). Каждый жёлоб держит упорядоченный список каналов; назначение каналов детерминировано (сортировка по edge key), смещение 8px на канал — параллельные рёбра не сливаются. **Инвариант: ни один сегмент полилинии не пересекает bounds не-endpoint тайла** (участки живут только в жёлобах). Соседние `main`/`branch`/короткие `fork`/`return` — прямые между соседними тайлами (как текущий `CjmConnector`); длинные (backward-возвраты) — полный жёлобный маршрут.
- Стили `verified` + легенда + `<title>`/hidden-список; атрибуты `data-edge-kind`, `data-verified`, `data-from/to`.
- **Ссылки тайлов**: тайл шага n дорожки k → `?flow=<flowId>&step=<n>`; main-node → `?flow=<flows[0].id>&step=<m>`; linear — без query.
- `src/styles/index.css`: grid + print (текущий print знает только `.cjm-list`, :171).
- Строки `src/app/strings/cjm.ts`: лейблы, легенда, `unassignedLaneName`, `flowsCount(n)`, «показать ещё», aria.

## 6. Плеер — ScenarioBar (guided browse)

`navigation.tsx`, `flowDepth`, `entryReason` не трогаем.

- Новый `src/player/ScenarioBar.tsx`:
  - активный сценарий — `?flow=<id>`; `doc.flows === undefined` → `null`; невалидный flow-id = отсутствие;
  - **`&step=<n>` — каноническая идентичность текущего шага (по ревью r3)**: при входе валидируется (`steps[n].screenId` = текущий экран, иначе параметр удаляется); **после каждого подтверждённого изменения шага `step` синхронизируется в URL** query-only replace-навигацией с сохранением `location.state` (helper `replaceQuery(search)` = `routerNavigate({search}, {replace: true, state: location.state})`); синхронизация — после смены экрана (browse-навигация переносит текущий search, порядок важен);
  - селект сценариев, «шаг X из N», prev/next → pendingTarget + `goToScreen`;
  - состояние ключуется `${runtimeKey}:${flowId}` (`runtimeKey` из `PlayerShell` через outlet context): `{lastConfirmed, pendingTarget}`. Внешняя навигация: единственное совпадение экрана → подтвердить; несколько совпадений без валидного `step`/pending → **состояние «шаг не определён»** (по ревью r3; произвольный индекс не выдумывается) с кнопками выбора вхождения; нет совпадений → «вне сценария» (+«к шагу 1»), `lastConfirmed` сохраняется;
  - интеграционный тест с реальным `PlayerNavigationProvider` (сохранение сессии при смене query).
- Встраивание: `ScreenView.tsx` рядом с `FlowResetBanner` (~:256). `PrototypeChrome.tsx` (:47): Player↔CJM переносит `flow` и `step`.
- **Границы объёма + срез**: `presentPath` (`ScreenView.tsx:102`) переносит весь search — T5 добавляет helper, удаляющий `flow`/`step` при входе в Present (остальное сохраняется); тест Player→Present→Esc. Share-whitelist (`server/share/repo.ts:189`) не трогаем. Present/share со сценариями — follow-up.

## 7. Тесты и фикстуры

- **Unit**: schema-flows (v1-правила: anchor-adjacency только main-соседняя, shortcut/backward anchor→anchor error, повторы неякорей валидны, `flows:[]`, лимиты); `navigationGraph.test.ts`; validate (missing-warning, dynamic, note-на-якоре, регресс reachability); `lanesLayout.test.ts` (§5.1, вкл. три канонических сценария r3); `ScenarioBar.test.tsx` (pendingTarget, `&step=`-канонизация в URL, «шаг не определён» при повторах, смена flow, location.state, setState-переход → текущий session state); `docDiff` (CAS + round-trip); CjmShell (дорожки, `data-verified`, легенда, collapsed unassigned).
- **Server (bun test)**: POST/PUT + warnings; 422 на каждое v1-правило; contract exact-assertions; discovery-schema; revisionDiff (блок + omit-plumbing); audit-only validationRecords; `verify:openapi`.
- **Capture-smoke**: скриншот экрана с flows идентичен без flows (`src/capture/CapturePrototype.tsx` flows не читает).
- **Фикстура**: `test/fixtures/branching-checkout.json` — 3 полных сценария (happy / отказ банка с возвратом / отмена), все v1-правила, реальные navigate-рёбра; done: `validatePrototype` errors И warnings пусты (fixture-glob suites `validate.test.ts:353`, `layoutLints.test.ts:194`); регистрация в `provisionStarterFixtures` (`e2e/starter-ds.fixture.ts:142`).
- **e2e**: `cjm.spec.ts` без правок; `cjm-flows.spec.ts`: дорожки, рёбра, **геометрия: концы через `getPointAtLength(0/len)` на границах endpoint-тайлов + каждый сегмент полилинии не пересекает bounds не-endpoint тайлов** (по ревью r3), main-ребро переиспользуется общим участком, collapsed unassigned + батч-раскрытие; `flow-scenario.spec.ts`: `?flow&step`, шаги/prev/next без сброса сессии, канонизация step в URL, «шаг не определён», CJM-тайл → плеер, Player→Present→Esc без flow/step; **перф-тест**: фикстура на границе лимитов + большой unassigned — проверка числа смонтированных DOM-тайлов и времени раскрытия батча, не только отсутствие таймаута.

## 8. Исполнение (workflow CLAUDE.md)

Волны Codex-задач (`--fresh --write --effort medium`, без коммитов; коммитит оркестратор после независимой верификации).

**Волна 1:**
- **T1 Формат+граф+валидация+docDiff** — `src/prototype/schema.ts`, `src/prototype/navigationGraph.ts`, `src/prototype/validate.ts`, `src/editor/docDiff.ts`, `src/app/strings/editor.ts`, их тесты, `docs/prototype-format.md`. Done: typecheck + unit; reachability без правок; CAS + round-trip.

**Волна 2 (после T1):**
- **T2 Фикстура** — `test/fixtures/branching-checkout.json`, `e2e/starter-ds.fixture.ts`. Done: validate чист; fixture-glob suites зелёные.
- **T3 Server/API** — `server/validationRecords.ts`, `server/routes/meta.ts`, `server/contracts.ts`, `server/contract.test.ts`, `src/prototype/revisionDiff.ts`(+тесты), `server/openapi.json`, `docs/server-api.md`. Done: `server:test` + `verify:openapi`.
- **T4 CJM** — `src/cjm/lanesLayout.ts(+test)`, `CjmEdgesOverlay.tsx`, `CjmView.tsx`, `CjmScreenTile.tsx` (`noteOverride` + ссылка), `CjmShell.test.tsx`, `src/app/strings/cjm.ts`, `src/styles/index.css`. Done: unit-инварианты (вкл. маршрутизацию как чистую функцию поверх измеренных прямоугольников); `cjm.spec.ts` без правок.
- **T5 Плеер** — `src/player/ScenarioBar.tsx(+test)`, `ScreenView.tsx`, `PlayerShell.tsx` (runtimeKey в context), `src/app/PrototypeChrome.tsx`, `src/app/strings/player.ts`. Done: unit вкл. state-preservation, step-канонизация, present-strip; без flows — DOM без изменений.

**Волна 3 (после T2+T3+T4+T5):**
- **T6 e2e + перф** — `e2e/dev/cjm-flows.spec.ts`, `e2e/dev/flow-scenario.spec.ts`, перф-фикстура. Done: Playwright dev зелёный; `npm run verify` целиком.

Финальная верификация оркестратором: `npm run verify` + `npm run e2e` + runtime-прогон по `/verify`.

## Триаж ревью r1 (2026-07-16) — сводно

B1–B5, M6–M17, m18–m20: все приняты полностью или частично в v2; r2/r3 подтвердили закрытие механики (verifyEdge, guided browse, docDiff/contracts, DAG, лимиты) — детальная таблица в git-истории плана (v2).

## Триаж ревью r2 (2026-07-17) — сводно

12 находок; blockers (тотальность layout, идентичность вхождения) и большинство major приняты в v3; r3 подтвердил закрытие №4,5,8,9,10 и частичное закрытие остальных — детальная таблица в git-истории (v3). Ключевая ошибка v3, найденная r3: схемные запреты пережали модель — исправлено в v4.

## Триаж ревью r3 (2026-07-17)

| # | Находка | Решение |
|---|---|---|
| 1 (blocker) | запрет anchor-adjacency делает end-to-end сценарии невалидными | **Принято** (вариант «flows = полные сценарии»): main-соседние якорные пары разрешены и репрезентуются main-ребром; error только для shortcut/backward anchor→anchor |
| 2 (major) | уникальность неякорей и неубывание якорей чрезмерны | **Принято**: оба ограничения сняты; идентичность — `(flowId, stepIndex)`/`&step=`; запрещены только равные соседние шаги |
| 3 (major) | `step` — не каноническая идентичность; порядок с goToScreen | **Принято**: step-канонизация в URL после подтверждения шага (replace + state), invalid step удаляется, «шаг не определён» при неоднозначности (прежнее отклонение снято), Chrome переносит flow+step |
| 4 (major) | «неубывание ≠ короткие рёбра»; каналы не заданы | **Принято**: вставка колонок в промежутки main (сегменты живут между якорями); формальная канальная маршрутизация в жёлобах, порты на границах, детерминированное назначение каналов; e2e — сегменты полилиний vs bounds всех тайлов |
| 5 (major) | collapsed unassigned не ограничивает рендер и ширину grid | **Принято**: unassigned — отдельная секция вне grid-колонок, батч-монтирование по 20, перф-тест числа DOM-тайлов |
| 6 (minor) | dynamic/missing различимы только цветом | **Принято**: разные dash-паттерны + маркер «!» у missing |
| 7 (minor) | rollback должен блокировать сохранение, не publish | **Принято**: формулировка «не персистить любую ревизию с flows в rollback-window» |

## Риски

- Backward-возвраты дают длинные жёлобные рёбра — читаемость приемлемая (не пересекают тайлы), «красивая» перестройка — v2-фаза.
- Конвергенция между ветками и branch-from-branch не выражаются — осознанное сужение v1 (`forkFrom` аддитивно).
- Rollback ниже этой версии при персистентных flows-ревизиях — правило rollback-window (§3).
- List API (`headScreens`) не включает flows — YAGNI.
