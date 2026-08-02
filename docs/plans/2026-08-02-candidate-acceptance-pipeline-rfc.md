# RFC: Candidate Acceptance Pipeline

Дата: 2026-08-02. Статус: **v2 — синк §10 с фактически посаженным кодом agent-iteration-dx (W1–W5, коммиты b4e2428…c7d8803) выполнен 2026-08-02; готов к Stage 2 (адверсариальному ревью).**

Источники: `docs/EASYUI_PRODUCT_IMPROVEMENTS.md` (§3–5, §9.2, §16–18 — количественный baseline и предложение RFC), `docs/plans/2026-08-02-agent-iteration-dx.md` §6 (перечень отложенных в RFC слоёв), посаженный код P8/P1b/P2 (`server/components/validate.ts`, `server/components/candidates.ts`, `server/screenshot/service.ts`, `src/capture/protocol.ts`).

## 1. Цель и не-цели

**Цель.** Публичная версия компонента появляется один раз — после автоматической проверки непубличного кандидата:

```text
head draft revision
    → validate (есть, P8)
    → candidate (durable, content-addressed)
    → acceptance run (единый серверный вердикт + evidence bundle)
    → promote (атомарно: одна immutable версия, preferred active, auto-supersede)
```

Baseline, который лечим (`yandex-pay-v2`): 2,4 публичные версии на принятый компонент, 11 публикаций ради 2 принятых head'ов (ButtonGroup, Timer), все промежуточные версии временно `active`, metadata-only версии ради provenance, 24 самописных verifier-скрипта и ручная evidence-сборка вне продукта.

**Не-цели этого RFC** (отдельные RFC после него; интерфейсы здесь проектируются так, чтобы их принять):

- Visual Diff Contract 2.0 целиком (exception lifecycle с owner/expiry, content-addressed references, унификация харнесного `compare.mjs` и `server/visual/*`) — здесь только слот gate'а `visual` и формат exception-записи в evidence;
- server-side interaction runner (§7 improvements) — здесь только слот gate'а `interactions` со статусом `not-implemented`;
- theme impact graph, sparse-театр темы сверх P6, `latestCompatible`-пиннинг, verification matrix, Figma Source Package, design-system change sets, flow-level release gate, dependency workbench;
- persistent reuse decisions (§12 improvements) — promote честно перепрогоняет каталого-временные гейты (см. §4.3), lease-модель — follow-up;
- schema-defaults parsing на хосте (ABI-миграция; parity-lint уже в P8).

## 2. Допущения о базе (что уже посажено к моменту реализации RFC)

RFC строится поверх плана agent-iteration-dx v6, волны W1–W5. Из них используются напрямую:

| Примитив | Откуда | Роль в RFC |
|---|---|---|
| `POST /api/components/:id/validate` (только head), receipt `ValidateReceipt = {ok: true, cached, sourceHash, bundleHash, hostAbiVersion, themeVersion (= latestMetaVersion DS, null без темы), catalogRevision, warnings: string[]}`; db-зависимые проверки (provenance, asset-refs) — вне кэша, на каждый вызов; `catalogRevision` считается свежо на ответ | P8 (факт), `server/components/validate.ts:182-229` | стадия validate; receipt — вход promote |
| Файловый candidate-кэш `<dataDir>/.candidates/<sourceHash>/{result.json,bundle.js}`, TTL 24 ч, cap 32 MiB, GC on start + on write, **отрицательные записи кэшируются** (`entry.ok=false` с failure), без публичного URL; таблицы в БД нет (решение W2) | P8 (факт), `server/components/candidates.ts` | build-кэш кандидата (см. §3.2: durable-слой добавляется поверх, кэш не становится контрактом) |
| Троттлинг validate: `validateUserConcurrent=1`, `validateGlobalConcurrent=2` (**делится с draft-preview**: постановка draft-джобы собирает кандидата тем же `withValidateSlot`), шов `PublishExtraction`/`preExtracted` (publish-кэш `id@rev` не заселяется validate'ом — ключ `validated@<sourceHash>`) | P8 (факт), `pipeline.ts`, `validate.ts` | promote переиспользует extract без второй компиляции |
| Draft-preview `POST /api/components/:id/head/screenshot` (+`probe: "geometry"` на обоих вариантах), `ensureDraftCandidate` (auto-rebuild после GC под тем же троттлингом), `bootstrap` несёт `target`, `propsJsonSchema`, `examples`; geometry-результат дискриминирован `surface: "prototype"|"component"` | P1b (факт), `service.ts`, `src/capture/protocol.ts:92-116` | gate'ы `render`/`geometry` acceptance-run'а |
| `track: "head"` — lifecycle-колонка (v22), только служебные kind + непубликован; publish/share/baseline/export → `422 prototype_head_tracking`; enqueue замораживает полные пины + manifestHash в `bootstrap.target`, ответ enqueue — `{jobId, components}`; резолв только компонентных пинов (тема — пин ревизии) | P2 (факт, W3) | transient overlay для gate'а `regression` |
| No-op детекция figma-PUT: byte-identical `source`+`figma` → `200 {unchanged: true, rev}` | P5.1 (факт), `routes/components.ts:251` | предпосылка §6 (provenance-евиденс без ревизий — следующий шаг) |
| Readiness-профиль `product|service` (warn служебных доков не поднимает статус, `profile` в отчёте) | P9 (факт) | acceptance-run на галереях не спотыкается о flow-гейты |

Kill-switch-канон (факты): `EASYUI_VALIDATE_DISABLED=1` (гасит validate и draft-preview, `features.componentValidate|componentDraftPreview=false`), `EASYUI_THEME_RESOLVER_V2_DISABLED=1`. Discovery-факты: `capabilities.limits.{validateUserConcurrent, validateGlobalConcurrent, validateCacheTtlHours, validateCacheMiB}`; `capabilities.features.{componentValidate, componentDraftPreview, componentGeometry, prototypeHeadTracking, readinessProfile, themeDryRun, themeSparseOps, themeSpacingResolverV2}`.

Существующая модель версий, которую RFC **не ломает** (`server/repos/components.ts`): immutable `component_publishes` со статусами `staging|active|deprecated|superseded|rejected|archived|failed`, ручные переходы `TRANSITIONS` с CAS по `status_rev`, `RENDERABLE_STATUS = {active, deprecated, superseded}` (пины продолжают исполняться), `latest = MAX(version) WHERE status='active'`.

## 3. Модель данных

### 3.1. State machine

Кандидат — **не** статус версии. Состояния кандидата живут в новой таблице и не пересекаются с `component_publishes`:

```text
head revision
  ├─ validate failed            (отрицательная запись candidate-кэша)
  └─ validated candidate        (candidates: status=validated)
       ├─ expired               (fingerprint-инвалидация или TTL durable-записи)
       ├─ rejected              (человеком, с reason)
       └─ accepted              (acceptance run passed / passed-with-exceptions)
            └─ promoted         (ссылка на созданную component_publishes-версию)
```

Версии после promote живут по существующей матрице `TRANSITIONS`; RFC добавляет только **автоматический** переход `active → superseded` прежнего head'а внутри транзакции promote (§4.3). Ручные переходы остаются для внештатных случаев.

### 3.2. Таблица `component_candidates` (новая, миграция)

P8-кэш остаётся эфемерным build-кэшем (файлы, без контракта). Durable-слой — строка БД, создаваемая **только** явным `POST …/candidates` (см. §4.1):

```text
component_candidates(
  candidate_id TEXT PK,        -- "cand_" + sha256(inputs_fingerprint), см. §5
  component_id TEXT,
  rev INTEGER,                 -- head-ревизия на момент создания
  source_hash TEXT, bundle_hash TEXT, host_abi_version INTEGER,
  theme_version INTEGER NULL, catalog_revision TEXT,
  policy_profile_id TEXT NULL, policy_profile_hash TEXT NULL,
  inputs_fingerprint TEXT,     -- §5
  status TEXT,                 -- validated|accepted|rejected|expired|promoted
  status_reason TEXT NULL,
  acceptance_run_id TEXT NULL, promoted_version INTEGER NULL,
  created_by TEXT, created_at TEXT, expires_at TEXT
)
```

Инварианты: строка иммутабельна кроме `status/status_reason/acceptance_run_id/promoted_version`; кандидат не участвует в latest-active resolution, catalog list/search, bundle-export; bundle кандидата отдаётся только job-scoped (механизм P1b) и никогда — публичным URL.

### 3.3. Таблица `acceptance_runs` (новая, миграция)

```text
acceptance_runs(
  run_id TEXT PK,              -- "acc_" + uuid
  candidate_id TEXT FK,
  idempotency_key TEXT NULL,   -- UNIQUE(candidate_id, idempotency_key)
  status TEXT,                 -- queued|running|passed|passed-with-exceptions|failed|error|cancelled
  policy_profile_hash TEXT,
  gates_json TEXT,             -- пер-gate результаты, §4.2
  evidence_dir TEXT NULL,      -- <dataDir>/.acceptance/<runId>/
  evidence_manifest_hash TEXT NULL,
  started_at TEXT NULL, finished_at TEXT NULL, created_by TEXT, created_at TEXT
)
```

Evidence-файлы — под `dataDir` (внутри корня проекта, как требует CLAUDE.md), с автоматическим `SHA256SUMS`; тяжёлые PNG складываются в существующий content-addressed asset-store и в бандле лежат ссылками, byte-identical снимки не дублируются.

### 3.4. Policy profiles

`policy_profiles(profile_id, design_system, version, body_json, body_hash, created_by, created_at)` — иммутабельные версии; `body_json` перечисляет обязательные gate'ы, пороги visual, допуски geometry, browsers, `allowExceptions: boolean`. Встроенный дефолт `default-v1` (минимальный состав §4.2) существует без записи в БД. Profile-hash входит в `inputs_fingerprint` — смена политики инвалидирует кандидата, а не тихо меняет вердикт.

## 4. API

### 4.1. Candidate

```http
POST /api/components/:id/candidates        { policyProfile?: string, idempotencyKey?: string }
GET  /api/components/:id/candidates        -- список живых кандидатов компонента
GET  /api/candidates/:candidateId
POST /api/candidates/:candidateId/reject   { reason: string }
```

`POST` выполняет validate head'а (через существующий `validateComponentHead`, тот же троттлинг) и материализует durable-строку. Повтор при неизменном `inputs_fingerprint` возвращает ту же строку (`cached: true`). Ошибки validate — те же стабильные коды, что у P8 (`validation_failed` с `issues[].path`).

### 4.2. Acceptance runs

```http
POST /api/acceptance-runs                  { candidateId, checks?: string[], idempotencyKey?: string }
GET  /api/acceptance-runs/:runId           -- статус + пер-gate результаты
GET  /api/acceptance-runs/:runId/evidence  -- tar/zip бандла (owner/admin)
POST /api/acceptance-runs/:runId/cancel
```

Выполняется фоновой джобой в семействе существующей screenshot-очереди (concurrency 1, cap, 429 `queue_full` — тот же backpressure-канон, что P1a). Gate-интерфейс плагинный; каждый gate возвращает `{gate, status: passed|failed|skipped|not-implemented, metrics?, artifacts?, exceptions?}`:

| Gate | Фаза 1 (этот RFC) | Реализация |
|---|---|---|
| `contract` | ✅ | receipt-поля + definition extraction из кандидата (уже посчитано validate'ом) |
| `defaults` | ✅ | parity-warnings P8, поднятые до gate-результата |
| `render` | ✅ | draft-preview P1b по examples кандидата |
| `geometry` | ✅ | компонентный geometry-probe P1b; сравнение с `expected` из policy/реквеста — механика `expect` (P4) на сервере |
| `visual` | ✅ (минимум) | pixelmatch против переданных/привязанных references через существующий `server/visual/diff-runner.ts`; полный контракт — RFC «VDC 2.0» |
| `determinism` | ✅ | повторный capture, требование byte-identical либо ≤ порога политики |
| `regression` | ✅ (сужено) | пересъёмка impacted-экранов track-доков (P2) с transient overlay кандидата через `bootstrap.target`; impact = доки, чьи пины/track указывают на компонент (`prototype_revision_components`); unknown deps → full scope политики |
| `interactions` | ⏸ `not-implemented` | слот под RFC interaction runner |
| `audit` | ✅ | существующий catalog audit / usages, предупреждения в evidence |

Вердикт: `passed` — все обязательные gate'ы прошли; `passed-with-exceptions` — есть failed gate'ы, покрытые exception-записями и `allowExceptions` политики; `failed` — иначе. Exception-запись (формат §5.3 improvements: `gate/owner/reason/expiresAt/reviewIssue`) сохраняется в evidence и видна в audit; lifecycle exceptions — RFC «VDC 2.0».

Идемпотентность: `UNIQUE(candidate_id, idempotency_key)` — повтор возвращает существующий run. Failed run не меняет никакого public state.

### 4.3. Promote

```http
POST /api/components/:id/promote
{ candidateId, acceptanceRunId?, expectedCatalogRevision?, parallelSupport?: false, message?, idempotencyKey? }
```

Атомарно, одной транзакцией:

1. Проверяет: кандидат жив и принадлежит `:id`; head-ревизия компонента всё ещё даёт `source_hash` кандидата (иначе 409 `candidate_stale`); при `acceptance.required` (см. §7) — run в статусе `passed|passed-with-exceptions` и его `policy_profile_hash` совпадает с кандидатским.
2. **Перепрогоняет каталого-временные гейты**, которые receipt не покрывает и покрывать не может: canonical-role, reuse-гейт, duplicate/atomic-политики — те же вызовы, что у сегодняшнего publish. `409 component_reuse_required|canonical_role_conflict|catalog_changed` остаются терминальными STOP по канону `docs/agent-authoring-policy.md`. Честность контракта: promote гарантирует отсутствие 422 **компиляционного** класса (покрыт receipt'ом), но не каталого-временных 409.
3. Создаёт одну immutable версию существующим путём `stage → activate` (артефакты — из candidate-кэша через `preExtracted`-шов, без второй компиляции; при вычищенном GC кэше — пересборка по `sourceHash` под троттлингом, как preview P1b).
4. Auto-supersede: все прочие `active`-версии компонента → `superseded` с `supersededBy = новая версия`, `status_reason = "auto: promoted vN"`, если не запрошен `parallelSupport: true`. Пины опубликованных прототипов не меняются (`RENDERABLE_STATUS` включает `superseded` — исполняемость сохранена).
5. Пишет в версию ссылки `candidate_id`/`acceptance_run_id` (новые nullable-колонки `component_publishes`), помечает кандидата `promoted`.
6. Аудит-событие promote с fingerprints.

Идемпотентность: повтор с тем же `idempotencyKey` и уже `promoted`-кандидатом возвращает созданную версию, а не 409.

## 5. Fingerprint/idempotency-модель

```text
inputs_fingerprint = sha256(canonicalJson({
  sourceHash, bundleHash, hostAbiVersion,
  themeVersion,          // = designSystemMetaVersion (факт receipt), null для DS без темы
  catalogRevision,
  policyProfileHash
}))
```

- Receipt/кандидат недействительны, когда любой вход изменился; `catalog_revision` — самый волатильный вход, поэтому его дрейф **не** сносит кандидата автоматически: promote перепроверяет каталого-временные гейты сам (§4.3.2), а `expectedCatalogRevision` в реквесте даёт вызывающему opt-in строгий CAS.
- Все content-хэши — sha256, канонизация JSON — стабильная сортировка ключей (уже используется для `bundleHash`/`sourceHash`).
- `candidate_id` детерминирован от `inputs_fingerprint` → повторное создание кандидата на неизменном входе бесплатно и не плодит строк.
- Evidence-бандл содержит `inputs_fingerprint`, resolved-пины и команду воспроизведения (`easyui accept … --candidate cand_…`).

## 6. Provenance/evidence отдельно от runtime-версий

Проблема (improvements §3.5, план §6): ButtonGroup v2↔v3 и Timer v2↔v3 — одинаковый bundle hash, версии ради правки provenance/references.

Решение — append-only evidence-таблица, резолв при чтении:

```text
component_evidence(component_id, rev, seq, figma_json, author, created_at)
  PK (component_id, rev, seq)
```

- `PUT /api/components/:id/provenance` `{ rev?, figma }` — добавляет `seq`-запись к указанной (по умолчанию head) ревизии; **не** создаёт ни ревизию, ни версию.
- Read-путь DTO ревизии/версии резолвит provenance как «последний `seq`, иначе `figma_json` самой ревизии» — существующие данные работают без backfill.
- Семантика наследования (improvements §9.2): поле отсутствует — inherit; `figma: null` — явная очистка; byte-identical `figma` → `unchanged: true` (продолжение no-op-детекции P5.1).
- Экспорт бандла включает историю `seq`; импорт создаёт записи с новыми `seq`, не переписывая существующие.
- Существующие metadata-only версии в проде остаются как есть — миграции данных нет (решение триажа плана v6).
- PUT `figma` на head-ревизию через существующий компонентный PUT продолжает работать (совместимость), но после посадки evidence-таблицы драйвер/скилл переводятся на `PUT …/provenance`.

## 7. Совместимость с текущим `publish` и режимы строгости

- `POST /api/components/:id/publish` остаётся как **legacy shortcut**: семантически = «validate (по кэшу) → stage → activate» без durable-кандидата и acceptance. Контракт ответа не меняется.
- Новая настройка design system: `acceptance: "off" | "advisory" | "required"` (default `off`; хранится рядом с reuse-гейтом, отдаётся в `GET /api/capabilities`).
  - `off` — сегодняшнее поведение;
  - `advisory` — publish работает, но пишет в аудит «published without acceptance», UI показывает бейдж;
  - `required` — publish отвечает `422 acceptance_required`; единственный путь — candidates → acceptance-run → promote.
- Auto-supersede в promote не ретроактивен: существующие «все версии active» хвосты чистятся отдельной разовой admin-операцией (вне RFC, при желании — существующими ручными переходами).
- CLI/драйвер: верб `accept` (`driver.mjs accept <componentId> [--policy …] [--out dir]`) = candidates + acceptance-run + poll + скачивание evidence; верб `promote`. Скилл-цикл после посадки: `preview --rev head-draft` → `accept` → `promote` — публикация одна. Драйвер проверяет `capabilities.features.acceptance` и деградирует на старом сервере читаемо (канон P7).
- Immutable pins опубликованных прототипов не затрагиваются нигде.

## 8. Миграции и откат

- Новые таблицы: `component_candidates`, `acceptance_runs`, `policy_profiles`, `component_evidence`; новые nullable-колонки `component_publishes.candidate_id/acceptance_run_id`. Все — forward-only, аддитивные: откат образа безопасен (старый код колонок/таблиц не читает).
- Данных не мигрируем: существующие версии/статусы/пины неизменны.
- Env-kill-switch на каждый новый роут-набор (candidates/acceptance/promote/provenance) — канон W2/W4.
- Discovery: `GET /api/capabilities` → `features.acceptance = { candidates, runs, promote, provenance, mode }`, лимиты — в `capabilities.limits`.
- Ресурсы 1-CPU прода: acceptance-run — та же очередь и concurrency, что скриншоты; gate'ы шарят троттлинг validate; evidence-объём под потолком байт с GC протухших `failed`-бандлов (TTL политики; `passed`-бандлы promoted-версий не GC-ятся).

## 9. KPI и телеметрия

Продуктовые (improvements §3.6/§4.7, меряем по аудиту и `driver.mjs audit --design-system` до/после на следующей DS-миграции):

- публичные версии на новый accepted компонент: 2,4 → **≤1,2**;
- first-public-version acceptance: **≥80%**;
- active-версии без успешного acceptance (в `required`-DS): **0**;
- publish/promote-422 компиляционного класса после validate: **0**;
- ручные status transitions для обычного supersede: **0**;
- клиентские команды на acceptance: 5–8 → **1**;
- accepted-артефакты с полным evidence bundle: **100%**;
- самописные verifier/compare-скрипты для новых компонентов: **−90%**.

Телеметрия: аудит-события `candidate.created|expired|rejected`, `acceptance.run.finished` (с вердиктом и длительностями gate'ов), `component.promoted` (с fingerprints), `publish.legacy` (для advisory-режима); счётчики в `GET /api/meta` не добавляем — аудит-лог достаточен.

## 10. Чек-лист синхронизации перед Stage 2 — **выполнен 2026-08-02** (v2)

Все пункты сверены с посаженным кодом W1–W5 (b4e2428…c7d8803), факты внесены в §2:

1. ✅ Receipt: `ValidateReceipt` — форма в §2; коды ошибок validate = коды publish-префлайта (`validation_failed` с `issues[].path` и пр.), отрицательные результаты тоже кэшируются.
2. ✅ Кэш остался **файловым**, без таблицы (W2, cap 32 MiB) — §3.2 строится как durable-слой поверх файлов.
3. ✅ Draft-доставка: `ensureDraftCandidate` + job-scoped bundle, `bootstrap.{target, propsJsonSchema, examples}` — §4.2.
4. ✅ `bootstrap.target`: enqueue замораживает полные пины + manifestHash; ответ enqueue `{jobId, components}`; тема остаётся пином ревизии (учтено в scope gate'а `regression`).
5. ✅ No-op PUT: `200 {unchanged: true, rev}`.
6. ✅ `capabilities.limits|features` — фактические имена в §2.
7. ✅ Строчные ссылки обновлены на состояние после c7d8803.
8. ✅ Решения W2 перенесены как факты (файловый кэш; draft-ручка `POST …/head/screenshot`; `probe: "geometry"` вместо отдельной geometry-ручки).

## 11. Порядок внедрения (после W1–W5, отдельными волнами со своим Stage 2/3)

- **R1**: `component_candidates` + promote + auto-supersede + `acceptance` mode (`off|advisory`) + capabilities/kill-switch. Ценность сразу: publish-churn убит даже без acceptance-run'ов (validate → promote).
- **R2**: `acceptance_runs` с gate'ами фазы 1 + evidence bundle + `GET …/evidence` + CLI `accept`/`promote` + policy profiles (`default-v1` + CRUD).
- **R3**: `component_evidence` (provenance) + `required`-режим + UI-блок Acceptance на странице компонента.
- **R4+** (отдельные RFC): interaction runner → gate `interactions`; VDC 2.0 → полный gate `visual` + exception lifecycle; theme impact → расширение `regression`; reuse-decision lease → снятие оговорки §4.3.2.

## 12. Открытые вопросы (к Stage 2)

1. ~~Нужен ли `theme_version` в `inputs_fingerprint`~~ — **закрыт синком §10**: в посаженном receipt `themeVersion` и есть `designSystemMetaVersion` (`latestMetaVersion`, null для DS без темы) — отдельного поля нет; fingerprint (§5) включает его один раз, дубль `designSystemMetaVersion` из §5 убрать при имплементации.
2. Гранулярность policy profiles: per-DS или per-component override (`policyProfile` в definition meta)?
3. Evidence-хранилище: собственный каталог `.acceptance/` vs полная укладка в asset-store (сейчас — гибрид: PNG в asset-store, JSON/манифест в каталоге).
4. `passed-with-exceptions` без VDC 2.0: достаточно ли plain-записей exceptions в evidence, или required-режим должен запрещать exceptions до посадки lifecycle (склоняюсь: в `required` — запрещать, флагом политики).
5. Судьба `staging|failed` статусов в promote-пути: переиспользуем как сейчас (транзакция короткая) или promote пишет `active` сразу без staging-фазы.
6. Разрешать ли acceptance-run на **published** версии (пост-фактум evidence для legacy-версий) — полезно для миграции прод-каталога в `required`-режим.
