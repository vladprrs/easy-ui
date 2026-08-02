# RFC: Candidate Acceptance Pipeline

Дата: 2026-08-02. Статус: **v3 — после раунда 1 Stage 2 (3 адверсариальных ревьюера: корректность/скоуп-API/риски). 13 blocker-находок сведены в 6 сводных блокеров, все приняты и внесены; триаж — §13. Требуется верификационный раунд 2 до Stage 3.**

История: v1 — draft (Stage 2 отложен до посадки agent-iteration-dx); v2 — синк §10 с посаженным кодом W1–W5 (b4e2428…c7d8803); v3 — триаж раунда 1: исправлена identity кандидата (component-scoped), promote переписан как сага, gate-матрица приведена к честной фазе 1, evidence уведён из asset-store, волны перекроены (R1 = promote без durable-таблиц), advisory получил would-block.

Источники: `docs/EASYUI_PRODUCT_IMPROVEMENTS.md` (§3–5, §9.2, §16–18 — количественный baseline и предложение RFC), `docs/plans/2026-08-02-agent-iteration-dx.md` §6 (перечень отложенных в RFC слоёв), посаженный код P8/P1b/P2 (`server/components/validate.ts`, `server/components/candidates.ts`, `server/screenshot/service.ts`, `src/capture/protocol.ts`).

## 1. Цель и не-цели

**Цель.** Публичная версия компонента появляется один раз — после автоматической проверки непубличного кандидата:

```text
head draft revision
    → validate (есть, P8)
    → candidate (durable, component-scoped)          [R2]
    → acceptance run (серверный вердикт + evidence)  [R2]
    → promote (сага: одна immutable версия, preferred active, auto-supersede)  [R1]
```

Baseline, который лечим (`yandex-pay-v2`): 2,4 публичные версии на принятый компонент, 11 публикаций ради 2 принятых head'ов (ButtonGroup, Timer), все промежуточные версии временно `active`, metadata-only версии ради provenance, 24 самописных verifier-скрипта и ручная evidence-сборка вне продукта.

**Не-цели этого RFC** (отдельные RFC после него; интерфейсы здесь проектируются так, чтобы их принять):

- Visual Diff Contract 2.0 целиком; **в фазе 1 gate `visual` = `not-implemented`** (решение триажа G1: визуальный гейт на непубличной ревизии требует новой fingerprint-модели references — это и есть VDC 2.0, здесь только слот);
- **regression-overlay** (подмена пина прототипа на неопубликованный кандидат): требует расширения `PrototypeBootstrapTarget` вариантом кандидат-пина, объединения allowlist'ов прототипной и draft-джобы и новой семантики `componentManifestHash` — работа масштаба P1b, вынесена в R4+ (решение G2/M9); в фазе 1 gate `regression` = `not-implemented`;
- server-side interaction runner (§7 improvements) — слот gate'а `interactions` со статусом `not-implemented`;
- theme impact graph, `latestCompatible`-пиннинг, verification matrix, Figma Source Package, design-system change sets, flow-level release gate, dependency workbench;
- persistent reuse decisions (§12 improvements);
- schema-defaults parsing на хосте (ABI-миграция; parity-lint уже в P8);
- перенос provenance-истории в bundle-export (это net-new функциональность формата бандла — формат-версия 3, см. §6/§8).

## 2. Допущения о базе (сверено с посаженным кодом, §10 выполнен)

RFC строится поверх плана agent-iteration-dx v6, волны W1–W5. Из них используются напрямую:

| Примитив | Откуда | Роль в RFC |
|---|---|---|
| `POST /api/components/:id/validate` (только head), receipt `ValidateReceipt = {ok: true, cached, sourceHash, bundleHash, hostAbiVersion, themeVersion (= latestMetaVersion DS, null без темы), catalogRevision, warnings: string[]}`; db-зависимые проверки (provenance, asset-refs) — вне кэша, на каждый вызов; `catalogRevision` считается свежо на ответ | P8 (факт), `server/components/validate.ts:182-229` | стадия validate; receipt — вход promote |
| Файловый candidate-кэш `<dataDir>/.candidates/<sourceHash>/{result.json,bundle.js}`, TTL 24 ч, cap 32 MiB, GC on start + on write, **отрицательные записи кэшируются** (`entry.ok=false` с failure), **`componentIds` — множество** (один исходник у нескольких компонентов — факт продукта), без публичного URL-контракта; таблицы в БД нет (решение W2) | P8 (факт), `server/components/candidates.ts` | build-кэш кандидата (durable-слой R2 добавляется поверх, кэш не становится контрактом) |
| Троттлинг validate: `validateUserConcurrent=1`, `validateGlobalConcurrent=2` (**делится с draft-preview**: постановка draft-джобы собирает кандидата тем же `withValidateSlot`), шов `PublishExtraction`/`preExtracted` (publish-кэш `id@rev` не заселяется validate'ом — ключ `validated@<sourceHash>`); **`preExtracted` экономит только `checkSource` — typecheck+compile publish повторяет** (факт, учтено в §4.3) | P8 (факт), `pipeline.ts`, `routes/components.ts:96-109` | promote переиспользует extraction; переиспользование компиляции — работа R1 (§4.3) |
| Draft-preview `POST /api/components/:id/head/screenshot` (+`probe: "geometry"` на обоих вариантах), `ensureDraftCandidate` (auto-rebuild после GC под тем же троттлингом, **только head** — пересборка произвольного rev — работа R1), `bootstrap` несёт `target`, `propsJsonSchema`, `examples` (`protocol.ts:98-118`); geometry-результат дискриминирован `surface: "prototype"|"component"` (`screenshot/service.ts:46-80`) | P1b (факт) | gate'ы `render`/`geometry` acceptance-run'а |
| `track: "head"` — lifecycle-колонка (v22), только служебные kind + непубликован; publish/share/baseline/export → `422 prototype_head_tracking`; enqueue замораживает полные пины + manifestHash в `bootstrap.target`, ответ enqueue — `{jobId, components}`; резолв только компонентных пинов (тема — пин ревизии) | P2 (факт, W3) | будущий regression-overlay (R4+) |
| No-op детекция figma-PUT: byte-identical `source`+`figma` → `200 {unchanged: true, rev}` | P5.1 (факт), `routes/components.ts:251` | предпосылка §6 |
| Readiness-профиль `product|service` (warn служебных доков не поднимает статус, `profile` в отчёте) | P9 (факт) | acceptance-run на галереях не спотыкается о flow-гейты |

Kill-switch-канон (факты): `EASYUI_VALIDATE_DISABLED=1` (гасит validate и draft-preview), `EASYUI_THEME_RESOLVER_V2_DISABLED=1`. Discovery-факты: `capabilities.limits.{validateUserConcurrent, validateGlobalConcurrent, validateCacheTtlHours, validateCacheMiB}`; `capabilities.features.*` — **булевы флаги** (канон соблюдаем: `acceptancePromote`, `acceptanceCandidates`, `acceptanceRuns`, `acceptanceProvenance`; per-DS режим — в DTO дизайн-системы, не в capabilities).

Существующая модель версий, которую RFC **не ломает** (`server/repos/components.ts`): immutable `component_publishes` со статусами `staging|active|deprecated|superseded|rejected|archived|failed`, ручные переходы `TRANSITIONS` с CAS по `status_rev`, `RENDERABLE_STATUS = {active, deprecated, superseded}`, `latest = MAX(version) WHERE status='active'`. Publish — фактически **сага** `stage → import → activate` с компенсацией `fail()` и стартовой уборкой `failStagingPublishes` (bun:sqlite не переживает `await` внутри транзакции — канон зафиксирован в `componentFingerprints.ts:16-17`); §4.3 строится на этом же каноне.

**Известная дыра, чинится в R1 (M5):** `GET /api/components/:id/draft/:sourceHash/bundle.js` сегодня неаутентифицирован — байты драфта доступны любому, знающему sourceHash. R1 добавляет owner-check (capture-принципал проходит по allowlist-механизму, как прочие capture-ресурсы).

## 3. Модель данных

### 3.1. State machine (упрощена триажем S3)

Кандидат — **не** статус версии. Фаза 1 хранит два статуса, остальное вычисляется:

```text
head revision
  ├─ validate failed          (отрицательная запись candidate-кэша, строк в БД нет)
  └─ validated candidate      (component_candidates: status=validated)  [R2]
       └─ promoted            (status=promoted, promoted_version = N)
```

- `stale` — **вычисляемое** свойство (head-ревизия компонента ушла от `rev` кандидата, или `build_fingerprint` больше не совпадает), не хранимый статус.
- `rejected` (человеком) и `expired` (TTL) вводятся в R3 вместе с UI, который их показывает и назначает.
- Версии после promote живут по существующей матрице `TRANSITIONS`; RFC добавляет только автоматический переход `active → superseded` прежних версий внутри финальной транзакции promote (§4.3). Ручные переходы остаются.

### 3.2. Таблица `component_candidates` (R2, миграция)

P8-кэш остаётся эфемерным build-кэшем. Durable-слой — строка БД, создаваемая только явным `POST …/candidates`:

```text
component_candidates(
  candidate_id TEXT PK,        -- "cand_" + sha256({componentId, designSystem, rev, build_fingerprint}) — component-scoped (триаж E1/B1)
  component_id TEXT, design_system TEXT,
  rev INTEGER,                 -- head-ревизия на момент создания; promote требует head_rev == rev (CAS)
  source_hash TEXT, bundle_hash TEXT, host_abi_version INTEGER,
  theme_version INTEGER NULL,
  build_fingerprint TEXT,      -- §5; НЕ уникален (индекс, не constraint)
  observed_catalog_revision TEXT,  -- справочное поле, НЕ входит в идентичность (триаж E2/B2)
  policy_profile_hash TEXT,
  status TEXT,                 -- validated|promoted (R3 добавит rejected|expired)
  status_reason TEXT NULL,
  acceptance_run_id TEXT NULL, promoted_version INTEGER NULL,
  created_by TEXT, created_at TEXT, expires_at TEXT
)
```

Инварианты: строка иммутабельна кроме `status/status_reason/acceptance_run_id/promoted_version`; кандидат не участвует в latest-active resolution, catalog list/search, bundle-export; bundle кандидата — только через draft-роут с owner-check (см. §2). Гигиена: свипер `expires_at` (GC-паттерн `.candidates/`), per-user cap живых кандидатов в `capabilities.limits` (триаж D3).

### 3.3. Таблица `acceptance_runs` (R2, миграция)

```text
acceptance_runs(
  run_id TEXT PK,              -- "acc_" + uuid (валидация формата на чтении)
  candidate_id TEXT FK,
  component_id TEXT,           -- денормализовано: субъект авторизации — владелец компонента (триаж D1)
  idempotency_key TEXT NULL,   -- UNIQUE(candidate_id, idempotency_key)
  status TEXT,                 -- queued|running|pass|pass_with_exceptions|fail|error|cancelled (словарь visual_runs, триаж A5)
  policy_profile_hash TEXT,
  gates_json TEXT,             -- пер-gate результаты §4.2 (известное ограничение: не запрашиваемо по gate — S4; развязка в R3 при необходимости)
  evidence_manifest_hash TEXT NULL,
  started_at TEXT NULL, finished_at TEXT NULL, created_by TEXT, created_at TEXT
)
```

Плюс partial unique index «не более одного нетерминального run'а на кандидата» (триаж E4). **Evidence не хранится в asset-store** (триаж B4-риски: GC ассетов в продукте не существует, `component_publish_assets` FK RESTRICT): каталог `<dataDir>/.acceptance/<runId>/` с `SHA256SUMS`, путь **выводится** из `runId` после regex-валидации (никакой `evidence_dir`-колонки — триаж D4), потолок размера бандла по паттерну `EXPORT_RAW_LIMIT`, GC: `fail|error`-бандлы — по TTL; старые `pass`-бандлы promoted-версий вытесняются по потолку суммарных байт (метаданные run'а остаются) (триаж S5).

### 3.4. Policy profile (упрощено триажем S2)

Фаза 1: **единственный профиль `default-v1` — константа кода** (прецедент `CALIBRATED_POLICY` + `policyVersion` reuse-гейта), `policyProfileHash = sha256(canonicalJson(константы))` — fingerprint-семантика сохраняется полностью. Профиль перечисляет обязательные gate'ы, допуски geometry, `maxJobsPerRun`, `allowExceptions: false`. Таблица `policy_profiles` + CRUD — только при появлении второго реального профиля (не раньше R3).

## 4. API

### 4.1. Candidate (R2)

```http
POST /api/components/:id/candidates        { }         -- validate head + durable-строка
GET  /api/component-candidates/:candidateId            -- глобальное чтение (namespace: не пересекается с /api/catalog/candidates — триаж A3)
```

`POST` выполняет validate head'а (тот же `validateComponentHead`, тот же троттлинг) и материализует строку. Повтор при неизменном `{componentId, rev, build_fingerprint}` возвращает ту же строку (`cached: true`) — идентичность component-scoped, дрейф чужого каталога строк не плодит. Ошибки validate — коды P8. Списочный `GET /api/components/:id/candidates` не вводится (YAGNI, ≤1 живой кандидат при детерминированном id — триаж A7).

### 4.2. Acceptance runs (R2)

```http
POST /api/acceptance-runs                  { candidateId, idempotencyKey? }
GET  /api/acceptance-runs/:runId           -- статус + пер-gate результаты
GET  /api/acceptance-runs/:runId/evidence  -- tar/zip (владелец компонента или админ)
POST /api/acceptance-runs/:runId/cancel    -- только пока queued; running не отменяется (в продукте нет механики отмены джоб — триаж A6)
```

**Оркестрация (переработана триажем B1/B2/B4):** оркестратор run'а живёт **вне** screenshot-помпы — собственный фоновый цикл с инвариантом «≤1 running acceptance-run на процесс». Capture-джобы он ставит в общую очередь **по одной**, дожидаясь каждой (интерактивные джобы перемежаются — глубина вытеснения ≤1 джобы; batch-постановки и самоблокировки нет). Внутренние вызовы validate идут под системным принципалом с **отдельным слотом**, не конкурирующим с интерактивным validate/draft-preview автора (триаж B3-риски). Бюджет: `maxJobsPerRun` из политики, публикуется в `capabilities.limits`; ориентировочный wall-clock честно документируется (минуты на 1-CPU проде).

Gate-интерфейс плагинный; каждый gate возвращает `{gate, status: pass|fail|skipped|not-implemented, metrics?, artifacts?, exceptions?}`:

| Gate | Фаза 1 (R2) | Реализация |
|---|---|---|
| `contract` | ✅ | receipt-поля + definition extraction кандидата (посчитано validate'ом) |
| `defaults` | ✅ | parity-warnings P8, поднятые до gate-результата |
| `render` | ✅ | draft-preview P1b по examples кандидата |
| `geometry` | ✅ | компонентный geometry-probe P1b (отдельная джоба: geometry и image — взаимоисключающие результаты); сравнение с `expected` политики/реквеста — механика `expect` (P4) на сервере |
| `determinism` | ✅ | повторный capture, byte-identical либо ≤ порога политики |
| `audit` | ✅ | существующий catalog audit / usages, предупреждения в evidence |
| `visual` | ⏸ `not-implemented` | требует fingerprint-модели references для непубличных ревизий — RFC «VDC 2.0» (триаж G1) |
| `regression` | ⏸ `not-implemented` | требует candidate-пина в `PrototypeBootstrapTarget` + объединения allowlist'ов + семантики manifestHash — R4+ (триаж G2/M9) |
| `interactions` | ⏸ `not-implemented` | слот под RFC interaction runner |

Вердикт: `pass` — все обязательные gate'ы прошли; `pass_with_exceptions` — только при `allowExceptions` политики (в `default-v1` — выключено; формат exception-записи `gate/owner/reason/expiresAt/reviewIssue` — в evidence, lifecycle — VDC 2.0); `fail` — иначе. Failed run не меняет public state. Идемпотентность: `UNIQUE(candidate_id, idempotency_key)`; `idempotencyKey` существует **только здесь** (дедупликация постановки фоновой джобы), на синхронных ручках канон — CAS по `baseRev` (триаж A1).

**Гонка с promote (триаж C4):** promote при живом `queued|running`-run'е кандидата → `409 acceptance_run_in_flight` (либо явный cancel + аудит).

### 4.3. Promote (R1) — сага, не «одна транзакция» (триаж C1/B3)

```http
POST /api/components/:id/promote
{ baseRev, sourceHash, candidateId?, acceptanceRunId?, expectedCatalogRevision?, supersede?: "auto"|"none", reuseOverride?, message? }
```

`baseRev` обязателен (канон CAS всей кодовой базы — триаж M4/A1); в R1 (до таблицы кандидатов) идентификация — `{baseRev, sourceHash}` из receipt; с R2 — `candidateId` (сервер сверяет его `rev`/`source_hash`). `supersede` — именованный enum вместо флага-отрицания (триаж A8). `reuseOverride` — паритет с publish (admin-обход canonical-role, тот же 409-конверт — триаж A2).

**Фаза A (async, вне транзакций)** — по канону сегодняшнего publish (`stage → import → activate` с компенсацией `fail()`):

1. Предпроверки: `head_rev === baseRev` (иначе `409 revision_conflict {currentRev}` — единый канонический код, `candidate_stale` не вводим); `sha256(source(baseRev)) === sourceHash`; при переданном `acceptanceRunId` — статус `pass|pass_with_exceptions` и совпадение `policy_profile_hash`; `expectedCatalogRevision` — opt-in строгий CAS каталога.
2. **Перепрогон каталого-временных проверок publish-пути** (уточнено триажем M2/M3): `reserveHostPrimitiveName`, `assertPublishRoleAvailable` (`canonical_role_conflict|catalog_changed`, с учётом `reuseOverride`), `assertAtomicPolicy` (`422 atomic_policy_violation`), `collectAndValidateComponentAssetRefs` (`422 asset_not_found`), `409 already_published` для уже опубликованного head-rev. Reuse-гейт (`component_reuse_required`) на publish-пути **не стоит** (он на создании компонента) — promote его не добавляет. Гарантия promote: отсутствие 422 **компиляционного** класса (покрыт receipt'ом); atomic/asset/canonical — перепрогоняются и могут отказать.
3. Сборка артефактов: `stage` расширяется приёмом precompiled-артефактов кандидата (`compiledJs/bundleHash/hostAbiVersion` со сверкой `sourceHash`) — компиляция не повторяется (новая работа R1, триаж M1); `importPublished` (ключ `id@rev`) выполняется всегда — publish-верификация не обходится. При холодном кэше — пересборка **из `component_revisions` по `rev` кандидата** (новая функция: `ensureDraftCandidate` умеет только head — триаж C5/m3) под `withValidateSlot`.

**Фаза B (одна короткая синхронная транзакция)** — триаж C2/M8:

4. `activate` новой версии + auto-supersede: выборка прочих `active` **внутри транзакции**, исключая новую версию по номеру; переходы — **через процедуру `setStatus`-инвариантов** (чтение и инкремент `status_rev`, cycle-check, `supersededBy = N`, `status_reason = "auto: promoted vN"`), не сырым UPDATE; при `supersede: "none"` — пропуск.
5. Ссылки `candidate_id`/`acceptance_run_id` в версию (nullable-колонки `component_publishes`, FK `ON DELETE SET NULL` — триаж A2-риски), кандидат → `promoted` (R2+).
6. Аудит-событие promote с fingerprints.

**Recovery и идемпотентность (триаж A4):** крэш в фазе A компенсируется `fail()`/`failStagingPublishes` (существующий механизм); повтор promote с тем же входом при уже `promoted`-кандидате **проверяет статус `promoted_version`**: если версия renderable — возвращает её; если `failed` (откат посреди саги) — сбрасывает кандидата в `validated` и переигрывает сагу.

**Инвариант пула active (триаж M7):** после auto-supersede компонент имеет ровно одну active-версию; последующий ручной `deprecated` на неё оставит компонент без active — каталог/track-доки деградируют видимо (readiness-ошибка «no active version» добавляется в R1; авто-восстановление `superseded→active` — решение оператора, матрица переходов это разрешает).

## 5. Fingerprint/идентичность (переписано триажем E1/E2)

```text
build_fingerprint = sha256(canonicalJson({
  sourceHash, bundleHash, hostAbiVersion,
  themeVersion,          // = designSystemMetaVersion (факт receipt), null для DS без темы
  policyProfileHash
}))
candidate_id = "cand_" + sha256(canonicalJson({ componentId, designSystem, rev, buildFingerprint }))
```

- **`catalogRevision` исключён из идентичности**: это глобальный хэш всего каталога (меняется на любой чужой publish) — не свойство входа сборки. Он хранится как `observed_catalog_revision` (справка) и проверяется на promote опциональным `expectedCatalogRevision`; каталого-временные проверки promote перепрогоняет сам (§4.3.2). Это же закрывает DoS-вектор бесплатного размножения строк (триаж D3).
- **`componentId`/`designSystem`/`rev` — в идентичности**: один `sourceHash` у нескольких компонентов — факт продукта (`candidates.ts:41`, `componentIds` — множество); без этого детерминированный PK коллидирует между компонентами (wedge + cross-owner disclosure).
- Публикация темы двигает `themeVersion` → кандидаты DS инвалидируются разом; известный эффект (триаж E3), стампида смягчается тем, что acceptance-run'ов ≤1 глобально; `accepted`-кандидаты R3 не инвалидируются автоматически (пометка `stale-theme`).
- Асимметрия воспроизводимости (триаж S7): компонентная съёмка не пинует версию темы (берёт последнюю) — evidence пишет фактический `dsMetaVersion` из результата джобы.
- Канонизация — стабильная сортировка ключей (уже используется для `bundleHash`/`sourceHash`).

## 6. Provenance/evidence отдельно от runtime-версий (R3)

Проблема (improvements §3.5): ButtonGroup v2↔v3, Timer v2↔v3 — одинаковый bundle hash, версии ради правки provenance.

Решение — append-only таблица, резолв при чтении:

```text
component_evidence(component_id, rev, seq, figma_json, author, created_at)
  PK (component_id, rev, seq)
```

- `PUT /api/components/:id/provenance` `{ rev?, figma }` — добавляет `seq`-запись к указанной (по умолчанию head) ревизии; не создаёт ни ревизию, ни версию. Byte-identical `figma` → `unchanged: true` (продолжение P5.1); `figma: null` — явная очистка; отсутствие поля — inherit.
- **Полный перечень read-путей, переходящих на резолвер «последний seq, иначе `figma_json` ревизии»** (триаж M10 — их пять плюс два скрытых): `repo.meta`/`figmaJsonForRev`, `repo.source`, `repo.version` (JOIN), прототипные DTO (`repos/prototypes.ts:327,371-376`), **`validateStoredFigma`** (сейчас читает сырую колонку — обязан валидировать действующий provenance, включая существование `referenceScreenshots`-ассетов), **`repo.restore`** (копирует `figma_json` — должен переносить резолвнутый provenance, иначе история теряется).
- Существующие данные работают без backfill; metadata-only версии в проде остаются как есть.
- **Экспорт/импорт**: сегодня бандл компонентов figma не содержит вовсе (`exporter.ts:105-142`) — «экспорт истории seq» это net-new функциональность формата (закрытый union formatVersion 1|2, старый сервер отвергнет v3) → вынесено в R4+ с отдельным решением по формату (триаж A5-риски/M10).
- Компонентный PUT с `figma` продолжает работать (совместимость); после посадки — драйвер/скилл переводятся на `PUT …/provenance`.

## 7. Совместимость с текущим `publish` и режимы строгости

- `POST /api/components/:id/publish` остаётся: переиспользует extraction кандидата, но **своим набором проверок** (не «validate+stage+activate»: не читает отрицательные записи, не гоняет `validateStoredFigma`, не отдаёт parity-warnings — триаж m2). Контракт ответа не меняется.
- Режим DS: `acceptance: "off" | "advisory"` — **per-DS колонка `design_systems`** (не capabilities: `features.*` — глобальные булевы; режим отдаётся в DTO дизайн-системы — триаж M6). Default `off`.
  - `advisory` (R2): publish работает, но **запускает acceptance-run пост-фактум** и пишет в аудит вердикт, включая `would_block: true|false` — по прецеденту shadow-фазы reuse-гейта (`would_block` в `catalog_reuse_decisions`), иначе фаза ненаблюдаема и нет критерия перехода к строгости (триаж C1).
  - `required` — **вынесен в R4+**: включается отдельным решением по накопленной advisory-статистике; политика exceptions в required — запрещены флагом. При гашении kill-switch'ем acceptance `required` автоматически деградирует до `advisory` — kill-switch не должен делать DS неопубликуемой (триаж D2).
- Расхождение путей publish/promote — временное и наблюдаемое (аудит `publish.legacy` в advisory-DS); условие вывода legacy — решение после метрик advisory (триаж C2-скоуп).
- Две правды о верификации (триаж A4-скоуп): Library-чип `Verified` строится на visual-runs active-версии — компонент с `pass` acceptance-run'ом покажет `Visual pending`; расхождение фиксируется здесь и снимается в R3 (маппинг Library учитывает acceptance-вердикт) либо в VDC 2.0.
- CLI/драйвер: R1 — верб `promote` (баланс триажа D1: волна закрывается только с обновлённым драйвером/скиллом, канон P7); R2 — верб `accept` (candidates + run + poll + evidence). Драйвер проверяет булевы `capabilities.features.acceptance*` и деградирует читаемо.
- Immutable pins опубликованных прототипов не затрагиваются нигде.

## 8. Миграции, откат, ресурсы

- Миграции по волнам: R1 — только 2 nullable-колонки `component_publishes` (`candidate_id`, `acceptance_run_id`, FK `ON DELETE SET NULL`) + колонка `design_systems.acceptance` (R2 может забрать её себе); R2 — `component_candidates`, `acceptance_runs`; R3 — `component_evidence` (+`rejected|expired`). Все — forward-only, аддитивные; `SELECT *` по `component_publishes` в коде нет (проверено ревью) — откат образа безопасен.
- **Обязательство шаблона rebuild** (триаж A2-риски): любой будущий rebuild `component_publishes` (прецедент v14: `RENAME → CREATE → INSERT SELECT` с явным перечнем) обязан включить новые колонки и FK-детей — записать в комментарий миграции по прецеденту `migrations.ts:163`.
- Bundle-export/import не видят новых таблиц (экспортёр читает только `MAX(version)`); provenance-история в бандл не входит до R4+ (§6).
- Env-kill-switch на каждый роут-набор (promote / candidates+runs / provenance); гашение не создаёт аварий (§7: required→advisory).
- Ресурсы 1-CPU: оркестратор acceptance — вне помпы, ≤1 run глобально, джобы по одной (§4.2); evidence — свой каталог с потолком и GC (§3.3); свипер кандидатов + per-user cap (§3.2).
- Discovery: булевы `features.acceptancePromote|acceptanceCandidates|acceptanceRuns|acceptanceProvenance`; `capabilities.limits.{acceptanceMaxJobsPerRun, candidatesPerUser, evidenceMaxBytes}`; режим DS — в DTO дизайн-системы.

## 9. KPI и инструмент измерения (дополнено триажем K1)

Продуктовые (меряем до/после на следующей DS-миграции):

- публичные версии на новый accepted компонент: 2,4 → **≤1,2**;
- first-public-version acceptance: **≥80%** (по advisory-аудиту);
- promote/publish-422 компиляционного класса после validate: **0**;
- ручные status transitions для обычного supersede: **0**;
- клиентские команды на acceptance: 5–8 → **1**;
- accepted-артефакты с полным evidence bundle: **100%**;
- самописные verifier/compare-скрипты для новых компонентов: **−90%**.

**Инструмент — входит в R1** (без него §9 — декларация): `driver.mjs audit --versions` поверх `GET /api/components/:id/versions` (версии/статусы/временные метки на компонент за период) + аудит-события `component.promoted` (с fingerprints), `publish.legacy`, позже `candidate.created`, `acceptance.run.finished` (с вердиктом и длительностями gate'ов). Счётчики в `/api/meta` не добавляем.

## 10. Чек-лист синхронизации перед Stage 2 — выполнен 2026-08-02 (v2)

Все пункты сверены с посаженным кодом W1–W5 (b4e2428…c7d8803), факты внесены в §2: receipt/коды ошибок; файловый кэш (32 MiB); draft-доставка через `bootstrap.{target, propsJsonSchema, examples}`; `bootstrap.target`-семантика и `{jobId, components}`; no-op `{unchanged, rev}`; фактические `capabilities.limits|features`; строчные ссылки; решения W2 как факты.

## 11. Порядок внедрения (волны, перекроены триажем D1/S1)

- **R1 — promote-сага, без durable-таблиц**: `POST /promote {baseRev, sourceHash, …}` (receipt-based), stage с precompiled-артефактами, пересборка по rev, auto-supersede в короткой транзакции + recovery, фикс auth draft-bundle-роута (M5), readiness «no active version», CLI `promote` + обновление скилла, `driver.mjs audit --versions`, аудит-события, features/kill-switch. Ценность сразу: один вызов вместо publish+ручных transitions, churn-метрика измерима.
- **R2 — durable-слой и раны**: `component_candidates` (component-scoped id) + `acceptance_runs` + оркестратор вне помпы + gate'ы фазы 1 (contract/defaults/render/geometry/determinism/audit) + evidence-каталог + `advisory`-режим с would-block + CLI `accept` + `default-v1` константой.
- **R3 — provenance и UI**: `component_evidence` + `PUT …/provenance` (полный перечень read-путей §6) + UI-блок Acceptance + Library-маппинг Verified + статусы `rejected|expired`.
- **R4+** (отдельные RFC/решения): `required`-режим (по advisory-статистике), regression-overlay (candidate-пин в `PrototypeBootstrapTarget`), VDC 2.0 → gate `visual`, interaction runner → gate `interactions`, provenance в bundle-формате v3, theme impact → расширение `regression`, reuse-decision lease.

Каждая волна — свой Stage 2/3, обновлённый драйвер/скилл в done-критериях (канон P7), строка «миграции/kill-switch» в PR.

## 12. Открытые вопросы

1. ~~`theme_version` в fingerprint~~ — закрыт (§5: `themeVersion` = `designSystemMetaVersion`, единственное поле).
2. ~~Гранулярность policy profiles~~ — закрыт триажем S2: `default-v1` — константа кода; per-DS/per-component — при втором профиле.
3. ~~Evidence-хранилище~~ — закрыт триажем B4: собственный каталог `.acceptance/`, asset-store не используется (GC ассетов в продукте нет).
4. ~~`passed-with-exceptions` без VDC 2.0~~ — закрыт: `allowExceptions: false` в `default-v1`; в будущем `required` exceptions запрещены флагом политики.
5. ~~Судьба `staging|failed` в promote~~ — закрыт триажем m5/S6: существующий канон `stage → import → activate` + `failStagingPublishes` как recovery.
6. Разрешать ли acceptance-run на **published** версии (пост-фактум evidence для legacy) — остаётся к R2 (advisory-режим фактически это и делает для новых publish; вопрос — про исторические версии).

## 13. Триаж Stage 2, раунд 1 (2026-08-02)

Ревьюеры: RA — корректность против кода, RB — скоуп/декомпозиция/API, RC — риски/миграции/ресурсы/безопасность. Все blocker-находки приняты; сводка (полные тексты — в отчётах ревьюеров, здесь — решения):

| Сводный блокер | Источники | Решение в v3 |
|---|---|---|
| Identity кандидата коллидирует между компонентами (fingerprint без componentId; `componentIds` в кэше уже множество) | RA-B1, RC-E1 | §5/§3.2: `candidate_id` component-scoped (`componentId, designSystem, rev, buildFingerprint`); fingerprint — неуникальная колонка |
| `catalogRevision` в fingerprint противоречит «дрейф не сносит кандидата»; DoS размножением строк | RA-B2, RC-E2, RC-D3 | §5: `catalogRevision` исключён из идентичности → `observed_catalog_revision`; strict-CAS — `expectedCatalogRevision` на promote; свипер + per-user cap |
| «Атомарно одной транзакцией» невозможно (await в bun:sqlite-транзакции; publish — сага) | RA-B3, RC-C1 | §4.3 переписан: фаза A (async, канон stage→import→activate + fail()) и фаза B (короткая транзакция activate+supersede+refs+аудит); recovery/идемпотентность через статус `promoted_version` (RC-A4) |
| Gate-матрица нечестна: `visual` и `regression` тянут отложенные слои (fingerprint непубличных ревизий; candidate-пин в prototype-bootstrap) | RB-G1, RB-G2, RA-M9 | §1/§4.2: оба — `not-implemented` в фазе 1; regression-overlay — R4+ с перечнем подсистем |
| Очередь: run не влезает в MAX_QUEUE=5, самоблокировка в concurrency-1 помпе, starvation интерактивных джоб | RA-B4, RC-B1, RC-B2 | §4.2: оркестратор вне помпы, ≤1 run глобально, джобы по одной, отдельный validate-слот (RC-B3), бюджет в limits |
| Evidence в asset-store при отсутствующем GC ассетов = рост диска навсегда | RC-B4 | §3.3: собственный каталог `.acceptance/`, потолки, GC; asset-store не трогаем |
| R1 не поставляет ценности (promote без CLI, метрика на скилле из будущей волны) | RB-D1, RB-S1 | §11: R1 = promote + CLI + KPI-инструмент, без durable-таблиц; candidates/runs — R2 |

Majors — приняты и внесены: RA-M1 (честность preExtracted → stage с precompiled, §4.3.3), RA-M2/M3 (точный список publish-проверок, `component_reuse_required` убран, §4.3.2), RA-M4/RB-A1 (обязательный `baseRev`, канонический `revision_conflict`), RA-M5 (фикс auth draft-bundle — R1, §2), RA-M6 (режим — per-DS колонка, не capabilities), RA-M7 (инвариант active-пула + readiness-ошибка), RA-M8 (auto-supersede через setStatus-инварианты), RA-M10 (полный перечень provenance read-путей, экспорт seq → R4+), RB-A2 (`reuseOverride` в promote), RB-A3 (`/api/component-candidates`), RB-C1 (advisory с would-block по прецеденту reuse-shadow), RB-C2 (наблюдаемость legacy-пути, вывод — по метрикам), RB-K1 (KPI-инструмент в R1), RB-A4 (расхождение Library `Verified` зафиксировано, снимается в R3), RC-C2/C3 (supersede в транзакции с исключением по номеру; CAS по rev вместо sourceHash-сверки), RC-C4 (`409 acceptance_run_in_flight`), RC-C5/RA-m3 (пересборка по rev — новая работа R1), RC-D1 (денормализация `component_id` в runs, owner-модель), RC-D2 (kill-switch: required→advisory), RC-A5 (provenance-экспорт = formatVersion-вопрос, R4+), RC-A2 (rebuild-шаблон + FK SET NULL).

Minors — приняты: RB-S3 (state machine упрощена), RB-S2 (default-v1 кодом), RB-A5 (словарь статусов visual_runs), RB-A6 (cancel только queued), RB-A7 (списочный GET убран), RB-A8 (`supersede: enum`), RB-S4 (gates_json — известное ограничение), RB-S5 (вытеснение старых pass-бандлов), RB-D2 (provenance не заперта за required — R3, required — R4+), RB-S6/RA-m5 (§12.5 закрыт), RB-S7/RC-E3 (асимметрия темы в evidence, стампида отмечена), RA-m1 (ссылки разнесены), RA-m2 (§7 переформулирован), RA-m4 (лимиты в capabilities), RA-m6 (булевы features), RC-D4 (evidence-путь выводится), RC-D5 (потолок бандла), RC-E4 (partial unique index), RC-E5 (стухшая заметка §12.1 вычищена).

Отклонено: RB-C2-вариант «publish = тонкая обёртка над promote» — отложено до метрик advisory (менять семантику legacy-пути до данных преждевременно); RC-рекомендация «не начинать R2 до посадки GC ассетов» — снята сменой решения §3.3 (asset-store не используется, свой каталог с GC входит в R2).
