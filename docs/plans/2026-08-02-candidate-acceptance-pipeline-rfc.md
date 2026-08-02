# RFC: Candidate Acceptance Pipeline

Дата: 2026-08-02. Статус: **v4 — после раунда 2 Stage 2 (верификационное ре-ревью: закрытие раунда 1 подтверждено, 3 новых R1-блокера V1–V3 и майноры V4–V15 внесены; триаж — §13-Р2). Blocking-возражений против Stage 3 (R1) после v4 нет — R1 готов к старту (дельта-верификация решений V1–V3 включена в done-критерии R1).**

История: v1 — draft (Stage 2 отложен до посадки agent-iteration-dx); v2 — синк §10 с посаженным кодом W1–W5 (b4e2428…c7d8803); v3 — триаж раунда 1: исправлена identity кандидата (component-scoped), promote переписан как сага, gate-матрица приведена к честной фазе 1, evidence уведён из asset-store, волны перекроены (R1 = promote без durable-таблиц), advisory получил would-block; v4 — триаж раунда 2: recovery через расширенный `already_published`-чек, `pinAssets`/`recordValidation`/`host_abi_version` в фазе B, **R1 вообще без миграций** (колонки и FK — R2), advisory материализует кандидата published-ревизии и снимает published-поверхностью, `policyProfileHash` вне build_fingerprint.

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

**Известная дыра, чинится в R1 (M5, форма уточнена V11):** `GET /api/components/:id/draft/:sourceHash/bundle.js` сегодня неаутентифицирован — байты драфта доступны любому, знающему sourceHash. R1 добавляет проверку так: `principal.kind === "capture"` пропускается по allowlist (прецедент прототипного драфт-роута), owner-check — только для user/anon-принципалов; прямое навешивание `requireResourceOwner` сломало бы съёмку (capture-воркер — не user).

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

Инварианты: строка иммутабельна кроме `status/status_reason/acceptance_run_id/promoted_version`; кандидат не участвует в latest-active resolution, catalog list/search, bundle-export; bundle кандидата — только через draft-роут с owner-check (см. §2). Гигиена: свипер `expires_at` (GC-паттерн `.candidates/`), **строки `status='promoted'` свипер не удаляет** (иначе `ON DELETE SET NULL` молча обнулит provenance-ссылку версии — триаж V14), per-user cap живых кандидатов в `capabilities.limits` (триаж D3).

### 3.3. Таблица `acceptance_runs` (R2, миграция)

```text
acceptance_runs(
  run_id TEXT PK,              -- "acc_" + uuid (валидация формата на чтении)
  candidate_id TEXT FK,
  component_id TEXT,           -- денормализовано: субъект авторизации — владелец компонента (триаж D1)
  idempotency_key TEXT NULL,   -- UNIQUE(candidate_id, idempotency_key)
  status TEXT,                 -- queued|running|pass|pass_with_exceptions|fail|error|cancelled (пересечение с visual_runs — pass|fail|error, остальное новое; триажи A5/V13)
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

**Оркестрация (переработана триажем B1/B2/B4, дополнена V7/V8):** оркестратор run'а живёт **вне** screenshot-помпы — собственный фоновый цикл с инвариантом «≤1 running acceptance-run на процесс». Capture-джобы он ставит в общую очередь **по одной**, дожидаясь каждой (интерактивные джобы перемежаются — глубина вытеснения ≤1 джобы), с backoff-ретраем на `429 queue_full` (потолок ретраев — в политике; триаж V7). Внутренние вызовы validate идут под системным принципалом через **пул слотов** (интерактивный cap + отдельный системный слот — правка `withValidateSlot`, работа R2; триажи B3/V7). **Recovery при рестарте** (триаж V8): стартовая уборка по прецеденту `failStagingPublishes` — все `queued|running`-раны → `error` (оркестратор in-memory, строка иначе зависает навсегда и partial-index блокирует новые раны). Бюджет: `maxJobsPerRun` из политики, публикуется в `capabilities.limits`; ориентировочный wall-clock честно документируется (минуты на 1-CPU проде).

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

1. Предпроверки: `head_rev === baseRev` (иначе `409 revision_conflict {currentRev}` — единый канонический код, `candidate_stale` не вводим); `sha256(source(baseRev)) === sourceHash`; при переданном `acceptanceRunId` — статус `pass|pass_with_exceptions` и совпадение `policy_profile_hash` (R2); `expectedCatalogRevision` — opt-in строгий CAS каталога.
2. **Перепрогон каталого-временных проверок publish-пути** (уточнено триажем M2/M3): `reserveHostPrimitiveName`, `assertPublishRoleAvailable` (`canonical_role_conflict|catalog_changed`, с учётом `reuseOverride`), `assertAtomicPolicy` (`422 atomic_policy_violation`), `collectAndValidateComponentAssetRefs` (`422 asset_not_found`), `409 already_published` для уже опубликованного head-rev — **проверка расширяется до «есть строка вне статуса `failed`»** (триаж V1). *Уточнение по факту реализации R1:* схема имеет `UNIQUE (component_id, rev)` (миграция v8), а R1 — без миграций, поэтому re-stage **перезаписывает `failed`-строку in-place с сохранением номера версии** (дырок в нумерации не возникает; `failed`-версию ничто не отдаёт и на неё нет FK-детей — пины ссылаются только на active); вариант «новый номер» из v4 нереализуем без миграции. Reuse-гейт (`component_reuse_required`) на publish-пути **не стоит** — promote его не добавляет. Гарантия promote: отсутствие 422 **компиляционного** класса; atomic/asset/canonical — перепрогоняются и могут отказать.
3. Сборка артефактов: **promote — вариант `publishComponent` без `typecheck+compile`** (уточнение V10/раунд 2: `repo.stage` уже принимает готовые артефакты — компилирует именно `publishComponent`): артефакты кандидата (`compiledJs/bundleHash/hostAbiVersion` со сверкой `sourceHash`) идут в `stage` напрямую; `importPublished` (ключ `id@rev`) выполняется всегда. При холодном кэше — пересборка head'а существующим `ensureDraftCandidate` под `withValidateSlot` (отдельная «пересборка по произвольному rev» не нужна: promote и так требует `head_rev === baseRev` — триаж V10).

**Фаза B (одна короткая синхронная транзакция)** — триаж C2/M8, дополнено V2:

4. `activate` новой версии (с фактическим `host_abi_version` кандидата — `stage` сегодня хардкодит `1`) + **`pinAssets(id, version, assetIds)`** (иначе версия остаётся без пинов ассетов: пустой DTO, сломанный export, потеря RESTRICT-защиты — триаж V2) + `recordValidation` + auto-supersede: выборка прочих `active` **внутри транзакции**, исключая новую версию по номеру; переходы — **через процедуру `setStatus`-инвариантов** (чтение и инкремент `status_rev`, cycle-check, `supersededBy = N`, `status_reason = "auto: promoted vN"`), не сырым UPDATE; при `supersede: "none"` — пропуск.
5. *(шаг R2)* Ссылки `candidate_id`/`acceptance_run_id` в версию (nullable-колонки `component_publishes` — миграция R2, FK там же; триаж V3: в R1 ни колонок, ни FK — иначе FK указывал бы на несуществующие таблицы), кандидат → `promoted`.
6. Аудит-событие promote с fingerprints.

**Recovery и идемпотентность (триажи A4, V1):** крэш в фазе A компенсируется `fail()`/`failStagingPublishes` (существующий механизм); повторный promote с тем же `{baseRev, sourceHash}` после этого **проходит** благодаря расширенному `already_published`-чеку (п. 2) и создаёт версию с новым номером. В R2+ повтор при `promoted`-кандидате дополнительно проверяет статус `promoted_version`: renderable — вернуть её; `failed` — кандидат в `validated` и повторная сага (что и есть повторный promote).

**Инвариант пула active (триаж M7):** после auto-supersede компонент имеет ровно одну active-версию; последующий ручной `deprecated` на неё оставит компонент без active — каталог/track-доки деградируют видимо (readiness-ошибка «no active version» добавляется в R1; авто-восстановление `superseded→active` — решение оператора, матрица переходов это разрешает).

## 5. Fingerprint/идентичность (переписано триажем E1/E2)

```text
build_fingerprint = sha256(canonicalJson({
  sourceHash, bundleHash, hostAbiVersion,
  themeVersion           // = designSystemMetaVersion (факт receipt), null для DS без темы
}))
candidate_id = "cand_" + sha256(canonicalJson({ componentId, designSystem, rev, buildFingerprint }))
```

`policyProfileHash` — **вне** build_fingerprint (триаж V12: политика — вход вердикта, не сборки; тот же аргумент, что исключил `catalogRevision`); он хранится на run'е (`acceptance_runs.policy_profile_hash`) и сверяется на promote при переданном `acceptanceRunId`.

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
- Режим DS: `acceptance: "off" | "advisory"` — **per-DS колонка `design_systems`, миграция R2** (единственный читатель — advisory, триаж V15; не capabilities: `features.*` — глобальные булевы; режим отдаётся в DTO дизайн-системы — триаж M6). Default `off`.
  - `advisory` (R2): publish работает, но **запускает acceptance-run пост-фактум**. Механика (триажи V4/V5): publish в advisory-DS материализует кандидата **по ревизии опубликованной версии** (внутренний путь: `getOrComputeCandidate` уже принимает `rev`), run привязывается к нему обычным FK; gate'ы `render`/`geometry`/`determinism` снимают **published-поверхностью** по `version` (существующий `enqueueComponent(id, version)`, examples из version-DTO) — не draft-preview, поэтому параллельный `PUT` автора не подменяет предмет вердикта. Вердикт и `would_block: true|false` — в аудит, по прецеденту shadow-фазы reuse-гейта (триаж C1).
  - `required` — **вынесен в R4+**: включается отдельным решением по накопленной advisory-статистике; политика exceptions в required — запрещены флагом. При гашении kill-switch'ем acceptance `required` автоматически деградирует до `advisory` — kill-switch не должен делать DS неопубликуемой (триаж D2).
- Расхождение путей publish/promote — временное и наблюдаемое (аудит `publish.legacy` в advisory-DS); условие вывода legacy — решение после метрик advisory (триаж C2-скоуп). **Третий путь публикации — bundle-import** (`importer.ts` зовёт `publishComponent`): не проходит ни promote, ни advisory; помечается в аудите (`publish.import`) и исключается из KPI-знаменателя §9 (триаж V9).
- Две правды о верификации (триаж A4-скоуп): Library-чип `Verified` строится на visual-runs active-версии — компонент с `pass` acceptance-run'ом покажет `Visual pending`; расхождение фиксируется здесь и снимается в R3 (маппинг Library учитывает acceptance-вердикт) либо в VDC 2.0.
- CLI/драйвер: R1 — верб `promote` (баланс триажа D1: волна закрывается только с обновлённым драйвером/скиллом, канон P7); R2 — верб `accept` (candidates + run + poll + evidence). Драйвер проверяет булевы `capabilities.features.acceptance*` и деградирует читаемо.
- Immutable pins опубликованных прототипов не затрагиваются нигде.

## 8. Миграции, откат, ресурсы

- Миграции по волнам (пересобрано триажами V3/V15): **R1 — миграций нет вообще** (promote receipt-based, ссылок на кандидата не пишет); R2 — `component_candidates`, `acceptance_runs`, nullable-колонки `component_publishes.candidate_id/acceptance_run_id` (FK `ON DELETE SET NULL` — появляются вместе с таблицами, на которые указывают), колонка `design_systems.acceptance`; R3 — `component_evidence` (+`rejected|expired`). Все — forward-only, аддитивные; `SELECT *` по `component_publishes` в коде нет (проверено ревью) — откат образа безопасен.
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

- **R1 — promote-сага, без durable-таблиц и без миграций**: `POST /promote {baseRev, sourceHash, …}` (receipt-based), promote-вариант `publishComponent` без typecheck+compile (артефакты кандидата в `stage`, фактический `host_abi_version`), расширенный `already_published`-чек (recovery, V1), фаза B с `pinAssets`+`recordValidation`+auto-supersede в короткой транзакции, фикс auth draft-bundle-роута (M5/V11), readiness «no active version», CLI `promote` + обновление скилла, `driver.mjs audit --versions`, аудит-события (`component.promoted`, `publish.import` — V9). Features: только `acceptancePromote` (V15) + kill-switch. Ценность сразу: один вызов вместо publish+ручных transitions, churn-метрика измерима.
- **R2 — durable-слой и раны**: `component_candidates` (component-scoped id) + `acceptance_runs` (+колонки-ссылки в `component_publishes`, +`design_systems.acceptance`) + оркестратор вне помпы (пул validate-слотов, backoff на 429, стартовая уборка ранов — V7/V8) + gate'ы фазы 1 (contract/defaults/render/geometry/determinism/audit; для advisory — published-вариант render/geometry/determinism, V5) + evidence-каталог + `advisory`-режим с would-block и материализацией кандидата published-ревизии (V4) + CLI `accept` + `default-v1` константой.
- **R3 — provenance и UI**: `component_evidence` + `PUT …/provenance` (полный перечень read-путей §6) + UI-блок Acceptance + Library-маппинг Verified + статусы `rejected|expired`.
- **R4+** (отдельные RFC/решения): `required`-режим (по advisory-статистике), regression-overlay (candidate-пин в `PrototypeBootstrapTarget`), VDC 2.0 → gate `visual`, interaction runner → gate `interactions`, provenance в bundle-формате v3, theme impact → расширение `regression`, reuse-decision lease.

Каждая волна — свой Stage 2/3, обновлённый драйвер/скилл в done-критериях (канон P7), строка «миграции/kill-switch» в PR.

## 12. Открытые вопросы

1. ~~`theme_version` в fingerprint~~ — закрыт (§5: `themeVersion` = `designSystemMetaVersion`, единственное поле).
2. ~~Гранулярность policy profiles~~ — закрыт триажем S2: `default-v1` — константа кода; per-DS/per-component — при втором профиле.
3. ~~Evidence-хранилище~~ — закрыт триажем B4: собственный каталог `.acceptance/`, asset-store не используется (GC ассетов в продукте нет).
4. ~~`passed-with-exceptions` без VDC 2.0~~ — закрыт: `allowExceptions: false` в `default-v1`; в будущем `required` exceptions запрещены флагом политики.
5. ~~Судьба `staging|failed` в promote~~ — закрыт триажем m5/S6: существующий канон `stage → import → activate` + `failStagingPublishes` как recovery.
6. Run по published-версии для **новых** publish — решён в R2 (§7: advisory материализует кандидата published-ревизии и снимает published-поверхностью — триажи V4/V5/V6). Открытым остаётся только **бэкфилл исторических** версий (пост-фактум evidence для legacy-каталога) — к R3.

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

### Раунд 2 — верификационное ре-ревью (V), триаж в v4

Закрытие всех блокеров раунда 1 подтверждено ревьюером (identity, catalogRevision, сага, gate-матрица, очередь, evidence, R1-ценность; точечные ссылки §2 верифицированы). Новые находки:

| Находка | Вердикт | Как отражено |
|---|---|---|
| V1 (blocker): recovery неисполним — `stage` отказывает `already_published` по факту строки любого статуса; после `failStagingPublishes` rev заблокирован навсегда | ✅ | §4.3.2: чек расширен до «строка вне статуса `failed`»; по факту R1 re-stage перезаписывает `failed`-строку in-place (UNIQUE(component_id, rev) + R1 без миграций), номер версии сохраняется; recovery-тест в R1 |
| V2 (blocker): фаза B теряла `pinAssets` (единственный источник `component_publish_assets`), `recordValidation` и фактический `host_abi_version` | ✅ | §4.3.4: все три — явные шаги фазы B |
| V3 (blocker): R1-колонки с FK на таблицы R2 (foreign_keys=ON → «no such table») | ✅ | §8/§11: **R1 без миграций вообще**; колонки+FK — R2; §4.3.5 помечен «шаг R2» |
| V4 (major): advisory-run без кандидата при обязательном FK | ✅ | §7: advisory материализует кандидата по ревизии опубликованной версии (`getOrComputeCandidate` принимает rev) |
| V5 (major): гейты фазы 1 определены только для draft-поверхности; advisory-вердикт мог оказаться о драфте | ✅ | §7/§11 R2: advisory снимает published-поверхностью (`enqueueComponent(id, version)`, examples из version-DTO) |
| V6 (major): §12.6 нечестно «открыт» | ✅ | §12.6 переформулирован: открыт только бэкфилл исторических версий |
| V7 (major): «отдельный validate-слот» — изменение кода, не записанное в объём; нет ретрая 429 | ✅ | §4.2/§11 R2: пул слотов + backoff-ретрай с потолком в политике |
| V8 (major): нет recovery ранов при рестарте — вечный `running` + блокировка partial-index | ✅ | §4.2: стартовая уборка `queued\|running → error` по прецеденту `failStagingPublishes` |
| V9 (major): bundle-import — неучтённый третий путь публикации, искажает KPI | ✅ | §7/§9: аудит `publish.import`, исключение из KPI-знаменателя |
| V10 (major): «пересборка по rev» — работа без сценария (promote требует head) | ✅ | §4.3.3: `ensureDraftCandidate` (head) достаточно; пункт снят из R1; формулировка «promote — вариант `publishComponent` без typecheck+compile» |
| V11 (major): лобовой owner-check сломал бы draft-preview (capture-принципал — не user) | ✅ | §2: точная форма фикса — capture по allowlist, owner-check для user/anon |
| V12 (minor): `policyProfileHash` в build_fingerprint противоречит собственному аргументу §5 | ✅ | §5: вынесен на run |
| V13 (minor): «словарь visual_runs» фактически неверен (CHECK: pass/fail/error/reference_missing) | ✅ | §3.3: «пересечение — pass\|fail\|error, остальное новое» |
| V14 (minor): TTL-свипер + `ON DELETE SET NULL` молча обнуляет provenance promoted-версии | ✅ | §3.2: свипер не трогает `promoted` |
| V15 (minor): волновые рассинхроны §8↔§11 (колонка acceptance, features-флаги, кандидат в R1-recovery) | ✅ | §8/§11 сведены: acceptance-колонка — R2, R1 — только `acceptancePromote`, recovery R1 — без кандидата |

Вердикт ревьюера раунда 2: V1–V3 — внутри объёма R1, точечные; «после их внесения R1 можно стартовать без нового полного раунда — достаточно дельта-верификации». Дельта-верификация решений V1–V3 включена в done-критерии R1 (§11).
