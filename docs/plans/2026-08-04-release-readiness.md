# План: подготовка easy-ui к первому публичному релизу в компании (release readiness)

**Статус:** v2 — прошёл Stage 2 (адверсариальное ревью двумя Opus-агентами, триаж в конце файла).

## Контекст

Сервис easy-ui готовится к первому публичному релизу внутри компании (Яндекс): внешнее code review и заезд во внутреннюю инфраструктуру. Проведён аудит тремя агентами (гигиена репо, качество кода/тестов, переносимость инфры). Решения пользователя:

- **Язык — русский остаётся**; унифицируем смешанные файлы точечно, перевод не делаем.
- **Публикация «свежим стартом»**: во внутренний git уезжает дерево с одной чистой историей; текущий репо остаётся личным архивом. Снимает проблемы истории (25 МБ блобов `server/openapi.json`, прод-домен, composeId в старых коммитах).
- **Два плана**: этот — гигиена репо + блокеры ревью + подготовка публикации. Хардненинг под внутреннюю инфру — отдельный план-2 (§W8 — скелет/backlog).
- Целевая инфра — внутренняя яндексовая; публичных деталей нет, допущения — «проверить по внутренним докам».

## Сквозные решения (после ревью)

- **Запрещённые регэкспы** — главный механизм чистки вместо ручных списков: `pay-offline\.ru`, `dokploy`, `vladprrs`, `CWXPcz6h`, `DOKPLOY_API_KEY`, `@gmail\.com`, `651559498`. Grep по ним — пре-пуш гейт публикации и критерий готовности (0 совпадений в публикуемом дереве). Сейчас след — 38 трекаемых файлов.
- **File ownership**: все правки `package.json` и `docker-compose.yml` принадлежат волне W4 (даже если по смыслу относятся к W1/W2/W5) — иначе волны конфликтуют.
- **Порядок и corpus**: любые изменения, влияющие на образ/шрифты, завершаются ДО армирования corpus-гейта (W5-финал): смена шрифтов/базы инвалидирует отпечаток рендерера.
- **`.claude/` публикуется**, кроме `.claude/skills/deploy/` (Dokploy-only, содержит прод-URL и composeId). Причина не выкидывать целиком: `scripts/sync-share-skills.mjs` читает канон из `.claude/skills/author/` без guard'ов. Остальные скиллы санитизируются от прод-дефолтов; ссылки на deploy-скилл (`CLAUDE.md`, `AGENTS.md`, `docs/plans/2026-07-29-scrn-gallery-ux.md:190`) заменяются на `docs/deploy-contract.md`; после — `grep -rn "skills/deploy"` = 0.
- **`share/*.tgz` остаются в гите** (236 КБ суммарно — шум): `sync-share-skills.mjs --check` падает при отсутствии архива, а переделка скрипта не окупается. `--check` подключается к `npm run verify`.

## Волны работ

### W0 — Ротация секретов (немедленно, вне репо; делает пользователь)
- Ротировать `DOKPLOY_API_KEY` (Dokploy UI) и пароль пользователя `vlad` на проде — оба значения из локального `.env` засвечивались в агентских контекстах.
- Обновить локальный `.env` и секрет `DOKPLOY_API_KEY` в GitHub Actions.
- После публикации во внутренний git — отдельно: судьба GHCR-пакета, Actions-секретов и PAT личного репо (архивация/отзыв).

### W1 — Лицензии и обязательные файлы
- Шрифты `public/fonts/` — **считать блокером до подтверждения**: в гите исходные OTF (`Coil-*.otf`), собственный `.gitignore` заявляет «лицензия Commercial Type — в репозиторий не кладём», файлы раздаются публично. Подтвердить право внутрияндексового использования (YS Text/YS Compressed — брендовые шрифты Яндекса, скорее всего ок); добавить `public/fonts/README.md` с источником и условиями. План Б: woff2-сабсет/системный фолбэк — тогда обязательно ДО армирования corpus (см. сквозные решения). `Шрифты.zip` из рабочей копии удалить.
- `LICENSE` «Proprietary / internal use only» (внутрияндексовый стандарт уточнить при заезде). Поля `package.json` (license/description/version 1.0.0, сохранить `private: true`) — руками волны W4.
- `SECURITY.md`: модель доверия (RCE by design, все аккаунты — доверенные операторы, ссылка на `docs/server-api.md` §«Граница доверия») + раздел про заведомо тестовые пароли в репо (`easy-ui-dev-password`, `corpus-admin-password`, `e2e-admin-password`, `measure-*`) — чтобы снять гарантированные вопросы ревью.
- `CONTRIBUTING.md` (запуск, verify-контур, политика авторинга, политика коммита `server/openapi.json` — только вместе с изменением контрактов), `CHANGELOG.md` (запись 1.0.0). `CODEOWNERS` — только с реальными владельцами; если их нет — не добавлять (заготовка с плейсхолдерами сама по себе замечание ревью).
- Инвентаризация лицензий npm-зависимостей: license-checker → `docs/third-party.md`; отметить `@json-render/*` 0.19.0 (vercel-labs) как ключевую стороннюю зависимость.

### W2 — Чистка дерева репозитория
- Удалить untracked-дубли `docs/EASYUI_PRODUCT_IMPROVEMENTS.md` и `docs/audit/EASYUI_PRODUCT_IMPROVEMENTS.md` (канон — `docs/easy-ui-product-improvements-v2.md`; новый контент от 2026-08-03 влить в канон).
- `docs/`: создать `docs/README.md`-оглавление; удалить машинные `docs/audit/*.json` (4 файла; ссылок из кода нет — проверено) и `docs/feedback 2/` (каталог с пробелом + zip). **`docs/audit/*.md` НЕ трогать** — на них ссылаются `server/catalog/roles.json:47,54`, `server/catalog/fingerprint.ts:214`, `policy.ts:55`, тесты и `scripts/calibrate-matcher.ts`. `docs/plans/` остаются, но: `2026-07-11-dokploy-deploy.md` санитизировать или исключить из публикации (содержит `BASIC_AUTH=vlad:<пароль>` и 20 вхождений домена); остальные планы пройдут через regex-гейт W6.
- Удалить `claude-here.sh`, `codex-here.sh` (локальные обёртки, ссылок ниоткуда нет).
- `.gitignore`: добавить `.superpowers/`, `.perf-verify/`, `*.zip` (кроме уже трекаемого — share-tgz это `.tgz`), `*.db`, `*.db-wal`, `*.db-shm`, `*.pem`, `*.key`; заменить `.w0-data/`/`.w6-data/`/`.measure-data/` на `.*-data/` (`data/` остаётся отдельным правилом). `.env.local` не нужен — уже покрыт `.env.*`.
- `.dockerignore`: добавить `.backups`, `work`, `share`, `e2e`, `test`, `test-results`, `Шрифты.zip`, `.w0-data`, `.w6-data`, `.measure-data`, `.superpowers`, `.perf-verify`. **Синтаксис — без `**/` (root-anchored)**: паттерн `**/share` выкинул бы живой `server/share/`. Безопасность проверена: corpus читает `e2e/fixtures` с чекаута раннера, не из образа. Сборка образа до/после — зафиксировать размеры.
- `public/design/cjm-ui/assets/*` НЕ удалять (используются e2e).

### W3 — Документация для нового читателя
- Переписать `README.md` (отстал на 255 коммитов): что это, архитектура (SPA + Bun server + SQLite, screenshot/acceptance-контур), quick start (npm install, установка Bun по `.bun-version`, `npx playwright install --with-deps chromium`), docker-запуск, полная таблица npm-скриптов, ссылки на ключевые доки.
- `docs/operations.md` — единый реестр env-переменных (compose/.env.example/server-api сейчас расходятся): все серверные переменные, полярность флагов (`*_DISABLED` = включено по умолчанию, `EASYUI_RENDERER_STRICT_MANIFEST` — `!== "0"`), обязательность, дефолты; раздел «данные и бэкапы» (SQLite+WAL как единица; `DATA_DIR` обязан быть внутри корня — резолв `node_modules` для материализованного TSX; forward-only миграции, rollback-window ограничения).
- Дополнить `.env.example` до полного набора.
- Прогнать линтер markdown-ссылок после чисток W2 (ссылки поедут гарантированно).
- `docs/server-api.md` (408 КБ) в этой волне не разбиваем.

### W4 — Код: снятие замечаний будущего ревью (владеет `package.json`, `docker-compose.yml`)
- **Мёртвый код — раздельно**:
  - удалить: `src/catalog/events.ts` (подтверждено, потребителей нет), 14 функций `src/api/client.ts` (подтверждены по 1 вхождению, барrelей нет, тесты мокают через `importOriginal()`-спред), `loadPrototypeList`, `enqueuePrototypeGeometry`, `createPrototypeId`;
  - **снять `export`, НЕ удалять** (используются внутри своих модулей): `listAssetsPage` (`src/api/assetsApi.ts:73`), `idfWeight` (`src/library/text.ts:55`), `surfaceById` (`src/prototype/surfaces.ts:59,86`), `mergeCaptureCodes` (`src/capture/readiness.ts:578`), `legacyDesignSystemSpacingScales` (`src/designSystems/spacingScale.ts:32`).
- TODO(T9): ручка **уже зарегистрирована** (`server/contracts.ts:1981-1989`, есть в openapi.json) — удалить протухший комментарий `server/routes/components.ts:401`, опционально добавить кейс в `contract.test.ts`. Регенерация не нужна; второй дескриптор не создавать.
- Удалить deprecated-алиас `BASIC_AUTH`: `server/main.ts:106-109` + переписать ассерты `server/auth.test.ts:139-143` + убрать проброс `docker-compose.yml:14` + комментарий в `.env.example` + `EASYUI_BASIC_AUTH` в `scripts/rebaseline-all.mjs:45`. Перед удалением проверить env compose в Dokploy (переменная снята с прода 2026-07-20, но убедиться, что не выставлена).
- Убрать мёртвый `EASYUI_CAPTURE_CACHE` из `docker-compose.yml:48` (подтверждено: не читается нигде).
- Русские строки мимо словаря → `src/app/strings/`: `src/auth/UsersPage.tsx` (9), `src/auth/LoginPage.tsx:39`, `src/editor/EditorCanvas.tsx:270`.
- `src/player/ScreenSurface.tsx:423` — `console.warn` под `import.meta.env.DEV`.
- `playwright.config.ts`: **`trace: "retain-on-failure"` при `retries: 0`** (решено; `retries: 1` опасен — stateful-серверы с общими `.e2e-data` не переподнимаются на ретрае, зелёный со второй попытки маскировал бы порядковую зависимость).
- `package.json`: убрать дубль `build:app`, добавить `packageManager`, поля license/description/version из W1, `verify` += `sync-share-skills --check`.
- `docker-compose.yml`: += `shm_size: 1g` (из W5; CI-гейт гоняет образ с `--shm-size=1g`, прод конфигурационно слабее протестированного).
- Комментарий-указатель к test-only легаси-рантаймам `__EUI_LEGACY_TEST_RUNTIME__` (`src/catalog/runtime.ts:49`, `src/prototype/validate.ts:384`, `src/editor/EditorView.tsx:70`) — сами ветки не трогать.
- ~~eslint recommendedTypeChecked~~ — перенесено в план-2 (оценка: сотни-тысячи диагностик, typed-режим на `*.mjs` требует `disableTypeChecked`-блока; не блокер релиза).

### W5 — CI/деплой: подготовка к переезду
- `.github/workflows/build-image.yml`: вынести в repo `vars` **и composeId, и хост dokploy** (`https://dokploy.pay-offline.ru`); `IMAGE` — repo variable (шаги deploy читают `$IMAGE` из env — сохранить проброс). Job `deploy` пометить как Dokploy-специфичный. **В публикуемом дереве (W6) job `deploy` удаляется целиком** — семантика переезжает в `docs/deploy-contract.md`.
- `ci.yml`: `concurrency`-группа, `timeout-minutes`, ограничение push-триггера ветками (`main`) — сейчас полный verify+e2e на каждый push любой ветки дублируется с PR-прогоном.
- `docs/deploy-contract.md`: что должен уметь любой CD — сборка с `EASYUI_BUILD_SHA`, corpus-гейт перед промоушеном тега, **бамп образа/шрифтов = обязательный re-adopt corpus** (отпечаток привязан к образу — иначе гейт снова декоративен), обязательные env, healthcheck-семантика `status: ready`, запрет сборки на прод-хосте.
- **Армирование corpus-гейта — последним шагом всех волн** (после решения по шрифтам W1 и правок образа W2/W4): взять артефакт `renderer-corpus-<sha>` последнего main-прогона (PR-прогоны truncated — не адоптятся без `--force`), `--adopt`, коммит `e2e/fixtures/renderer-corpus/expected.json`; после армирования рассмотреть перевод bootstrap-`::warning::` в failure.

### W6 — Публикация «свежим стартом»
- **Процедура (не orphan!):** `git checkout --orphan` сохраняет старый объектный граф — риск утечки всей истории одним `push --mirror`. Вместо этого: копия рабочего дерева → применить чек-лист исключений → `rm -rf .git && git init` → корпоративные `user.name`/`user.email` → один initial-коммит «easy-ui v1.0.0» → push строго `git push <remote> HEAD:main` (без `--all/--mirror/--tags`).
- Чек-лист исключений: `.claude/skills/deploy/`, `claude-here.sh`, `codex-here.sh`, `docs/audit/*.json`, `docs/feedback 2/`, `docs/plans/2026-07-11-dokploy-deploy.md` (если не санитизирован), job `deploy` из `build-image.yml`. `docker-compose.candidate.yml` остаётся (легитимный drill-инструмент) после regex-чистки. `AGENTS.md`/`CLAUDE.md` публикуются санитизированными (домен → плейсхолдер, deploy-разделы → ссылка на `docs/deploy-contract.md`).
- **Пре-пуш гейты (обязательные):**
  1. grep по запрещённым регэкспам (см. сквозные решения) = 0 совпадений;
  2. gitleaks (или git-secrets) по дереву = чисто;
  3. `git log --all --oneline | wc -l` = 1, `git rev-list --all --objects | wc -l` — только текущее дерево;
  4. `npm audit --omit=dev` — зафиксировать результат.
- Прод-домен в рабочих файлах (`.env.example`, скрипты, скиллы, доки — полный список даёт regex-гейт, 38 файлов) → плейсхолдер `https://easy-ui.example.internal` / переменная.
- `server/openapi.json` остаётся в гите нового репо (один блоб на публикацию), политика коммита — в CONTRIBUTING (W1).

### W7 — Верификация
- `npm run verify` + `npm run e2e` зелёные после каждой волны; руками прогнать `node scripts/sync-share-skills.mjs --check` до коммита W4.
- Пересборка docker-образа после W2: зафиксировать «transferring context» и `docker image inspect .Size` до/после; распаковкой слоя убедиться, что `.backups`/`Шрифты.zip`/`share`/`e2e` отсутствуют.
- Runtime-прогон по `.claude/skills/verify/SKILL.md` после W4.
- Финальный смоук чистого клона (предусловия: Bun по `.bun-version`, `npx playwright install --with-deps chromium`): `npm ci` → `npm run verify` → `npm run e2e` → `docker build`.
- Прод: волны меняют поведение минимально (`shm_size`, снятие мёртвых env, удаление алиаса `BASIC_AUTH` — предварительно проверив env в Dokploy); деплой обычным пайплайном после мерджа.

### W8 — Скелет плана-2 (хардненинг + заезд, отдельный план)
Backlog: non-root контейнер + chromium-sandbox стратегия; секреты через файлы/`*_FILE` (Yav-подобный store); structured-логи + метрики + request-id; rate limiting за балансировщиком (реальный IP от доверенного прокси); adversarial egress-тест (`e2e/preview/screenshot.spec.ts:134` `test.fixme`); замена GitHub Actions → внутренний CI/CD (реестр, промоушен тега, corpus-артефакты); **сборка без публичных CDN**: `playwright install` качает браузер с внешнего CDN, Bun — из Docker Hub, npm — публичный (нужны внутренние зеркала — первоочередной вопрос заезда); доступность Bun как рантайма во внутренней инфре; eslint `recommendedTypeChecked` (точечно: `no-floating-promises`, `no-misused-promises`, `await-thenable` + `disableTypeChecked` для js/mjs); декомпозиция `server/contracts.ts` (2914 строк); автоматический бэкап volume; генерация `server/openapi.json` в CI вместо коммита; допущения об Аркадии/Deploy/RTC/TVM — проверить по внутренним докам.

## Исполнение

1. ~~Сохранить план, закоммитить~~ — сделано (b2e0552; v2 — этот файл).
2. ~~Stage 2 ревью~~ — сделано, триаж ниже.
3. Stage 3 — Opus-субагенты по волнам. Порядок: W1(доки)+W2 → W3 ∥ W4 → W5 → corpus-арм → W6-подготовка (без push — ждёт адреса внутреннего git). `package.json`/`docker-compose.yml` — только W4. Оркестратор верифицирует и коммитит поволново.

## Критерии готовности

- Секреты ротированы (W0, подтверждение пользователя); судьба GHCR/Actions-секретов личного репо решена.
- Чистый клон (с предусловиями Bun+playwright) проходит `npm ci && npm run verify && npm run e2e && docker build`.
- Размер образа зафиксирован до/после; прод-данных/шрифтового архива/share/e2e в слоях нет (проверено распаковкой).
- **0 совпадений запрещённых регэкспов + чистый gitleaks в публикуемом дереве** (главный критерий).
- README/docs/README/operations.md актуальны; markdown-ссылки прогнаны линтером; env-реестр полон.
- Мёртвый код удалён/разэкспортирован, протухший TODO(T9)-комментарий снят, corpus-гейт заармлен (адопт с main-артефакта) или явно задокументирован как non-gating.
- Готова процедура fresh-start публикации (`git init`, пре-пуш гейты); план-2 заведён как backlog.

## Триаж находок Stage 2

Ревьюер A (корректность): B1 TODO(T9) уже зарегистрирован — **принято**, пункт переписан. B2 tgz vs `--check` — **принято**, tgz остаются. B3 5/8 экспортов живые — **принято**, раздельные списки. M1 BASIC_AUTH — полный список файлов + проверка Dokploy env — **принято**. M2 eslint typed → план-2 — **принято**. M3 ownership `package.json`/compose → W4 — **принято**. M4 corpus re-adopt при бампах + порядок — **принято**. M5 полный след домена → regex-гейт — **принято**. m1–m9 (dockerignore root-anchored, `.perf-verify`, `*.zip`, retain-on-failure, ci.yml ветки, dokploy-хост в vars, предусловия клона) — **приняты**.

Ревьюер B (полнота): B1 = A/B2. B2 `.claude/` публикуется кроме deploy (sync-share зависимость) — **принято**. B3 regex-список + корпоративная git-идентичность — **принято**. B4 шрифты = блокер + связка с corpus — **принято**. M1 job deploy удалить из публикации — **принято**. M2 портируемость (CDN/Bun/npm-зеркала — в W8; лицензии зависимостей — в W1) — **принято**. M3 CHANGELOG / реальный CODEOWNERS / `private: true` — **принято**. M4 gitleaks + npm audit — **принято**. M5 не-orphan процедура — **принято**. M6 санитизация `docs/plans/2026-07-11-dokploy-deploy.md` — **принято**. M7 AGENTS/CLAUDE.md санитизировать и публиковать — **принято**. m1 `docs/audit/*.md` и cjm-ui assets не трогать — **принято**. Отклонённых находок нет.
