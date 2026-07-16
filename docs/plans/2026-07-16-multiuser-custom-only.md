# План v4: мультиюзерность + полный отказ от встроенных компонентов

> Статус ревью: раунд 3 — «блокеров нет»; остаточные major/minor учтены ниже (триаж раунда 3).

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

## Триаж находок Codex-ревью (раунд 2)

Раунд 2 подтвердил закрытие блокеров 1, 2, 4 (архитектурно), 5 (базово), 6 (read-path); остаточные находки ниже. Все приняты, продуктовых развилок нет.

| # | Sev | Находка | Вердикт |
|---|-----|---------|---------|
| R2-1 | blocker | Финальный B-сервер не пройдёт startup-инвариант: provider-check (`migrations.ts:315`) требует registry entry для любого ненулевого `builtin_provider`, независимо от `retired` | **Принято** → B.2: инвариант заменяется на «не-retired provider обязан резолвиться; неизвестный provider допустим только при `retired=1`»; тесты старта финального B-кода на БД 0→15 и populated 14→15 |
| R2-2 | blocker | v15 не задаёт классификацию по точной ревизии: share-grants пинят собственный `rev` (смешанные случаи head/grant); проверка по имени типа спутает wireframe-Image (`{alt,label}`) с host-Image (`src/alt/…`) | **Принято** → единая `classifyRevision(prototypeId, rev)`: exact doc + exact pins; тип renderable, если это host type **с совместимыми props** или запиненный custom с renderable bundle. Архив — по классификации head; каждый активный `share_grants.rev` классифицируется независимо (revoke + удаление его sessions). Dry-run отчёт (списки архивируемых head/отзываемых grants) до прод-мутации; mixed-history тесты; `renderableForRev` расширяется, не переиспользуется как есть |
| R2-3 | blocker | Compatibility-релиз неисполним из старого prod-конфига: compose требует `BASIC_AUTH:?`, env сам не переименуется; не определены bypass внешнего барьера | **Принято** → отдельная задача A4-0 «compatibility release»: сервер принимает старый `BASIC_AUTH` как deprecated-алиас `LEGACY_BASIC_AUTH`; `docker-compose.yml`/`.env.example` в скоупе A.4, `docker compose config` проходит и со старым env-only, и с новым; bypass барьера: health, share exchange + share-scope, capture-scope (login/статика — за барьером на переходный период); `BASIC_AUTH` сохраняется до конца rollback-window (rollback-image его требует); удаление — отдельным cleanup-релизом после B |
| R2-4 | major | Композиция принципалов не определена (User+Share в одном браузере; SPA fallback ломает literal-allowlist статики) | **Принято** → path-aware порядок: Capture(match path) → Share(match path) → User → Anonymous; валидный но не подходящий к path share-cookie не перекрывает User; allowlist статики — по резолвнутому физическому файлу (SPA fallback на index.html разрешён для route-путей) |
| R2-5 | major | B1 активирует host-Image поверх живого wireframe-Image до архивации (host мерджится последним, `runtime.ts:73`) | **Принято** → в переходный период (B1–B2) builtin definitions перекрывают host content types (порядок мерджа: host первым, builtin поверх); финальный порядок (host-only) включается в B3. B1-тест существующего wireframe-Image |
| R2-6 | major | `retired` требует двух read-моделей; `yandex-pay` создаётся с `builtin_provider=NULL` (утверждение v2 неверно) — empty-state опять недостижим на fresh DB | **Принято** → `listActiveDesignSystems` / `getIncludingRetired` (старые DTO/theme/versions) / `requireActiveDesignSystem` (create/save/attach/publish/PATCH theme); capabilities/manifest исключают retired; immutable theme-versions обслуживаются. Empty-state определяется как «нет usable active components», а не «нет active DS»; факт про yandex-pay исправлен |
| R2-7 | major | Unrenderable-заглушка не включена во frontend-декомпозицию; revoked share = 404, а не заглушка | **Принято** → контракт: revoked share → 404/410 (заглушка только в авторизованных вьюхах); DTO получает `renderable`/typed error; единый gate в `PrototypeLoader` до загрузки бандлов/создания runtime; потребители (Player/Present/CJM/Gallery/Capture/Editor) добавлены в B.2/B.3 |
| R2-8 | major | Figma встроена в meta/draft/version DTO — закрытия history-роутов мало; права каталога — конъюнкция | **Принято** → principal-aware projection: figma-поля отсутствуют (не null) в meta/head/version для всех не-owner принципалов, тесты на отсутствие; attach/move/publish = владелец компонента **и** владелец DS (или admin) |
| R2-9 | major | Граф переходов status не зафиксирован (архив → published напрямую?) | **Принято** → серверный граф: `private↔published`, `private|published→archived`, `archived→private` (только). Cross-product тесты: version-publish не меняет status; private с версиями невидим; archive не отзывает custom-шары и не трогает versions; v15-архив не создаёт версий |
| R2-10 | major | Порядок волн: auth-harness нужен в A1 (не A2); dev-cookie не уйдёт на `127.0.0.1:8787`; storageState в auth-preview маскирует share-проверку; `/author`-driver и checked-in скрипты ломаются после A4 | **Принято** → auth-harness переносится в A1-1; dev API-запросы — через project baseURL/Vite-proxy или отдельный залогиненный 127-контекст; share-спеки остаются anonymous с отдельным owner-API-контекстом; `/author` driver.mjs, `scripts/w6-yandex-pay.mjs`, perf-скрипт → login+cookie jar+Origin в A.4 |
| R2-11 | major | Забытые потребители: `main.ts` импортирует seedPrototypes; `routes/components.ts` — DEFAULT_DESIGN_SYSTEM_ID; `catalog/definitions.ts` реэкспортирует shadcn; судьба `builtin_catalog_hash` — контракт | **Принято** → inventory B.2/B.3 расширен; контракт hash: legacy-значения immutable, новые ревизии получают детерминированный host-catalog hash; `seed_log` остаётся legacy-таблицей; `validate:templates` реально валидирует шаблоны и starter-фикстуру строгой input-схемой + exact definitions |
| R2-12 | major | CSS-снапшот без критерия эквивалентности (Tailwind сканирует пакет; check-css — 3 селектора) | **Принято** → детерминированная генерация compat-CSS + закоммиченный манифест selectors+declarations с hash, pre/post-build сравнение; визуальная light/dark проверка реального yandex-pay; при недоказанной эквивалентности — бамп styleContractVersion |
| R2-13 | major | Push в main автодеплоится — промежуточные волны нельзя пушить | **Принято** → вся работа в feature-ветке; в `main` два атомарных пуша: после полного A.4 и после полного B.4. Maintenance для B enforced; snapshot — WAL-consistent копия volume + compose/env; done-критерии += `docker compose config`, старт финального image на restored DB, сверка v15 impact counts |
| R2-14 | minor | Audit без схемы хранения | **Принято** → v14 добавляет `audit_events (id, at, actor_id, action, subject_type, subject_id, detail)`; system-actor для миграций |
| R2-15 | minor | SQL `DEFAULT 'shadcn'` может воскресить retired DS через внутренние insert | **Принято** → startup/DB-инвариант «новые строки не ссылаются на retired DS» + тесты insert-путей (rebuild таблиц не делаем) |

---

## Триаж находок Codex-ревью (раунд 3 — блокеров нет)

| # | Sev | Находка | Вердикт |
|---|-----|---------|---------|
| R3-1 | major | Props-проверка `classifyRevision` отклонит валидные `$asset`/`$state`/`$cond` при сыром Zod-parse | **Принято** → host-compatibility использует ту же directive-aware семантику, что `validateElementProps` (подстановка директив до parse); тесты: `$asset`, `$state`, `$cond`, shadcn-Image, wireframe `{alt,label}` |
| R3-2 | major | Startup-инвариант не отличит новую ссылку на retired DS от legacy-строк | **Принято** → вместо data-scan: `BEFORE INSERT`/`BEFORE UPDATE OF design_system` triggers в v15 на prototypes/components/component_revisions (prototype_revisions — через parent/`json_extract`); startup проверяет наличие triggers; тест raw-insert |
| R3-3 | major | Dry-run и candidate image технически неисполнимы (`openDatabase` мигрирует безусловно; image собирается только из main c `latest`) | **Принято** → CLI `migration:v15:report` (открытие SQLite без migrate, structured JSON с ID/counts); workflow-вариант для feature-ветки: image под SHA-тегом без `latest`/deploy; compose-override для запуска тега на restored volume; машинная сверка отчёта с фактом |
| R3-4 | major | Инструментам в transition нужны две пары credentials (Basic-барьер + named account) | **Принято** → env: `EASYUI_LEGACY_BASIC_AUTH` (внешний барьер) + `EASYUI_USERNAME`/`EASYUI_PASSWORD` (аккаунт); Basic шлётся на login и далее, cookie после login; интеграционный тест `/author`+`/deploy` при обоих слоях |
| R3-5 | major | После revoke `/share/p/**` отдаст 200 (SPA fallback), а не 404/410 | **Принято** → неавторизованные `/share/p/**` обрабатываются до SPA fallback → 404; e2e: повторный вход по token-URL и reload exchanged-URL после revoke |
| R3-6 | major | `archived→private` выводит unrenderable-прототип в недоступное состояние | **Принято** → `archived→private` запрещён при `classifyRevision(head).renderable=false` → typed 409; тесты: v15-архивированный head (409) и обычный renderable-архив (ok) |
| R3-7 | major | Bump `styleContractVersion` — не рабочий fallback (нет pin'а у publishes) | **Принято** → CSS-эквивалентность — жёсткий release-gate B: при недоказанной эквивалентности v1 compat-CSS остаётся (bump/multi-contract — вне скоупа); манифест сравнения сохраняет порядок правил, layers/media и cascade |
| R3-8 | minor | Custom-ревизии в retired DS зависят от wireframe/shadcn spacing scale | **Принято** → shadcn/wireframe spacing scales фиксируются как legacy-compatibility данные в `spacingScale.ts`; тест custom-only wireframe-ревизии, пережившей v15 |
| R3-9 | minor | `validate:templates` (B3) требует starter-фикстуру из B4 | **Принято** → декларативная starter-фикстура (TSX+DS) создаётся в B3; B4 добавляет только API-provisioning/setup |

---

## Workstream A — мультиюзерность

### A.0 Архитектурные решения

- Пароли: `Bun.password.hash/verify` (argon2id). Сессии: `user_sessions`, в БД SHA-256 digest токена; cookie `easyui_session` (`__Host-` в проде) HttpOnly, `SameSite=Lax`, `Secure` при https, TTL 30 дней, cap на пользователя + cleanup протухших.
- **Принципал-модель** (находки #5, R2-4): `Anonymous | User {userId,name,isAdmin} | Share(scope) | Capture(scope)`; резолвится один раз в `createHandler`, path-aware порядок: Capture(match) → Share(match) → User → Anonymous — валидный, но не подходящий к пути share-cookie не перекрывает User-сессию. Endpoint-матрица — приложение к `docs/server-api.md`. Anonymous-доступ: статика-allowlist (по резолвнутому физическому файлу; SPA-fallback на index.html разрешён для route-путей, **кроме** неавторизованных `/share/p/**` — они обрабатываются до fallback и отдают 404, находка R3-5), `GET /api/health`, `POST /api/auth/login`, `GET /share/:token`. Share/Capture — exact GET/HEAD allowlist своего скоупа, работают и для private/archived ресурсов скоупа.
- CSRF/hardening (находка #13): Origin-check на unsafe-методы, login rate-limit + dummy-verify, лимиты длины, валидация `next`.
- BASIC_AUTH как механизм приложения удаляется; **переходно** сервер поддерживает опциональный внешний Basic-барьер поверх сессий (env `LEGACY_BASIC_AUTH`, удаляется после B) — совместимость compose/rollback (находка #7). Инвариант старта: non-loopback требует существующего admin или `ADMIN_*`-env.
- Порядок старта (находка #9): migrate → `ensureBootstrapAdmin` (id `user_admin`, транзакционно: upsert админа + бэкфилл `owner_id IS NULL` во всех трёх таблицах) → seed(owner=admin). Смена bootstrap-пароля отзывает его сессии.
- Статика: публичный allowlist (находка #14); остальное (включая `dist/storybook` до B) — за сессией. Session-API ответы: `Vary: Cookie`, `private`/`no-store`.
- Видимость прототипа — колонка `status: private | published | archived`, ортогональна version-publish. Серверный граф переходов (находки R2-9, R3-6): `private↔published`, `private|published→archived`, `archived→private` — только; `archived→private` запрещён (typed 409) при нерендерабельном head; version-publish не меняет status. Матрица доступа: owner — всё; не-владелец при `published` — GET meta/draft-doc/versions/render-status (play/present/CJM), **без** revisions/diff/figma; мутации — 403; `private|archived` не-владельцу — 404. Screenshot/visual-мутации — owner-only; list/usage assets и visual-артефактов фильтруются по видимости (находка #8), bytes глобальны (задокументировать).
- Каталог: `owner_id` у components/design_systems; чтение глобально; мутации owner-only; attach/move/publish компонента в DS — **конъюнкция**: владелец компонента И владелец DS (или admin) (находки #11, R2-8); статус-переходы, ломающие запиненные bundles, — только admin.
- DTO-проекция по принципалу (находка R2-8): figma-поля отсутствуют (не `null`) в meta/draft/version для всех не-owner принципалов (включая Share/Capture).
- Audit (находки #18, R2-14): таблица `audit_events (id, at, actor_id, action, subject_type, subject_id, detail)`; system-actor для миграций. Смена владельца и удаление пользователей — вне скоупа.
- **Ветки/деплой (находка R2-13)**: вся работа в feature-ветке; в `main` (автодеплой!) — два атомарных пуша: после полного A.4 и после полного B.4.

### A.1 Волна 1 — migration runner + серверное ядро auth

Задача **A1-0 (первой, отдельным коммитом)**: переписать runner в `server/migrations.ts` (находка #1) — последовательное исполнение индексов ≥13, `user_version` после каждой; тесты переходов и crash/retry.

Задача A1-1 — auth-ядро. Файлы: `server/migrations.ts` (v14), `server/auth.ts` (переписать под принципалы/сессии), `server/main.ts`, новые `server/users.ts`, `server/routes/auth.ts`, `server/routes/users.ts`, `server/contracts.ts`, `server/seed.ts` (owner), OpenAPI, `docs/server-api.md` (auth + threat model + endpoint-матрица). Сюда же — **общий auth-harness для существующих ~47 `createHandler`-тестов** (находка R2-10): `server:test` должен быть зелёным уже после A1.

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
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, actor_id TEXT NOT NULL,
  action TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  detail TEXT);
```

`owner_id` nullable в схеме; NOT NULL обеспечивают бэкфилл + startup-проверка.

API: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST/GET /api/users` (admin). 401 — JSON без `WWW-Authenticate`.

Done: `npm run server:test`; тесты login/logout/me/bootstrap/rate-limit/Origin-check; отказ старта без админа на non-loopback; матрица anonymous-доступа.

### A.2 Волна 2 — ownership/visibility на API

Файлы: `server/repos/prototypes.ts`, `server/routes/prototypes.ts`, `server/repos/components.ts`, `server/routes/components.ts`, `server/routes/designSystems.ts`, `server/share/repo.ts`, `server/routes/share.ts`, `server/routes/screenshots.ts`, `server/routes/visual.ts`, `server/routes/assets.ts`, `server/repos/assets.ts`, тесты.

- Принципал во все route-модули (единая сигнатурная правка).
- `PrototypeRepo.list(principal)`: свои все + чужие `published` (+`owner {id,name}`, `status` в DTO).
- Не-владельцу: meta/draft-doc/versions/render-status; `revisions/diff/restore/figma` — 404/403 (owner-only). Share/Capture-принципалы читают свой скоуп независимо от status.
- `POST /api/prototypes/:id/status {status}` — owner-only, actor в audit, серверная валидация графа переходов (A.0); cross-product тесты status × version-publish (находка R2-9).
- Components/DS: owner-мутации; DS-права на attach/publish; admin-only опасные статус-переходы.
- Assets/visual/screenshots: фильтрация list/usage, owner-гейт мутаций.

Done: server-тесты матрицы (principal × статус × метод); тесты DTO-проекции (figma отсутствует у не-owner).

### A.3 Волна 3 — фронтенд (последовательно: A3-1 → A3-2)

**A3-1 auth-инфраструктура**: `src/api/client.ts` (auth-функции, DTO, 401 → `/login?next=…` с same-origin-валидацией, кроме share-роутов), `src/app/routes.tsx` (`/login`, `/users`), новый `src/auth/`, Layout (имя + «Выйти»), `/users` (admin).

**A3-2 галерея/гварды**: `src/gallery/GalleryPage.tsx` — табы «Мои / Общие / Архив» (chokepoint `filterAndSortPrototypes`); карточные контролы владельца (Опубликовать/Снять, В архив/Вернуть; паттерн `src/library/statusBadge.ts`); бейдж владельца; guard чужого `/p/:id/edit` (находка #19); Library — owner-гейт мутационных контролов.

### A.4 Волна 4 — compatibility-релиз + e2e + docs + прод-деплой A

Задача **A4-0 — compatibility release** (находка R2-3): сервер принимает старый `BASIC_AUTH` как deprecated-алиас `LEGACY_BASIC_AUTH`; `docker-compose.yml` и `.env.example` — в скоупе (снять `:?`-требование); `docker compose config` и старт проходят и со старым env-only, и с новым. Bypass внешнего Basic-барьера: health, share exchange + share-scope, capture-scope; login и статика — за барьером на переходный период. `BASIC_AUTH` в Dokploy сохраняется до конца rollback-window (rollback-image его требует); удаление — отдельным cleanup-релизом после B.

- `playwright.config.ts`: `ADMIN_NAME/ADMIN_PASSWORD` во все webServer; per-project setup + `storageState`, login через base-origin каждого проекта; **dev API-запросы — через project baseURL/Vite-proxy или отдельный залогиненный `127.0.0.1:8787`-контекст** (host-only cookie не пересекает хосты, находка R2-10); share-спеки остаются anonymous-контекстом с отдельным owner-API-контекстом (не маскировать share-проверку storageState'ом); auth-preview — собственная API-фикстура вместо seed `hello-world`.
- Checked-in инструменты на login+cookie jar+Origin: `.claude/skills/author/driver.mjs`, `scripts/w6-yandex-pay.mjs`, perf-скрипт (находка R2-10). Две пары credentials на переходный период (находка R3-4): `EASYUI_LEGACY_BASIC_AUTH` (внешний барьер, шлётся и на login) + `EASYUI_USERNAME`/`EASYUI_PASSWORD` (named-аккаунт → cookie); интеграционный тест инструментов при обоих включённых слоях.
- Спеки: login-flow, табы, публикация/архив, principal-матрица (API), share поверх session-auth.
- Docs: `docs/server-api.md` (auth, threat model, матрица), `CLAUDE.md`, скиллы `/deploy` и `/author` (auth-часть).
- Прод (единый атомарный push после всей A, находка R2-13): restore-drill v14 на копии прод-БД → WAL-consistent бэкап (пара image+snapshot) → env в Dokploy (`ADMIN_*`, `BASIC_AUTH` остаётся) → push → верификация по `/deploy` (health, `docker compose config`, логин, старые прототипы published под админом, share-ссылки, скриншоты) → создать пользователей.

---

## Workstream B — удаление встроенных компонентов

### B.0 Архитектурные решения

- **Три категории вместо «host primitives» (находка #4)**: reserved names; extraction-примитивы (только Overlay — вырезается в overlay-слой); **host content types** — Image и Hotspot: обычные компоненты дерева, поставляются хостом, всегда мерджатся в каталог, Hotspot проходит существующий canvas-splitter, Image рендерится в потоке. Wireframe-Image (другие props) не переносится — его прототипы архивируются. **Порядок мерджа в переходный период B1–B2 (находка R2-5)**: host content types первыми, builtin definitions поверх (живой wireframe-Image не подменяется); финальный host-only порядок включается в B3. Классификация renderability различает host-Image и wireframe-Image по props-контракту, не по имени (находка R2-2).
- CSS-контракт (находки #15, R2-12, R3-7): перед удалением `@json-render/shadcn` детерминированно сгенерировать и закоммитить compat-CSS в `src/styles/` + манифест, сохраняющий порядок правил, layers/media и cascade (не множество селекторов); pre/post-build сравнение; визуальная light/dark проверка реально опубликованного yandex-pay. Эквивалентность — **жёсткий release-gate B**: при недоказанной эквивалентности v1 compat-CSS остаётся в бандле (бамп styleContractVersion не является fallback — у publishes нет pin'а стиль-версии).
- `design_systems`: provider сохраняется, добавляется `retired` (находки #12, R2-6). Read-модели: `listActiveDesignSystems` (выбор/manifest/capabilities), `getIncludingRetired` (старые DTO, immutable theme-versions), `requireActiveDesignSystem` (create/save, attach/move/publish, PATCH theme). Startup-инвариант provider'а (находка R2-1): не-retired provider обязан резолвиться; неизвестный provider допустим только при `retired=1`. Защита от новых ссылок на retired DS (находки R2-15, R3-2): `BEFORE INSERT`/`BEFORE UPDATE OF design_system` triggers в v15 (prototypes/components/component_revisions; prototype_revisions — через parent), startup проверяет наличие triggers; SQL-дефолты `'shadcn'` не перестраиваем. Empty-state = «нет usable active components», а не «нет active DS» (`yandex-pay` создаётся v3 с `builtin_provider=NULL` и остаётся активной).
- Renderability (находки #3, R2-2, R2-7, R3-1): единая `classifyRevision(prototypeId, rev)` по exact doc + exact pins (host type с совместимыми props / запиненный custom с renderable bundle); props-совместимость — directive-aware, той же семантикой, что `validateElementProps` (подстановка `$asset`/`$state`/`$cond` до parse). DTO получает `renderable`/typed error; единый gate в `src/player/PrototypeLoader.tsx` до загрузки бандлов и создания runtime; заглушка «прототип в архиве» — в авторизованных вьюхах (Player/Present/CJM/Gallery/Capture/Editor); **revoked share → 404/410**, без заглушки.
- `builtin_catalog_hash` — контракт (находка R2-11): legacy-значения immutable (не пересчитываются), новые ревизии получают детерминированный hash host-каталога/actions/space; capture/visual-инварианты продолжают работать на старых значениях.
- Seed удаляется; фикстурные JSON переезжают в `test/fixtures/` для unit-тестов (находка #16), затем переавторинг. `validate:prototypes` → `validate:templates` (находка #17). Storybook удаляется полностью. `DEFAULT_DESIGN_SYSTEM_ID` умирает; строгая input-схема требует `designSystem`, толерантная stored-схема сохраняет default для чтения старых ревизий (находка #6).
- cjmRegistry shadcn/Dialog-хак и name-based Link-семантика удаляются; name-based остаётся только для Image/Hotspot.

### B.1 Волна 1 — host content types (совместимо с живыми builtins)

Файлы: `src/catalog/hostPrimitives/**` (переименование/структура: extraction vs content), перенос `hotspot.tsx`/`hotspot.definition.ts`, нейтральный `image.tsx` (без shadcn-токенов), `src/catalog/builtinSemantics.ts`, `src/catalog/runtime.ts` (переходный порядок мерджа: host первым, builtin поверх), `src/prototype/validate.ts` (isCustomType, custom-гейты), `src/prototype/runtimeSpec.ts` (extraction — только Overlay), `server/builtinHash.ts`, тесты cross-surface (player/present/capture/gallery/CJM/editor, desktop-flow) + тест неизменности живого wireframe-Image (находка R2-5).

### B.2 Волна 2 — сервер + миграция v15

Файлы: `server/designSystems.ts` (read-модели active/retired), `server/migrations.ts` (v15; снять `assertBuiltinNamesDoNotCollide`, заменить provider-инвариант, добавить retired-инвариант вставок), `server/seed.ts` (удалить) **+ импорт/вызов `seedPrototypes` в `server/main.ts`** (находка R2-11), `server/routes/components.ts` (импорт `DEFAULT_DESIGN_SYSTEM_ID`, shadcn-default при create/move), `server/validation.ts`, `server/repos/prototypes.ts` + `server/routes/prototypes.ts` (classifyRevision/renderable в DTO), `server/routes/designSystems.ts` (retired), `server/routes/meta.ts`, `prototypes/` → `test/fixtures/`, тесты (включая старт финального B-кода на БД 0→15 и populated 14→15).

Миграция **v15** (после v14):

```sql
ALTER TABLE design_systems ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
UPDATE design_systems SET retired=1 WHERE builtin_provider IS NOT NULL;
-- дальнейшее — кодом миграции (не голым SQL):
--   classifyRevision(head) для каждого прототипа → нерезолвимые → status='archived'
--   каждый активный share_grants.rev классифицируется независимо:
--     нерезолвимый rev → revoked_at + удаление его share_sessions
--     (renderable custom-grant архивированного прототипа сохраняется — решение «шары живут»)
--   dry-run режим: отчёт (архивируемые прототипы, отзываемые grants) без мутаций — обязательный
--   прогон на копии прод-БД до релиза, сверка counts при деплое
```

Инструментарий (находка R3-3): CLI `migration:v15:report` — открывает SQLite **без** `openDatabase`/`migrate` (иначе копия немедленно мигрирует), выдаёт structured JSON с точными prototype/grant ID и counts; triggers против retired-вставок (находка R3-2).

(`yandex-pay` создана v3 с `builtin_provider=NULL` — под `retired=1` попадают только shadcn/wireframe; классификация прототипов идёт по документам и пинам, не по полю `design_system`.)

### B.3 Волна 3 — фронтенд-чистка + Storybook (одна задача, последовательно; конфликт по package.json — находка #17)

- Runtime/DS: `src/catalog/runtime.ts` (каталог = custom + host types + Overlay, финальный host-only порядок мерджа), `src/catalog/definitions.ts` (реэкспорт shadcn — удалить, находка R2-11), `src/designSystems/index.ts` (снос shadcn/wireframe, `DEFAULT_DESIGN_SYSTEM_ID`; зачистка потребителей: `CjmView`, `cjmRegistry`, `EditorView`, `screenshot/service`, `share/repo`, `?? "shadcn"`-fallback-и), удаление `src/designSystems/shadcn|wireframe`, `@json-render/shadcn` (после фиксации CSS-снапшота с манифестом эквивалентности), `src/catalog/fixtures.ts`; фронтовый renderable-gate в `src/player/PrototypeLoader.tsx` + заглушка у потребителей (`PlayerShell`, `PresentShell`, CJM, Gallery, Capture, Editor) (находка R2-7).
- Галерея/библиотека: `prototypeTemplates.ts` (шаблон Image+Hotspot), create-dialog + empty-state (CTA «создать дизайн-систему»), `LibraryPage.tsx` (только custom), удаление `.storybook/`, stories, `storybookIndex.ts`, `check-storybook-drift`.
- Inventory (находка #17): `package.json` (scripts/deps, `build` без storybook), `vite.config.ts` (storybook-proxy), `playwright.config.ts`, `scripts/perf-gallery-dataset.ts`, `src/smoke/SmokeSpec.tsx`, `public/design/cjm-ui`, README, `CLAUDE.md`, скиллы `/verify` и `/author` (референс-каталог на custom).
- Legacy spacing scales (находка R3-8): shadcn/wireframe scale-значения фиксируются как compatibility-данные в `src/designSystems/spacingScale.ts` (custom-ревизии в retired DS сохраняют геометрию); тест custom-only wireframe-ревизии.
- Декларативная starter-фикстура (TSX-компоненты + DS-описание) создаётся здесь, в B3 (находка R3-9) — `validate:templates` в `npm run verify` валидирует её сразу; B4 добавляет только API-provisioning.

### B.4 Волна 4 — e2e re-author + прод-деплой B

- API-provisioning starter-фикстуры из B3: `e2e/starter-ds.fixture.ts` (DS `e2e-starter` + Button/Text/Stack-подобные TSX), публикация через API под админом; setup-проекты для dev, preview (новый) и auth-preview.
- Переавторинг спеков на starter-DS + Image/Hotspot; удаление storybook/restyle-спеков; тесты legacy-заглушки (unrenderable) и retired-DS.
- Прод (единый атомарный push после всей B): candidate image из feature-ветки под SHA-тегом без `latest`/deploy (правка `build-image.yml`, находка R3-3) + запуск через compose-override на restored volume → restore-drill v15 + dry-run отчёт (`migration:v15:report`) → **enforced read-only maintenance window** → WAL-consistent бэкап (пара image+snapshot) → push → верификация: `docker compose config`, сверка v15 impact counts с dry-run, yp-прототипы рендерятся/published, builtin-прототипы в «Архиве» с заглушкой, их share-ссылки отозваны (404), yp-шары живы, создание прототипа предлагает только active DS, `/library` без Storybook. После стабилизации — отдельный cleanup-релиз: удалить `LEGACY_BASIC_AUTH`/`BASIC_AUTH` из compose/env.

---

## Верификация

Каждая волна: `npm run typecheck && npm run server:typecheck && npm run lint && npm run test -- --run && npm run server:test`; после изменений API — `verify:openapi`; после B3 — обновлённый `npm run verify`; после A.4/B.4 — `npm run e2e` + runtime-прогон по `/verify`. Волны коммитятся в **feature-ветку**; в `main` — только два атомарных пуша (после A.4 и после B.4), перед каждым: restore-drill миграций на копии прод-БД, `docker compose config`, старт финального image на restored DB. Деплой — по `/deploy`.

## Остаточные риски

1. Same-origin вредоносный компонент обходит CSRF и читает данные — покрыто принятой threat model (доверенные аккаунты).
2. CSS-снапшот shadcn — замороженный артефакт; новые custom-компоненты должны нести свои стили (уже так для yp v2).
3. Forward-only миграции: откат B возможен только парой image+snapshot в пределах maintenance window.
4. `components.name` остаётся глобально уникальным — межпользовательские коллизии имён решаются социально (доверенная команда).

## Процесс

1. План v3 закоммичен; повторный раунд Codex-ревью (`--resume` того же треда) до отсутствия блокеров.
2. Исполнение: Codex-задачи `--fresh --write --effort medium` по волнам; оркестратор независимо верифицирует done-критерии, коммитит по зонам; финальный проход `npm run verify` + `npm run e2e` + `/verify`.
