# Admin visibility: админы видят все прототипы и компоненты

Дата: 2026-08-05. Статус: v2, прошёл адверсариальное ревью (триаж ниже).

## Задача

«Сделай так, чтобы админы могли видеть все компоненты и прототипы».

## Текущее состояние (факты)

- **Прототипы, сервер**: `server/repos/prototypes.ts:382-394` — `WHERE (?=1 OR p.owner_id=? OR p.status='published')`; escape hatch `?=1` включается только при отсутствии principal. Залогиненный админ = обычный пользователь. `JOIN users` — inner: прототипы с `owner_id IS NULL` невидимы вообще всем.
- **Прототипы, чтение одного**: `server/authorization.ts:15` — админ считается владельцем только orphaned-прототипов. Чужой private админ открыть не может (404).
- **Прототипы, клиент**: `src/gallery/galleryModel.ts:26-34` — вкладки `mine|shared|archive|service` фильтруют по `owner.id === userId`; вкладки «всё» нет.
- **Компоненты / ДС / композиции**: list-роуты без owner-предиката — все аутентифицированные уже видят всё (`server/repos/components.ts:60`, `server/routes/designSystems.ts:188`, `server/routes/compositions.ts:156`). Library — publish-scoped витрина, одинаковая для всех. **Менять не требуется** (см. «Вне скоупа»).

## Изменения

### T1. Сервер: `GET /api/prototypes?scope=all` (только админ)

- `server/routes/prototypes.ts` (список, :125): принять query `scope=all`; если principal не user-админ — 403 (или молча игнорировать? — нет: явный 403 `admin_required`). При `scope=all` вызвать `repo.list` с опцией `includeAll: true`.
- `server/repos/prototypes.ts` `list`: опция `includeAll` биндит `1` в существующий escape hatch. `JOIN users` → `LEFT JOIN users`; owner маппить как в `meta()` (`server/repos/prototypes.ts:397`): `{ id: r.owner_id ?? "", name: r.owner_name ?? "Unknown" }` — контракт `owner: {id:string,name:string}` (`server/contracts.ts:897,930`) не меняется. Дефолтный ответ (без `scope=all`) обязан остаться байт-в-байт прежним для всех, включая админов; orphaned-прототипы при LEFT JOIN у не-админов по-прежнему не должны всплывать published-веткой — сохранить это условием `p.owner_id IS NOT NULL` в не-includeAll ветке предиката (фиксируем текущее поведение, продуктовое решение об orphaned+published не принимаем здесь).
- `docs/server-api.md`: описать `scope=all`; при необходимости — `server/openapi.ts`/схемы, если query-параметры там перечислены.

### T2. Сервер: админ читает любой прототип (read, не mutate)

`server/authorization.ts`: в `resolvePrototypeAccess` добавить признак `adminRead` (user-principal с `isAdmin`); `requirePrototypeRead` пропускает по нему. `requirePrototypeOwner` НЕ расширять — мутации (PUT/DELETE/status/share/scenarios/baselines) остаются owner-only; существующее правило «админ владеет orphaned» сохранить. Решение триажа: заявка — «видеть», DELETE необратим, публикация чужого private меняет его видимость — это отдельные продуктовые решения.

### T3. Клиент: вкладка «Все» для админа

- `src/gallery/galleryModel.ts`: `GalleryTab` + `"all"`; ветка фильтра для `all` — показывать всё (включая private/archived чужие); второй фильтр `isService === (tab === "service")` (:34) для `all` не применять (как для `archive`); guard `userId !== "" && owner.id === userId` в ветке `mine`/`archive`/`service`, чтобы orphaned с `owner.id === ""` не попадал в «Мои».
- `src/gallery/GalleryPage.tsx`: вкладка `all` видна только `user.isAdmin`; при `tab === "all"` запрашивать `listPrototypes({ scope: "all" })` (клиент `src/api/client.ts` — параметр), иначе обычный запрос — дефолтная выдача и другие потребители (`src/visual/VisualPage.tsx:225`, `src/prototype/loader.ts:21`) не меняются.
- `src/gallery/components/GalleryToolbar.tsx:23-26,50`: список табов — функция от `isAdmin`; `kindsForTab` для `all` — все виды (как `archive`).
- `PrototypeCard` (`src/gallery/components/PrototypeCard.tsx:76`): `isOwner` оставить настоящим владением — бейдж владельца на чужих карточках сохраняется, меню мутаций у админа на чужом не появляется (консистентно с T2).

### T4. Тесты и доки

- `server/ownership.test.ts`: третий пользователь-админ (`is_admin=1`) + сессия; кейсы: `scope=all` возвращает чужой private и orphaned; без `scope=all` админ видит как обычный; не-админ со `scope=all` получает 403; админ читает чужой private по id (200), мутация чужого админом — по-прежнему 403/404.
- `src/gallery/GalleryPage.test.tsx`: мок `../auth` (:12) сделать мутируемым; вкладка `all` видна админу, скрыта обычному; тест «mutation controls only for the owner» остаётся на не-админе.
- Контрактный тест (`server/contract.test.ts`) должен остаться зелёным — owner всегда строки.

## Триаж ревью

- B1 (owner null ломает контракт) — принято: `{id:"", name:"Unknown"}` как в `meta()`, guard в galleryModel.
- B2 (GalleryToolbar/kindsForTab/service-фильтр не в скоупе T3) — принято, включено.
- M3 (LEFT JOIN менял видимость не-админам) — принято: `scope=all` + фиксация текущего поведения для дефолтной выдачи.
- M4 (mutate-всё как побочный эффект) — принято: только adminRead, owner-гейты не трогаем.
- M5 (isOwner ломает бейдж владельца) — принято: isOwner = настоящее владение.
- M8 (перф и побочные потребители list) — принято через `scope=all`.
- Замечание «а вдруг заказчик имел в виду чужие драфты компонентов» — компоненты уже видны всем через `/api/components` и Library; драфты/retired/soft-deleted скрыты одинаково для всех (это не ownership-фильтр). Оставляем вне скоупа, фиксируем явно.

## Вне скоупа

- Чужие неопубликованные компоненты в Library UI, компоненты retired-ДС, soft-deleted (`?includeDeleted=1` UI не шлёт) — скрыты для всех одинаково, ownership не участвует.
- Мутации чужих прототипов админом (delete/publish/share) — отдельное продуктовое решение.

## Критерии готовности

`npm run verify` зелёный; новые кейсы ownership/gallery-тестов зелёные; под админом вкладка «Все» показывает чужие private и они открываются; под обычным пользователем поведение и ответы API не изменились.
