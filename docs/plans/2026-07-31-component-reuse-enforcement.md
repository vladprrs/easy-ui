# План: Component Reuse Enforcement and Agent Discovery (проект 2)

Дата: 2026-07-31
Спека: `docs/superpowers/specs/2026-07-30-component-reuse-enforcement-design.md`
Зонт: `docs/superpowers/specs/2026-07-30-library-reuse-architecture-design.md` (проект 1 выполнен, не задеплоен)
Статус: draft → на адверсариальное ревью

## 0. Резюме

Сделать «переиспользуй, прежде чем создавать» **неотключаемым на границе API** и дешёвым для агента
с ограниченным контекстом:

1. детерминированный матчер семантических дубликатов поверх активного каталога;
2. `POST /api/catalog/candidates` — компактный поиск кандидатов;
3. обязательный `intent` и не обходимый gate на `POST /api/components` c админским
   `force-new` через `reuseOverride`;
4. append-only аудит решений `catalog_reuse_decisions`;
5. селективные команды `driver.mjs catalog search|get` и `--intent/--force-new`;
6. единая политика авторинга для всех агентов (`AGENTS.md` → `docs/agent-authoring-policy.md`).

Матчинг локальный, объяснимый, без эмбеддингов и без обращения к модели.

## 1. Что уже есть в коде (опорные точки)

| Что | Где |
|---|---|
| Создание компонента (draft rev 1) | `server/routes/components.ts:146` |
| Извлечение `DefinitionMeta` | `server/components/extract-subprocess.ts`, сборка — `server/components/pipeline.ts:103` |
| Материализация модуля | `materializeSource` — `server/components/pipeline.ts:29` |
| Активные строки каталога | `activeCatalogRows` — `server/routes/components.ts:107` |
| Read-model библиотеки (проект 1) | `server/routes/libraryCatalog.ts` |
| Ревизия каталога | `server/catalogRevision.ts` (единственный callsite — `libraryCatalog.ts:138`) |
| Использование в головах прототипов | `headUsageCounts` — `server/usageGraph.ts:222` |
| Клиентские токенизация/скоринг | `src/library/libraryModel.ts:47-120` |
| Реестр контрактов + OpenAPI-дрифт | `server/contracts.ts:48`, `scripts/generate-openapi.ts` |
| Аудит-события | `server/audit.ts:11` (таблица `audit_events`, v14) |
| Миграции | `server/migrations.ts`, текущий `user_version = 19` |
| CLI | `.claude/skills/author/driver.mjs` (906 строк, `parseArgs` :116, `runCatalog` :512, POST :807) |
| Тесты CLI | `server/driver-cli.test.ts`, типы — `server/driver-mjs.d.ts` |

Композиции v1 уже существуют (`server/repos/compositions.ts`, миграция v18), вложенность
запрещена (`src/prototype/composition.ts:98`). FTS5 в проекте **отсутствует**.

## 2. Осознанные отступления от спеки

| # | Спека | Решение плана | Почему |
|---|---|---|---|
| D1 | §3/§9: FTS-ранжирование, fallback при повреждении FTS-индекса | Никакого FTS5. Детерминированный in-memory скан по активному каталогу с портированной токенизацией `src/library/libraryModel.ts` | В проде 115 активных записей на систему; скан — доли миллисекунды. FTS5 добавляет виртуальные таблицы, миграцию, рассинхрон и целую ветку обработки ошибок (§9) ради нулевого выигрыша. Ветка «FTS corruption» из §9 исчезает вместе с причиной |
| D2 | §5 зонта: `catalogRevision` = хэш активных версий **плюс их discovery-метаданных** | Расширить `CatalogRevisionRow` до `{kind,designSystem,id,version,metaHash}` | Текущая реализация хэширует только идентификаторы: публикация новой версии не меняет ревизию, и админский `reuseOverride` мог бы подтвердить устаревший набор кандидатов. Это дефект корректности, а не улучшение |
| D3 | §6: `driver.mjs composition …` | Отложено в проект 3 | Композиционный gate спека сама включает «после Composition v2»; CLI без вложенности бесполезен агенту. В этом проекте — только компоненты |
| D4 | §4: «Updates to an existing artifact do not run the create gate» | Принимаем, **но** добавляем warn-only проверку дубликата на `publishComponent` (в общий канал `architectureWarnings`) | Иначе тривиальный обход: создать новый непохожий компонент → `PUT` дубликатным исходником → `publish`. Блокировать publish нельзя (сломает легальную эволюцию), но молчать о дубликате нельзя тоже |
| D5 | §8: бэкфилл `canonicalFor`/`scope` на 115 записях | В этом проекте — только версионированный глоссарий ролей + enforcement уникальности роли. Сам бэкфилл — проект 3 | Бэкфилл выполняется новыми ревизиями/версиями и является частью аудита каталога (проект 3) |
| D6 | §2: корпус кандидатов = активные компоненты + опубликованные композиции | Только активные компоненты; композиции подключаются точкой расширения (`kind` уже в сигнатуре) | Композиции v1 нельзя вкладывать, их дублирование — предмет проекта 3 |

## 3. Архитектура

### 3.1 Корпус матчинга

Источник — `activeCatalogRows(db, designSystem)` (последняя `active`-публикация на пару
`(component, designSystem)`, `deleted_at IS NULL`, не-retired системы) плюс `headUsageCounts`
и статус deprecated из `libraryCatalog`-логики. Из `definition_meta` берём `description`,
`propsJsonSchema`, `events`, `slots`, `atomicLevel`, `scope`, `canonicalFor`, `replacement`.
Исходник кандидата читается **лениво**, только для шингл-сигнала, и не попадает в ответ.

Известное ограничение: неопубликованные драфты в корпус не входят (у них нет
`definition_meta`). Драфт не рендерится и не пиннится прототипом, поэтому дубликат-драфт
безвреден до публикации; publish-предупреждение (D4) закрывает наблюдаемость.

### 3.2 Отпечатки (`server/catalog/fingerprint.ts`)

Чистые функции, ноль обращений к БД:

- `propsSignature(schema)` — отсортированные имена свойств, флаг required, примитив/enum-форма,
  политика `additionalProperties`. Значения `default`, `description`, `title` отбрасываются.
- `ioSignature(events, slots)` — отсортированные события и именованные слоты.
- `sourceShingles(source)` — нормализованные TSX-токены: удаляются комментарии, пробелы,
  строковые/числовые литералы, локальные идентификаторы (не-JSX, не-импорт); k-шинглы (k=5),
  сравнение — Jaccard.
- `structuralFingerprint(meta)` — sha256 канонического JSON `{props, io, atomicLevel, scope}`.
  Точное равенство → blocking.

Все нормализации детерминированы и покрыты фикстурами.

### 3.3 Скоринг (`server/catalog/matcher.ts`)

Веса — ровно из спеки §3, вынесены в `MATCH_WEIGHTS`/`MATCH_THRESHOLDS` как контрактные
константы:

```
props 0.25 · events+slots 0.15 · source-shingles 0.20 · name-tokens 0.15 ·
description/intent 0.15 · same atomicLevel+scope 0.10
blocking ≥ 0.82 · review-кандидат 0.65..0.8199 · ниже — только добивка до limit
```

Blocking также независимо от score при: пересечении `canonicalFor` или равенстве
`structuralFingerprint`. Deprecated/replaced артефакты возвращаются для объяснения,
но `blocking:false`, если объявленная активная замена уже присутствует в наборе (§9).

Порядок результатов детерминирован: `score desc → id asc` (score округляется до 4 знаков
перед сортировкой, чтобы плавающая точка не меняла порядок между прогонами).

`reasons` — человекочитаемые строки из фиксированного набора шаблонов (RU/EN нейтральные,
как в спеке §3).

### 3.4 Ревизия каталога

`CatalogRevisionRow` расширяется до `{kind, designSystem, id, version, metaHash}`, где
`metaHash` — sha256 канонического JSON discovery-подмножества `definition_meta`
(`description, atomicLevel, scope, canonicalFor, replacement, propsSignature, ioSignature`).
Считается по **нефильтрованному** каталогу (инвариант из комментария `catalogRevision.ts:6`
сохраняется). `GET /api/catalog/library` продолжает отдавать то же поле; тесты
`server/library-catalog.test.ts` обновляются на новую формулу.

### 3.5 Gate создания

`POST /api/components` перестраивается в порядок:

1. валидация полей (+ новый обязательный `intent`, 8–500 символов после trim, минимум один
   токен вне stop-set `component|компонент|element|элемент|ui`);
2. `mkdtemp` **внутри `DATA_DIR`** (`<dataDir>/.staging-<uuid>/`) → запись исходника →
   `checkSource` (транспайл + `extractDefinition`);
   *критично*: staging обязан лежать под корнем проекта, иначе материализованный TSX не
   разрешит `react`/`zod` из корневого `node_modules` (CLAUDE.md);
3. матчинг по извлечённой мете и исходнику;
4. решение:
   - нет blocking → создание + аудит `accepted_no_match` в одной транзакции;
   - blocking и нет валидного override → `409 component_reuse_required`, записи компонента и
     durable-модуля **нет**, пишется best-effort `blocked`-аудит;
   - валидный override (админ, `reason` 20–500, все текущие blocking-ключи подтверждены,
     `catalogRevision` совпадает) → создание + аудит `force_new` атомарно;
   - `catalogRevision` не совпал → `409 catalog_changed` + свежие кандидаты;
5. `materializeSource` в durable-путь только после решения «создаём»;
6. `finally` — удаление staging-каталога (успех, отказ, исключение, таймаут извлечения).

Shadow-режим (`REUSE_GATE=shadow`, §11): матчинг выполняется и пишется в аудит,
`409` не возвращается, в ответ добавляется `reuseWarnings`. Дефолт в проде на шаге 1
раскатки — `shadow`, затем переключение на `enforce` отдельным деплоем. Флаг read-only
серверный, клиент им управлять не может; значение видно в `GET /api/capabilities`.

Уникальность `canonicalFor` внутри системы проверяется и на create, и на publish
(изменение меты приходит публикацией новой версии) — конфликт даёт
`409 canonical_role_conflict`, обход — тот же админский override.

### 3.6 Аудит решений

Миграция **v20**: `catalog_reuse_decisions` по §5 (`id, actor_id, artifact_kind, artifact_id,
design_system, source_or_doc_hash, catalog_revision, intent, candidates_json, decision,
reason, created_at`), индексы по `(actor_id, created_at)` и `(artifact_id)`.
`candidates_json` содержит только компактные строки ответа (id/score/blocking/reasons) —
ни исходников, ни значений props, ни токенов.

Чтение: `GET /api/catalog/reuse-decisions` (только админ) с фильтрами
`decision|actor|designSystem|since` и `driver.mjs audit`-совместимый вывод.

## 4. Декомпозиция задач

Владение файлами строгое; параллелятся только непересекающиеся зоны.

### Волна 1 (параллельно)

**T1 — Ревизия каталога и текстовая нормализация**
Владеет: `server/catalogRevision.ts`, новый `server/catalog/text.ts`, `server/routes/libraryCatalog.ts`
(только строки ревизии), `server/library-catalog.test.ts`, `src/library/libraryModel.ts`
(экспорт токенизатора для переиспользования, поведение не менять), `src/library/*.test.ts` при
необходимости.
Готово когда: `metaHash`/`version` в ревизии, ревизия меняется при публикации новой версии и
при смене discovery-меты и **не** меняется при неотносящихся правках; токенизатор един для
сервера и SPA; `npm run verify` зелёный.

**T2 — Отпечатки и матчер (чистое ядро)**
Владеет: `server/catalog/fingerprint.ts`, `server/catalog/matcher.ts`,
`server/catalog/matcher.test.ts`, `server/catalog/fixtures/*`.
Зависит от T1 только по импорту `text.ts` (интерфейс согласован заранее: `tokenize(s): string[]`).
Готово когда: покрыты все кейсы §10 «Matcher» (canonical overlap, точные отпечатки,
переименованная копипаста, похожее имя + несовместимые props, одинаковая структура в разных
системах, deprecated с заменой, RU/EN описания, границы 0.65 и 0.82, стабильный порядок);
ноль обращений к БД в модуле.

**T3 — Миграция v20 и репозиторий решений**
Владеет: `server/migrations.ts` (только новый элемент массива), `server/repos/reuseDecisions.ts`,
`server/migrations.test.ts`, `server/repos/reuseDecisions.test.ts`.
Готово когда: `user_version = 20`, миграция идемпотентна на populated-базе, best-effort запись
`blocked` вне транзакции создания и атомарная запись `accepted_no_match|force_new` внутри неё
покрыты тестами.

### Волна 2 (после волны 1)

**T4 — Корпус + `POST /api/catalog/candidates`**
Владеет: `server/catalog/corpus.ts`, `server/routes/catalogCandidates.ts`, `server/main.ts`
(регистрация маршрута), `server/contracts.ts` (новые контракты), `server/openapi.json`
(регенерация), `server/catalog-candidates.test.ts`, кейс в `server/contract.test.ts`.
Готово когда: ответ компактный (без source и без полных props-схем), `catalogRevision`
в ответе, `limit` 1..20 (default 8), валидация `intent`, 404 на неизвестную систему,
`verify:openapi` зелёный, кейс контракта присутствует (иначе `contract.test.ts` красный).

**T5 — Gate создания компонента**
Владеет: `server/routes/components.ts`, `server/components/pipeline.ts` (только staging-путь),
`server/reuse-gate.test.ts`, `server/contracts.ts` (схема create — координация с T4 по
последовательности коммитов: T4 коммитится первым).
Готово когда: покрыты все кейсы §10 «API/security» — прямой дубликат блокируется без вызова
поиска; новый компонент создаётся; клиент не может подделать score/кандидатов; не-админ не
может override; override требует все blocking-ключи и валидный reason; гонка каталога отдаёт
свежих кандидатов; create+аудит атомарны; исходник отсутствует в аудите; staging-каталог
удаляется во всех ветках (проверка «в `DATA_DIR` не осталось `.staging-*`»);
`REUSE_GATE=shadow` не блокирует, но пишет аудит.

### Волна 3

**T6 — Миграция вызывателей на обязательный `intent`**
Владеет: все `server/*.test.ts` с `POST /api/components` (26 файлов из разведки), `e2e/**`,
`scripts/perf-gallery-dataset.ts`, `scripts/w6-yandex-pay.mjs`.
Не владеет `server/routes/components.ts` (T5) и `server/contracts.ts` (T4).
Готово когда: `npm run verify` и `npm run e2e` зелёные; в фикстурах осмысленные `intent`,
а не заглушка `"component"` (она не проходит stop-set).
Отдельно: `scripts/perf-library-dataset.ts` сидит напрямую в БД — задокументировать в шапке
скрипта, что он намеренно минует gate (local-only инструмент).

**T7 — CLI**
Владеет: `.claude/skills/author/driver.mjs`, `server/driver-cli.test.ts`, `server/driver-mjs.d.ts`.
Готово когда: `catalog search <ds> <intent> [--limit N] [--json]`; `catalog get <ds> <artifact…>`
(точные определения только для названных); `component … --intent <text>` обязателен,
`--force-new` требует `--reason` и админа; блокировка печатает кандидатов и выходит с
`EXIT.productErrors = 2`; старый `catalog <ds>` больше не вырезает `scope`/`canonicalFor`/
`replacement`/`deprecated`/usage (правка `compactCatalog`, driver.mjs:279); парсер-тесты на
новые флаги и `ranges`.

### Волна 4

**T8 — Политика и глоссарий**
Владеет: `docs/agent-authoring-policy.md` (канон), `AGENTS.md` (новый, тонкая ссылка),
`CLAUDE.md` (ссылка), `.claude/skills/author/SKILL.md`, `.claude/skills/yp-prototype/SKILL.md`,
`.claude/skills/yandex-pay/SKILL.md`, `docs/canonical-roles.md` + `server/catalog/roles.json`,
drift-тест `server/agent-policy.test.ts`.
Готово когда: все тонкие точки входа ссылаются на канон (drift-тест падает при рассинхроне);
глоссарий ролей версионирован, слаги валидируются при публикации (warn на неизвестный слаг,
не блокировать).

**T9 — Раскатка, capabilities, документация**
Владеет: `server/routes/meta.ts` (feature-флаг), `docs/server-api.md`,
`docs/plans/2026-07-31-component-reuse-enforcement.md` (журнал приёмки), интеграционные тесты
`server/reuse-integration.test.ts` (§10 «Integration»).
Готово когда: `GET /api/capabilities` отдаёт режим gate; описаны новые эндпоинты, коды ошибок,
`intent`-контракт; интеграционный сценарий «агент нашёл → переиспользовал → опубликовал
прототип без создания компонента» зелёный; результаты shadow-прогона по прод-дампу приложены.

## 5. Порядок деплоя

1. Волны 1–4 → `npm run verify` + `npm run e2e` + `/verify` runtime.
2. Деплой с `REUSE_GATE=shadow`.
3. Прогон всего прод-каталога через матчер; ложные срабатывания фиксируются
   детерминированными фикстурами (без правки порогов «на глаз»; изменение порогов — версионное
   изменение политики с отчётом).
4. Переключение на `REUSE_GATE=enforce` отдельным деплоем.
5. Проект 3 (Composition v2 + дедупликация) стартует только после шага 4 —
   жёсткий гейт обязан стоять до прод-дедупликации.

## 6. Риски

| Риск | Митигация |
|---|---|
| Ложные блокировки на легитимных вариациях (например, `yp-button` vs `yp-button-icon`) | Shadow-прогон по проду до включения; фикстуры на найденные ложные срабатывания; `force-new` у админа |
| Обход через PUT+publish | D4: warn-only на publish, наблюдаемость через аудит |
| Ломающее изменение контракта create (26+ вызывателей) | T6 отдельной волной; `npm run e2e` **не входит** в `verify` — гонять явно |
| Стоимость матчинга на create | Корпус ≤ 200 строк, ленивое чтение исходников только для top-N по дешёвым сигналам |
| Расхождение ревизии каталога с проектом 1 | T1 обновляет формулу и тесты одним коммитом |

## 7. Журнал приёмки

Заполняется по ходу выполнения.
