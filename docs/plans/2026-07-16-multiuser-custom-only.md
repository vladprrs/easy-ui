# План: мультиюзерность + полный отказ от встроенных компонентов

## Контекст

easy-ui сейчас — однопользовательский инстанс за одним общим Basic Auth: в БД нет ни пользователей, ни владельцев, ни видимости (колонки `author` мертвы, «статусы» существуют только у версий компонентов). Встроенный каталог (shadcn — 37 компонентов из `@json-render/shadcn`, wireframe — 12) вшит в бандл, на нём построены все checked-in прототипы, seed и весь Storybook.

Цель: (1) мультиюзерность — именованные пользователи, приватные по умолчанию прототипы, публикация в общую галерею, архив у владельца; (2) полное удаление встроенного каталога — остаются только пользовательские компоненты и кастомные дизайн-системы.

**Решения, зафиксированные с пользователем:**
- Auth: простые именованные пользователи (имя+пароль, cookie-сессии); создаёт только админ через минимальную страницу `/users`; bootstrap-админ из env.
- Публикация прототипа = виден всем залогиненным (read/present/CJM); правка — только владелец.
- Архив у владельца: исчезает из списков, вкладка «Архив», разархивация → private. Отдельного «скрыть» нет.
- Builtins удаляются полностью (включая Storybook); существующие builtin-прототипы архивируются, не удаляются.
- Share-ссылки/QR продолжают работать независимо от unpublish/архива (grant пинит immutable-версию, отзыв — существующий revoke).
- **Компоненты и дизайн-системы тоже получают владельцев**: видят и используют все, мутации (save/publish/delete/status/theme) — только владелец.

## Последовательность: A (multi-user) → B (удаление builtins)

Миграция B зависит от механики A (архивация builtin-прототипов требует `owner_id`/`status`); прод-ценность A выше; две независимые прод-миграции (v14, v15) проще верифицировать и откатывать.

---

## Workstream A — мультиюзерность

### A.0 Архитектурные решения

- Пароли: `Bun.password.hash/verify` (argon2id).
- Сессии: таблица `user_sessions`, в БД только SHA-256 digest токена (зеркало `share_sessions`); cookie `easyui_session` HttpOnly, `SameSite=Lax` (базовый CSRF), `Secure` при https, TTL 30 дней.
- **BASIC_AUTH удаляется полностью**, `server/auth.ts` переписывается под сессии. Инвариант `startServer` (`server/main.ts:106`): отказ старта на non-loopback без пользователей в БД и без bootstrap-env. `ensureBootstrapAdmin(db)` на старте: env `ADMIN_NAME`/`ADMIN_PASSWORD` → создаёт/обновляет админа и **бэкфиллит все `owner_id IS NULL`** (prototypes, components, design_systems) на админа.
- Статика (SPA) публична, весь `/api` за сессией. Pre-auth полосы сохраняются: `GET /api/health`, `GET /share/:token` + share-cookie, capture-bearer (loopback).
- Видимость прототипа — одна колонка `status`: `private | published | archived`. Ортогональна version-publish (`POST /:id/publish` не меняется). Галерейная публикация не требует опубликованной версии; share/QR по-прежнему требует.
- Матрица доступа к прототипам: owner — всё; не-owner при `published` — только GET (meta/draft/revisions/versions/render-status/CJM); мутации — 403; `private|archived` для не-owner — 404. Скриншот/visual-мутации — owner-only.
- Каталог: components/design_systems получают `owner_id`; чтение/manifest — глобальные, мутации — owner-only (403). Создавать новые может любой залогиненный.
- Assets остаются глобальными content-addressed; смена владельца и удаление пользователей — вне скоупа.

### A.1 Волна 1 — серверное ядро auth

Файлы: `server/migrations.ts`, `server/auth.ts`, `server/main.ts`, новые `server/users.ts`, `server/routes/auth.ts`, `server/routes/users.ts`, `server/contracts.ts`, OpenAPI (`scripts/generate-openapi.ts`), `docs/server-api.md`.

Миграция **v14** (обычная транзакция, append в массив `migrations[]`):

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

`owner_id` nullable в схеме; NOT NULL обеспечивается бэкфиллом `ensureBootstrapAdmin` + startup-проверкой (остались NULL → ошибка старта).

API: `POST /api/auth/login {name,password}` → Set-Cookie; `POST /api/auth/logout`; `GET /api/auth/me`; `POST /api/users` (admin); `GET /api/users` (admin). Чокпоинт `createHandler` (`server/main.ts:46-101`): резолв сессии → `AuthContext {userId, name, isAdmin}`; 401 — JSON-ошибка без `WWW-Authenticate`.

Done: `npm run server:test` зелёный, тесты login/logout/me/bootstrap, отказ старта без админа на non-loopback.

### A.2 Волна 2 — ownership/visibility на API

Файлы: `server/repos/prototypes.ts`, `server/routes/prototypes.ts`, `server/repos/components.ts`, `server/routes/components.ts`, `server/routes/designSystems.ts`, `server/share/repo.ts` + `server/routes/share.ts`, `server/routes/screenshots.ts`, `server/routes/visual.ts`, тесты.

- Прокинуть `AuthContext` во все route-модули (единая сигнатурная правка).
- `PrototypeRepo.list(auth)`: свои все + чужие `published`; DTO `PrototypeSummary`/meta + `owner {id,name}`, `status` (`src/api/client.ts:40`).
- `create` пишет владельца; `save/restore/publish/delete` — owner-check; GET — матрица A.0.
- Новый `POST /api/prototypes/:id/status {status}` (owner-only; без CAS, last-write-wins).
- Components/DS: мутации (PUT source, publish, delete, version-status, PATCH theme) — owner-check; DTO + owner.
- Share-grant создание — owner-only; exchange-полоса не меняется.

Done: server-тесты матрицы доступа (owner/не-owner × статусы × методы).

### A.3 Волна 3 — фронтенд (2 параллельные задачи)

**A3-1 auth-инфраструктура**: `src/api/client.ts` (login/logout/me/setPrototypeStatus/users, обработка 401 → redirect `/login?next=…`, кроме share-роутов), `src/app/routes.tsx` (`/login`, `/users`), новый `src/auth/` (LoginPage, useCurrentUser), Layout — имя пользователя + «Выйти», страница `/users` (admin-only, создание пользователя).

**A3-2 галерея**: `src/gallery/GalleryPage.tsx` — табы «Мои / Общие / Архив» (расширение chokepoint `filterAndSortPrototypes`, GalleryPage.tsx:15); карточные контролы владельца (Опубликовать/Снять, В архив/Вернуть — паттерн бейджей из `src/library/statusBadge.ts`); бейдж владельца на чужих; скрыть Edit/Delete на чужих. В Library — owner-гейт мутационных контролов.

### A.4 Волна 4 — e2e + docs + прод-деплой A

- `playwright.config.ts`: webServer-команды получают `ADMIN_NAME/ADMIN_PASSWORD`; общий helper `e2e/auth.ts` (login через API + `storageState` в setup-проектах); проект `auth-preview` (:4174) переориентируется на «share pre-auth поверх session-auth» (env `BASIC_AUTH` удаляется).
- Фикстуры (`e2e/dev/custom-ds.fixture.ts` и др.) — провижининг под залогиненным админом.
- Новые спеки: login-flow, табы, публикация/архив, 403/404-матрица.
- Прод: бэкап `.backups/` → env в Dokploy (`ADMIN_NAME`/`ADMIN_PASSWORD`, удалить `BASIC_AUTH`) → push → верификация по `/deploy` (health, логин, старые прототипы published под админом, share-ссылки живы, скриншоты работают) → создать реальных пользователей.

---

## Workstream B — удаление встроенных компонентов

### B.0 Архитектурные решения

- **Hotspot и Image → host primitives** (рядом с Overlay: reserved names, мерджатся в каждый runtime-каталог). Hotspot — ядро кликабельного прототипа; Image (с `$asset`) + Hotspot дают сценарий «скриншот + хотспоты» на пустом инстансе. Image освободить от shadcn-специфики.
- Строки `design_systems` shadcn/wireframe **не удаляются** — v15 ставит `builtin_provider=NULL` (иначе dangling-ссылки у прототипов/ревизий); их прототипы архивируются.
- Колонка `builtin_catalog_hash` остаётся (история); `builtinCatalogHashFor` уже поддерживает пустые definitions.
- Seed удаляется целиком (`server/seed.ts`, `prototypes/*.json`, `server/fixtures/checkout-v1.seed.json`); `validate:prototypes` удаляется из verify.
- Storybook удаляется полностью: `.storybook/`, `src/**/stories`, `storybookIndex.ts`, `check-storybook-drift`, deps, шаг в `npm run build`, webServer в playwright.
- `DEFAULT_DESIGN_SYSTEM_ID="shadcn"` умирает; `designSystem` в `prototypeDocSchema` становится обязательным (снять default). Создание прототипа: выбор из кастомных DS; если их нет — empty-state с CTA «создать дизайн-систему».

### B.1 Волна 1 — промоушен host primitives (совместимо с живыми builtins)

Файлы: `src/catalog/hostPrimitives/**` (перенос `hotspot.tsx`, `hotspot.definition.ts`, `shadcn/image.tsx`), `src/catalog/builtinSemantics.ts` (сужение до семантик примитивов), `src/prototype/validate.ts`, `server/builtinHash.ts`, тесты.

`validate.ts`: `isCustomType = !hostPrimitiveNames.has(type)`; custom-only гейты ($if, param sources, named slots) — на всех не-примитивных типах.

### B.2 Волна 2 — сервер + миграция v15

Файлы: `server/designSystems.ts`, `server/migrations.ts` (v15, удалить `assertBuiltinNamesDoNotCollide` и provider-логику), `server/seed.ts` (удалить + вызов в main.ts), `server/validation.ts` (`snapshotDefinitions`: builtins → `{}`), `server/routes/prototypes.ts`, `server/routes/designSystems.ts`, `server/routes/meta.ts`, удаление `prototypes/` и seed-фикстур, тесты.

Миграция **v15** (после v14 — `status` уже существует):

```sql
UPDATE design_systems SET builtin_provider=NULL,
  description=description||' (legacy: встроенные компоненты удалены)'
  WHERE builtin_provider IS NOT NULL;
UPDATE prototypes SET status='archived'
  WHERE design_system IN ('shadcn','wireframe');
```

### B.3 Волна 3 — фронтенд-чистка + Storybook (2 параллельные задачи)

**B3-1 runtime/DS**: `src/catalog/runtime.ts` (каталог = custom + hostPrimitives, убрать `resolveBuiltinSystem`/`builtinCatalogs`), `src/designSystems/index.ts` (удалить shadcn/wireframe и `DEFAULT_DESIGN_SYSTEM_ID`, зачистить потребителей: `CjmView`, `EditorView`, `screenshot/service`, `share/repo`, fallback-и `?? "shadcn"`), удаление `src/designSystems/shadcn|wireframe`, `@json-render/shadcn` из package.json, `src/catalog/fixtures.ts`/definitions-тесты.

**B3-2 галерея/библиотека/Storybook**: `src/gallery/prototypeTemplates.ts` (шаблон на Image+Hotspot), `GalleryPage.tsx` (create-dialog, empty-state), `src/library/LibraryPage.tsx` (только custom), удаление `.storybook/`, stories, `storybookIndex.ts`, `check-storybook-drift`, scripts/deps в `package.json` (`build` → без storybook), `playwright.config.ts`, `CLAUDE.md`/docs.

### B.4 Волна 4 — e2e re-author + прод-деплой B

- Starter-фикстура: общий модуль `e2e/starter-ds.fixture.ts` (DS `e2e-starter` + 3 компонента Button/Text/Stack-подобных TSX), публикация через API; используется dev-setup **и новым preview-setup** (сейчас у preview нет setup-проекта).
- Переавторинг спеков (gallery/present/misclick/cjm/editor/flow-entry/checkout→starter-flow и т.д.) на starter-DS + Image/Hotspot; удалить storybook/restyle-спеки.
- Прод: бэкап → push → верификация: yp-прототипы рендерятся и published, builtin-прототипы в «Архиве» админа, создание прототипа предлагает yandex-pay DS, `/library` без Storybook, share-ссылки живы.

---

## Верификация

Каждая волна: `npm run typecheck && npm run server:typecheck && npm run lint && npm run test -- --run && npm run server:test`; после изменений API — `verify:openapi`; после B3 — обновлённый `npm run verify` (без storybook-шагов); после A.4/B.4 — `npm run e2e` + runtime-прогон по скиллу `/verify`. Перед каждым прод-push — прогон миграций v14/v15 на копии прод-БД из бэкапа. Деплой и проверка прода — по скиллу `/deploy`.

## Риски

1. CSRF: `SameSite=Lax` принят для MVP; double-submit-token — отдельная итерация при необходимости.
2. «Общие» показывают живой head чужого прототипа (не только published-версию) — принято осознанно.
3. Image как host primitive: проверить связанность `shadcn/image.tsx` с токенами; при сильной связке — переписать на нейтральный рендер.
4. Проверить и снять default `'shadcn'` у `designSystem` в `src/prototype/schema.ts` (иначе старые клиенты создадут прототип на мёртвой DS).
5. Ownership каталога ломает существующие e2e-фикстуры компонентов — правится в A.4 (провижининг под админом).
6. Порядок деплоя строго A → B.

## Процесс (по CLAUDE.md workflow)

1. Сохранить план в `docs/plans/2026-07-16-multiuser-custom-only.md`, закоммитить.
2. Codex `gpt-5.6-sol` (max) — адверсариальное ревью плана; триаж находок в плане; итерации до отсутствия блокеров.
3. Исполнение: Codex-задачи `--fresh --write --effort medium` по волнам с file ownership выше; оркестратор независимо верифицирует done-критерии, коммитит по зонам.
