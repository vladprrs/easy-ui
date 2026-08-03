# План: Matrix Acceptance, Geometry/Readiness 2.0, Reference Mapping и Composition v3

Дата: 2026-08-03. Статус: **draft для Stage 2 (адверсариальное ревью)**. Источник требований: `docs/EASYUI_PRODUCT_IMPROVEMENTS.md` §19 (P0.1–P0.4, P1.1–P1.4, KPI §19.10). База: `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md` v4 (R1 — promote-сага — в проде; R2/R3 — не начаты).

Процесс: Stage 1 (планирование) пройден; далее Stage 2 — адверсариальное ревью, триаж вносится в этот файл; реализация — волнами по отдельным командам.

> Очередь исполнения: трек A (W1→W7) — поверх посаженного R1; трек B (W8→W9) идёт параллельно с W2+ (файловые множества не пересекаются, кроме `server/contracts.ts`/`openapi.json`/`driver.mjs` — протокол шаринга в §6).

---

## 1. Задача и цели

Сегодня приёмка семейства из 49 состояний (`pay-payment-card`) — это 100–150 клиентских операций, 2–4 самописных matrix-скрипта, ручная агрегация SHA и geometry-вердикты, которые врут («карточка шириной 175px» при layout-ширине 140px — эффектная подсветка попала в измеренные bounds). Draft-скриншот `pay-action-button` снялся до появления theme-иконки и попал в визуальную оценку. Никакая из этих проблем не лечится клиентом.

Цель пакета — **один серверный вызов вместо семейства**: immutable кандидат + набор верификационных случаев → durable run с per-case вердиктами, честной геометрией (layout/paint/overflow), доказанной readiness, сгруппированными визуальными причинами и content-addressed evidence; повторная правка пересуёмывает только затронутые случаи. Параллельно — снять причину, по которой продуктовые блоки уходят в TSX (Composition v3).

### KPI (§19.10) и как меряем

| KPI | Baseline | Цель | Инструмент измерения |
|---|---:|---:|---|
| Клиентские операции на семью 49 cases | 100–150 | 1 постановка + polls | `driver.mjs accept --case-set …` (W2), счётчик вызовов в cache-логе (W7) |
| Ручные matrix-скрипты | 2–4 | 0 | ревью PR семейства |
| Cases, снятые до font/asset readiness | возможны | 0 | gate `readiness` (W4), метрика `readinessFailures` в run-репорте |
| Geometry failures без названного descendant/cause | возможны | 0 | контракт gate `geometry`: `fail` обязан нести `overflow.sources[]` (W3), тест-инвариант |
| Product-блоки в TSX из-за ограничений composition | регулярно | <10% | analyzer-вердикт (W8g) в аудите `catalog candidates` |
| Повторные captures неизменившихся cases | полный rerun | <10% | `run.progress.reused / total` (W1+W6) |
| Runs с автособранным SHA evidence | 0% | 100% | наличие `evidence_manifest_hash` на каждом терминальном run'е (W1) |
| source-ready → actionable family verdict | десятки шагов | <10 мин | замер wall-clock в done-критериях W1/W5 (§7) |

Про «<10 минут» — честно: см. §4 (бюджет ёмкости). Он достижим только совокупностью «дедуп props + determinism на выборке + reuse», и первый холодный run семейства из 49 cases остаётся в диапазоне 8–15 минут на 1-CPU проде. Это записано в контракт (`eta`), а не спрятано.

---

## 2. Поправки к RFC candidate-acceptance (обязательный раздел)

RFC v4 прошёл два раунда адверсариального ревью; его решения по умолчанию **сохраняются**. §19 местами предлагает конструкции, которые триаж RFC уже отклонил. Ниже — полный список: что оставлено, что изменено и почему.

### 2.1. Решения RFC, которые сохраняются без изменений

| Решение RFC | Почему §19 его не отменяет |
|---|---|
| **Identity кандидата component-scoped**: `candidate_id = "cand_"+sha256({componentId, designSystem, rev, buildFingerprint})`, `buildFingerprint = sha256({sourceHash, bundleHash, hostAbiVersion, themeVersion})` | §19.1 предлагает передавать кандидата инлайном `{rev, sourceHash, bundleHash, themeVersion}` — это ровно та модель, которую триаж RFC отклонил: один `sourceHash` принадлежит нескольким компонентам (`server/components/candidates.ts`, `componentIds` — множество), ключ без `componentId` коллидирует и даёт cross-owner disclosure. **Инлайн-кандидат не вводится.** `POST /api/acceptance-runs` принимает `candidateId`; клиент получает его из `POST /api/components/:id/candidates`. |
| `catalogRevision` вне идентичности, `policyProfileHash` вне `buildFingerprint` | без изменений |
| Оркестратор **вне** screenshot-помпы, ≤1 running run на процесс, capture-джобы по одной с backoff на `429 queue_full`; отдельный системный validate-слот | §19.1 просит клиентскую `concurrency` — не поддерживается; `cases.concurrency` в запросе **отвергается 422** (сервер владеет параллелизмом; на 1 CPU он равен 1) |
| Стартовая уборка: все `queued\|running` раны → `error` | сохраняется; см. поправку A3 — это больше не теряет работу |
| Evidence **не** в asset-store (GC ассетов нет, `component_publish_assets` FK RESTRICT) | сохраняется; см. поправку A4 о форме хранения |
| `≤1` нетерминальный run на кандидата (partial unique index); `cancel` только из `queued` | сохраняется |
| `409 acceptance_run_in_flight` на promote при живом run'е; `pass_with_exceptions` только при `allowExceptions` (в `default-v1` выключено) | сохраняется |
| Гейты `regression`/`interactions` = `not-implemented` | сохраняется (не-цели §8) |
| Kill-switch `EASYUI_ACCEPTANCE_DISABLED`, булевы `capabilities.features.acceptance*` | сохраняется, расширяется новыми флагами |

### 2.2. Поправки (амендменты) к RFC

**A1. Матричная семантика: per-case durable-строки.** RFC R2 описывал run как набор gate-результатов в `gates_json`. §19.1 требует матрицы. Амендмент: таблица `acceptance_cases` (строка на случай) и `acceptance_case_results` (content-addressed результат случая). `gates_json` остаётся **run-level агрегатом** (его известное ограничение «не запрашиваемо по gate» сохраняется), per-case запросы обслуживает новая таблица. Без durable-строк невозможны ни прогресс/ETA, ни reuse, ни P1.4.

**A2. Источник cases и место manifest'а.** §19.1 предлагает `cases.manifestAssetId` — манифест как ассет. Амендмент: манифест — **сущность продукта** (`component_case_sets`, W2), а не ассет; ассет неизменяем и невалидируем, а манифест обязан валидироваться сервером (§19.5 требует ровно этого: полнота tuples, SHA references, дубли props, crop lineage). В W1 источник cases — **именованные examples кандидата** (уже приезжают в `bootstrap.examples`), что даёт ценность до появления манифеста. `manifestAssetId` не поддерживается никогда.

**A3. Resume — не мутация упавшего run'а, а дешёвый новый run.** §19.1 требует «resumable очередь», RFC требует «при рестарте всё in-flight → error». Оба сохраняются без противоречия: **run иммутабелен**, resume = новый run по тому же `{candidateId, caseSetId}`, который **переиспользует per-case результаты по `case_fingerprint`** (content-addressed) и пересуёмывает только недостающие/принудительно обновляемые. Стоимость повторного вердикта после падения на 40-м случае из 49 — 9 захватов, а не 49. Этот же механизм — фундамент P1.4 (W6). Форсирование — `refresh: "none" | "failed" | "all" | {caseIds:[…]}` (аналог `--refresh` из §19.7), причина форса пишется в evidence.

**A4. Evidence: per-run манифест + content-addressed CAS.** RFC выбрал `<dataDir>/.acceptance/<runId>/` + `SHA256SUMS`. §19.1 требует cross-run дедупликации. Амендмент: **артефакты** (PNG, geometry JSON, diff PNG) лежат в `<dataDir>/.acceptance/cas/<sha256[0:2]>/<sha256>`, а `<dataDir>/.acceptance/<runId>/manifest.json` + `SHA256SUMS` перечисляют артефакты случая **ссылками на CAS**. Путь по-прежнему выводится из `runId` после regex-валидации (нет колонки `evidence_dir`). GC: артефакт удаляется, когда на него не ссылается ни один run в пределах TTL (`refcount` считается запросом по `acceptance_cases`, не колонкой-счётчиком — счётчик рассинхронизируется при крэше). Asset-store не используется. Экспорт `GET /api/acceptance-runs/:runId/evidence` материализует tar из CAS.

**A5. Минимальный визуальный гейт до VDC 2.0.** RFC: `visual` = `not-implemented`, потому что «визуальный гейт непубличной ревизии требует новой fingerprint-модели references». §19 требует `visual` в матрице. Амендмент: гейт `visual` включается в **минимальной форме** в W5 и обходит блокер RFC не построением новой fingerprint-модели, а тем, что **reference приходит из case-set** (`referenceAssetId` per case, W2) — эталон привязан к случаю манифеста, а не к опубликованной версии. Что **не** входит и остаётся за VDC 2.0: lifecycle exceptions (approve/expire/review issue), promotion baseline'ов, per-DS автоприёмка эталонов, интеграция с `visual_references`/`visual_runs` (остаются отдельной подсистемой, W5 их не мигрирует). Гейт: `pass|fail` для случаев с эталоном, `skipped` — без эталона; `default-v1` делает его **обязательным только если case-set помечен `requireVisual: true`**.

**A6. Политики: именованный реестр-константа, per-case override из манифеста; таблицы нет.** RFC: `default-v1` — константа кода до второго реального профиля. §19 просит именованные per-DS профили. Амендмент: **реестр констант** `server/acceptance/policies.ts` с `default-v1` и `pixel-strict-v1` (второй реальный профиль — pixel-perfect-приёмка Figma-семейств), per-case допуски приезжают из манифеста и хешируются в `case_policy_hash`. `policy_profiles` как таблица + CRUD — **не в этом пакете** (момент введения — профиль, который нужно менять без деплоя).

**A7. Ёмкость: явные лимиты вместо клиентской конкурентности.** Новые `capabilities.limits`: `acceptanceMaxCasesPerRun` (дефолт 64), `acceptanceMaxJobsPerRun` (RFC), `acceptanceCaseTtlHours`, `evidenceMaxBytes`. Дедупликация одинаковых `propsHash` — **до** постановки (одна съёмка, N ссылающихся case-строк, `aliasOfCaseId`).

**A8. `POST /api/components/{id}/acceptance-runs` (§19.1) не вводится.** Канон RFC — `POST /api/acceptance-runs` (run — субъект первого класса, авторизация по денормализованному `component_id`). Два пути к одной сущности — источник расхождений.

---

## 3. Ключевые проектные решения

- **D1. `case_fingerprint`** — ядро reuse, дедупа и P1.4:
  ```
  case_fingerprint = sha256(canonicalJson({
    buildFingerprint,              // кандидат: sourceHash+bundleHash+hostAbi+themeVersion
    caseKey,                       // стабильный id случая (example name | manifest case id)
    propsHash,                     // существующий propsHashOf
    surface: { viewport, dsf, theme },
    readinessPolicyHash,           // W4 (до W4 — хеш константы v0)
    captureEnvFingerprint,         // W4: browser/platform/dpr/fontRaster/rendererBuild
    casePolicyHash,                // W2: per-case допуски + профиль
    referenceAssetId | null        // W2/W5
  }))
  ```
  Колонки для всех компонентов заводятся **в W1** (значения-заглушки до W3–W5), чтобы не было второй миграции.
- **D2. Run иммутабелен; `acceptance_cases` — единственная мутируемая часть** (`status`, `verdict`, `result_fingerprint`, `reuse_reason`, тайминги). Терминализация run'а — одна короткая транзакция (канон bun:sqlite: без `await` внутри).
- **D3. Геометрия: факты в capture, вердикт на сервере.** `geometry.mjs` отдаёт измерения (`layoutBounds`, `effectSources`, `clipChain`), `paintBounds` меряется по пикселям снимка, `policyVerdict` считает чистая функция (`src/capture/geometryPolicy.ts`), покрытая unit-тестами без DOM — тот же канон, что `analyzeGeometry`.
- **D4. `paintBounds` — измеряется, а не выводится из CSS.** Формулы расширения от `filter: blur()`/`box-shadow` дают лишь консервативную верхнюю границу (blur(68px) по спеке даёт ~100px, наблюдалось 17–18px — разница в разы). Поэтому `paintBounds` = ink-bbox по PNG (альфа при прозрачном фоне, иначе разница с цветом угла; поле `paintBoundsSource: "alpha"|"background-diff"`), а CSS-разбор — **только для атрибуции** (какой descendant и какое свойство), что и требует §19.2.
- **D5. Readiness — декларативная политика, а не задержки.** Политика версионируется и хешируется, evidence readiness'а сохраняется на случай; **capture, не прошедший readiness, не попадает ни в один визуальный вердикт** (жёсткий инвариант, тест).
- **D6. Impact — консервативный и доказательный.** Никакого статического анализа произвольного JS. Доказуемы только два класса: (а) изменились только литералы `asset_<sha256>` в исходнике (`sourceShapeHash` совпал) → пересъёмка только случаев, чьи наблюдённые в baseline-run'е ресурсы пересекаются с изменённым множеством; (б) сменилась только версия темы → пересъёмка только случаев, чьи наблюдённые токены/иконки/шрифты пересекаются с диффом темы. Всё прочее → **полная пересъёмка** с явным `basis: "conservative"`.
- **D7. Composition v3 — expansion-time, не runtime.** Композиции раскрываются при сохранении (`expandCompositions`/`expandPrototypeForSave`), поэтому все новые возможности v3 обязаны быть **статически разрешимы от значений параметров в точке ссылки**. `$if`/`$switch` v3 — по параметрам; ветвление по `doc.state` остаётся существующим `$cond` внутри тела и проходит через раскрытие как есть. Эта граница — главный инвариант W8, первой строкой в `docs/prototype-format.md`.
- **D8. Формат композиций аддитивен**: `version: 3` — новая ветка discriminated union; v1/v2 документы читаются и раскрываются байт-в-байт как раньше; опубликованные прототипы неизменны.
- **D9. Kill-switch'и с дефолтом OFF там, где прод может накопить необратимые данные**: `EASYUI_COMPOSITION_V3=1` (прецедент `EASYUI_SURFACES`). Acceptance-ручки гасятся существующим `EASYUI_ACCEPTANCE_DISABLED=1` (обратная полярность — фича включена по умолчанию, гашение аварийное).

---

## 4. Бюджет ёмкости (честно)

Замеры делаются в W1 (done-критерий — записать факт в план), оценка на входе:

| Стадия на 1 case | Оценка |
|---|---|
| capture image (запуск воркера + навигация + readiness + PNG) | 4–8 с |
| geometry probe (отдельная джоба: geometry и image взаимоисключающи) | 3–6 с |
| ink-bbox + diff + классификация причин (node-подпроцесс) | 0,5–1,5 с |

49 cases холодным run'ом ⇒ **8–15 минут**. Меры, вшитые в план:
1. дедуп по `propsHash` до постановки (в реальных семьях 49 tuple'ов дают 30–40 уникальных props);
2. gate `determinism` — на **выборке** (`determinismSampleSize` в политике, дефолт 3 случая + все `fail`-случаи), а не на всех 49;
3. reuse по `case_fingerprint` — повторный вердикт после правки одного ассета: <1 минуты (P1.4);
4. `acceptanceMaxCasesPerRun = 64` — потолок, за ним `422 case_set_too_large`;
5. `eta` в статусе: EMA длительности незареюзанных случаев × остаток, плюс `basis: "measured"|"estimate"`.

Опциональная оптимизация O1 (**не** в объёме, включается решением после замера W1): переиспользование прогретого browser-процесса между джобами одного run'а — экономит ~1,5 с/джоба, но ломает изоляцию `worker-runner`; вводится отдельным решением, если замер даёт >15 мин.

---

## 5. Волны

Порядок трека A: **W1 → W2 → W3 → W4 → W5 → W6 → W7**. Трек B (**W8a…W8g → W9**) стартует параллельно с W2.

### W1 — Durable-база и matrix-run (RFC R2 + per-case слой)

**Объём.** `component_candidates`, `acceptance_runs`, `acceptance_cases`, `acceptance_case_results`; оркестратор вне помпы; гейты фазы 1 (`contract`/`defaults`/`render`/`geometry`(v1)/`determinism`/`audit`); CAS-evidence + манифест; прогресс/ETA; дедуп props; reuse по `case_fingerprint`; источник cases — examples кандидата; advisory-режим ДС (RFC §7); CLI `accept`.

**Новые файлы.** `server/acceptance/{ids,policies,repo,orchestrator,runner,evidence,cases}.ts`, `server/acceptance/gates/{index,contract,defaults,render,geometry,determinism,audit}.ts`, `server/routes/acceptance.ts`, `server/acceptance/{repo,runner,evidence}.test.ts`.
**Изменяемые.** `server/migrations.ts` (**v25**), `server/contracts.ts`, `server/openapi.json` (регенерация), `server/main.ts` (диспатч роутов), `server/components/validate.ts` (пул слотов: интерактивный cap + системный слот), `server/screenshot/service.ts` (публичный `enqueueComponentDraftFrozen` для оркестратора + backoff-контракт), `server/components/promote.ts` (опциональные `candidateId`/`acceptanceRunId`, `409 acceptance_run_in_flight`, ссылки в Phase B), `.claude/skills/author/driver.mjs` + зеркала (`scripts/sync-share-skills.mjs`), `docs/server-api.md`.

**Схема (v25).**
```
component_candidates(...)             -- ровно как RFC §3.2
acceptance_runs(...)                  -- как RFC §3.3, + case_set_id TEXT NULL, policy_profile_id TEXT,
                                         progress_json TEXT, impact_json TEXT NULL
acceptance_cases(
  run_id TEXT, case_id TEXT, case_key TEXT, props_hash TEXT,
  case_fingerprint TEXT, case_policy_hash TEXT,
  reference_asset_id TEXT NULL, expected_geometry_json TEXT NULL,
  status TEXT,          -- pending|running|done|error|skipped
  verdict TEXT NULL,    -- pass|fail|skipped
  gates_json TEXT NULL, alias_of_case_id TEXT NULL,
  reuse_reason TEXT NULL, started_at TEXT NULL, finished_at TEXT NULL,
  PRIMARY KEY (run_id, case_id))
acceptance_case_results(
  case_fingerprint TEXT PK, artifacts_json TEXT, metrics_json TEXT,
  verdict TEXT, produced_run_id TEXT, created_at TEXT, last_used_at TEXT)
component_publishes.candidate_id / .acceptance_run_id  (nullable + FK ON DELETE SET NULL)
design_systems.acceptance                              (off|advisory, default off)
```
Индексы: `acceptance_cases(case_fingerprint)`, partial unique «≤1 нетерминальный run на кандидата», `acceptance_case_results(last_used_at)`.

**API.**
```http
POST /api/components/:id/candidates      {}                       -> candidate
GET  /api/component-candidates/:id
POST /api/acceptance-runs  { candidateId, idempotencyKey?, caseSetId?, cases?: [{key, props}],
                             checks?: string[], policy?: "default-v1"|"pixel-strict-v1",
                             refresh?: "none"|"failed"|"all"|{caseIds:[]} }
GET  /api/acceptance-runs/:runId          -> { status, gates, progress:{total,completed,reused,failed,running},
                                               eta:{secondsRemaining,basis}, failedCases:[{caseId,gate,cause}] }
GET  /api/acceptance-runs/:runId/cases    -> per-case вердикты + ссылки на CAS
GET  /api/acceptance-runs/:runId/evidence -> tar (owner|admin)
POST /api/acceptance-runs/:runId/cancel   -> только queued
```
422-коды: `case_set_too_large`, `duplicate_case_props` (без `aliasOf`), `unsupported_option` (для `cases.concurrency`/`manifestAssetId`); `candidate_stale` не вводится (канон — `409 revision_conflict`).

**Флаги.** `features.acceptanceCandidates`, `features.acceptanceRuns`, `features.acceptanceMatrix`; лимиты §A7. Kill-switch — существующий.
**Done.** `npm run verify`; новые unit-тесты (fingerprint-детерминизм, reuse, стартовая уборка, дедуп props, partial-index, CAS GC не удаляет живой артефакт); e2e `e2e/dev/acceptance-run.spec.ts` (run на фикстурном компоненте с 3 examples: pass, затем повтор — `reused: 3`); прогон миграции на копии прод-БД; `driver.mjs accept <id> --json` — одна команда до вердикта; **записан замер wall-clock** на 20 и 49 cases.
**Риски.** Голодание интерактивных джоб (митигация RFC: по одной джобе, глубина вытеснения ≤1); зависший run при крэше (стартовая уборка + reuse делает потерю дешёвой); рост CAS (потолок `evidenceMaxBytes` + GC по TTL, тест на вытеснение).

### W2 — Reference Mapping (case-sets) — P1.1

**Объём.** Манифест §19.5 как сущность; валидация; coverage-отчёт; per-case политика; подключение `caseSetId` к run'у.

**Новые файлы.** `server/acceptance/caseSets.ts`, `server/routes/caseSets.ts`, `src/acceptance/caseSetSchema.ts` (zod, общий с клиентом/драйвером), `server/acceptance/caseSets.test.ts`.
**Изменяемые.** `server/migrations.ts` (**v26**: `component_case_sets`), `server/figma.ts` (переиспользование валидаторов `fileKey`/`nodeId`), `server/acceptance/{runner,policies}.ts`, contracts/openapi, `driver.mjs` (`case-set put/get/coverage`), `docs/server-api.md`.

**Схема/API.**
```
component_case_sets(case_set_id PK, component_id, design_system, manifest_json,
                    case_count, source_file_key, source_node_id, created_by, created_at)
case_set_id = "cset_" + sha256(canonicalJson(manifest))   -- контентная адресация, повтор идемпотентен

PUT  /api/components/:id/case-sets   { manifest }  -> { caseSetId, cases, warnings[] }
GET  /api/case-sets/:caseSetId
GET  /api/case-sets/:caseSetId/coverage -> { dimensions, expectedTuples, presentTuples, missingTuples[], duplicates[] }
```
Манифест — как §19.5 плюс: `dimensions` (для coverage), `capture: {viewport, dsf, theme}` (общий для набора — иначе эталоны несопоставимы по размеру), `requireVisual?: boolean`, `policy: {profile, perCase overrides}`.
Валидация: существование `referenceAssetId` в реестре ассетов (`422 asset_not_found`), уникальность `case.id`, дубли `propsHash` (`422 duplicate_case_props`, если не помечены `aliasOf`), `cropLineage.rect` внутри родителя, `props` против `propsJsonSchema` head-кандидата — **warning**, не блокер (схема живёт на ревизии, манифест — на компоненте).

**Done.** `verify`; e2e: манифест на 9 cases → run с эталонами → coverage 0 missing; отказы на дублях/битом ассете; драйвер публикует манифест и печатает coverage. **Риск:** дрейф `propsJsonSchema` между ревизиями — warning + coverage-отчёт на каждом run'е.

### W3 — Geometry Contract 2.0 — P0.2

**Объём.** `layoutBounds`/`paintBounds`/`overflow.sources`/`clipChain`/`policyVerdict`; ink-bbox по PNG; gate `geometry` v2 против `expectedGeometry` из case-set.

**Новые файлы.** `src/capture/geometryPolicy.ts` (+`.test.ts`), `scripts/ink-bbox-worker.mjs` (по канону `scripts/visual-diff-worker.mjs`), `server/acceptance/gates/geometry2.ts`.
**Изменяемые.** `src/capture/geometry.mjs` (+`geometry.d.mts`, тесты), `scripts/screenshot-worker.mjs`, `server/screenshot/service.ts` (`geometryDetailKeys` в джобе, поля результата), `server/contracts.ts`/openapi, `docs/server-api.md`.

**Контракт (аддитивно, `rects[]` не меняется).** Новый блок вычисляется только для ограниченного множества ключей (`geometryDetailKeys`, ≤20; по умолчанию — корневой маркер):
```json
{"key":"root","layoutBounds":{"x":0,"y":0,"width":140,"height":96},
 "paintBounds":{"x":-18,"y":-17,"width":175,"height":130},
 "paintBoundsSource":"alpha",
 "overflow":{"left":18,"right":17,"top":17,"bottom":17,
   "sources":[{"elementPath":"div>span[data-eui-key=highlight]","elementKey":"highlight",
               "cause":"filter:blur(68px)","contribution":{"left":18,"top":17}}]},
 "clipChain":[{"key":"card-skin","property":"overflow","value":"hidden","effective":true}],
 "policyVerdict":"paint-overflow-not-clipped"}
```
- `layoutBounds` — union border-box'ов **in-flow** потомков (`position: static|relative|sticky`, не hidden); out-of-flow (`absolute|fixed`) и трансформированные потомки исключены и попадают в атрибуцию.
- `paintBounds` — ink-bbox из PNG (альфа/фон-разница), считается в `ink-bbox-worker.mjs`; при недоступности — `paintBoundsSource: "css-upper-bound"` с консервативной оценкой и пометкой в вердикте.
- `overflow.sources` — ранжирование потомков, чей эффект (`filter`, `box-shadow`, `outline`, `transform`, out-of-flow позиция) пересекает соответствующую сторону overflow.
- `policyVerdict` ∈ `clean | paint-overflow-clipped | paint-overflow-not-clipped | layout-overflow | indeterminate`; считает `geometryPolicy.ts` от фактов + per-case допусков (`allowPaintOverflow`, `expectedClip`).

**Done.** unit-тесты чистой политики (включая кейс 140/175 из фидбэка и «blur внутри `overflow:hidden` → `clean`»); DOM-тест `collectGeometry` на blur-потомке; **инвариант-тест: gate `geometry` не может вернуть `fail` без непустого `overflow.sources` или названного `expectedGeometry`-расхождения**; `verify`. **Риски.** ink-bbox на непрозрачном фоне (митигируется `paintBoundsSource` + `indeterminate` вместо ложного fail); бюджет CPU (ограничение `geometryDetailKeys`).

### W4 — Deterministic Capture Readiness — P0.3

**Объём.** Декларативная readiness-политика, расширенный handshake, `captureEnvFingerprint`, gate `readiness`, инвариант «не-ready кадр не идёт в визуальный вердикт».

**Новые файлы.** `src/capture/readinessPolicy.ts` (схема+хеш, общий клиент/сервер), `src/capture/env.ts` (env-fingerprint, font-raster probe), `server/acceptance/gates/readiness.ts`, тесты.
**Изменяемые.** `src/capture/readiness.ts`, `src/capture/protocol.ts` (поля `readiness`/`env` в Expected/Ready), `src/capture/CaptureComponent.tsx`/`CaptureSurface.tsx`, `scripts/screenshot-worker.mjs` (network-quiet, 2 стабильных rAF, отключение анимаций), `server/screenshot/service.ts` (проброс политики, `CaptureQuality` → `+readiness`), `server/screenshot/noise.ts`, contracts/openapi, `docs/server-api.md`.

```ts
readinessPolicy = { version: 1, fonts: "used-faces"|"document-ready",
  images: "decoded", network: { quietMs: 200, scope: "component-owned" },
  frames: 2, animations: "disabled", timeoutMs: 15000 }
readinessPolicyHash = sha256(canonicalJson(policy))
captureEnvFingerprint = sha256({ browserVersion, platform, dpr, colorScheme,
                                 fontRasterFingerprint, rendererBuild, readinessPolicyHash })
ready.evidence = { fontFaces:[{family,weight,style,status}], images:{total,decoded,failed},
                   pendingRequests:[…], framesWaited, animationsDisabled }
```
**Done.** e2e-регресс на кейс `pay-action-button`: фикстура с намеренно медленной theme-иконкой — без W4 PNG без иконки, с W4 либо ready-кадр с иконкой, либо `readiness_not_met` (и `visual` не выполняется); тест «два подряд захвата дают одинаковый `captureEnvFingerprint`»; `verify` + `npm run e2e`. **Риск.** `network quiet` может вечно ждать на фоновом polling'е — потолок `timeoutMs` и явный список pending-запросов в evidence.

### W5 — Минимальный per-case visual gate + классификация и группировка причин — P1.2

**Объём.** Diff кандидат↔эталон на случай; метрики raw/AA/regions; таксономия §19.6; группировка ремедиаций.

**Новые файлы.** `server/acceptance/gates/visual.ts`, `server/visual/causes.ts` (+`.test.ts` — чистые классификаторы над масками), `server/acceptance/grouping.ts` (+`.test.ts`).
**Изменяемые.** `scripts/visual-diff-worker.mjs` (маска, связные компоненты, AA-дифференциал, best-offset корреляция), `server/visual/diff-runner.ts` (расширенный результат), `server/acceptance/runner.ts`, contracts/openapi.

**Метрики на случай.** `rawDiffPct`, `aaDiffPct`, `maxChannelDelta`, `regions:[{bbox, areaPct, meanDelta}]` (до 12), `bestOffset:{dx,dy,residualPct}`.
**Причины** (каждая — `{code, confidence, detail}`, всегда есть фолбэк `unclassified`): `surface-tint`, `edge-radius-stroke`, `geometry-shift`, `text-raster-residual`, `missing-late-asset` (перекрёстно с readiness-evidence W4), `alpha-compositing`, `effect-overflow` (регионы между `layoutBounds` и `paintBounds` — прямое использование W3), `descendant-outside-mask` (регионы вне `paintBounds`).
**Группировка.** `remediationKey = sha256({causeCode, квантованная относительная bbox-сигнатура, доминирующий elementKey из geometry-карты})`; run-репорт отдаёт `remediationGroups: [{key, cause, sharedElementKey, cases:[…], suggestion}]` — 20 состояний с одной сломанной иконкой дают одну группу.
**Done.** unit-тесты классификатора на синтетических парах PNG (по одному на код таксономии, включая «одна иконка на 20 случаев → 1 группа»); e2e: case-set с эталонами, один сломанный shared-ассет → run `fail` с одной группой; `verify`. **Риски.** Ложные классификации — все причины несут `confidence`, вердикт `fail/pass` **никогда** не зависит от классификации (только от порогов diff), классификация — исключительно диагностика.

### W6 — Impact и частичная пересъёмка — P1.4

**Объём.** D6: `sourceShapeHash`, наблюдённые ресурсы случая, диффы темы, `POST …/impact` (dry-run) и `mode: "impact"` на run'е.

**Новые файлы.** `server/acceptance/impact.ts` (+`.test.ts`), `server/acceptance/resources.ts` (нормализация наблюдённых ресурсов из readiness-evidence W4).
**Изменяемые.** `server/acceptance/{runner,repo}.ts`, `server/routes/acceptance.ts`, `server/components/candidates.ts` (`sourceShapeHash` рядом с `sourceHash`), contracts/openapi, `driver.mjs` (`accept --baseline-run <id>`, `impact`).
```http
POST /api/components/:id/impact { candidateId, baselineRunId } ->
  { basis: "asset-only"|"theme-only"|"conservative", changedAssets[], changedTokens[],
    affectedCases[], unaffectedCases[], recaptureCount, reason }
```
**Done.** Тест сценария §19.8: 49 cases, замена одного `BalanceHidden`-ассета → `recaptureCount` = числу случаев, реально использующих ассет; «любая другая правка исходника → conservative, 49»; e2e; `verify`. **Риск.** Неполнота наблюдённых ресурсов (динамический URL) → нет молчаливого reuse: неизвестный ресурс переводит анализ в `conservative`.

### W7 — Client-side evidence cache — P1.3

**Объём.** `--cache-dir` в `driver.mjs`; только клиент, серверных зависимостей нет.

**Новые файлы.** `.claude/skills/author/cache.mjs` (+ зеркала через `scripts/sync-share-skills.mjs`), `test/driver-cache.test.ts`.
**Изменяемые.** `.claude/skills/author/driver.mjs`, `.claude/skills/*/SKILL.md`, `docs/server-api.md` (раздел «клиентский кэш»).
```
<cache>/requests/<sha256(key)>.json   { request(без секретов), status, headers.etag, body, fetchedAt, fingerprints }
<cache>/blobs/<sha256>                PNG/ассеты
<cache>/receipts/<verb>/<key>.json    job-receipts + история polling'а
<cache>/links.json                    candidate → run → cases → artifacts → report
<cache>/SHA256SUMS
key = sha256({ baseUrl, method, path, sortedQuery, canonicalBody, apiVersion })   // токены/куки не входят и не пишутся
```
Кэшируются: read-only GET'ы (catalog/get/capabilities/case-sets), **терминальные** acceptance-run'ы и их evidence, capture-результаты по `case_fingerprint`. Валидация: ETag, если есть; иначе совпадение фингерпринтов ответа (`buildFingerprint`, `catalogRevision`, `case_fingerprint`). `--refresh` форсирует промах и пишет `refreshReason`. Любой `--json`-ответ получает `cache: {status:"hit"|"miss"|"refresh", key, reason}`.
**Done.** unit-тесты (hit/miss/refresh, отсутствие секретов — grep-тест, стабильность ключа при перестановке query); ручной прогон: повтор `accept` на неизменившемся кандидате не делает ни одного capture-запроса; `verify`. **Риск.** Устаревший hit — в ключ входит `apiVersion`, в валидацию — фингерпринты; `--refresh` документирован в скилле.

### W8 — Composition v3 (трек B) — P0.4

Подволны последовательны внутри трека; каждая — своя `verify`-зелень. Kill-switch `EASYUI_COMPOSITION_V3=1` (дефолт OFF) вводится в W8a и снимается только после приёмки W9.

- **W8a — типизированные параметры и параметрические условия.** `params[*].type += "enum"|"object"|"array"` со схемой/дефолтами/границами (`items`, `maxItems`), `$if`/`$switch` по параметрам, optional branch. Файлы: `src/prototype/composition.ts` (ветка `version: 3`), новые `src/prototype/compositionV3/{params,conditions}.ts` + тесты, `server/validation.ts`, `server/contracts.ts`.
- **W8b — `repeat` по параметру-массиву.** Разворачивание на этапе expansion, key-expression, лимит элементов (учитывается в `EXPANDED_ELEMENTS_LIMIT`). Файлы: `src/prototype/compositionV3/repeat.ts`, expansion в `composition.ts`.
- **W8c — слоты с метаданными.** `slots: {name: {required, allowedTypes[], cardinality:{min,max}, fallback}}` (аддитивно к «списку строк» v1/v2). Валидация в точке ссылки.
- **W8d — event outputs.** `events: {onPick: {payload: schema}}`; внутренний типизированный event маппится в выход композиции, точка ссылки биндит выход на action/state хоста; никакого event-proxy в TSX. Файлы: `src/prototype/compositionV3/events.ts`, правки expansion (переписывание props действий).
- **W8e — token layout.** Ограниченная схема `layout: {flow, gap, padding, align, justify, radius, clip, background}` на элементах композиции — компилируется в существующий host-примитив со spacing/layout-контрактом v1; новых рантайм-примитивов не появляется.
- **W8f — варианты.** `variants: {name: {tuples[], defaults}}`; ссылка может передать `variant`; варианты экспортируются в case-set-измерения (стык с W2).
- **W8g — анализатор и preview-дерево.** `POST /api/compositions/analyze {doc}` → `{verdict: "composition"|"extend-component"|"needs-ownership-component", reasons[], unsupported[]}`; `POST /api/compositions/:id/preview-tree {params, slots}` → resolved params, выбранные ветки, привязки слотов и событий, владелец раскладки, раскрытое дерево (без capture). Файлы: `src/prototype/compositionAnalyze.ts` (+тесты), `server/routes/compositions.ts`.

**Отложено осознанно.** §19.4.7 **responsive branches** — container-width брейкпоинты требуют измерения на рантайме, что несовместимо с expansion-time-моделью (D7); реализация означала бы рантайм-интерпретатор композиций — отдельный RFC. Записано как не-цель с обоснованием.
**Done трека.** Раскрытие v1/v2 байт-в-байт не изменилось (снапшот-тесты); фикстуры «FAQ list», «Payment schedule», «Card details» собираются композицией v3 без TSX и проходят `e2e/dev/composition-v3.spec.ts`; kill-switch выключен → `422 composition_v3_disabled`; `docs/prototype-format.md` описывает границу D7; `verify`.
**Риски.** Взрыв раскрытия (`repeat`×`$switch`) — все лимиты проверяются **до** раскрытия и на раскрытом дереве; откат образа на документе v3 (митигация — kill-switch OFF на проде до приёмки).

### W9 — Workbench (трек B)

**Объём.** Снять `422 unsupported_kind` для `proposed.kind === "composition"` в `server/routes/catalogCandidates.ts`; ответ даёт три исхода (§19.4: «собрать composition» / «расширить существующий component» / «нужен новый ownership component») с объяснением и dependency impact (`usages`); вердикт анализатора W8g в ответе; минимальная UI-точка — блок в Library-поиске с тремя исходами. Полноценный визуальный workbench — **не в объёме**.
**Файлы.** `server/routes/catalogCandidates.ts`, `server/catalog/*` (матчер — только чтение), `src/library/*` (минимальный блок), `driver.mjs` (`catalog search` печатает три исхода), `docs/server-api.md`.
**Done.** тест на композиционном кандидате; e2e-путь «поиск → вердикт → создание композиции»; `verify`.

---

## 6. Владение файлами и параллелизм

| Файл | Волны | Правило |
|---|---|---|
| `server/migrations.ts` | W1 (v25), W2 (v26) | **строго серийный**; другие волны миграций не добавляют; трек B миграций не требует |
| `server/contracts.ts`, `server/openapi.json` | W1–W6, W8a/g, W9 | правки только аддитивные; каждая волна в конце гоняет `scripts/generate-openapi.ts` и `check-openapi-drift`; конфликт мержа решается регенерацией |
| `.claude/skills/*/driver.mjs` + зеркала | W1, W2, W6, W7, W8, W9 | «замок драйвера»: одновременно правит **одна** волна; `scripts/sync-share-skills.mjs` в конце волны |
| `server/screenshot/service.ts`, `scripts/screenshot-worker.mjs`, `src/capture/protocol.ts` | W1 (проброс), W3, W4 | W3 и W4 **не параллелятся** между собой |
| `src/capture/geometry.mjs` | W3 | эксклюзив |
| `scripts/visual-diff-worker.mjs`, `server/visual/*` | W5 | эксклюзив; `visual_references`/`visual_runs` не трогаются |
| `server/acceptance/**` | W1 владеет, W2/W5/W6 расширяют своими файлами | новые гейты — только новыми файлами в `gates/` |
| `src/prototype/composition.ts`, `src/prototype/compositionV3/**` | W8a–f | эксклюзив трека B |
| `server/routes/catalogCandidates.ts` | W9 | эксклюзив |

Параллельные пары, разрешённые к одновременному исполнению субагентами: (W2 ‖ W8a–c), (W3 ‖ W8d–f), (W7 ‖ W9). Всё остальное — последовательно.

---

## 7. Верификация

**Инженерный гейт каждой волны:** `npm run verify` + целевые e2e-спеки волны + `npm run e2e` целиком перед закрытием трека.

**Новые e2e-спеки:** `e2e/dev/acceptance-run.spec.ts` (W1), `e2e/dev/case-sets.spec.ts` (W2), `e2e/dev/capture-readiness.spec.ts` (W4), `e2e/dev/visual-causes.spec.ts` (W5), `e2e/dev/acceptance-impact.spec.ts` (W6), `e2e/dev/composition-v3.spec.ts` (W8), `e2e/dev/workbench.spec.ts` (W9).

**Runtime-приёмка (по `.claude/skills/verify`), до снятия любых флагов на проде:**
1. Фикстурный компонент семейства (≥20 cases) + case-set с эталонами; `driver.mjs accept` — одна команда до вердикта; в отчёте per-case таблица, remediationGroups, SHA-манифест.
2. Ломается один shared-ассет → run `fail` с **одной** ремедиационной группой; правка ассета → `impact` показывает ≤ числа затронутых случаев; повторный run переиспользует остальные.
3. Кейс `pay-action-button`: без readiness-политики кадр без иконки, с ней — `readiness_not_met`, визуальный вердикт не выдан.
4. Кейс «карточка 140/175»: `geometry` возвращает `layoutBounds 140×96`, `paintBounds 175×130`, `sources[0].cause = "filter:blur(…)"`, вердикт по политике.
5. Композиционные фикстуры (FAQ list / Payment schedule / Card details) собираются без TSX и рендерятся в плеере.
6. Миграции v25/v26 прогнаны на копии прод-БД; откат образа проверен (новые таблицы не читаются старым кодом).

---

## 8. Явные не-цели

- **VDC 2.0 целиком**: lifecycle exceptions, продвижение baseline'ов, автоприёмка эталонов, миграция `visual_references`/`visual_runs` в acceptance-модель. В объёме — только минимальный per-case гейт (A5).
- **Gate `regression`** (candidate-пин в `PrototypeBootstrapTarget`) и **gate `interactions`** — остаются `not-implemented` (RFC R4+).
- **Режим ДС `required`** — только `off|advisory` (RFC).
- **Таблица `policy_profiles` и CRUD профилей** (A6).
- **Flow-level release gate**, theme impact graph, dependency workbench.
- **Автогенерация галереи из манифеста** (§19.5) — в объёме только `coverage`.
- **Responsive branches композиций** (§19.4.7) и любой рантайм-интерпретатор композиций (D7).
- **Figma API-клиент/квоты** — сервер не ходит в Figma; манифест приносит клиент.
- **GC ассет-стора**, provenance в bundle-формате v3, backfill исторических версий evidence'ом.
- **Полноценный визуальный Composition Workbench** — W9 минимален (API + три исхода + один блок в Library).

---

## 9. Сводные риски пакета

| Риск | Sev | Митигация |
|---|---|---|
| Wall-clock 49 cases не влезает в KPI «<10 мин» | high | §4: дедуп props, determinism на выборке, reuse, честный `eta`; опция O1 по факту замера W1 |
| Ложные визуальные причины дезориентируют агента | med | классификация не влияет на вердикт, только диагностика; `confidence` + `unclassified` |
| ink-bbox неприменим на непрозрачном фоне | med | `paintBoundsSource` + вердикт `indeterminate` вместо ложного fail |
| Рост диска CAS | med | `evidenceMaxBytes`, GC по TTL и отсутствию ссылок, тест вытеснения |
| Reuse переиспользует результат из другой среды | high | `captureEnvFingerprint` внутри `case_fingerprint` (заведён в W1, наполняется в W4) |
| Взрыв раскрытия композиций v3 | med | лимиты до и после раскрытия, kill-switch OFF на проде |
| Конфликты параллельных волн по `contracts.ts`/`driver.mjs` | med | §6: замок драйвера, регенерация openapi, серийные миграции |

### Критические файлы

- `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md` — база трека A
- `server/screenshot/service.ts`, `scripts/screenshot-worker.mjs`, `src/capture/protocol.ts` — capture-пайплайн
- `src/capture/geometry.mjs` — геометрия
- `src/prototype/composition.ts` — формат композиций
- `server/migrations.ts` — v25/v26
