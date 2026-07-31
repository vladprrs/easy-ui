# План: Composition v2, атомарная политика и миграция каталога (проект 3)

Дата: 2026-07-31
Спека: `docs/superpowers/specs/2026-07-30-composition-v2-dedup-migration-design.md`
Зонт: `docs/superpowers/specs/2026-07-30-library-reuse-architecture-design.md` (проект 1 выполнен и в проде, проект 2 выполнен и в проде в режиме `enforce`)
Статус: **код и приёмка волн 1–5 завершены**; продовые стадии A/B/C — отдельным решением владельца

## 0. Особенность этого плана

План написан **после** реализации: код проекта 3 был сделан на ветке `codex/composition-v2-runtime`
одной волной без предварительного плана и без прогона e2e. Документ фиксирует фактический
объём, найденные при приёмке дефекты и границу готовности, чтобы продовая миграция шла по
записанному, а не по устной договорённости. Отклонение от канона CLAUDE.md (планирование →
адверсариальное ревью → исполнение) зафиксировано осознанно и не повторяется для стадий A/B/C:
их запуск требует отдельного решения.

## 1. Объём

| Волна | Что | Ключевые файлы |
|---|---|---|
| W1 | Документ композиции v2: discriminated union по `version`, `atomicLevel`/`scope`/`canonicalFor`/`ownership`/`replacement`, право на вложенность | `src/prototype/composition.ts` |
| W1 | Раскрытие v2: depth-first, глубина 5, полный путь цикла, бюджеты раскрытого дерева (500/50), `expandedFrom.chain` | `src/prototype/composition.ts`, `server/validation.ts` |
| W2 | Манифест замыкания публикации + хеш, транзитивные пины прототипа, статусы всех пинов в `classifyRevision` | `server/repos/compositions.ts`, `server/routes/compositions.ts`, `server/classify.ts` |
| W2 | Миграция v21: колонки манифеста, `catalog_replacements`, `catalog_migration_runs/staging`, `atomic_policy`, `maintenance_locks`, триггеры retired-DS для композиций | `server/migrations.ts` |
| W3 | Атомарная политика: граница активации из БД, `422 atomic_policy_violation` для новых TSX-молекул/организмов без `ownership.reason` | `server/atomicPolicy.ts`, `server/routes/components.ts` |
| W4 | Аудит каталога → детерминированный план миграции, выбор канона, адаптеры с отказами, идемпотентный хеш плана | `server/catalog/audit.ts`, `server/catalog/migrationPlan.ts`, `server/catalog/adapters.ts` |
| W4 | Runner: prepare/apply/backup/restore, maintenance-lock, `503` на мутациях, админский роут | `server/migrationRunner.ts`, `server/maintenance.ts`, `server/routes/catalogMigrations.ts`, `server/main.ts` |
| W5 | Приёмка: доки, e2e, устранение дефектов приёмки | `docs/prototype-format.md`, `docs/server-api.md`, `e2e/dev/composition-v2.spec.ts` |

## 2. Дефекты, найденные приёмкой (волна 5)

1. **Бэкап cutover жил только в памяти процесса.** `applyMigration` клал образ в
   `inProcessBackups`, а HTTP-роут не передавал путь; `getCatalogBackup` не имел дискового
   фолбэка. После рестарта или редеплоя откат применённой продовой миграции через API был бы
   невозможен — прямое нарушение §10 спеки. Исправлено: образ пишется в
   `DATA_DIR/catalog-migrations/<backupId>.sqlite` + sidecar с `sha256`/`bytes`/`createdAt`,
   `getCatalogBackup(id, dataDir)` и `restoreCatalogBackup(..., {dataDir})` читают его, ответ
   `apply` отдаёт `backupId`. Покрыто тестом с эмуляцией рестарта (`evictCatalogBackupCache`).
2. **Атомарная политика ломала провижининг e2e.** `StarterStack` (`atomicLevel: "molecule"`) и
   пять организмов `library-preview.fixture.ts` публиковались без `ownership.reason`, поэтому
   весь `npm run e2e` падал на setup-проекте. На ветке e2e ни разу не запускался. Исправлено
   заполнением `ownership.reason` — по назначению, а не понижением уровня.
3. **Незакоммиченный мусор ронял lint**: временные каталоги `mkdtemp` серверных тестов и
   раздаточный `share/`. `share` и глоб `.*-test-*` внесены в игнор eslint.
4. **Документация отставала от кода**: формат прототипа утверждал «nesting rejected in v1» без
   раздела v2, а `docs/server-api.md` не знал ни про манифест замыкания, ни про атомарную
   политику, ни про maintenance-lock, ни про пять эндпоинтов миграции. Дописано.

## 3. Соответствие тест-стратегии спеки §11

| Требование спеки | Где |
|---|---|
| Поведение и хеши v1 не изменились | `server/composition-v2.test.ts`, существующие `composition.test.ts` |
| Вложенные параметры, слоты через два уровня | `src/prototype/__tests__/composition-v2.test.ts`, e2e |
| Стабильные раскрытые ключи и цепочка происхождения | `src/prototype/__tests__/composition-v2.test.ts` |
| Одна дизайн-система, путь цикла, глубина 5 против 6 | `server/composition-v2.test.ts`, e2e (цикл) |
| Бюджеты раскрытых элементов и глубины дерева | `src/prototype/__tests__/composition-v2.test.ts` |
| Точные прямые и транзитивные пины; старые версии стабильны после републикации | `server/composition-v2.test.ts`, e2e |
| Атомарная политика: атом, новая молекула без причины, легаси-бэкфилл | `server/components.test.ts`, `server/atomicPolicy` через publish-путь |
| Выбор канона, группировка, адаптеры, идемпотентность хеша плана | `server/catalog/migrationPlan.test.ts`, `server/catalog/adapters.test.ts`, `server/catalog/audit.test.ts` |
| Устаревший отпечаток, конкурентная голова, откат, нулевое использование до soft-delete | `server/migrationRunner.test.ts` |
| E2E: агент собирает молекулу из атомов и организм из молекулы; сохранение пинует замыкание; неизменяемая версия рендерит старые пины | `e2e/dev/composition-v2.spec.ts` |

Не покрыто локально и намеренно перенесено в продовые стадии: сравнение визуальных эталонов
до/после cutover (§9) и итоговый отчёт (§12) — им нужен реальный каталог.

## 4. Журнал приёмки (2026-07-31)

- `npm run verify` — зелёный целиком (typecheck, server:typecheck, lint, 1059 vitest, 559 server-тестов, templates, openapi-drift, sdk, build, css-гейт).
- `npm run e2e` — зелёный (см. финальный прогон ниже).
- Дефекты 1–4 §2 закрыты в этой же волне.

## 5. Что осталось

Продовая дедупликация (§8 спеки) отдельными стадиями, каждая — по явному решению:

- **A**: read-only аудит прода (`GET /api/catalog/migrations/audit`), разбор плана, материализация
  и валидация кандидатов в изолированном клоне прод-данных, визуальные эталоны до cutover.
- **B**: защищённый cutover (`prepare` → `apply`) с maintenance-lock и удержанным бэкапом.
- **C**: пост-проверка: ноль использований отставленных id в головах, render-status изменённых
  экранов, повторные снимки, рендер выборки неизменяемых версий, read-only смоук и отчёт §12.

Порядок деплоя из зонта соблюдён: жёсткий гейт (проект 2) уже в проде до дедупликации.
