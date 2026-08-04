# План: подготовка easy-ui к первому публичному релизу в компании (release readiness)

## Контекст

Сервис easy-ui готовится к первому публичному релизу внутри компании (Яндекс): внешнее code review и заезд во внутреннюю инфраструктуру. Проведён аудит тремя агентами (гигиена репо, качество кода/тестов, переносимость инфры). Решения пользователя:

- **Язык — русский остаётся** (ревью внутри русскоязычной компании); унифицируем только смешанные файлы точечно, перевод не делаем.
- **Публикация «свежим стартом»**: во внутренний git уезжает squash-нового репо/orphan-ветка с чистой историей; текущий репо остаётся личным архивом. Это снимает проблемы истории (25 МБ блобов `server/openapi.json`, прод-домен, composeId в старых коммитах).
- **Два плана**: этот — гигиена репо + блокеры ревью + подготовка публикации. Хардненинг под внутреннюю инфру (non-root, секреты, метрики, rate limiting, Deploy/RTC-специфика) — отдельный план после этого (§W8 — только его скелет).
- Целевая инфра — внутренняя яндексовая; публичных деталей нет, допущения фиксируем в плане как «проверить по внутренним докам».

Ключевые находки аудита, на которых стоит план: живой `DOKPLOY_API_KEY` и пароль в локальном `.env` (не в гите, но засвечены); README отстал на 255 коммитов; `LICENSE`/`license`-поля нет; 3 дубля PRODUCT_IMPROVEMENTS; `.dockerignore` пропускает в образ `.backups/` (594 МБ прод-данных), `Шрифты.zip`, `share/`; мёртвый код (`src/catalog/events.ts`, ~14 функций `src/api/client.ts`, флаг `EASYUI_CAPTURE_CACHE`); незарегистрированная ручка `TODO(T9)`; deprecated `BASIC_AUTH`; 11 русских строк мимо словаря; `retries: 0` + `trace: on-first-retry`; corpus-гейт возможно non-gating (`--bootstrap`).

## Волны работ

### W0 — Ротация секретов (немедленно, вне репо; делает пользователь)
- Ротировать `DOKPLOY_API_KEY` (в Dokploy UI) и пароль пользователя `vlad` на проде: оба значения из `/home/coder/project/.env` засвечивались в агентских контекстах.
- После ротации обновить локальный `.env` и секрет `DOKPLOY_API_KEY` в GitHub Actions.

### W1 — Лицензии и обязательные файлы
- Проверить статус шрифтов `public/fonts/` (YS Text/YS Compressed — брендовые шрифты Яндекса, Coil): для внутрияндексового репо использование почти наверняка легально — **подтвердить по внутренним правилам бренда** и добавить `public/fonts/README.md` с указанием источника и условий. `Шрифты.zip` из рабочей копии удалить (он и так gitignored).
- Добавить `LICENSE`-заглушку «Proprietary / internal use only» (или внутрияндексовый стандарт, уточнить при заезде) + `package.json`: `"license": "UNLICENSED"`, заполнить `description`, поднять `version` до `1.0.0`.
- Добавить `SECURITY.md` (модель доверия: RCE by design, все аккаунты — доверенные операторы; ссылка на `docs/server-api.md` §«Граница доверия»), `CONTRIBUTING.md` (запуск, verify-контур, политика авторинга), `CODEOWNERS`-заготовку.

### W2 — Чистка дерева репозитория
- Удалить untracked-дубли: `docs/EASYUI_PRODUCT_IMPROVEMENTS.md`, `docs/audit/EASYUI_PRODUCT_IMPROVEMENTS.md` (канон остаётся `docs/easy-ui-product-improvements-v2.md`; если в untracked-версиях есть новый контент от 2026-08-03 — влить его в канон одним файлом).
- `docs/`: создать `docs/README.md`-оглавление; вынести машинные артефакты (`docs/audit/*.json` — 4 файла, включая 272 КБ `audit-merged.json`) и `docs/feedback 2/` (каталог с пробелом + zip в гите) из будущей публикации; `docs/plans/` (49 файлов) и `docs/superpowers/` — оставить (внутренний репо, русский ок), но пометить в оглавлении как исторические.
- `share/`: удалить `*.tgz` из гита (генерировать `scripts/sync-share-skills.mjs` по требованию); подключить `sync-share-skills --check` к `npm run verify`, чтобы зеркала не разъезжались.
- Удалить `claude-here.sh`, `codex-here.sh` из будущей публикации (локальные обёртки с захардкоженным путём машины).
- `.gitignore`: добавить `.superpowers/`, `*.db`, `*.db-wal`, `*.db-shm`, `*.pem`, `*.key`, `.env.local`; заменить четыре ad-hoc правила на `.*-data/`; правило `Шрифты.zip` → `*.zip` не делаем (в share/ zip больше не будет — достаточно текущего).
- `.dockerignore` (важно: это дефект текущего образа): добавить `.backups/`, `work/`, `share/`, `e2e/`, `Шрифты.zip`, `.w0-data/`, `.w6-data/`, `.measure-data/`, `.superpowers/`, `docs/` уже есть — проверить полноту. Прогнать сборку образа и сравнить размер до/после.

### W3 — Документация для нового читателя
- Переписать `README.md` (сейчас отстал на 255 коммитов): что это, архитектура (SPA + Bun server + SQLite, screenshot/acceptance-контур), quick start (npm install, dev, verify), docker-запуск, полная таблица npm-скриптов, ссылки на `docs/server-api.md`, `docs/prototype-format.md`, `docs/authoring-sdk.md`, установка Bun (вместо «должен лежать в ~/.bun/bin»).
- Создать `docs/operations.md` — единый реестр env-переменных (сейчас разъезжаются `.env.example`, compose и `docs/server-api.md`): все серверные переменные из аудита (§2 инфра-отчёта), полярность флагов (`*_DISABLED` = включено по умолчанию), какие обязательны, дефолты; раздел «данные и бэкапы» (SQLite + WAL как единица, `DATA_DIR` обязан быть внутри корня — причина: резолв `node_modules` для материализованного TSX; forward-only миграции и rollback-window ограничения).
- Дополнить `.env.example` до полного набора переменных.
- `docs/server-api.md` (408 КБ) — не разбиваем в этой волне (генерируемо-связанный, риск高), только добавляем в оглавление docs/README.md.

### W4 — Код: снятие замечаний будущего ревью
Мелкие, но заметные ревьюеру вещи; каждая — атомарный коммит:
- Удалить мёртвое: `src/catalog/events.ts` (файл целиком), неиспользуемые функции `src/api/client.ts` (`createPrototype`, `deletePrototype`, `repinPrototype`, `saveComposition`, `deleteComposition`, `listCompositionRevisions`, `listCompositionVersions`, `getCompositionVersion`, `getCapabilities`, `getCatalogUsages`, `getComponentUsageTree`, `createDesignSystem`, `patchDesignSystemTheme`, `setComponentVersionStatus`), одиночные мёртвые экспорты (`loadPrototypeList`, `listAssetsPage`, `enqueuePrototypeGeometry`, `createPrototypeId`, `idfWeight`, `surfaceById`, `mergeCaptureCodes`, `legacyDesignSystemSpacingScales`) — перед удалением каждый перепроверить grep'ом (динамические обращения).
- Закрыть `TODO(T9)`: зарегистрировать ручку из `server/routes/components.ts:401` в `server/contracts.ts` → перегенерировать OpenAPI/SDK (`npm run generate:openapi && generate:sdk`).
- Удалить deprecated-алиас `BASIC_AUTH` (`server/main.ts:106-109`) и устаревший комментарий `EASYUI_BASIC_AUTH` в `scripts/rebaseline-all.mjs:45`; в docs — только `LEGACY_BASIC_AUTH`.
- Убрать мёртвый `EASYUI_CAPTURE_CACHE` из `docker-compose.yml:48` (не читается нигде; волна R9b не реализована — оставить упоминание только в плане renderer-contract-2).
- Русские строки мимо словаря → `src/app/strings/`: `src/auth/UsersPage.tsx` (9 строк), `src/auth/LoginPage.tsx:39`, `src/editor/EditorCanvas.tsx:270`.
- `src/player/ScreenSurface.tsx:423` — обернуть `console.warn` в `import.meta.env.DEV`.
- `playwright.config.ts`: включить `retries: 1` в CI (иначе `trace: "on-first-retry"` никогда не срабатывает и падения e2e в CI остаются без артефактов) — либо осознанно `trace: "retain-on-failure"` при `retries: 0`; выбрать при реализации, зафиксировать комментарием.
- `package.json`: убрать дубль `build:app`, добавить `packageManager`, отразить Bun-версию в README (engines Bun не поддерживает).
- eslint: включить `typescript-eslint.recommendedTypeChecked` (projectService уже настроен); прогнать, точечно поправить/задокументировать подавления. Если находок слишком много (>50) — зафиксировать в плане хардненинга, не блокировать релиз.
- Test-only легаси-рантайм встроенных ДС (`__EUI_LEGACY_TEST_RUNTIME__` ветки в `src/catalog/runtime.ts:49`, `src/prototype/validate.ts:384`, `src/editor/EditorView.tsx:70`) — не трогаем (живые тесты на нём), но добавить общий комментарий-указатель, почему ветки существуют.

### W5 — CI/деплой: подготовка к переезду
- `.github/workflows/build-image.yml`: вынести `composeId` в `vars`/`secrets`, `IMAGE` — в repo variable; job `deploy` пометить комментарием как Dokploy-специфичный (уйдёт при переезде).
- `ci.yml`: добавить `concurrency`-группу и `timeout-minutes`.
- Проверить, заармлен ли renderer-corpus гейт (сейчас `--bootstrap` = non-gating, warning в воркфлоу): если нет — прогнать процедуру `--adopt` и вмерджить запись в `expected.json`, иначе «пиксельный гейт» декоративен.
- `docker-compose.yml`: добавить `shm_size: 1g` (CI-гейт гоняет образ с `--shm-size=1g`, прод сейчас конфигурационно слабее протестированного).
- Написать `docs/deploy-contract.md`: что должен уметь любой CD (собрать образ с `EASYUI_BUILD_SHA`, corpus-гейт перед промоушеном тега, обязательные env, healthcheck-семантика `status: ready`, запрет сборки на прод-хосте). Это вход для плана-2 переезда на внутренний CD.

### W6 — Публикация «свежим стартом»
- Собрать чек-лист исключений публикации (из W2): `.claude/` (скиллы с прод-URL и деплой-инструкциями — решить: вычистить URL или не публиковать каталог; рекомендация — не публиковать `.claude/skills/deploy`, остальные скиллы очистить от прод-дефолтов), `claude-here.sh`, `codex-here.sh`, `docs/audit/*.json`, `docs/feedback 2/`, `docker-compose.candidate.yml` (или оставить с русским комментарием — он легитимный drill-инструмент).
- Процедура: свежий клон → применить чек-лист → `git checkout --orphan release` → один initial-коммит «easy-ui v1.0.0» → push во внутренний git (адрес получим при заезде). Прод-домен `easy-ui.pay-offline.ru` в рабочих файлах (`.env.example`, скрипты, скиллы) заменить на плейсхолдер/переменную до публикации.
- `server/openapi.json` (1.4 МБ, генерируемый): оставить в гите нового репо (один блоб на публикацию не страшен), но зафиксировать в CONTRIBUTING политику «коммитится только вместе с изменением контрактов» — вопрос генерации в CI отложить в план-2.

### W7 — Верификация
- `npm run verify` + `npm run e2e` зелёные после каждой волны (W4 — обязательно).
- Пересборка docker-образа после W2: размер уменьшился, `.backups`/`Шрифты.zip`/`share` в слоях отсутствуют (`docker history` / распаковка слоя).
- Runtime-прогон по `.claude/skills/verify/SKILL.md` после W4.
- Финальный смоук чистого клона: свежий `git clone` (эмуляция публикации) → `npm ci` → `npm run verify` → `docker build` — всё проходит без файлов, существующих только в рабочей копии.
- Прод не трогаем: волны W1–W6 не меняют поведение сервера (кроме `shm_size` и удаления мёртвого env — безопасно); деплой обычным пайплайном после мерджа.

### W8 — Скелет плана-2 (хардненинг, отдельный план — здесь не исполняется)
Зафиксировать как backlog для следующего планирования, когда появятся требования внутренней инфры: non-root контейнер + chromium-sandbox стратегия; секреты через файлы/`*_FILE` (Yav-подобный secret-store); structured-логи + метрики (Solomon/Monitoring-подобное) + request-id; rate limiting за балансировщиком (реальный IP из заголовков доверенного прокси); `e2e/preview/screenshot.spec.ts:134` `test.fixme` — adversarial egress-тест; замена GitHub Actions → внутренний CI/CD (реестр, промоушен тега, corpus-артефакты); декомпозиция `server/contracts.ts` (2914 строк); автоматический бэкап volume; допущения об Аркадии/Deploy/RTC/TVM проверить по внутренним докам — публично они не описаны.

## Исполнение (по workflow проекта)

1. После одобрения — сохранить план в `docs/plans/2026-08-04-release-readiness.md`, закоммитить.
2. Stage 2 — адверсариальное ревью плана Opus-субагентами (линзы: полнота чек-листа публикации, риски удаления «мёртвого» кода, корректность docker/CI-правок), триаж в план.
3. Stage 3 — волны W1–W6 отдельными Opus-субагентами с файловым ownership (W2 и W4 не пересекаются — параллелить; W3 после W2; W5/W6 последними), оркестратор верифицирует и коммитит поволново.

## Критерии готовности

- Секреты ротированы (W0, подтверждение пользователя).
- Чистый клон проходит `npm ci && npm run verify && npm run e2e && docker build`.
- Образ не содержит прод-данных/шрифтового архива/share.
- README/docs/README/operations.md актуальны; env-реестр полон.
- Ноль untracked-дублей, мёртвый код удалён, TODO(T9) закрыт, corpus-гейт заармлен (или явно задокументирован как non-gating).
- Готов чек-лист и процедура orphan-публикации; план-2 (хардненинг) заведён как backlog.
