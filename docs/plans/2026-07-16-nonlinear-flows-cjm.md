# Нелинейные прототипы: `doc.flows` + дорожки-ветки в CJM + сценарии в плеере

## Контекст

Сейчас модель прототипа плоская: `screens[]` + `startScreen`; CJM (`src/cjm/CjmView.tsx`) — линейная лента тайлов в порядке массива, стрелки между соседями декоративные («does not encode a flow edge»). Реальный граф переходов существует только неявно — через `navigate`-действия — и материализуется лишь как reachability-проверка в валидаторе (`src/prototype/validate.ts:244,455-462,505-513`). Нелинейные прототипы (ветвления: happy path / отказ / возврат) невозможно ни выразить, ни увидеть.

Решения, согласованные с пользователем:
- **Гибридная модель**: рёбра выводятся из `navigate`-действий (единственный источник правды), автор поверх задаёт именованные сценарии `doc.flows` — пути по экранам, валидируемые против графа.
- **CJM — дорожки-ветки**: главная лента = первый flow, ответвления на дорожках ниже с точками расхождения/возврата.
- **Охват**: формат + валидация + server API, CJM-рендер, плеер (индикатор/навигация по шагам). Редактор — вне объёма (инспектор actions остаётся read-only).

## Ключевые решения

1. **Шаг flow — объект `{screenId, note?}`**, не строка: расширяется аддитивно. `stateOverrides` на шаге отложены (третий слой состояния без текущей потребности); `mergeScreenState` не трогаем.
2. **Остаёмся на `version: 1`**, `flows` — optional-поле (задокументированная политика «v1 evolves additively», `docs/prototype-format.md`). Миграции БД нет. Бампается только `VALIDATOR_VERSION` `"v2"` → `"v3"` (`server/validationRecords.ts:6`).
3. **Сверка шагов с navigate-графом — warning**, не error: navigate-таргет бывает динамическим (`{$event}`-source, статический граф неполон), и это консистентно с существующими reachability-warnings. Errors только структурные: шаг ссылается на несуществующий экран, дубликат `flow.id`, два одинаковых соседних шага.
4. **Повтор экрана в flow**: экран главной дорожки — единственный «якорный» тайл; шаг ветки, совпадающий с якорем, рисуется стрелкой fork/return, а не дубль-тайлом; повторное вхождение в главном flow — дуга `loop-back` к якорю. Шаг ветки вне главной дорожки — всегда собственный тайл (дубли внутри ветки допустимы).
5. **Все экраны видимы**: экраны вне сценариев — хвостовая дорожка «Вне сценариев» (скрытие было бы регрессом текущего CJM).
6. **Деградация**: документ без `flows` рендерится ровно как сейчас (существующие e2e `cjm.spec.ts` проходят без правок).

## 1. Формат — `src/prototype/schema.ts`

```ts
export const FLOWS_LIMIT = 24;
export const FLOW_STEPS_LIMIT = 100;

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

В `refinePrototypeDoc` (schema.ts:71): уникальность `flow.id`; `step.screenId ∈ screens`; соседние шаги не равны. Экспорт типов `Flow`, `FlowStep` и лимитов. Первый flow — главный сценарий.

Документация: `docs/prototype-format.md` — раздел «Flows (named scenarios)» (семантика: аннотация поверх navigate-графа, лимиты, severity, совместимость); `docs/server-api.md` — обновить пример capabilities.

## 2. Общий navigate-граф — новый `src/prototype/navigationGraph.ts`

```ts
export interface NavigationGraph {
  edges: ReadonlyMap<string, ReadonlySet<string>>;   // статические navigate-рёбра
  dynamicSources: ReadonlySet<string>;               // экраны с динамическим screenId
}
export function buildNavigationGraph(doc: PrototypeDoc): NavigationGraph;
export function hasEdge(graph: NavigationGraph, from: string, to: string): boolean; // true и при from ∈ dynamicSources
```

Чистая функция: обход `screen.spec.elements[*].on[*]`, сбор `action === "navigate"` со статическим `params.screenId`; объект-директива в `screenId` помечает `dynamicSources`. Несуществующие таргеты игнорирует (их репортит валидатор).

Рефакторинг `validate.ts`: убрать инлайновое накопление `navigation` (строки 244, 457-461), reachability-блок (505-513) перевести на `buildNavigationGraph` — сообщения/paths не меняются, существующие тесты валидатора проходят без правок. `getCjmTransitions` в `CjmScreenTile.tsx` не трогаем (другая семантика — подписи press-биндингов).

### Валидация flows (в `validatePrototype`, после reachability)

- **warning** «flow step is not connected to the previous step by a navigate action» — для пары шагов без ребра `hasEdge(prev, cur)` (подавляется `dynamicSources`); path `["flows", i, "steps", j, "screenId"]`.
- **warning** «main flow does not start at startScreen» — `flows[0].steps[0] !== startScreen`.
- **warning** «flow has a single step».

## 3. Server / API

- `server/validationRecords.ts:6` — `VALIDATOR_VERSION = "v3"`.
- `server/routes/meta.ts` `capabilities()` (:41-67): `features.flows: true`; `limits.flows`, `limits.flowSteps` (импорт из schema.ts). JSON-схема документа подхватит `flows` из zod автоматически; добавить `$comment` к узлу flows.
- OpenAPI: `contracts.ts` уже встраивает `inputPrototypeDocSchema` → `npm run generate:openapi`, закоммитить `server/openapi.json`; дрифт держит `verify:openapi`.
- Роуты публикации/`classifyRevision` — без изменений (warnings уже пишутся и возвращаются). Миграций нет; фронт и сервер деплоятся одним образом — рассинхрона strict-парсинга нет.

## 4. CJM-дорожки

### 4.1 Раскладка — новый чистый модуль `src/cjm/lanesLayout.ts` (без DOM)

```ts
export interface CjmNode { key: string; screenId: string; note?: string; column: number; lane: number; anchor: boolean }
export interface CjmEdge { key: string; from: string; to: string; kind: "main" | "fork" | "branch" | "return" | "loop-back" }
export interface CjmLane { id: string /* flow id | "main" | "unassigned" */; name: string | null; nodes: CjmNode[] }
export interface CjmLayout { lanes: CjmLane[]; edges: CjmEdge[]; columns: number; linear: boolean }
export function computeCjmLanes(doc: PrototypeDoc): CjmLayout;
```

- Без flows → `linear: true`, одна дорожка = `doc.screens`, рёбра `main` — точная деградация.
- С flows: lane 0 = `flows[0]` (column = индекс шага; повтор экрана в главном flow → ребро `loop-back` к якорю, колонку не занимает). Каждый следующий flow — дорожка ниже: шаги-якоря дают точки fork/return, непрерывные сегменты неглавных шагов — тайлы с колонками `fork.column+1…`. Рёбра: `fork` (якорь → первый тайл сегмента), `branch` (внутри), `return` (последний тайл → якорь), хвост без возврата просто заканчивается. Упрощение v1: колонки главной дорожки не раздвигаются под длинную ветку — стрелка возврата может идти назад-вверх.
- Экраны вне flows — дорожка `"unassigned"` без рёбер.

### 4.2 Рендер — `src/cjm/CjmView.tsx` + новый `src/cjm/CjmEdgesOverlay.tsx`

- `layout.linear` → текущая разметка `<ol className="cjm-list">` + `CjmConnector` без изменений.
- С flows → CSS-grid (`repeat(columns, max-content)`, ряд = дорожка-`<section>` с sticky-заголовком имени flow, `data-testid="cjm-lane"`); обёртка тайла — `data-cjm-node`, `data-screen-id`. `CjmScreenTile` переиспользуется, единственное расширение — проп `noteOverride?: string` (показывать `step.note ?? screen.note`).
- `CjmEdgesOverlay`: один absolute-SVG на grid-контейнер, координаты по `querySelectorAll('[data-cjm-node]')` через ResizeObserver (обобщение паттерна `CjmConnector`, CjmView.tsx:26-69). Атрибуты `data-testid="cjm-edge"`, `data-edge-kind`, `data-from/to` — для e2e. Формы: main/branch — прямая со стрелкой; fork — вниз-вправо от якоря; return — вверх к якорю; loop-back — дуга под дорожкой.
- Строки в `src/app/strings/cjm.ts`: `unassignedLaneName`, `flowsCount(n)`, aria-лейблы дорожек/рёбер; чип «N сценариев» в metadata-шапке. Зум — вне объёма.

## 5. Плеер (минимально инвазивно)

`navigation.tsx`, `flowDepth`, `entryReason` не трогаем — всё поверх browse-семантики `goToScreen`.

- Новый `src/player/ScenarioBar.tsx`:
  - активный сценарий — query `?flow=<id>` (query переживает переходы и шарится ссылкой; невалидный id = отсутствие);
  - селект сценариев, «шаг X из N», prev/next → `goToScreen(steps[i±1].screenId)`;
  - текущий шаг: `useState` последнего подтверждённого индекса; при смене экрана — поиск следующего вхождения вперёд, затем `indexOf`, иначе `null` → состояние «вне сценария» + кнопка «к шагу 1» (корректно для повторов экрана);
  - `doc.flows === undefined` → `null` (нулевое влияние на существующие документы).
- Встраивание: `src/player/ScreenView.tsx`, полоса рядом с `FlowResetBanner` (~строка 256). Строки — `src/app/strings/player.ts`.
- Индикатор в мобильном `PresentHud` — зафиксированный follow-up, не в этой итерации.

## 6. Тесты и фикстуры

- **Unit**: schema-flows (лимиты, дубли id, несуществующий экран, соседние дубли); `navigationGraph.test.ts` (статические/динамические рёбра); validate — warnings несвязного шага + подавление dynamicSources + регресс reachability; `lanesLayout.test.ts` (linear-деградация, fork/return, loop-back, дубль в ветке, unassigned, колонки); `ScenarioBar.test.tsx`; CjmShell — дорожки/edge-датасеты.
- **Server (bun test)**: POST/PUT с flows → 200/201 + warnings; 422 на битые flows; schema/capabilities содержат flows; `verify:openapi`.
- **Фикстура**: `test/fixtures/branching-checkout.json` — 3 flows (happy / отмена с возвратом / ошибка оплаты) с реальными navigate-рёбрами; регистрация в `provisionStarterFixtures` (`e2e/starter-ds.fixture.ts:142`).
- **e2e**: существующий `e2e/dev/cjm.spec.ts` — без правок (деградация); новые `e2e/dev/cjm-flows.spec.ts` (дорожки, `cjm-edge[data-edge-kind="fork"|"return"]`, дубль-тайл) и `e2e/dev/flow-scenario.spec.ts` (`?flow=`, «шаг 1 из 3», next → шаг 2, «вне сценария»).

## 7. Исполнение (workflow CLAUDE.md)

После одобрения: сохранить план в `docs/plans/2026-07-16-nonlinear-flows-cjm.md`, закоммитить, прогнать адверсариальное Codex-ревью (stage 2), затем волны Codex-задач (`--fresh --write --effort medium`, без коммитов):

**Волна 1 (параллельно):**
- **T1 Формат+граф+валидация** — `src/prototype/schema.ts`, `src/prototype/navigationGraph.ts`, `src/prototype/validate.ts`, их тесты, `docs/prototype-format.md`. Done: `npm run typecheck` + unit зелёные; validate-тесты reachability без правок проходят.
- **T2 Фикстура** — `test/fixtures/branching-checkout.json`, `e2e/starter-ds.fixture.ts` (строка регистрации). Done: валидна по контракту flows из плана.

**Волна 2 (после T1):**
- **T3 Server/API** — `server/validationRecords.ts`, `server/routes/meta.ts`, `server/openapi.json` (regen), `docs/server-api.md`, серверные тесты. Done: `server:test` + `verify:openapi`.
- **T4 CJM** — `src/cjm/lanesLayout.ts(+test)`, `CjmEdgesOverlay.tsx`, `CjmView.tsx`, `CjmScreenTile.tsx` (только `noteOverride`), `CjmShell.test.tsx`, `src/app/strings/cjm.ts`. Done: unit layout; `e2e/dev/cjm.spec.ts` без правок зелёный.
- **T5 Плеер** — `src/player/ScenarioBar.tsx(+test)`, `ScreenView.tsx`, `src/app/strings/player.ts`. Done: unit; документы без flows — DOM без изменений.

**Волна 3 (после T2+T4+T5):**
- **T6 e2e** — `e2e/dev/cjm-flows.spec.ts`, `e2e/dev/flow-scenario.spec.ts`. Done: Playwright dev-проект зелёный.

Файловых пересечений внутри волн нет (strings: cjm.ts → T4, player.ts → T5). Финальная верификация оркестратором: `npm run verify` + `npm run e2e` + runtime-прогон по `/verify`.

## Риски

- `src/editor/docDiff.ts` на новом корневом поле — проверить в T1, что diff generic и не падает.
- Длинная ветка «правее» точки возврата — осознанное упрощение v1 (стрелка назад-вверх); раздвижение колонок — фаза 2.
- Дубль-тайлы = дополнительные изолированные json-render stores; лимиты 24×100 теоретические, виртуализация — вне объёма.
- List API (`headScreens`) не включает flows — осознанно (YAGNI).
