# План: Component Reuse Enforcement and Agent Discovery (проект 2)

Дата: 2026-07-31 · Версия: **v2** (после раунда адверсариального ревью, 3 линзы)
Спека: `docs/superpowers/specs/2026-07-30-component-reuse-enforcement-design.md`
Зонт: `docs/superpowers/specs/2026-07-30-library-reuse-architecture-design.md` (проект 1 выполнен, не задеплоен)
Статус: v2 → на повторное ревью

## 0. Резюме

Сделать «переиспользуй, прежде чем создавать» **неотключаемым на границе API** и дешёвым для
агента с ограниченным контекстом:

1. детерминированный матчер семантических дубликатов (калиброванный на реальном каталоге);
2. `POST /api/catalog/candidates` — компактный поиск кандидатов;
3. gate на **всех** путях создания активного компонента: `POST /api/components` и
   `POST /api/bundles/import`, с админским `force-new` через `reuseOverride`;
4. append-only аудит решений `catalog_reuse_decisions` + админское чтение;
5. селективные команды `driver.mjs catalog search|get`, `--intent/--force-new`;
6. единая политика авторинга для всех агентов (`AGENTS.md` + `CLAUDE.md` → канон).

Матчинг локальный, объяснимый, без эмбеддингов и без обращения к модели.

## 1. Триаж ревью v1

Ревью: три read-only субагента (корректность/безопасность, скоуп/декомпозиция, агентский DX).
Все три сошлись на трёх находках; они переписали план, а не детали.

| # | Находка | Решение |
|---|---|---|
| B1 | D2 опирался на неверную посылку: `catalogRevision(all)` получает полные `LibraryCatalogEntry`, а `canonicalStringify` хэширует **фактические** ключи объекта — в ревизию уже входят `version`, `bundleHash`, `status`, `headUsageCount`. Проверено лично: `server/routes/libraryCatalog.ts:138`, `src/capture/canonicalJson.ts:11-18` | **Принято.** D2 переписано с «расширить» на «**сузить** до стабильной проекции». Настоящий дефект — волатильность: `headUsageCount` меняется от правки любого прототипа, `verified` — от фонового visual-run, поэтому `reuseOverride` протухал бы от чужой работы. См. §3.4, T1 |
| B2 | `POST /api/bundles/import` создаёт и публикует компоненты в обход роута (`server/bundle/importer.ts:250`), authz — `requireUser`, не админ. Тезис «gate необходим» был ложен | **Принято.** Новая задача T11: gate внутри импортёра, per-item `reuse_blocked`, аудит-решения с `actor = importerId`. См. §3.7 |
| B3 | Пороги не калиброваны. Рецензент прогнал плановую формулу на 37 активных yandex-pay: blocking-пар **0**; синтетическая копипаста с переформулированным описанием — 0.775, с переименованными идентификаторами — 0.685 (обе ниже 0.82). Плюс `J(∅,∅)=1` даёт +0.15 даром 22 компонентам из 37, а `scope`/`canonicalFor` в проде отсутствуют у **всех** записей | **Принято, это самая дорогая правка.** Введена задача **T0 — калибровка до исполнения** (§4, волна 0). Пороги/веса спеки становятся стартовой точкой, а не контрактом; итоговые значения выбираются по замеренному распределению и фиксируются как версионированная политика (D7). Исправлены дефекты сигналов: пустое↔пустое нейтрально с перенормировкой весов, IDF по корпусу описаний, шинглы по всему корпусу (не top-N) |
| B4 | Корпус из одних активных публикаций + warn-only publish = штатный обход «создать N драфтов → опубликовать». Плюс TOCTOU между двумя конкурентными POST (между `await checkSource` и вставкой) | **Принято.** Драфты входят в корпус через новую таблицу отпечатков, заполняемую на create/save (мета там уже извлекается). Матчинг **пересчитывается внутри синхронной транзакции создания** — окно TOCTOU закрывается. См. §3.1, §3.5 |
| B2′ (DX) | У не-админского агента нет терминального выхода из 409: политика запрещает ему `force-new`, а переименование/косметика блокировку не снимут | **Принято.** Контракт 409 получает машиночитаемый терминал (`retryable:false`, `resolution`, `nextSteps`, `overrideTemplate`, `repeatedAttempts`) и `propsDelta` у blocking-кандидатов. Драйвер печатает явный STOP и не ретраит. См. §3.5 |
| B3′ (DX) | Жёсткая обязательность `intent` едет в прод **раньше** shadow-фазы и ломает внешних вызывателей (в т.ч. закоммиченный дистрибутив `.claude/skills/author.zip` со старым драйвером) | **Принято.** `intent` привязан к фазе: в `shadow` отсутствующий `intent` синтезируется из `name`+`description`, отдаётся `warnings[]` и помечается в аудите `intent_missing`; в `enforce` — обязателен. Метрика готовности к enforce: доля create без `intent` за окно = 0 |
| M1/M3 (r1/r3) | «Ленивое чтение исходников только для top-N» убивает единственный сигнал против переименованной копипасты; полный `catalog <ds>` после T7 становится **толще**, а он и есть основной цикл | **Принято.** Шинглы кэшируются в БД при create/publish (таблица отпечатков), скан по всему корпусу. Расширенные поля полного каталога — за `--full`; скиллы переводятся на `catalog get` |
| M2 (r1) | Асинхронный callback в `db.transaction` молча коммитит: откат не происходит | **Принято.** Инвариант в §3.5: блок «матч + create + аудит» строго синхронный, ни одного `await`; регрессионный тест |
| M3 (r1) / B2 (r2) / M5 (r3) | Пересечения владения: `contracts.ts`, `contract.test.ts`, `openapi.json`, `main.ts` | **Принято.** T4 — единственный владелец контрактного слоя на весь проект; остальные задачи отдают дельты заявкой |
| B3 (r2) | `GET /api/catalog/reuse-decisions` бесхозен, §5 спеки покрыт на четверть | **Принято.** Новая задача T10 с четырьмя выборками спеки |
| M5 (r2) | SDK discovery summary (§6 спеки) молча выпал | **Принято**, добавлен в T8 |
| M6 (r2) | D3 шире обоснования: гейт композиций ждёт v2, но CLI-команды композиций — нет | **Частично принято.** Две тонкие команды `composition`/`composition publish` над существующим API v1 — в T7; гейт композиций остаётся в проекте 3 |
| M6 (r3) | Link-only `AGENTS.md` — регрессия для Codex-пути (Codex не читает `CLAUDE.md`) | **Принято.** `AGENTS.md` несёт операционные разделы целиком, а не одну ссылку |
| M7 (r3) | Drift-тест по grep зелёный ровно там, где все примеры команд уже неверны | **Принято.** Тест прогоняет команды из fenced-блоков SKILL.md через экспортируемый `parseArgs` |
| M8 (r3) | Login rate-limit прода (3+ вызова подряд → 429) ломает цикл search→get→component | **Принято.** Ранний поиск выполняется **внутри** verb `component` (тот же процесс, один логин) |
| M2 (r3) | `--intent` обязателен на verb `component`, который в 90% случаев PUT+publish | **Принято.** Драйвер требует `--intent` только когда сам зарезолвил `meta === null` |
| M7 (r2) / M4 (r3) | Интеграционные сценарии §10 покрыты на 1 из 4; «search results match Library results» архитектурно недостижимо | **Принято частично.** Три сценария добавлены в T9; полное совпадение ранжирования — отступление **D8** (проверяем более слабый инвариант подмножества) |
| m4 (r3) | §5 шаг 2 выкатывает в прод заодно непродеплоенный проект 1 | **Принято.** Деплой проекта 1 — отдельный релиз до shadow |
| m1 (r3) | `POST /api/catalog/candidates` попадает под `enforceOrigin` (403 без `Origin`) | **Принято.** Частый случай (без `proposed`) продублирован как `GET /api/catalog/candidates` с query-параметрами |
| прочие minor (m1–m9 ×3) | Материализация на create не нужна вовсе; `text.ts` направление импорта `src → server`; проверка id/name до матчинга; sweep `.staging-*` на старте; отсутствие FK на `artifact_id`; `append-only` через триггер; `recommendable` у deprecated; deprecated-замена проверяется по всему корпусу, не по срезу | **Приняты**, разнесены по §3 и done-критериям |
| **Отклонено** | «Переставить проекты 2 и 3 местами» (r1, вариант в B3) | Жёсткий гейт обязан стоять **до** прод-дедупликации (зонт §6). Вместо перестановки — калибровка T0 и честная фиксация в §5: до бэкфилла `canonicalFor` (проект 3) гейт ловит структурные и исходниковые дубликаты, но не ролевые |

## 2. Осознанные отступления от спеки

| # | Спека | Решение | Почему |
|---|---|---|---|
| D1 | §3/§9: FTS-ранжирование + fallback при повреждении индекса | Никакого FTS5. Детерминированный in-memory скан; сигнал description/intent — **IDF-взвешенное** пересечение токенов, IDF считается по корпусу активных описаний той же системы | 115 записей на систему; скан — доли мс. FTS5 добавляет виртуальные таблицы, миграцию и целую ветку §9 ради нуля. IDF обязателен: без него моно-вендорная лексика («экран», «оплата») систематически завышает сигнал |
| D2 | §5 зонта: `catalogRevision` = хэш активных версий + discovery-метаданных | **Сузить** текущую ревизию до проекции `{kind,designSystem,id,version,metaHash}` через единственный экспортируемый `catalogRevisionRows(db)` | Сегодня в хэш случайно попадают `headUsageCount`, `status.verified`, `figma`, `preview` — ревизия дёргается от правки чужого прототипа и от фонового visual-run, из-за чего `reuseOverride` протухал бы без изменений каталога. Это смена контракта проекта 1, тесты `server/library-catalog.test.ts` обновляются осознанно |
| D3 | §6: `driver.mjs composition …` + гейт композиций | CLI-команды `composition`/`composition publish` над существующим API v1 — **в скоупе**; гейт `POST /api/compositions` — проект 3 | Спека сама привязывает гейт к Composition v2. Но политика T8 предписывает «предпочитай композицию» — оставить агента без инструмента нельзя |
| D4 | §4: «Updates do not run the create gate» | Принимаем, **но** publish получает warn-only проверку дубликата (в `architectureWarnings`), с обязательным исключением самого артефакта `(designSystem,id)` из корпуса | Иначе обход PUT→publish. Исключение себя критично: без него каждая обычная перепубликация печатала бы «дубликат» (и убила бы бэкфилл проекта 3 на 115 компонентах) |
| D5 | §8: бэкфилл `atomicLevel`/`scope`/`canonicalFor`/`ownership`/`replacement` | Здесь — только версионированный глоссарий ролей + enforcement уникальности роли + warn на неизвестный слаг. Бэкфилл всех пяти полей — проект 3 (инструмент `scripts/backfill-component-scope.ts` уже есть) | Бэкфилл выполняется новыми ревизиями/версиями и является частью аудита каталога |
| D6 | §2: корпус = компоненты + опубликованные композиции | Только компоненты (активные публикации + head-драфты) | Композиции v1 не вкладываются; их дедупликация — проект 3. `kind` уже в сигнатуре, точка расширения открыта |
| **D7** | §3: конкретные веса и пороги 0.65/0.82 как «контрактные константы» | Веса/пороги спеки — **стартовая точка**; итоговые выбираются задачей T0 по замеренному распределению на прод-дампе и фиксируются в `server/catalog/policy.ts` с версией политики и отчётом | Замер рецензента: под весами спеки на реальном каталоге blocking-пар ноль, а переименованная копипаста (кейс §10) даёт 0.685. Спека сама требует «production shadow analysis runs before enforcement is enabled» — T0 выполняет её раньше, на дампе, до ломающих изменений |
| **D8** | §10: «search results match Library results for the same intent» | Проверяем более слабый инвариант: каждый кандидат матчера со `score ≥ 0.65` присутствует в результатах `searchComponents` библиотеки для того же intent (подмножество), порядок не сверяется | Ранжирования разные по назначению: библиотека ранжирует для человека (роль/имя), матчер — для дедупликации (структура/исходник). Полное совпадение потребовало бы слить две функции и ухудшить обе |

## 3. Архитектура

### 3.1 Корпус матчинга

Три источника, объединённые в `server/catalog/corpus.ts`:

1. **Активные публикации** — `activeCatalogRows(db, designSystem)` + `headUsageCounts` +
   deprecated-статус (логика `libraryCatalog`).
2. **Head-драфты** — компоненты без активной публикации. Их discovery-мета извлекается уже
   сегодня на create (`checkSource` → `extractDefinition`, `routes/components.ts:146`), но нигде
   не сохраняется; новая таблица отпечатков (§3.6) её фиксирует на create и save.
3. **Кэш отпечатков** — нормализованные шинглы исходника, `propsSignature`, `ioSignature`,
   `structuralFingerprint`. Пишется при create/save/publish, читается матчером. Это снимает
   необходимость читать исходники всего каталога на каждый create (M1) и позволяет считать
   шингл-сигнал по **всему** корпусу, а не по top-N.

Из корпуса всегда исключается сам оцениваемый артефакт по `(designSystem, id)` (D4).

### 3.2 Отпечатки (`server/catalog/fingerprint.ts`)

Чистые функции, ноль обращений к БД:

- `propsSignature(schema)` — отсортированные имена свойств, required, примитив/enum-форма,
  политика `additionalProperties`; `default`/`description`/`title` отбрасываются.
- `ioSignature(events, slots)` — отсортированные события и именованные слоты.
- `sourceShingles(source)` — TSX-токены без комментариев, пробелов, литералов и локальных
  идентификаторов; k-шинглы (k=5), сравнение — Jaccard.
- `structuralFingerprint(meta)` — sha256 канонического JSON `{props, io, atomicLevel, scope}`.
  Точное равенство → blocking.

**Инвариант пустых множеств:** если оба сравниваемых множества пусты, сигнал не даёт
1.0, а исключается из суммы, и веса перенормируются на присутствующие сигналы. Без этого
22 из 37 прод-компонентов без событий и слотов получают +0.15 даром (B3).

### 3.3 Скоринг (`server/catalog/matcher.ts` + `server/catalog/policy.ts`)

Сигналы — из спеки §3; **числовые веса и пороги живут в `policy.ts` с полем `policyVersion`**
и задаются по результатам T0 (D7). Стартовые значения — спековские:

```
props 0.25 · events+slots 0.15 · source-shingles 0.20 · name-tokens 0.15 ·
description/intent (IDF) 0.15 · same atomicLevel+scope 0.10
blocking ≥ 0.82 · review 0.65..0.8199
```

Независимо от score blocking дают: пересечение `canonicalFor`; равенство
`structuralFingerprint`. Deprecated/replaced артефакты возвращаются с `blocking:false` и
`recommendable:false`, если их объявленная активная замена присутствует **в корпусе** (а не в
усечённом до `limit` ответе). Порядок: `score desc → id asc`, score округляется до 4 знаков
перед сортировкой.

`reasons` — фиксированные шаблоны из спеки §3. У blocking-кандидатов дополнительно
`propsDelta` — только имена добавленных/убранных/сменивших тип пропов (без схем): именно это
поле превращает «заблокировано» в решение без второго round-trip.

### 3.4 Ревизия каталога

Единственный источник строк — новый `catalogRevisionRows(db)`: проекция
`{kind, designSystem, id, version, metaHash}`, где `metaHash` — sha256 канонического JSON
discovery-подмножества (`description, atomicLevel, scope, canonicalFor, replacement,
propsSignature, ioSignature`). Считается по **нефильтрованному** каталогу.

Исключены намеренно: `headUsageCount`, `status.*`, `figma`, `preview`, `bundleUrl` — они
меняются от действий, не относящихся к решению о дубликате.

`GET /api/catalog/library`, `POST /api/catalog/candidates` и gate потребляют **одну и ту же**
функцию; тест сверяет побайтовое равенство ревизий из библиотеки и из кандидатов на одной БД.

### 3.5 Gate создания (`POST /api/components`)

Порядок:

1. дешёвые проверки: аллоу-лист полей (+`intent`), слаг id, regex имени,
   `reserveHostPrimitiveName`, **существование id/name**, активность системы, права —
   всё до дорогого извлечения (m4 r1);
2. `intent` по фазе: `enforce` — обязателен (8–500 символов после trim, ≥1 токен вне stop-set
   `component|компонент|element|элемент|ui`); `shadow` — синтезируется из `name`, ответ несёт
   `warnings[]`, аудит помечается `intent_missing`;
3. `<dataDir>/.staging/<uuid>/` → запись исходника → `checkSource`.
   *Критично*: staging обязан лежать под корнем проекта, иначе материализованный TSX не
   разрешит `react`/`zod` из корневого `node_modules` (CLAUDE.md). Фиксированный корень
   `.staging/` + подметание сирот на старте (рядом с `failStagingPublishes`, `main.ts:186`) —
   `finally` не спасает от SIGKILL при редеплое;
4. **синхронный блок** `db.transaction(() => …)`, ни одного `await` внутри (иначе bun:sqlite
   молча коммитит на первом await, M2): пересчёт матчинга по свежему корпусу → решение →
   вставка компонента и аудит-строки. Пересчёт именно здесь закрывает TOCTOU между двумя
   конкурентными POST (B4);
5. решения:
   - нет blocking → create + аудит `accepted_no_match`;
   - blocking без override → `409 component_reuse_required`, ни строки компонента, ни
     durable-модуля; best-effort `blocked`-аудит вне транзакции;
   - валидный override (админ, `reason` 20–500, подтверждены все текущие blocking-ключи,
     `catalogRevision` совпал) → create + аудит `force_new` в той же транзакции;
   - `catalogRevision` не совпал → `409 catalog_changed` + свежие кандидаты;
   - исключение матчера → 5xx, компонента нет (§9 «never fails open»), покрыто тестом на
     инъекцию сбоя;
6. durable-материализация модуля на create **не выполняется вовсе**: `publishComponent`
   материализует заново из `repo.source(id)` (`routes/components.ts:71`), путь
   content-addressed и идемпотентен. Это заодно снимает §9-требование про удаление staged-
   артефактов при откате (m1 r1);
7. `finally` — удаление staging-каталога во всех ветках.

Тело `409 component_reuse_required` (терминальный контракт для агента, B2′):

```ts
{ error: "component_reuse_required", catalogRevision, candidates: [...],
  retryable: false, resolution: "reuse" | "escalate", nextSteps: string[],
  repeatedAttempts: number,                 // тот же actor+sourceHash+designSystem
  overrideTemplate: { catalogRevision, candidateKeys } }
```

Уникальность `canonicalFor` внутри системы проверяется на create и на publish;
конфликт → `409 canonical_role_conflict`, обход — тот же админский override.

Режим gate — **не** `process.env` внутри хендлера, а параметр `HandlerOptions`
(`server/main.ts:33`) с дефолтом `enforce` в коде и переопределением из `REUSE_GATE` только на
входе процесса (иначе тесты мутируют глобальный env в общем процессе `bun test`, M4 r1).
Прецедент `EASYUI_PUBLISH_GATES` (`server/readiness.ts:79`), который выключен в проде с
2026-07-27 и не включён до сих пор, — прямое предупреждение: у выхода из shadow в §5 есть
критерий и ответственный.

### 3.6 Схема (миграция v20)

- `catalog_reuse_decisions` по §5 спеки: `id, actor_id, artifact_kind, artifact_id,
  design_system, source_or_doc_hash, catalog_revision, intent, candidates_json, decision,
  reason, created_at`. **Без FK на `components(id)`**: `blocked`-запись ссылается на
  *предложенный* id, а миграции гоняют `PRAGMA foreign_key_check` (`migrations.ts:495`).
  Append-only enforced триггерами `BEFORE UPDATE/DELETE → RAISE(ABORT)`.
  `candidates_json` — только компактные строки (id/score/blocking/reasons), без исходников,
  значений props и токенов. Индексы: `(actor_id, created_at)`, `(artifact_id)`, `(decision)`.
- `component_fingerprints`: `component_id, design_system, rev, version|NULL, props_signature,
  io_signature, structural_fingerprint, shingles_json, description, updated_at`.
  Пишется на create/save/publish; для драфтов `version IS NULL`.

### 3.7 Импорт бандла (T11)

`server/bundle/importer.ts` create-ветка (`:250`) проходит **тот же** матчер:
per-item решение, при blocking — `action: "error", detail: "reuse_blocked"` в отчёте (импорт
по-элементный, запрос не роняется), аудит-запись `blocked` с `actor = importerId` и
синтезированным intent `imported from <manifest.source.origin>`. Админ может выполнить импорт с
`?reuseOverride=force` — тогда каждая блокирующая позиция даёт `force_new` с обязательным
`reason` из query. Ветка «существующий id → save+publish» гейт не проходит (это update, D4),
но получает publish-предупреждение.

## 4. Декомпозиция

Владение строгое. **Контрактный слой (`server/contracts.ts`, `server/contract.test.ts`,
`server/openapi.json`, `server/main.ts`) принадлежит T4 на весь проект**; остальные задачи
отдают дельты заявкой в своём отчёте, T4 вносит их и регенерирует OpenAPI.

### Волна 0 — калибровка (блокирует всё остальное)

**T0 — Калибровка матчера на реальном каталоге**
Владеет: `scripts/calibrate-matcher.ts`, `docs/audit/2026-07-31-matcher-calibration.md`,
`server/catalog/policy.ts` (начальные значения), фикстуры `server/catalog/fixtures/`.
Работает на локальной копии прод-дампа (при недоступности — на `data/easy-ui.db` + синтетика).
Готово когда: приложено распределение score по всем парам активного каталога; замерены восемь
синтетических сценариев §10 (дословная копия, копия со сменой описания, переименованная
копипаста, переписанный с нуля с теми же props, похожее имя + несовместимые props, одинаковая
структура в разных системах, deprecated с заменой, RU/EN); выбраны и обоснованы веса и пороги,
при которых первые три сценария blocking, а легитимные пары каталога — нет; результат зафиксирован
в `policy.ts` с `policyVersion: 1`. **Если такой набор весов не существует — задача обязана это
доказать и вернуть решение на уровень плана (кандидат: включать enforce только после бэкфилла
ролей в проекте 3).**

### Волна 1 (параллельно, после T0)

**T1 — Ревизия каталога и текст**
Владеет: `server/catalogRevision.ts`, `src/library/text.ts` (чистый токенизатор + IDF; импорт
`src → server`, как уже делается для `src/designSystems`), `src/library/libraryModel.ts`,
`server/routes/libraryCatalog.ts` (только строки ревизии), `server/library-catalog.test.ts`,
`src/library/*.test.ts`.
Готово когда: `catalogRevisionRows(db)` — единственный источник; ревизия **меняется** при
публикации новой версии и при смене discovery-меты; **не меняется** при правке прототипа
(`headUsageCount`), при завершении visual-run (`verified`) и при сохранении драфта; смена
контракта библиотеки зафиксирована в шапке теста; `npm run verify` зелёный.

**T2 — Отпечатки и матчер (чистое ядро)**
Владеет: `server/catalog/fingerprint.ts`, `server/catalog/matcher.ts`, их тесты.
Потребляет `policy.ts` (T0) и `src/library/text.ts` (интерфейс `tokenize(s): string[]`,
файл создаёт T1 — заглушка кладётся до диспатча).
Готово когда: покрыты все кейсы §10 «Matcher»; инвариант пустых множеств с перенормировкой;
ноль обращений к БД; стабильный порядок; `recommendable` у deprecated считается по корпусу.

**T3 — Миграция v20 и репозитории**
Владеет: `server/migrations.ts` (новый элемент), `server/repos/reuseDecisions.ts`,
`server/repos/componentFingerprints.ts`, их тесты, `server/migrations.test.ts`.
Готово когда: `user_version = 20`; триггеры append-only покрыты тестом (UPDATE/DELETE → ABORT);
миграция идемпотентна на populated-базе; отсутствие FK на `artifact_id` задокументировано.

### Волна 2

**T4 — Контрактный слой + `/api/catalog/candidates`**
Владеет: `server/catalog/corpus.ts`, `server/routes/catalogCandidates.ts`, `server/main.ts`,
`server/contracts.ts`, `server/contract.test.ts`, `server/openapi.json`, свой тест маршрута.
Готово когда: `POST` и `GET` (частый случай без `proposed`, чтобы обойти `enforceOrigin`);
ответ компактный; `limit` 1..20 (default 8); 404 на неизвестную систему; `422 unsupported_kind`
на `kind:"composition"` (D6); `verify:openapi` зелёный; кейсы контрактов для всех новых кодов.

**T5a — Рефакторинг порядка операций create (behaviour-preserving)**
Владеет: `server/routes/components.ts`, `server/components/pipeline.ts`, `server/main.ts`
(sweep `.staging/` на старте — дельта заявкой в T4).
Готово когда: staging вместо durable-материализации на create, дешёвые проверки перед
извлечением, sweep сирот; **существующие тесты зелёные без единой правки**.

**T5b — Gate, override, аудит, shadow**
Владеет: те же файлы после T5a, `server/reuse-gate.test.ts`.
Готово когда: покрыты все кейсы §10 «API/security» + синхронность транзакции (регресс-тест на
async-callback) + «матчер бросил → 5xx, компонента нет» + `.staging` пуст в `afterEach` +
shadow не блокирует, но пишет аудит и синтезирует intent + `409` несёт терминальные поля и
`propsDelta` + `canonical_role_conflict` на create и publish + publish-предупреждение D4 с
исключением самого артефакта.

**T11 — Gate в импорте бандла**
Владеет: `server/bundle/importer.ts`, `server/bundle-import.test.ts`.
Зависит от T5b (общая функция гейта). Готово когда: create-ветка гейтится per-item; отчёт несёт
`reuse_blocked`; аудит с `actor=importerId`; админский `?reuseOverride=force` с `reason`;
экспорт→импорт дубликата под свободным id блокируется тестом.

### Волна 3

**T6a — Механическая простановка `intent`**
Владеет: 12 серверных тест-файлов с HTTP-создданием (~34 вызова), `e2e/**`,
`scripts/perf-gallery-dataset.ts`, `scripts/w6-yandex-pay.mjs`, `scripts/backfill-component-scope.ts`.
Явный список «намеренно мимо гейта» (прямой `ComponentRepo.create`, сырые `INSERT INTO
components`, `scripts/perf-library-dataset.ts`) документируется в шапке плана-отчёта, чтобы
следующая волна их не «починила».

**T6b — Триаж коллизий гейта в фикстурах**
Готово когда: матчер прогнан по всему набору e2e/тестовых сидов, пары со `score ≥ 0.65`
перечислены, по каждой принято решение (структурно развести фикстуру / выдать тестовому хелперу
admin-override); `npm run verify` и `npm run e2e` зелёные.

**T7 — CLI**
Владеет: `.claude/skills/author/driver.mjs`, `server/driver-cli.test.ts`, `server/driver-mjs.d.ts`.
Готово когда: `catalog search <ds> --intent <text> [--limit N] [--json]` (exit 0 даже при
blocking-кандидатах: запрос успешен); `catalog get <ds> <artifact…>` (вариадическая форма в
`ranges`); подкоманды различаются по `positionals[0] ∈ {search,get}`, слаги `search`/`get`
зарезервированы и покрыты тестом; `--limit` валидируется на клиенте (1..20); все новые
подкоманды идут через `report()` и уважают `--json` (сегодня `runCatalog` его игнорирует,
driver.mjs:512); `--intent` требуется только когда драйвер зарезолвил `meta === null`;
`--force-new` требует `--reason` и админа; `component_reuse_required`/`catalog_changed`
перехватываются **до** `failRevisionConflict` (driver.mjs:809) и печатают STOP-инструкцию без
авто-ретрая, exit 2; расширенные поля полного каталога — за `--full`; команды
`composition <id> <doc.json> --design-system` и `composition publish <id>`; ранний поиск
выполняется внутри verb `component` (один логин на процесс — прод рейт-лимитит логины).

### Волна 4

**T8 — Политика, глоссарий, SDK**
Владеет: `docs/agent-authoring-policy.md` (канон), `AGENTS.md` (с операционными разделами
целиком, не ссылкой), `CLAUDE.md`, три SKILL.md, `docs/authoring-sdk.md`,
`docs/canonical-roles.md` + `server/catalog/roles.json`, `scripts/generate-sdk.ts`
(discovery summary по ролям и уровням), `server/agent-policy.test.ts`.
Готово когда: drift-тест вытаскивает все `driver.mjs …` из fenced-блоков и прогоняет через
`parseArgs`, падая на usage-ошибке; скиллы переведены с полного дампа каталога на
`catalog get`; глоссарий стартовый (не «все 115»), с процедурой пополнения; судьба
`.claude/skills/author.zip` решена (обновить или удалить).

**T9 — Раскатка, capabilities, документация, интеграция**
Владеет: `server/routes/meta.ts` (дельта контракта — заявкой в T4), `docs/server-api.md`,
`server/reuse-integration.test.ts`, журнал приёмки этого плана.
Готово когда: `GET /api/capabilities` отдаёт режим гейта; три интеграционных сценария §10
(reuse без создания; блокировка через driver **и** через сырой API; force-new даёт ровно одну
атрибутируемую запись) + инвариант D8; `docs/server-api.md` описывает новые эндпоинты, коды и
контракт `intent` (заодно правится устаревшее «designSystem по умолчанию shadcn», :275).

**T10 — Админское чтение аудита**
Владеет: `server/routes/reuseDecisions.ts` (дельты контракта — заявкой в T4), CLI-подкоманда в
`driver.mjs` (координация с T7: T7 коммитится первым), тесты.
Готово когда: четыре выборки §5 спеки — force-new; **повторяющиеся** blocked по actor/artifact
(агрегация); конфликты канонической роли; артефакты, созданные до гейта и ни разу не прошедшие
reuse-review (LEFT JOIN каталога с решениями); только админ.

## 5. Порядок деплоя

1. **Отдельный релиз: проект 1 (library perf)** — он закоммичен, но не задеплоен; смешивать две
   несвязанные волны в одном релизе с одной точкой отката нельзя.
2. Волны 0–4 → `npm run verify` + `npm run e2e` + runtime `/verify`.
3. Деплой с `REUSE_GATE=shadow`. Критерий выхода из shadow (иначе повторим историю
   `EASYUI_PUBLISH_GATES`, выключенных в проде с 2026-07-27): ≥ 2 недель наблюдения ИЛИ ≥ 20
   решений в аудите, доля create без `intent` = 0, ложные срабатывания разобраны и закрыты
   фикстурами. Ответственный — оркестратор волны.
4. Переключение на `REUSE_GATE=enforce` отдельным деплоем; смена порогов после этого —
   версионное изменение политики (`policyVersion`) с отчётом и тестами.
5. Проект 3 стартует только после шага 4.

**Честная граница возможностей:** до бэкфилла `canonicalFor`/`scope` (проект 3) гейт ловит
структурные и исходниковые дубликаты, но не ролевые — blocking по канонической роли не может
сработать на каталоге, где это поле пусто у всех 115 записей.

## 6. Риски

| Риск | Митигация |
|---|---|
| Гейт инертен на реальном каталоге (замер ревью: 0 blocking-пар под весами спеки) | T0 до исполнения; отчёт по распределению; D7 |
| Ложные блокировки | Shadow-фаза с критерием выхода; фикстуры; админский override; `propsDelta` и STOP-инструкция в 409 |
| Агент залипает на 409 | Терминальный контракт 409, запрет авто-ретрая в драйвере, `repeatedAttempts` |
| Ломающий контракт create | `intent` привязан к фазе; T6a/T6b отдельной волной; `npm run e2e` **не входит** в `verify` — гонять явно; `author.zip` обновить/удалить |
| Обход через bundle-import | T11 |
| Обход через драфты и TOCTOU | Драфты в корпусе; пересчёт матча внутри синхронной транзакции |
| Расхождение ревизии между эндпоинтами | Единственный `catalogRevisionRows`; тест на побайтовое равенство |
| Прод рейт-лимитит логины (429 на 3+ вызова) | Ранний поиск внутри verb `component`; отдельный `catalog search` — для явного цикла |

## 7. Журнал приёмки

Заполняется по ходу исполнения.
