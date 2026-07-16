# План v2: мультиюзерность + полный отказ от встроенных компонентов

## Контекст

easy-ui сейчас — однопользовательский инстанс за одним общим Basic Auth: в БД нет ни пользователей, ни владельцев, ни видимости (колонки `author` мертвы, «статусы» существуют только у версий компонентов). Встроенный каталог (shadcn — 37 компонентов из `@json-render/shadcn`, wireframe — 12) вшит в бандл, на нём построены все checked-in прототипы, seed и весь Storybook.

Цель: (1) мультиюзерность — именованные пользователи, приватные по умолчанию прототипы, публикация в общую галерею, архив у владельца; (2) полное удаление встроенного каталога — остаются только пользовательские компоненты и кастомные дизайн-системы.

**Решения, зафиксированные с пользователем:**
- Auth: именованные пользователи (имя+пароль, cookie-сессии); создаёт только админ через минимальную страницу `/users`; bootstrap-админ из env.
- **Threat model: все аккаунты — доверенные операторы.** Пользовательский TSX исполняется с правами сервера (publish-pipeline) и same-origin в браузерах всех пользователей; песочницы нет и не планируется. Приватность прототипов защищает от случайного просмотра, не от злонамеренного коллеги. Фиксируется в `docs/server-api.md` (раздел trust boundary).
- Публикация прототипа = виден всем залогиненным. Не-владелец видит **мета + живой head (play/present/CJM) + опубликованные версии**; история ревизий, diff и figma-исходники — только владельцу.
- Архив у владельца: исчезает из списков, вкладка «Архив», разархивация → private. Отдельного «скрыть» нет.
- Builtins удаляются полностью (включая Storybook). **Старые builtin-версии и их share-ссылки ломаются честно**: при миграции B share-grants builtin-прототипов отзываются, их версии становятся unrenderable (заглушка «прототип в архиве»); JSON-данные сохраняются. Share-ссылки на custom-прототипы (yandex-pay) продолжают работать.
- Share-ссылки custom-прототипов живут независимо от unpublish/архива (grant пинит immutable-версию; отзыв — существующий revoke).
- Компоненты и дизайн-системы получают владельцев: видят и используют все, мутации — только владелец (детали в A.0).

## Последовательность: A (multi-user) → B (удаление builtins)

Миграция B зависит от механики A (архивация builtin-прототипов требует `owner_id`/`status`); прод-ценность A выше; две независимые прод-миграции (v14, v15) проще верифицировать и откатывать. Внутри волн задачи с пересечением файлов сериализуются (см. ниже).

---

## Триаж находок Codex-ревью (раунд 1, тред task-mrnqhwam-pksiwp)

| # | Sev | Находка | Вердикт |
|---|-----|---------|---------|
| 1 | blocker | Migration runner зашит под v13 (`server/migrations.ts:329`): v14/v15 молча не выполнятся | **Принято** → задача A1-0: переписать runner на последовательное исполнение каждого индекса ≥13 с инкрементом `user_version` после каждой миграции; v13 остаётся special-case. Тесты: 0→15, 12→15, 13→14, 13→15, 14→15, crash/retry, `foreign_key_check` |
| 2 | blocker | Custom TSX = межпользовательский RCE/XSS | **Принято решением пользователя**: threat model «все аккаунты доверенные», без песочницы; фиксация в docs. Публикация компонентов доступна всем залогиненным |
| 3 | blocker | «Удалить builtins» несовместимо с живыми builtin-шарами/версиями | **Принято решением пользователя**: «сломать честно» — v15 отзывает share-grants builtin-прототипов; `renderableForRev`/render-status проверяет резолвимость всех типов элементов (не только custom-пины); unrenderable → заглушка |
| 4 | blocker | Image/Hotspot нельзя в `hostPrimitiveNames` (extraction вырежет их из layout/canvas) | **Принято** → B.0/B.1 переработаны: три категории — reserved names; extraction-примитивы (только Overlay); **host-rendered content types** (Image, Hotspot) — обычные компоненты в дереве, поставляемые хостом. Hotspot остаётся в canvas-splitter. Wireframe-Image несовместим по props — его прототипы и так архивируются. Cross-surface тесты (player/present/capture/gallery/CJM/editor, desktop без canvas) |
| 5 | blocker | Одного user-контекста мало для pre-auth полос; login отсутствовал в anonymous-списке | **Принято** → принципал-модель: `Anonymous \| User \| Share(scope) \| Capture(scope)`; резолв один раз в `main.ts`, endpoint-матрица; anonymous: статика-allowlist, health, `POST /api/auth/login`, `GET /share/:token`; share/capture читают private-ресурсы своего скоупа без user-сессии; невалидный bearer не перекрывает валидную сессию |
| 6 | blocker | Обязательный `designSystem` сломает stored-ревизии (3 прототипа без поля в прод/dev БД) | **Принято** → разделить толерантную `storedPrototypeDocSchema` (default при чтении) и строгую input-схему create/save; старые immutable JSON не переписывать; SQL/runtime-дефолты `'shadcn'` убрать только из новых write paths |
| 7 | blocker | Cutover: compose требует `BASIC_AUTH:?`, rollback forward-only миграций не описан | **Принято** → compatibility-релиз: compose принимает оба набора env; переходно новый сервер поддерживает опциональный внешний Basic-барьер поверх сессий; rollback = пара «image + DB snapshot», restore-drill на копии перед каждым push; для B — read-only maintenance window |
| 8 | major | Assets/visual/screenshots глобальны — private прототип «течёт» | **Принято частично**: bytes остаются глобальными content-addressed (задокументировать); list/usage фильтруются по достижимости из видимых ресурсов; screenshot/visual-мутации гейтятся owner-check таргета. Полные asset_grants — вне скоупа |
| 9 | major | Bootstrap/seed ordering, стабильный admin id, dev-flow без env | **Принято** → порядок: migrate → `ensureBootstrapAdmin` (стабильный id `user_admin`, транзакция: ensure+бэкфилл) → seed(owner=admin); require ≥1 admin; смена bootstrap-пароля отзывает его сессии; `npm run server:dev`/e2e задают `ADMIN_NAME/ADMIN_PASSWORD` в командах |
| 10 | major | Публикация раскрывает историю ревизий/figma; нет CAS/audit у status | **Принято решением пользователя**: не-владельцу — meta+head+versions, история owner-only. Audit-actor пишется (см. #18); CAS на status не вводим (last-write-wins для 3 состояний), actor фиксируется |
| 11 | major | Любой может публиковать в чужую DS; owner-status ломает чужие пины | **Принято** → attach/move/publish компонента в DS: только владелец DS (или admin); переводы статуса, делающие запиненный bundle недоступным (archived/rejected активной версии с пинами) — только admin; владельцу — deprecate |
| 12 | major | v15: обнуление `builtin_provider` маскирует legacy под custom, PATCH theme откроется, empty-state недостижим | **Принято** → provider не обнуляется; добавляется `design_systems.retired INTEGER NOT NULL DEFAULT 0`: retired = скрыт из выбора/manifest-подсказок, PATCH theme запрещён, прототипы не создаются. Классификация архивируемых прототипов — по head-doc (нерезолвимые builtin-типы), не по полю design_system |
| 13 | major | SameSite=Lax недостаточен; session lifecycle недоопределён | **Принято** → Origin-check на все unsafe-методы (включая multipart), login rate-limit + dummy-verify против enumeration, лимиты длины, cap+cleanup сессий, `__Host-`-cookie в проде, валидация `next` (same-origin relative). Примечание: same-origin вредоносный компонент обходит CSRF — покрыто threat model #2 |
| 14 | major | Публичная статика отдаёт Storybook/manifest/public целиком; Vary: Authorization устарел | **Принято** → публичный allowlist статики (index.html, hashed-чанки, favicon, шрифты); `dist/storybook` и прочее — за auth до B; для session-API централизованно `Vary: Cookie` + `private/no-store` |
| 15 | major | Удаление shadcn ломает CSS-контракт опубликованных бандлов (yp) и name-based семантику (cjmRegistry Dialog, validate Link/Image/Hotspot) | **Принято** → перед удалением зависимости зафиксировать скомпилированный CSS-снапшот (compat-слой в `src/styles/`), обновить `check-css` сентинелы; cjmRegistry shadcn-хак удалить; name-based семантика остаётся только для host types (Image/Hotspot), Link-специалка удаляется |
| 16 | major | e2e: auth-preview без фикстур, cookie-origin mismatch, 47 createHandler-тестов, 19 unit-файлов на prototypes/*.json | **Принято** → setup+storageState на каждый проект (login через base-origin проекта); auth-preview получает собственную фикстуру вместо hello-world; общий auth-harness для server-тестов; фикстурные JSON переезжают из `prototypes/` в `test/fixtures/` (не удаляются, пока ими живут unit-тесты, затем переавторинг) |
| 17 | major | Неполный inventory (vite proxy, скиллы deploy/verify/author, perf-скрипт, SmokeSpec, README, builtinHash defaults); конфликт B3-1/B3-2 по package.json | **Принято** → зачистка добавлена в B.3/B.4; `validate:prototypes` → `validate:templates` (шаблоны + starter-фикстуры); B3-1 и B3-2 сериализуются (один исполнитель); A3-2 стартует после A3-1 (зависимость по client.ts) |
| 18 | minor | Нет audit trail | **Принято** → оживить `author`-колонки: actor в revision save, publish, status change, share create/revoke, user creation |
| 19 | minor | UI-скрытие не закрывает прямые роуты | **Принято** → сервер 403/404 — источник истины (A.2); фронт добавляет guard на чужой `/p/:id/edit` (redirect с уведомлением) |

---

## Workstream A — мультиюзерность

### A.0 Архитектурные решения

- Пароли: `Bun.password.hash/verify` (argon2id). Сессии: `user_sessions`, в БД SHA-256 digest токена; cookie `easyui_session` (`__Host-` в проде) HttpOnly, `SameSite=Lax`, `Secure` при https, TTL 30 дней, cap на пользователя + cleanup протухших.
- **Принципал-модель** (находка #5): `Anonymous | User {userId,name,isAdmin} | Share(scope) | Capture(scope)`; резолвится один раз в `createHandler`, передаётся во все route-модули. Endpoint-матрица — приложение к `docs/server-api.md`. Anonymous-доступ: статика-allowlist, `GET /api/health`, `POST /api/auth/login`, `GET /share/:token`. Share/Capture — exact GET/HEAD allowlist своего скоупа, работают и для private/archived ресурсов скоупа.
- CSRF/hardening (находка #13): Origin-check на unsafe-методы, login rate-limit + dummy-verify, лимиты длины, валидация `next`.
- BASIC_AUTH как механизм приложения удаляется; **переходно** сервер поддерживает опциональный внешний Basic-барьер поверх сессий (env `LEGACY_BASIC_AUTH`, удаляется после B) — совместимость compose/rollback (находка #7). Инвариант старта: non-loopback требует существующего admin или `ADMIN_*`-env.
- Порядок старта (находка #9): migrate → `ensureBootstrapAdmin` (id `user_admin`, транзакционно: upsert админа + бэкфилл `owner_id IS NULL` во всех трёх таблицах) → seed(owner=admin). Смена bootstrap-пароля отзывает его сессии.
- Статика: публичный allowlist (находка #14); остальное (включая `dist/storybook` до B) — за сессией. Session-API ответы: `Vary: Cookie`, `private`/`no-store`.
- Видимость прототипа — колонка `status: private | published | archived`, ортогональна version-publish. Матрица доступа: owner — всё; не-владелец при `published` — GET meta/draft-doc/versions/render-status (play/present/CJM), **без** revisions/diff/figma; мутации — 403; `private|archived` не-владельцу — 404. Screenshot/visual-мутации — owner-only; list/usage assets и visual-артефактов фильтруются по видимости (находка #8), bytes глобальны (задокументировать).
- Каталог: `owner_id` у components/design_systems; чтение глобально; мутации owner-only; attach/publish компонента в DS — только владелец DS или admin; статус-переходы, ломающие запиненные bundles, — только admin (находка #11).
- Audit: actor во все мутационные записи (находка #18). Смена владельца и удаление пользователей — вне скоупа.

### A.1 Волна 1 — migration runner + серверное ядро auth

Задача **A1-0 (первой, отдельным коммитом)**: переписать runner в `server/migrations.ts` (находка #1) — последовательное исполнение индексов ≥13, `user_version` после каждой; тесты переходов и crash/retry.

Задача A1-1 — auth-ядро. Файлы: `server/migrations.ts` (v14), `server/auth.ts` (переписать под принципалы/сессии), `server/main.ts`, новые `server/users.ts`, `server/routes/auth.ts`, `server/routes/users.ts`, `server/contracts.ts`, `server/seed.ts` (owner), OpenAPI, `docs/server-api.md` (auth + threat model + endpoint-матрица).

Миграция **v14**:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
  created_at TEXT NOT NULL);
CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY, session_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX user_sessions_user ON user_sessions(user_id, expires_at);
ALTER TABLE prototypes ADD COLUMN owner_id TEXT REFERENCES users(id);
ALTER TABLE prototypes ADD COLUMN status TEXT NOT NULL DEFAULT 'private'
  CHECK(status IN ('private','published','archived'));
UPDATE prototypes SET status='published';           -- существующие видимы всем
ALTER TABLE components ADD COLUMN owner_id TEXT REFERENCES users(id);
ALTER TABLE design_systems ADD COLUMN owner_id TEXT REFERENCES users(id);
```

`owner_id` nullable в схеме; NOT NULL обеспечивают бэкфилл + startup-проверка.

API: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST/GET /api/users` (admin). 401 — JSON без `WWW-Authenticate`.

Done: `npm run server:test`; тесты login/logout/me/bootstrap/rate-limit/Origin-check; отказ старта без админа на non-loopback; матрица anonymous-доступа.

### A.2 Волна 2 — ownership/visibility на API

Файлы: `server/repos/prototypes.ts`, `server/routes/prototypes.ts`, `server/repos/components.ts`, `server/routes/components.ts`, `server/routes/designSystems.ts`, `server/share/repo.ts`, `server/routes/share.ts`, `server/routes/screenshots.ts`, `server/routes/visual.ts`, `server/routes/assets.ts`, `server/repos/assets.ts`, тесты.

- Принципал во все route-модули (единая сигнатурная правка).
- `PrototypeRepo.list(principal)`: свои все + чужие `published` (+`owner {id,name}`, `status` в DTO).
- Не-владельцу: meta/draft-doc/versions/render-status; `revisions/diff/restore/figma` — 404/403 (owner-only). Share/Capture-принципалы читают свой скоуп независимо от status.
- `POST /api/prototypes/:id/status {status}` — owner-only, actor в audit.
- Components/DS: owner-мутации; DS-права на attach/publish; admin-only опасные статус-переходы.
- Assets/visual/screenshots: фильтрация list/usage, owner-гейт мутаций.

Done: server-тесты матрицы (principal × статус × метод), общий auth-harness для существующих ~47 `createHandler`-тестов (находка #16).

### A.3 Волна 3 — фронтенд (последовательно: A3-1 → A3-2)

**A3-1 auth-инфраструктура**: `src/api/client.ts` (auth-функции, DTO, 401 → `/login?next=…` с same-origin-валидацией, кроме share-роутов), `src/app/routes.tsx` (`/login`, `/users`), новый `src/auth/`, Layout (имя + «Выйти»), `/users` (admin).

**A3-2 галерея/гварды**: `src/gallery/GalleryPage.tsx` — табы «Мои / Общие / Архив» (chokepoint `filterAndSortPrototypes`); карточные контролы владельца (Опубликовать/Снять, В архив/Вернуть; паттерн `src/library/statusBadge.ts`); бейдж владельца; guard чужого `/p/:id/edit` (находка #19); Library — owner-гейт мутационных контролов.

### A.4 Волна 4 — e2e + docs + прод-деплой A

- `playwright.config.ts`: `ADMIN_NAME/ADMIN_PASSWORD` во все webServer; per-project setup + `storageState`, login через base-origin каждого проекта (dev — `localhost:5173`); auth-preview — собственная API-фикстура вместо seed `hello-world`.
- Спеки: login-flow, табы, публикация/архив, principal-матрица (API), share поверх session-auth.
- Docs: `docs/server-api.md` (auth, threat model, матрица), `CLAUDE.md`, скилл `/deploy` (env).
- Прод: restore-drill миграций v14 на копии прод-БД → бэкап → env в Dokploy (`ADMIN_*`; `BASIC_AUTH` остаётся до конца переходного периода как `LEGACY_BASIC_AUTH`) → push → верификация по `/deploy` (health, логин, старые прототипы published под админом, share-ссылки, скриншоты) → создать пользователей.

---

## Workstream B — удаление встроенных компонентов

### B.0 Архитектурные решения

- **Три категории вместо «host primitives» (находка #4)**: reserved names; extraction-примитивы (только Overlay — вырезается в overlay-слой); **host content types** — Image и Hotspot: обычные компоненты дерева, поставляются хостом, всегда мерджатся в каталог, Hotspot проходит существующий canvas-splitter, Image рендерится в потоке. Wireframe-Image (другие props) не переносится — его прототипы архивируются.
- CSS-контракт (находка #15): перед удалением `@json-render/shadcn` зафиксировать скомпилированный CSS-снапшот в `src/styles/` (compat-слой для опубликованных custom-бандлов, включая yandex-pay), обновить `scripts/check-css.mjs`; `styleContractVersion` не бампаем.
- `design_systems`: provider сохраняется, добавляется `retired` (находка #12) — retired-системы скрыты из выбора/создания, PATCH theme запрещён; их наличие не блокирует empty-state.
- Renderability (находка #3): `renderableForRev`/render-status проверяют резолвимость **всех** типов элементов (custom-пины + host types); нерезолвимые → unrenderable, плеер/шара — заглушка «прототип в архиве».
- Seed удаляется; фикстурные JSON переезжают в `test/fixtures/` для unit-тестов (находка #16), затем переавторинг. `validate:prototypes` → `validate:templates` (находка #17). Storybook удаляется полностью. `DEFAULT_DESIGN_SYSTEM_ID` умирает; строгая input-схема требует `designSystem`, толерантная stored-схема сохраняет default для чтения старых ревизий (находка #6).
- cjmRegistry shadcn/Dialog-хак и name-based Link-семантика удаляются; name-based остаётся только для Image/Hotspot.

### B.1 Волна 1 — host content types (совместимо с живыми builtins)

Файлы: `src/catalog/hostPrimitives/**` (переименование/структура: extraction vs content), перенос `hotspot.tsx`/`hotspot.definition.ts`, нейтральный `image.tsx` (без shadcn-токенов), `src/catalog/builtinSemantics.ts`, `src/prototype/validate.ts` (isCustomType, custom-гейты), `src/prototype/runtimeSpec.ts` (extraction — только Overlay), `server/builtinHash.ts`, тесты cross-surface (player/present/capture/gallery/CJM/editor, desktop-flow).

### B.2 Волна 2 — сервер + миграция v15

Файлы: `server/designSystems.ts`, `server/migrations.ts` (v15; снять `assertBuiltinNamesDoNotCollide`), `server/seed.ts` (удалить), `server/validation.ts`, `server/routes/prototypes.ts` (renderability), `server/routes/designSystems.ts` (retired), `server/routes/meta.ts`, `prototypes/` → `test/fixtures/`, тесты.

Миграция **v15** (после v14):

```sql
ALTER TABLE design_systems ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
UPDATE design_systems SET retired=1 WHERE builtin_provider IS NOT NULL AND id IN ('shadcn','wireframe');
-- архивация по head-doc: выполняется кодом миграции (не голым SQL):
--   прототипы, чей head содержит типы, нерезолвимые без builtin-каталога → status='archived'
-- share-grants таких прототипов (и всех builtin-версий) — revoke
```

(`yandex-pay` имеет builtin_provider, но её каталог custom — она НЕ retired; классификация прототипов идёт по документам, не по полю design_system.)

### B.3 Волна 3 — фронтенд-чистка + Storybook (одна задача, последовательно; конфликт по package.json — находка #17)

- Runtime/DS: `src/catalog/runtime.ts` (каталог = custom + host types + Overlay), `src/designSystems/index.ts` (снос shadcn/wireframe, `DEFAULT_DESIGN_SYSTEM_ID`; зачистка потребителей: `CjmView`, `cjmRegistry`, `EditorView`, `screenshot/service`, `share/repo`, `?? "shadcn"`-fallback-и), удаление `src/designSystems/shadcn|wireframe`, `@json-render/shadcn` (после фиксации CSS-снапшота), `src/catalog/fixtures.ts`.
- Галерея/библиотека: `prototypeTemplates.ts` (шаблон Image+Hotspot), create-dialog + empty-state (CTA «создать дизайн-систему»), `LibraryPage.tsx` (только custom), удаление `.storybook/`, stories, `storybookIndex.ts`, `check-storybook-drift`.
- Inventory (находка #17): `package.json` (scripts/deps, `build` без storybook), `vite.config.ts` (storybook-proxy), `playwright.config.ts`, `scripts/perf-gallery-dataset.ts`, `src/smoke/SmokeSpec.tsx`, `public/design/cjm-ui`, README, `CLAUDE.md`, скиллы `/verify` и `/author` (референс-каталог на custom).

### B.4 Волна 4 — e2e re-author + прод-деплой B

- Starter-фикстура `e2e/starter-ds.fixture.ts` (DS `e2e-starter` + Button/Text/Stack-подобные TSX), публикация через API под админом; setup-проекты для dev, preview (новый) и auth-preview.
- Переавторинг спеков на starter-DS + Image/Hotspot; удаление storybook/restyle-спеков; тесты legacy-заглушки (unrenderable) и retired-DS.
- Прод: restore-drill v15 на копии прод-БД → **read-only maintenance window** → бэкап (пара image+snapshot для отката, находка #7) → push → верификация: yp-прототипы рендерятся/published, builtin-прототипы в «Архиве» с заглушкой, их share-ссылки отозваны, yp-шары живы, создание прототипа предлагает только не-retired DS, `/library` без Storybook. После стабилизации — удалить `LEGACY_BASIC_AUTH` из compose/env.

---

## Верификация

Каждая волна: `npm run typecheck && npm run server:typecheck && npm run lint && npm run test -- --run && npm run server:test`; после изменений API — `verify:openapi`; после B3 — обновлённый `npm run verify`; после A.4/B.4 — `npm run e2e` + runtime-прогон по `/verify`. Перед каждым прод-push — прогон миграций на копии прод-БД (restore-drill). Деплой — по `/deploy`.

## Остаточные риски

1. Same-origin вредоносный компонент обходит CSRF и читает данные — покрыто принятой threat model (доверенные аккаунты).
2. CSS-снапшот shadcn — замороженный артефакт; новые custom-компоненты должны нести свои стили (уже так для yp v2).
3. Forward-only миграции: откат B возможен только парой image+snapshot в пределах maintenance window.
4. `components.name` остаётся глобально уникальным — межпользовательские коллизии имён решаются социально (доверенная команда).

## Процесс

1. План v2 закоммичен; повторный раунд Codex-ревью (`--resume` того же треда) до отсутствия блокеров.
2. Исполнение: Codex-задачи `--fresh --write --effort medium` по волнам; оркестратор независимо верифицирует done-критерии, коммитит по зонам; финальный проход `npm run verify` + `npm run e2e` + `/verify`.
