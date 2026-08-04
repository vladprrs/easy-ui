# План: acceptance pipeline — фидбэк 2026-08-04

**Статус:** v1, Stage 1 завершён; Stage 2 (адверсариальное ревью) — в процессе. Источник: `docs/EASYUI_ACCEPTANCE_PIPELINE_FEEDBACK_20260804.md`.

## Контекст

`docs/EASYUI_ACCEPTANCE_PIPELINE_FEEDBACK_20260804.md` — фидбэк после первого боевого end-to-end переноса `pay-card-button` (12 cases) и `pay-payment-card` (49 cases, 2 shards) через контур case-set → accept → evidence → promote (план 2026-08-03, в проде, миграции v28, `EASYUI_ACCEPTANCE_MATRIX=1`). 8 проблем: 4×P0 (promote-линковка в CLI, promote отвергает pixel-strict, reuse вердиктов через границу политики, `--refresh failed` проигрывает impact), 4×P1 (ложный not-found, семантика padded reference, лимиты case-set/sparse families + multi-shard provenance, объём JSON), 1×P2 (уровни reuse).

### Корневые причины (верифицированы по коду)

- **P0-3/P0-4 — один узел, два дефекта** (`server/acceptance/orchestrator.ts`): порог per-case **входит** в `case_fingerprint` (через `casePolicyHash`), но (a) `forceOf("failed")` (:456-470) ищет провальный вердикт по **новому** fingerprint → после смены порога кэш пуст → форс молча снимается; (b) далее `carryBaselineCase` (`runner.ts:461-505`) переносит вердикт baseline-рана под новый fingerprint **не сравнивая** `casePolicyHash`. Плюс: `fingerprintOf` (`runner.ts:74-85`) не пробрасывает readiness-политику профиля (strict-ран получает `DEFAULT_READINESS_POLICY_HASH`), examples-путь использует заглушку `CASE_POLICY_HASH_V0` — смена `--policy` не инвалидирует reuse.
- **P0-2 — эмерджентный отказ, promotion policy не существует**: кандидат при создании всегда штампуется `policyProfileHash(default-v1)` (`server/routes/acceptance.ts:235,245`), а `resolveAcceptanceRefs` (`server/components/promote.ts:126-128`) требует равенства хэша рана и кандидата → любой `pixel-strict-v1` ран падает `acceptance_run_mismatch`. RFC-инвариант: policy вне идентичности кандидата (не пересматривать).
- **P0-1 — чисто клиентский разрыв**: сервер уже принимает `candidateId`/`acceptanceRunId` (роут `components.ts:352-379`, тесты `component-promote.test.ts:310-393`), но `runPromote` в каноне `.claude/skills/author/driver.mjs:1993-2038` их не шлёт и флагов нет. Доп. пробел: одиночный `version()` DTO (`server/repos/components.ts:114`) не возвращает `candidateId`/`acceptanceRunId` (список versions — возвращает).
- **P1-5 — атрибуция фидбэка не совпадает с кодом**: `GET /components/:id` вообще не кэшируется (`cache.mjs classify:90-106`), «cached component list» не существует. Истинная причина неизвестна → волна начинается с расследования.
- **P1-6**: paint-канва = layout + 2×64px (`DEFAULT_PAINT_MARGIN_PX`, `service.ts:120`) × dsf; двухчастный контракт (padded reference vs `expectedGeometry`=layout root) существует, но неявен; `cropLineage.rect` не валидируется против размеров ассета — ловушка двойного crop.
- **P1-7**: `CASE_SET_MAX_DIMENSION_VALUES=32` (`src/acceptance/caseSetSchema.ts:45`) при `acceptanceMaxCasesPerRun=64` — единственная причина шардирования 49 cases; лимиты не видны в capabilities; валидация только через мутирующий PUT.
- **P1-9**: 1800 строк — `runView` (`server/routes/acceptance.ts:168-207`) инлайнит полные `gates[].metrics` всех failed cases; CLI спредит run в `--json` целиком.

## Ключевые решения

- **D-A (P0-2):** убрать hash-равенство; `acceptance_run_mismatch` = только «ран чужого кандидата»; новый предикат `run.policy_profile_id ∈ PROMOTION_POLICY_PROFILES` (оба встроенных профиля) → иначе новый `422 acceptance_policy_mismatch {runPolicyProfileId, allowed}`. Штамп кандидата не менять (информационный, задокументировать). `capabilities.acceptance.promotionPolicyProfiles`. Strict⇒weak получается автоматически.
- **D-B (P0-3/P0-4):** расслоить fingerprint: `frameFingerprint` (входы съёмки: candidateId, caseKey, propsHash, surface, readinessPolicyHash, rendererFingerprint) + `effectivePolicyHash` (всё, что меняет вердикт без пикселей: профиль, gates, geometry/visual-допуски, perCase, requireVisual, expectedGeometry, referenceAssetId+surface, cropLineage); `caseFingerprint = hash({algo, frame, effectivePolicy})`; `CASE_FINGERPRINT_ALGO_VERSION` 5→6 (инвалидация прод-кэша — приемлема). Пересчёт вердикта — отдельный чистый модуль `recompute.ts` по сохранённым `metrics_json` (visual/geometry — пересчитываемы; остальные гейты нет → recapture, никогда не тихий перенос). Алгебра refresh: `effectiveRefresh = requestedRefresh ∪ impactRefresh`, считается на старте, персистится, печатается тройкой; `forceOf("failed")` сначала смотрит вердикты baseline-рана (`repo.cases(baselineRunId)`), потом fingerprint-кэш; непустой explicit-скоуп, схлопнувшийся в ∅ без пересчёта → `422 refresh_scope_empty`.
- **D-C (P1-7):** поднять `CASE_SET_MAX_DIMENSION_VALUES` до 64 (тест-инвариант «≥ acceptanceMaxCasesPerRun»), все лимиты в capabilities, dry-run `POST /api/components/:id/case-sets/validate` + CLI `case-set validate`. `caseSetGroup` **не строить**: с лимитом 64 семьи ≤64 cases однорановые; хвост >64 закрывает D-D.
- **D-D (P1-8):** promote принимает `acceptanceRunIds: string[]` (1..8, взаимоисключимо с одиночным); все раны — один кандидат, terminal pass, promotion-профиль, case-id-множества попарно дизъюнктны (`422 acceptance_coverage_overlap`), опц. `expectedCases` (`422 acceptance_coverage_incomplete`). Хранение: новая плоская TEXT-колонка `acceptance_run_ids` (JSON-массив, без FK — инвариант A9), `acceptance_run_id` остаётся = первый ран.
- **D-E (P1-9):** summary — **серверный** `?view=summary` (экономит провод и клиентский кэш, переиспользуем в UI), CLI `--summary` и drill-down `accept-status --case <id>`; при fail дефолтный `--json` переключается на summary (полный — `--json-full`).

## Волны

Зависимости: `W1 ∥ W2 ∥ W3` (файлово-дизъюнктны) → далее W2→W4 (driver.mjs), W1→W5→W6 (schema), W3→W7 (promote.ts), W1→W8 (orchestrator receipts), всё → W9. Миграции: v29 (W1), v30 (W7). Kill-switches: `EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE` (W1, default on; off = всегда recapture, никогда stale-carry), опц. `EASYUI_PROMOTE_POLICY_STRICT` (W3, откат к старому поведению).

### W1 — расслоение fingerprint, recompute вердиктов, алгебра refresh (P0-3+P0-4) · большая
**Файлы:** `server/acceptance/{ids,caseSets,runner,orchestrator,repo,impact}.ts`, новый `server/acceptance/recompute.ts`, `server/routes/acceptance.ts` (только run-view), `server/migrations.ts` (v29), `server/contracts.ts`, `docs/server-api.md`.
- `ids.ts`: `frameFingerprint()`, `effectivePolicyHashOf(profile, manifest, caseId)`, пересборка `caseFingerprint`, ALGO=6; examples-путь хэширует реальный профиль рана (конец `CASE_POLICY_HASH_V0` в fingerprint-пути).
- `runner.ts`: `fingerprintOf` получает readiness/профиль из `deps.policy`; `CaseExecution` несёт тройку фингерпринтов; reuse-lookup по `frameFingerprint` при промахе `caseFingerprint` → recompute; `carryBaselineCase` сравнивает `effective_policy_hash`: равен → carry как сейчас; различен → `reevaluateGates` (`frameReused:true, verdictRecomputed:true`, `reuseReason:"recompute:policy"`) либо recapture.
- `recompute.ts`: чистый `reevaluateGates(gates, policy, item) → {gates, reevaluable, changed}`; visual: `rawDiffPct` vs новый бюджет + severityClass; geometry: сохранённые дельты vs допуски; остальные — `reevaluable:false`.
- `orchestrator.ts`: `startRun` считает и персистит `{requested, impact, effective}` (`refresh_json`); `forceOf("failed")` — baseline-вердикты first; `carryable` минус `effectiveRefresh`; `422 refresh_scope_empty`.
- `repo.ts`: `caseResultForFrame()`, запись `frame_fingerprint`/`effective_policy_hash` в результат.
- **v29** (всё nullable, без backfill): `acceptance_case_results` +`frame_fingerprint`,`effective_policy_hash`+индекс; `acceptance_cases` +те же+`reuse_receipt_json`; `acceptance_runs` +`refresh_json`.
- API: `run.refresh{requested,impact,effective}`, `progress.frameReused/verdictRecomputed`.
- **Тесты:** `recompute.test.ts` (флип вердикта от порога в обе стороны, нереэвалюируемый гейт); `ids.test.ts` (порог меняет case- но не frame-fingerprint; `--policy` меняет hash на examples-пути; ALGO=6 литералом); `orchestrator.test.ts` — **точный репро фидбэка**: смена только порогов + `--refresh failed --baseline-run` ⇒ frames reused=25, verdictRecomputed=8, recapture=0, pass; `runner.test.ts` (отказ carry поперёк политики); `refresh_scope_empty`.
- **Done:** оба P0-репро — тестами; verify зелёный; алгебра и слои задокументированы в server-api.md.

### W2 — promote-линковка в CLI (P0-1) · малая-средняя · ∥ W1
**Файлы:** `.claude/skills/author/driver.mjs`, оба `SKILL.md`, зеркала через `scripts/sync-share-skills.mjs`. (Серверный `runs[]` в candidate-view — в W3, чтобы не пересекаться с W1 по `routes/acceptance.ts`.)
- Флаги `--candidate <id>`, `--acceptance-run <runId>` (повторяемый — задел под W7) → `candidateId`/`acceptanceRunId` в теле.
- Автовыбор без флагов (при `acceptanceMatrix`): по link-store кэша + candidate-view сервера единственный terminal pass ран кандидата, совпадающего с `{baseRev, sourceHash}` validate-receipt; 0 → promote без линка с warning (текущее поведение); ≥2 → `CliError` со списком ранов.
- Локальный pre-flight до POST (rev/sourceHash кандидата vs receipt, run vs candidate); печать выбранной связки до мутации; `--json` и человеческий вывод несут оба id.
- Доки: `.claude/skills/author/SKILL.md:489` («body only») исправить; `share/yp-figma-rebuild-skill/SKILL.md:193,310,326` выровнять с реальными флагами.
- **Done:** `promote --candidate --acceptance-run` даёт версию с обоими id; help/скиллы соответствуют реальности; `driver-cli.test.ts` — флаги в теле, ambiguity → локальная ошибка без POST.

### W3 — promotion policy (P0-2) · средняя
**Файлы:** `server/components/promote.ts`, `server/routes/{components,meta,acceptance}.ts`, `server/acceptance/policies.ts`, `server/repos/components.ts` (version-DTO), `server/contracts.ts`, `docs/server-api.md`.
- `PROMOTION_POLICY_PROFILES = ["default-v1","pixel-strict-v1"]`; `resolveAcceptanceRefs` — убрать hash-равенство, добавить профильный предикат → `acceptance_policy_mismatch`; сузить и переформулировать `acceptance_run_mismatch`.
- Capabilities: `acceptance.promotionPolicyProfiles` (+`policyProfiles`).
- Candidate-view: `runs[{runId,status,policyProfileId,caseSetId,finishedAt,promotionEligible}]` — заодно «promotionEligible заранее» из фидбэка (вариант 4) и источник автовыбора W2.
- `version()` DTO (`repos/components.ts:114`): добавить `candidateId`/`acceptanceRunId` (пробел P0-1-критерия).
- Комментарий v25 + server-api.md: `component_candidates.policy_profile_hash` — информационный.
- **Тесты:** strict-ран промоутится; чужой кандидат → `acceptance_run_mismatch`; несовместимый профиль → `acceptance_policy_mismatch`; capabilities; version-DTO несёт id.
- **Done:** репро `pay-card-button` (strict `acc_7462…`) промоутился бы; коды ошибок разведены.

### W4 — existence-provenance (P1-5) · малая-средняя · после W2
**Шаг 0 — расследование** (атрибуция фидбэка опровергнута кодом): репро с warm `--cache-dir` и свежим draft; кандидаты — 5-мин fresh-кэш catalog-путей в accept-цепочке, identity-mismatch сессии (draft чужого owner'а → легитимный 404), серверная видимость draft с `versions:[]`. Итог зафиксировать; при причинах (b)/(c) фикс корректируется, provenance-поле остаётся.
**Файлы:** `driver.mjs`, `cache.mjs`, оба SKILL.md, зеркала.
- `getMeta` → `{value, provenance: list-cache|direct-cache|direct-network}`; отрицательный не-network результат → ровно один принудительный direct refresh до «not found»; мутационные пути требуют direct-*; `existence{source,refreshed,status}` в `--json`.
- **Done:** свежий draft принимается без `--cache-refresh`; provenance в JSON; тест «настоящий 404 = ровно один refresh».

### W5 — content-hug reference (P1-6) · большая · после W1
**Файлы:** `src/acceptance/caseSetSchema.ts`, `server/acceptance/{caseSets,evidence}.ts`, `server/acceptance/gates/visual.ts`, `scripts/visual-diff-worker.mjs` (+тип опций `diff-runner.ts`), `docs/server-api.md`.
- Схема (аддитивно, старые `cset_` хэшируются идентично): `referenceSurface: "content-hug"|"paint"` (default paint = сегодняшнее), `referencePlacement {x,y}?`, `cropLineage.sourceSurface: "figma-node"|"content-hug"|"paint"`; `expectedGeometry` семантически = layout root (переименовать в доках).
- Валидация: `rect` за пределами размеров ассета → `422 crop_rect_out_of_bounds`; `cropLineage`+`content-hug` без `sourceSurface:"figma-node"` → `422 crop_lineage_conflict`; warning на «expectedGeometry похож на padded-канву».
- `visual.ts`: для content-hug сервер сам паддит эталон до канонической paint-канвы (`expectedGeometry|layoutBounds + 2×margin×dsf`, placement default = margin×dsf); crop применяется максимум один раз по `sourceSurface`; `metrics.referenceNormalization{…}`; worker получает явный `padTo` вместо вывода.
- Evidence: immutable source ref (id+sha) + нормализованный дериват с lineage.
- **Done:** ловушка `pay-card-button` (136×32 vs 264×160 vs двойной crop 116×12) — прошедшими тестами; golden-hash-тест неизменности старых `cset_` id.

### W6 — лимиты, capabilities, dry-run validate (P1-7) · средняя · после W5
**Файлы:** `src/acceptance/caseSetSchema.ts`, `server/routes/{caseSets,meta}.ts`, `driver.mjs`, `server/contracts.ts`, `docs/server-api.md`, оба SKILL.md.
- Лимит values 32→64; тест-инвариант «≥ acceptanceMaxCasesPerRun» (в server-тесте, схема без server-импортов).
- `capabilities.limits`: `caseSetMaxCases/MaxDimensions/MaxDimensionValues/ManifestVersion`; подсказки схемы (обязательность `componentId`, «cropLineage:null запрещён — опускать»).
- `POST /api/components/:id/case-sets/validate` (без записи; отдаёт вычисленный `caseSetId`, cases, coverage, warnings, `wouldBeCached`); CLI `case-set validate`.
- SKILL.md: sparse-семьи = одна каноническая ось.
- **Done:** 49-case семья — один case-set и один ран; все лимиты читаются из capabilities; validate немутирующий (тест).

### W7 — multi-run promote provenance (P1-8) · средняя · после W3, W6
**Файлы:** `server/components/promote.ts`, `server/routes/components.ts`, `server/repos/components.ts`, `server/migrations.ts` (v30), `server/contracts.ts`, `driver.mjs`, `docs/server-api.md`, оба SKILL.md.
- Тело: `acceptanceRunIds[]` (1..8) XOR `acceptanceRunId`; проверки: один кандидат, terminal pass, promotion-профиль, единый policy_profile_id, дизъюнктность case-id (`acceptance_coverage_overlap`), опц. `expectedCases` (`acceptance_coverage_incomplete`).
- **v30**: `component_publishes` +`acceptance_run_ids TEXT` (JSON-массив, без FK — A9); `acceptance_run_id` = первый ран (совместимость).
- DTO версий: `acceptanceRunIds`, `evidenceManifestHashes`; CLI: повторяемый `--acceptance-run` / `--acceptance-runs a,b`.
- **Done:** два дизъюнктных shard-рана промоутятся с union-покрытием; пересечение блокируется; одиночный promote байтово совместим по legacy-полю.

### W8 — summary + reuse-receipts (P1-9, P2-10) · средняя-большая · после W1, W5
**Файлы:** `server/routes/acceptance.ts`, `server/acceptance/{evidence,orchestrator}.ts` (сборка receipts), `driver.mjs`, `server/contracts.ts`, `docs/server-api.md`, оба SKILL.md.
- `GET /acceptance-runs/:runId?view=summary` — форма из фидбэка: `{runId, status, progress{…, frameReused, verdictRecomputed}, gates, refresh, failedCases[{caseId,gate,raw,aa,cause}], remediationGroups, evidenceUrl}`; `view=full` (default) без изменений; `?case=<id>` фильтр на `/cases`.
- Per-case receipt (`acceptance_cases.reuse_receipt_json` из v29, в EvidenceCaseEntry): `{reuse:{candidate,frame,readiness,geometry,visualMetrics,verdict}, fingerprints:{frame,effectivePolicy,case}}`; `reuseReason` остаётся производной сводкой; манифест evidence несёт effective policy случая (критерий P0-3).
- CLI: `accept --summary` / `accept-status --summary` / `accept-status --case <id>`; при fail дефолтный `--json` = summary, полный — `--json-full`.
- **Done:** failed-ран на 25 cases — <100 строк по умолчанию (size-budget-тест); `reused` больше не двусмысленен.

### W9 — верификация, доки, репетиция · после всех
1. `npm run verify`; e2e: расширить `e2e/preview/acceptance-run.spec.ts` (threshold-only recompute; content-hug визуальный pass; promote strict-раном end-to-end).
2. `scripts/sync-share-skills.mjs` + `git diff --exit-code share/`.
3. Runtime-репетиция на локальном сервере — репро фидбэка вербатим: R1 смена порогов+`--refresh failed` ⇒ recapture=0/pass с тройкой refresh; R2 strict-promote; R3 свежий draft с warm-кэшем; R4 49-case одним set/раном; R5 `--summary`.
4. Миграционная репетиция: копия v28-базы → v29/v30 вперёд, старые `cset_` резолвятся, старые publish-строки читаются с `acceptanceRunIds:null`.
5. Чек-лист доков: `docs/server-api.md` (W1/W3/W5/W6/W7/W8), `server/contracts.ts`, оба SKILL.md (+ зеркала), `docs/openapi` если генерится из contracts.

## Верификация (итоговая)
- Гейт каждой волны: `npm run verify` зелёный; коммитит оркестратор после независимой проверки done-критериев.
- Финал: verify + полный e2e + runtime-прогон по `.claude/skills/verify/SKILL.md` + пять репро-сценариев W9.3.
- Деплой — отдельной командой пользователя (по конвенции проекта), с бэкапом перед v29/v30.
