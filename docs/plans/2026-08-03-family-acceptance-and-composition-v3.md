# План: Matrix Acceptance, Geometry/Readiness 2.0, Reference Mapping и Composition v3

Дата: 2026-08-03. Версия: **v2** (после Stage 2, раунд 1 — 3 адверсариальных ревьюера: корректность/код, скоуп/декомпозиция, риски/эксплуатация; триаж — §10). Источник требований: `docs/EASYUI_PRODUCT_IMPROVEMENTS.md` §19 (P0.1–P0.4, P1.1–P1.4, KPI §19.10). База: `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md` v4 (R1 — promote-сага — в проде; R2/R3 — не начаты).

> Очередь исполнения: W0 (микро-релиз env) → трек A (W1a→W1b→W1c→W2→W3→W4→W5a→W5b→W6→W7); трек B (W8a…W8g → W9) стартует параллельно с W2. Весь трек A закрыт opt-in флагом `EASYUI_ACCEPTANCE_MATRIX` (дефолт OFF) до runtime-приёмки §7.

---

## 1. Задача и цели

Сегодня приёмка семейства из 49 состояний (`pay-payment-card`) — это 100–150 клиентских операций, 2–4 самописных matrix-скрипта, ручная агрегация SHA и geometry-вердикты, которые вводят в заблуждение: измеренная ширина 175px при layout-ширине корня 140×96 — потому что union `getClientRects()` включает коробки декоративных/out-of-flow потомков (сам blur в client rects не входит; «утечку» дала коробка подсветки). Draft-скриншот `pay-action-button` снялся до появления theme-иконки и попал в визуальную оценку. Никакая из этих проблем не лечится клиентом.

Цель пакета — **один серверный вызов вместо семейства**: immutable кандидат + набор верификационных случаев → durable run с per-case вердиктами, честной геометрией (layout/paint/overflow), доказанной readiness, сгруппированными визуальными причинами и content-addressed evidence; повторная правка пересуёмывает только затронутые случаи. Параллельно — снять причину, по которой продуктовые блоки уходят в TSX (Composition v3).

### KPI (§19.10) и как меряем

| KPI | Baseline | Цель | Инструмент измерения |
|---|---:|---:|---|
| Клиентские операции на семью 49 cases | 100–150 | 1 постановка + polls | `driver.mjs accept --case-set …` (W2); замер на 49-кейсовой семье — done W7 |
| Ручные matrix-скрипты | 2–4 | 0 | ревью PR первой прод-семьи после W5b (done-критерий W5b) |
| Cases, снятые до font/asset readiness | возможны | 0 | gate `readiness` (W4), `readinessFailures` в run-репорте |
| Geometry failures без названного descendant/cause | возможны | 0 | контракт gate `geometry` v2: `fail` обязан нести `overflow.sources[]` или названное `expectedGeometry`-расхождение (W3), тест-инвариант |
| Product-блоки в TSX из-за ограничений composition | регулярно | <10% | analyzer-вердикт (W8g) в аудите `catalog candidates` |
| Повторные captures неизменившихся cases (**сценарий §19.8: правка одного ассета/темы; кроме unknown impact**) | полный rerun | <10% | `run.progress.reused/total` на сценарии W6; **KPI измеряется начиная с W5b** (до этого фингерпринты мигрируют, см. D1) |
| Runs с автособранным SHA evidence | 0% | 100% ранов, терминализованных оркестратором | `evidence_manifest_hash` (W1a); раны, убитые стартовой уборкой, вне знаменателя |
| source-ready → actionable family verdict | десятки шагов | **<10 мин тёплый run (reuse), <15 мин холодный** | замер wall-clock + RSS в done W1b; **гейт: холодный run >15 мин ⇒ O1 (§4) становится обязательным объёмом W1b** |

---

## 2. Поправки к RFC candidate-acceptance (обязательный раздел)

RFC v4 прошёл два раунда адверсариального ревью; его решения по умолчанию **сохраняются**. §19 местами предлагает конструкции, которые триаж RFC уже отклонил.

### 2.1. Решения RFC, которые сохраняются без изменений

| Решение RFC | Почему §19 его не отменяет |
|---|---|
| **Identity кандидата component-scoped**: `candidate_id = "cand_"+sha256({componentId, designSystem, rev, buildFingerprint})`, `buildFingerprint = sha256({sourceHash, bundleHash, hostAbiVersion, themeVersion})` | §19.1 предлагает инлайн-кандидата `{rev, sourceHash, bundleHash, themeVersion}` — модель, отклонённую триажем RFC: один `sourceHash` принадлежит нескольким компонентам (`server/components/candidates.ts`, `componentIds` — множество), ключ без `componentId` коллидирует и даёт cross-owner disclosure. **Инлайн-кандидат не вводится.** |
| `catalogRevision` вне идентичности, `policyProfileHash` вне `buildFingerprint` | без изменений |
| Оркестратор **вне** screenshot-помпы, ≤1 running run на процесс, capture-джобы по одной с backoff на `429 queue_full` | `cases.concurrency` в запросе отвергается `422 unsupported_option` |
| Стартовая уборка: все `queued\|running` раны → `error` | сохраняется; A3 делает потерю дешёвой |
| Evidence **не** в asset-store | сохраняется и **усиливается**: A4 вводит байтовый канал, чтобы acceptance-капчуры вообще не ингестились в asset-store |
| `≤1` нетерминальный run на кандидата (partial unique index); `cancel` только из `queued` | сохраняется + watchdog (D2) против вечного `running` |
| `409 acceptance_run_in_flight` на promote при живом run'е; `pass_with_exceptions` только при `allowExceptions` | сохраняется |
| Гейты `regression`/`interactions` = `not-implemented` | сохраняется (не-цели §8) |
| Kill-switch `EASYUI_ACCEPTANCE_DISABLED` | сохраняется для promote-пути; matrix-стек получает **свой** opt-in `EASYUI_ACCEPTANCE_MATRIX` (A7) |

### 2.2. Поправки (амендменты) к RFC

**A1. Матричная семантика: per-case durable-строки.** Таблицы `acceptance_cases` (строка на случай) и `acceptance_case_results` (content-addressed результат). `gates_json` остаётся run-level агрегатом; per-case запросы — новая таблица. Правило свёртки run-вердикта — D10.

**A2. Источник cases и место manifest'а.** Манифест — **сущность продукта** (`component_case_sets`, W2), не ассет: сервер обязан валидировать полноту tuples, SHA references, дубли props, crop lineage (§19.5). В W1 источник cases — именованные examples кандидата (`bootstrap.examples`). `manifestAssetId` не поддерживается никогда.

**A3. Resume — не мутация упавшего run'а, а дешёвый новый run.** Run иммутабелен; resume = новый run по тому же `{candidateId, caseSetId}`, переиспользующий per-case результаты по `case_fingerprint` (D1) и пересуёмывающий только недостающие. Плюс **автоматический внутрираночный retry инфраструктурных сбоев**: per-case бюджет `maxInfraRetries` (дефолт 2) на основе существующей классификации `captureClean/productErrors/infraNoise/runtimeWarnings` (`server/screenshot/noise.ts`) — «повторять только infrastructure failures» из §19.1 выполняется внутри run'а, а не новым клиентским вызовом. Форсирование — `refresh: "none"|"failed"|"all"|{caseIds:[…]}`, причина пишется в evidence.

**A4. Evidence: per-run манифест + content-addressed CAS + байтовый канал мимо asset-store.** Артефакты (PNG, geometry JSON, diff PNG) лежат в `<dataDir>/.acceptance/cas/<sha256[0:2]>/<sha256>`; `<dataDir>/.acceptance/<runId>/manifest.json` + `SHA256SUMS` ссылаются на CAS. Путь выводится из `runId` после regex-валидации. **Сегодня image-джоба всегда ингестит PNG в asset-store (`assetRepo.ingest` в `ScreenshotService.execute`), где GC нет** — поэтому W1a вводит для acceptance-джоб байтовый режим: `execute` отдаёт байты вызывающему (оркестратору), который кладёт их в CAS; в asset-store acceptance-капчуры **не попадают**. GC CAS: refcount считается запросом по **объединению** `acceptance_cases` и `acceptance_case_results`; строка `acceptance_case_results` удаляется той же операцией, что и её артефакты; grace-период для артефактов моложе N минут (прецедент `gcCandidates`); **reuse обязан проверять физическое существование артефактов, иначе пересъёмка**. Экспорт evidence — **zip** через существующий `fflate`/`zipResponse` (tar-зависимости в проекте нет), стримово, с потолком `evidenceMaxBytes`; имена записей архива — только из санитизированных `caseId` (charset W2), плюс независимая санитизация при формировании архива.

**A5. Минимальный визуальный гейт до VDC 2.0.** Гейт `visual` в W5a: reference приходит из case-set (`referenceAssetId` per case), эталон привязан к случаю манифеста, а не к опубликованной версии — блокер RFC (fingerprint-модель references) не задевается. Вне объёма: lifecycle exceptions, promotion baseline'ов, автоприёмка эталонов, миграция `visual_references`/`visual_runs`. Гейт: `pass|fail` с эталоном, `skipped` без; обязателен только при `requireVisual: true` в case-set. Обязательная часть W5a — **нормализация размеров**: crop эталона по `cropLineage`, pad кандидата/эталона до общего холста; несводимое расхождение размеров → `indeterminate`, не `fail` (текущий `visual-diff-worker` возвращает `dimensionMismatch` без метрик — этого недостаточно).

**A6. Политики: именованный реестр-константа, per-case override из манифеста; таблицы нет.** `server/acceptance/policies.ts`: `default-v1` и `pixel-strict-v1`; per-case допуски из манифеста хешируются в `case_policy_hash`. `policy_profiles`-таблица — не в этом пакете.

**A7. Ёмкость и включение: явные лимиты + opt-in флаг.** `capabilities.limits`: `acceptanceMaxCasesPerRun` (64), `acceptanceMaxJobsPerRun`, `acceptanceCaseTtlHours`, `evidenceMaxBytes` (ограничивает и CAS, и экспорт). Дедуп одинаковых `propsHash` до постановки (`aliasOfCaseId`); дедуп референс-ассетов по sha256 (один blob на N cases). Весь matrix-стек (candidates/runs/case-sets ручки) включается **только** при `EASYUI_ACCEPTANCE_MATRIX=1` (дефолт OFF; снятие — решение после runtime-приёмки §7). `EASYUI_ACCEPTANCE_DISABLED=1` продолжает аварийно гасить promote и дополнительно **дренирует активный run** (терминализация `error`).

**A8. `POST /api/components/{id}/acceptance-runs` не вводится.** Канон — `POST /api/acceptance-runs`.

**A9. Ссылки publish→run: TEXT-receipts без FK.** RFC R2 предлагал nullable FK-колонки на `component_publishes`. Инвариант v8-перестройки (`server/migrations.ts`: «any new FK-child … must be added to this list») и связка `ON DELETE SET NULL` + TTL-GC ранов (молчаливая потеря provenance) делают FK вредным. Амендмент: `component_publishes.candidate_id` / `.acceptance_run_id` — **плоские TEXT NULL колонки без FK** (денормализованные свидетельства, канон ADD COLUMN v16/v22/v23); GC ранов обязан query-проверкой не удалять терминальные раны, на которые ссылается publish.

**A10. Захват запинен к кандидату.** Сегодня `ensureDraftCandidate`/`enqueueComponentDraft` всегда читают **head** — за 8–15 минут run'а head может смениться, и кадры молча снимутся с другого билда. W1a вводит enqueue по явному `{rev, sourceHash}` кандидата: перед каждым захватом CAS-проверка `head_rev === candidate.rev`, при расхождении run терминализуется с причиной `candidate_stale_head` в `failedCases`. Дополнительно кандидат-бандл **пинуется против `gcCandidates`** (TTL 24ч / 32 МБ LRU): GC не вытесняет `sourceHash`, на который ссылается нетерминальный run; `POST /api/acceptance-runs` → `409 candidate_evicted`, если бандл уже отсутствует.

---

## 3. Ключевые проектные решения

- **D1. `case_fingerprint`** — ядро reuse/дедупа/P1.4, **component-scoped**:
  ```
  case_fingerprint = sha256(canonicalJson({
    algoVersion,                   // версия схемы фингерпринта; растёт в W2/W3/W4/W5a —
                                   // автоматически инвалидирует весь старый reuse
    candidateId,                   // уже содержит componentId+designSystem+rev+buildFingerprint
    caseKey, propsHash,
    surface: { viewport, dsf, theme },
    readinessPolicyHash,           // W4; до W4 — константа v0
    captureEnvFingerprint,         // W4; до W4 — константа v0
    casePolicyHash,                // W2; до W2 — константа v0
    referenceAssetId | null
  }))
  ```
  `acceptance_case_results` дополнительно несёт `component_id` (денормализация), reuse проверяет владение. Reuse-KPI измеряется с W5b: границы W2/W3/W4/W5a поднимают `algoVersion` и обнуляют накопленный reuse — признанная плата за поэтапность.
- **D2. Run иммутабелен; `acceptance_cases` — единственная мутируемая часть.** Терминализация — одна короткая транзакция (bun:sqlite: без `await` внутри). **Watchdog**: run в `running` дольше `runDeadline` (политика; дефолт 30 мин) терминализуется `error` живым процессом — иначе исключение в цикле оркестратора вечно блокирует кандидата partial-индексом. `SQLITE_CONSTRAINT` на partial unique index маппится в `409 acceptance_run_in_flight`.
- **D3. Геометрия: факты в capture, вердикт на сервере.** `policyVerdict` считает чистая функция `src/capture/geometryPolicy.ts` (unit-тесты без DOM, канон `analyzeGeometry`).
- **D4. Paint-контур: отдельный capture-режим, один кадр — оба измерения.** Element-screenshot клиппит чернила коробкой `#eui-capture-surface` (inline-block, непрозрачный `bg-background`) — по текущему пайплайну ink-bbox **не измерим**. W3 вводит режим `probe:"paint"`: прозрачный фон поверхности (`omitBackground`) + маргин-поле вокруг компонента (из политики, дефолт 64px) + **одна сессия браузера собирает и geometry-факты, и PNG** — `layoutBounds` и `paintBounds` гарантированно про один кадр. `paintBounds` = ink-bbox по альфе (`paintBoundsSource:"alpha"`; поле недостаточно → `indeterminate` + рекомендация увеличить маргин). Все значения нормализуются в **CSS px** (PNG-пиксели делятся на `deviceScaleFactor` — иначе ложный overflow ×2/×3). CSS-разбор (`getComputedStyle` filter/box-shadow/transform/position) — только для **атрибуции** источников overflow.
- **D5. Readiness — декларативная политика, а не задержки.** Версионируется и хешируется; **capture, не прошедший readiness, не попадает ни в один визуальный вердикт** (инвариант; тест — в W5a, раньше гейта `visual` не существует).
- **D6. Impact — консервативный и доказательный.** Два доказуемых класса: (а) изменились только литералы `asset_<sha256>` (`sourceShapeHash` совпал) → пересъёмка случаев, чьи наблюдённые ресурсы пересекаются с изменёнными; (б) сменилась только версия темы → пересъёмка случаев, чьи наблюдённые токены/иконки/шрифты пересекаются с диффом темы. Наблюдённые токены/иконки собираются в capture-evidence **в W4** (без этого класс (б) нереализуем). Всё прочее → полная пересъёмка, `basis:"conservative"`; неизвестный ресурс → `conservative`.
- **D7. Composition v3 — expansion-time, не runtime.** Все возможности v3 статически разрешимы от значений параметров в точке ссылки. Ветвление по `doc.state` — существующий `$cond` внутри тела. Первая строка в `docs/prototype-format.md`.
- **D8. Формат композиций аддитивен, включая диспетчеры.** `version:3` — новая ветка union; **обязательные правки двух точек диспетчеризации** — `isCompositionSource` (сейчас принимает только 1|2 → v3-source молча падал бы в version 1) и выбор алгоритма в `expandCompositions` (`hasV2Reference` → документ только с v3-ссылками ушёл бы в legacy v1-раскрытие). Аддитивность доказывается снапшот-тестами **на диспетчерах**, не только на телах.
- **D9. Kill-switch'и реально доступны на проде.** W0 пробрасывает переменные в `docker-compose.yml` (**сегодня `EASYUI_ACCEPTANCE_DISABLED`/`EASYUI_VALIDATE_DISABLED` в compose отсутствуют — аварийного выключателя на проде физически нет**). `EASYUI_ACCEPTANCE_MATRIX` (OFF) — трек A; `EASYUI_COMPOSITION_V3` (OFF) — трек B; **после первой v3-записи откат образа невозможен без чистки данных** — поэтому OFF до приёмки W9.
- **D10. Свёртка run-вердикта из per-case (контракт W1a).** `fail` — хотя бы один case `fail` по обязательному гейту; `error` — есть case `error` после исчерпания `maxInfraRetries` и нет `fail`; `pass` — все обязательные гейты всех cases `pass` (алиасы наследуют вердикт целевого case; `reused` эквивалентен свежему; `skipped` допустим только для необязательных гейтов). Инвариант-тест: `reused`/`skipped`/`alias` не могут замаскировать `fail`. Каждый failed case несёт `severity: {rank, class: "structural"|"geometry"|"aa"|"raw", score}` (§19.1 «ранжировать по severity»); `GET /cases` и run-репорт сортируют по нему.
- **D11. Качество капчура — четыре поля на случай.** `captureClean/productErrors/runtimeWarnings/infraWarnings` (существующая классификация `noise.ts`) пишутся в `acceptance_cases` с W1a — на них опираются авто-retry (A3) и различение продуктовой ошибки от шума.

---

## 4. Бюджет ёмкости (честно)

Замеры — done-критерий W1b (wall-clock **и пиковый RSS** через `docker stats`; прирост байт CAS на run), оценка на входе:

| Стадия на 1 case | Оценка |
|---|---|
| capture (запуск chromium + навигация + readiness + PNG + geometry в одной сессии с W3) | 4–8 с |
| до W3: geometry и image — **две** джобы (98 запусков на 49 cases) | ×2 |
| ink-bbox + diff + классификация (node-подпроцесс) | 0,5–1,5 с |

Холодный run 49 cases: реалистично **12–20 мин до W3**, 8–15 мин после объединения сессий. Меры:
1. дедуп по `propsHash` до постановки (оценка «49→30–40» не подтверждена — замер в W1b);
2. `determinism` на выборке (`determinismSampleSize`, дефолт 3 + все fail-cases);
3. reuse по `case_fingerprint` — тёплый run <1–2 мин;
4. `acceptanceMaxCasesPerRun = 64`;
5. `eta`: EMA × остаток, `basis:"measured"|"estimate"`; **оркестратор забирает результат джобы сразу** (`RESULT_TTL` 10 мин + reap — иначе ложный `error` кейса);
6. **память**: `mem_limit: 1g` на контейнер (bun + SQLite + chromium + diff/ink-подпроцессы). Один системный слот на тяжёлый подпроцесс: ink-bbox/diff не запускаются одновременно с chromium-джобой. Done-тест W1b: `kill -9` воркера и симуляция OOM посреди run'а → resume досуёмывает ровно недостающие;
7. **резервирование очереди**: оркестратор не ставит джобу, если `queue.length >= MAX_QUEUE - 2` (интерактиву гарантированы 2 слота из 5), а не только «по одной»;
8. maintenance-lock: `POST /api/acceptance-runs` → 503 при удержанном lock'е; `acquireMaintenanceLock` отказывает при нетерминальном run'е.

Опция O1 (переиспользование прогретого браузера между джобами одного run'а): **становится обязательным объёмом W1b, если замер холодного run'а >15 мин** (гейт KPI §1).

---

## 5. Волны

### W0 — Микро-релиз: kill-switch'и до кода

Добавить в `docker-compose.yml` проброс `EASYUI_ACCEPTANCE_DISABLED: ${EASYUI_ACCEPTANCE_DISABLED:-}`, `EASYUI_VALIDATE_DISABLED`, `EASYUI_THEME_RESOLVER_V2_DISABLED`, `EASYUI_ACCEPTANCE_MATRIX: ${EASYUI_ACCEPTANCE_MATRIX:-}`, `EASYUI_COMPOSITION_V3: ${EASYUI_COMPOSITION_V3:-}`. Выяснить фактическое значение `EASYUI_SURFACES` в Dokploy и синхронизировать `docs/server-api.md` (compose-дефолт `:-1` противоречит докам). Done: деплой, `capabilities` подтверждает управляемость флагов. Перед W1a — **бэкап prod-volume** (канон `/deploy`).

### W1a — Durable-схема, run и гейты без capture-матрицы

**Объём.** Миграция **v25**: `component_candidates` (RFC §3.2), `acceptance_runs` (RFC §3.3 + `case_set_id`, `policy_profile_id`, `progress_json`, `impact_json`), `acceptance_cases` (+ поля D11, `severity_json`), `acceptance_case_results` (+ `component_id`), TEXT-колонки A9 на `component_publishes` (`DEFAULT NULL`, без FK, канон плоских ADD COLUMN), `design_systems.acceptance TEXT NOT NULL DEFAULT 'off'` (**DEFAULT обязателен** — иначе старый INSERT из `routes/designSystems.ts` падает при откате образа). Partial unique «≤1 нетерминальный run на кандидата» (первый partial index в проекте; маппинг ошибки → 409). Роуты `POST /api/components/:id/candidates`, `GET /api/component-candidates/:id`, `POST/GET /api/acceptance-runs*` (+`/cases`, `/evidence`, `/cancel`). Оркестратор вне помпы + watchdog (D2) + стартовая уборка. Гейты `contract`/`defaults`/`render`/`audit`; `geometry` — **advisory-only** (v1-семантика в вердикт не входит — она и есть исходный дефект §19.2; боевой гейт приезжает в W3); `visual`/`readiness`/`regression`/`interactions` = `not-implemented`. Байтовый канал capture→CAS (A4: acceptance-джобы не ингестят в asset-store). Пин кандидата (A10). Per-run evidence-манифест + `SHA256SUMS`. Свёртка D10. Источник cases — examples кандидата.

**Авторизация (контракт для всех acceptance/case-set роутов).** `requireUser` + owner компонента по денормализованному `component_id` (или admin); `share`/`capture`-принципалы — 403 всегда (инвариант `catalogCandidates.ts`); артефакты CAS отдаются **только** через `runId`-scoped роут с проверкой владельца рана (ручек «по sha» нет). Компоненты с `owner_id IS NULL`: сегодня `resourceOwner` даёт 404 даже админу — admin-путь для acceptance обязан работать, зафиксировать явно.

**Файлы.** Новые: `server/acceptance/{ids,policies,repo,orchestrator,runner,evidence,cases}.ts`, `server/acceptance/gates/*`, `server/routes/acceptance.ts`, тесты. Изменяемые: `server/migrations.ts` (v25 + дополнение комментария-инварианта v8), `server/contracts.ts`, `server/openapi.json` (реген + `npm run generate:sdk`), `server/main.ts`, `server/screenshot/service.ts` (байтовый режим, резервирование очереди §4.7, enqueue по `{rev, sourceHash}`), `server/components/candidates.ts` (пин GC), `server/maintenance.ts` (§4.8), `docs/server-api.md`.

**Done.** `npm run verify`; unit: fingerprint-детерминизм и component-scope (два компонента с одним sourceHash **не** делят результаты), стартовая уборка, watchdog, D10-свёртка (reused/skipped не маскируют fail), partial-index→409, авторизация (share/capture 403), CAS-байты не попадают в asset-store (счётчик строк `assets` до/после), пин head (смена head посреди run'а → `candidate_stale_head`); e2e `e2e/preview/acceptance-run.spec.ts` (**capture-спеки живут в `e2e/preview/` — dev-проект не поднимает `SERVE_DIST`, `ScreenshotService.available()` вернул бы 501**); миграция на копии прод-БД; `EASYUI_ACCEPTANCE_MATRIX` не задан → 404 всех новых ручек.

### W1b — Reuse, CAS GC, дедуп, прогресс/ETA, замеры

**Объём.** `case_fingerprint` (D1, `algoVersion:1`), reuse (владение + физическое существование артефактов), авто-retry `maxInfraRetries` (A3), дедуп props (`aliasOfCaseId`), CAS GC (union-refcount + grace-период + удаление result-строки вместе с артефактами), progress/ETA, `refresh`. Замеры: wall-clock 20/49 cases, RSS, байты CAS — результат вписывается в §4; **>15 мин ⇒ O1 в объём этой волны**.
**Done.** unit: reuse-инварианты, GC (не удаляет живое; не оставляет result без артефактов; переживает крэш между записью артефакта и строки), retry только на infra-классе (D11); e2e: повтор run'а → `reused: N`; kill/OOM-тест §4.6.

### W1c — Интеграции: promote, слоты, CLI

**Объём.** `promoteComponent`: опциональные `candidateId`/`acceptanceRunId`, `409 acceptance_run_in_flight`, запись A9-ссылок в Phase B. Слоты `server/components/validate.ts`: **не** «третий системный слот» (на 1 CPU это +1 тяжёлый typecheck поверх capture), а приоритетная схема: оркестратор конкурирует за существующий `VALIDATE_GLOBAL_CONCURRENT=2` и **не занимает per-user слот пользователя** (`inFlightUsers` ключуется userId — иначе интерактивный validate владельца run'а получает 429 на 15 минут; оркестратор работает под системным principal с отдельным ключом). CLI `driver.mjs accept <id> [--case-set] [--json]` + зеркала. Правка слотов — отдельно откатываемый шаг: деплоится и наблюдается до включения matrix на проде.
**Done.** `verify`; unit promote-саги со ссылками; тест «интерактивный validate владельца не деградирует во время run'а»; CLI-путь одной командой.

### W2 — Reference Mapping (case-sets) — P1.1

**Объём.** Манифест §19.5 как сущность + `manifestVersion: 1` (поля геометрии/readiness расширяются в W3/W4 — forward-compatible, ранние case-set'ы не перевыпускаются); charset `^[A-Za-z0-9._-]{1,64}$` для `case.id`/`caseKey` (защита от zip-slip в evidence и клиентском кэше); дедуп reference-ассетов по sha256. Миграция **v26**: `component_case_sets`. `case_set_id = "cset_"+sha256(canonicalJson(manifest))` — контентная адресация, повтор идемпотентен. Манифест: cases (id, props, referenceAssetId, expectedGeometry, cropLineage, policy), `dimensions` (coverage + variant family), `capture:{viewport,dsf,theme}` (общий для набора), `requireVisual?`, `policy:{profile, perCase}`. Валидация: `asset_not_found`, уникальность id, `duplicate_case_props` без `aliasOf`, `cropLineage.rect` в границах родителя, props против `propsJsonSchema` head-кандидата — warning. Coverage-роут (`expected/present/missing tuples, duplicates`). `casePolicyHash` входит в `case_fingerprint` (bump `algoVersion`).
**Файлы.** Новые: `server/acceptance/caseSets.ts`, `server/routes/caseSets.ts`, `src/acceptance/caseSetSchema.ts` (zod, общий с драйвером), тесты. Изменяемые: `server/migrations.ts` (v26), `server/figma.ts` (валидаторы fileKey/nodeId), `server/acceptance/{runner,policies}.ts`, `server/main.ts`, contracts/openapi, `driver.mjs` (`case-set put/get/coverage`), `docs/server-api.md`.
**Done.** `verify`; e2e `e2e/preview/case-sets.spec.ts`: манифест 9 cases → run (эталоны гейтами пока не потребляются — это W5a; проверяются постановка и `reference_asset_id` в case-строках) → coverage 0 missing; отказы на дублях/битом ассете/плохом charset; драйвер публикует манифест и печатает coverage.

### W3 — Geometry Contract 2.0 — P0.2

**Объём.** Режим `probe:"paint"` (D4): прозрачный фон + маргин, **одна сессия = geometry + PNG**; `layoutBounds` (union border-box'ов **in-flow** потомков; out-of-flow/трансформированные исключаются и уходят в атрибуцию), `paintBounds` (ink-bbox по альфе, CSS px), `overflow.sources` (`elementKey`, `cause` вида `filter:blur(68px)`, `contribution` по сторонам), `clipChain`, `policyVerdict ∈ clean|paint-overflow-clipped|paint-overflow-not-clipped|layout-overflow|indeterminate`; `geometryDetailKeys` ≤20 (дефолт — корневой маркер). Гейт `geometry` v2 становится боевым (advisory v1 выключается), per-case допуски `allowPaintOverflow`/`expectedClip`. Bump `algoVersion`.
**Файлы.** Новые: `src/capture/geometryPolicy.ts` (+тест), `scripts/ink-bbox-worker.mjs` (канон `visual-diff-worker.mjs`), `server/acceptance/gates/geometry2.ts`. Изменяемые: `src/capture/geometry.mjs` (+`.d.mts`, тесты), `src/capture/CaptureComponent.tsx` (маргин/прозрачность в paint-режиме), `scripts/screenshot-worker.mjs` (`omitBackground`, combined-сессия), `server/screenshot/service.ts`, contracts/openapi, `docs/server-api.md`.
**Done.** unit-тесты политики: кейс из фидбэка (**layout 140×96 честный; paint больше layout; источник — коробка/эффект потомка `highlight` с CSS-причиной**), «blur внутри `overflow:hidden` → clean»; DOM-тест `collectGeometry` (out-of-flow потомок не расширяет layoutBounds); инвариант «fail ⇒ `overflow.sources[]` непуст или названо `expectedGeometry`-расхождение»; тест нормализации dsf=2 (нет ложного overflow ×2); `verify`.

### W4 — Deterministic Capture Readiness — P0.3

**Объём.** Декларативная readiness-политика (schema+hash), расширенный handshake, `captureEnvFingerprint`, gate `readiness`; **сбор наблюдённых ресурсов** — использованные font faces, загруженные theme-иконки/изображения, применённые theme-токены — в `ready.evidence` (без этого W6-класс «theme-only» нереализуем); `colorProfile` best-effort (честная деградация до `colorSchemeOnly`). Network-quiet, 2 стабильных rAF, отключение анимаций, `timeoutMs`-потолок + список pending-запросов в evidence. Bump `algoVersion`.
```ts
readinessPolicy = { version: 1, fonts: "used-faces"|"document-ready", images: "decoded",
  network: { quietMs: 200, scope: "component-owned" }, frames: 2,
  animations: "disabled", timeoutMs: 15000 }
captureEnvFingerprint = sha256({ browserVersion, platform, dpr, colorScheme|colorProfile,
                                 fontRasterFingerprint, rendererBuild, readinessPolicyHash })
```
**Файлы.** Новые: `src/capture/readinessPolicy.ts`, `src/capture/env.ts`, `server/acceptance/gates/readiness.ts`, тесты. Изменяемые: `src/capture/readiness.ts`, `src/capture/protocol.ts`, `src/capture/CaptureComponent.tsx`/`CaptureSurface.tsx`, `scripts/screenshot-worker.mjs`, `server/screenshot/service.ts`, `server/screenshot/noise.ts`, contracts/openapi, `docs/server-api.md`.
**Done.** e2e `e2e/preview/capture-readiness.spec.ts`: фикстура с медленной theme-иконкой → либо ready-кадр с иконкой, либо `readiness_not_met`; стабильность `captureEnvFingerprint` на двух захватах; `verify` + `npm run e2e`. (Инвариант D5 «не-ready не идёт в visual» — тест в W5a.)

### W5a — Per-case visual gate — P1.2 (метрики)

**Объём.** Гейт `visual` (A5): нормализация размеров (crop по `cropLineage`, pad до общего холста, `indeterminate` при несводимости), метрики `rawDiffPct/aaDiffPct/maxChannelDelta/regions(≤12)/bestOffset`, per-case пороги из политики/манифеста; severity-ранжирование (D10) в действии; инвариант-тест D5. Bump `algoVersion` (последний — **с этой волны reuse-KPI измеряется**).
**Файлы.** `server/acceptance/gates/visual.ts`, `scripts/visual-diff-worker.mjs` (нормализация, маска, связные компоненты, AA-дифференциал, best-offset), `server/visual/diff-runner.ts`, `server/acceptance/runner.ts`, contracts/openapi.
**Done.** unit на синтетических парах (включая dimension-normalization и «не-ready кадр не получает вердикта»); e2e `e2e/preview/visual-causes.spec.ts` (часть 1: пороговые вердикты); `verify`.

### W5b — Таксономия причин и группировка ремедиаций

**Объём.** 8 классификаторов §19.6 (`{code, confidence, detail}`, фолбэк `unclassified`): `surface-tint`, `edge-radius-stroke`, `geometry-shift`, `text-raster-residual`, `missing-late-asset` (от W4-evidence), `alpha-compositing`, `effect-overflow` (регионы между layout и paint bounds — от W3), `descendant-outside-mask`. Группировка: `remediationKey = sha256({causeCode, квантованная bbox-сигнатура, elementKey, variantFamily})` — семейственные измерения из W2-манифеста входят в ключ (§19.6 «группировать по variant family»); run-репорт: `remediationGroups` + сортировка по severity. Классификация **никогда** не влияет на pass/fail.
**Файлы.** `server/visual/causes.ts` (+тест — чистые классификаторы над масками), `server/acceptance/grouping.ts` (+тест), `server/acceptance/runner.ts`, contracts/openapi.
**Done.** unit по каждому коду («одна иконка на 20 случаев → 1 группа»); e2e: сломанный shared-ассет → `fail` с одной группой; **ревью первой прод-семьи: 0 ручных matrix-скриптов (KPI)**; `verify`.

### W6 — Impact и частичная пересъёмка — P1.4

**Объём.** D6: `sourceShapeHash` (в `server/components/candidates.ts` рядом с `sourceHash`), нормализация наблюдённых ресурсов из W4-evidence (`server/acceptance/resources.ts`), диффы темы, `POST /api/components/:id/impact {candidateId, baselineRunId}` → `{basis, changedAssets[], changedTokens[], affectedCases[], unaffectedCases[], recaptureCount, reason}`; `driver.mjs accept --baseline-run <id>` / `impact`.
**Done.** «замена одного ассета → recapture = числу реально использующих», «любая другая правка исходника → conservative, все»; e2e `e2e/preview/acceptance-impact.spec.ts`; `verify`. Риск: динамический URL → неизвестный ресурс → `conservative`, без молчаливого reuse.

### W7 — Client-side evidence cache — P1.3

**Объём.** `--cache-dir` в `driver.mjs` (только клиент). Схема кэша: `requests/<sha256(key)>.json`, `blobs/<sha256>`, `receipts/`, `links.json`, `SHA256SUMS`. **Ключ включает идентичность**: `key = sha256({identity: sha256(baseUrl+userId|username), method, path, sortedQuery, canonicalBody, apiVersion})` — общий `--cache-dir` не отдаёт ответы чужой учётки; токены/куки не входят и не пишутся. Каталог `mode 0700`; `SHA256SUMS` проверяется при чтении (подмена blob'а = miss); распаковка evidence-архива отвергает `..`/абсолютные имена; кэш при `LEGACY_BASIC_AUTH` выключен. Кэшируются read-only GET'ы, **терминальные** раны и их evidence, capture-результаты по `case_fingerprint`; валидация — ETag либо фингерпринты; `--refresh` пишет `refreshReason`; каждый `--json`-ответ несёт `cache:{status,key,reason}`. Явно: клиентский кэш — ускоритель, **не свидетельство**.
**Файлы.** `.claude/skills/author/cache.mjs` (+зеркала, `scripts/sync-share-skills.mjs`), `.claude/skills/author/driver.mjs`, `.claude/skills/*/SKILL.md`, `test/driver-cache.test.ts`, `docs/server-api.md`.
**Done.** unit (hit/miss/refresh, изоляция учёток, grep секретов, стабильность ключа при перестановке query); ручной прогон: повтор `accept` на неизменённом кандидате — 0 capture-запросов; **замер KPI №1 на 49-кейсовой семье**; `verify`.

### W8 — Composition v3 (трек B) — P0.4

Подволны последовательны; каждая — своя `verify`-зелень. `EASYUI_COMPOSITION_V3` OFF до приёмки W9. **W8a–f — внутренние инкременты, поставка трека — W9.**

- **W8a — параметры и условия.** `params[*].type += "enum"|"object"|"array"` (схемы/дефолты/`items`/`maxItems`), `$if`/`$switch` по параметрам, optional branch. **Обязательные правки диспетчеров D8** + снапшот-тесты диспетчеризации v1/v2. Файлы: `src/prototype/composition.ts` (ветка `version:3`), `src/prototype/compositionV3/{params,conditions}.ts` (+тесты), `server/validation.ts`, `server/contracts.ts`.
- **W8b — `repeat` по параметру-массиву.** Expansion-time; **схема ключей развёрнутых элементов задаётся явно** (индексный суффикс в authored-пространстве; `$` остаётся зарезервирован за `expandedKey` — коллизии с `hostKey$innerKey` исключены тестом); лимиты до и после раскрытия (`EXPANDED_ELEMENTS_LIMIT`). Файлы: `src/prototype/compositionV3/repeat.ts`, expansion.
- **W8c — слоты с метаданными.** `slots` как объект: **нормализация/форк `refineCompositionDoc`** (текущий код делает `new Set(doc.slots)`/`.includes` — со словарём ломается); `required`, `allowedRoles[]` (роли из `canonicalFor`-глоссария) + `allowedTypes[]` (дополнительно), `cardinality:{min,max}`, `fallback`. Валидация в точке ссылки.
- **W8d — параметры-действия (пересмотрено, T-M6).** Заявленный §19.4.5 «typed event → composition output» **нереализуем** при expansion-time: подстановка не ходит в `element.on`, валидатор отвергает `$param` в action-параметрах, host-элемент удаляется при раскрытии — рантайм-границы композиции не существует. Вместо этого **параметр типа `action`**: точка ссылки передаёт handler-биндинг (навигация/state-мутация/типизированное событие хоста), expansion статически вписывает его в `on` целевых элементов. Декларация payload-схем событий композиции — в не-цели. Файлы: `src/prototype/compositionV3/actions.ts`, expansion.
- **W8e — token layout.** `layout: {flow, gap, padding, align, justify, sizing (width|height|grow|basis из токенов), radius, clip, background}` — компилируется в существующие примитивы spacing/layout-контракта v1; новых рантайм-примитивов нет.
- **W8f — варианты.** `variants: {name: {tuples[], defaults}}`; ссылка передаёт `variant`; экспорт в case-set-измерения (стык с W2).
- **W8g — анализатор и preview-дерево.** `POST /api/compositions/analyze {doc}` → `{verdict: "composition"|"extend-component"|"needs-ownership-component", reasons[], unsupported[]}`; `POST /api/compositions/:id/preview-tree {params, slots}` → resolved params, ветки, слоты/события, layout-owner, раскрытое дерево (UI-превью — не в объёме, ограничение против §19.4.10). Файлы: `src/prototype/compositionAnalyze.ts` (+тесты), `server/routes/compositions.ts`.

**Отложено осознанно.** §19.4.7 responsive branches (несовместимо с D7; рантайм-интерпретатор — отдельный RFC); §19.4.5 event-декларации (заменены параметром-действием).
**Done трека.** Снапшоты диспетчеров v1/v2 байт-в-байт; фикстуры «FAQ list», «Benefit list», «Payment schedule», «Card details» — композициями v3 без TSX; `e2e/preview/composition-v3.spec.ts` (+ правка `playwright.config.ts`: `EASYUI_COMPOSITION_V3=1` в `webServer`-команде, прецедент `surfacesEnv`); флаг OFF → `422 composition_v3_disabled`; `docs/prototype-format.md` описывает границу D7; `verify`.

### W9 — Workbench (трек B)

**Объём.** Снять `422 unsupported_kind` для композиционных кандидатов; **расширить корпус матчера композициями** (сейчас `server/catalog/corpus.ts` собирает только `kind:"component"` — без этого дубль существующей композиции не детектируется и «три исхода» слепы к композициям); три исхода («собрать composition» / «расширить component» / «нужен ownership component») с объяснением и dependency impact (`usages`); вердикт W8g в ответе; минимальный блок в Library. Печать трёх исходов в `driver.mjs catalog search` — в этой волне (замок драйвера, §6). Полноценный визуальный workbench — не в объёме.
**Файлы.** `server/routes/catalogCandidates.ts`, `server/catalog/{corpus,matcher}.ts`, `src/library/*`, `driver.mjs` + зеркала, `docs/server-api.md`.
**Done.** тест матчера на композиционном дубле; e2e `e2e/preview/workbench.spec.ts` «поиск → вердикт → создание композиции»; `verify`.

---

## 6. Владение файлами и параллелизм

| Файл | Волны | Правило |
|---|---|---|
| `server/migrations.ts` | W1a (v25), W2 (v26) | строго серийный |
| `server/contracts.ts`, `server/openapi.json`, SDK | почти все | аддитивно; в конце волны `generate-openapi` **и `generate:sdk`** + drift-чеки; сгенерированные файлы не мержатся руками — только регенерация |
| `server/main.ts` (диспатч роутов) | W1a, W2, W8g, W9 | append-only; конфликт решает волна с бóльшим номером |
| `docs/server-api.md` | W1a–W7, W9 | append-only по секциям волны |
| `.claude/skills/*/driver.mjs` + зеркала + `scripts/sync-share-skills.mjs` | W1c, W2, W6, W7, W9 | «замок драйвера»: одновременно правит одна волна; sync в конце волны |
| `server/screenshot/service.ts`, `scripts/screenshot-worker.mjs`, `src/capture/protocol.ts`, `src/capture/CaptureComponent.tsx` | W1a, W3, W4 | серийно; W3 и W4 не параллелятся |
| `src/capture/geometry.mjs` | W3 | эксклюзив |
| `scripts/visual-diff-worker.mjs`, `server/visual/*` | W5a/W5b | эксклюзив; `visual_references`/`visual_runs` не трогаются |
| `server/acceptance/**` | W1a владеет; W1b/W1c/W2/W5/W6 — свои файлы | новые гейты — новыми файлами в `gates/` |
| `server/validation.ts` (раскрытие прототипов) | W8a–f | эксклюзив трека B; **не путать** с `server/components/validate.ts` (трек A, W1c) |
| `src/prototype/composition.ts`, `src/prototype/compositionV3/**` | W8a–f | эксклюзив |
| `server/routes/catalogCandidates.ts`, `server/catalog/{corpus,matcher}.ts` | W9 | эксклюзив |
| `playwright.config.ts` | W8 | эксклюзив |
| `docker-compose.yml` | W0 | эксклюзив |

Параллельные пары: (W2 ‖ W8a–c), (W3 ‖ W8d–f). Пара (W7 ‖ W9) **запрещена** (обе правят драйвер). Всё остальное — последовательно.

---

## 7. Верификация

**Инженерный гейт каждой волны:** `npm run verify` (включая openapi+sdk drift) + целевые e2e-спеки; `npm run e2e` целиком перед закрытием трека. Все capture-зависимые спеки — в `e2e/preview/` (dev-проект не поднимает `SERVE_DIST`); бюджет времени e2e закладывать (4 web-сервера, два с build).

**Runtime-приёмка (по `.claude/skills/verify`), до включения `EASYUI_ACCEPTANCE_MATRIX`/`EASYUI_COMPOSITION_V3` на проде:**
1. Фикстурная семья ≥20 cases + case-set с эталонами; `driver.mjs accept` — одна команда; per-case таблица с сортировкой по severity, remediationGroups, SHA-манифест.
2. Один сломанный shared-ассет → `fail` с одной группой; `impact` ≤ реально затронутых; повторный run reuse'ит остальные.
3. Кейс `pay-action-button`: `readiness_not_met`, визуальный вердикт не выдан.
4. Кейс «карточка 140/175»: `layoutBounds 140×96`, `paintBounds` больше layout, источник — конкретный потомок с CSS-причиной, вердикт по политике.
5. Композиционные фикстуры без TSX рендерятся в плеере.
6. Миграции v25/v26 на копии прод-БД; **бэкап volume перед W1a**; чек-лист отката: старый код не читает новые таблицы/колонки (подтверждено ревью: `SELECT *` по `component_publishes`/`design_systems` в продовом коде нет; `design_systems.acceptance` — NOT NULL DEFAULT), `.acceptance/**` при откате не растёт (оркестратора нет — но периметр диска проверить), незавершённые раны уберёт стартовая уборка следующего деплоя.
7. Замеры: wall-clock/RSS/CAS-байты холодного и тёплого run'а вписаны в §4; KPI-таблица §1 актуализирована фактами.

---

## 8. Явные не-цели

- VDC 2.0 целиком (exceptions lifecycle, baseline promotion, автоприёмка эталонов, миграция `visual_references`/`visual_runs`).
- Gate `regression` и `interactions` (RFC R4+).
- Режим ДС `required`; таблица `policy_profiles`.
- Flow-level release gate, theme impact graph, dependency workbench.
- Автогенерация галереи из манифеста (только `coverage`).
- Responsive branches композиций (§19.4.7) и рантайм-интерпретатор композиций (D7); **event-декларации композиций с payload-схемой** (§19.4.5 — заменены параметром-действием, T-M6).
- UI-превью composition workbench (§19.4.10 — только API W8g); полноценный визуальный Workbench.
- Figma API-клиент/квоты; GC ассет-стора (acceptance его больше не наполняет — A4); provenance в bundle v3; backfill исторических версий.
- Точный ICC color profile в env-fingerprint (best-effort, деградация до `colorSchemeOnly`).

---

## 9. Сводные риски пакета

| Риск | Sev | Митигация |
|---|---|---|
| Wall-clock холодного run'а не влезает в KPI | high | §4; **гейт O1 по замеру W1b**; KPI переформулирован (тёплый <10 мин) |
| OOM контейнера (`mem_limit: 1g`) посреди run'а | high | один слот тяжёлого подпроцесса; замер RSS в W1b; resume-тест kill/OOM |
| Диск: CAS + (исторически) asset-store | high | acceptance-капчуры не ингестятся в asset-store (A4); `evidenceMaxBytes`; GC с grace-периодом и union-refcount |
| Cross-owner reuse/disclosure | high | `candidateId` в `case_fingerprint` (D1); `component_id` в results; артефакты только через runId-scoped роут |
| Смена head посреди run'а / вытеснение бандла GC | high | пин A10; `candidate_stale_head`/`candidate_evicted` |
| Reuse из другой среды/эпохи | med | `captureEnvFingerprint` + `algoVersion` (авто-инвалидация на границах волн) |
| Голодание интерактива (очередь 5, validate-слоты) | med | резервирование 2 слотов; оркестратор не занимает per-user validate-слот; отдельный деплой W1c |
| Ложные визуальные причины | med | классификация не влияет на вердикт; `confidence`+`unclassified` |
| ink-bbox: непрозрачный фон/малый маргин | med | paint-режим с `omitBackground`+маргином; `indeterminate` вместо ложного fail |
| Взрыв раскрытия v3 | med | лимиты до/после; флаг OFF; после первой v3-записи откат = чистка данных |
| Zip-slip / небезопасные имена | med | charset `caseId` (W2) + санитизация архива (A4) + клиентская защита распаковки (W7) |
| Конфликты волн по общим файлам | med | §6 (включая `main.ts`, `docs/server-api.md`, SDK-реген) |

---

## 10. Триаж Stage 2 (раунд 1)

Ревьюеры: R1 корректность/код, R2 скоуп/декомпозиция, R3 риски/эксплуатация. **Принято** = внесено в v2; **отклонено** = с обоснованием.

**Принятые blocker'ы.**
- R1-B1 = R2-1: `case_fingerprint` без component-scope → D1 (`candidateId` + `algoVersion`, `component_id` в results, владение на reuse).
- R1-B2/B3: ink-bbox неизмерим (element-screenshot клиппит чернила; PNG на сервер — только через asset-store) → D4 (режим `probe:"paint"`: прозрачный фон + маргин + одна сессия) и A4 (байтовый канал в CAS); мотивировка §1 исправлена (R1-M1: blur в `getClientRects` не входит — «175» дала коробка потомка).
- R1-B4: захват не запинен к кандидату (head мутирует) → A10 (+пин бандла против `gcCandidates`, R3).
- R1-B5: refcount CAS не по той таблице → A4 (union-refcount, атомарное удаление result-строки, проверка существования при reuse).
- R2-9: перегруз W1 → W1a/W1b/W1c; R2-10: W5 → W5a/W5b.
- R3: kill-switch физически не проброшен в compose → W0; `mem_limit: 1g` → §4.6 + замер RSS; asset-store ingest капчуров без GC → A4.

**Принятые major (сводно).** R1-M2 (единицы CSS/device px → D4), R1-M3 (два несопоставимых кадра → combined-сессия), R1-M4 (`dimensionMismatch` без метрик → нормализация A5/W5a), R1-M5 (диспетчеры v3 → D8/W8a), R1-M6 (event-wiring нереализуем → W8d переписан на параметр-действие; изменение §19.4.5 в не-целях), R1-M7 (вечный `running` → watchdog D2), R1-M8 (per-user validate-слот → W1c), R1-M9 (корпус матчера без композиций → W9), R2-2 (severity-ранжирование → D10), R2-3 (четыре поля качества → D11), R2-4 (авто-retry infra → A3), R2-5 (свёртка вердикта → D10), R2-6/7 (KPI-переформулировки + гейт O1 → §1/§4), R2-11 (geometry v1 → advisory в W1a), R2-12 (инвалидация фингерпринтов → `algoVersion`; reuse-KPI с W5b), R2-13 (done W2/W4 без visual → перенесено в W5a), R2-14 (наблюдённые theme-ресурсы → W4), R2-16 (пары §6: W7‖W9 запрещена; сгенерированные артефакты только регенерацией), R2-17 (§6 дополнен `main.ts`/`docs/server-api.md`/`validation.ts`/SDK), R2-18 (полярность флагов → `EASYUI_ACCEPTANCE_MATRIX` opt-in; слоты — отдельный деплой W1c), R2-19 (чек-лист отката: CAS-каталог, зависшие раны), R3 (FK на publishes → A9 TEXT без FK; NOT NULL DEFAULT 'off'; ADD COLUMN без перестройки; маппинг partial-index → 409), R3 (authz-контракт всех роутов, capture/share 403, артефакты только через runId, owner_id NULL) → W1a, R3 (zip вместо tar, zip-slip: charset + санитизация + клиент) → A4/W2/W7, R3 (identity в ключе кэша, 0700, SHA256SUMS-проверка, кэш ≠ свидетельство) → W7, R3 (e2e в `e2e/preview/`, `playwright.config.ts` в W8) → §5/§7, R3 (RESULT_TTL 10 мин → §4.5; резервирование очереди → §4.7; maintenance-lock → §4.8; бэкап volume → W0/§7.6; бюджет §4 честнее: 98 запусков до W3).
**Принятые minor.** Sizing-токены в W8e; `allowedRoles` в W8c; фикстура «Benefit list»; дедуп references (A7); схема ключей repeat (W8b); нормализация `refineCompositionDoc` (W8c); KPI evidence «терминализованных оркестратором» (§1); «после первой v3-записи откат = чистка данных» (D9); SDK-реген (§6); colorProfile best-effort (§8); W8a–f — внутренние инкременты; замер прироста байт CAS (§4/§7.7).

**Отклонено/переформулировано.**
- R2-15 «W2 после W3/W4»: отклонено — вместо перестановки `manifestVersion: 1` с forward-совместимой схемой; ранний манифест ценен для W1-cases и coverage.
- R2-8 «`allowedTypes` теряет роли ДС»: принято частично — добавлен `allowedRoles`, `allowedTypes` сохранён как дополнительное ограничение.
- R2-21 «неизмеряемые KPI»: закрыто привязкой замеров к done W5b и W7; отдельный KPI-процесс не заводится.
- R1-m2 «политика в Expected тавтологична»: принято к сведению — политика сверяется сервером по хешу в результате, в Expected не дублируется.
- R3 «O1 планировать сразу, а не опцией»: оставлен гейтом по замеру W1b (не безусловным объёмом) — изоляция worker-runner ценна, ломать её до фактов преждевременно; гейт делает решение автоматическим.
