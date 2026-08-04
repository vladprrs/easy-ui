# Bun Server API

Локальный Bun-сервер — единственный источник данных для галереи и плеера. Он хранит прототипы и пользовательские React-компоненты в SQLite, раздаёт API, а при `SERVE_DIST=dist` также SPA и Storybook-статику.

## Auth, сессии и принципалы

Именованные аккаунты используют парольные hash’и Argon2id (`Bun.password`) и opaque cookie-сессии. В SQLite хранится только SHA-256 digest токена. Сессия живёт 30 дней; сервер удаляет протухшие записи и оставляет не более 10 активных сессий на пользователя. Cookie называется `easyui_session` в HTTP dev-режиме и `__Host-easyui_session` при HTTPS; атрибуты: host-only, `Path=/`, `HttpOnly`, `SameSite=Lax`, а при HTTPS также `Secure`. Все session-API ответы имеют `Vary: Cookie` и `Cache-Control: private, no-store`. Ответ приложения `401` — JSON без `WWW-Authenticate`.

Bootstrap выполняется в порядке migrate → admin/backfill → seed. `ADMIN_NAME` и `ADMIN_PASSWORD` создают или обновляют стабильного администратора `user_admin`; изменение bootstrap-пароля отзывает его сессии. В той же транзакции пустые `owner_id` прототипов, компонентов и дизайн-систем получают admin-владельца. Запуск без администратора запрещён; для non-loopback bind администратор должен уже существовать или быть задан обеими переменными. `LEGACY_BASIC_AUTH` — опциональный внешний compatibility-барьер поверх cookie-сессий, а не аккаунт приложения. Переходно старое имя `BASIC_AUTH` принимается как deprecated-алиас с warning в логах; если заданы оба, приоритет у `LEGACY_BASIC_AUTH`. Health, share exchange/share scope и capture scope обходят внешний барьер; login и статика остаются за ним.

Сервер один раз на запрос выбирает принципал в path-aware порядке: `Capture(scope)` → `Share(scope)` → `User {userId,name,isAdmin}` → `Anonymous`. Capture/share учитываются только когда их credential валиден и текущий `GET`/`HEAD` входит в exact scope. Поэтому валидная share-cookie для другого пути и невалидный capture bearer не перекрывают рабочую user-сессию.

Все unsafe-методы требуют same-origin `Origin`, независимо от типа тела (включая multipart). Login ограничивает длину имени/пароля, валидирует `next` как относительный same-origin путь, rate-limit’ится и выполняет dummy Argon2 verify для неизвестного имени.

| Endpoint / ресурс | Anonymous | User | Share(scope) | Capture(scope) |
|---|---:|---:|---:|---:|
| `GET /api/health` | да | да | да | да |
| `POST /api/auth/login` | да | да | только как anonymous-route | только как anonymous-route |
| `POST /api/auth/logout`, `GET /api/auth/me` | нет | да | нет | нет |
| `POST /api/users`, `GET /api/users`, `PATCH /api/users/:id` | нет | только admin | нет | нет |
| `GET /share/:token` | да | да | да | да |
| Scoped immutable GET/HEAD | нет | да | exact share scope | exact capture scope |
| Prototype meta/draft/versions/render-status | нет | owner; чужой только published | exact prototype scope, любой status | exact capture scope, любой status |
| Prototype revisions/diff/restore/figma и мутации | нет | только owner (чужой published → 403, private/archived → 404) | нет | нет |
| Components/design systems: чтение | нет | да | только если входит в scope | только если входит в scope |
| Components/design systems: мутации | нет | owner или admin; attach/move/publish требует владения обоими ресурсами | нет | нет |
| Assets list/usage, visual list | нет | только достижимые из видимых ресурсов | только exact scope | только exact scope |
| Остальной API | нет | да | нет | нет |
| `index.html`, hashed chunks, favicon, fonts, SPA route fallback | да | да | в scope сборки | в scope сборки |
| Прочая статика, включая `dist/storybook` | нет | да | нет | нет |

Неавторизованный `/share/p/**` обрабатывается до SPA fallback и возвращает 404. Это сохраняет revoke-семантику share-ссылки.

Endpoints auth (здесь и далее API-пути могут быть показаны без общего `/api`):

| Метод и путь | Тело / ответ |
|---|---|
| `POST /auth/login` | `{name,password,next?}` → `{user:{userId,name,isAdmin},next?}` + session cookie |
| `POST /auth/logout` | revoke текущей сессии, очистка cookie, 204 |
| `GET /auth/me` | `{userId,name,isAdmin}` |
| `POST /users` | admin-only `{name,password,isAdmin?}` → 201 `{id,name,isAdmin,createdAt}` |
| `GET /users` | admin-only `{users:[...]}` |
| `PATCH /users/:id` | admin-only `{isAdmin}` → `{id,name,isAdmin,createdAt}`; bootstrap-админа `user_admin` понизить нельзя (409) |

## Trust boundary и threat model

Все аккаунты считаются доверенными операторами. Пользовательский TSX исполняется publish-pipeline с правами серверного процесса и исполняется same-origin в браузерах всех пользователей. Песочницы нет. Разделение владельцев и приватность защищают от случайного просмотра и ошибочных действий, но не от злонамеренного коллеги с аккаунтом. Same-origin вредоносный компонент может читать данные и выполнять мутации от лица открывшего его пользователя; cookie/Origin-защита не меняет эту границу доверия.

## Модель версий

Каждое сохранение создаёт неизменяемую ревизию `rev`; `headRev` указывает на текущий draft. Restore копирует старую ревизию в новую. Publish не копирует данные, а присваивает текущей ревизии последовательное имя `version` (v1, v2, …); одну ревизию нельзя публиковать дважды.

При каждом сохранении прототипа сервер разрешает используемые кастомные типы в последние active-версии и записывает точные пины `(componentId, version)`. Поэтому последующий publish компонента не меняет старый draft или опубликованный прототип. Publish компонента проходит состояния `staging → active` либо `staging → failed`; staging/failed невидимы манифесту, новым пинам и bundle endpoint. После рестарта незавершённые staging-записи становятся failed.

Все пути ниже имеют префикс `/api`. JSON-ответы, кроме immutable-ресурсов, имеют `Cache-Control: no-store`. Поля `message` необязательны. Все мутации существующего ресурса требуют `baseRev`.

## Endpoints прототипов

| Метод и путь | Тело / ответ |
|---|---|
| `GET /prototypes?kind=` | свои прототипы любого статуса + чужие `published`; `PrototypeListItem[]`: `{id,name,description?,device,designSystem,screenCount,flowCount,headRev,latestVersion,status,owner:{id,name},updatedAt,kind,tags,derivedFrom,track}`; `kind` — CSV-фильтр по видам (см. [Lifecycle](#lifecycle-прототипа)) |
| `POST /prototypes` | `{doc,message?,kind?,tags?,derivedFrom?}` → 201 `{id,rev,warnings,screens}` и `Location` |
| `GET /prototypes/:id` | `{id,name,designSystem,headRev,latestVersion:number|null,versions:PrototypeVersion[],updatedAt,draftRevision,validatedRevision,publishedVersion,renderable,kind,tags,derivedFrom,track}` |
| `GET /prototypes/:id/draft` | `{doc,rev,builtinCatalogHash,componentManifestHash,components:ComponentPin[],compositions:CompositionPin[],assets:AssetPin[]}` |
| `GET /prototypes/:id/screens/:screenId/render-status?version=n\|rev=n` | Готовность экрана к рендеру — см. [Render status](#render-status) |
| `PUT /prototypes/:id` | `{doc,message?,baseRev}` → `{rev,warnings,screens}`; `doc.id` обязан совпадать с `:id` |
| `DELETE /prototypes/:id` | `{baseRev}` → 204; hard delete с каскадом ревизий |
| `GET /prototypes/:id/revisions?limit&before` | `{rev,message:string|null,createdAt}[]`; `limit` по умолчанию 20, максимум 100 |
| `GET /prototypes/:id/revisions/:rev` | `{rev,doc,components:ComponentPin[],compositions:CompositionPin[],assets:AssetPin[],message:string|null,createdAt}` |
| `GET /prototypes/:id/revisions/:rev/diff?against=n` | Структурный diff ревизий; без `against` сравнивает с `rev-1` |
| `POST /prototypes/:id/restore` | `{rev,baseRev}` → `{rev}` (номер новой head-ревизии) |
| `GET /prototypes/:id/readiness` | Ready-to-publish отчёт головной ревизии — см. [Готовность к публикации](#готовность-к-публикации) |
| `POST /prototypes/:id/repin?dryRun=1` | owner-only; пере-сохраняет head-документ, чтобы пины ушли на последние active-публикации → `{dryRun,rev,before,after,changed:[{component,from,to}]}` |
| `POST /prototypes/:id/publish` | `{message?,baseRev,force?}` → 201 `{version,rev,screens}` и `Location`; включённый гейт готовности → `409 publish_blocked` |
| `POST /prototypes/:id/status` | owner-only `{status:"private"|"published"|"archived"}`; граф `private↔published`, `private|published→archived`, `archived→private` |
| `POST /prototypes/:id/lifecycle` | owner-only `{kind?,tags?,derivedFrom?,track?}` → `{kind,tags,derivedFrom,track}`; аддитивный патч, см. [Lifecycle](#lifecycle-прототипа) и [Head-tracking](#head-tracking-служебных-прототипов) |
| `GET /prototypes/:id/versions` | `PrototypeVersion[]`: `{version,rev,publishedAt}` |
| `GET /prototypes/:id/versions/:version` | `{version,rev,doc,builtinCatalogHash,componentManifestHash,components:ComponentPin[],compositions:CompositionPin[],assets:AssetPin[],publishedAt}`; immutable |
| `POST /prototypes/:id/share` | `{version,ttlSeconds}` → 201 `{id,prototypeId,version,url,createdAt,expiresAt,activeSessions}`; bearer-token присутствует только в одноразово возвращённом `url` |
| `GET /prototypes/:id/share` | `{shares: ShareGrant[]}` — только активные/неистёкшие grants, без bearer-token |
| `DELETE /prototypes/:id/share/:shareId` | 204; revoke grant и всех выданных им sessions |

`PUT /prototypes/:id` — это осознанный checkpoint, а не no-op. Даже если `doc` не изменился, успешный запрос с актуальным `baseRev` создаёт новую ревизию: сервер заново разрешает и фиксирует пины active custom-бандлов, текущей версии темы дизайн-системы и ассетов, а также сохраняет переданный `message`. CAS по `baseRev` действует как обычно. Сервер намеренно не дедуплицирует такие ревизии, потому что повторное сохранение выражает явное решение зафиксировать актуальное окружение документа.

`ComponentPin` — `{id,name,version,bundleUrl,bundleHash,status}` (`status` — статус публикации закреплённой версии, аддитивно добавлен волной 3). `CompositionPin` — `{id,name,version,sourceHash,doc}` (пины ревизии из `prototype_revision_compositions` вместе с замороженным документом композиции; клиент раскрывает по ним авторский документ — см. [Композиции](#endpoints-композиций)). `AssetPin` — `{id,sha256,mime,size}` (пины ревизии из `prototype_revision_assets`; см. [Ассеты](#ассеты)). `componentManifestHash` — SHA-256 канонически отсортированных пинов. `builtinCatalogHash` вычисляется отдельно для системы из документа ревизии и идентифицирует её render/validation-контракт. Дескриптор включает обязательный `renderContractVersion` (сейчас `4`), actions, имена/descriptions/events/slots, input JSON Schema пропсов, `layout`/`layoutNeutral`, host-примитивы, включая `@eui/FlowRoot`, и resolved spacing scale из **pinned** `design_system_meta_version`. Restore копирует версию темы исходной ревизии, поэтому восстанавливает и соответствующий hash. Хеш остаётся детектором несовместимости, а не pin: рантайм не сравнивает и не блокирует mismatch.

### Lifecycle прототипа

Миграция **v16** добавила в `prototypes` три колонки: `kind TEXT NOT NULL DEFAULT 'product-flow'`, `tags TEXT` (JSON-массив slug'ов, `NULL` == тегов нет) и `derived_from TEXT`. Изменение аддитивное: строки, созданные до миграции, читаются как `product-flow` с пустыми тегами, а клиент, который никогда не шлёт `kind`, работает как раньше.

`kind` ∈ `product-flow | composition-fixture | component-gallery | evidence | visual-reference | experiment`.

- Значения перечислены **только** в контракте (`prototypeKindSchema` в `server/contracts.ts`, построен из `PROTOTYPE_KINDS` в `src/api/client.ts`). Колонка намеренно **без** `CHECK`: SQLite принял бы column-level `CHECK` в `ADD COLUMN`, но тогда любое расширение таксономии потребовало бы полной перестройки таблицы. Точка контроля — zod на входе API; запись мимо API (ручной SQL, миграции) не проверяется.
- `tags` — до 16 уникальных slug'ов (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤ 32 символов).
- `derivedFrom` — id прототипа-источника, до 128 символов. **Без FK и без проверки существования**: линия происхождения переживает удаление источника. Запрещена только ссылка на самого себя (`422 validation_failed`).

`POST /prototypes/:id/lifecycle` — owner/admin (та же authz, что у `/status`), тело `strictObject` `{kind?,tags?,derivedFrom?,track?}`:

- отсутствующее поле не меняется; `derivedFrom: null` очищает связь; `tags: []` очищает теги;
- пустое тело `{}` — read-back без записи и без audit-события;
- успешная запись бампает `updated_at` и пишет audit `prototype.lifecycle.changed`; дополнительно смена `kind` пишет `prototype.kind.changed`, а смена `track` — `prototype.track.changed` (оба с `{from,to}`);
- неизвестный ключ, неизвестный `kind`/`track`, «грязный» тег или > 16 тегов → `422 validation_failed`; не-владелец → `403 forbidden`; отсутствующий прототип → `404 prototype_not_found`; любой метод, кроме POST → `405`;
- переход в служебный `kind` при наличии опубликованных версий → `422 service_kind_requires_unpublished`: `kind` мутабелен и снимает архитектурные линты и readiness-порог, поэтому задним числом «расслабить» уже опубликованный поток нельзя.

`GET /prototypes?kind=` фильтрует список: значение — **CSV** (`?kind=evidence,experiment`); повторение параметра не поддерживается (побеждает последнее вхождение). Пустое значение (`?kind=`) означает «фильтра нет». Неизвестный вид в списке → `422 validation_failed`.

Галерея использует ту же таксономию: служебные виды (`composition-fixture`, `component-gallery`, `evidence`, `visual-reference`) скрыты из табов «Мои»/«Общие» и живут в табе «Служебные»; `derivedFrom` показывается строкой на карточке.

#### Head-tracking служебных прототипов

Миграция **v22** добавила `prototypes.track TEXT NOT NULL DEFAULT 'pinned'` — ещё одну lifecycle-колонку рядом с `kind`/`tags`/`derived_from`. Формат документа (allowlist v1) и `documentVersion` не тронуты: `track` намеренно **не** поле документа, иначе строгая схема старого образа перестала бы читать сохранённые ревизии при откате. `CHECK` у колонки нет — точка контроля контрактная (`prototypeTrackSchema`), как у `kind`.

`track ∈ pinned | head`:

- `pinned` (по умолчанию, и семантика всех доков до миграции) — ревизия рендерит закреплённые пины;
- `head` — read-пути резолвят **компонентные** пины ревизии на последние `active`-публикации тех же компонентов. Компонент без единой active-публикации остаётся на пине ревизии.

Ставится **только** `POST /prototypes/:id/lifecycle` и только при двух условиях: служебный `kind` (`component-gallery`, `evidence`, `visual-reference`, `composition-fixture`) и отсутствие опубликованных версий. Нарушения — `422 track_requires_service_kind` и `422 track_requires_unpublished`.

**Скоуп резолва — только компоненты.** `designSystemMetaVersion` (а с ним производный `builtinCatalogHash` и allowlist ассетов темы) остаётся пином ревизии: после PATCH темы трекающий док по-прежнему требует пересохранения. Расширение резолва на тему — вне текущего контракта.

**Что резолв меняет в ответах.** DTO ревизии, черновика и версии additively несут `track` и `resolvedAt`: `resolvedAt` — момент резолва head-пинов, `null` у обычных (`pinned`) доков, где пины иммутабельны и «момента резолва» нет. `components[]` и производный `componentManifestHash` считаются из уже резолвнутого списка, поэтому плеер, `render-status`, readiness и capture видят один и тот же набор. Иммутабельность `GET /prototypes/:id/revisions/:rev` перестаёт быть инвариантом ровно для трекающих доков — их нельзя ни опубликовать, ни расшарить (см. ниже).

**Съёмка.** `POST /prototypes/:id/screens/:screenId/screenshot` резолвит пины атомарно на enqueue, кладёт их в `expected` **и** в `bootstrap.target`, и поверхность рендерит именно их. Публикация новой версии компонента между постановкой и рендером поэтому не уводит джобу и не ломает exact-match handshake. Разрешённый набор возвращается в ответе постановки как `components[]`.

**Операции, требующие воспроизводимого снимка**, для трекающего дока отвечают `422 prototype_head_tracking` (операция названа в `message`): `POST /prototypes/:id/publish`, создание share-гранта, `PUT /visual-baselines/prototypes/:id` и bundle-export прототипа (`GET /prototypes/:id/export`). Bulk-экспорт `GET /bundles/export` проходит тот же гейт по каждому owned-прототипу, поэтому один трекающий док отклоняет весь запрос. Чтобы выполнить любую из этих операций, верните `track: "pinned"` тем же lifecycle-роутом.

### Готовность к публикации

`GET /prototypes/:id/readiness` (read-доступ) отдаёт отчёт по головной ревизии. Запрос **ничего не запускает**: ни screenshot-job'ов, ни visual-прогонов — только читает уже накопленные данные.

```json
{ "prototypeId": "...", "rev": 12, "generatedAt": "...", "profile": "product",
  "gates": [{ "id": "architecture", "status": "warn", "summary": "architecture_warnings", "...": "детали гейта разложены в тот же объект" }],
  "blocking": [], "publishable": true, "enabledGates": {} }
```

Статусы: `pass | warn | fail | unknown`. `unknown` означает «данных нет» и **никогда** не блокирует публикацию.

**Профиль отчёта.** `profile` — `service` для служебных видов (`component-gallery`, `evidence`, `visual-reference`, `composition-fixture`), `product` для остальных. У служебного профиля порог `warn` включённых гейтов не применяется: блокирует только `fail`. Предупреждения витрины — недостижимый экран, отсутствующий baseline, нет сценариев — не про готовность продукта к публикации, и «зелёный» служебного дока нельзя прочитать как «зелёный» продуктового именно потому, что профиль назван в отчёте. Ниже по стеку то же различие делает валидатор: для служебных видов подавляются ровно два предупреждения `validatePrototype` — «screen is not reachable by navigate actions» и «interactive `<type>` has no event handler and no two-way binding»; остальные предупреждения служебные доки получают как обычно, а архитектурные линты `arch/*` были kind-aware и раньше.

| gate | Источник | Статусы |
|---|---|---|
| `architecture` | `arch/*`-предупреждения `validatePrototype` + `architecture.exempted` | `pass`/`warn`; `unknown`, если определения не разрешились |
| `schema` | `validatePrototype.errors` / не-архитектурные warnings | `fail`/`warn`/`pass` |
| `screens` | `classifyRevision` — документ + бандлы каждого экрана | `pass`/`fail` |
| `assets` | ссылки документа × `assets` × `prototype_revision_assets` | `fail` (нет в реестре) / `warn` (нет пина) / `pass` |
| `pins` | `bundleReadiness` ревизии | `fail`/`warn`/`pass` |
| `deprecated` | пины со статусом `deprecated`/`superseded` + `replacement` компонента | `warn`/`pass` |
| `visual` | последний `visual_baseline_sets` + последние `visual_runs` по его эталонам | `unknown`/`warn`/`fail`/`pass` |
| `capture` | последний screenshot-job, если он персистентен | сейчас всегда `unknown` |
| `interactions` | сценарии прототипа (`prototype_scenarios`, волна 6) | `unknown` (сценариев нет) / `warn` (все сценарии пустые) / `pass` |
| `publishDiff` | наличие diff головы против последней опубликованной версии | `unknown`/`warn`/`pass` |

Гейт `screens` **не** использует флаг `route` из render-status: тот равен `Boolean(SERVE_DIST)` и в dev/тестах/e2e всегда `false`. Route-готовность вынесена в информационное подполе `screens.route = {served, informational:true}`.

Гейт `capture` описан контрактом, но сегодня всегда `unknown`: очередь `ScreenshotService` живёт только в памяти процесса и не пишет результаты в БД. Идентификатор гейта и форма отчёта зафиксированы, чтобы включение персистентности не ломало клиентов.

**Конфигурация.** Единственная переменная окружения `EASYUI_PUBLISH_GATES` — CSV идентификаторов гейтов. Запись `pins` блокирует публикацию при статусе `fail`, запись `screens:warn` — уже при `warn`. Неизвестные идентификаторы игнорируются. **По умолчанию переменная пуста**, поэтому `blocking: []`, `publishable: true` и поведение `publish` в точности прежнее. Так и задумано: publish исторически не валидировал документ, и dry-run по прод-данным (`scripts/readiness-dryrun.ts`) показывает, что включённый гейт `schema` заблокировал бы больше половины прототипов.

**Publish.** `POST /prototypes/:id/publish` считает отчёт в роут-ветке **до** `repo.publish` (та — синхронная транзакция и не может выполнить асинхронный `snapshotDefinitions`), сверяет `report.rev === baseRev` (расхождение → `409 revision_conflict`) и при непустом `blocking` отвечает `409 publish_blocked` с полным отчётом в поле `report` конверта ошибки. `{"force": true}` от владельца/админа проходит гейты и пишет audit-событие `prototype.publish.forced`.

**Repin.** `POST /prototypes/:id/repin` — тонкая обёртка над обычным сохранением головы (`updatePrototypeFromDoc`), которое и так пере-пинует документ на последние active-публикации. Отдельного pin-writer'а нет. `?dryRun=1` считает diff без записи; запись пропускается и когда diff пуст, поэтому повторный вызов не плодит пустые ревизии. Успешная запись пишет audit `prototype.repinned`.

### Сценарии взаимодействия

Записанный в плеере сценарий хранится рядом с прототипом (`prototype_scenarios`, миграция v19) и переигрывается **клиентом** (`src/player/scenarioRunner.ts`). Серверного headless-прогона и таблицы прогонов нет сознательно: флакующий replay не имеет права блокировать публикацию.

| Метод | Путь | Доступ |
|---|---|---|
| `GET` | `/prototypes/:id/scenarios` | read-доступ к прототипу |
| `POST` | `/prototypes/:id/scenarios` | владелец/админ, `201` + `Location` |
| `GET` | `/prototypes/:id/scenarios/:scenarioId` | read-доступ |
| `PUT` | `/prototypes/:id/scenarios/:scenarioId` | владелец/админ (полная замена `name`/`steps`) |
| `DELETE` | `/prototypes/:id/scenarios/:scenarioId` | владелец/админ, `204` |

Тело записи: `{ "id"?: slug, "name": string, "steps": Step[] }`. `id` необязателен — сервер генерирует slug. Шаги (`src/prototype/scenario.ts`, strict-схемы):

```json
[{ "type": "click", "elementKey": "cta", "label": "Продолжить" },
 { "type": "expectScreen", "screenId": "done" },
 { "type": "expectText", "text": "124 бонуса начислены" },
 { "type": "setState", "pointer": "/selected", "value": [1, 2] },
 { "type": "expectState", "pointer": "/count", "value": 5 },
 { "type": "expectDisabled", "elementKey": "sixth-option" }]
```

Лимиты: 200 шагов на сценарий, 50 сценариев на прототип, 120 символов имени. `pointer` — безопасный абсолютный RFC 6901 указатель (те же правила, что у действий рантайма). Сценарии удаляются вместе с прототипом (FK `ON DELETE CASCADE`) и **не** входят в ZIP-бандл экспорта.

`elementKey` — ключ **раскрытого** документа: внутренности композиции адресуются как `<hostKey>$<innerKey>`. Ключи скоупны ревизии, поэтому исчезнувший ключ (или исчезнувший `on.press`) даёт шагу статус `stale`, а не `fail`: раннер отдаёт `{index, status: "pass"|"fail"|"stale", message?}` на шаг, и `stale` не роняет прогон.

### Diff ревизий

`GET /prototypes/:id/revisions/:rev/diff?against=<rev>` сравнивает две разные существующие ревизии; `against` по умолчанию равен `rev-1`. Для ревизии 1 параметр обязателен. Одинаковые номера и отсутствие `against` у rev 1 дают `400 invalid_request`; отсутствующий прототип или ревизия — `404 prototype_not_found` / `revision_not_found`.

Ответ имеет следующую форму; пустые секции и пустые дочерние `added`/`removed`/`changed` либо element-поля опускаются, а map-диффы представлены entry-массивами, поэтому ключи вроде `__proto__` не теряются:

```jsonc
{
  "prototypeId": "checkout",
  "from": {"rev": 1, "message": V, "createdAt": "..."},
  "to": {"rev": 2, "message": V, "createdAt": "..."},
  "doc": [{"key": "name|description|device|designSystem|startScreen", "from": V, "to": V}],
  "state": {"added": [{"key": "...", "value": V}], "removed": ["..."], "changed": [{"key": "...", "from": V, "to": V}]},
  "screens": {
    "added": [{"id": "...", "name": "...", "elementCount": 1}],
    "removed": [{"id": "...", "name": "..."}],
    "changed": [{
      "id": "...",
      "meta": [{"key": "name|note|canvas|root", "from": V, "to": V}],
      "stateOverrides": {"added": [], "removed": [], "changed": []},
      "elements": {
        "added": [{"id": "...", "type": "..."}], "removed": [{"id": "...", "type": "..."}],
        "changed": [{"id": "...", "type": {"from": "...", "to": "..."}, "props": {"added": [], "removed": [], "changed": []}, "children": {"from": V, "to": V}, "on": {"added": [], "removed": [], "changed": []}, "visible": {"from": V, "to": V}, "repeat": {"from": V, "to": V}, "slot": {"from": V, "to": V}, "region": {"from": V, "to": V}}]
      }
    }]
  },
  "screenOrder": {"from": ["..."], "to": ["..."]},
  "pins": {"components": {"added": [{"id": "...", "version": 1}], "removed": [], "changed": [{"id": "...", "from": 1, "to": 2}]}, "assets": {"added": ["asset_..."], "removed": []}},
  "renderInputs": [{"key": "builtinCatalogHash|componentManifestHash|designSystemMetaVersion", "from": V, "to": V}],
  "summary": {"screensAdded": 0, "screensRemoved": 0, "screensChanged": 1, "staticElementsAdded": 0, "staticElementsRemoved": 0, "staticElementsChanged": 1, "identical": false, "docIdentical": false, "truncated": false, "omittedSections": []}
}
```

Здесь `V` — ровно одна из форм `{"value":<JSON>}`, `{"truncated":{"preview":"…","chars":n}}` или `{"missing":true}`. `missing` отличает отсутствующее optional-поле от JSON `null`. Изменённый `screenOrder` выдаётся только до 100 записей; более длинный заменяется `{"omitted":true}`. Общий бюджет — 500 leaf-изменений и жёсткий предел сериализованного ответа 256 KiB. Недоверенные строки и значения ограничиваются, а при исчерпании бюджета целые секции заменяются `{"omitted":true}`; точный список находится в `summary.omittedSections`, факт усечения — в `summary.truncated`.

`docIdentical` сравнивает только нормализованные документы: порядок ключей объектов незначим, порядок массивов значим. `identical` дополнительно требует равенства component/asset pins и `renderInputs`. Оба флага вычисляются до усечения; `message`, `createdAt` и `figma` — metadata ревизии и намеренно не участвуют ни в одном флаге. Capture-session не включает diff-URL в `allowedUrls`, поэтому `X-EasyUI-Capture` не даёт доступ к этому endpoint.

### Scoped share

Owner-endpoints share требуют user-сессию владельца (и внешний Basic, если compatibility-барьер включён). Grant всегда закреплён за опубликованной immutable version; TTL допускается от 5 минут до 30 дней. Bearer-token генерируется из 32 случайных байт (256 бит) и возвращается только при создании: в SQLite хранится исключительно SHA-256 hash. Поэтому старую ссылку нельзя восстановить из списка — можно отозвать её и создать новую.

Публичный `GET /share/:token` обходит внешний Basic-гейт. Живой token обменивается на opaque server-session, после чего сервер ставит host-only cookie `HttpOnly; SameSite=Lax; Path=/` (`Secure` только при HTTPS `PUBLIC_ORIGIN`) и отвечает `303` на абсолютный tokenless URL `/share/p/:id/v/:version/present/s/:startScreen`. Token исчезает из адресной строки и не попадает в referrer.

Если запрос обмена содержит ровно один параметр `mobile` со строгим значением `0` или `1`, сервер переносит его в `Location` ответа `303`. Это позволяет форсировать режим мобильного плеера на принимающем устройстве; дубликаты, другие значения и все остальные query-параметры не переносятся.

Share-cookie авторизует исключительно `GET`/`HEAD` по exact allowlist: share-present маршруты экранов, DTO выбранной version, её pinned component bundles и точные shim/asset/theme-version зависимости. Draft/list/write API, обычные `/p/*` маршруты, другие прототипы и версии не разрешены. Ответы имеют `Cache-Control: no-store`, `Vary: Cookie`, `Referrer-Policy: no-referrer`. Closure текущей SPA-сборки (Vite chunks, fonts, favicon и скопированные public-файлы) перечисляется из текущего `SERVE_DIST` на каждом запросе, не сохраняется в grant/session; уже выданная cookie поэтому продолжает работать после redeploy с новыми hash-именами. Revoke помечает grant и удаляет все его sessions немедленно.

### Матрица `designSystem` в DTO прототипов

Нормализованный `doc` — источник истины. Если ответ содержит `doc`, система находится только в `doc.designSystem` и не дублируется сверху: это draft, конкретная revision и опубликованная version. В list и meta, где документа нет, `designSystem` находится top-level и отражает текущий head. Ответы create, save и restore содержат только номер ревизии (и применимые warnings), поэтому отдельного поля системы в них нет. Старый документ без поля при чтении нормализуется в `designSystem: "shadcn"`.

### Мульти-поверхностные документы (`doc.surfaces`)

Документ может нести две **поверхности** — по девайс-панели на сцену плеера, с общим стейтом и (опционально) со своей дизайн-системой у каждой. Формат, правила валидации и авторские ограничения — `docs/prototype-format.md#surfaces-docsurfaces`; ниже — только серверный контракт.

**Kill-switch `EASYUI_SURFACES` (без переменной запись выключена; прод-compose задаёт `1`).** Полярность обратна `EASYUI_PUBLISH_GATES`: пустая переменная означает «писать нельзя». Без `EASYUI_SURFACES=1` любое сохранение документа с непустым `doc.surfaces` (`POST /prototypes`, `PUT /prototypes/:id`) отвечает `422 surfaces_disabled`. **Чтение не ограничено ничем**: сохранённые surfaces-документы читаются, рендерятся и снимаются всегда — иначе откат образа ломал бы уже записанные данные. Переменная читается на запросе через `surfacesWriteEnabled()`; в e2e и dev-скриптах она выставлена в `1`. С релиза f5eaa65 (2026-08-03) `docker-compose.yml` задаёт дефолт `${EASYUI_SURFACES:-1}` — **на проде запись surfaces включена**; аварийное выключение — задать `EASYUI_SURFACES=` (пусто) в env Dokploy.

Discovery (`GET /api/capabilities`):

- `features.surfaces` — формат `doc.surfaces`/`screen.surface`/`step.companions` поддержан кодом образа (stored-документы читаются). Всегда `true` начиная с этой волны;
- `features.surfacesWrite` — разрешена **запись** (значение kill-switch'а). Флаги разнесены намеренно: «код умеет» и «писать можно» — разные вопросы для агента;
- `limits.surfaces` — число поверхностей документа (v1 — ровно две), импортируется из `SURFACES_LIMIT` в `src/prototype/schema.ts`.

**Пины тем: карта вместо скаляра.** Ревизия пинует версию темы **каждой** ДС документа (таблица `prototype_revision_theme_pins`, миграция v24). DTO ревизии/версии/draft несут:

- `designSystemMetaVersion` — по-прежнему версия темы **primary**-ДС (`surfaces[0]`, для обычного документа — просто `doc.designSystem`); поле не меняет смысла для непереведённых клиентов;
- `designSystemMetaVersions` — карта `дизайн-система → версия темы | null`.

**Read-правило (бэкфила нет by design):** если строк в таблице для ревизии нет — она записана до миграции v24, и карта равна `{ <ДС primary>: designSystemMetaVersion }`. Restore копирует карту исходной ревизии; catalog-migration переносит строки вместе с ревизией, а таблица входит в `currentDataFingerprint`.

**Производные пина.** `resolvedSpacingScale` считается для каждой ДС отдельно (geometry-probe второй поверхности меряет её шкалой). `builtin_catalog_hash` у одно-поверхностного документа побайтно прежний; при двух и более ДС это детерминированный sha256 по отсортированному множеству `(designSystem, metaVersion, per-ds hash)`.

**Резолв компонентов и пины.** Тип экрана резолвится в ДС **его поверхности**; тип чужой ДС даёт ту же `422 validation_failed` («Unknown or unpublished component type in design system …»), что и неизвестный тип. Guard'ы пинов (save, publish, restore) проверяют принадлежность компонента **множеству** ДС документа, а не одной.

**Warnings валидации (не блокирующие, эмитит только сервер).** При ≥2 различных ДС в документе — безусловное предупреждение о том, что `token()`/`Icon` читают глобальный снапшот primary-системы целиком; при пересечении семейств шрифтов пиннутых тем — предупреждение о том, что побеждает первая (primary) регистрация. Карту `ДС → тема` в валидацию передаёт сервер, поэтому клиентская валидация редактора этих warnings не эмитит.

**Share.** Grant surfaces-документа кладёт в `dependencies` ресурсы тем **всех** ДС документа с их пиннутыми версиями (`/api/design-systems/<ds>/versions/<v>` и ассеты каждой темы) — иначе аноним получал бы вторую панель без темы.

**Скриншоты.** `CaptureExpected`/`CaptureReady` несут резолвнутую пару `(designSystem, dsMetaVersion)` **снимаемого экрана**: у одно-поверхностного документа это `doc.designSystem`, у дуо-дока — система поверхности экрана, иначе дрейф темы второй ДС не детектировался бы handshake'ом. Capture-allowlist — объединение тем и ассетов всех ДС документа с их пиннутыми версиями. Съёмка остаётся поэкранной и в дефолтном состоянии (композитного дуо-кадра в v1 нет).

**Ретайр ДС.** `DELETE /design-systems/:id` дополнительно блокируется surface-ссылками: счётчик `prototypeSurfaces` в `retireBlockers` считает прототипы, у которых **головная** ревизия ссылается на систему через `doc.surfaces[].designSystem`. Сканируются только головы — принятое ограничение того же класса, что сегодняшний счёт по `prototypes.design_system`. Триггеры целостности retired-систем пересозданы миграцией v24 и учитывают `doc.surfaces`.

**Отказы v1 со стабильными кодами:**

| Код | Когда | Почему v1 |
|---|---|---|
| `422 surfaces_disabled` | save документа с `doc.surfaces` при выключенном kill-switch | прод не накапливает surfaces-документы до приёмки |
| `422 surfaces_not_exportable` | экспорт бандла прототипа, у которого `doc.surfaces` есть **в любой** ревизии; импорт такого документа — тем же кодом | манифест бандла v1 скалярен по ДС, ключ импортёра — `${designSystem}::${type}`; мульти-ДС манифест — v2 |
| `422 composition_foreign_design_system` | композиция на экране, чья ДС ≠ `doc.designSystem` | резолвер композиционных пинов однодизайнсистемный; per-screen резолв — v2 |
| `422 surface_design_system_not_supported` | `surface.designSystem` ≠ `doc.designSystem` при выключенном флаге поддержки | точка контроля в `src/prototype/schema.ts`; сегодня флаг включён |

**Оговорка про `track: "head"`.** Head-tracking-документы непубликуемы и нешерабельны (`422 prototype_head_tracking` на publish/share/visual-baseline/bundle-export). Дуо-демо, которое показывают человеку по share-ссылке, поэтому **не может** быть одновременно `track: "head"`-документом: это либо служебный трекающий док, либо публикуемый демо-док.

### Canonical URLs

Ответы `POST /prototypes`, `PUT /prototypes/:id` и `POST /prototypes/:id/publish` additively содержат `screens:[{id,url}]` — канонический player-URL каждого экрана. Для create/save это head-форма `/p/<id>/s/<screen>`, для publish — version-форма `/p/<id>/v/<n>/s/<screen>`. URL — это SPA-маршрут: истинность маршрута (существование экрана, готовность бандлов) подтверждает [render-status](#render-status), а не HTTP-код статики. SPA-fallback отдаёт `index.html` для любого GET/HEAD вне `/api/` и путей без расширения, независимо от заголовка `Accept` (programmatic-клиент без `Accept: text/html` тоже получает SPA); неизвестный extensionless-путь получает SPA и рендерит клиентскую 404-страницу.

### Render status

`GET /prototypes/:id/screens/:screenId/render-status` с опциональным `?version=n` **или** `?rev=n` (взаимоисключающие; по умолчанию — head-ревизия) раздельно проверяет три условия готовности:

- **document_ready** — документ целевой ревизии/версии существует и содержит `screenId`;
- **bundles_ready** — все пины ревизии резолвятся в рендеримые публикации компонентов (`active`; будущие `deprecated`/`superseded` рендерятся с warning; прочие статусы → `bundle_failed`);
- **local_route_ready** — SPA-статика раздаётся этим процессом (`SERVE_DIST`); в dev без dist — `route_not_ready` с указанием использовать Vite-origin.

Ответ (`200`, `no-store`):

```json
{
  "status": { "document": true, "bundles": true, "route": true },
  "renderable": true,
  "url": "/p/<id>/s/<screen>",
  "revision": 3,
  "publishedVersion": 1,
  "resolvedPins": [{ "id": "…", "name": "…", "version": 1, "bundleUrl": "…", "bundleHash": "…", "status": "active" }],
  "bundleStatus": "ready",
  "warnings": [{ "code": "pin_deprecated", "message": "…" }],
  "errors": [{ "code": "route_not_ready", "message": "…" }]
}
```

`renderable` = document_ready ∧ bundles_ready (готовность контента, независимо от local route). Отсутствие ресурса — типизированный `404`: `prototype_not_found`, `screen_not_found`, `version_not_found`, `revision_not_found`. `bundle_failed` и `route_not_ready` — диагностические записи в `errors[]` тела с `200`. Внешний ingress-probe (доступность домена за прокси) вне scope MVP.

### Lifecycle-модель

Sever ведёт неизменяемый журнал валидаций `validation_records(resource_type, resource_id, rev, validator_version, catalog_hash, ok, issues_json, created_at)`. Запись создаётся при `POST`/`PUT` прототипа (проверка прошла → `ok=1`, warnings в `issues_json`), при `restore` (restore теперь заново прогоняет `validatePrototype` против живого каталога и пишет результат, не блокируя восстановление), а также на publish-стадиях компонентов (`ok=1` при активации, `ok=0` при провале импорта).

`warnings` в ответах save/create включают архитектурные предупреждения `arch/*` (см. `docs/prototype-format.md#architecture-warnings`). Они warn-only и не меняют условия 422. Документ может нести `architecture.exemptions` — снятые ими issue'ы не попадают в `warnings`. `validatePrototype` принимает опциональный `options.kind`, выключающий архитектурные правила для служебных видов (`component-gallery`, `evidence`, `visual-reference`, `composition-fixture`); проброс `kind` из строки прототипа в этот вызов делает волна 4 в `server/routes/prototypes.ts` — без него правила работают для всех видов.

Meta-ответы прототипов и компонентов additively несут lifecycle-поля:

- `draftRevision` — текущая head-ревизия;
- `validatedRevision` — последняя ревизия с прошедшей (`ok`) записью валидации, либо `null`;
- `publishedVersion` — последняя опубликованная версия (для компонента — последняя `active`), либо `null`;
- `renderable: {head, published}` — та же логика, что render-status (document ∧ bundles), без external probe; `published` = `null`, если публикаций нет.

Поле `deployedVersion` намеренно **не** выдаётся: инстанс single-server, поэтому «задеплоенная» версия тождественна опубликованной и отдельное поле было бы тавтологией.

## Endpoints компонентов

Идентификатор — slug, имя — уникальное `^[A-Z][A-Za-z0-9]*$`, не конфликтующее со встроенным каталогом ни одной зарегистрированной системы с builtin provider. Имена компонентов глобально уникальны, а не уникальны в паре с системой: поэтому и в custom-системе нельзя создать `Button`, `Card` и другие builtin-имена. Это ограничение MVP связано с pins, registry и `components.name UNIQUE`. Имя после создания неизменно; систему head можно сменить. Удаление soft: компонент исчезает из списка/манифеста и не доступен новым сохранениям, но ранее опубликованные bundle и пины продолжают работать. Удаление записывает надгробие (`deleted_at`, `delete_reason`, `replacement_component_id`, миграция v17), видимое **только** под `?includeDeleted=1`; голый `GET /components/:id` для удалённого компонента остаётся `404` — на это поведение завязаны `driver.mjs` и SPA-клиент. Удалить компонент, который пинуют головные ревизии прототипов, нельзя: `409 component_in_use` с телом графа использования, обход — `force:true` от админа.

При добавлении builtin-системы коллизия любого её имени с существующим custom-компонентом является dev-time блокером. Startup-инвариант сравнивает объединение builtin-имён всех зарегистрированных систем со всей таблицей `components` и останавливает сервер с явной ошибкой; grandfathering устраняется вручную до регистрации системы. Композитный ключ `(designSystem, name)` отложен на post-MVP.

| Метод и путь | Тело / ответ |
|---|---|
| `GET /components` | `{id,name,designSystem,headRev,latestVersion:number|null,updatedAt}[]`; `?includeDeleted=1` дополнительно возвращает надгробия с `{deleted:true,deletedAt,reason,replacement}` |
| `POST /components` | `{id,name,source,designSystem,message?,figma?,intent?,reuseOverride?}` → 201 `{id,rev,warnings?}` и `Location`; создание проходит reuse gate — детали ниже |
| `GET /components/:id` | `{id,name,designSystem,headRev,versions:ComponentVersion[],updatedAt,draftRevision,validatedRevision,publishedVersion,renderable}` (lifecycle-поля — см. [Lifecycle-модель](#lifecycle-модель)); мягко удалённый компонент — **404**, если не передан `?includeDeleted=1` (тогда meta дополняется `{deleted:true,deletedAt,reason,replacement}`) |
| `PUT /components/:id` | `{source?,designSystem?,figma?,message?,baseRev}` → `{rev}`; хотя бы одно из `source`/`designSystem`/`figma`, смена системы наследует текущий source; figma-only PUT, байт-идентичный head → `{unchanged:true,rev:<headRev>}` без новой ревизии (см. [Figma provenance](#figma-provenance)) |
| `DELETE /components/:id` | `{baseRev, reason?, replacement?, force?}` → 204; `409 component_in_use` пока компонент пинуют головные ревизии (обход — `force:true` от админа, иначе `403 admin_required`); `replacement` — id живого компонента, иначе `422` |
| `GET /components/:id/usages` | Граф использования; `?format=tree` — то же деревом. См. [Граф использования](#граф-использования-компонентов) |
| `GET /components/:id/source` | Текущий `{rev,source,designSystem,message:string|null,createdAt}` |
| `GET /components/:id/draft` | Alias текущего source DTO |
| `GET /components/:id/revisions` | `{rev,designSystem,message:string|null,createdAt}[]` |
| `GET /components/:id/revisions/:rev` | `{rev,source,designSystem,message:string|null,createdAt}` |
| `POST /components/:id/restore` | `{rev,baseRev}` → `{rev}`; переносит резолвнутую provenance исходной ревизии (включая tombstone) |
| `PUT /components/:id/provenance` | `{rev?,figma}` → `{rev,seq,unchanged,figma}`; правка Figma-ссылки **без** новой ревизии и версии, см. [Provenance компонентов](#provenance-компонентов-без-новых-версий) |
| `POST /components/:id/validate` | Тело не читается → 200 receipt префлайта head-ревизии; см. [Validate-префлайт](#validate-префлайт-публикации) |
| `POST /components/:id/publish` | `{message?,baseRev,reuseOverride?}` → 201 `{version,hostAbiVersion,warnings}` и `Location`; `reuseOverride` — только для администратора (`403 admin_required`), конфликты роли — терминальные `409 catalog_changed\|canonical_role_conflict` |
| `POST /components/:id/promote` | `{baseRev,sourceHash,expectedCatalogRevision?,supersede?,reuseOverride?,message?,candidateId?,acceptanceRunId?\|acceptanceRunIds?,expectedCases?}` → 201 `{version,rev,hostAbiVersion,sourceHash,bundleHash,themeVersion,catalogRevision,superseded[],cached,warnings}` и `Location`; см. [Promote](#promote-приёмка-провалидированной-головы) |
| `GET /components/:id/versions` | `ComponentVersion[]`: `{version,rev,status,statusReason:string\|null,supersededBy:number\|null,statusRev,designSystem,publishedAt,candidateId:string\|null,acceptanceRunId:string\|null,acceptanceRunIds:string[],evidenceManifestHashes:string[]}`; receipt-ссылки приёмки непусты только у версий, опубликованных `promote` с кандидатом и пройденным acceptance-раном; `acceptanceRunIds` — весь набор ранов версии ([multi-run promote](#multi-run-promote-шардированная-семья-волна-w7-план-2026-08-04)), `acceptanceRunId` всегда равен его первому элементу |
| `GET /components/:id/versions/:version` | Метадата версии **любого статуса**: `{version,rev,status,statusReason,supersededBy,statusRev,source,designSystem,events,eventPayloads?,capabilities?,slots,description,example?,examples?,propsJsonSchema?,atomicLevel?,layoutNeutral?,layout?,scope?,allowedAsRoot?,canonicalFor?,sourceBounded?,ownership?,replacement?,bundleHash,hostAbiVersion,assets:AssetPin[],publishedAt}`; `propsJsonSchema` описывает input (до Zod defaults/transforms); immutable |
| `GET /components/:id/versions/:version/bundle.js` | Скомпилированный ESM (`text/javascript`); отдаётся при статусе `active\|deprecated\|superseded`, иначе `404 bundle_unavailable`; immutable |
| `POST /components/:id/versions/:version/status` | `{status, reason?, supersededBy?, baseStatusRev}` → 200 `{status, statusRev}`; см. [Статусы версий](#статусы-версий-компонентов) |

### Validate-префлайт публикации

`POST /components/:id/validate` прогоняет publish-набор проверок над **головной ревизией** и ничего не создаёт: ни версии, ни ревизии, ни записи в public state. Тело запроса не читается; доступ — владелец компонента (или админ), как у `PUT`. Rev-адресного варианта нет сознательно: publish работает только с head.

Набор проверок (в этом порядке): сохранённая figma-provenance против строгой схемы → asset-ссылки исходника → извлечение `definition` со smoke-рендером → TypeScript-check → сборка → import-верификация → parity-предупреждения «schema `.default()` ↔ render `??`-fallback». Первые две — db-зависимые и выполняются на **каждый** вызов (их результат зависит от состояния БД, а не от исходника); остальные кэшируются.

Ответ — receipt:

```json
{ "ok": true, "cached": false, "sourceHash": "…", "bundleHash": "…", "hostAbiVersion": 2,
  "themeVersion": 7, "catalogRevision": "…", "warnings": ["Parity: prop \"gap\" …"] }
```

- `cached: true` означает, что тяжёлая часть взята из candidate-кэша по `sourceHash`, а не пересчитана;
- `themeVersion` — последняя meta-версия темы системы компонента (`null`, если версий темы нет), `catalogRevision` — та же sha256-проекция каталога, что в `/catalog/candidates` и в reuse-конверте;
- `warnings[]` — те же строки, что вернул бы publish (extract-warnings, отсутствующий `atomicLevel`, [architecture-warnings](#architecture-metadata)) плюс parity-предупреждения.

**Чего receipt НЕ покрывает.** Гарантия «publish не упадёт на 422» ограничена перечисленным набором. Каталого-временные проверки — конфликт канонической роли (`409 canonical_role_conflict`), reuse-гейт, `422 atomic_policy_violation` — остаются на publish и успешным receipt'ом не обходятся: между префлайтом и публикацией каталог мог сдвинуться.

**Переиспользование publish'ем.** Если head-исходник на момент `POST …/publish` совпадает по sha256 с успешно провалидированным, публикация берёт extraction из candidate-кэша через шов `preExtracted` и не платит второй раз за `checkSource`/smoke-рендер. Расхождение sha256 молча отправляет publish извлекать заново. Кэш validate адресуется `sourceHash` и не заселяет publish-кэш import-верификации (`id@rev`), поэтому publish не пропускает собственную проверку импорта.

**Кэш, троттлинг, лимиты.** Candidate-кэш файловый (`DATA_DIR/.candidates/<sourceHash>/{result.json,bundle.js}`), без миграции и без публичного URL-контракта: TTL 24 ч, потолок суммарных байт, GC на старте процесса и при каждой записи (вытесняются самые старые). Отрицательный исход (422/413/400) кэшируется так же, как положительный; неожиданные ошибки (5xx) не кэшируются. Конкурентность — один прогон на пользователя и общий cap; значения публикуются в [`/api/capabilities`](#discovery): `limits.validateUserConcurrent`, `limits.validateGlobalConcurrent`, `limits.validateCacheTtlHours`, `limits.validateCacheMiB`.

**Коды ошибок.** `429 validate_in_flight` — у этой учётки уже идёт прогон; `429 queue_full` — исчерпан общий cap (оба ретраятся с бэкоффом). `422 validation_failed` — любая из проверок набора; неподдерживаемое поле provenance (исторический кейс `pageNodeId`, переживший сужение схемы или приехавший импортом бандла) приходит именно так, с полем в `issues[].path` = `["figma","pageNodeId"]`. Также `422 asset_not_found` (dangling asset-ссылка исходника или `figma.referenceScreenshots`), `422 event_schema_not_serializable`, `413 payload_too_large`, `404 not_found` для несуществующего компонента и `403 forbidden` для чужого.

**Kill-switch.** `EASYUI_VALIDATE_DISABLED=1` (читается один раз на входе процесса) убирает ручку — `404 not_found` — и гасит `features.componentValidate` и `features.componentDraftPreview` в discovery.

### Promote: приёмка провалидированной головы

`POST /components/:id/promote` (RFC `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md`, волна R1) публикует головную ревизию **одним вызовом**: без повторной компиляции и без ручных status-переходов. Доступ — владелец компонента и владелец его дизайн-системы (как у publish). Никаких новых таблиц и миграций: вход опознаётся парой `{baseRev, sourceHash}` из [validate-receipt](#validate-префлайт-публикации).

Это **сага**, а не одна транзакция (bun:sqlite не переживает `await` внутри транзакции):

**Фаза A (вне транзакций).** Предпроверки: `head_rev === baseRev` (иначе `409 revision_conflict {currentRev}`), `sha256(source) === sourceHash` (иначе `409 source_hash_mismatch {sourceHash,currentRev}`), опциональный CAS каталога `expectedCatalogRevision` (иначе `409 catalog_changed {catalogRevision}`). Затем перепрогон каталого-временных проверок publish-пути — имя host-примитива, `canonicalFor` (тот же терминальный reuse-конверт и тот же admin-only `reuseOverride`), атомарная политика, asset-ссылки. Артефакты берутся из candidate-кэша по `sourceHash`; при холодном кэше кандидат пересобирается тем же путём, что draft-preview (под троттлингом validate, отсюда `429 validate_in_flight`/`429 queue_full`). **`typecheck` и `compile` не выполняются** — их уже оплатил validate; `stage` получает готовые `compiledJs`/`bundleHash`/**фактический** `hostAbiVersion`. Import-верификация (`id@rev`) выполняется всегда.

**Фаза B (одна короткая синхронная транзакция).** `activate` новой версии → `pinAssets` (иначе версия осталась бы без пинов: пустой `assets` в DTO, сломанный export, потеря RESTRICT-защиты) → `recordValidation` → auto-supersede: прочие `active`-версии выбираются **внутри** транзакции (новая исключается по номеру) и переводятся через инварианты `setStatus` — CAS с инкрементом `status_rev`, cycle-check, `supersededBy = N`, `status_reason = "auto: promoted vN"`. `supersede: "none"` пропускает этот шаг и оставляет параллельные active-версии. Любая ошибка фазы B откатывает транзакцию целиком и компенсируется `fail()`.

**Инвариант пула.** После `supersede: "auto"` у компонента ровно одна active-версия. Последующий ручной `deprecated` на неё оставляет компонент без active — это видно как warning `component_no_active_version` в readiness-гейте `pins` и как ненулевой `noActiveVersion` в `driver.mjs audit --versions`.

**Recovery и идемпотентность.** Крах фазы A компенсируется `fail()`/`failStagingPublishes` — ровно как у publish. Повторный promote тех же `{baseRev, sourceHash}` после этого **проходит**: `already_published` проверяется по строкам ревизии *вне* статуса `failed`. Схема запрещает две публикации одной ревизии (`UNIQUE (component_id, rev)`), а R1 идёт без миграций, поэтому повтор переписывает `failed`-строку на месте — номер версии сохраняется, дырки в нумерации не возникает. Повтор поверх **успешной** версии остаётся терминальным `409 already_published`.

**Коды ошибок.** `400 invalid_request`/`base_rev_required`; `403 admin_required` (`reuseOverride` не от админа); `404 not_found`; `409 revision_conflict|source_hash_mismatch|already_published|catalog_changed|canonical_role_conflict|candidate_unavailable|candidate_rejected`; `422 validation_failed|asset_not_found|atomic_policy_violation|event_schema_not_serializable`; `413 payload_too_large`; `429 validate_in_flight|queue_full`. `candidate_unavailable` — редкая гонка с GC кэша: повторить validate+promote. Ни один `409` не ретраится автоматически.

**Publish не меняется.** `POST /components/:id/publish` остаётся полноценным путём публикации (в т.ч. когда приёмка погашена kill-switch'ем); bundle-import публикует своим путём и помечается аудит-событием `publish.import`. Успешный promote пишет `component.promoted` с fingerprints (`sourceHash`/`bundleHash`/`hostAbiVersion`/`themeVersion`/`catalogRevision`/`superseded`) — это источник KPI-метрик приёмки.

**Kill-switch.** `EASYUI_ACCEPTANCE_DISABLED=1` (читается один раз на входе процесса) убирает ручку — `404 not_found` — и гасит `features.acceptancePromote` в discovery. Publish при этом продолжает работать: гашение приёмки не делает дизайн-систему неопубликуемой.

#### Promotion policy: какой ран допускает публикацию (волна W3, план 2026-08-04)

Ссылки `candidateId`/`acceptanceRunId` (`EASYUI_ACCEPTANCE_MATRIX=1`) сверяются до любых записей. Предикаты:

- **кандидат** описывает ровно `{baseRev, sourceHash}` запроса (`409 revision_conflict`), не держит живого рана (`409 acceptance_run_in_flight`) и принадлежит этому компоненту (`404 not_found` — типизованный отказ был бы оракулом по чужой приёмке);
- **ран принадлежит этому кандидату** — иначе `422 acceptance_run_mismatch`. Этот код больше **не** означает «другая политика»;
- **профиль рана допущен к публикации**: `run.policy_profile_id ∈ capabilities.acceptance.promotionPolicyProfiles` — иначе `422 acceptance_policy_mismatch` с `{runPolicyProfileId, allowed}`;
- **вердикт** — терминальный `pass|pass_with_exceptions` (`422 acceptance_run_not_passed`).

**Хэш профиля кандидата в предикате не участвует.** `component_candidates.policy_profile_hash` — **информационный штамп**: кандидат замораживает билд, а не политику (RFC-инвариант «policy вне идентичности кандидата»), и штампуется хэшем `default-v1` при создании. Прежняя сверка «хэш рана == хэш кандидата» поэтому делала любой `pixel-strict-v1`-ран непромоутабельным — дефект P0-2 фидбэка 2026-08-04, снят этой волной.

**Устаревший хэш профиля — warning, не отказ.** `run.policy_profile_hash` сверяется с текущим `policyProfileHash(ACCEPTANCE_POLICIES[run.policy_profile_id])`; расхождение (профиль правили после рана) даёт warning в `warnings[]` и provenance в ответе:

```json
"acceptancePolicy": {"profileId": "pixel-strict-v1", "runPolicyProfileHash": "…", "currentPolicyProfileHash": "…", "stale": true}
```

Те же поля уезжают в аудит-событие `component.promoted` (колонки под них у `component_publishes` нет — волна идёт без миграций). Запрет публикации здесь наказывал бы за правку кода, а не за качество сборки: вердикт получен по политике, которая тогда действовала.

**Kill-switch `EASYUI_PROMOTE_POLICY_STRICT`** (объявлен в `docker-compose.yml`, по умолчанию **выключен**). `1` возвращает докритическое равенство хэшей профиля рана и кандидата, то есть **возврат дефекта P0-2** — только аварийный откат до отката образа.

**DTO версий.** `candidateId`/`acceptanceRunId`, а с волны W7 — ещё `acceptanceRunIds[]` и `evidenceManifestHashes[]`, отдаёт и список версий (`GET /components/:id`, `no-store`), и одиночный `GET /components/:id/versions/:version`, и 201-ответ promote. Ограничение (C30): одиночный DTO версии клиентский кэш держит как `immutable` (адрес несёт версию), а receipts — мутабельная часть строки, их проставляет фаза B саги. Свежую связку читать по 201-ответу promote или по списку версий, а не из тёплого кэша ручки версии.


#### Multi-run promote: шардированная семья (волна W7, план 2026-08-04)

Семья, которая не влезает в один ран (лимит `limits.acceptanceMaxCasesPerRun` или осознанное шардирование light/dark), принимается **набором** ранов и публикуется одним promote. Гейт возможности — `capabilities.features.acceptanceMultiRunPromote` (тот же `EASYUI_ACCEPTANCE_MATRIX=1`); клиент обязан проверить флаг **до** вызова: сервер до W7 отвечает на массив `400 invalid_request: Unknown field: acceptanceRunIds`.

**Тело.** `acceptanceRunIds: string[]` (1..8) — **взаимоисключимо** с `acceptanceRunId`; оба поля сразу → `400 invalid_request`. Опциональный `expectedCases: number` включает сверку суммарного покрытия.

**Предикаты набора** (в дополнение к одиночным — кандидат, terminal pass, promotion-профиль):

- **один кандидат**: каждый ран принадлежит указанному (или выведенному из первого рана) кандидату — иначе `422 acceptance_run_mismatch`;
- **единый `policy_profile_id`** у всех ранов — иначе `422 acceptance_policy_mismatch` с `{runIds, policyProfileIds}`. Половина семьи под `default-v1` и половина под `pixel-strict-v1` — не одна приёмка, а две;
- **единый `renderer_fingerprint`** (колонка `acceptance_runs.renderer_fingerprint`, v30; пишется на постановке рана) — иначе `422 acceptance_renderer_mismatch` с `{runIds, rendererFingerprints}`. Раны до v30 несут `NULL`: «неизвестно» ≠ «разошлось», поэтому для них проверка пропускается с warning;
- **дизъюнктность покрытия по `(propsHash, surface)`** — иначе `422 acceptance_coverage_overlap` с `{runIds, overlap, overlapCount}`. Поверхность — `capture` (viewport/dsf/theme) **набора**, а не случая, поэтому шардирование light/dark законно даёт одинаковые props и даже одинаковые `caseId` в разных наборах; совпадение `caseKey` между наборами — **warning, не ошибка**;
- **полнота** (только при `expectedCases`): суммарное покрытие считается **кадрами** — различными парами `(propsHash, surface)`, поэтому алиасы дублей учитываются один раз. Несовпадение → `422 acceptance_coverage_incomplete` с `{expectedCases, coveredCases, runs[]}`.

**Хранение и порядок (v30).** `component_publishes.acceptance_run_ids` — плоская TEXT-колонка с JSON-массивом **без FK** (инвариант A9). Сервер сортирует набор по `(created_at, run_id)`, поэтому порядок аргументов запроса на хранение не влияет, а легаси-скаляр `acceptance_run_id` — **первый элемент отсортированного массива**. Массив пишется всегда, когда ран есть (одиночный promote даёт `[run]`), поэтому новым читателям не нужно различать «одиночная версия» и «набор». Чтение до-миграционных строк: `acceptance_run_ids IS NULL` ⇒ `[acceptance_run_id]` (пусто, если и он `NULL`) — backfill'а нет намеренно.

**GC.** Свипер кандидатов защищает раны, упомянутые в `component_publishes`, union'ом скалярной колонки и `json_each(acceptance_run_ids)` (`runIdsReferencedByPublishes()`/`isRunReferencedByPublish()`). Без второго слагаемого TTL унёс бы все шарды семьи, кроме первого.

**CLI.** `driver.mjs promote <id> --acceptance-run a --acceptance-run b` (флаг повторяем) либо `--acceptance-runs a,b`; `--expected-cases N` — та же сверка покрытия. Драйвер сверяет принадлежность **каждого** рана компоненту и кандидату до POST и печатает весь набор строкой связки.

### Acceptance: кандидаты и матричные раны

Матричная приёмка (план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md` §5 W1a, RFC §4.1–4.2) заменяет семейство из десятков клиентских операций **одной постановкой и polls**: неизменяемый кандидат (замороженный билд ревизии) + набор верификационных случаев → durable-ран с per-case вердиктами, гейтами и content-addressed evidence.

**Kill-switch.** Весь набор ручек существует только при `EASYUI_ACCEPTANCE_MATRIX=1` (env читается один раз на входе процесса, как `REUSE_GATE`/`EASYUI_VALIDATE_DISABLED`). Флаг выключен → каждая ручка отвечает `404 not_found`, а `features.acceptanceMatrix|acceptanceCandidates|acceptanceRuns` в `/api/capabilities` равны `false`. Тем же флагом закрыты ссылки `candidateId`/`acceptanceRunId` у `POST /components/:id/promote`: при выключенной матрице они дают `422 acceptance_matrix_disabled` (в саму сагу promote они приезжают волной W1c — до неё `422 unsupported_option`).

**Авторизация — одна на все ручки.** `requireUser` + владелец компонента по денормализованному `component_id` кандидата/рана (или админ). `share`- и `capture`-принципалы получают `403 forbidden` всегда: они проходят анонимный барьер и иначе читали бы чужие раны (тот же инвариант, что у `/catalog/candidates`). Артефакты CAS отдаются **только** внутри `runId`-scoped архива — ручки «по sha» нет by design: адрес артефакта не несёт владельца.

| Метод | Путь | Ответ |
|---|---|---|
| `POST` | `/components/:id/candidates` | `200` кандидат + `cached` |
| `GET` | `/component-candidates/:candidateId` | `200` кандидат |
| `POST` | `/component-candidates/:candidateId/reject` | `200` кандидат с `rejected: true` |
| `POST` | `/acceptance-runs` | `202` `{runId,status,cases,progress,cached}` |
| `GET` | `/acceptance-runs/:runId` | `200` статус + gates + progress + eta + `failedCases`; `?view=summary` — компактная сводка |
| `GET` | `/acceptance-runs/:runId/cases` | `200` per-case вердикты, квитанции reuse и имена артефактов; `?case=<id>` — один случай |
| `GET` | `/acceptance-runs/:runId/evidence` | `200` `application/zip` |
| `POST` | `/acceptance-runs/:runId/cancel` | `200` ран в статусе `cancelled` |
| `POST` | `/components/:id/impact` | `200` отчёт импакта (dry-run, ничего не снимает) |

**`POST /components/:id/candidates`** (тело `{}`) выполняет тот же [validate-префлайт головы](#validate-префлайт-публикации) — с тем же троттлингом и теми же кодами — и этим же материализует бандл, который потом снимается **по ревизии кандидата**, а не по head. Строка идемпотентна по `{componentId, designSystem, rev, buildFingerprint}`: повтор на неизменённом билде возвращает тот же `candidateId` с `cached: true` и не сбрасывает его `status`. Бандл кандидата пинуется против GC candidate-кэша, пока на него ссылается нетерминальный ран. Ответ: `candidateId`, `componentId`, `designSystem`, `rev`, `sourceHash`, `bundleHash`, `hostAbiVersion`, `themeVersion`, `buildFingerprint`, `policyProfileHash`, `catalogRevision`, `status` (`validated|promoted`), `statusReason`, `rejected`, `decision` (`{reason, actor, createdAt}` либо `null`), `acceptanceRunId`, `promotedVersion`, `createdAt`, `expiresAt`, `cached`, `warnings`. `policyProfileHash` — информационный штамп профиля на момент заморозки (в promote-предикате [не участвует](#promotion-policy-какой-ран-допускает-публикацию-волна-w3-план-2026-08-04)). `acceptanceRunId` — **последний поставленный** ран, а не принятый; выбирать ран для promote по нему нельзя. Полный список — `runs: [{runId, status, policyProfileId, caseSetId, finishedAt, promotionEligible}]` в порядке постановки, где `promotionEligible` = терминальный `pass|pass_with_exceptions` под профилем из `capabilities.acceptance.promotionPolicyProfiles`. Ответ **мутабелен** (`status`/`acceptanceRunId`/`runs[]` живут вместе с кандидатом) — клиентский кэш харнеса держит его как `fresh` с коротким TTL, не как `immutable`. Уехавшая между префлайтом и записью голова — `409 revision_conflict {currentRev}`. Списочной ручки нет (триаж A7): кандидат адресуется своим id.

**`POST /component-candidates/:candidateId/reject`** `{reason}` — отклонение сборки человеком (RFC §4.1, волна R3b). Владелец компонента или админ; `reason` обязателен (непустая строка). Решение пишется **append-only**-строкой в `candidate_decisions`: хранимый enum `status` не расширяется, а `rejected` — вычисляемый признак DTO (`rejected: true` + `decision {reason, actor, createdAt}`). Пишется аудит-событие `candidate.rejected`.

**Отклонение терминально — «разотклонения» нет.**

- Promote **всей ревизии** блокируется: `POST /components/:id/promote` перед фазой A проверяет, есть ли отклонённый кандидат для `(component_id, design_system, rev = baseRev)`, и отвечает `409 candidate_rejected` с `{candidateId, decision}`. Предикат работает на **обоих** путях promote — и с `candidateId`, и на receipt-пути `{baseRev, sourceHash}` — и **не зависит** от `EASYUI_ACCEPTANCE_MATRIX` (таблицы заводятся безусловными миграциями v25/v27). Семантика намеренно широкая: отклонена сборка ревизии — заблокированы и её пересборки с другим `buildFingerprint` (иная тема/ABI). Выход — новая ревизия компонента.
- Надгробие переживает TTL: свипер просроченных кандидатов **не удаляет** кандидатов с decision-строками (как не удаляет `promoted`), иначе `ON DELETE CASCADE` снёс бы решение и TTL работал бы отложенным `unreject`.
- Повторный `POST /components/:id/candidates` той же сборки возвращает **того же** отклонённого кандидата (`cached: true`, `rejected: true`), а не создаёт чистого.
- Ручек `unreject`/`DELETE` нет.

Отказы: `409 candidate_already_rejected` — кандидат уже отклонён, в `details` существующее решение `{reason, actor, createdAt}` (арбитр гонки — partial unique index, а не предпроверка); `409 candidate_promoted` `{currentVersion}` — сборка уже опубликована, отклонять нечего. **`candidate_promoted` ≠ `candidate_already_promoted`**: второй код принадлежит CAS'у саги promote (`markPromoted` фазы B, `details {promotedVersion}`) и означает «кандидат уже помечен promoted другим прогоном саги».

Reject **не** отменяет ран приёмки и ничего не мутирует в самом кандидате: отклонённый кандидат с живым (`queued|running`) раном продолжает занимать in-flight-слот до терминализации рана — это ожидаемое поведение, отмена рана — `POST /acceptance-runs/:runId/cancel`.

CLI: `driver.mjs reject <candidateId> --reason <text>`.

**`POST /acceptance-runs`** `{candidateId, idempotencyKey?, policy?, cases?, refresh?, baselineRunId?}`. Профили — `default-v1` (по умолчанию) и `pixel-strict-v1`; неизвестный → `422 unknown_policy_profile`. Источник случаев в этой фазе — именованные `definition.examples` кандидата; `cases: [{key, props}]` задаёт набор явно. Дубликат props становится **алиасом** (одна съёмка, наследованный вердикт), пустой набор — `422 empty_case_set`, превышение `limits.acceptanceMaxCasesPerRun` — `422 case_set_too_large` (потолок считается до схлопывания алиасов). `idempotencyKey` уникален в паре с кандидатом и дедуплицирует **постановку** (ответ с `cached: true`); на синхронных ручках канон остаётся CAS по `baseRev`. У кандидата не может быть двух нетерминальных ранов — `409 acceptance_run_in_flight {runId}`; вытесненный бандл — `409 candidate_evicted`, разъехавшаяся пара `{rev, sourceHash}` — `409 candidate_stale`. Под maintenance-lock'ом каталога постановка отвечает `503 maintenance_in_progress` (обратная сторона: `acquireMaintenanceLock` отказывает при живом ране). Отклонённые конструкции — `422 unsupported_option`: `concurrency`, `cases.concurrency`, `manifestAssetId`. `caseSetId` (см. [case-set'ы](#case-set-манифесты-наборы-случаев-семьи)) задаёт набор случаев из опубликованного манифеста — он взаимоисключим с `cases` (`400 invalid_request`) и обязан принадлежать тому же компоненту, что кандидат (`422 case_set_mismatch`).

**Исполнение.** Ран живёт вне screenshot-помпы: собственный цикл ставит capture-джобы по одной, оставляя интерактиву слоты очереди, ретраит только инфраструктурные исходы джобы и терминализуется watchdog'ом при превышении дедлайна профиля. Пережившие рестарт `queued|running`-раны переводятся в `error` стартовой уборкой — потеря дешёвая, потому что повтор переиспользует результаты случаев по `case_fingerprint` (в `progress.reused`). Гейты: `contract`, `defaults`, `render`, `determinism` (повтор на выборке, побайтово), `audit`, [`geometry` 2.0](#geometry-contract-20--probe-paint-волна-w3-план-2026-08-03) и [`readiness`](#deterministic-capture-readiness-волна-w4-план-2026-08-03) — обязательные; [`visual`](#минимальный-визуальный-гейт-приёмки-волна-w5a-план-2026-08-03-2-a5) — advisory в `default-v1` и `required` в `pixel-strict-v1` либо при `requireVisual` case-set-манифеста; `regression`/`interactions` — `not-implemented` и в свёртке не участвуют. Свёртка: `fail` — любой случай `fail` **или** `indeterminate` по обязательному гейту; `error` — инфраструктурный отказ и нет ни одного `fail`; `cancelled` — по cancel; иначе `pass`. `reused`/`skipped`/алиасы не маскируют `fail`.

**`GET /acceptance-runs/:runId`** отдаёт `status`, `statusReason` (названная причина терминального статуса, сегодня — `refresh_scope_empty`; иначе `null`), `policy {id,hash}`, `progress {total, completed, reused, frameReused, verdictRecomputed, rediffed, failed, running, eta {secondsRemaining, basis}}` (смысл счётчиков reuse — [ниже](#трёхслойный-отпечаток-случая-каскад-reuse-и-алгебра-refresh-волна-w1-план-2026-08-04)), `refresh {requested, impact, effective}`, `gates` (сводка «гейт → статус → сколько случаев»), `evidenceManifestHash` и `failedCases`, отсортированные по severity (`{rank, class, score}`) с перечнем провалившихся гейтов и их `detail`. **`/cases`** добавляет `propsHash`, `caseFingerprint`, `aliasOfCaseId`, `reuseReason`, качество капчура и `artifacts: [{name, sha256, bytes}]` — имена и адреса, но не содержимое, — плюс [квитанцию reuse](#компактная-сводка-рана-и-квитанция-reuse-волна-w8-план-2026-08-04) `reuseReceipt`. `?case=<caseId>` сужает ответ до одного случая; id вне набора рана — `404 not_found`, а не пустой список.

##### Компактная сводка рана и квитанция reuse (волна W8, план 2026-08-04)

**`GET /acceptance-runs/:runId?view=summary`** отдаёт тот же ран **компактно**: failed-ран на 25 случаев в полном виде — около 1800 строк (в каждом провале повторяются `metrics`/`regions`), в сводке — меньше 100. Форма:

```json
{
  "view": "summary",
  "runId": "acc_…", "status": "fail", "statusReason": null,
  "progress": {"total":25,"completed":25,"reused":0,"frameReused":25,"verdictRecomputed":0,"rediffed":25,"failed":8,"running":0},
  "gates": {"contract":"pass:25","visual":"pass:17 fail:8"},
  "refresh": {"requested":"verdict:failed","impact":"none","effective":"verdict:failed"},
  "failedCases": [{"caseId":"…","gate":"visual","raw":2.69,"aa":1.27,"cause":"surface-tint: …"}],
  "remediationGroups": {"<12 символов ключа>":"surface-tint ×8: caseId, caseId, …"},
  "evidenceUrl": "/api/acceptance-runs/acc_…/evidence"
}
```

- **`view=full` — дефолт и он не менялся**: вложенные `gates`, `remediationGroups`-массив объектов и полные `failedGates[].metrics` остаются там. Неизвестное значение `view` — `400 invalid_request`, а не тихий полный ответ.
- **Маркер `view:"summary"` в теле обязателен для клиента.** Гейт возможности — `capabilities.features.acceptanceSummaryView`, но одного флага мало: сервер до этой волны молча игнорирует незнакомый query и отвечает полным раном с кодом 200. Клиент проверяет **и** флаг, **и** маркер; при отсутствии маркера — сводит полный ран локально в ту же форму (`driver.mjs accept-status --summary` печатает `summarySource: "client"`).
- **Сводка не заменяет источник записи.** Ссылки, квитанции и любые производные (`cache.link`/`cache.receipt` харнеса) строятся из полного рана: сводка — вид для чтения, а не свидетельство.
- **Drill-down** — `GET /acceptance-runs/:runId/cases?case=<caseId>` (CLI `accept-status <runId> --case <caseId>`): полные гейты, причины, артефакты и квитанция ровно одного случая.

**Квитанция reuse (`reuseReceipt`)** отвечает на вопрос «что именно переиспользовано» **по уровням**, а не одним счётчиком: `{reuse: {candidate, frame, readiness, geometry, visualMetrics, verdict}, fingerprints: {frame, comparison, verdictPolicy, case}, reuseReason?}`. Она есть у каждого случая в `/cases` (`null` — строка старше миграции v29) и в манифесте evidence. Именно она различает «ничего не считали заново» и «вердикт пересчитан по новому порогу над переиспользованным кадром» — то, чего `progress.reused` по построению не различает.

Манифест evidence с этой волны несёт по случаю ещё и **эффективную вердиктную политику** — `verdictPolicy {hash, snapshot}`. Пара, а не один хэш: снимок отвечает читателю, каким порогом мерили, хэш проверяет, что снимок — тот самый (тот же валидатор, что у `acceptance_case_results.verdict_policy_json`).

**`GET /acceptance-runs/:runId/evidence`** — ZIP: `manifest.json`, `SHA256SUMS` (формат `sha256sum`, строки `"<sha256>  <caseId>/<name>"`) и сами артефакты по путям `<caseId>/<name>` (`render.png`, `geometry.json`, `determinism.png`, …). Манифест пишется при терминализации рана; до неё — `409 evidence_not_ready`. Сырьё тяжелее `limits.evidenceMaxBytes` — `413 evidence_too_large` (проверяется по размерам из манифеста, до чтения байтов). Артефакт, уже вычищенный GC evidence, остаётся строкой в `SHA256SUMS`, но отсутствует в архиве: `sha256sum -c` покажет ровно то, чего не хватает.

**`POST /acceptance-runs/:runId/cancel`** отменяет только `queued`-ран; бегущий не отменяется — `409 run_not_cancellable` (он завершится сам либо по watchdog'у).

#### Импакт и частичная пересъёмка (волна W6, план 2026-08-03 §3 D6)

Правка одного ассета в семье из 49 состояний не обязана стоить 49 капчуров. Импакт-анализ отвечает на вопрос «какие случаи baseline-набора могли измениться» — **доказательно** и только в двух узких классах; всё остальное честно деградирует в полную пересъёмку.

**`POST /components/:id/impact`** `{candidateId, baselineRunId}` → `{basis, candidateId, baselineRunId, baselineCandidateId, changedAssets[], changedTokens[], affectedCases[], unaffectedCases[], recaptureCount, reason}`. Ручка **ничего не пишет и ничего не снимает**. Кандидат обязан принадлежать компоненту из пути (иначе `404 not_found` — адрес кандидата не работает оракулом), baseline-ран — тоже (`422 baseline_run_mismatch`).

Три базиса:

- **`asset-only`** — `sourceShapeHash` кандидата совпал с baseline-кандидатским и версия темы та же. `sourceShapeHash` — sha256 исходника, в котором **каждый** литерал `asset_<sha256>` заменён плейсхолдером: совпадение доказывает, что структура кода, пропсы, разметка и стили побайтово те же, а изменились только ссылки на ассеты. `changedAssets` — симметрическая разность множеств литералов; затронуты случаи, чьи **наблюдённые** ассеты (`themeResources.icons ∪ images` из [readiness-evidence](#deterministic-capture-readiness-волна-w4-план-2026-08-03)) с ними пересекаются.
- **`theme-only`** — `sourceHash` совпал, сменилась версия темы ДС. `changedTokens` — имена CSS-кастом-проперти (`--eui-color-bg`) изменившихся/добавленных/удалённых токенов, `changedAssets` — asset-id добавленных и удалённых иконок; затронуты случаи, чьи наблюдённые токены/иконки с ними пересекаются. Изменение `@font-face` действует документ-широко и затрагивает **все** случаи (это отражено в `reason`).
- **`conservative`** — всё прочее: изменились и исходник, и тема; правка задела не-литерал (`sourceShapeHash` разошёлся); в candidate-кэше нет доказательств формы (запись вытеснена или собрана до W6); baseline нетерминален или без случаев; кандидат переехал между ДС. Затронуты все случаи, `recaptureCount` = число целевых.

**Случай без readiness-evidence — всегда затронут.** Динамический URL, вычищенный GC артефакт, кадр от шелла, не знающего протокол readiness, — всё это «неизвестно», а не «ресурсов нет». Молчаливого reuse не бывает даже внутри узкого базиса.

**Частичная пересъёмка.** `POST /acceptance-runs {candidateId, baselineRunId}` считает импакт **до** создания рана и возвращает его в `impact` ответа. Затронутые случаи снимаются как обычно; незатронутые получают вердикт и артефакты baseline-случая с `reuseReason: "impact:<basis>"`, и результат upsert'ится в кэш под **новым** `case_fingerprint` — поэтому следующий ран того же кандидата переиспользует их уже обычным путём. Перенос отменяется, если у baseline-случая нет вердикта или хотя бы один его артефакт вычищен из CAS: случай снимается заново. Явный `refresh` всегда перебивает импакт (форс — прямое указание автора). Применённый план записывается в `impact_json` рана и виден в `GET /acceptance-runs/:runId → impact` (`null` — импакт не считался). Импакт не входит в `case_fingerprint` и не меняет капчур, поэтому эта волна не поднимает `algoVersion` и накопленный reuse остаётся годным.

CLI: `driver.mjs impact <id> --candidate <candidateId> --baseline-run <runId>` (dry-run отчёт), `driver.mjs accept <id> --baseline-run <runId>` (частичный ран).

**Лимиты в discovery.** `limits.acceptanceMaxCasesPerRun` (случаев на ран), `limits.acceptanceMaxJobsPerRun` (capture-джоб на ран у профиля по умолчанию), `limits.acceptanceCaseTtlHours` (TTL кэша результатов случаев) и `limits.evidenceMaxBytes` (потолок байт evidence и экспорта).

#### Трёхслойный отпечаток случая, каскад reuse и алгебра refresh (волна W1, план 2026-08-04)

Плоский `case_fingerprint` смешивал в одном хэше три разнородные вещи — вход съёмки, вход сравнения и вход вердикта, — поэтому смена **одного числа** в политике («порог 2% → 0.5%») инвалидировала весь накопленный reuse и стоила полной пересъёмки матрицы. С этой волны отпечаток расслоён; `CASE_FINGERPRINT_ALGO_VERSION` поднят 5 → 6 (накопленный прод-кэш инвалидируется один раз, первый ран после деплоя — холодный).

| Слой | Что в нём | Что означает совпадение |
|---|---|---|
| `frameFingerprint` | `candidateId`, `caseKey`, `propsHash`, поверхность (viewport/dsf/theme), `readinessPolicyHash`, `rendererFingerprint` | пересъёмка даст те же пиксели ⇒ кадр из CAS можно переиспользовать |
| `comparisonFingerprint` | `referenceAssetId`, `cropLineage` (вкл. `sourceSurface`), `expectedGeometry`, `maxDimensionDeltaPx`, параметры канвы (`paintMargin`, `dsf`); `referenceSurface`/`referencePlacement` (W5) | метрики расхождения остаются в силе ⇒ пересчёт по ним законен |
| `verdictPolicyHash` | профиль и его пороги (`maxRawDiffPct`, geometry-допуски), `perCase`-оверрайды, `requireVisual`, состав и роли гейтов, `allowPaintOverflow`/`expectedClip`, `expectedGeometry`, `policy.profile` манифеста | решение по тем же метрикам будет тем же |

`case_fingerprint = sha256({algo: 6, frame, comparison, verdictPolicy})`. **`expectedGeometry` — двухслойное поле**: оно и допуск вердикта геометрии, и (с волны W5) `padTo` нормализации content-hug эталона, поэтому его смена уводит визуал в re-diff, а не в пересчёт по старым метрикам. Разбиение полей по слоям — типизированное и **тотальное**: новое поле политики или случая не соберётся, пока ему не назначен слой (значение `report-only` — обоснованное «ни в одном», а не пропуск).

Examples-путь больше не хэширует заглушку `CASE_POLICY_HASH_V0`: вердиктный слой строится из **реальной эффективной политики рана**, поэтому `--policy pixel-strict-v1` инвалидирует reuse и на examples-, и на case-set-пути.

**Каскад reuse.** По месту первого промаха, каждый шаг честно дороже предыдущего и честно дешевле пересъёмки:

| Путь | Условие | Счётчик `progress` | `reuseReason` |
|---|---|---|---|
| полный reuse | совпал `case_fingerprint` | `reused` + `frameReused` | `case_fingerprint` |
| recompute | совпали кадр и сравнение, разошёлся вердиктный слой | `frameReused` + `verdictRecomputed` | `recompute:policy` |
| re-diff | совпал кадр, разошлось сравнение | `frameReused` + `rediffed` | `rediff:comparison` |
| перенос baseline | импакт доказал «случай не мог измениться», слои сошлись | `reused` + `frameReused` | `impact:<basis>` |
| перенос + пересчёт | то же, но разошёлся вердикт/сравнение | `frameReused` + `verdictRecomputed`/`rediffed` | `impact:<basis>+recompute:policy`, `impact:<basis>+rediff:comparison` |
| пересъёмка | всё остальное | — | `null`, либо названная причина: `recapture:policy_snapshot_missing`, `recapture:policy_delta`, `recapture:frame_missing`, `recapture:frame_not_ready`, `recapture:no_verdict_delta`; при явном форсе — `refresh:all|failed|cases` |

`progress.reused` — **только полный** reuse (двусмысленность из фидбэка снята): `frameReused` — надмножество (кадр не снимался), `verdictRecomputed`/`rediffed` — отдельные счётчики. Re-diff учитывается в EMA длительности как оплачиваемая работа, пересчёт — нет.

Правила, которые каскад не нарушает ни при каких входных данных:

- **Пересчёт идёт по дельте политики, а не по имени гейта.** Отображение «поле политики → затронутые гейты» решает, что пересчитывается (`visual`, `geometry`), что переносится (гейты вне дельты) и что требует пересъёмки (затронутый непересчитываемый гейт — например, при переходе гейта в/из `not-implemented`).
- **Старая политика — снимок по значениям.** v29 хранит канонизованный `verdict_policy_json` рядом с `verdict_policy_hash` (хэш — валидатор снимка). Снимка нет, он нечитаем или хэш не сошёлся ⇒ дельта неизвестна ⇒ **пересъёмка, никогда перенос**. Тот же смысл у NULL-слоёв до-миграционных строк.
- **Геометрия пересчитывается от сырых `layoutBounds`/`paintBounds`/`effectSources`**, а не от `overflow`, уже отфильтрованного прежним допуском: иначе ужесточение допуска молча не срабатывало бы.
- **Кадр для re-diff — `paint.png` строки кэша**, с проверкой физического существования; нет кадра ⇒ `recapture:frame_missing`. Кадр, не прошедший readiness, визуального вердикта не получает и на re-diff (инвариант D5) ⇒ `recapture:frame_not_ready`.
- **Производные артефакты переписываются.** `visual.json`/`geometry.json` пересчитанного случая пишутся новыми записями CAS с `recomputed: true` и `derivedFrom: <sha предыдущей>`; байтовые артефакты (`paint.png`, `diff.png`) переиспользуются. Манифест evidence и содержимое артефакта случая всегда согласованы.
- **`policy.perCase`, адресующий случай с `aliasOf`, отвергается** `422 per_case_policy_on_alias`: вердикт алиаса идентичен вердикту цели, и такой допуск не был бы исполнен ничем.

**Kill-switch `EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE`** (объявлен в `docker-compose.yml`, по умолчанию включён). `0` выключает **и** recompute, **и** re-diff: любой промах `case_fingerprint` уводит в пересъёмку — но никогда в перенос устаревшего вердикта. Откат флага не ретроактивен: уже записанные пересчитанные строки остаются годными (их чистка — bump `algoVersion`).

**Алгебра refresh.** `refresh` получил **гранулярность**: `frame` — пересъёмка кадра, `verdict` — переоценка вердикта над переиспользованным кадром.

- `refresh: "failed"` — **verdict-скоуп**: «пересмотри упавшее», а не «пересними упавшее». Кадр берётся из CAS при совпавшем `frameFingerprint`, поэтому `recapture = 0` — законный исход, а не ошибка. Флаг `recapture: true` (CLI `--recapture`) поднимает его до frame-скоупа.
- `refresh: "all"` и `refresh: {caseIds}` — frame-скоуп (прежняя семантика «переснять»).
- **Флейк-ретрай не потерян:** если у упавшего случая нет дельты вердикта/сравнения относительно кэша, пересчитывать нечего — verdict-скоуп эскалируется до пересъёмки (`recapture:no_verdict_delta`).
- `forceOf("failed")` ищет прошлый провал сначала в вердиктах baseline-рана, затем frame-lookup'ом (`ORDER BY last_used_at DESC LIMIT 1`, с фильтром по `component_id`). Раньше он искал по **новому** `case_fingerprint`, и после смены порога форс молча снимался — корневая причина P0-3/P0-4 фидбэка.

Ран несёт тройку `refresh {requested, impact, effective}` (`effective = requested ∪ impact`) — она считается на постановке, персистится (`acceptance_runs.refresh_json`) и отдаётся и в 202-ответе `POST /acceptance-runs`, и в `GET /acceptance-runs/:runId`. **Импакт-часть плана не форсит пересъёмку**: она запрещает перенос вердикта baseline, тогда как отпечаток доказывает строго больше («входы случая те же»), поэтому reuse по совпавшим слоям законен и для затронутого случая.

**`refresh_scope_empty`.** Если явный скоуп непуст, хотя бы один случай отдан из кэша и при этом **ни один** не был переснят, пере-диффнут или пересчитан — форс не сделал ничего, и ран терминализуется как `error` с `statusReason: "refresh_scope_empty"` (постановка асинхронна, поэтому это исход рана, а не `422`). Статически вычислимые отказы скоупа (`caseIds` вне набора) остаются `422 unknown_case_id` на постановке. Первый ран с пустым кэшем через предикат проходит: там ничего и не переиспользовалось.

### Case-set-манифесты: наборы случаев семьи

Именованных `definition.examples` хватает атому, но не семье из десятков состояний с эталонами из Figma. Такой набор описывается **манифестом** и живёт отдельной сущностью (`component_case_sets`, миграция v26), а не ассетом: сервер обязан проверять полноту tuples, ссылки на эталоны, дубли props и crop lineage. Гейт и авторизация — те же, что у ручек приёмки (`EASYUI_ACCEPTANCE_MATRIX=1`, владелец компонента или админ; `share`/`capture` — `403`).

| Метод | Путь | Ответ |
|---|---|---|
| `PUT` | `/components/:id/case-sets` | `200` `{caseSetId, componentId, designSystem, cases, cached, coverage, warnings}` |
| `POST` | `/components/:id/case-sets/validate` | `200` `{caseSetId, componentId, designSystem, cases {count, ids}, coverage, warnings, wouldBeCached}` — dry-run без записи |
| `GET` | `/case-sets/:caseSetId` | `200` строка набора + `manifest` |
| `GET` | `/case-sets/:caseSetId/coverage` | `200` покрытие измерений |

**Контентная адресация.** `caseSetId = "cset_" + sha256(canonicalJson(manifest))`. Повторный `PUT` того же манифеста возвращает ту же строку с `cached: true` и **ничего не переписывает**; изменённый манифест — новый набор с новым id, поэтому раны, сославшиеся на прежний, остаются воспроизводимыми. Строка денормализует `componentId`, `designSystem`, `case_count` и Figma-`source`.

**Манифест** (`manifestVersion: 1`, strict-объекты — неизвестное поле отвергается):

```jsonc
{
  "manifestVersion": 1,
  "componentId": "pay-payment-card",
  "source": { "fileKey": "…", "componentSetNodeId": "54863:9518" },   // опционально
  "capture": { "viewport": {"width": 390, "height": 844}, "deviceScaleFactor": 2, "theme": "light" },
  "dimensions": { "family": ["Product", "Split"], "state": ["Default", "Disabled"] },  // опционально
  "requireVisual": false,                                              // намерение для гейта visual (W5a)
  "policy": { "profile": "pixel-strict-v1", "perCase": { "split-disabled": { "maxRawDiffPct": 2 } } },
  "cases": [{
    "id": "product-default",                                           // ^[A-Za-z0-9._-]{1,64}$
    "props": { "family": "Product", "state": "Default" },
    "dims": { "family": "Product", "state": "Default" },               // координата в матрице
    "referenceAssetId": "asset_<sha256>",                              // эталон из реестра ассетов
    "referenceSurface": "content-hug",                                 // чем является ассет (W5; по умолчанию "paint")
    "referencePlacement": { "x": 128, "y": 128 },                      // место в канве, device px (по умолчанию margin×dsf)
    "expectedGeometry": { "width": 140, "height": 96 },                // ЛЕЙАУТ-КОРЕНЬ в CSS px, не канва сравнения
    "cropLineage": { "parentNodeId": "54863:9518", "rect": [0, 0, 140, 96], "sourceSurface": "figma-node" },
    "aliasOf": null                                                    // явный дубликат props
  }]
}
```

**Двухчастный контракт эталона (волна W5, план 2026-08-04; фидбэк P1).** `expectedGeometry` и
поверхность сравнения — **разные величины**, и их путаница стоила `pay-card-button` 12 провалов из
12: геометрия судит layout-корень компонента, а визуал сравнивает padded paint-канву
(`корень + 2×64 px маргина`, всё × `deviceScaleFactor`), внутри которой компонент лежит со
смещением `margin × dsf`.

| Поле | Что описывает | Кто читает |
|---|---|---|
| `expectedGeometry` | габариты **layout-корня** в CSS px | гейт `geometry` (допуски) и гейт `visual` (`padTo` канвы) |
| `referenceSurface` | чем является ассет: `"paint"` (уже каноническая канва, дефолт) или `"content-hug"` (штатный экспорт узла) | гейт `visual` |
| `referencePlacement` | смещение content-hug эталона внутри канвы, **device px**; по умолчанию `margin × dsf` | гейт `visual` |
| `cropLineage.rect` | прямоугольник происхождения эталона | гейт `visual` — **только если** `sourceSurface` говорит, что резать надо |
| `cropLineage.sourceSurface` | в координатах какой поверхности записан `rect`: `figma-node` (резать; дефолт при отсутствии поля), `content-hug`/`paint` (уже вырезано, rect — provenance) | гейт `visual` |

С `referenceSurface: "content-hug"` **сервер сам** строит каноническую канву: паддит эталон
прозрачным до `(expectedGeometry + 2×margin) × dsf` и кладёт его по `referencePlacement`. Ручной
паддинг PNG и подглядывание размеров канвы в диагностике упавшего рана больше не нужны. Корень
берётся из `expectedGeometry`, а при его отсутствии — из измеренного в этом же ране `layoutBounds`;
если недоступно ни то, ни другое (re-diff без свежей геометрии) — `indeterminate` с
`reason: "reference_canvas_unresolved"`, а не сравнение с канвой, построенной наугад.

Все три новых поля **строго опциональны и без zod-дефолтов**: дефолт применяет потребитель.
`caseSetId` — контентный адрес `parsed.data`, поэтому дефолт в схеме сменил бы адрес всех уже
опубликованных манифестов. Следствие-инвариант: манифест, который новых полей не объявляет,
сравнивается **побайтово так же, как до W5** (паддинг — только при `content-hug`, crop — как
сегодня), и его `cset_` не двигается.

Charset `case.id` совпадает с charset имён записей evidence-архива (защита от zip-slip), поэтому **Figma node id вида `54863:9537` не проходит** — санитизировать на клиенте.

**Отказы `PUT`** (все `422`): `validation_failed` (схема, charset, `cropLineage.rect` с отрицательными координатами или нулевым размером), `case_set_component_mismatch` (манифест описывает другой `componentId`), `case_set_too_large` (больше `limits.acceptanceMaxCasesPerRun` случаев), `case_set_coverage_too_large` (декартово произведение `dimensions` больше `limits.caseSetMaxExpectedTuples`; считается перемножением длин осей до материализации), `duplicate_case_id`, `duplicate_case_props` (одинаковые props без `aliasOf`), `invalid_alias_target` (цель отсутствует, сама является алиасом или имеет другие props), `asset_not_found` (эталона нет в реестре), `crop_rect_out_of_bounds` (применяемый `rect` не помещается в размеры ассета — раньше воркер молча клампил вырезку и сравнивал не то, что объявлено), `crop_lineage_conflict` (`referenceSurface: "content-hug"` вместе с `cropLineage` требует `sourceSurface: "figma-node"`: «ассет уже вырезан» и «вырежи из него» — взаимоисключающие утверждения об одном ассете).

**Предупреждения, а не отказы** (`warnings[]`): `expectedGeometry`, равный размерам эталона и похожий на padded-канву (`корень + 2×64`) — тот самый способ уронить геометрию 12/12; `referenceSurface: "content-hug"` без `expectedGeometry` (канва будет выведена из измеренного `layoutBounds`); неполные/недекларированные `dims` и расхождение props со схемой опубликованной версии компонента — схема головы законно отличается от последней публикации, а манифест часто готовится до правки компонента.

**Coverage** (`GET /case-sets/:caseSetId/coverage`): `dimensions`, `expectedTuples` (декартово произведение), `presentTuples` (различные tuples из `cases[].dims`), `missingTuples[]` (не более **64** ячеек), `missingCount` (полное число незакрытых ячеек), `truncated` и `duplicates[] {tuple, caseIds}`. Считать пропуски по `missingTuples.length` нельзя — на больших семьях список усечён; истина в `missingCount`. Манифест без `dimensions` получает тривиальный отчёт (`expectedTuples: 0`, `presentTuples` = число случаев): фиктивное произведение по неполной Figma-матрице не выдумывается.

**Лимиты набора** (все — в `GET /api/capabilities` → `limits`, волна 2026-08-04 W6):

| Лимит | Значение | Смысл |
|---|---|---|
| `caseSetManifestVersion` | `1` | единственная принимаемая версия манифеста |
| `caseSetMaxCases` | `512` | абсолютный потолок массива `cases` (защита парсера); продуктовый потолок рана — `acceptanceMaxCasesPerRun` |
| `caseSetMaxDimensions` | `8` | число осей `dimensions` |
| `caseSetMaxDimensionValues` | `64` | значений в одной оси; **≥ `acceptanceMaxCasesPerRun` by design** — одна каноническая ось обязана вмещать целый ран, иначе семья из 49 состояний шардируется только из-за схемы |
| `caseSetMaxExpectedTuples` | `4096` | потолок декартова произведения `dimensions`; превышение — `422 case_set_coverage_too_large` |

Потолок произведения проверяется **перемножением длин осей**, до построения хотя бы одной ячейки: 8 осей по 64 значения — это 2.8·10^14 tuples, и материализация такого произведения убила бы процесс. Отказ приходит на обоих путях — при `PUT`/`validate` манифеста и при чтении `/coverage`.

**Sparse-семьи: одна каноническая ось.** Семья, чьи состояния не раскладываются в честную решётку (Figma-матрица с дырами), описывается **одной** осью с перечислением состояний (`dimensions: {state: [… 49 значений …]}`), а не произведением осей с `missingTuples` в половине ячеек. 49 состояний — это один `case-set` и один ран: шардировать вручную не нужно и не следует (два набора = два `cset_`, два рана и ручная сшивка provenance).

**Подсказки схемы, на которых чаще всего спотыкаются.** `componentId` — **обязательное** поле манифеста и обязано совпадать с id в пути (`422 case_set_component_mismatch`). `null` схема не принимает **нигде**: необязательное поле надо **опускать**, а не занулять — `"cropLineage": null` это `422 validation_failed`, а не «нет lineage» (то же верно для `expectedGeometry`, `referenceSurface`, `dims`, `aliasOf`, `source`, `policy`).

**Dry-run: `POST /components/:id/case-sets/validate`.** Те же проверки, что у `PUT`, **без записи**: ответ несёт вычисленный `caseSetId`, `cases {count, ids}` (набор случаев рана в том виде, в каком его построил бы оркестратор — с алиасами и отказом `empty_case_set`), `coverage`, `warnings` и `wouldBeCached` (набор с таким адресом уже опубликован, то есть `PUT` был бы идемпотентным повтором). Гейт возможности — `capabilities.features.caseSetValidate`; авторизация и коды отказов — как у `PUT`. Раньше единственным способом узнать вердикт сервера была мутирующая публикация, и черновой манифест оставлял в базе `cset_`-строку навсегда.

**Ран по набору.** `POST /acceptance-runs {candidateId, caseSetId}` строит случаи из манифеста: `capture` задаёт поверхность съёмки, `referenceAssetId`/`referenceSurface`/`referencePlacement`/`expectedGeometry`/`cropLineage` уезжают в durable-строки случаев, `policy.profile` + `policy.perCase[caseId]` дают `case_policy_hash`, который входит в `case_fingerprint` — правка допуска одного случая инвалидирует reuse ровно его. Эталон и его нормализацию потребляет [визуальный гейт](#минимальный-визуальный-гейт-приёмки-волна-w5a-план-2026-08-03-2-a5); все поля происхождения эталона — входы `comparisonFingerprint`, поэтому их правка даёт **re-diff** (пересравнение сохранённого кадра), а не пересъёмку и не пересчёт по старым метрикам.

### Поиск кандидатов на переиспользование

| Метод и путь | Тело / ответ |
|---|---|
| `GET /catalog/candidates?designSystem=&intent=&limit=` | `{designSystem,catalogRevision,policyVersion,candidates[]}`; поиск по одной формулировке задачи |
| `POST /catalog/candidates` | `{designSystem,intent,limit?,proposed?}` → то же тело; при `proposed.source` дополнительно `overrideTemplate:{catalogRevision,candidateKeys}`; при `proposed.kind:"composition"` — `outcome`/`explanation`/`matches`/`analyzerVerdict`/`dependencyImpact` (см. ниже) |

Оба метода требуют именованного пользователя: share- и capture-принципалы получают `403 forbidden` — иначе публичная ссылка на прототип открывала бы индекс каталога. Ответ `no-store`.

`GET` существует ради вызывающих без браузерного `Origin` (агент, CLI): `enforceOrigin` срабатывает только на unsafe-методах, поэтому `POST` без `Origin` даёт `403 origin_required`. Плата — отсутствие `proposed`: в query едут только `designSystem`, `intent` и `limit`.

`intent` валидируется так же, как в `POST /components` (см. ниже). `limit` — 1..20, по умолчанию 8; он усекает **только выдачу** и не влияет ни на blocking-набор гейта, ни на `overrideTemplate.candidateKeys`. Неизвестная или отставленная (`retired`) система — `404 not_found`.

Строка кандидата компактная: `{kind,id,name,designSystem,version,draft,description,atomicLevel?,scope?,canonicalFor,replacement?,deprecated,recommendable,headUsageCount,score,blocking,reasons[]}`. Ни исходника, ни `propsJsonSchema`, ни примеров, ни внутренних `signals` в ней нет — за точным определением выбранного кандидата идите в `GET /components/:id/versions/:version`. `draft:true` и `version:0` означают head-драфт: он участвует в корпусе, но метаданных публикации у него ещё нет. `recommendable:false` — кандидат показан ради объяснения (deprecated с живой заменой), а не как цель переиспользования.

`proposed` описывает то, что вызывающий собирается создать: `{kind:"component",id?,name?,description?,atomicLevel?,scope?,canonicalFor?,propsJsonSchema?,events?,slots?,source?}`. Если передан `source`, сервер извлекает метаданные из него сам, а присланные `propsJsonSchema`/`canonicalFor` проигрывают извлечённым: подделать сигналы через тело нельзя. Невалидный исходник отвечает теми же кодами, что и создание компонента (`422 validation_failed`, `422 event_schema_not_serializable`, `413 payload_too_large`). Артефакт с тем же `(designSystem, proposed.id)` из корпуса исключается — поиск по существующему id не возвращает его самого.

#### Композиционный кандидат: три исхода workbench (W9)

`POST /catalog/candidates` с `proposed.kind:"composition"` отвечает на вопрос «собирать композицию, расширять компонент или писать ownership-компонент». Прежний отказ `422 unsupported_kind` снят.

Вход: `{designSystem,intent,limit?,proposed:{kind:"composition",id?,name?,description?,atomicLevel?,scope?,canonicalFor?,slots?,events?,propsJsonSchema?,compositionDoc?}}`. `proposed.source` для композиции — `422 validation_failed` (исходник — контракт компонента). `compositionDoc` **не обязан** проходить строгую схему (кандидат приходит черновиком), но без него сервер видит только имя/описание/контракт: ни структурная сигнатура тела, ни вердикт анализатора не считаются.

Ответ добавляет к обычному телу:

- `outcome` — `build-composition` | `extend-component` | `new-ownership-component`, и `explanation` — человеческая формулировка с именем найденного артефакта;
- `matches[]` — `{kind,id,name,version,score,blocking,recommendable,why}` по тем же кандидатам, что и `candidates[]`;
- `analyzerVerdict` + `analysis:{reasons,unsupported,schemaValid,stats}` — вердикт того же анализатора, что у `POST /compositions/analyze` (только если передан `compositionDoc`);
- `dependencyImpact:{components[],compositions[],unknownTypes[]}` — `usages` компонентов тела и вложенных композиций.

Порядок решения: точный структурный дубль композиции → `build-composition` с указанием существующей (её и надо переиспользовать); сильный мэтч компонента → `extend-component`; вердикт анализатора `needs-ownership-component` → `new-ownership-component`; иначе `build-composition`.

**Исход рекомендательный.** Гейт переиспользования (`409 component_reuse_required`) на композиции не распространяется: сервер объясняет и предлагает, но ничего не запрещает. Включение enforce — отдельное решение, ему нужен замер распределения score на композиционных парах.

Корпус матчинга для композиционного кандидата дополнительно содержит **head-ревизии живых композиций** системы (`kind:"composition"`, `version:0`/`draft:true` у неопубликованной): без этого дубль существующей композиции не детектировался бы вовсе. Сигнал «тело» у композиции — структурная сигнатура (типы элементов, форма дерева, имена props, контракт `params`/`slots`), значения props в неё не входят; между разными типами артефактов этот сигнал неприменим, и кросс-типовой мэтч опирается на имя, описание, контракт и роли. Пороги композиционных пар отдельные и консервативнее компонентных; `policyVersion` — тот же. Гейт создания компонента композиций в корпусе **не видит**.

`catalogRevision` — sha256-проекция каталога, общая с `GET /catalog/library` и с гейтом: она **не** реагирует на счётчики использования, статусы визуальных прогонов, figma и preview, поэтому подготовленный override не протухает от чужой работы. `policyVersion` — версия политики матчинга (веса и пороги); score корпус-относителен, и без неё решение невоспроизводимо задним числом. Оба значения совпадают с теми, что вернутся из `GET /api/capabilities` (`reuseGate.policyVersion`) и лягут в аудит.

### Reuse gate при создании и публикации компонента

`POST /components` сопоставляет новую TSX-реализацию с актуальным каталогом той же дизайн-системы. Перед созданием клиенту следует вызвать `GET` или `POST /catalog/candidates`: ответ содержит `catalogRevision` и компактные строки кандидатов, которые не обещают поле `key`. Только source-backed `POST /catalog/candidates` возвращает полный авторитетный набор ключей, и только в `overrideTemplate.candidateKeys`. Поиск помогает выбрать уже существующий компонент, но не заменяет проверку самого `POST /components` — сервер повторно вычисляет решение в одной транзакции.

**Фазы гейта.** У гейта две фазы, и они меняют поведение одних и тех же запросов, поэтому фазу нужно прочитать **до** create, а не выяснять по ошибке:

| | `shadow` | `enforce` |
|---|---|---|
| `intent` в `POST /components` | необязателен; синтезируется из имени, ответ несёт `warnings[]` | обязателен, иначе `400 invalid_request` |
| blocking-совпадение на create | компонент создаётся, ответ несёт `warnings[]` | `409 component_reuse_required`, артефакта не остаётся |
| запись аудита | `would_block` (плюс отдельная `intent_missing`, если поле не прислали) | `blocked` |
| `reuse_blocked` в отчёте `POST /bundles/import` | не выставляется | выставляется по-элементно |

От фазы **не зависят**: конфликт канонической роли (`409 canonical_role_conflict` на create и publish), валидация уже присланного `intent`, правила `reuseOverride` и сама запись решений в аудит. Фаза задаётся переменной окружения `REUSE_GATE` (см. [Deployment](#deployment)), читается один раз на старте процесса и публикуется в discovery:

```json
"reuseGate": { "mode": "shadow", "intentRequired": false, "policyVersion": 1 }
```

`GET /api/capabilities` — единственный поддерживаемый способ узнать фазу: `reuseGate.intentRequired` истинно ровно в `enforce`. Клиент, который умеет обе фазы, шлёт `intent` всегда (в `shadow` он тоже валидируется и попадает в аудит) и не полагается на то, что создание дубликата пройдёт.

`intent` описывает продуктовую задачу нового компонента. В фазе `enforce` он обязателен; строка сначала `trim`-ится, затем должна иметь от 8 до 500 символов и хотя бы один токен вне стоп-набора `component`, `компонент`, `element`, `элемент`, `ui`. В `shadow` поле можно не передавать: сервер синтезирует intent из имени, возвращает предупреждение и отдельно пишет в аудит решение `intent_missing`. Если `intent` передан в любой фазе, он всегда валидируется по тем же правилам.

Когда сервер требует повторно использовать компонент или обнаруживает конфликт канонической роли, он возвращает `409` с конвертом `error`. `error.code` — один из `component_reuse_required`, `catalog_changed`, `canonical_role_conflict`. В конверте есть `catalogRevision`, `decisionId`, `repeatedAttempts:number|null` (число повторных blocked-попыток, либо `null`, если best-effort аудит недоступен), `candidates` (доступный материал кандидатов: `key`, id/name, дизайн-система, версия/draft, description, atomic/scope/canonical metadata, recommendation/deprecation, usage, score, blocking, reasons и при наличии `propsDelta`), `policyVersion`, `resolution`, `nextSteps`, `overrideTemplate:{catalogRevision,candidateKeys}` и `retryable:false`. Для `canonical_role_conflict` дополнительно есть `conflictingRoles`. Полный набор требуемых blocking-ключей берите из `overrideTemplate.candidateKeys`; top-level `candidateKeys` в create-409 нет, и нельзя подменять этот набор отфильтрованной UI-выборкой.

`reuseOverride` — только для администратора и только после двухфазного подтверждения человеком. Сначала прочитайте кандидатов/получите `409` и сохраните его `catalogRevision` с **полным** `candidateKeys`; затем повторите raw API-запрос с `{catalogRevision,candidateKeys,reason}`. `reason` после trim должен быть 20..500 символов. Сервер заново считает кандидатов: устаревшая ревизия даёт `409 catalog_changed`, а неполный список ключей не подтверждает override. Не делайте авто-ретрай и не выполняйте auto-`force-new`: покажите кандидатов и `decisionId` человеку для решения.

`POST /components/:id/publish` не запускает create-only решение `component_reuse_required`, но перед staging проверяет уникальность новых `canonicalFor` публикуемой ревизии. При конфликте первый запрос без override терминально отвечает `409 canonical_role_conflict` (`retryable:false`) с тем же типизированным reuse-конвертом и авторитетным `overrideTemplate`. После решения человека администратор может повторить publish с `reuseOverride:{catalogRevision,candidateKeys,reason}`; не-администратор получает `403 admin_required`, а сдвиг каталога между фазами — терминальный `409 catalog_changed` с обновлённым шаблоном. Клиент не должен автоматически повторять ни один из этих `409`: он снова показывает результат человеку и начинает двухфазное подтверждение с актуального `overrideTemplate`.

### Аудит решений гейта

`GET /catalog/reuse-decisions` — **только админ** (`401 unauthorized` анонимному, `403 forbidden` не-админу и share/capture-принципалам), только чтение: таблица решений append-only и защищена триггерами БД. Фильтры query: `since` (ISO, строго новее), `designSystem`, `actorId`, `limit`, `minAttempts`. Ответ `no-store` и собирается одной транзакцией, поэтому агрегаты сходятся с перечислениями под ними: `{generatedAt, gateActiveSince, filter, totals, forceNew[], repeatedBlocked[], canonicalRoleConflicts[], wouldBlock[], unreviewed[]}`.

`forceNew` — кто и по какой человеческой причине обошёл гейт; `repeatedBlocked` — агрегация повторных блокировок по паре actor/artifact (порог — `minAttempts`), то есть застрявшие вызывающие; `canonicalRoleConflicts` — попытки забрать занятую каноническую роль; `wouldBlock` — то, что в `shadow` было бы отклонено в `enforce` (материал критерия включения фазы); `unreviewed` — компоненты каталога, созданные до гейта и ни разу не проходившие reuse-review. `gateActiveSince` — время первой записи: без него нулевые выборки читаются как «нарушений нет», хотя означают «гейта тогда ещё не было».

### Граф использования компонентов

`GET /components/:id/usages` отвечает на вопрос «что сломается, если это тронуть». Источник правды — таблица пинов `prototype_revision_components`; документ головной ревизии разбирается поверх пинов только ради точных ключей экрана/элемента.

```json
{
  "componentId": "yp-button", "name": "YpButton",
  "currentHeadUsages": [{
    "prototypeId": "checkout", "name": "Checkout", "kind": "product-flow", "rev": 12, "componentVersion": 4,
    "screens": [{ "screenId": "home", "screenName": "Home", "elementKeys": ["pay", "retry"] }]
  }],
  "immutableUsages": [{ "prototypeId": "checkout", "name": "Checkout", "version": 3, "componentVersion": 2 }],
  "versionsInUse": [2, 4],
  "safeToRemove": false
}
```

- `currentHeadUsages` — пины на **головных** ревизиях: то, что живо прямо сейчас.
- `immutableUsages` — пины на ревизиях, на которые ссылаются `prototype_publishes`. Их бандлы обязаны исполняться вечно, поэтому любая такая ссылка снимает `safeToRemove`.
- `safeToRemove` = обе оси пусты.
- `?format=tree` возвращает `{format:"tree", nodes:[{kind:"prototype"|"screen"|"element", id, label, children?}], …}` — те же данные, сгруппированные путями (используется кнопкой «Показать usages» в библиотеке). SPA-ссылки строит клиент.
- Компонент-надгробие тоже имеет читаемый граф: `usages` не фильтрует по `deleted_at`.

`GET /catalog/usages?designSystem=` — агрегированный индекс: `{components:[{componentId,name,designSystem,headUsageCount,prototypes:[{prototypeId,name,kind,rev}]}]}`. Ответ кэшируется в памяти; ключ инвалидации — `MAX(prototypes.updated_at)` (плюс `COUNT(*)`, чтобы поймать удаление прототипа, которое не двигает максимум). Тот же кэш питает поля `headUsageCount`/`deprecated` в `GET /catalog/manifest`, где `deprecated` означает «последняя публикация компонента переведена в `deprecated`/`superseded`» (строка манифеста по построению всегда `active`).

### Статусы версий компонентов

Каждая опубликованная версия имеет lifecycle-статус в `component_publishes.status` (+`status_reason`, `superseded_by`, `status_rev`). `staging`/`failed` — внутренние стадии publish-пайплайна и **вручную не управляются**. Остальные переходы задаёт `POST …/versions/:version/status` с CAS по `statusRev` (не `headRev`).

**Матрица переходов** (иные → `422 invalid_transition`):

| Из | Разрешённые цели |
|---|---|
| `active` | `rejected`, `deprecated`, `superseded`, `archived` |
| `deprecated` | `archived`, `active` |
| `superseded` | `archived`, `active` |
| `rejected` | `archived` |
| `archived` | — (терминальный) |
| `staging`, `failed` | — (только пайплайн) |

- **CAS.** `baseStatusRev≠current` → `409 status_conflict` с `currentStatusRev`. Успешный переход возвращает новый `statusRev` (инкремент).
- **`reason`.** Обязателен для `rejected` (иначе `422 validation_failed`, `issues[].path=["reason"]`); сохраняется в `statusReason` и очищается при переходах без `reason`.
- **`supersededBy`.** Обязателен для `superseded`: версия **того же** компонента, существует, не сама себя, без циклов (обход цепочки `superseded_by`); нарушение → `422 validation_failed`. Хранится только пока статус `superseded`, иначе сбрасывается в NULL.

**Семантика исполнения.**

- **Новые пины и `/catalog/manifest`** резолвят только `active`-версии: `rejected`/`deprecated`/`superseded` в новые прототипы не подхватываются.
- **Существующие пины** (`prototype_revision_components`): bundle отдаётся при `active|deprecated|superseded` (старые прототипы продолжают рендериться), а `rejected|archived|failed|staging` → `404 bundle_unavailable`. `rejected` трактуется как потенциально вредный код и не исполняется.
- **render-status** для пинов на `deprecated|superseded` добавляет `warnings` `pin_deprecated`/`pin_superseded` (renderable), а на `rejected|archived|failed|staging` — `errors` `bundle_failed` (не renderable).
- **Метадата** любой версии (`GET …/versions/:version`) читается независимо от статуса.

Миграция v8 расширяет `CHECK(status)` строгим rebuild-алгоритмом `component_publishes`: снапшот всех FK-child (`prototype_revision_components` RESTRICT, `component_publish_assets` CASCADE) → drop children → rebuild parent → recreate children → restore rows → `PRAGMA foreign_key_check`.

## Endpoints композиций

Композиция — версионированный декларативный фрагмент экрана с параметрами и именованными слотами; грамматика документа и правила раскрытия — в [формате прототипа](prototype-format.md#versioned-compositions). Ресурс зеркалит компонентный: slug-`id`, глобально уникальное `name`, `headRev` + ревизии + неизменяемые публикации + мягкое удаление. Отличие одно: компилировать нечего — артефактом публикации является сам документ, а `sourceHash` считается как sha256 его канонического JSON (ключи отсортированы, `undefined` отброшены).

Миграция **v18** добавила четыре таблицы (только `CREATE TABLE`, перестройка существующих не требуется):

- `compositions(id PK, name UNIQUE, head_rev, design_system FK→design_systems, owner_id FK→users, deleted_at, delete_reason, created_at, updated_at)`;
- `composition_revisions(composition_id, rev, doc, design_system, message, author, created_at)`, PK `(composition_id, rev)`;
- `composition_publishes(composition_id, version, rev, status, status_reason, superseded_by, status_rev, source_hash, message, published_at)`, PK `(composition_id, version)`, `UNIQUE (composition_id, rev)`, `CHECK(status IN ('active','deprecated','superseded','archived'))` — компонентных `staging`/`failed` здесь нет, сборки у композиции не существует;
- `prototype_revision_compositions(prototype_id, rev, composition_id, composition_version)` — пины ревизии прототипа; FK на `prototype_revisions` — `ON DELETE CASCADE`, FK на `composition_publishes` — **`ON DELETE RESTRICT`**, тот же инвариант, что у компонентных пинов: опубликованная версия прототипа не может ссылаться на исчезающую публикацию композиции.

| Метод и путь | Тело / ответ |
|---|---|
| `GET /compositions` | `{id,name,designSystem,headRev,latestVersion:number|null,updatedAt,description?,params:string[],slots:string[]}[]` (последняя active-версия в `latestVersion`); `?includeDeleted=1` дополнительно возвращает надгробия с `{deleted:true,deletedAt,reason}` |
| `POST /compositions` | `{id,doc,designSystem,message?}` → 201 `{id,rev:1}` и `Location`; неизвестное поле тела → `400 invalid_request`; `id` не slug → `422`; занятые `id`/`name` → `409 already_exists` |
| `GET /compositions/:id` | `{id,name,designSystem,headRev,versions:CompositionVersion[],updatedAt,publishedVersion:number|null,doc}`; мягко удалённая композиция — **404**, если не передан `?includeDeleted=1` (тогда meta дополняется `{deleted:true,deletedAt,reason}`) |
| `PUT /compositions/:id` | `{doc,message?,baseRev}` → `{rev}`; конфликт имени с другой композицией → `409 already_exists` |
| `DELETE /compositions/:id` | `{baseRev,reason?,force?}` → 204; `409 composition_in_use`, пока композицию пинуют головные ревизии прототипов (обход — `force:true` от админа, иначе `403 admin_required`) |
| `GET /compositions/:id/revisions` | `{rev,message:string|null,createdAt}[]`, новые первыми |
| `GET /compositions/:id/revisions/:rev` | `{rev,doc,designSystem,message:string|null,createdAt}` |
| `POST /compositions/:id/publish` | `{message?,baseRev}` → 201 `{version,rev}` и `Location`; повторная публикация той же ревизии → `409 already_published` |
| `GET /compositions/:id/versions` | `CompositionVersion[]`: `{version,rev,status,statusReason:string\|null,supersededBy:number\|null,statusRev,sourceHash,publishedAt}` |
| `GET /compositions/:id/versions/:version` | Метадата версии любого статуса + замороженный документ: `CompositionVersion & {doc,designSystem}`; immutable |
| `POST /compositions/:id/versions/:version/status` | `{status,reason?,supersededBy?,baseStatusRev}` → 200 `{status,statusRev}`; CAS по `statusRev`; `status:"superseded"` требует `supersededBy` |
| `GET /compositions/:id/usages` | `{currentHeadUsages:[{prototypeId,name,kind,rev,version}],immutableUsages:[{prototypeId,version,compositionVersion}],safeToRemove}` |

**Авторизация.** Чтение (list/meta/revisions/versions/usages) доступно любому аутентифицированному пользователю; анонимный доступ, share и capture-scope — нет (строка «Остальной API» в матрице принципалов). `POST` требует владения **дизайн-системой** композиции, остальные мутации — владения самой композицией (или прав админа). Audit-события: `composition.revision.saved`, `composition.version.published`, `composition.status.changed`, `composition.deleted`.

**CAS.** Все мутации существующей композиции требуют `baseRev` (отсутствует → `400 base_rev_required`, расхождение → `409 revision_conflict` с `currentRev`); переход статуса версии — `baseStatusRev` (расхождение → `409 status_conflict` с `currentStatusRev`). Матрица переходов: `active → deprecated|superseded|archived`, `deprecated → archived|active`, `superseded → archived|active`, `archived` терминальный; иное → `422 invalid_transition`. Переход в `superseded` требует `supersededBy` — ровно как у компонента: отсутствие/не-целое → `422 validation_failed` с `issues[].path = ["supersededBy"]`, ссылка на себя, на несуществующую версию или образующая цикл по цепочке `superseded_by` — тоже `422`.

**Каталог композиции.** Каждый тип элемента документа обязан быть host-примитивом либо **опубликованным** компонентом той же дизайн-системы — проверка выполняется на `POST` и `PUT` (`422 validation_failed`). Иначе раскрытие в save-пути прототипа не нашло бы пина компонента.

**Разрешение ссылок и пины.** Прототип ссылается на композицию элементом `@eui/Composition`. При сохранении прототипа сервер резолвит каждую ссылку в **последнюю `active`-публикацию** живой композиции той же дизайн-системы; неизвестная, неопубликованная или чужая по системе композиция → `422 validation_failed`. Раскрытие (`expandPrototypeForSave`) выполняется **до** `snapshotDefinitions` и `collectAndValidateAssetRefs`, поэтому компонент или ассет, встречающийся только внутри композиции, всё равно попадает в `prototype_revision_components` / `prototype_revision_assets`. В БД сохраняется **авторский** документ, пины — от раскрытого; `restore` копирует пины композиций исходной ревизии, а удаление композиции параллельно сохранению даёт `409 composition_changed`. `publish` прототипа дополнительно требует, чтобы каждая упомянутая композиция была запинована (`422 validation_failed`, «Unpinned composition»).

**Чтение прототипа.** `GET /prototypes/:id/draft`, `…/revisions/:rev` и `…/versions/:v` additively отдают `compositions: CompositionPin[]` — `{id,name,version,sourceHash,doc}` по пинам ревизии. Клиент раскрывает авторский документ этими документами перед построением runtime-спека, поэтому плеер и capture видят ровно ту версию композиции, что была закреплена.

### Композиции версии 2 (вложенность)

`POST`/`PUT` принимают документ версии **1** или **2** (`compositionDocSchema` — discriminated union по `version`; грамматика — в [формате прототипа](prototype-format.md#composition-document-v2)). Поведение v1 заморожено: её документ, `sourceHash` и раскрытие не изменились ни на байт, а `@eui/Composition` внутри v1-документа по-прежнему `422`.

Миграция **v21** добавила публикации композиций два столбца (`ALTER TABLE ... ADD COLUMN` с дефолтами, перестройки нет):

- `composition_publishes.dependency_manifest_json` — манифест замыкания `{version:1, root:{id,version}, compositions:CompositionDependencyPin[], components:ComponentDependencyPin[], hash}`; у исторических публикаций остаётся `'[]'`;
- `composition_publishes.dependency_manifest_hash` — sha256 канонического манифеста (списки отсортированы по `id`,`version`), продублированный столбцом ради дешёвой сверки; расхождение столбца и payload при чтении → `422 invalid_stored_revision`.

Также v21 навесила на `compositions`/`composition_revisions` те же триггеры запрета retired-дизайн-системы, что уже стояли на компонентах и прототипах, и `assertRegistryIntegrity` теперь проверяет композиции наравне с компонентами (висячая система, расхождение системы головы и ревизии).

**Публикация v2** резолвит каждую вложенную ссылку в последнюю `active`-публикацию композиции **той же** дизайн-системы, фиксирует прямые и транзитивные пины, проверяет ацикличность и глубину, раскрывает параметры и слоты и валидирует полностью раскрытое дерево — всё это **до** записи публикации, поэтому неудачный publish не оставляет ни строки в `composition_publishes`. Ошибки — `422 validation_failed` с говорящим `issues[].message`: `different design system`, полный путь цикла (`a@1 → b@1 → a@1`), `composition nesting exceeds 5`, а также обычные ошибки параметров/слотов, вычисленные на раскрытой публикации (например, недостающий `required`-параметр вложенной композиции).

**Пины прототипа** при v2 — это всё замыкание, а не только верхнеуровневые хосты: `prototype_revision_compositions` получает транзитивный набор, а компонентные пины берутся из манифеста каждой запинованной публикации, поэтому более поздняя публикация вложенной композиции не меняет уже сохранённую ревизию прототипа. `classifyRevision` проверяет статус **каждого** пина замыкания, а не только композиций, встреченных в авторском документе.

**Мягкое удаление.** `DELETE` только помечает `deleted_at`/`delete_reason`: композиция исчезает из списка и не доступна новым сохранениям, но уже закреплённые публикации продолжают читаться по версии (их защищает FK RESTRICT), а `usages` остаётся читаемым и для надгробия. Повреждённая строка ревизии при чтении даёт `422 invalid_stored_revision`.

### Анализ кандидата и preview-дерево (волна W8g, план 2026-08-03)

Две **read-only** ручки: они ничего не пишут и потому **не зависят от kill-switch'а `EASYUI_COMPOSITION_V3`** — выбор «композиция или TSX» агент обязан уметь сделать до того, как на сервере разрешат запись v3. Discovery — `capabilities.features.compositionAnalyze`. Авторизация — как у остального API: любой аутентифицированный пользователь; share/capture-scope → `403 forbidden`.

| Endpoint | Смысл |
|---|---|
| `POST /compositions/analyze` | `{doc, designSystem?}` → вердикт по кандидату/черновику |
| `POST /compositions/:id/preview-tree` | `{params?, variant?, rev?}` → как ревизия композиции раскроется на этих значениях |

**`analyze`.** Ответ: `{verdict, reasons[], unsupported[], schemaValid, stats, dependencyImpact}`.

- `verdict` — один из трёх (те же исходы печатает workbench):
  - `composition` — конструкция выразима средствами v3;
  - `extend-component` — тело сводится к **одному** компоненту с вариациями props (единственный не-слотовый элемент без объявленных слотов либо набор взаимоисключающих по `when` элементов одного типа): композиция здесь — лишний уровень косвенности;
  - `needs-ownership-component` — в теле есть то, чего в v3 нет по построению.
- `unsupported[]` — `{feature, elementKey, hint}`. Классы: `timer`, `async-data`, `scroll`, `dom-measurement` (эвристика по именам событий, действий и — **только у host-примитивов** — props: props кастомного компонента принадлежат его собственному контракту и невыразимости не означают), `custom-action` (действие вне закрытого набора рантайма), `business-state` (обработчик, переписывающий больше двух путей стейта разом), `dynamic-directive` (`$`-директива вне формата), `limit/elements|params|slots|expanded-elements|tree-depth|nesting-depth|repeat-items` (лимиты формата и бюджеты раскрытия).
- `reasons[]` — `{code, message, elementKey?}`: `analyze/expressible`, `analyze/single-element-body`, `analyze/component-variations`, `analyze/host-primitive-body`, `analyze/needs-ownership`, `unsupported/<feature>`, `expansion/<code>` (диагностика probe-раскрытия) и `analyze/schema-invalid` (черновик, не прошедший строгую схему, — он всё равно анализируется, а `schemaValid: false` это фиксирует).
- `stats` — `{elements, params, slots, componentTypes[], branches, switches, repeats, actionParams, nestedCompositions}`.
- `dependencyImpact` (только с `designSystem`) — **существующий** usages-механизм: `components[]` (`componentUsages`: `headUsageCount`/`immutableUsageCount`/`safeToRemove`), `compositions[]` (usages вложенных ссылок) и `unknownTypes[]` — типы тела, не опубликованные в этой ДС.
- `analyze` — **зарезервированный сегмент пути**: `POST /compositions/analyze` никогда не адресует композицию с id `analyze` (её остальные методы и ручки работают как обычно).
- Ошибки: `400 invalid_request` (нет `doc`, лишнее поле), `422 validation_failed` (неизвестная/архивная `designSystem`), `403 forbidden`.

**`preview-tree`.** Это **инструментированный прогон того же раскрытия** (`expandCompositions` + опциональный trace-коллектор), что и в save-пути прототипа, — показанные решения фактические, а не пересчитанные копией логики. Ответ: `{compositionId, rev, designSystem, resolvedParams, chosenBranches[], switches[], repeatExpansions[], slotBindings[], layoutOwners[], expandedTree, issues[]}`:

- `resolvedParams` — значения после варианта, явного `params` и дефолтов объявления;
- `chosenBranches[]` — `{elementKey, compositionId, when, taken}` (`when` — **объявленное** условие, `taken` — его значение на этих параметрах);
- `switches[]` — `{elementKey, prop, param, case}`, где `case` — выбранный ключ или `"default"`;
- `repeatExpansions[]` — `{elementKey, param, count}`: сколько клонов реально построено (после `maxItems`, бюджета и коллизий ключей);
- `slotBindings[]` — `{slot, compositionId, required, filled, fallbackUsed}`; точки ссылки у превью нет, поэтому слоты **декларативны**: `filled` всегда `false`, контракт слота не проверяется (`validateSlotContract: false`), а fallback раскрывается;
- `layoutOwners[]` — `{elementKey, type, props}`: во что скомпилировался token `layout`;
- `expandedTree` — `{root, elements}` раскрытого фрагмента (без capture и без рендера: UI-превью в объём волны не входит);
- `issues[]` — обычные issue раскрытия (`{path[], message, code?}`), включая `composition/layout-unsupported` и нерезолвящиеся вложенные ссылки.
- `rev` по умолчанию — головная ревизия; неизвестная композиция → `404 not_found`, неизвестная ревизия → `404 revision_not_found`; не-объект `params`, не-строковое значение оси `variant` или лишнее поле → `400 invalid_request`; метод кроме POST → `405`.

## Атомарная политика и миграция каталога

Спека — `docs/superpowers/specs/2026-07-30-composition-v2-dedup-migration-design.md`. Возможности объявлены в `/api/capabilities` как `features.compositionV2` и `features.catalogMigration`.

### Атомарная политика

Представление артефакта выбирается по ответственности: атом — TSX, молекула/организм/шаблон/страница — композиция. TSX-молекула или TSX-организм допустимы, только если поведение нельзя выразить событиями, state-директивами, параметрами и слотами, и тогда `definition.ownership.reason` обязан это объяснять.

Правило применяется **к новым артефактам**: миграция v21 создала однострочную таблицу `atomic_policy(id=1, activated_at, policy_version, activated_by)`, и граница берётся из БД, а не из окружения, — рестарт или восстановление образа не могут выбрать другой рубеж. Компонент с `components.created_at >= atomic_policy.activated_at`, у которого `atomicLevel` ∈ `molecule|organism` и нет непустого `ownership.reason`, получает на `POST /components/:id/publish` ошибку **`422 atomic_policy_violation`** с `issues[].path = ["ownership","reason"]`. Более старые id остаются публикуемыми на время аудируемой миграции, но попадают в отчёт аудита.

### Maintenance-lock

Защищённый cutover берёт эксклюзивный однострочный лок `maintenance_locks`. Пока он держится, **чтение и воспроизведение работают**, а любой небезопасный метод (всё, кроме `GET`/`HEAD`/`OPTIONS`) отвечает **`503 maintenance_in_progress`** с `details.runId` и `details.retryAfterSeconds`. Исключений два: сам префикс `/api/catalog/migrations` (иначе нельзя было бы завершить или откатить активный прогон) и `/api/auth/*` — проверка выполняется после роутера аутентификации, поэтому логин под локом не ломается. Попытка взять уже занятый лок — тоже `503`; потеря лока во время защищённой операции — `409 maintenance_lock_lost`.

### Endpoints миграции каталога

Все — **только админ** (`401 unauthorized` анонимному, `403 admin_required` не-админу).

| Метод и путь | Тело / ответ |
|---|---|
| `GET /catalog/migrations/audit` | Read-only аудит согласованного снапшота: `{generatedAt,catalogRevision,dataFingerprint,artifacts[],duplicateGroups[],plan}`. Каждый артефакт классифицируется как `irreducible-code | composition-candidate | semantic-duplicate | metadata-only-fix | deprecated-unused | documented-exception` и несёт граф зависимостей, счётчики использования и метаданные. `plan` — готовый `CatalogMigrationPlan` версии 1 |
| `GET /catalog/migrations` | `{runs:[{id,planHash,catalogRevision,dataFingerprint,status,generatedAt,startedAt,completedAt,backupId,reason}]}`, `status` ∈ `prepared | applying | applied | aborted | rolled_back` |
| `POST /catalog/migrations/prepare` | Тело — план; → 201 `{runId,planHash,status}`. Идемпотентен по `planHash`: повторный prepare того же плана возвращает существующий прогон. Устаревшие `catalogRevision`/`dataFingerprint` → `409 migration_plan_stale` **до** любых записей |
| `POST /catalog/migrations/:runId/apply` | Тело — тот же план; → `{runId,status:"applied",backupId}`. Берёт maintenance-lock, снимает полный образ SQLite, повторно сверяет отпечатки и выполняет весь cutover **одной транзакцией**; повтор для уже применённого прогона идемпотентен. Чужой план → `409 migration_plan_mismatch`, неподготовленный прогон → `409 migration_run_not_prepared` |
| `POST /catalog/migrations/:runId/rollback` | `{backupId?,reason?}` → `{runId,backupId,backupSha256,bytes,status:"rolled_back"}`. Восстанавливает образ cutover и переводит прогон в `rolled_back`. `404 migration_backup_not_found`, `409 migration_backup_mismatch|migration_backup_corrupt|migration_run_not_rollbackable` |

**План** (`CatalogMigrationPlan`) содержит `groups[]` (канон, отставляемые, confidence, причины, адаптер, затронутые головы, неизменяемые использования), `compositionConversions[]`, `metadataRevisions[]`, `documentedExceptions[]`. Канонический сериализованный план хешируется, и `apply` требует ровно тот план, которым владеет прогон. Выбор канона детерминирован: активный раньше deprecated → валидная каноническая роль → больше использований в головах → пройденный визуальный эталон → полные архитектурные метаданные → более старая стабильная публикация как последний тайбрейк.

**Адаптеры** декларативны (`typeMap`, `props.rename|defaults|enumMap|drop`, `events.rename|payloadMap`, `slots.rename|defaultTarget`), чисты и идемпотентны. Отбрасывание заполненного пропса, обработчика или слота запрещено и даёт отказ адаптера, если в плане нет артефакт-специфичного `documentedException`; преобразованный документ проходит обычную серверную валидацию — миграция не обходит схемы и линты.

**Таблицы** (миграция v21): `catalog_replacements(from_kind,from_id,from_design_system PK, to_*, migration_run_id, reason, created_at)` — межартефактный реестр замен, переживающий мягкое удаление источника (FK на источник намеренно нет; поддерживает component→component, component→composition, composition→composition); `catalog_migration_runs`; `catalog_migration_staging(run_id,kind,artifact_id,design_system,payload_json,status)` — план-owned staging стадии A, недоступный обычному авторингу.

**Бэкапы cutover** удерживаются и в процессе, и на диске: `apply` пишет образ в `DATA_DIR/catalog-migrations/<backupId>.sqlite` плюс sidecar `<...>.sqlite.json` с `sha256`/`bytes`/`createdAt`. Поэтому откат остаётся возможен после рестарта или редеплоя; при восстановлении сверяются контрольная сумма и совпадение схемы (`409 migration_backup_incompatible`), а `audit_events` и `catalog_reuse_decisions` намеренно **не** откатываются — это append-only свидетельства, включая запись о самом откате (`catalog.migration.rolled_back`).

## Bundles (экспорт/импорт ZIP)

Перенос прототипов и custom-компонентов наружу (между серверами/аккаунтами, локальный архив, обмен) — через ZIP-бандлы. Три вида экспорта (прототип, компонент, всё owned) описываются **одним манифестом** и импортируются **единым** endpoint'ом. Схемы (`bundleManifestSchema`, `importReportSchema`) живут в `src/bundle/schema.ts` и общие для сервера и клиента; ZIP-кодек (`fflate`) — только на сервере и в клиентских download-хелперах, никогда в shared-схеме или SPA-рендере.

### Endpoints

| Метод и путь | Authz | Семантика |
|---|---|---|
| `GET /prototypes/:id/export?version=N` | `requirePrototypeRead`; draft (без `?version`) — только owner; не-owner по умолчанию — последняя published-версия (иначе `404 version_not_found`) | Прототип выбранной ревизии + полное замыкание зависимостей. Файл `easy-ui-prototype-<id>-{draft-r<rev>\|v<N>}.zip` |
| `GET /components/:id/export?version=N` | `requireUser` (как `/source`) | По умолчанию последняя active-версия; без публикаций — head draft (`version: null` в манифесте). Файл `easy-ui-component-<id>-{v<N>\|draft-r<rev>}.zip` |
| `GET /bundles/export` | `requireUser` | Всё owned вызывающим. Для каждого прототипа — последняя published-версия, head draft **только если публикаций нет**; компоненты — последняя active, иначе head draft. Файл `easy-ui-export-<yyyymmdd>.zip` |
| `POST /bundles/import?mode=dry-run\|apply` | `requireUser` | Импорт бандла. `mode` по умолчанию `apply`. Тело — multipart (`file`, опционально `reuseOverride` — только админ) **или** raw `application/zip`. Ответ — отчёт `importReportSchema` (см. ниже) |

Ответ на все три export'а — бинарный `application/zip` с `content-disposition: attachment; filename="…"` и `no-store` (свежая материализация замыкания, кэшировать нельзя). Per-resource `export`-хвосты живут в `routes/prototypes.ts`/`routes/components.ts` (authz на месте); `/bundles/*` — в `routes/bundles.ts`.

Коды ошибок export: `401 unauthorized`, `403 forbidden`, `404 prototype_not_found`/`404 not_found`/`404 version_not_found`, `413 export_too_large`. Коды ошибок import (HTTP-уровень): `400 invalid_bundle` (не-zip, traversal-путь, битый/лживый central directory, sha-mismatch байтов, невалидный манифест), `413 payload_too_large` (аплоад/бюджет распаковки/лимит entries), `415 unsupported_media_type` (не multipart и не `application/zip`), `422 validation_failed`. Конфликты отдельных элементов **не** роняют запрос — они попадают в отчёт как item-error (см. [Конфликт-политика](#конфликт-политика-импорта)).

### Формат бандла

`formatVersion: 1 | 2`, zod-валидируемый `manifest.json`. Layout архива:

```
manifest.json
prototypes/<prototypeId>.json          # точный doc экспортируемой ревизии
compositions/<compositionId>.json      # замороженный doc закреплённой версии композиции (format 2)
components/<componentId>/source.tsx    # TSX-исходник
assets/<sha256>                        # сырые байты, имя = sha256 (store); JSON/TSX — deflate
```

**Версии формата.** `1` — исходный набор секций; `2` — добавляет `compositions[]` и `prototypes[].compositionPins`. Экспорт выставляет `2` **только** если бандл реально несёт композиции, поэтому бандлы без композиций остаются форматом `1` и читаются сервером, который о композициях не знает. Обратная совместимость чтения — в обе стороны: старый бандл без `compositions`/`compositionPins` импортируется как раньше (поля опциональны с `default []`), а бандл формата `2` на старом сервере отвергается целиком (`z.literal(1)` → `400 invalid_bundle` с `issues[].path = ["formatVersion"]`) **до единой записи в БД** — частичного импорта без композиций не бывает. Неизвестная будущая версия (`3+`) отвергается так же.

`manifest.json`:

- `kind` (`prototype|component|bulk`, информационно — импортёр един), `exportedAt` (ISO).
- `source { origin, apiVersion, renderContractVersion, builtinCatalogHash }` — compat-сигнал источника для диагностики межверсионного импорта.
- `prototypes[]`: `{ id, name, designSystem, exported {selector: "draft"|"version", rev, version|null}, docPath, componentPins [{id, version}], compositionPins [{id, version}] (format 2), assetIds[], designSystemMetaVersion|null }`.
- `components[]`: `{ id, name, designSystem, sourcePath, sourceHash (sha256 источника), exported {rev, version|null}, assetIds[] }`.
- `compositions[]` (format 2): `{ id, name, designSystem, docPath, sourceHash (sha256 канонического JSON документа), exported {rev, version|null} }`.
- `designSystems[]`: `{ id, name, description?, builtin, theme {metaVersion, tokens, fonts, icons} | null }`.
- `assets[]`: `{ id (asset_<64hex>), sha256, mime, size, originalName|null }` — каждый ассет в архиве один раз по sha.

**Пины компонентов и DS meta-version в манифесте информационные.** На импорте они не восстанавливаются буквально: пины пересчитываются резолвом по `name+designSystem` к последней active-версии на цели, тема перепиновывается. Точная **version-fidelity не гарантируется** — импорт эквивалентен свежему POST (см. [Конфликт-политика](#конфликт-политика-импорта)). Пины ассетов ревизии — единственный источник asset-замыкания (walk по `props`); `$asset` в `state`/`stateOverrides`/`flows` рантаймом не резолвится и не пинуется — это осознанно **не** пробел.

**Композиции входят в замыкание** (format 2). Для каждого прототипа экспортируются **закреплённые** версии композиций (`prototype_revision_compositions`) вместе с их замороженными документами; bulk-экспорт дополнительно берёт все owned-композиции (последняя active-версия, иначе head draft — как у компонентов). Компоненты и ассеты, используемые **только внутри** композиции, отдельного обхода не требуют: пины ревизии считаются по **раскрытому** документу, поэтому уже покрывают их (тот же инвариант B3, что и на save). На импорте композиция создаётся/переиспользуется по компонентной конфликт-политике и публикуется, после чего save-путь прототипа резолвит её по id к последней active-версии.

**Что НЕ экспортируется** (осознанно): `compiled_js`/`bundle_hash`/host-ABI (цель перекомпилирует через publish-пайплайн), история ревизий, скриншоты и visual-бейзлайны, share-гранты, `figma_json`, owner/audit-данные, статус прототипа (импорт всегда приватный). Прототипный и bulk-бандл **включает TSX всех запинованных компонентов независимо от их владельца** — это консистентно с текущим `GET /components/:id/source` (читается любым аутентифицированным пользователем) и зафиксировано как продуктовое решение.

### Конфликт-политика импорта

Импорт **не атомарен** (компиляция компонентов идёт в сабпроцессах, глобального rollback нет). Поэтому отчёт — по-элементный: `{ mode, ok, items: [{type: "asset"|"designSystem"|"component"|"composition"|"prototype", id, name?, action: "created"|"reused"|"skipped"|"error", detail?, remappedTo?, version?}], summary {created, reused, skipped, errors} }`. Порядок обработки: ассеты → дизайн-системы → компоненты → **композиции** → прототипы (зависимость сверху вниз). Элемент-ошибка выставляет `ok: false`, но остальные элементы обрабатываются.

| Фаза | created | reused | skipped | error (typed `detail`) |
|---|---|---|---|---|
| **Ассеты** | новый sha ingest'ится | sha уже есть (`ingest` идемпотентен) | — | байты не сходятся с заявленным sha256, либо `id ≠ asset_<sha>` |
| **Дизайн-системы** | custom id свободен → создаётся (owner = импортёр); своя тема пишется как version 1 после `validateThemeAssets` | id существует → **reuse by reference** (реестр глобальный); своя (owner=импортёр) отличающаяся тема → новая версия `latest+1`; чужая отличающаяся тема → reuse + `detail` «theme drift: not owner…» | — | builtin отсутствует на цели → `design_system_missing` |
| **Компоненты** | оба свободны → `create`+publish; свой id/name с отличающимся source → новая версия; `compiled_js` бандла **не** используется — только `publishComponent` | свой id/name, head sourceHash совпадает и есть active publish | — | чужой занятый name → `name_conflict`; soft-deleted строка по id/name → `deleted_conflict` (v1 без revive); имя = builtin-каталог → `builtin_name_reserved`; провал publish-пайплайна → его сообщение; создание нового компонента, дублирующего каталог цели, в фазе `enforce` → `reuse_blocked` |
| **Композиции** | оба свободны → `create`+`publish`; свой id с отличающимся документом → новая ревизия + новая версия | свой id, `sourceHash` головы совпадает и есть active-публикация | — | чужой занятый id/name либо совпадение по имени под **другим** id → `name_conflict` (remap невозможен: прототип адресует композицию по id); soft-deleted строка → `deleted_conflict`; недоступная система или неопубликованный внутренний тип → `dependency_failed: …`; невалидный документ → `invalid_document: …` |
| **Прототипы** | id свободен → created; чужой/tombstone id → remap `<id>-imported-<n>` (`remappedTo` в отчёте) | — | свой id, doc идентичен head | зависимость (DS/компонент/композиция) не разрешима → `dependency_failed: …` / `dependency_failed: composition …`; невалидный doc при `renderContractVersion`/`builtinCatalogHash` новее целевых → `format_too_new: …` |

**Reuse gate на импорте.** Создание нового компонента бандлом проходит тот же гейт, что и `POST /components`: иначе импорт был бы обходным путём вокруг него. Ветка «существующий свой id → новая версия» гейт не проходит (это update). Заблокированный элемент отчёта несёт `{action:"error", detail:"reuse_blocked", reuseCode, catalogRevision, candidateKeys[], decisionId}` и не роняет весь запрос — остальные элементы обрабатываются. В фазе `shadow` `reuse_blocked` не выставляется вовсе.

Обход — двухфазный и только для администратора; бланкетного флага «пропусти гейт» нет. Фаза 1 — `mode=dry-run`: отчёт называет заблокированные компоненты, их `candidateKeys` и текущий `catalogRevision` (аудит в dry-run **не пишется**). Фаза 2 — `mode=apply` с multipart-полем `reuseOverride` = `{catalogRevision, reason, components:[{id, candidateKeys[]}]}` (у raw `application/zip` места для него нет by design): `reason` — 20..500 символов после trim, id должны присутствовать в бандле (иначе `422 validation_failed`), не-администратор — `403 admin_required`. Каталог, сдвинувшийся между фазами, не применяется молча: элемент остаётся `reuse_blocked`, но уже с `reuseCode:"catalog_changed"` и свежими `catalogRevision`/`candidateKeys` для следующей попытки.

**`mode=dry-run`** ничего не пишет и не компилирует: действия предсказываются по хешам/именам/id. Строки dry-run-отчёта **предварительные** — компиляция компонентов оценивается только на `apply`, поэтому провал пайплайна в предпросмотре не виден. UI помечает предпросмотр явно.

### Лимиты

- **Экспорт**: раскрытый (uncompressed) объём ≤ **512 MiB**. Кап проверяется **до материализации** архива — сумма размеров ассетов (из БД) + длины doc/source; превышение → `413 export_too_large`. ZIP собирается целиком в памяти (streaming — совместимый follow-up).
- **Импорт**: аплоад ≤ **256 MiB**; бюджет распаковки читается из central directory (заявленные uncompressed-размеры) — суммарно ≤ **512 MiB**, entries ≤ **4096** — и отклоняется **до инфляции** (защита от zip-бомбы); после инфляции фактические длины сверяются с заявленными (расхождение → `400 invalid_bundle`). Пути — по allowlist-regexp (`manifest.json | prototypes/<slug>.json | compositions/<slug>.json | components/<slug>/source.tsx | assets/<64hex>`), перекрёстно сверяются манифест↔архив, байты ассетов перехешируются.

## Figma provenance

Ссылка на исходный Figma-файл принимается опционально рядом с `doc`/`source`. У **прототипов** она остаётся immutable-свойством ревизии (колонка `figma_json TEXT NULL` в `prototype_revisions`, миграция v9). У **компонентов** с миграции v27 provenance отвязана от ревизий и версий — см. [Provenance компонентов](#provenance-компонентов-без-новых-версий) ниже; колонка `component_revisions.figma_json` продолжает заполняться write-путями и служит фолбэком резолва для исторических ревизий.

- Прототипы: `POST /prototypes` и `PUT /prototypes/:id` — `{doc, message?, figma?}`.
- Компоненты: `POST /components` (`{id,name,source,…,figma?}`) и `PUT /components/:id` (`{source?,designSystem?,figma?,baseRev}`; допускается изменение **только** `figma` — создаётся новая ревизия с прежним source).

**No-op figma-only PUT.** Повторная публикация неизменённого head невозможна и так (`409 already_published`), а сохранение байт-идентичного source — `400`. Оставалась одна дыра: PUT с `figma` создавал ревизию, даже когда и source, и `figma` совпадали с head. Теперь такой запрос ревизию не создаёт и отвечает `200 {unchanged:true, rev:<headRev>}` — `rev` присутствует всегда, поэтому старые клиенты, читающие только его, продолжают работать. Предмет сравнения у компонентов — **резолвнутая** provenance головы (не сырая колонка ревизии), у прототипов — по-прежнему колонка.

**Строгая схема** (`z.strictObject`, лишние ключи → `422 validation_failed`):

| Поле | Правило |
|---|---|
| `fileKey` | строка 1..128, `^[A-Za-z0-9_-]+$` |
| `nodeIds` | 1..50 строк, каждая 1..64, `^[A-Za-z0-9:._-]+$` |
| `referenceScreenshots?` | ≤50 asset-id (`asset_<64hex>`); каждый обязан существовать в реестре assets, иначе `422 asset_not_found` |
| `lastSyncedAt?` | ISO-дата (`Date.parse`-валидная), ≤40 символов |

### Provenance компонентов без новых версий

Правка ссылки на Figma раньше требовала новой ревизии, а у опубликованного компонента — metadata-only версии (одинаковый bundle hash, версия ради метаданных). С миграции **v27** provenance компонентов живёт в append-only таблице `component_provenance(component_id, rev, seq, figma_json, author, created_at)` и **резолвится при чтении**.

| Аспект | Правило |
|---|---|
| Резолв | последняя запись по `(rev, seq)` среди ревизий `rev' ≤ rev` того же компонента; записей нет → `component_revisions.figma_json` самой ревизии |
| Наследование | source-PUT **без** `figma` больше не обнуляет provenance: новая ревизия резолвится в запись предыдущей |
| Очистка | `figma: null` пишет **tombstone**-строку (`figma_json IS NULL`); резолв возвращает `null` и не проваливается на колонку |
| Запись | seq-строку пишет любой write-путь с переданным `figma` — `POST /components`, `PUT /components/:id`, `restore`, `PUT /components/:id/provenance` — тем же внутренним хелпером и в **той же транзакции**, что запись ревизии |
| Дедуп | значение, равное резолвнутому, новой строки не создаёт (история не растёт от повторов драйвера) |
| Идентичность | seq-запись **не** инвалидирует `sourceHash`, `build_fingerprint`, validate-receipt, `catalogRevision` и результаты приёмки: provenance — метаданные происхождения, не вход сборки |

`PUT /api/components/:id/provenance` `{rev?, figma}` → `200 {rev, seq, unchanged, figma}` — правка **без** новой ревизии и без новой версии. `rev` по умолчанию головной; несуществующая ревизия → `404`. Доступ — владелец компонента или админ (`share`/`capture` — `403` всегда), аудит-событие `component.provenance.updated {rev, seq}`. Discovery — `capabilities.features.acceptanceProvenance` (kill-switch'а нет). CLI: `driver.mjs provenance <componentId> <figma.json|null> [--rev N]`.

**Provenance опубликованной версии сознательно мутабельна**: `PUT …/provenance` с `rev` опубликованной версии меняет то, что отдаёт `GET /components/:id/versions/:v`. Иммутабельна только байтовая часть версии — `compiled_js`, `bundle_hash`, `definition_meta`. Ровно ради этого слой и вводился.

Миграция v27 аддитивна (`CREATE TABLE` + индексы, без перестроек) и включает **backfill**: каждой head-ревизии с непустым `figma_json` пишется `seq = 1`-запись (автор `migration:component_provenance`). Без него первый же source-PUT без `figma` обнулил бы provenance у компонентов без seq-истории. Той же миграцией создаётся `candidate_decisions` (надгробия отклонений кандидатов, FK `ON DELETE CASCADE` + partial unique index); ручка `POST /component-candidates/:candidateId/reject` и promote-предикат приехали волной R3b — см. [acceptance](#acceptance-кандидаты-и-матричные-раны).

Регресс-гард: `npm run verify:provenance` (`scripts/check-provenance-resolver.ts`) держит закрытый allowlist читателей/писателей `figma_json` — новый путь обязан ходить через резолвер `server/figma.ts` либо попасть в allowlist осознанной правкой.

**Семантика (прототипы).** Значение сохраняется на **создаваемой** ревизии; `restore` копирует `figma_json` исходной ревизии вместе с документом. `publish` прототипа переиспользует head-ревизию. Для owner read-back additively отдаёт `figma` (объект или `null`). Для любого не-owner принципала, включая Share/Capture, ключ `figma` в meta/draft/version **полностью отсутствует**, а история ревизий закрыта. Легаси-ревизии без ссылки читаются owner-у как `figma: null`.

## Служебные endpoints

### Реестр дизайн-систем

Единственный источник существования и metadata системы — таблица SQLite `design_systems` (`id`, `name`, `description`, внутренний immutable `builtin_provider`, timestamps). `shadcn`, `wireframe` и `yandex-pay` создаются миграцией как обычные registry-записи; API-системы переживают рестарт. Provider связывает запись с кодовым builtin-каталогом, но не является вторым реестром. У системы без provider `components: []`; её доступный каталог формируют опубликованные custom-компоненты.

| Метод и путь | Тело / ответ |
|---|---|
| `GET /design-systems` | `{designSystems: DesignSystemSummary[]}` |
| `GET /design-systems/:id` | `DesignSystemSummary`; неизвестный ID → `404 not_found` |
| `POST /design-systems` | `{id,name,description}` → 201 `DesignSystemSummary` и `Location`; повтор ID → `409 already_exists` |
| `PATCH /design-systems/:id` | Тема (см. §Тема) `{tokens?,fonts?,icons?,addTokens?,addFonts?,addIcons?,dryRun?,baseVersion}` → 200 `DesignSystemSummary` + `{dryRun,noop,nextVersion,spacingResolver,diff,inheritedSpaceTokens,stalePins}`; builtin → `405`; CAS-конфликт → `409 version_conflict`; append-конфликт → `409 theme_append_conflict` |
| `DELETE /design-systems/:id` | Без тела → `204`: мягкий ретайр (`retired=1`). Владелец или админ; builtin → `405`; непустая система → `409 design_system_in_use`; уже ретайрнутая → `409 design_system_retired` |
| `GET /design-systems/:id/versions/:v` | Immutable `{systemId,version,tokens,fonts,icons,createdAt,spacingResolver,resolvedSpaceScale}`; отсутствует → `404 not_found` |

`DesignSystemSummary` имеет `{id,name,description,builtinCatalogHash,resolvedSpaceScale,components,hostPrimitives}` плюс additively `latestMetaVersion` и содержимое последней версии темы `{tokens,fonts,icons}`; provider не раскрывается. `components[]` сериализует `propsJsonSchema` (input), `layout?` и явный `layoutNeutral`; `hostPrimitives[]` использует ту же generic-схему дескриптора и содержит host-owned `Image`, `Hotspot`, `Overlay`, `@eui/FlowRoot`, а также `@eui/Composition` и `@eui/Slot` (волна 5) для каждой системы. Они доступны runtime независимо от custom bundle и намеренно не входят в `/catalog/manifest`. `resolvedSpaceScale` — итоговые девять `none..4xl` для последней merged-темы системы. Malformed JSON/body не-object даёт `400 invalid_request`; неизвестные поля, неверные типы, невалидный slug, пустые или слишком длинные значения — `422 validation_failed` с `issues[].path`. `PUT` на collection или `:id`, `DELETE` на collection, а также `PATCH` на collection дают `405 method_not_allowed`: registry metadata в этом API неизменяемы. Повтор идентичного POST не идемпотентен и также даёт 409.

#### Ретайр системы (`DELETE /design-systems/:id`)

Ретайр — **мягкая архивация, а не удаление**: строка `design_systems` остаётся, выставляются `retired=1` и `updated_at`, пишется audit-событие `design_system.retired`. Никаких миграций и физического удаления; ранее ретайр делался только миграциями (v14/v15).

- **Право:** владелец системы (`design_systems.owner_id`) либо админ — та же модель, что у `PATCH` (`requireResourceOwner`). Аноним → `401`, чужой не-админ → `403 forbidden`.
- **Builtin:** система с `builtin_provider` → `405 method_not_allowed`, как и `PATCH` её темы.
- **Только пустая система.** Считаются живые артефакты, привязанные к системе: `components` без надгробия (`deleted_at IS NULL`), `prototypes` (удаляются физически, поэтому считаются все) и `compositions` без надгробия. Любой ненулевой счётчик → `409 design_system_in_use` с `error.blockers = {components, prototypes, compositions, total}`. Порядок действий: удалить/перенести артефакты, затем ретайрить.
- **Повтор не идемпотентен:** уже ретайрнутая система → `409 design_system_retired`. `204` означал бы, что ретайр только что произошёл, а `404` соврал бы про существование — ретайрнутая система остаётся читаемой по прямому `GET /design-systems/:id` (с `retired:true`). Тот же код и та же причина, что у `PATCH` темы ретайрнутой системы.
- **Последствия.** Система исчезает из `GET /design-systems` (список отдаёт только активные) и из выбора при записи: `requireActiveDesignSystem` даёт `422 validation_failed` на создание компонента/композиции/прототипа в ней, а нижним рубежом стоят триггеры миграции v15 (`... retired design system reference`), отвергающие такие вставки на уровне БД. Прошлые ревизии и публикации остаются нетронутыми и читаемыми.

CLI: `node driver.mjs delete design-system <id>` (единственное и множественное число коллекции равнозначны; тело `baseRev` для систем не отправляется).

#### Тема дизайн-системы (tokens/fonts/icons) и версии

Тема кастомной системы — три строго-валидируемых коллекции, хранимые как **immutable-версии** в `design_system_versions(system_id, version, tokens_json, fonts_json, icons_json, created_at, spacing_resolver)`. `PATCH /design-systems/:id` доступен **только для кастомных систем** (builtin-provider → `405`) и создаёт версию `baseVersion+1` с CAS по последней версии: `baseVersion≠latest` → `409 version_conflict` с `currentVersion`. Первая тема создаётся при `baseVersion:0`. PATCH-семантика: переданная коллекция заменяет предыдущую, опущенная — наследуется. Версии неизменяемы и читаются через `GET …/versions/:v`.

**Sparse-операции (append-only).** Вместо полной коллекции можно прислать `addTokens` / `addFonts` / `addIcons`: правка из двух токенов передаёт два объекта, а не весь словарь. Каждая пара «полная ↔ sparse» взаимоисключающая (`tokens` и `addTokens` вместе → `422 validation_failed`). Мердж резолвится строго против `baseVersion` — того же снимка, что прошёл CAS, — по политике `appendOnly`:

- ключа/шрифта/иконки нет → добавляется;
- есть с идентичным значением → ничего не меняется;
- есть с другим значением → `409 theme_append_conflict` с `currentVersion` и `issues[]` вида `{path:["addTokens","<key>"],existing,incoming,message}`; тихой перезаписи не бывает;
- **удаления под sparse нет** by construction — для него остаётся полный PATCH.

Идентичность шрифта — тройка `family|weight|style`, иконки — `name`. Полнота и монотонность шкалы `space.*` для sparse-режима проверяется на смердженном наборе (тело append-операции частично по определению), поэтому нарушение приходит как `422 validation_failed` с `issues[].path = ["tokens", …]` и пометкой «checked on the merged base N + addTokens result».

**`dryRun` и no-op.** `dryRun: true` выполняет всю валидацию, отдаёт `diff` и итоговую `resolvedSpaceScale`, но версию не пишет. Независимо от `dryRun` контент, семантически равный `baseVersion`, версию **не создаёт**: ответ несёт `noop: true` и `nextVersion: null` (токены сравниваются как множество пар — порядок ключей незначим; шрифты и иконки — по порядку, он влияет на каскад `@font-face` и выбор иконки). Поля ответа PATCH поверх обычного `DesignSystemSummary`:

- `dryRun`, `noop`, `nextVersion` (номер созданной версии либо `null`);
- `diff` — `{tokens:{added,changed,removed},fonts:{added,removed},icons:{added,removed},changed}` относительно `baseVersion`;
- `spacingResolver` — резолвер, с которым версия записана (или который остаётся у `baseVersion` при no-op);
- `inheritedSpaceTokens` — ключи `space.*`, унаследованные от базовой версии (см. ниже);
- `stalePins` — `{total,limit,prototypes:[{id,name,pinnedVersion}]}`: головные ревизии прототипов этой системы, пинующие более старую (или отсутствующую) версию темы; список усечён до 50, полный размер — в `total`.

**Версионирование резолвера spacing-шкалы.** Миграция **v23** добавила `design_system_versions.spacing_resolver INTEGER NOT NULL DEFAULT 1` (плоский `ADD COLUMN`, backfill `1`, без `CHECK` — точка контроля контрактная):

- `1` — историческое поведение, сохранённое для всех существующих версий байт-в-байт: частичные `space.*`-оверрайды кладутся на **каноническую** шкалу, а не на базовую шкалу дизайн-системы, и любой невалидный/немонотонный набор откатывается на каноническую;
- `2` — фикшеный мердж: и оверрайды, и фолбэк идут на **базовую шкалу самой системы**. Пишется только новыми версиями. Дополнительно под резолвером 2 полный патч `tokens`, из которого `space.*` выпали целиком, наследует шкалу базовой версии вместо молчаливой подмены — унаследованные ключи перечислены в `inheritedSpaceTokens`.

Разница наблюдаема только там, где база системы отличается от канонической (сегодня `wireframe`/`shadcn`, чьи темы неизменяемы); для кастомных систем база каноническая и оба резолвера совпадают. Резолвер — свойство **версии**, поэтому read-пути (discovery, `DesignSystemSummary`, capture, geometry-probe) резолвят каждую версию тем алгоритмом, с которым она записана. Kill-switch `EASYUI_THEME_RESOLVER_V2_DISABLED=1` (читается один раз на входе процесса) заставляет писать новые версии с резолвером `1` и отключает наследование `space.*`; в discovery это видно как `features.themeSpacingResolverV2: false`.

Грамматика (нарушение → `422 validation_failed` с `issues[].path`):

- **tokens**: карта ключ→значение. Ключ `^[a-z][a-z0-9]*(\.[a-z0-9-]+)*$`; значение — строка ≤256 без `;{}<>` **или** конечное число.
- **fonts**: `[{family, src, weight?, style?}]`, только asset-backed. `family` — буквы/цифры/пробел/дефис, ≤64. `src` — `asset_<64hex>`, который обязан существовать и быть font-типом (`font/woff2|ttf|otf`). `weight` — 1..1000 или `normal|bold`; `style` — `normal|italic|oblique`.
- **icons**: `[{name, assetId, viewBox?, themes?{light?,dark?}}]`. `name` — slug; `assetId` и `themes.*` — существующие asset'ы image-типа (`image/*`); `viewBox` — цифры/пробелы/точки/дефисы.

**Пин версии темы.** При сохранении/создании ревизии прототипа в `prototype_revisions.design_system_meta_version` фиксируется latest meta-version его системы (NULL, если версий темы нет — например у builtin). Restore копирует пин исходной ревизии, а не берёт latest. Пин **диагностический** (как `builtinCatalogHash`), enforcement нет; read-back `/draft`, `/revisions/:rev`, `/versions/:v` отдаёт `designSystemMetaVersion` additively.

**Доставка в runtime.** Player и capture грузят пиновую версию (latest для head) и инжектят `<style data-eui-theme>`: токены → CSS custom properties `--eui-<key с '.'→'-'>`, шрифты → `@font-face` с `src: url(/api/assets/<id>)`. Сериализация только из провалидированной грамматики; строковые значения дополнительно CSS-эскейпятся. Снапшот темы кладётся в `globalThis.__easyUiShared.tokens` (плоская карта key→string|number) и `.icons` (name→{assetUrl, themes}), откуда их читают `token()`/`Icon` shim'а `easy-ui/runtime` (ABI v2). Cleanup восстанавливает предыдущий снапшот при размонтировании.

### Система ревизии, публикации и manifest

Система head хранится в `components.design_system`, а каждая immutable ревизия фиксирует её в `component_revisions.design_system`. Publish не дублирует систему: версия связана с конкретной ревизией и читает систему join-ом. Поэтому перенос через `PUT` с `designSystem` и последующий publish не изменяет старые ревизии, версии и prototype pins.

После переноса один компонент намеренно может иметь active-версии в двух системах. `/catalog/manifest` возвращает отдельную запись для каждой пары `(component, designSystem)` — последнюю active-версию в этой системе. Старые и вновь сохраняемые прототипы прежней системы продолжают резолвить последнюю опубликованную версию своей системы; Library поэтому показывает компонент в обеих группах.

### Управляемая миграция компонента между системами

Production-миграция выполняется по явному manifest с `id`, `expectedHeadRev` и SHA-256 ожидаемого source, а не по имени или префиксу. Перед действием читаются meta и `/source`; hash считается от UTF-8 байтов source без канонизации. Допустимы только состояния:

| Read-back | Действие |
|---|---|
| ожидаемая rev, исходная система, source совпал | `PUT` с целевой системой и `baseRev`, без source |
| ожидаемая rev + 1, целевая система, source совпал, head не опубликован | publish head |
| ожидаемая rev + 1, целевая система, publish именно head active | шаг завершён |
| любое иное состояние | остановка и ручной разбор |

При `409 revision_conflict` state machine перечитывается, PUT вслепую не повторяется. `already_published` считается успехом только после сверки rev, системы и source hash конфликтующей версии. Результаты rev/version пишутся в deployment log. Лишь после публикации всех компонентов сохраняется новая ревизия прототипа с целевой `doc.designSystem`; иначе save атомарно отклоняется. Старые prototype revisions и pins остаются неизменны. Полный порядок, backup-требования и read-back описаны в [плане v3](plans/2026-07-11-custom-design-systems.md#миграция-существующих-yandex-pay-данных).

| Метод и путь | Ответ |
|---|---|
| `GET /health` | `{status:"ready", renderer:{…}}` после миграций, seed и ABI-проверки; до готовности 503 `starting`. Секция `renderer` — объявленный рендерер образа (см. [Renderer fingerprint 2.0](#renderer-fingerprint-20-волна-r1-план-2026-08-03-renderer-contract-2)): деплой сверяет её с `renderer-manifest.json` образа, не дожидаясь первого капчура |
| `GET /catalog/manifest?designSystem=<slug>` | `{components:[{id,name,designSystem,version,bundleUrl,bundleHash,hostAbiVersion,events,eventPayloads?,capabilities?,slots,description,example?,examples?,propsJsonSchema?,atomicLevel?,layoutNeutral?,layout?,scope?,allowedAsRoot?,canonicalFor?,sourceBounded?,ownership?,replacement?,headUsageCount,deprecated}]}` — последняя active-версия каждого неудалённого custom-компонента для каждой системы или только указанной системы; host-примитивы намеренно не входят; `headUsageCount`/`deprecated` — см. [Граф использования](#граф-использования-компонентов) |
| `GET /catalog/usages?designSystem=<slug>` | Агрегированный индекс использования, см. [Граф использования](#граф-использования-компонентов) |
| `GET /shims/v1/:name.js` | ESM-шим host ABI v1; immutable |
| `GET /shims/v2/:name.js` | ESM-шим host ABI v2 (v1 + `easy-ui-runtime.js`); immutable |

Без `designSystem` manifest охватывает все системы. Для фильтра действует явная матрица: malformed slug → `422 validation_failed`; корректный, но незарегистрированный slug → `404 not_found`; зарегистрированная система без active custom-компонентов → `200 {"components":[]}`.

### Ассеты

Content-addressed реестр бинарных ассетов (изображения и шрифты). `id = "asset_" + полный sha256` (64 hex-символа) — контент-адрес, коллизий нет. Байты хранятся в `DATA_DIR/assets/<sha256>` атомарной записью (temp-файл + `rename`); таблица `assets(id,sha256,mime,size,width?,height?,original_name?,created_at)`. Пины `prototype_revision_assets` и `component_publish_assets` держат FK `ON DELETE RESTRICT`: пиновые байты нельзя удалить.

Байты намеренно остаются глобальными внутри аутентифицированного origin: content-addressed ID не получает отдельного владельца. При этом list/usage не раскрывают приватный граф ссылок и фильтруются по достижимости из ресурсов, видимых текущему принципалу. Полные `asset_grants` вне этой модели.

| Метод и путь | Тело / ответ |
|---|---|
| `POST /assets` | Raw body с `Content-Type` (или `multipart/form-data` с ровно одним файлом). Новый ассет → 201 `{id,url,sha256,mime,size,width?,height?}` и `Location`; существующий sha256 → 200 с тем же телом и `deduplicated:true` |
| `GET /assets?limit=&cursor=` | `{assets:[AssetWithUsage],nextCursor:string|null}` в обратном порядке создания; `limit` по умолчанию 50, диапазон 1–200 |
| `GET /assets/:id` | Байты ассета; корректный `Content-Type`, immutable cache и жёсткие inert-заголовки (см. ниже). Неизвестный `id` → `404 asset_not_found` |
| `GET /assets/:id/usage` | Ассет и все удерживающие его hard pins; неизвестный `id` → `404 asset_not_found` |

Cursor — каноническая строка `<ISO-8601>~<asset_id>`, например `2026-07-15T12:34:56.789Z~asset_<64 hex>`, длиной не более 128 символов. Неканоническая дата, неверный asset ID или иная грамматика дают `400 invalid_cursor`; неизвестные query-поля, нецелый/нулевой/отрицательный `limit` и `limit>200` — `422 validation_failed`. `AssetWithUsage` содержит `{id,sha256,mime,size,width?,height?,originalName:string|null,createdAt,url,usage:{prototypes,components,visualReferences,visualRuns}}`.

`GET /assets/:id/usage` возвращает `{asset,prototypes:[{id,name,revCount,lastRev,pinnedAtHead}],components:[{id,name,versions:number[]}],visualReferences:[{id,deleted}],visualRuns:[{id,referenceId,role:"reference"|"candidate"|"diff"}]}`. Это полный список только **hard pins**: ревизий прототипов, публикаций компонентов, visual references (включая tombstone) и трёх ролей visual runs. Семантические ссылки в theme assets и Figma `referenceScreenshots` endpoint не индексирует и не показывает.

Приём: реальный тип определяется по magic-байтам и обязан совпадать с заявленным `Content-Type` — иначе `422 asset_type_mismatch`; неподдерживаемый заявленный тип — `422 unsupported_asset_type`. Допустимы `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/svg+xml`, `font/woff2`, `font/ttf`, `font/otf`. Лимит размера — 5 MiB (`413 asset_too_large`). Для растров декодируются размеры из заголовков (png/jpeg/webp/gif) и применяется лимит 16 Mpx (`413 asset_too_large`, decompression-bomb guard). SVG в v1 не санитизируется — вместо этого отдаётся инертно.

Заголовки `GET /assets/:id`: `Cache-Control: public, max-age=31536000, immutable`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`. Ассеты остаются за границей BasicAuth и same-origin (остаточный риск SVG зафиксирован здесь как admin-only инструмент).

**Ссылки из документов.** В URL-пропах документа допустима директива `{"$asset":"asset_<sha256>"}` (см. [формат](prototype-format.md#assets)); резолвится в `/api/assets/<id>` при построении runtime-спека. На save `collectAndValidateAssetRefs` проверяет существование до транзакции (`422 asset_not_found`) и пинует ассеты в `prototype_revision_assets` на каждой ревизии; restore копирует пины. Read-back (`/draft`, `/revisions/:rev`, `/versions/:v`) отдаёт `assets:[{id,sha256,mime,size}]`.

**Ссылки из компонентов.** На publish source сканируется на строковые литералы `/api/assets/asset_<sha256>`; найденные ассеты валидируются (`422 asset_not_found` при dangling) и пинуются в `component_publish_assets`; read-back версии показывает `assets`.

**Orphan-политика.** Загрузка через `POST /assets` сразу создаёт строку реестра и файл, даже если клиент затем не сохранил документ со ссылкой на ассет. Сервер сейчас не запускает GC и не удаляет такие unpinned-ассеты автоматически: они хранятся бессрочно. `scripts/audit-assets.ts` лишь показывает unpinned-строки как кандидатов на будущую ручную очистку; самой очистки скрипт не выполняет. Пиновые ассеты защищены FK `ON DELETE RESTRICT`.

**Backup.** Логический снапшот прод-данных должен включать БД (`easy-ui.db` + `-wal`/`-shm`) **и** каталог `DATA_DIR/assets/`. Целостность (orphan-файлы, битые/недостающие байты, unpinned) проверяет ручной/деплойный скрипт `scripts/audit-assets.ts` (в `npm run verify` не входит — требует живую БД).

## Скриншоты

Асинхронный job-API рендерит экран прототипа (либо компонент — опубликованную версию или сохранённую head-ревизию) через headless Chromium (playwright) в отдельном node-подпроцессе. Обычный режим создаёт PNG и складывает его в реестр ассетов (D); geometry probe возвращает только DOM-геометрию и не создаёт PNG/asset. Оба режима требуют `SERVE_DIST` **и** установленного chromium; иначе POST сразу отвечает `501 screenshot_unavailable`.

| Метод и путь | Тело / ответ |
|---|---|
| `POST /prototypes/:id/screens/:screenId/screenshot` | `{rev?\|version?, viewport{width,height}, deviceScaleFactor?, theme?, waitForFonts?, probe?:"geometry"}` → `202 {jobId}` |
| `POST /components/:id/versions/:version/screenshot` | `{props?\|exampleName?, viewport, deviceScaleFactor?, theme?, waitForFonts?, probe?:"geometry"}` → `202 {jobId}`; `props` и `exampleName` взаимоисключающие |
| `POST /components/:id/head/screenshot` | То же тело; снимает сохранённую **неопубликованную** head-ревизию → `202 {jobId}`. См. [Draft-preview](#draft-preview-head-ревизии-компонента) |
| `GET /screenshot-jobs/:jobId` | `{status: queued\|running\|done\|error, result?, error?}` |
| `GET /screenshot-jobs/:jobId/receipt` | `{receiptSha256, receipt}` — capture receipt кадра, см. [Capture receipt](#capture-receipt-волна-r5-план-2026-08-03-renderer-contract-2) |

Прототипная постановка additively возвращает `components[]` — разрешённые на момент enqueue пины (`{id,name,version,bundleHash}`). Для [head-tracking](#head-tracking-служебных-прототипов) дока это единственный момент, когда клиент узнаёт, какие версии компонентов реально пойдут в кадр. Постановка требует владения ресурсом; `GET /screenshot-jobs/:jobId` перепроверяет доступ по цели джобы — read-доступ к прототипу для прототипных и владение компонентом для компонентных, включая draft-джобы.

`result` (при `done`) — discriminated union. Image-ветка сохраняет прежние поля и получает discriminator: `{kind:"image", imageUrl, assetId, width, height, consoleErrors, pageErrors, rendererBuild, browserVersion, componentPins?|bundleHash?}`. Draft-джоба (`/head/screenshot`) дополнительно несёт `draftRev` — номер снятой head-ревизии.

**Capture-контракт (волна 7.1, аддитивно).** Обе ветки результата дополнительно несут `captureClean`, `productErrors[]`, `infraNoise[]`, `runtimeWarnings[]`; image-ветка ещё и `imageProduced: true`. `consoleErrors`/`pageErrors` остаются прежними (полный сырой список) — старые клиенты не ломаются. Классификация — единый allowlist в `server/screenshot/noise.ts`: `favicon.ico`, origin'ы браузерных расширений (`chrome-|moz-|safari-web-extension://`), `ERR_NETWORK_CHANGED`, `ResizeObserver loop …`, а также любое сообщение, все абсолютные URL которого ведут не на capture origin. Всё остальное — `productErrors`, то есть дефект самого прототипа; `captureClean === productErrors.length === 0`. `runtimeWarnings` — console-warning'и страницы (`[overlay] …` и подобные), они никогда не являются причиной провала.

Geometry-ветка дискриминирована по `surface`: `"prototype"` — экран прототипа, `"component"` — одиночный компонент (`probe: "geometry"` принимают обе компонентные ручки, published и draft). Замер (`rects`, `truncated`, `total`, `safeArea`, `roleRects`, `frame`, `content`, `scroll`, `viewportOwnership`, `issues`), `viewport`, `dpr` и capture-контракт качества у обеих поверхностей одинаковы; различаются только поля цели. Прототипная поверхность:

```json
{
  "kind": "geometry",
  "surface": "prototype",
  "resolvedRev": 3,
  "prototypeInstanceId": "instance_…",
  "componentPins": [{"id":"stack","version":1,"bundleHash":"…"}],
  "designSystemMetaVersion": 2,
  "resolvedSpaceScale": {"none":"0px","xs":"4px","sm":"8px","md":"12px","lg":"16px","xl":"24px","2xl":"32px","3xl":"48px","4xl":"64px"},
  "viewport": {"width":390,"height":844},
  "dpr": 1,
  "rects": [{
    "key":"content","instance":0,"parentKey":"root","parentInstance":0,"domIndex":1,
    "x":16,"y":24,"width":358,"height":80,
    "layoutContext":{"display":"flex","flexDirection":"column","flexWrap":"nowrap","rowGap":"12px","columnGap":"12px"}
  }],
  "truncated": false,
  "total": 2,
  "safeArea": {"top":0,"right":0,"bottom":0,"left":0},
  "roleRects": {
    "panel": {"x":0,"y":0,"width":390,"height":844,"source":"key","key":"root"},
    "region:header": {"x":0,"y":0,"width":390,"height":56,"source":"key","key":"head"},
    "region:footer": {"x":0,"y":760,"width":390,"height":84,"source":"selector"}
  },
  "frame": {"x":0,"y":0,"width":390,"height":844,"source":"surface"},
  "content": {"x":0,"y":0,"width":390,"height":844},
  "scroll": {"width":390,"height":1180},
  "viewportOwnership": {
    "frame": {"width":390,"height":844}, "content": {"width":390,"height":844}, "scroll": {"width":390,"height":1180},
    "scrollable": true,
    "owners": [{"role":"region:header","areaPct":6.64,"heightPct":6.64},{"role":"region:footer","areaPct":9.95,"heightPct":9.95}],
    "unownedPct": 83.41
  },
  "issues": [{"code":"content-clipped-by-frame","severity":"warn","message":"…","detail":{"overflowRight":0,"overflowBottom":336}}]
}
```

Поля `safeArea`/`roleRects`/`frame`/`content`/`scroll`/`viewportOwnership`/`issues` добавлены волной 7.1 и аддитивны: прежние `rects`/`truncated`/`total` не изменились. `roleRects` покрывает роли `panel`, `frame`, `region:header`, `region:footer`, `region:statusBar`; каждая опциональна. Источник роли (`source`) — `key` (rect авторского элемента: `panel` = root экрана, регионы — из `region`-разметки спеки), `selector` (DOM-слот `[data-eui-region=…]`, `[data-eui-stage-viewport]`, `[data-eui-content-scroller]`) или `surface` (fallback фрейма на `#eui-capture-surface`). `safeArea` читается из `env(safe-area-inset-*)` временным probe-элементом (в capture-окружении обычно нули). `viewportOwnership` показывает, какую долю фрейма занимает каждая роль (`areaPct`/`heightPct`) и сколько остаётся контенту (`unownedPct`), плюс `scrollable` (scrollHeight выше фрейма). `issues[]` — структурные проверки (все `severity:"warn"`, ничего не блокируют): `content-clipped-by-frame` (контент выходит за фрейм), `overlapping-regions` (две роли пересекаются), `footer-owns-page` (футер занимает ≥50% высоты фрейма). Анализ чистый и живёт в `analyzeGeometry` (`src/capture/geometry.mjs`), сам замер — в `collectGeometry`.

Компонентная поверхность вместо `resolvedRev`/`prototypeInstanceId`/`componentPins` несёт цель самого компонента:

```json
{
  "kind": "geometry",
  "surface": "component",
  "componentId": "pay-button",
  "version": 3,
  "bundleHash": "…",
  "designSystemMetaVersion": 7,
  "resolvedSpaceScale": {"none":"0px","xs":"4px","…":"…"},
  "viewport": {"width":390,"height":844},
  "dpr": 1,
  "rects": [],
  "truncated": false,
  "total": 0
}
```

`version` и `draftRev` взаимоисключающие: published-джоба отдаёт `version`, draft-джоба (`/head/screenshot`) — `draftRev`. `designSystemMetaVersion` и `resolvedSpaceScale` берутся из **последней** версии темы системы компонента (компонентная съёмка версию темы не пинует, в отличие от прототипной, которая читает пин ревизии); шкала резолвится тем `spacingResolver`, который записан в этой версии темы — см. [Тема](#тема-дизайн-системы-tokensfontsicons-и-версии). Ролей экрана у одиночного компонента нет, поэтому `roleRects` обычно пуст, а `frame` приходит из capture-поверхности.

#### Draft-preview head-ревизии компонента

`POST /components/:id/head/screenshot` снимает **сохранённую, но не опубликованную** head-ревизию: атом доводится до нужной геометрии до первой публикации. Тело — как у published-ручки (`props?`|`exampleName?`, `viewport`, `deviceScaleFactor?`, `theme?`, `waitForFonts?`, `probe?:"geometry"`), доступ — владелец компонента.

- Рендерится эфемерный candidate-bundle [validate-префлайта](#validate-префлайт-публикации). При холодном кэше (кандидат не собирался или вычищен GC) постановка собирает его сама, под тем же троттлингом и с тем же кэшем по `sourceHash`, поэтому ручка асинхронна и может ответить `429 validate_in_flight`/`429 queue_full`.
- Сломанный драфт отвечает тем же ApiError, что и validate (`422 validation_failed` и остальной набор), а не «нет бандла».
- `exampleName` и `propsJsonSchema` берутся из extract-результата драфта (published-DTO для него не существует) и едут на capture-поверхность внутри job-scoped bootstrap; неизвестное имя примера → `422 unknown_example`.
- Asset-ссылки, извлечённые из исходника драфта, попадают в capture-allowlist джобы. Пиннинга ассетов у драфта нет — он появляется только на publish.
- Candidate-bundle доступен исключительно внутри своей джобы (content-addressed путь в allowlist), не участвует в каталоге, резолве latest-active и bundle-экспорте и публичного URL-контракта не имеет.
- Ручка гаснет тем же kill-switch'ем, что и validate (`EASYUI_VALIDATE_DISABLED=1` → `404`), потому что постановка джобы означает сборку кандидата.

Worker обходит production-маркеры `span[data-eui-key]` после `__EUI_CAPTURE_READY__`. `instance` — нулевой ordinal одинакового `key` в DOM-порядке (в том числе для repeat), `parentKey`/`parentInstance` указывают ближайший ancestor-маркер, `domIndex` — общий DOM-порядок. Координаты округлены до 0.01 CSS px и отсчитаны от border box `#eui-capture-surface`; `dpr` не масштабирует их. Rect — union видимых box'ов DOM-поддерева маркера. Портал вне этого поддерева не включается; Overlay-layer включается, потому что его маркеры находятся внутри capture surface; fixed box целиком вне surface отбрасывается. Clipping/scroll не обрезает исходный layout rect.

Состояния различаются так: отсутствующий marker отсутствует и в `rects`; `display:none`/`visibility:hidden` даёт `hidden:true` и нулевой rect; отрендеренный элемент нулевого размера имеет нулевой rect без `hidden`. Число строк ограничено `limits.geometryRects` из `GET /capabilities` (тот же бюджет, что `repeatBudget`); `total` содержит число до усечения, `truncated` сообщает об усечении.

Layout owner вычисляется только из DOM: для непосредственных child-маркеров slot-группы берётся ближайший общий non-`display:contents` предок внутри parent-маркера. Fragment, несколько DOM roots или переход через marker делают owner неоднозначным, поэтому `layoutContext:null`. Из однозначного owner возвращаются computed `display`, `flexDirection`, `flexWrap`, `rowGap`, `columnGap`.

`driver.mjs geometry <protoId> <screenId>` печатает rect, layoutContext, роли, safeArea, ownership и `issues`. Observed clearance между соседними rect по оси и CSS gap owner'а выводятся только когда definition декларирует `layout.flow`, направление статически известно, owner подтверждает non-wrapped flex нужной оси и группа не содержит repeat/named slots. Во всех остальных случаях печатается `gaps: n/a (<причина>)`. Observed clearance намеренно может отличаться от CSS gap из-за margins.

**CLI-контракт `driver.mjs` (волна 7.1/7.2).** `snap` завершается с кодом `0`, если PNG создан на всех экранах и `productErrors` пуст; `2`, если PNG создан, но есть product-ошибки; `1`, если PNG не создан вовсе. Инфраструктурный сбой (job `error`/`timeout`, 5xx) повторяется автоматически — ровно 2 попытки на экран; product-ошибки не повторяются никогда. `status` и `snap` принимают `--all-screens`, любой verb — `--json` (машинный документ в stdout вместо человеческих строк). `snap` дополнительно принимает `--viewport WxH`, `--dsf 1|2|3`, `--theme light|dark` (как `baseline`); вьюпорт по умолчанию — canvas-aware `resolveViewport` (паритет с `geometry`/`baseline`), бюджет capture-поверхности (`surface × dsf² ≤ 16 Mpx` — лимит ингеста ассетов) проверяется до постановки job'а. `component` принимает `--figma <file.json>` — provenance уходит одним вызовом вместе с source (create и update); флаг **опционален**: provenance наследуется между ревизиями, и update без флага её не обнуляет (см. [Provenance компонентов](#provenance-компонентов-без-новых-версий)). Смена и очистка ссылки — верб `provenance <componentId> <figma.json|null> [--rev N]`. Сессионная cookie кэшируется на диске между процессами (`scripts/easyui-auth.mjs`: `$XDG_STATE_HOME/easyui`, TTL 24 ч, атомарная запись; 401 с `code:"unauthorized"` на кэшированной cookie → один shared re-login с повтором запроса; выключатель `EASYUI_SESSION_CACHE=0`, путь — `EASYUI_SESSION_FILE`), GET-запросы и постановка screenshot-job'а ретраятся на 5xx с backoff 500/1500 мс.

Для component screenshot `exampleName` выбирается строго из `definition.examples`: неизвестное имя или отсутствие `examples` → `422 unknown_example`, одновременные `props` и `exampleName` → `400 invalid_request`. После выбора набор проходит обычную валидацию props и участвует в `propsHash`.

**Границы (bounds).** `width ∈ [64,2000]`, `height ∈ [64,4000]`, `deviceScaleFactor ∈ {1,2,3}`, `width×height×dsf² ≤ 20 Mpx` — иначе `422 invalid_viewport`. PNG подчиняется лимитам ассетов (5 MiB / 16 Mpx). Пул concurrency 1, очередь ≤5 (`429 queue_full`), hard deadline job 60 s, TTL результата 10 минут (PNG остаётся в ассетах). Jobs хранятся в памяти.

**Snapshot цели при enqueue.** POST атомарно резолвит цель в `expected` (`prototype`: `{prototypeInstanceId,rev,componentManifestHash,builtinCatalogHash,dsMetaVersion,rendererBuild}`; `component`: `{componentId,version,bundleHash,propsHash,dsMetaVersion,rendererBuild}`) и сохраняет в job. Queued job не может «уехать» на более поздний head. Capture-shell (`/capture/:id/s/:screen`, `/capture/component/:id/:version`) выставляет discriminated `window.__EUI_CAPTURE_READY__` той же формы; worker строго канонически сравнивает с `expected` и падает при mismatch/`status:"error"` (быстрый fail вместо таймаута; readiness poll 20 s). Хеши добавлены в revision DTO additively.

Прямой component capture понимает только следующую грамматику. Bootstrap props от screenshot-worker всегда приоритетны. `?example=<name>` выбирает own-key из `examples` без fallback; неизвестное имя — capture error. `?props=example` без `example` выбирает legacy `definition.example`, а при его отсутствии падает. Любое другое значение `props`, а также повтор любого из параметров — ошибка. Без селекторов используются `{}`.

**Session-auth капчера.** При dequeue минтится одноразовая (в рамках job) capture-session: `{token(32B), kind, allowedUrls (точный immutable snapshot), expected, props?}`, TTL = deadline 60 s + 30 s, revoke в `finally`. Worker шлёт `X-EasyUI-Capture: <token>` только на loopback capture-origin (инжект в `context.route` по exact origin). Сервер принимает токен как транспортную авторизацию (обходит BasicAuth) только при: `server.requestIP()` ∈ loopback (`127.0.0.1`/`::1`/`::ffff:127.0.0.1`), метод GET/HEAD, нормализованный decoded-путь ∈ `allowedUrls`. `allowedUrls`: capture-route, revision/version/draft endpoint, pinned bundle URLs, pinned `/api/assets/:id` (из документа и компонентов), `/api/shims/`, транзитивная статика SPA из Vite-манифеста (js/css/`/fonts/*`/index; fallback — префиксы `/assets/`, `/fonts/`). Bootstrap (`__EUI_CAPTURE_BOOTSTRAP__`, включая произвольные `props` компонента) доставляется через `page.addInitScript` — page-JS не нуждается в токене.

**Egress-модель (defense-in-depth).** Network namespace в этом окружении недоступен (нет прав на unshare), поэтому изоляция задаётся Chromium-флагами и контекстом: `--proxy-server=http://127.0.0.1:<deny-port>` (контролируемый deny-proxy — локальный TCP-сокет, немедленно закрывающий соединения), `--proxy-bypass-list=<-loopback>;127.0.0.1:<capture-port>` (port-scoped: `<-loopback>` отключает implicit loopback-bypass, мимо proxy идёт только точный capture-origin), `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`, `--disable-quic`, `--webrtc-ip-handling-policy=disable_non_proxied_udp` + `--force-webrtc-ip-handling-policy`; контекст — `serviceWorkers:"block"`, `routeWebSocket` close, `context.route` в allowlist-режиме (только captureOrigin + путь ∈ allowedUrls, включая redirect-цепочки; иной loopback-порт или `[::1]` — abort). locale `ru-RU`, timezone `Europe/Moscow`, `reducedMotion: reduce`; CSS-анимации/caret глушатся стилем в capture-режиме.

**Остаточный риск.** По [модели доверия](#граница-доверия-и-запуск) published-код равен коду репозитория; egress-блок — defense-in-depth, а не sandbox. Точная строка `--proxy-bypass-list` закреплена unit-тестом; главный allowlist-инвариант покрыт server-side unit-тестами; полный adversarial сетевой сценарий помечен `test.fixme` в `e2e/preview/screenshot.spec.ts` (нестабилен в контейнере).

### Geometry Contract 2.0 — `probe: "paint"` (волна W3, план 2026-08-03)

Режим измерения **краски**, а не только коробок. Доступен только на candidate-пути матричной приёмки
(`server/screenshot/service.ts`, `enqueueComponentCandidate({ probe: "paint" })`), который использует
гейт `geometry`; публичные screenshot-ручки (`/screenshot`, `/head/screenshot`) принимают по-прежнему
только `probe: "geometry"` — `probe: "paint"` на них отвечает `422 unsupported_option`. Наличие режима
в сборке публикуется как `features.geometryPaint` в `GET /capabilities`.

**Зачем.** Element-screenshot клиппит чернила коробкой `#eui-capture-surface` (она непрозрачна и
inline-block), поэтому ink-bbox по обычному кадру не измерим в принципе. Paint-джоба рендерит
поверхность **прозрачной** и с полем вокруг компонента (по умолчанию 64 CSS px, потолок 256), снимает
её с `omitBackground: true` и **в той же browser-сессии** собирает geometry-факты: `layoutBounds` и
`paintBounds` гарантированно относятся к одному кадру.

Исход джобы (`kind: "paint"`) несёт и байты PNG, и обычный geometry-блок, плюс `paintMargin` и
`details[]` — детальные измерения по `geometryDetailKeys` (≤20 ключей маркеров; пустой список
означает корневой маркер):

```json
{
  "key": "root", "instance": 0,
  "layoutBounds": {"x":64,"y":64,"width":140,"height":96},
  "effectSources": [
    {"elementKey":"highlight","elementPath":"div>div.highlight","cause":"filter:blur(68px)","rect":{"x":46.5,"y":47,"width":175,"height":130}}
  ],
  "clipChain": [{"key":"card","elementPath":"div.card","property":"overflow","value":"hidden hidden","effective":true,"rect":{"x":64,"y":64,"width":140,"height":96}}]
}
```

- `layoutBounds` — union border-box'ов **in-flow** потомков маркера. Потомки с `position:absolute|fixed`
  и трансформированные из контура исключены: именно их коробки давали «ширину 175 при layout-ширине
  140». Существующий `rects[]` не изменился ни на байт — измерение аддитивно.
- `effectSources[]` — потомки, красящие за пределами своей коробки или выпавшие из потока:
  `filter:*`, `box-shadow:*`, `outline:*`, `transform:*`, `position:absolute|fixed`.
- `clipChain[]` — предки с `overflow:hidden|clip` или `clip-path`; `effective: true` означает, что клип
  реально режет объединение layout-боксов и источников (а не просто объявлен).
- `paintBounds` считает `scripts/ink-bbox-worker.mjs` (node-подпроцесс, pngjs): bbox пикселей с
  `alpha > 0`, **нормализованный в CSS px** делением на `deviceScaleFactor` (`paintBoundsSource:"alpha"`).
  Если чернила упираются в край поля (`clamped`), измерение обрезано холстом, а не компонентом.

**Вердикт** считает чистая функция `src/capture/geometryPolicy.ts` (без DOM и без PNG):
`policyVerdict ∈ clean | paint-overflow-clipped | paint-overflow-not-clipped | layout-overflow | indeterminate`,
плюс `overflow: {left,right,top,bottom,sources[]}`, где каждый источник несёт `elementKey`, CSS-`cause`
и `contribution` по сторонам (источники ранжируются по вкладу). Допуски случая приходят из
case-set-манифеста (`policy.perCase.<id>`): `allowPaintOverflow` (ожидаемая тень/свечение),
`expectedClip` (ожидаемая обрезка), `expectedGeometry` (ожидаемые габариты layout-контура).

**Гейт `geometry`** в профилях `default-v1`/`pixel-strict-v1` стал `required` (advisory-фаза v1
закончилась). Его инвариант: `fail` возможен **только** с непустым `overflow.sources[]` либо с названным
расхождением `expectedGeometry`; наблюдённый overflow без объяснимого источника, чернила на краю поля и
несобранный контур дают `indeterminate` с диагностикой («увеличить маргин»), а не обвинение компонента.
Артефакты случая — `paint.png` и `geometry.json` (факты + вердикт) в CAS evidence. Граница волны подняла
`case_fingerprint.algoVersion` до 3: накопленный reuse прошлых волн инвалидирован.

### Deterministic Capture Readiness (волна W4, план 2026-08-03)

Готовность кадра перестала быть «подождать и надеяться»: капчур-поверхность исполняет
**версионированную политику** и публикует доказательство. Наличие механизма в сборке —
`features.captureReadiness` в `GET /capabilities`.

```ts
readinessPolicy = { version: 1, fonts: "used-faces" | "document-ready", images: "decoded",   // v2 — ниже, «Строгая readiness 2.0»
  network: { quietMs: 200, scope: "component-owned" }, frames: 2,
  animations: "disabled", timeoutMs: 15000 }
readinessPolicyHash = sha256(canonicalStringify(policy))       // src/capture/readinessPolicy.ts
```

Политика едет поверхности в `bootstrap.readiness` (её пинует acceptance-путь из профиля приёмки:
`AcceptancePolicy.readiness`); джобы без неё работают по дефолтной политике — поведение
интерактивных путей (галерея, библиотека, draft-preview) не изменилось. Поверхность по политике:

1. гасит анимации/переходы инъекцией `*{animation:none!important;transition:none!important}`;
2. поднимает и ждёт **реально применённые** `@font-face` (`fonts: "used-faces"` — семейства
   собираются `getComputedStyle`-выборкой по поверхности), либо `document.fonts.ready`;
3. декодирует все `img` поверхности (`images: "decoded"`);
4. ждёт тишины сети `network.quietMs` по **ресурсам компонента** (same-origin `/api/assets`,
   `/api/design-systems`) — чужие запросы страницы ожидание не продлевают;
5. ждёт `frames` подряд стабильных rAF-кадров;
6. упирается в `timeoutMs`: превышение не бросает ошибку, а даёт честный `met: false` с причиной.

Доказательство публикуется рядом с handshake (`__EUI_CAPTURE_READY__.readiness` / `.env`) и **не
входит** в сравнение с `expected` — сервер сверяет хэш политики прямо в результате:

```json
{
  "met": false, "reason": "images_failed", "policyHash": "<sha256>", "elapsedMs": 15002,
  "evidence": {
    "fontFaces": [{"family":"Ya Sans","weight":"400","style":"normal","status":"loaded"}],
    "images": {"total": 3, "decoded": 2, "failed": 1},
    "pendingRequests": ["image:https://example.test/late-icon.svg"],
    "framesWaited": 2, "animationsDisabled": true,
    "themeResources": {
      "tokens": ["--eui-color-bg-default", "--eui-color-fg-primary"],
      "icons": ["asset_<sha256>"], "images": ["asset_<sha256>"]
    }
  }
}
```

`themeResources` — **обязательная** часть доказательства: наблюдённые токены (имена CSS-переменных,
на которые ссылаются стили поверхности), иконки темы и прочие ассеты, попавшие в кадр. Это
единственный вход класса «сменилась только версия темы» в импакт-анализе W6; без них частичная
пересъёмка невозможна.

Отпечаток окружения (`src/capture/env.ts`) наблюдается там же:
`captureEnvFingerprint = sha256({browserVersion, platform, dpr, colorScheme, colorProfile,
fontRasterFingerprint, rendererBuild, readinessPolicyHash})`. `colorProfile` — best-effort
(наблюдаемый gamut; при недоступности — `"colorSchemeOnly"`, точный ICC вне объёма),
`fontRasterFingerprint` — канвас-проба (эталонная строка рисуется в offscreen canvas, пиксели
хешируются). Байтовые исходы приёмки (`kind: "image-bytes"`, `kind: "paint"`) несут
`readinessMet` / `readinessReason` / `readinessPolicyHash` / `readinessEvidence` /
`captureEnvFingerprint`; контракты публичных screenshot-ручек не изменились.

**Гейт `readiness`** — `required` в обоих профилях приёмки. Он судит тот же кадр, что снял `render`
(своей съёмки не делает), кладёт доказательство в CAS (`readiness.json`) и даёт:

- `fail` — `met: false`; причина и `pendingRequests` в `detail`/`metrics`. Это **продуктовый** исход:
  авто-retry (A3) его не ретраит — ретраятся только инфраструктурные `jobOutcome`;
- `indeterminate` — кадр не принёс доказательства вовсе (шелл старше протокола) либо поверхность
  ждала по другой политике (`policyHash` ≠ политики профиля);
- `pass` — политика выполнена.

**Инвариант D5:** capture с `met:false` не получает визуального вердикта. Раннер при провале
readiness не считает сравнивающие гейты случая (`geometry`, `determinism`, будущий `visual`) —
они возвращают `indeterminate` с `metrics.skippedByReadiness: true`, а не обвиняют компонент за
кадр, снятый до появления шрифта или иконки. Граница волны подняла `case_fingerprint.algoVersion`
до 4, а `readinessPolicyHash`/`captureEnvFingerprint` в отпечатке случая перестали быть заглушками:
хэш политики — общий с клиентом, серверная часть отпечатка окружения — платформа хоста плюс этот
хэш (браузерная часть отпечатка наблюдается в кадре и живёт в evidence, потому что отпечаток
случая считается **до** съёмки).

### Минимальный визуальный гейт приёмки (волна W5a, план 2026-08-03 §2 A5)

Эталон приезжает из **case-set-манифеста** (`cases[].referenceAssetId`, ассет реестра) и привязан к
набору, а не к опубликованной версии: подсистема `visual_references`/`visual_runs` (раздел
[Visual regression](#visual-regression) ниже) этой волной не затрагивается и не мигрируется.
Кандидат — тот самый `paint.png`, который снял гейт `geometry`: второй съёмки нет, поэтому
`layoutBounds`, `paintBounds` и пиксельный вердикт относятся к одной сессии.

**Нормализация размеров** (обязательная часть). Порядок фиксирован и **однократен** (волна W5):

1. **crop** — по `cases[].cropLineage.rect`, и только если `cropLineage.sourceSurface` объявляет
   ассет экспортом родительского узла (`figma-node` либо отсутствие поля — legacy-семантика). При
   `sourceSurface: "content-hug"|"paint"` ассет уже вырезан, rect остаётся provenance'ом, и
   повторного crop'а не происходит: именно он превращал эталон `136×32` в `116×12`.
2. **построение канвы** — только при `referenceSurface: "content-hug"`: эталон кладётся в
   прозрачный холст `(expectedGeometry ?? layoutBounds + 2×margin) × dsf` по `referencePlacement`
   (по умолчанию `margin × dsf`). Размеры канвы считает **сервер** и передаёт воркеру числом
   (`padTo`): у воркера нет ни `expectedGeometry`, ни маргина рендерера, и вывод размеров на его
   стороне был бы вторым источником правды. Эталон, не помещающийся в объявленную канву, —
   `indeterminate`, а не тихая обрезка.
3. **дополнение до общего холста** — обе картинки добиваются прозрачным по левому-верхнему углу.

Что и как сервер сделал с эталоном, видно в `metrics.referenceNormalization`
(`{referenceSurface, sourceSurface, cropApplied, cropRect, croppedDims, padTo, placement, marginPx,
deviceScaleFactor, layoutRoot, layoutRootSource, sourceDims, refDims}`) — оно же в `visual.json`.
Поле кладётся всегда: «ничего не паддили и не резали» — тоже факт, и его отсутствие раньше и
делало нормализацию невидимой для автора.

Если после нормализации габариты расходятся больше
`maxDimensionDeltaPx` профиля (`default-v1` — 8 px, `pixel-strict-v1` — 4 px), метрик нет вовсе:
гейт отдаёт `indeterminate` с названной причиной, а не выдуманный процент расхождения.

**Метрики случая** (в `gates[].metrics` и в CAS-артефакте `visual.json`):

| Поле | Смысл |
|---|---|
| `rawDiffPct` | pixelmatch, порог `0.1`, сглаживание **считается** — по нему выносится вердикт |
| `aaDiffPct` | pixelmatch, порог `0.25`, сглаживание игнорируется — остаток структурного расхождения |
| `maxChannelDelta` | максимальная по-канальная дельта (0–255) |
| `regions` | до 12 связных областей diff-маски: `{bbox, areaPct, meanDelta}`, по убыванию площади |
| `bestOffset` | `{dx, dy, residualPct}` в окне ±8 px: «съехало на N px» отличимо от «перерисовано» |
| `severityClass` | `raw` или `aa` — класс severity случая (D10) |

**Порог и обязательность.** Бюджет `rawDiffPct` — per-case `policy.perCase.<id>.maxRawDiffPct`
манифеста, иначе профильный (`default-v1` — 2.0 %, `pixel-strict-v1` — 0.5 %). Гейт `required`
только там, где визуальная приёмка объявлена: профиль `pixel-strict-v1` либо `requireVisual: true`
манифеста (последнее поднимает роль гейта **для рана**, не меняя `policy.hash`, и входит в
`case_policy_hash`, поэтому переключение обязательности инвалидирует reuse ровно затронутых
случаев). В `default-v1` без `requireVisual` гейт считается и пишет метрики в evidence, но ран не
роняет. Случай без эталона — `skipped` у необязательного гейта и `indeterminate` у обязательного
(D10: `skipped` положен только необязательным).

Артефакты случая — `diff.png`, `normalized-candidate.png` и `visual.json` в CAS, плюс
`normalized-reference.png`, когда канву строил сервер (`referenceSurface: "content-hug"`). Сам
эталон в CAS **не копируется** — он уже иммутабелен в asset-store, и evidence несёт на него
ссылку парой `referenceSource {assetId, sha256}`, а рядом — построенный сервером дериват с полным
lineage (`referenceNormalization`). Инвариант D5
действует в полную силу: кадр с `readinessMet: false` до визуального гейта не доходит вовсе.
Граница волны подняла `case_fingerprint.algoVersion` до **5**; следующий (и на сегодня последний)
bump — **6**, вместе с расслоением отпечатка на три слоя (см.
[Трёхслойный отпечаток случая](#трёхслойный-отпечаток-случая-каскад-reuse-и-алгебра-refresh-волна-w1-план-2026-08-04)).

**Content-hug и переиспользованный кадр.** Корень канвы (§2 выше) берётся из `expectedGeometry`
случая, а при его отсутствии — из `layoutBounds`, **измеренного в этом же ране**. Случай, кадр
которого приехал из кэша (re-diff), свежих `layoutBounds` не приносит: канву строить не из чего, и
гейт честно отдаёт `indeterminate` с `reason: "reference_canvas_unresolved"`, а не сравнивает
компонент с пустотой. Практическое правило: **`referenceSurface: "content-hug"` объявляется вместе
с `expectedGeometry`** — иначе набор проходит только на холодном кэше и падает на любом повторе.
PUT такого манифеста предупреждает об этом (`warnings[]`), но не отказывает: на первом ране корень
действительно выводим.

### Таксономия причин и группировка ремедиаций (волна W5b, план 2026-08-03 §5)

Классификация — **диагностика поверх готового вердикта**: она никогда не влияет на pass/fail и
считается только для случаев, чей визуальный исход `fail` или `indeterminate`. Прошедший случай
причин не получает (`causes: []`).

Причины лежат в `gates[].causes` визуального гейта и поднимаются на уровень случая
(`GET /api/acceptance-runs/:runId/cases → cases[].causes`, `GET /api/acceptance-runs/:runId →
failedCases[].causes`). Форма причины: `{code, confidence (0..1), detail, elementKey?, region?}`,
где `region = {bbox (px холста), norm (доля layout-контура), basis}`. Список никогда не пуст:
последний код — `unclassified`.

| Код | Сигнал |
|---|---|
| `surface-tint` | ≥45 % холста в маске при малом разбросе дельты (`channelStats.stdMaxDelta`) — заливка/фон целиком |
| `edge-radius-stroke` | ≥70 % областей — тонкие (≤4 CSS px) полосы вдоль периметра контура |
| `geometry-shift` | `bestOffset` ненулевой, а остаток после него ≤35 % от `rawDiffPct` — «съехало», а не «перерисовано» |
| `text-raster-residual` | `aaDiffPct` ≤25 % от `rawDiffPct`, ≥3 мелких области — растровый остаток текста |
| `missing-late-asset` | доказательство readiness (W4): непустые `images.failed` или `pendingRequests` |
| `alpha-compositing` | ≥50 % пикселей маски расходятся преимущественно в альфе либо ≥60 % полупрозрачны |
| `effect-overflow` | ≥40 % площади расхождения — в кольце между `layoutBounds` и `paintBounds`; виновник берётся из `effectSources` |
| `descendant-outside-mask` | ≥40 % площади расхождения — вне измеренной маски владения |
| `unclassified` | ни один классификатор не сработал: причина не названа честно, а не подменена догадкой |

Метрики визуального гейта дополнены `channelStats` (`{pixels, meanDelta:{r,g,b,a}, meanMaxDelta,
stdMaxDelta, alphaDominantPct, semiTransparentPct}`) — статистика **внутри diff-маски**, вход
классификаторов `surface-tint`/`alpha-compositing`. Геометрические классификаторы молчат, если
контуры не помещаются в холст расхождения: несовпавшие системы координат — не находка.

Терминальный ран несёт `remediationGroups` (`GET /api/acceptance-runs/:runId`, сортировка по числу
случаев по убыванию):

```json
{"key":"<sha256>","cause":{"code":"missing-late-asset","confidence":0.9,"detail":"…"},
 "bboxSignature":{"x":1,"y":0,"width":1,"height":1,"grid":8},"sharedElementKey":"icon",
 "variantFamily":{"size":"m"},"cases":["…"],"caseCount":20,"suggestion":"…"}
```

`remediationKey = sha256(canonicalJson({causeCode, bbox, elementKey, variantFamily}))`. Случай
попадает ровно в одну группу — по своей самой уверенной причине. Если виновник назван
(`elementKey`), он и есть идентичность группы, а `bbox` в ключе — `null`: один и тот же элемент в
20 состояниях занимает 20 слегка разных прямоугольников. Без виновника ключом работает сигнатура
области — нормированный к `layoutBounds` bbox, квантованный в сетку 8×8. `variantFamily` —
**пересечение** `cases[].dims` участников группы (что у них общего), поэтому 20 состояний с одной
сломанной иконкой дают одну группу, а не 20 (§19.6 фидбэка). `suggestion` — шаблон следующей правки
по коду причины.

### Клиентский кэш харнеса (волна W7, план 2026-08-03 §5)

Кэш живёт **только на клиенте** (`.claude/skills/author/cache.mjs`, флаги `--cache-dir` /
`--cache-refresh` драйвера) — сервер о нём ничего не знает и никаких кэш-заголовков для него не
вводит (`ETag` API сегодня не отдаёт, валидация клиента идёт по фингерпринтам ответа и окну
свежести). Кэшируются только read-only GET'ы (`/capabilities`, каталог, версии компонентов,
`/component-candidates/:id`, `/case-sets/:id`, **терминальные** `/acceptance-runs/:id` и их
`/evidence`); нетерминальный ран, мутации и `/auth/*` — никогда, поэтому poll идущего рана всегда
доходит до сервера. Ключ записи несёт идентичность (`sha256(baseUrl + "\n" + username)`), токены и
куки в него не входят и на диск не пишутся; при legacy-Basic кэш выключен целиком.

**Клиентский кэш не является свидетельством приёмки.** Доказательная запись — серверный
evidence-манифест рана (CAS + `SHA256SUMS`, `GET /api/acceptance-runs/:id/evidence`); локальные
файлы лишь избавляют от повторного запроса, и любой отчёт агента обязан нести `cache.status`.

### Renderer fingerprint 2.0 (волна R1, план 2026-08-03 renderer-contract-2)

Идентичность рендерера объявляется **сервером и до съёмки** — только такой отпечаток годится
ключом reuse (`case_fingerprint` считается до постановки джобы). До волны эту роль играли две
вещи, и обе врали: `rendererBuild` — имя entry-файла SPA (идентичность бандла, не рендерера), а
серверный `captureEnvFingerprint` — `sha256({platform, arch, readinessPolicyHash})`, который
**не менялся от апгрейда chromium**, из-за чего reuse приёмки переживал смену браузера.

```ts
rendererFingerprint = sha256(canonicalJson({           // server/capture/renderer.ts
  rendererSchema: 2, rendererVersion,                   // ручной пин репозитория
  os, arch, nodeVersion, playwrightVersion,
  browserName, browserVersion, browserRevision,
  launchedExecutable, browserExecutableSha256,          // sha ФАКТИЧЕСКИ запускаемого бинаря
  fontStackSha256, appFontsSha256, systemLibsHash,
  launchDeterminismArgsHash, contextOptionsHash, colorProfile: "srgb",
  readinessPolicyHash,
}))
```

Ключевой факт: `chromium.launch({headless:true})` исполняет **`chrome-headless-shell`**, а
`chromium.executablePath()` возвращает полный `chrome`, который кадров не рисует. Поэтому в
отпечаток входит sha256 именно shell-бинаря плюс его имя (`launchedExecutable`). Значения
известны внутри образа, где браузер установлен: их считает build-слой
(`scripts/renderer-manifest.mjs` → `/app/renderer-manifest.json`, путь в переменной
`EASYUI_RENDERER_MANIFEST`), а сервер их читает и **замораживает на старте процесса**.
`provenance` (buildSha/imageRef/builtAt/bunVersion) едет рядом, но **в отпечаток не входит** —
иначе каждый коммит обнулял бы весь накопленный reuse.

**Dev-фолбэк.** В рабочем дереве манифеста нет: `source: "fallback"`, дорогие поля
(`browserExecutableSha256`, `fontStackSha256`, `systemLibsHash`, `appFontsSha256`) честно `null`,
дешёвые (os/arch/node/playwright/`browsers.json`) считаются на месте. Отпечаток остаётся
стабильным внутри процесса, но сравнивать его между хостами в этом режиме бессмысленно.

**Где виден.** `GET /api/capabilities` → `renderer` и `GET /api/health` → `renderer` (одно и то
же объявление; `fingerprint` — под дефолтной readiness-политикой, её хэш публикуется рядом как
`policyHash`). Результат image-джобы несёт `result.renderer` — отпечаток, замороженный **на
постановке** этой джобы, вместе с его входами. Прод-приёмка сверяет секцию с
`docker run <image> cat /app/renderer-manifest.json`.

**Сверка на капчуре.** Наблюдённая версия браузера (`browser.version()` воркера) сравнивается с
объявленной по `major.minor.build` — patch-часть плавает между сборками одного chromium и на
растр не влияет. Расхождение значит «образ не соответствует манифесту»: джоба терминализуется
`{"status":"error","error":{"code":"renderer_mismatch"}}`, кадр не создаётся. Аварийный
kill-switch `EASYUI_RENDERER_STRICT_MANIFEST=0` деградирует отказ до предупреждения в
`result.runtimeWarnings` (`renderer_mismatch: …`). Синтетические версии стендов, не разбирающиеся
в версию chromium, сверку не запускают.

**Наблюдённое остаётся наблюдением.** In-page проба окружения (канвас-растр, UA, gamut, DPR)
переименована в `observedCaptureEnvFingerprint` и продолжает ехать в evidence и в метрики гейта
`readiness` — теперь под именем, которое не путается с объявленным рендерером.

**Детерминизм-флаги запуска (волна R2a).** Список флагов растеризации живёт в одном месте —
`scripts/screenshot-worker.mjs` (`BASE_DETERMINISM_ARGS` + `STRICT_DETERMINISM_ARGS`), и **тот же**
массив едет двумя путями: в `launchDeterminismArgsHash` объявленного рендерера и в payload джобы
(`WorkerJob.determinismArgs`), которым воркер запускает chromium. Воркер окружение не читает
вовсе: так «объявленный хеш ≠ фактические args» становится невозможным по конструкции.

| Состояние | Args запуска | Смысл |
|---|---|---|
| `EASYUI_RENDERER_FLAGS` не задан (дефолт образа, прод) | `--force-color-profile=srgb`, `--hide-scrollbars` | явные дубли того, что playwright передаёт сам: флаг попадает в наш хеш и перестаёт зависеть от версии playwright; пиксели не меняются |
| `EASYUI_RENDERER_FLAGS=1` (dev/CI; прод — по чек-листу [деплоя](#deployment)) | те же + `--disable-font-subpixel-positioning`, `--disable-lcd-text`, `--disable-partial-raster`, `--disable-skia-runtime-opts`, `--font-render-hinting=none` | снимает зависимость растра от SIMD-путей Skia, хинтинга FreeType, субпиксельного origin глифа, LCD-текста и истории инвалидации тайлов |

Включение флага **меняет пиксели** и, значит, `launchDeterminismArgsHash` → renderer fingerprint →
`case_fingerprint`: reuse приёмки честно инвалидируется, а существующие визуальные эталоны
становятся снятыми другим рендерером. Поэтому dev/CI держат флаг включённым (`playwright.config.ts`,
команда `webServer` — прецедент `EASYUI_SURFACES`/`EASYUI_ACCEPTANCE_MATRIX`), а прод — выключенным
до массового переснятия эталонов.

`--font-render-hinting=none` (как и `--deterministic-mode`) существует **только** в
`chrome-headless-shell`; полный `chrome` такой switch молча игнорирует. Поэтому
`server/screenshot-worker.test.ts` статически проверяет, что имя каждого детерминизм-switch'а
присутствует в фактически запускаемом бинаре: смена channel/headless обязана красить тест, а не
тихо ронять детерминизм растра.

`contextOptionsHash` считается из экспортируемой константы воркера `CAPTURE_CONTEXT_OPTIONS`
(`locale`, `timezoneId`, `reducedMotion`) — из кода, а не из манифеста образа: контекст задаёт
репозиторий, и его дрейф обязан менять отпечаток без пересборки. Пер-джобные `viewport`/`dsf`/
`colorScheme` в хеш не входят — это параметры кадра, а не рендерера.

**Пин и drift-чек.** `server/capture/rendererPin.json` фиксирует `rendererVersion`, точные версии
`playwright` и `@playwright/test`, revision/версию `chromium` и `chromium-headless-shell` и digest
базового образа. `npm run verify:renderer` (часть `npm run verify`) падает, если фактический
`browsers.json`, package.json-пины, единственность `playwright-core` в lockfile или база
`Dockerfile` разъехались с пином: апгрейд chromium обязан быть явным PR'ом, а не побочным
эффектом `npm install`.

### Корпус рендерера (волна R2b, план 2026-08-03 renderer-contract-2)

Корпус — исполняемая проверка метрики **K1**: «повторные capture одного входа дают
`exact-rgba = 0`». Он живёт вне обычного e2e, потому что меряет не продукт, а **рендерер**:
`e2e/fixtures/renderer-corpus/` (12 фикстур) + `scripts/renderer-corpus.mjs` (harness) +
`expected.json` (эталонные ожидания). PNG в git не кладутся — только исходники фикстур и хеши.

| Команда | Что делает |
|---|---|
| `npm run corpus:verify` | полная матрица 12×20 = **240 капчуров**, сверка с `expected.json`; ненулевой код при первом расхождении |
| `npm run corpus:verify -- --truncated` | усечённая матрица PR-CI: 12×3 (варианты с `"truncated": true` в `corpus.json`) |
| `npm run corpus:verify -- --repeat 2 --report` | два прохода подряд в одном процессе (прямая метрика K1) + тайминги по фикстурам |
| `npm run corpus:record` | перезапись `expected.json` (см. инвариант ниже) |

**Два подмножества.** `pixel/` (9 фикстур) сверяется по **sha256 PNG**: текст YS Text 400/500
(кириллица, цифры, валюта), тот же текст на целых и дробных координатах, badge со скруглениями,
inline-SVG и SVG-ассет, растровый ассет в четырёх режимах масштабирования, opacity/тени/градиенты,
flex/grid на дробных ширинах, волосяные линии, шрифт из темы ДС. `outcome/` (3 фикстуры)
сверяется по **исходу** капчура: отсутствующий шрифтовой ассет, битое изображение, поздняя
мутация layout. До R3/R4 все три проходят старым untyped-путём (капчур завершается `done` без
типизированного кода) — это записано в `expected.json` намеренно; типизированные коды
`font_face_missing` / `image_load_failed` / `layout_unstable` и новые ожидания приносит R4.

**Матрица вариантов** — 20 комбинаций `theme × dsf × viewport`: light/dark × DPR 1/2/3 ×
вьюпорты 390×844, 391×845, 360×640 (+412×915 на DPR 2). Нечётная ширина и `vw`-раскладка части
фикстур дают дробные device-пиксели — именно там субпиксельное позиционирование и partial-raster
перестают быть детерминированными.

**Как устроен harness.** Канон — `scripts/measure-acceptance.mjs`: скрипт сам поднимает Bun
preview (`SERVE_DIST=dist`, изолированный `DATA_DIR` внутри корня проекта), логинится
bootstrap-админом, заливает ассеты фикстур, публикует ДС `renderer-corpus` с темой (два face'а
семейства `Corpus Text` — байты YS Text Regular/Medium), публикует 12 компонентов, снимает
матрицу через `POST /api/components/:id/versions/1/screenshot` и хеширует **скачанные байты**
PNG. Детерминизм-флаги включаются явно (`EASYUI_RENDERER_FLAGS=1`): прод-дефолт образа — OFF,
и без явного включения гейт мерил бы не ту конфигурацию рендерера.

**Инвариант эталонов (§6 плана).** sha-часть `expected.json` меняется **только** вместе с
bump'ом `RENDERER_VERSION`: `--record` отказывается переписать расходящийся sha при неизменной
версии рендерера (обойти — осознанным `--force`), а `--verify` отказывается сверять эталоны,
записанные для другой версии. Флакующая фикстура помечается в `quarantined` файла `expected.json`
(поддерживается и по `id` фикстуры, и по `fixture/variant`).

## Visual regression

Встроенный визуальный gate: reference-baseline (PNG-ассет) закрепляется за **канонической поверхностью** (fingerprint), а candidate снимается тем же screenshot job-пайплайном (параметры капчера берутся **из fingerprint**) и сравнивается в отдельном node-подпроцессе (`scripts/visual-diff-worker.mjs`, `pixelmatch` + `pngjs`). UI — `/visual`.

| Метод и путь | Тело / ответ |
|---|---|
| `PUT /visual-baselines/prototypes/:id` | Атомарная замена полного baseline-set: `{rev,prototypeInstanceId,baseGeneration,members:[{screenId,viewport,deviceScaleFactor,theme,assetId}],receipts?}` → `{generation,rev,members:[{…,referenceId}]}`. `receipts` — необязательная карта `assetId → receiptSha256` (R6, массовая пересъёмка). |
| `GET /visual-baselines/prototypes/:id` | Последний set: `{generation,rev,prototypeInstanceId,createdAt,members:[{screenId,viewport,deviceScaleFactor,theme,referenceId}]}` |
| `PUT /visual-references` | `{fingerprint, assetId, note?, receiptSha256?}` → `200 reference`; upsert по канону fingerprint. Ассет обязан существовать и быть `image/png` (иначе `422`). `receiptSha256` — необязательный адрес receipt'а кадра (R6, массовая пересъёмка); рендерер эталона сервер резолвит сам. |
| `GET /visual-references?scope=&prototypeId=&componentId=` | `{references:[reference]}` — каждая с `lastRun`. |
| `GET /visual-references/:id` | `reference` + `runs:[report]` (полная история). |
| `DELETE /visual-references/:id` | `204`; soft-delete активного reference без удаления runs. Повторный DELETE → `404 reference_not_found`. |
| `POST /visual-references/:id/check` | `{threshold?,rev?,version?}` → `202 {runId, jobId?}`. Капчер кандидата + diff-run. `jobId` отсутствует при `reference_missing`. |
| `GET /visual-runs/:runId` | `running`-плейсхолдер `{runId, referenceId, status:"running", jobId}` **или** терминальный evidence-отчёт. |
| `GET /visual-runs/:runId/bundle.zip` | Diagnostic bundle терминального рана (ZIP, R7b): оба кадра, три производные картинки, оба receipt'а, `report.json` и `SHA256SUMS`. Бегущий ран → `409 bundle_not_ready`. |

### Baseline-sets

Baseline прототипа — журнал поколений, а не набор независимо мутируемых references. Каждый PUT с корректным CAS создаёт `generation = previous+1` и атомарно заменяет весь membership; GET возвращает последнее committed-поколение. В v1 у прототипа ровно **одна активная конфигурация**: смена theme/viewport/dsf заменяет предыдущую, независимых профилей нет. `members` обязаны покрывать каждый экран выбранной ревизии ровно один раз, то есть на экран приходится одна surface-конфигурация. Старые references tombstone'ятся, но их runs и evidence сохраняются.

CAS двухмерный: `prototypeInstanceId` защищает от delete/recreate того же slug, `baseGeneration` — от параллельного rebaseline (`null` допустим только до первого поколения). Клиент сначала читает `prototypeInstanceId` из draft/meta и текущий generation из baseline GET, затем передаёт оба в PUT. Generic `PUT /visual-references` и `DELETE /visual-references/:id` для reference из последнего committed set запрещены с `409 baseline_managed`; менять управляемые references можно только заменой полного set.

Матрица baseline API:

| Операция | Статус и code |
|---|---|
| PUT, прототип/ревизия отсутствует | `404 prototype_not_found` / `404 revision_not_found` |
| GET, прототип/set отсутствует | `404 prototype_not_found` / `404 baseline_not_found` |
| stale instance/generation или конкурентный commit | `409 instance_conflict` / `409 generation_conflict` (`currentGeneration` при известном текущем поколении) |
| неполный, лишний или дублирующий membership | `422 incomplete_baseline` |
| размеры вне `64..2000 × 64..4000`, dsf не 1/2/3 или более 20 Mpx с учётом dsf² | `422 invalid_viewport` |
| asset отсутствует / не PNG | `422 asset_not_found` / `422 invalid_reference_asset` |
| неверная строгая форма тела | `422 validation_failed` |

Транзакционный abort не оставляет частичного поколения или активного membership. Однако PNG уже загружаются в content-addressed registry до PUT: сбой capture, browser errors, гонка CAS или иной abort оставляют orphan PNG без baseline-пина; автоматического GC сейчас нет.

**Fingerprint** (`server/visual/fingerprint.ts`). Канонический JSON поверхности; ключи детерминированно сортируются, `undefined`-опционалы отбрасываются, так что семантически равные fingerprint'ы хэшируются одинаково. `fingerprint_json` — UNIQUE-колонка; `id = "vref_" + sha256(fingerprint_json)`. Поля:
- `scope: "prototype-screen"` → `{prototypeId, prototypeInstanceId?, screenId, refRevision}`; `scope: "component"` → `{componentId, refVersion}`;
- общие: `viewport{width,height}`, `deviceScaleFactor ∈ {1,2,3}`, `theme ∈ {light,dark}`, опциональные `propsHash?`, `stateHash?`.

**Check target.** В теле check `rev` разрешён только для `prototype-screen`, `version` — только для `component`; без override используется `refRevision`/`refVersion`. Неверная комбинация и любой check fingerprint'а с `propsHash` или `stateHash` дают `422 invalid_candidate_target`: воспроизводимого capture-рецепта для hash-bearing surfaces нет. Остальные ошибки: `404 reference_not_found|prototype_not_found|screen_not_found|revision_not_found|version_not_found`, `409 instance_conflict`, `422 invalid_threshold|invalid_viewport`, `429 queue_full`, `501 screenshot_unavailable`.

`candidateMeta` — discriminated union по `kind:"prototype"|"component"` и `outcome:"captured"|"capture_failed"`. Общая часть: `{requestedTarget:{rev|version},resolvedTarget:{rev|version},expected,browser:{browserVersion,rendererBuild,consoleErrors,pageErrors}|null,error?}`; `browser:null` означает сбой до получения browser evidence. Для совместимости сохраняются top-level aliases: у прототипа `rev`, `pins?`, `rendererBuild?`, `browserVersion?`; у компонента `version`, `bundleHash?`, `rendererBuild?`, `browserVersion?`.

**Метрики (честно).** За один прогон считаются **обе**: `exact-rgba` (полное попиксельное равенство RGBA, `diffPixels/totalPixels`) и `pixelmatch-v1` (все options — `threshold`, `includeAA` — в `metric_options_json`). Никакого «AE». Первичная метрика прогона (колонки `metric`/`diff_pixels`/`total_pixels`/`diff_percent`) — `pixelmatch-v1`; `exact-rgba` кладётся в `candidate_meta_json.exactRgba`; отчёт отдаёт обе под `metrics`. `pass` при `pixelmatch diffPercent ≤ threshold` (по умолчанию 0), иначе `fail`.

**Статусы прогона** (`visual_runs.status`): `pass | fail | error | reference_missing`. В публичном отчёте legacy-строка с `reference_asset_id=NULL` всегда нормализуется в `status:"reference_unknown"`, даже если до v11 в колонке был записан `pass`/`fail`: результат нельзя считать доказанным без точного baseline. **Несовпадение размеров** reference/candidate → `error` **без процента** (dimensions обоих всё равно в отчёте). Ошибка капчера/diff-воркера → `error`.

**Evidence guard (обязательный).** Процент не выдаётся без **обоих** физических файлов. Отчёт прогона ВСЕГДА содержит: `referenceStatus:"known"|"unknown"`, `reference`/`candidate` = `{assetId, url, sha256, width, height, mime}` (sha256 и dimensions берутся из content-addressed реестра ассетов), `diffPixels` (числитель), `totalPixels` (знаменатель), `metric` + `metricOptions`, `metrics.{exact-rgba,pixelmatch-v1}`, `diff` (сгенерированное diff-изображение как ассет) и `candidateMeta` (`rev`/`version`, `pins`, `bundleHash?`, `rendererBuild`, `browserVersion` из результата капчера). У legacy-прогонов до v11 `reference_asset_id=NULL`, поэтому они честно отдаются как `status:"reference_unknown"`, `referenceStatus:"unknown"`, `reference:null`; comparison-поля (`metric`, options, numerator/denominator, percent, metrics, diff) подавляются, потому что без доказанного baseline их нельзя интерпретировать. Текущий baseline им задним числом не приписывается. Если точный reference-ассет нового прогона известен, но его физические байты отсутствуют: `status:"reference_missing"`, `diffPercent:null`, кандидат **не** снимается.

**Хранение и retention.** В v11: `visual_references(id, fingerprint_json UNIQUE, asset_id FK→assets RESTRICT, note, created_at, deleted_at NULL)`, `visual_runs(id, reference_id FK→visual_references RESTRICT, reference_asset_id FK→assets RESTRICT NULL, candidate_asset_id FK→assets RESTRICT NULL, diff_asset_id FK→assets RESTRICT NULL, metric, metric_options_json, diff_pixels, total_pixels, diff_percent, status, candidate_meta_json, created_at)`. Каждый новый run пинует точный baseline в `reference_asset_id`; legacy-строки мигрируют с `NULL`. `lastRun` активного reference выбирается только среди runs с `reference_asset_id == visual_references.asset_id`: после замены baseline старый `pass` не верифицирует новый asset. `DELETE` выставляет `deleted_at`: reference исчезает из list/GET/check, но строка, runs и все evidence-ассеты сохраняются. `GET /visual-runs/:runId` продолжает отдавать сохранённый отчёт после удаления reference. Повторный `PUT` того же fingerprint оживляет tombstone и обновляет только активный baseline, не исторические runs. В v1 автоматического TTL/prune и публичного hard-delete для терминальных runs/tombstone нет — они хранятся бессрочно и входят в backup; будущая административная retention-политика должна удалять их явно и согласованно с asset FK. `POST check` держит только незавершённый прогон в памяти. Проверка требует screenshot-пайплайн (`SERVE_DIST` + chromium), иначе `501 screenshot_unavailable`.

## Library-фильтры

`/library` строит статус каждого custom-компонента чистыми функциями (`src/library/libraryModel.ts`); сетевые вызовы выполняются **лениво после манифеста** (по `GET /components/:id` за версиями/`figma` и `GET /visual-references?scope=component` за прогонами). Маппинг статусов зафиксирован и однозначен:

| Чип | Условие |
|---|---|
| `Published` | есть хотя бы одна `active`-версия |
| `Rejected` | **последняя** (макс. номер) версия — `rejected` |
| `Blocked` | последняя версия — `deprecated` \| `superseded` \| `archived` |
| `Verified` | `Published` **и** последний visual-run reference'а этой active-версии (`fingerprint {scope:"component", componentId, refVersion}`) = `pass` |
| `Visual pending` | `Published` и **не** `Verified` |
| `Accepted` | `Published` **и** у активной версии непустой `acceptanceRunId` |

`Accepted` — **независимый** от `Verified` признак (RFC candidate-acceptance §7): `Verified` говорит о визуальных эталонах, `Accepted` — о том, что версию опубликовал `promote` с терминальным (pass) acceptance-раном. Один не подменяет и не переопределяет другой; `Accepted` **не** входит в проекцию `catalogRevision` — иначе любой acceptance-run глобально сдвигал бы хэш каталога. Тот же признак отдаёт read-model: `status.accepted` в `GET /catalog/library`, а сами ссылки — `candidateId`/`acceptanceRunId` в `GET /components/:id/versions`. Пока promote с кандидатом не вошёл в практику, признак пуст у всего каталога — это ожидаемое состояние, а не пробел в данных: чип-фильтр в таком каталоге просто не показывается (фильтр предлагается, только когда он сужает список), бейджей на карточках нет, а на странице компонента блок «Приёмка» объясняет отсутствие ссылок. Read-only срез покрытия — колонка `acceptance` в `node driver.mjs audit --versions`.

`Rejected`/`Blocked` описывают **последнюю** версию, даже если более старая `active`-версия сохраняет компонент в манифесте — поэтому manifest-запись может читаться как blocked/rejected. Фильтры-чипы объединяются по OR; пока статус компонента не загружен, он не скрывается. Живое превью карточки показывает чип `default` для legacy `example` (`?props=example`) и сортированные чипы `examples` (`?example=<name>`); без обоих остаётся meta-карточка. Figma-бейдж на карточке/в списке — при `figma` на head-ревизии (тултип `fileKey` + число `nodeIds`).

## Ошибки и ограничения HTTP

Единый envelope:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Prototype document is invalid",
    "issues": [],
    "warnings": [],
    "currentRev": 2,
    "currentVersion": 1
  }
}
```

Опциональные поля присутствуют только когда применимы. Типичные статусы: 400 — неверный JSON/DTO или отсутствующий `baseRev`; 404 — ресурс; 405 — метод; 409 — CAS-конфликт, дубликат либо повторный publish ревизии; 413 — лимит; 415 — не `application/json`; 422 — семантическая валидация (включая `event_schema_not_serializable` — типизированный event-payload не сериализуется в JSON Schema); 429 — очередь занята; 501 — возможность недоступна в этом окружении. JSON body ограничен 1 MiB, source компонента — 256 KiB.

Каждый элемент `issues[]` имеет `{path,message,pointer?,code?}`. Опциональный `code` — стабильный машинный код правила (его наполнение layout-линтами начинается в W3). `pointer` — корректный RFC 6901 JSON Pointer с escape `~0`/`~1` (легаси-поле `path` сохраняется как есть) и добавляется централизованно в `errorResponse`: для массивных `path` каждый сегмент экранируется, строковые pointer-подобные `path` проходят без изменений.

## Discovery

Машиночитаемое самоописание API:

- `GET /api/openapi.json` — OpenAPI 3.1-документ. Отдаётся закоммиченный артефакт `server/openapi.json`, сгенерированный из реестра контрактов `server/contracts.ts` командой `npm run generate:openapi`. Дрифт ловится в `npm run verify` (`verify:openapi`) и contract-тестом. Операции несут расширение `x-easyui-validated`: `true` — handler валидирует вход по схемам контракта (`parseWith`/`parseQuery`), `false` — контракт документационный, handler валидирует вход самостоятельно.
- `GET /api/schemas/prototype-document.json` — JSON Schema (draft 2020-12) формата документа прототипа, производная от **авторской (input) ветки** схемы (`inputPrototypeDocSchema`), а не от tolerant-ветки для уже сохранённых ревизий: агент видит строгую грамматику, включая `computed` (record с `propertyNames.pattern` и `oneOf` из четырёх op-вариантов). Директивы props (`$state`, `$bindState`, `$template`, `$cond`, `$asset`) и param sources событий (`$event`, `$elementId`, `$itemIndex`, `$itemKey`) описаны в `$defs` как `anyOf` с `$comment` — их семантика enforce'ится валидатором `src/prototype/validate.ts`, а не самой схемой.
- `GET /api/schemas/component-definition.json` — JSON Schema контракта `definition` кастомного компонента (props/events/slots/capabilities/description/example/examples/atomicLevel, architecture metadata `scope`/`allowedAsRoot`/`canonicalFor`/`sourceBounded`/`ownership`/`replacement` и прочая metadata).
- `GET /api/capabilities` — фичи и лимиты инстанса:

```json
{
  "apiVersion": 1,
  "documentVersion": 1,
  "layoutContractVersion": 1,
  "actions": ["navigate", "back", "openUrl", "restart", "setState", "pushState", "removeState"],
  "directives": ["$state", "$bindState", "$template", "$cond", "$asset"],
  "paramSources": ["$event", "$elementId", "$itemIndex", "$itemKey"],
  "conditions": ["$and", "$or", "$state", "$item", "$index", "eq", "neq", "gt", "gte", "lt", "lte", "not"],
  "computedOps": ["count", "sum", "sumProduct", "add"],
  "limits": { "elements": 500, "depth": 50, "bodyMiB": 1, "sourceKiB": 256, "assetMiB": 5, "repeatBudget": 2000, "repeatPerScreen": 20, "screenshotQueue": 5, "geometryRects": 2000, "flows": 24, "flowSteps": 50, "flowTotalSteps": 320, "flowDepth": 4, "compositionDepth": 5,
    "computedEntries": 20, "computedFields": 4, "computedTerms": 8, "surfaces": 2,
    "acceptanceMaxCasesPerRun": 64, "acceptanceMaxJobsPerRun": 128, "acceptanceCaseTtlHours": 336, "evidenceMaxBytes": 268435456,
    "validateUserConcurrent": 1, "validateGlobalConcurrent": 2, "validateCacheTtlHours": 24, "validateCacheMiB": 32 },
  "designSystems": ["shadcn", "wireframe", "..."],
  "resolvedSpaceScales": { "shadcn": { "none": "0px", "xs": "4px", "sm": "8px", "md": "12px", "lg": "16px", "xl": "24px", "2xl": "32px", "3xl": "48px", "4xl": "64px" } },
  "regions": ["statusBar", "header", "footer"],
  "features": { "renderStatus": true, "screenshots": true, "visualRegression": true, "assets": true, "typedEvents": true, "repeat": true, "namedSlots": true, "themeVersions": true, "layoutContract": true, "flows": true, "computed": true, "screenRegions": true, "bundleExport": true, "bundleImport": true, "componentReuseGate": true, "compositionV2": true, "catalogMigration": true,
    "componentValidate": true, "componentGeometry": true, "componentDraftPreview": true, "prototypeHeadTracking": true, "readinessProfile": true, "themeDryRun": true, "themeSparseOps": true, "themeSpacingResolverV2": true,
    "surfaces": true, "surfacesWrite": false,
    "acceptanceMatrix": false, "acceptanceCandidates": false, "acceptanceRuns": false },
  "acceptance": { "policyProfiles": ["default-v1", "pixel-strict-v1"], "defaultPolicyProfile": "default-v1", "promotionPolicyProfiles": ["default-v1", "pixel-strict-v1"] },
  "renderer": { "rendererSchema": 2, "rendererVersion": "r2", "fingerprint": "<sha256>", "policyHash": "<sha256 дефолтной readiness-политики>",
    "os": "linux", "arch": "x64", "nodeVersion": "24.x.y", "playwrightVersion": "1.61.1",
    "browserName": "chromium", "browserVersion": "149.0.7827.55", "browserRevision": "1228",
    "launchedExecutable": "chrome-headless-shell", "browserExecutableSha256": "<sha256>",
    "fontStackSha256": "<sha256>", "appFontsSha256": "<sha256>", "systemLibsHash": "<sha256>",
    "launchDeterminismArgsHash": "<sha256>", "contextOptionsHash": null, "colorProfile": "srgb",
    "source": "manifest", "provenance": { "buildSha": "…", "imageRef": "ghcr.io/…", "builtAt": "…", "bunVersion": "1.3.14" } },
  "reuseGate": { "mode": "shadow", "intentRequired": false, "policyVersion": 1 }
}
```

`acceptance` разводит два разных множества политик приёмки: `policyProfiles` — что примет `POST /acceptance-runs` в `policy` (иначе `422 unknown_policy_profile`), `promotionPolicyProfiles` — под каким профилем полученный вердикт [допускает публикацию](#promotion-policy-какой-ран-допускает-публикацию-волна-w3-план-2026-08-04) (иначе `422 acceptance_policy_mismatch`). Сегодня множества совпадают; различать их обязан клиент, а не догадка — пересечение задано конфигурацией сервера, а не инвариантом кода.

`reuseGate` описывает фазу [reuse-гейта](#reuse-gate-при-создании-и-публикации-компонента) этого инстанса: `mode` — `shadow` либо `enforce`, `intentRequired` истинно ровно в `enforce`, `policyVersion` — версия политики матчинга, та же, что в ответах `/api/catalog/candidates` и в записях аудита. Значение приходит из `REUSE_GATE`, прочитанной один раз на входе процесса, — повторного чтения окружения на запросе нет, поэтому discovery и сам гейт не могут разойтись.

`renderer` — объявленный рендерер этой сборки (см. [Renderer fingerprint 2.0](#renderer-fingerprint-20-волна-r1-план-2026-08-03-renderer-contract-2)): агент сверяет `fingerprint` с `result.renderer.fingerprint` снятой джобы, а деплой — с `renderer-manifest.json` образа. `source: "fallback"` означает рабочее дерево без манифеста: часть полей `null`, отпечаток стабилен внутри процесса, но между хостами не сравним.

`designSystems` читается из живого реестра БД; `resolvedSpaceScales` резолвится для каждой системы из её последней merged-темы с canonical fallback. Значения `limits` импортируются из модулей, где они реально enforce'ятся (`src/prototype/schema.ts`, `src/prototype/validate.ts`, `server/assets/validate.ts`, `server/screenshot/service.ts`, `server/http.ts`), — двойного хардкода нет.

Флаги волны итеративного авторинга описывают возможности, которых на старом образе просто нет, поэтому клиент обязан читать их **до** вызова, а не выяснять по 404:

| Флаг | Что означает | Как гаснет |
|---|---|---|
| `componentValidate` | доступен [`POST /components/:id/validate`](#validate-префлайт-публикации) | `EASYUI_VALIDATE_DISABLED=1` → `false` и `404` на ручке |
| `acceptancePromote` | доступен [`POST /components/:id/promote`](#promote-приёмка-провалидированной-головы) | `EASYUI_ACCEPTANCE_DISABLED=1` → `false` и `404` на ручке; publish продолжает работать |
| `componentDraftPreview` | доступна [съёмка head-ревизии](#draft-preview-head-ревизии-компонента) `POST /components/:id/head/screenshot` | тот же kill-switch: постановка джобы собирает candidate-bundle |
| `componentGeometry` | `probe: "geometry"` принимают обе компонентные ручки, результат — [`surface: "component"`](#скриншоты) | — |
| `prototypeHeadTracking` | lifecycle-роут принимает [`track: "head"`](#head-tracking-служебных-прототипов) | — |
| `readinessProfile` | readiness-отчёт несёт [`profile`](#готовность-к-публикации) | — |
| `themeDryRun` | PATCH темы умеет `dryRun` и no-op-детекцию | — |
| `themeSparseOps` | PATCH темы умеет `addTokens`/`addFonts`/`addIcons` | — |
| `themeSpacingResolverV2` | новые версии темы пишутся [резолвером 2](#тема-дизайн-системы-tokensfontsicons-и-версии) | `EASYUI_THEME_RESOLVER_V2_DISABLED=1` → `false`, новые версии остаются на резолвере 1 |
| `surfaces` | образ понимает [мульти-поверхностные документы](#мульти-поверхностные-документы-docsurfaces) (`doc.surfaces`) на чтении и рендере | — |
| `surfacesWrite` | разрешено **сохранять** документы с `doc.surfaces`; иначе `422 surfaces_disabled` | без переменной `false`; включает `EASYUI_SURFACES=1` (прод-compose задаёт дефолт `1` с f5eaa65) |
| `acceptanceMatrix` | доступна [матричная приёмка](#acceptance-кандидаты-и-матричные-раны) целиком, включая ссылки `candidateId`/`acceptanceRunId` в promote | без `EASYUI_ACCEPTANCE_MATRIX=1` — `false`, все ручки набора `404`, promote со ссылками — `422 acceptance_matrix_disabled` |
| `acceptanceCandidates` | доступны `POST /components/:id/candidates` и `GET /component-candidates/:id` | тот же флаг |
| `acceptanceRuns` | доступны `/acceptance-runs*` (постановка, poll, cases, evidence, cancel) | тот же флаг |
| `acceptanceMultiRunPromote` | promote принимает `acceptanceRunIds[]` — [набор ранов шардированной семьи](#multi-run-promote-шардированная-семья-волна-w7-план-2026-08-04) | тот же флаг; сборка до W7 отвечает на массив `400 invalid_request` |
| `acceptanceSummaryView` | `GET /acceptance-runs/:runId?view=summary` — [компактная сводка рана](#компактная-сводка-рана-и-квитанция-reuse-волна-w8-план-2026-08-04) | тот же флаг; сборка до W8 **молча** игнорирует query и отдаёт полный ран, поэтому клиент дополнительно проверяет маркер `view` в теле |

`EASYUI_SURFACES` — единственный switch с **обратной** полярностью: пустое значение означает «запись выключена» (`surfacesWrite: false`), а не «разрешено». Он читается на запросе, поэтому discovery и поведение ручки совпадают по определению. Остальные kill-switch'и (`EASYUI_VALIDATE_DISABLED`, `EASYUI_ACCEPTANCE_DISABLED`, `EASYUI_ACCEPTANCE_MATRIX`, `EASYUI_THEME_RESOLVER_V2_DISABLED`), как и `REUSE_GATE`, читаются один раз на входе процесса, поэтому discovery и поведение ручек не могут разойтись. Флаг `false` означает «выключено на этом инстансе», а отсутствие ключа — «образ старше этой волны»; клиент обязан различать эти случаи. Лимиты `validateUserConcurrent`/`validateGlobalConcurrent` описывают, когда прилетит `429 validate_in_flight`/`429 queue_full`, а `validateCacheTtlHours`/`validateCacheMiB` — срок жизни и потолок candidate-кэша (после вытеснения следующий draft-preview просто пересоберёт кандидата).

`features.compositionV2` — инстанс принимает документы композиций версии 2 (вложенность, `atomicLevel`); `features.catalogMigration` — доступны админские эндпоинты аудита и миграции каталога. `limits.compositionDepth` — максимальная глубина вложенности композиций, **внешняя композиция считается уровнем 1** (см. [формат](prototype-format.md#composition-document-v2)).

`limits.flowDepth` — максимальная глубина дерева сценариев (`flow.parentId`), и **корень считается уровнем 1**: при `flowDepth: 4` законна цепочка «корень → ребёнок → внук → правнук», а пятый уровень отвергается входной схемой. Правила иерархии описаны в `docs/prototype-format.md#scenario-tree-flowparentid`; они исполняются только на записи — сохранённые ревизии парсятся без авторских правил и лимитов, чтобы откат образа читал документы без потерь.

**Правило**: каждый новый endpoint обязан регистрироваться в `server/contracts.ts` (`registerContract`) — contract-тест `server/contract.test.ts` требует покрытия каждого контракта, а drift-check заставит перегенерировать `server/openapi.json`.

**Известное ограничение генератора OpenAPI:** numeric path-параметры (`rev`, `version` и подобные) публикуются в схеме как строки, хотя handler преобразует и проверяет их как положительные целые. Это ограничение артефакта генерации, а не runtime API.

## Контракт кастомного компонента

Модуль TSX экспортирует named `definition` и default plain function component. `definition.props` — Zod-схема; допустимы `events`, `slots?: string[]`, `capabilities?`, обязательный `description: string`, legacy `example?: Record<string, unknown>`, именованные `examples?: Record<string, Record<string, unknown>>`, `atomicLevel?: "atom" | "molecule" | "organism" | "template" | "page"`, `layoutNeutral?: boolean` и `layout?` контракта v1. `DefinitionMeta`, сохранённый для published-версии, содержит нормализованные `events`, `slots`, `description` и опциональные `eventPayloads`, `capabilities`, `example`, `examples`, input-`propsJsonSchema`, `atomicLevel`, `layoutNeutral`, `layout`; те же метаданные входят в version DTO и manifest. У custom-компонента уровень опционален для ABI v1 backward compatibility, но publish без него возвращает warning `Atomic design level is not provided; component will be classified as Other` и Library классифицирует компонент как `Other`. Default получает `BaseComponentProps` — объект `{props, emit}`. `memo` и `forwardRef` не поддерживаются.

#### Architecture metadata

Аддитивный набор полей definition (волна 2 плана 2026-07-27), полностью опциональный: `scope?: "primitive" | "section" | "shell" | "screen"` (какой частью экрана компонент владеет), `allowedAsRoot?: boolean`, `canonicalFor?: string[]` (до 12 slug'ов продуктовых ролей), `sourceBounded?: boolean`, `ownership?: {reason: string; provenance?: string}` (≤500 символов на поле), `replacement?: string` (имя компонента-замены, ≤64 символа). Значения проходят те же strict-схемы, что и остальная metadata (дочерний процесс extract, `metaSchema`, `definition_meta` контракта), сохраняются в `DefinitionMeta` и отдаются в version DTO, `/catalog/manifest` и `GET /api/schemas/component-definition.json`. `canonicalFor` сортируется при сериализации.

Publish добавляет **только warnings** (никогда не блокирует): `scope: "screen"|"shell"` без `ownership.reason`; `replacement`, указывающий на компонент, которого нет в той же дизайн-системе; и — **только при `sourceBounded: true`** — скан исходника на screen-геометрию (`h-screen`, `min-h-screen`, `100vh`, `100dvh`, `fixed inset-0`). Канонические каркасы (`yp-screen`, `yp-panel`, `yp-app-home-shell`, `yp-scroll-area`) законно несут такую геометрию и не объявляют `sourceBounded`, поэтому молчат. Архитектурные правила прототипа, читающие эти поля, описаны в `docs/prototype-format.md#architecture-warnings`; проставить `scope` по каталогу помогает `scripts/backfill-component-scope.ts` (по умолчанию dry-run, запись — только с `--apply`).

#### Named examples

Имена в `definition.examples` — slug'и `^[a-z0-9]+(?:-[a-z0-9]+)*$` длиной 1–32; имя `default` зарезервировано, максимум 8 наборов. Каждый набор обязан быть plain-JSON объектом с конечными числами, без циклов, функций, BigInt, sparse/custom arrays и ключей с префиксом `$` или `__eui` на любой глубине. Лимит канонического JSON — 16 KiB на набор и 64 KiB на всю карту компонента.

Каждый набор проверяется `definition.props.parse`, но сохраняется и публикуется именно исходный **input**, а не результат Zod transform/default; ключи examples сортируются. Legacy `definition.example` остаётся отдельным полем и также должен проходить props-схему. Named examples не повышают `hostAbiVersion`; каждый из них участвует в advisory SSR smoke.

#### Typed event payloads (`events` + `capabilities`)

`events` может быть legacy-списком `string[]` (payloadless) **или** `Record<name, ZodSchema>` — типизированный payload на событие. Нормализация всегда сохраняет наружу `events: string[]`; для типизированных событий дополнительно строится additive `eventPayloads: Record<name, JSONSchema>`. На publish сериализация **fail-closed**: если хотя бы одна event-схема не конвертируется `z.toJSONSchema` в детерминированную JSON-safe схему (например, transform/preprocess/custom), publish возвращает `422 event_schema_not_serializable`. Типизированные события доставляются собственным event-адаптером (только custom-компоненты) и потребляются через param sources (`$event`) и `$if` в биндингах действий (см. `docs/prototype-format.md`).

`definition.capabilities?: { typedEvents?: true; namedSlots?: true }` объявляет расширенные возможности; наличие любой capability требует host **ABI v2**.

#### Named slots (`capabilities.namedSlots` + `slots`)

Компонент с `capabilities.namedSlots: true` объявляет допустимые регионы в `definition.slots: string[]` (slug-имена). Хост раскладывает детей элемента по слотам и передаёт компоненту `slots: Record<name, ReactNode>` в `EasyUIComponentProps`: ребёнок с `slot: "<name>"` в документе попадает в `slots[name]`, ребёнок без `slot` — в `slots.default`, и для named-slot компонента `children === slots.default`. Роутинг выполняется до рендера по позиции ребёнка в `element.children` (side-channel `slotIndices`), без DOM-маркеров. Legacy-компоненты без capability получают прежний `children` без изменений. Документные правила и запреты (`slot` только под namedSlots-родителем и только из объявленного набора; `repeat` на namedSlots-родителе запрещён) — в `docs/prototype-format.md#named-slots`. Пример: `server/fixtures/named-slots-panel.tsx`.

```tsx
import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ title: z.string() }),
  events: [],
  capabilities: { namedSlots: true } as const,
  slots: ["header", "items"],
  description: "A panel that routes children into header and items slots",
  example: { title: "Panel" },
};

type Props = z.output<typeof definition.props>;
export default function Panel({ props, slots }: EasyUIComponentProps<Props>) {
  return (
    <section>
      <h2>{props.title}</h2>
      <header>{slots.header}</header>
      <ul>{slots.items}</ul>
      <div>{slots.default}</div>
    </section>
  );
}
```

#### Host ABI и shims v2

`hostAbiVersion` вычисляется на publish как **максимум требований**: ABI 2, если compiled JS импортирует `easy-ui/runtime` **или** объявлена любая `capabilities` (typedEvents/namedSlots); иначе ABI 1. ABI v2 = ABI v1 + модуль `easy-ui/runtime` (`/api/shims/v2/easy-ui-runtime.js`, экспортирует тип `EasyUIComponentProps`, `token(key)`, `Icon`), и для ABI 2 остальные шимы тоже резолвятся из `/api/shims/v2/*`. Loader поддерживает оба ABI. Тип `easy-ui-runtime.d.ts` подключается в publish-typecheck через `paths`.

```tsx
import { useState } from "react";
import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({ value: z.number().min(0).max(5) }),
  events: ["press"],
  slots: [],
  description: "An interactive five-star rating",
  example: { value: 3 },
  atomicLevel: "atom",
};

type Props = z.output<typeof definition.props>;
export default function RatingStars({ props, emit }: BaseComponentProps<Props>) {
  const [value, setValue] = useState(props.value);
  return <button onClick={() => { setValue(value + 1); emit("press"); }}>{"★".repeat(value)}</button>;
}
```

Канонический полный пример: `server/fixtures/rating-stars.tsx`. Save проверяет синтаксис и контракт в короткоживущем subprocess. Publish дополнительно делает TypeScript-check, сборку, проверку импортов и advisory SSR smoke; SSR-warning не блокирует publish.

### styleContractVersion 1

Гарантированы CSS-переменные темы, inline-стили и классы уже включённого shadcn-набора. Произвольные Tailwind utility-классы не гарантированы, поскольку для пользовательского source отдельный CSS не компилируется. CSS/asset imports отклоняются.

### Shim ABI v1

Bundles могут импортировать только allowlist ниже; сервер переписывает specifier в same-origin immutable shim.

| Исходный specifier | URL bundle |
|---|---|
| `react` | `/api/shims/v1/react.js` |
| `react-dom` | `/api/shims/v1/react-dom.js` |
| `react/jsx-runtime` | `/api/shims/v1/react-jsx-runtime.js` |
| `zod` | `/api/shims/v1/zod.js` |
| `@json-render/react` | `/api/shims/v1/json-render-react.js` |

### Shim ABI v2

ABI v2 — суперсет v1: те же specifiers резолвятся в `/api/shims/v2/*` плюс дополнительный `easy-ui/runtime` → `/api/shims/v2/easy-ui-runtime.js`. Bundle получает ABI v2, если импортирует `easy-ui/runtime` или объявляет `capabilities`. Модуль `easy-ui/runtime` экспортирует тип `EasyUIComponentProps` (= `BaseComponentProps` + `emit(name, payload?)` + `slots`), а также `token(key): string` и `Icon({name,size?,theme?})` (данные темы наполняются отдельной задачей).

## Граница доверия и запуск

По умолчанию сервер слушает `127.0.0.1`. Приложение использует именованные аккаунты и cookie-сессии; bootstrap-администратор задаётся парой `ADMIN_NAME`/`ADMIN_PASSWORD`. `HOST` меняет bind-адрес, а опциональный `LEGACY_BASIC_AUTH=user:pass` добавляет внешний Basic-барьер (с прода снят 2026-07-20; поддержка в коде сохранена). Старый `BASIC_AUTH` — deprecated-алиас. Без Basic проходят health, обмен share-token и запросы в точном share/capture scope; login и статика требуют Basic, если барьер включён. На non-loopback сервер не стартует без существующего администратора или обеих `ADMIN_*` переменных.

Checked-in инструменты (`.claude/skills/author/driver.mjs`, `scripts/w6-yandex-pay.mjs`, gallery perf harness) используют единый env-контракт: `EASYUI_USERNAME` + `EASYUI_PASSWORD` для `POST /api/auth/login` и cookie jar; опциональный `EASYUI_LEGACY_BASIC_AUTH` содержит credentials внешнего Basic-барьера (на проде снят 2026-07-20) и, если задан, отправляется и на login, и на каждый последующий API/SPA-запрос. Инструменты выставляют `Origin` и не переиспользуют Basic credentials как named account.

Код компонента выполняется с правами серверного процесса уже при save во время draft extraction, а при publish также проходит дополнительные стадии исполнения. Загружать следует только код, которому доверяют как коду репозитория. Subprocess и timeout ограничивают сбои extraction, но не являются security sandbox; published-код импортируется сервером и выполняется в браузере. Поэтому для публичного домена authentication обязательна.

Зависимости устанавливает только npm; требуется полный `npm install`, включая TypeScript из devDependencies. Серверный runtime — Bun 1.3.14 из `~/.bun/bin`, версия закреплена `.bun-version`; `~/.bun/bin` должен быть раньше битого `/usr/local/bin/bun` в `PATH`.

`DATA_DIR` обязан находиться внутри корня проекта. Сервер материализует туда TSX-модули, а Bun разрешает их `react`, `zod` и прочие imports через корневой `node_modules`; внешний каталог нарушает это разрешение. Для разработки: `PATH="$HOME/.bun/bin:$PATH" npm run server:dev`. Для собранной SPA: сначала `npm run build`, затем `npm run serve`.

## Deployment

Production разворачивается в Dokploy из корневого `docker-compose.yml` на домене `easy-ui.pay-offline.ru`. Образ **не собирается на прод-сервере**: его строит GitHub Actions (`.github/workflows/build-image.yml`) на каждый push в `main` и публикует в `ghcr.io/vladprrs/easy-ui:{latest,<sha>}` (публичный пакет, анонимный pull); по завершении workflow вызывает `compose.deploy` через Dokploy API (секрет `DOKPLOY_API_KEY`), и Dokploy выполняет только `docker compose pull` + `up` (`pull_policy: always`). Серверная сборка (npm ci + chromium + vite + storybook) трижды роняла хост 2026-07-14 и запрещена; прямой GitHub→Dokploy push-вебхук отключён. Контейнер использует `HOST=0.0.0.0`, `PORT=8787`, `SERVE_DIST=dist`, `DATA_DIR=data`; `PUBLIC_ORIGIN=https://easy-ui.pay-offline.ru` и named admin (`ADMIN_NAME`, `ADMIN_PASSWORD`) задаются только в окружении Dokploy. Внешний Basic-барьер снят с прода 2026-07-20 (`LEGACY_BASIC_AUTH`/`BASIC_AUTH` удалены из env Dokploy); compose по-прежнему пробрасывает оба имени без жёсткого требования, так что барьер можно вернуть, задав переменную заново. `PUBLIC_ORIGIN` содержит только scheme + host + опциональный port, без path/query/credentials. Для любого non-loopback hostname сервер требует HTTPS; явный HTTP разрешён лишь для loopback auth-preview/e2e. Именно этот origin используется в абсолютных share/QR URL и `303 Location`, поэтому он должен совпадать с внешним origin reverse proxy. Named volume `easy-ui-data` монтируется в `/app/data`.

`REUSE_GATE` задаёт фазу reuse gate: допустимы только `shadow` и `enforce`. Compose всегда передаёт `${REUSE_GATE:-shadow}`, поэтому безопасный default — `shadow`; для смены фазы следует изменить `REUSE_GATE` в service environment Dokploy и выполнить отдельный redeploy. Смена фазы допускается только по подписанной записи приёмки: критерии перечислены в [§5.4 плана reuse enforcement](plans/2026-07-31-component-reuse-enforcement.md#5-порядок-деплоя) (принятый отчёт T0 и достаточное качество матчера, плюс наблюдения shadow: не менее двух недель, 20 решений от двух акторов, хотя бы одно `would_block`, разбор каждого `would_block` и отсутствие `intent_missing` среди последних K create). **С 2026-07-31 прод работает в `enforce`** по [решению владельца проекта](audit/2026-07-31-reuse-gate-enforce-decision.md): блок «качество матчера» выполнен, блок «наблюдения shadow» не набран и риск принят явно. Возврат в `shadow` — правка той же переменной и redeploy; критерии отката записаны в решении.

Compose healthcheck обращается без credentials к открытому `GET http://127.0.0.1:8787/api/health` и считает сервис готовым только при HTTP 200 и JSON `status: "ready"`. Для rollback следует указать в compose известный хороший тег `ghcr.io/vladprrs/easy-ui:<sha>` (каждый коммит main тегируется) либо revert+push; миграции forward-only, поэтому перед рискованными изменениями нужен backup volume.

При выкладке поддержки `doc.flows` действует отдельное правило совместимости: в течение rollback-window нельзя персистить **ни одной** ревизии с `flows` — ни через create, ни через save, ни через restore. Старый образ не умеет читать такой документ, поэтому наличие flows-ревизии делает безопасный rollback образа невозможным. После окончания окна откат на образ без поддержки `flows` выполняется только вместе с откатом данных на совместимый backup.

Для screen regions действует та же rollback-политика. Перед деплоем обязателен проверенный логический бэкап данных, совместимый со старым образом; его сохраняют на весь rollback-window. Несовместимость возникает в двух независимых случаях: строгая схема старого сервера не распарсит документ с полем элемента `region`, а документ с `@eui/FlowRoot` старый runtime не сможет отрендерить, поскольку у него нет ни host-рендерера, ни component pin для этого типа. Поэтому в течение rollback-window нельзя персистить через create, save или restore ни одной ревизии, содержащей `region` или `@eui/FlowRoot`. После первой такой записи откат на образ без screen regions допустим только вместе с восстановлением совместимого бэкапа.

Мульти-поверхностные документы (`doc.surfaces`, миграция v24) подчиняются той же rollback-политике. **С релиза f5eaa65 (2026-08-03) запись surfaces на проде включена по умолчанию** (compose-дефолт `${EASYUI_SURFACES:-1}`, `capabilities.features.surfacesWrite: true`) — решение принято командой релиза без фичефлага. Последствие для отката: старый образ не распарсит документ с `surfaces` и не отрендерит вторую панель, поэтому после первой surfaces-записи откат образа возможен только вместе с восстановлением совместимого бэкапа (бэкап волны — `.backups/prod-surfaces-20260803`). Сама миграция v24 добавляет таблицу `prototype_revision_theme_pins` и пересоздаёт триггеры retired-систем — старому образу она не мешает.

Для композиций (миграция v18) действует та же rollback-политика, что для flows и screen regions: старый образ не знает host-примитивов `@eui/Composition`/`@eui/Slot` и не умеет раскрывать документ, поэтому в течение rollback-window нельзя персистить ни одной ревизии прототипа со ссылкой на композицию. Сама миграция только добавляет таблицы и старому образу не мешает.

SQLite работает в WAL-режиме: корректный backup должен учитывать основной `.db` вместе с файлами `-wal` и `-shm` либо выполняться штатным SQLite backup-механизмом. `docker compose down -v` удаляет named volume и все постоянные данные — на production эту команду применять нельзя.

### CI-гейт корпуса рендерера и soft cross-host сверка (волна R2c, план 2026-08-03 renderer-contract-2)

С волны R2c `.github/workflows/build-image.yml` — три job'а вместо одного (находка N13: раньше
сборка, `latest` и `compose.deploy` были шагами одного job'а, и любой «после-job» был декоративен):

| Job | Что делает | Условие |
|---|---|---|
| `build` | собирает образ и пушит **только SHA-тег** `ghcr.io/vladprrs/easy-ui:<sha>` (кандидат) | всегда |
| `renderer-corpus` | `docker run` этого SHA-образа с `EASYUI_RENDERER_FLAGS=1` и `REUSE_GATE=shadow`, прогон `scripts/renderer-corpus.mjs --verify --server-url http://127.0.0.1:8787`; полная матрица 12×20 в main, усечённая 12×3 в PR | всегда |
| `deploy` | `docker buildx imagetools create --tag …:latest …:<sha>` (перевешивает тег на тот же digest, без пересборки) + `compose.deploy` в Dokploy | только `push` в `main` и только после зелёного корпуса |

Красный корпус ⇒ тег `latest` не двигается и деплоя нет. Флаги детерминизма передаются
контейнеру **явно**: дефолт образа — OFF (порядок прод-включения — §7 плана), и без явного
`EASYUI_RENDERER_FLAGS=1` гейт мерил бы не ту конфигурацию рендерера.

Операционные следствия (осознанные): **каждый** push в `main`, включая docs-only, платит полный
корпус до деплоя (~8–15 мин на GH-раннере сверх сборки — закладывай в latency хотфиксов; `paths-ignore`
не ставим сознательно: гейт без исключений); fork-PR сборку не запускают вовсе (GITHUB_TOKEN
read-only, push SHA-образа в GHCR невозможен — guard на job `build`); PR из этого репозитория
пушат SHA-теги в GHCR без политики очистки — периодическая ручная уборка пакета.
Bootstrap-режим **не тихий**: шаг `Corpus bootstrap warning` вешает `::warning::` и строку в job
summary, пока ожидания образа не адоптированы — не оставляй гейт декоративным.

**Per-fingerprint ожидания.** Пиксели зависят от хоста растеризации, поэтому `expected.json`
хранит ожидания **по отпечатку рендерера**: корень файла — историческая запись dev-хоста
(`rendererSource: "fallback"`), любые другие хосты — в `hosts["<source>:<fingerprint>"]` в той же
форме (`pixel`/`outcome`/`sizes` + метаданные). `--verify` выбирает запись по отпечатку текущего
сервера; `--record` пишет в корень, если отпечаток совпал с корневым, и в `hosts[…]` иначе —
аддитивно, не трогая чужие записи.

**Bootstrap-режим гейта.** У образа отпечаток другой (`source: "manifest"`, свой sha бинаря
headless-shell и свой font stack), поэтому при первом прогоне ожиданий для него ещё нет. В этом
случае `--bootstrap` снимает матрицу, кладёт её в артефакт и **не красит** job. Как только запись
образа вмерджена, гейт для этого отпечатка становится жёстким — флаг `--bootstrap` на него больше
не влияет. Перевод гейта в жёсткий режим:

```bash
gh run download <run-id> -n renderer-corpus-<sha>   # артефакт job'а renderer-corpus
node scripts/renderer-corpus.mjs --adopt corpus-report.json   # вмерджить в hosts[...] expected.json
git add e2e/fixtures/renderer-corpus/expected.json && git commit
```

`--adopt` отказывается принимать усечённую (12×3) запись и запись с провалившимися капчурами:
эталон полной матрицы нельзя завести из PR-прогона.

**Soft cross-host гейт (K2).** Артефакт CI-прогона сравнивается с локальным прогоном **того же
digest'а**:

```bash
docker run -d --name corpus --shm-size=1g -p 127.0.0.1:8787:8787 \
  -e EASYUI_RENDERER_FLAGS=1 -e REUSE_GATE=shadow \
  -e ADMIN_NAME='Corpus Admin' -e ADMIN_PASSWORD='corpus-admin-password' \
  -e PUBLIC_ORIGIN=http://127.0.0.1:8787 ghcr.io/vladprrs/easy-ui:<sha>
node scripts/renderer-corpus.mjs --verify --bootstrap --report \
  --server-url http://127.0.0.1:8787 --out corpus-local.json
```

Шаг 1 — сверка отпечатков: если `renderer.fingerprint` обоих прогонов совпал, а sha разошлись,
это регрессия детерминизма (K1), а не кросс-хост дельта. Шаг 2 — сверка матриц `pixel` двух
файлов: **ноль расходящихся случаев ⇒ 0 ppm ⇒ K2 выполнен байт-точно**, гейт можно держать
жёстким на обоих хостах. Шаг 3 (только если случаи разошлись) — квалификация остатка в ppm:
sha этого не даёт, нужны сами PNG, поэтому оба прогона повторяются с `--keep` и кадры
сравниваются `scripts/visual-diff-worker.mjs`; ppm = `differingPixels / totalPixels × 1e6`,
суммарно по матрице. Порог решения — **≤50 ppm суммарно**; edge-квалификация остатка (внутри
маски краёв) возможна только после волны R7a, когда маска появится.

**Карантин фикстуры.** Флакующая фикстура помечается в `quarantined` файла `expected.json` (по
`id` фикстуры или по `fixture/variant`) — `--verify` её пропускает, main не краснеет; список
наследуется хостовыми записями из корня. Каждая постановка в карантин обязана сопровождаться
фактом в §4 плана: что именно флакует и по какой гипотезе.

**Проверка самого гейта.** `workflow_dispatch` с входом `corpus-sanity=break` снимает усечённую
матрицу образа, портит в ней один sha, вмердживает как ожидание этого отпечатка и повторяет
`--verify` — прогон обязан покраснеть. Деплой при этом не запускается (job `deploy` требует
`push` в `main`), а правки живут только в workspace прогона, так что `main` не портится.

### Типизированные коды капчура и `outcome` джобы (волна R3, план 2026-08-03 renderer-contract-2)

До волны причина неуспеха капчура была ad-hoc строкой (`"fonts_timeout,images_failed"`), а наружу
по HTTP ехал безымянный `capture_failed`: «почему кадр не получился» выяснялось глазами по PNG.
С R3 словарь исходов — один на продукт (`src/capture/failureCodes.ts`, §3 E3):

| Код | Кто эмитит | Смысл |
|---|---|---|
| `font_load_failed` | поверхность (`fonts_timeout`, `fonts_pending`; R4 — отказ required-face) | шрифт не догрузился; под политикой v1 — `warning`, под строгой v2 — `error` |
| `font_face_missing` | поверхность (R4, `fonts: "required-faces"`) | объявленный темой и реально используемый face недоступен (`document.fonts.check() === false`) |
| `image_load_failed` | поверхность (`images_timeout`, `images_failed`) | изображение без растра |
| `layout_unstable` | поверхность (`frames_timeout`; `stability.ts` — R4) | layout не успокоился за ≤3 попытки перемеры |
| `surface_missing` | воркер | в документе нет `#eui-capture-surface` |
| `surface_overflow` | гейт `geometry` v2 | вердикт политики геометрии (`paint-overflow-*`, `layout-overflow`) |
| `renderer_mismatch` | сервис (сверка манифеста), guard визуальных ранов — R6 | кадр нарисовал не тот браузер, что объявлен |
| `navigation_failed` | воркер | `page.goto` не открыл capture-URL |
| `runtime_error` | воркер (handshake/mismatch), поверхность (`network_timeout`) | исполнение страницы |

Форма кода: `{ code, severity: "error"|"warning", detail, ref? }`.

**`reason` не заменяется кодами.** Маппинг не биективен (две legacy-строки схлопываются в один
код), поэтому доказательство readiness несёт **оба** поля: `reason` в доволновом формате (строки
через запятую, поля нет при `met: true`) и `codes[]` рядом. Это же правило действует в метриках
гейтов `readiness`/`render`/`geometry` и в CAS-артефакте `readiness.json`.

**`GET /api/screenshot-jobs/:id`** получил два **аддитивных** поля; `status`, `result` и `error`
не изменились:

```jsonc
{
  "status": "error",
  "error": { "code": "navigation_failed", "message": "navigation failed: net::ERR_CONNECTION_REFUSED…" },
  "outcome": "renderer_mismatch | surface_missing | subprocess_error | worker_crash | timeout | queue_full | ok",
  "failure": { "code": "navigation_failed", "message": "…" }   // только когда причина типизирована
}
```

`outcome` — таксономия исхода **джобы**: `worker_crash`/`timeout`/`queue_full`/`subprocess_error`
инфраструктурны (повтор осмыслен), `renderer_mismatch` — **терминальный** исход, повтор в том же
процессе даст ровно то же расхождение. Приёмка это уважает: `maxInfraRetries` на терминальные
исходы не тратится (раньше расхождение рендерера ехало как `subprocess_error` и съедало бюджет
ретраев). `failure` появляется только при типизированной причине; нетипизированный отказ остаётся
доволновым `error.code = "capture_failed"` — код не выдумывается.

**Изменение поведения:** отсутствие `#eui-capture-surface` больше **не** деградирует в снимок всей
страницы. Раньше такой кадр молча уезжал в эталоны и давал необъяснимый визуальный провал; теперь
это `surface_missing` — отказ джобы с названной причиной.

### Строгая readiness 2.0 (волна R4, план 2026-08-03 renderer-contract-2)

Политика readiness получила **вторую версию**. Доволновая v1 не изменилась ни в одном байте
(`policyHash` тот же — иначе обнулился бы весь накопленный reuse приёмки), рядом появилась
строгая:

```ts
STRICT_READINESS_POLICY = { version: 2, fonts: "required-faces", images: "decoded-strict",
  network: { quietMs: 200, scope: "component-owned" }, frames: 2,
  animations: "disabled", timeoutMs: 15000, layout: { stabilize: true, attempts: 3 } }
```

Строгость включается **политикой профиля приёмки**, не env-флагом: её носит `pixel-strict-v1`.
`default-v1` и все интерактивные пути (галерея, библиотека, draft-preview, `POST
…/screenshot`) остаются на v1 — их поведение волной не изменилось. Перевод `default-v1` — отдельный
откатываемый шаг после приёмки волны.

**`fonts: "required-faces"`.** Сервер строит **манифест шрифтов темы** джобы и кладёт его в
`bootstrap.fonts = { declared, manifestHash }`. `assetId` берётся из `themeContent.fonts[].src`
(в схеме темы этого поля нет), `sha256` — из канонического формата id `asset_<sha256>`
(не-канонический id даёт `null`). Манифест резолвится на **всех** frozen-постановках: у прототипа
— по ДС снимаемого экрана с её пиннутой версией темы, у компонента/драфта/кандидата — по последней
версии темы его ДС. Правило требования:

```
required = faces манифеста темы  ∩  семейства, реально применённые к поверхности
```

Тема вправе объявлять шрифты, которых компонент не касается: требовать их загрузки нельзя.
Оговорка о «реально применённых»: наблюдение — это токены computed `font-family` выборки
элементов (весь стек, включая фолбэки, которые ни одного глифа не отрисовали), а выборка
ограничена потолками (≈400 элементов / 24 семейства). Следствия: face темы, стоящий в стеке
только фолбэком, может стать required (ложная строгость — редкость на реальных темах);
семейство за пределами выборки требование молча теряет (деградация в v1-поведение). Первая
«ложная» сработка `font_face_missing` — свойство этой выборки, а не баг строгости. Для
каждого required-face поверхность делает `document.fonts.load('<weight> <style> 16px "<family>"')`,
затем `check()` — он **авторитет**, `FontFace.status` — подтверждение:

| Наблюдение | Код |
|---|---|
| `check() === false` | `font_face_missing` (severity `error`, `ref` — семейство) |
| `check() === true`, но загрузка отвергнута или `FontFace.status === "error"` | `font_load_failed` |

Диапазон веса variable-шрифта (`"400 700"`) нормализуется к первому токену — иначе шорткод был бы
невалиден и волна врала бы `font_face_missing`. ДС **без темы** (`fonts: []`) — манифест пуст, и
строгость шрифтов вырождается в v1-семантику: требовать нечего.

**`images: "decoded-strict"`.** Критерий годности картинки — `complete ∧ naturalWidth > 0 ∧
naturalHeight > 0 ∧ decode() resolved`; отказ даёт `image_load_failed` с URL виновника. До волны
хватало «есть хоть какой-то растр», поэтому битый `<img>` рядом с живым давал «готовый» кадр.
Доказательство пополнилось `evidence.imageDetails[]` (`url`, `assetId`, интринсики, `decoded`,
`contentHash` из id ассета).

**`layout.stabilize`.** После frames-settle и до сбора ресурсов темы поверхность делает до
`attempts` (3) циклов «rAF → мера → rAF → мера → сравнение». Подпись кадра — прямоугольники
поверхности и всех geometry-узлов `[data-eui-key]`, округлённые до 1/64 px. Исчерпание попыток —
`layout_unstable` с `ref` первого разъехавшегося узла и `evidence.layout = { stable, attempts,
elementKey }`.

Метрики гейта `readiness` (и артефакт `readiness.json`) получили аддитивные `imageDetails`,
`layout`, `fontManifestHash`; `null` в них означает «политика профиля этого не требовала», а не
«проверено и хорошо». `detail` упавшего гейта теперь называет типизированные коды с указателем на
виновника.

**Терминальность `surface_missing`.** Исход джобы `outcome` пополнился значением `surface_missing`
(было: такой отказ классифицировался как `subprocess_error`). Терминальные исходы теперь два —
`renderer_mismatch` и `surface_missing`: повтор капчура даёт ровно ту же пустую страницу, и бюджет
`maxInfraRetries` приёмки на него больше не тратится.

### Capture receipt (волна R5, план 2026-08-03 renderer-contract-2)

Каждый капчур теперь оставляет **один машиночитаемый документ о происхождении кадра** — и на
байтовом канале приёмки, и на asset-канале (интерактивный `snap`, кадр визуального рана). До
волны доказательства ехали только байтовым каналом: кадр в asset-store не нёс ни рендерера, ни
readiness, ни таймингов.

Receipt собирается в `ScreenshotService` **после воркера и до ветвления по kind**, поэтому его
получают все режимы. Форма (`src/capture/receipt.ts`, `receiptVersion: 1`):

| Блок | Содержимое |
|---|---|
| `renderer` | объявление рендерера (§ [Renderer fingerprint 2.0](#renderer-fingerprint-20-волна-r1-план-2026-08-03-renderer-contract-2)) + `fingerprint`, `provenance`, `observedBrowserVersion`, `drift[]` (typed-коды расхождения) |
| `target` | `kind`, `componentId`/`prototypeId`, `version`/`rev`, `sourceHash?`, `bundleHash`, `dsMetaVersion`, `propsHash`; неприменимые поля — `null` |
| `resources` | `fontManifestHash`, `fontFaces[]` (`family/weight/style/assetId/sha256/status/checked/required`), `images[]` (`url/assetId/интринсики/decoded/contentHash`), `themeResources` |
| `console` | `errors[]`, `warnings[]`, `pageErrors[]` |
| `output` | `viewport`, `dpr`, `colorScheme`, `pngWidth/pngHeight`, `pngSha256`, `surfaceRect`, `paintMargin?` — **`null` для `probe:"geometry"`**: кадра в этой ветке не существует |
| `timings` | `navigateMs`, `screenshotMs`, `totalMs`, `readyMs`, `readinessMs` измеряются; пофазовые `fontsMs/imagesMs/networkMs/framesMs/stabilizeMs` объявлены и пока `null` — их источник (`collectReadiness`) публикует только суммарный `elapsedMs`. `null` означает «не измерялось», а не «ноль» |
| `verdict` | `captureClean`, `codes[]` (типизированные коды readiness), `readinessMet`, `readinessPolicyHash` |

Receipt **детерминирован** для одного входа во всём, кроме `timings` и `renderer.provenance.builtAt`.

**Доступ — только job-scoped:**

| Метод и путь | Ответ |
|---|---|
| `GET /screenshot-jobs/:jobId/receipt` | `200 {receiptSha256, receipt}` · `403 forbidden` · `404 receipt_not_found` |

Ручки «по sha» нет и не будет: у content-addressed документа нет владельца (дедуп даёт один адрес
двум владельцам), поэтому такая ручка была бы cross-owner-каналом — тот же инвариант, что у
CAS-артефактов приёмки. Авторизация выводится из владения **целью** капчура (read-доступ к
прототипу либо владение компонентом) и записана рядом со ссылкой, поэтому работает и после того,
как сама джоба вычищена по `RESULT_TTL` (10 минут): receipt живёт дольше неё. Результат джобы
дополнительно несёт аддитивное поле `receiptSha256`.

**Хранение.** `<DATA_DIR>/.receipts/<sha[0:2]>/<sha>` плюс два индекса: `jobId → {receiptSha256,
ownerKey}` (ручка выше) и `assetId → receiptSha256` (пишется **после** ингеста кадра — до него
assetId не существует; по нему следующая волна резолвит рендерер визуального эталона). Свипер:
TTL 7 суток, потолок 64 МБ, LRU по mtime, GC на старте процесса и при каждой записи. Пины: адреса
живых job-результатов и адреса, на которые ссылаются per-run манифесты приёмки, не вытесняются.

**Приёмка.** Гейт `render` кладёт `receipt.json` в CAS приёмки как обычный артефакт случая
(попадает в per-run манифест и `SHA256SUMS`) и публикует `receiptSha256` в метриках. Копия, а не
ссылка: у CAS приёмки refcount по строкам ранов, у receipt-стора — TTL/LRU, и связывать два
контура GC нельзя. Байты копируются дословно, поэтому адрес CAS-копии совпадает с адресом
receipt'а.

**Kill-switch.** `EASYUI_CAPTURE_RECEIPTS_DISABLED=1` — receipt'ы не собираются и не пишутся;
кадры при этом снимаются как прежде, `receiptSha256` просто отсутствует, а ручка отвечает `404`.
Дефолт — receipt'ы включены. Отказ записи receipt'а никогда не валит капчур: он едет
`runtimeWarnings`-предупреждением (`receipt_store_failed`).

**Цена диска.** Receipt — компактный JSON (порядок ≈1–2 КБ на кадр; факт замера — в §4 плана),
`.receipts` входит в периметр `du`-приёмки тома вместе с `assets/`, `.acceptance/cas` и
`.candidates`.

### Cross-renderer guard визуальных эталонов (волна R6, план 2026-08-03 renderer-contract-2)

Кадры, нарисованные **разными рендерерами**, больше не сравниваются. До волны эталон и кандидат,
снятые разными chromium/шрифтами/флагами, судились как обычная визуальная регрессия, и разница
рендереров приезжала процентом — то есть числом, которое нечем интерпретировать.

**Что хранится.** Миграция **v28** (единственная миграция пакета, только `ADD COLUMN`, без FK):
`visual_references` += `renderer_fingerprint`, `renderer_json`, `font_manifest_hash`,
`receipt_sha256`, `renderer_recorded_at`; `visual_runs` += `renderer_guard`, `outcome_code`,
`candidate_receipt_sha256`, `reference_receipt_sha256`. Отпечаток **не входит** в
`fingerprint_json` эталона: тот — content-addressed identity (PK, членство baseline-set'а,
`z.strictObject`), и новое поле внутри него сменило бы id всех эталонов. `visual_runs.status`
новых значений не получает (это был бы rebuild таблицы под CHECK): cross-renderer исход — пара
`status:"error"` + `outcomeCode`.

**Откуда берётся рендерер эталона.** Обе точки записи (baseline-коммит
`PUT /visual-baselines/prototypes/:id` и generic `PUT /visual-references`) резолвят его сервером по
индексу `assetId → receiptSha256` receipt-стора (R5) и пишут **инлайном**: `renderer_json`
переживает TTL стора, `receipt_sha256` — только evidence-ссылка, дополнительно защищённая пином
свипера (receipt, на который ссылается эталон, не вытесняется). PNG, залитый со стороны, честно
получает `renderer: null` — это `unknown`, а не «совпало». Оба PUT принимают необязательный адрес
receipt'а (`receiptSha256` / `receipts: {assetId: sha}`) — фолбэк массовой пересъёмки, когда
клиент знает адрес из `JobStatus.result`; **факты** рендерера сервер всё равно читает из своего
стора, подделать их этим полем нельзя.

**Как судит guard.** Он живёт в `VisualService.drive()` между кадром кандидата и диффом и
сравнивает три уровня: `rendererFingerprint`, `fontManifestHash`, `readinessPolicyHash`
(`null` с любой стороны — «доказательства нет», а не «разошлось»). Guard считается **раньше**
терминализации по продуктовым ошибкам кадра (console/pageErrors): диагнозы «переснимите эталон» и
«почините компонент» лечатся по-разному, и первый не выводится из второго; сами консольные ошибки
при этом остаются в `candidateMeta.browser` того же рана.

| Исход | Условие | Что в отчёте рана |
|---|---|---|
| `matched` | обе стороны известны и сошлись | вердикт по метрикам, как до волны |
| `mismatch` | известны и разошлись | `status:"error"`, `outcomeCode:"renderer_mismatch"`, `rendererGuard.differing[]`, **процента нет** |
| `unknown`, флаги OFF | происхождение эталона неизвестно | вердикт по метрикам + advisory `warnings:["renderer_unknown"]` (нулевой регресс) |
| `unknown` / чужая эпоха, `EASYUI_RENDERER_FLAGS=1` | то же при новых пикселях | `status:"error"`, `outcomeCode:"stale_renderer"`, **процента нет** |
| `disabled` | `EASYUI_RENDERER_GUARD_DISABLED=1` | доволновое поведение; guard записан, но ни на что не влияет |

Эпоха рендерера по умолчанию — `rendererVersion` объявления; `EASYUI_RENDERER_EPOCH` — только
override, и без `EASYUI_RENDERER_FLAGS=1` он игнорируется (self-check пишет warning на старте).
Снапшот флагов берётся на постановке проверки: ран, стартовавший до флипа флага, доигрывается по
старой семантике. Приоритет кодов: разошлись и отпечаток, и эпоха ⇒ `renderer_mismatch`.

Семантика `mismatch` шире буквального «другой браузер»: в сверку входят также `fontManifestHash`
и `readinessPolicyHash`, поэтому легитимная продуктовая смена (тема добавила/убрала шрифт,
профиль сменил политику readiness) на эталоне, записанном ПОСЛЕ этой волны, терминализует ран как
`renderer_mismatch` без процента — вместо прежнего измеримого visual-fail. Это осознанно: кадр с
другим шрифтовым манифестом несравним попиксельно; правильный ход — переснять эталон
(`rebaseline-all.mjs` / baseline-путь), а не читать diff. Поле-виновник видно в `differing[]`.

Отчёт рана (`GET /visual-runs/:runId`, `reference.lastRun`, `runs[]`) получил аддитивные поля
`outcomeCode`, `rendererGuard`, `candidateReceiptSha256`, `referenceReceiptSha256`, `warnings`;
`reference` — поле `renderer` (или `null`).

**Приёмка.** Reuse `acceptance_case_results` дополнительно сверяет `renderer.fingerprint` в
`receipt.json` кэшированного случая с рендерером текущего процесса. Расхождение — не ошибка рана,
а промах кэша: случай снимается заново.

**Массовая пересъёмка.** `node scripts/rebaseline-all.mjs --api <base> [--dry-run]` —
инвентаризация эталонов обоих scope (`--dry-run` печатает `total/withRenderer/currentEpoch/unknown`
по каждому) и пересъёмка: `prototype-screen` — через baseline-путь с CAS по поколению,
`component` — через generic PUT. Капчуры идут строго последовательно с паузой (`--delay-ms`):
конкуренция capture на сервере равна 1, а очередь делится с фоновой приёмкой. 409 не ретраится —
прототип помечается `conflict`, повторный запуск доснимет пропущенное.

**Rollback-политика (точка невозврата).** Первая запись эталона с `renderer_fingerprint` **при
включённых** `EASYUI_RENDERER_FLAGS` — точка невозврата волны: с этого момента эталоны прода
описывают новый растр, и откат образа/флага возвращает старый рендерер к новым эталонам, то есть
массовый `stale_renderer`/`mismatch`, а не «как было». Отсюда порядок:

1. **до** включения флагов — логический бэкап prod-тома (канон `/deploy`, `.backups/prod-*`);
2. деплой образа с guard'ом при выключенных флагах (эталоны продолжают судиться метриками,
   guard пишет `renderer_unknown` advisory) — это состояние откатывается свободно;
3. инвентаризация `rebaseline-all.mjs --dry-run` — число эталонов известно заранее;
4. включение `EASYUI_RENDERER_FLAGS=1` и массовая пересъёмка в maintenance-окно, **разнесённое** с
   холодной пересъёмкой приёмки;
5. после шага 4 откат — **только** восстановлением бэкапа шага 1 (канон surfaces). Аварийная
   ручка на этот период — `EASYUI_RENDERER_GUARD_DISABLED=1`: она возвращает доволновое судейство
   не трогая данные.

Сама миграция v28 откат образа переживает: колонки аддитивны, потребители `SELECT *` не
сериализуют строку наружу, поэтому предыдущий образ на базе v28 стартует и отдаёт эталоны.

### Разделение метрик визуального рана: сигналы и edge-маска (волна R7a, план 2026-08-03 renderer-contract-2)

Флаг: **`EASYUI_VISUAL_SIGNALS_V2=1`** (opt-in). Выключен — поведение доволновое буквально: тот же
режим воркера, вердикт по проценту pixelmatch, поля `class`/`signals` отчёта — `null`.

**Зачем.** До волны ран судился одним числом — процентом pixelmatch, — и это число отвечало сразу
на два вопроса («изменился ли рендер» и «изменился ли продукт»), то есть ни на один. Теперь
сигналов четыре, и каждый отвечает за своё:

| сигнал | что означает |
|---|---|
| `dims` | `equal` / `normalized` (кадры сведены padding'ом в пределах допуска) / `irreconcilable` |
| `exact` | exact-rgba: отличается ли хоть один байт (порогов нет) |
| `perceptual` | pixelmatch с порогом рана — историческая метрика, она же бюджет |
| `edgeResidual` | **где** лежит остаток: доля отличающихся пикселей, попавшая на контуры самого эталона |

`edgeResidual` считается по эталону (кандидат в маске не участвует — иначе он сам себе назначал бы
допустимую зону): яркость с учётом альфы → Sobel → порог → дилатация 1 px. Дилатация обязательна:
сдвиг растра на 1 px уводит пиксель ровно на соседний.

**Вердикт (E6).** `irreconcilable` → `status:"error"`, `class:"indeterminate"`,
`outcomeCode:"dimensions_irreconcilable"`, процента нет вовсе. `exact = 0` → `pass`,
`class:"identical"`. `exact > 0` ∧ перцептивная метрика в бюджете рана ∧ `edgeResidual.insidePct ≥
T` → `pass`, `class:"renderer_residual"`. Иначе — `fail`, `class:"regression"` и `signals.causes[]`
той же таксономии, что у приёмки (`server/visual/causes.ts`). `status` новых значений не получил
(N7): класс объясняет статус, а не заменяет его.

**Порог T = 95 %, калибровка на реальных парах** (chromium, DPR 1 и 2, реальный текст и реальный
антиалиасинг — факт R7a в §4 плана): сдвиг текста на 0,5–1 px даёт 98,7–100 % остатка внутри
маски, `letter-spacing 0.1px` — 94,8–99,4 %, сдвиг плашки на 4 px — 50,6–79,4 %, перекраска —
0,96–26,3 %. Зазор между классами — (79,4; 98,7); 95 выбран внутри него ближе к верхней границе:
цена ошибки несимметрична, ложный `renderer_residual` прячет регрессию, а ложная регрессия всего
лишь требует взгляда человека. Сдвиг на 1 px даёт 100 % остатка внутри маски и для плашки тоже —
такие раны отсекает **перцептивный** бюджет, поэтому оба условия в E6 обязательны.

**Что меняется в вердиктах.** Ран, у которого перцептивная метрика в бюджете, но остаток лежит вне
контуров, теперь `fail`. Это не ужесточение ради ужесточения: смена заливки половины холста
`#f2f1f0 → #e8f0ff` даёт **0 %** по pixelmatch и **52 %** по exact-rgba — доволновая семантика
такую регрессию не видела вовсе. Ровно поэтому волна opt-in.

**Один детектор одного явления.** Edge-маска — вход классификатора `text-raster-residual`: при
наличии сигнала решает только она, доволновая AA-эвристика остаётся фолбэком на его отсутствие
(флаг выключен либо метрики сняты до волны). Двух детекторов одновременно не существует.

Отчёт рана (`GET /visual-runs/:runId`, `reference.lastRun`, `runs[]`) получил аддитивные поля
`class` и `signals`; `metric`/`diffPercent` по-прежнему несут перцептивную метрику, `metrics
["exact-rgba"]` — точную. Миграции у волны нет: `class`/`signals` хранятся в
`candidate_meta_json` рядом с `exactRgba` и наружу отдаются собственными полями отчёта.

### Diagnostic bundle визуального рана (волна R7b, план 2026-08-03 renderer-contract-2)

`GET /api/visual-runs/:runId/bundle.zip` — всё, что нужно для расследования одного рана, одним
запросом и в самопроверяемом виде. До волны это была ручная работа: три ассета по трём URL, два
receipt'а по двум sha и отчёт рана — четыре источника, которые человек сшивал сам и не мог
доказать, что сшил именно их.

**Состав архива** (плоский, без каталогов):

| Запись | Происхождение |
|---|---|
| `reference.png` | ассет эталона рана |
| `candidate.png` | ассет кадра кандидата |
| `diff-perceptual.png` | diff-ассет, **произведённый самим раном** — никогда не перерисовывается |
| `diff-exact.png` | маска exact-rgba, пересчитанная на запросе (чёрное — отличается) |
| `edge-mask.png` | edge-маска эталона (Sobel + дилатация 1 px) — та же, по которой считается сигнал `edgeResidual` |
| `reference-receipt.json`, `candidate-receipt.json` | документы receipt-стора по `reference_receipt_sha256`/`candidate_receipt_sha256` рана |
| `report.json` | `bundleVersion`, отчёт рана целиком, `receipts` и `artifacts[]` с sha256 и происхождением каждого файла |
| `SHA256SUMS` | `"<sha256>  <имя>"` по каждой записи архива — формат `sha256sum -c` |

**Почему две маски пересчитываются, а перцептивный diff — нет.** Хранить `diff-exact.png` и
`edge-mask.png` значило бы класть два PNG на каждый ран в стор ассетов, у которого **нет GC**, —
ради диагностики, которую открывают у единиц ранов. Пересчёт детерминирован: те же чистые функции
того же воркера (`padPng`/`exactDiffMaskOf`/`edgeMaskOf`), которыми ран судился. `diff-perceptual.png`,
наоборот, — артефакт вердикта: подменять его свежим рендером значило бы показывать не то, по чему
вердикт вынесен.

**Отсутствующее не выдумывается.** Вытесненный receipt (`receipt_unavailable`), не записанный
receipt эталона, залитого извне (`no_receipt_recorded`), вычищенный кадр (`asset_bytes_missing`),
ран без diff-ассета (терминализовавшийся раньше диффа) и несводимые габариты
(`dimensions_irreconcilable`) дают **отсутствие файла** плюс названную причину в `report.json`;
`SHA256SUMS` при этом описывает ровно то, что в архиве есть. Receipt'ы эталонов держит пин
receipt-стора (R6), поэтому первый случай редок — но не невозможен, и врать о нём нельзя.

**Инварианты доступа.** Авторизация — та же, что у `GET /visual-runs/:runId` (чтение эталона):
архив не показывает ничего, чего не показывает отчёт. Ручки «receipt по sha» по-прежнему нет
(N12): run-scoped архив — единственный способ получить receipt'ы рана байтами. Потолок —
`limits.evidenceMaxBytes`, проверяется по размерам ассетов **до** чтения байтов (`413
evidence_too_large`, канон evidence-архива приёмки). mtime записей фиксирован, содержимое
детерминировано — один и тот же терминальный ран отдаёт один и тот же архив.

### Один рендерер в харнесе: `shoot` → `snap`, офлайн-съёмка `docker run` (волна R8a, план 2026-08-03 renderer-contract-2)

Локальный браузер из харнеса убран. `.claude/skills/author/driver.mjs` больше не импортирует
`playwright` и не делает `chromium.launch()`; верб `shoot` сохранён как **deprecated-алиас**
`snap --all-screens` (та же постановка job'а, тот же readiness-протокол, те же exit codes
`0/2/1`, тот же `--json`-отчёт с `command: "shoot"`) и печатает о своём статусе строку на stderr.
Escape-hatch `--local-browser` **не заводится**: два рендерера означали бы два набора шрифтов и
два набора пикселей, из которых один заведомо несопоставим с эталонами и с приёмкой. Флаг
распознаётся парсером только затем, чтобы объяснить своё отсутствие вместо «unknown flag».

**Предполётная сверка рендерера.** Перед съёмкой (`snap`, и потому `shoot`) драйвер читает
`GET /api/capabilities` → секцию `renderer` и пишет на stderr предупреждение, если секции нет
(сборка старше renderer-контракта) либо `source: "fallback"` (сборка без `renderer-manifest.json`
рисует локально установленным браузером). Проверка **мягкая**: недоступные capabilities, ответ не-200 и
любая ошибка сети её глушат, exit code съёмки от неё не зависит — иначе один разъехавшийся
дев-инстанс блокировал бы работу вместо того, чтобы её пометить.

**Офлайн-съёмка.** Агенту без доступа к проду доступен ровно тот же рендерер — образ поднимается
локально, и драйвер ходит в него:

```bash
docker run -d --name easyui-offline --shm-size=1g -p 127.0.0.1:8787:8787 \
  -e ADMIN_NAME='Offline Admin' -e ADMIN_PASSWORD='offline-admin-password' \
  -e PUBLIC_ORIGIN=http://127.0.0.1:8787 ghcr.io/vladprrs/easy-ui:<sha>
EASYUI_API=http://127.0.0.1:8787/api EASYUI_USERNAME='Offline Admin' \
  EASYUI_PASSWORD='offline-admin-password' \
  node .claude/skills/author/driver.mjs snap my-flow ./shots --json
```

Отпечаток такого прогона — отпечаток образа (`docker run <image> cat /app/renderer-manifest.json`
и `GET /api/capabilities` → `renderer.fingerprint`); кадры сопоставимы с прод-кадрами того же
digest'а. Автоматическая проверка рецепта (корпус `docker run` против корпуса драйвера по
`expected.json`) — ниже, § [Receipt в CLI и проверка офлайн-рецепта](#receipt-в-cli-и-проверка-офлайн-рецепта-волна-r8b-план-2026-08-03-renderer-contract-2).

### Receipt в CLI и проверка офлайн-рецепта (волна R8b, план 2026-08-03 renderer-contract-2)

Доказательства происхождения кадра (§ [Capture receipt](#capture-receipt-волна-r5-план-2026-08-03-renderer-contract-2))
доступны прямо из харнеса: агент, который смотрит на PNG, обязан уметь ответить, **чем** этот
PNG снят, не заходя в БД сервера.

**`--json` у `snap`/`shoot`/`preview`** дополнительно несёт три поля на каждый снятый кадр:

| Поле | Источник | Смысл |
|---|---|---|
| `receiptSha256` | `JobStatus.result.receiptSha256` | адрес receipt'а; читается ручкой `GET /screenshot-jobs/:jobId/receipt` |
| `renderer` | `JobStatus.result.renderer` (R1) | `{rendererFingerprint, rendererVersion, source, browserVersion}` — объявление, замороженное на постановке джобы |
| `codes[]` | `failure` джобы (R3) + `verdict.codes` и `renderer.drift` receipt'а (R5) | типизированные коды капчура, дедуплицированные по `code|severity|detail` |

У `snap` эти поля лежат в каждом элементе `screens[]` (у каждого экрана свой капчур и свой
receipt), у `preview` — на верхнем уровне отчёта, включая `--probe geometry` (у измерительной
джобы receipt есть, но `output` в нём `null` — кадра не существует). В человекочитаемом режиме
`preview` печатает `receipt=<sha>` в строке пинов, а непустые `codes[]` уходят на stderr.

**`--receipt <file.json>`** дополнительно скачивает сам документ:

```bash
node .claude/skills/author/driver.mjs preview yp-button props.json --receipt ./receipts/button.json --json
node .claude/skills/author/driver.mjs snap my-flow ./shots --receipt ./receipts/my-flow.json --json
```

| Верб | Форма файла |
|---|---|
| `preview` | `{command:"preview", componentId, jobId, receiptSha256, receipt}` — `receipt` дословно тот документ, что отдаёт job-scoped ручка |
| `snap` | `{command:"snap"\|"shoot", prototypeId, rev, receipts:[{screenId, jobId, receiptSha256, receipt}]}` — один файл на команду, по записи на экран |

Чтение receipt'а **мягкое**: kill-switch `EASYUI_CAPTURE_RECEIPTS_DISABLED=1`, вытеснение
свипером и сборка старше волны R5 дают `receipt: null` в файле, строку-объяснение на stderr и
**неизменный exit code** — кадр уже снят, и терять его из-за отсутствующего доказательства
нельзя. Отпечаток рендерера при этом остаётся: он объявляется на постановке джобы и от receipt'ов
не зависит.

#### K2: проверка офлайн-рецепта (локальный харнес против сервера в образе)

Метрика K2 плана распадается на две части; кросс-хост часть закрыта волной R2c, здесь — вторая:
**кадр, снятый через `driver.mjs`, обязан быть байт-идентичен кадру, снятому корпусом по HTTP на
том же образе**. После R8a у харнеса нет собственного браузера, поэтому обе ноги обязаны сойтись
дословно; расхождение означало бы, что клиент влияет на растр (иной вьюпорт, dpr, тема или
props), и это баг харнеса.

Шаг 1 — поднять образ и снять корпус по HTTP (нога «сервер в контейнере»; она же публикует
фикстурную ДС и компоненты в контейнер):

```bash
docker run -d --name easyui-k2 --shm-size=1g -p 127.0.0.1:8787:8787 \
  -e EASYUI_RENDERER_FLAGS=1 -e REUSE_GATE=shadow \
  -e ADMIN_NAME='Corpus Admin' -e ADMIN_PASSWORD='corpus-admin-password' \
  -e PUBLIC_ORIGIN=http://127.0.0.1:8787 ghcr.io/vladprrs/easy-ui:<sha>
node scripts/renderer-corpus.mjs --verify --bootstrap --truncated \
  --server-url http://127.0.0.1:8787 --out corpus-image.json
```

Шаг 2 — снять ту же матрицу драйвером и сверить с `corpus-image.json` (нога «локальный харнес»).
Скрипт ниже самодостаточен: он читает манифест корпуса, гонит `driver.mjs preview` по каждой паре
фикстура×вариант и сравнивает **три** величины — sha скачанного PNG, `receipt.output.pngSha256` и
ожидание из записи корпуса, плюс отпечаток рендерера:

```bash
export EASYUI_API=http://127.0.0.1:8787/api
export EASYUI_USERNAME='Corpus Admin' EASYUI_PASSWORD='corpus-admin-password'
export CORPUS_RECORD=corpus-image.json   # FULL=1 — полная матрица вместо усечённой
node --input-type=module - <<'EOF'
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const record = JSON.parse(await readFile(process.env.CORPUS_RECORD, "utf8"));
const corpus = JSON.parse(await readFile("e2e/fixtures/renderer-corpus/corpus.json", "utf8"));
const work = await mkdtemp(join(tmpdir(), "k2-cli-"));
const variants = corpus.variants.filter((v) => process.env.FULL === "1" || v.truncated === true);
const rows = [];
for (const fixture of corpus.fixtures.filter((f) => f.subset === "pixel")) {
  const props = join(work, `${fixture.id}.props.json`);
  await writeFile(props, JSON.stringify(fixture.props ?? {}));
  for (const variant of variants) {
    const png = join(work, `${fixture.id}-${variant.id}.png`);
    const receiptPath = join(work, `${fixture.id}-${variant.id}.receipt.json`);
    const { stdout } = await run("node", [
      ".claude/skills/author/driver.mjs", "preview", fixture.id, props,
      "--viewport", `${variant.viewport.width}x${variant.viewport.height}`,
      "--theme", variant.theme, "--dsf", String(variant.dsf),
      "--out", png, "--receipt", receiptPath, "--json",
    ], { env: process.env, maxBuffer: 64 * 1024 * 1024 });
    const payload = JSON.parse(stdout);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")).receipt;
    const fileSha = createHash("sha256").update(await readFile(png)).digest("hex");
    const want = record.pixel?.[fixture.id]?.[variant.id] ?? null;
    rows.push({
      key: `${fixture.id}/${variant.id}`, want, fileSha,
      receiptSha: receipt?.output?.pngSha256 ?? null,
      fingerprint: payload.renderer?.rendererFingerprint ?? null,
      ok: want !== null && want === fileSha && receipt?.output?.pngSha256 === fileSha
        && payload.renderer?.rendererFingerprint === record.renderer.fingerprint,
    });
  }
}
const bad = rows.filter((row) => !row.ok);
process.stdout.write(`${JSON.stringify({ captures: rows.length, mismatches: bad.length, detail: bad.slice(0, 10) }, null, 2)}\n`);
if (bad.length > 0) process.exitCode = 1;
EOF
docker rm -f easyui-k2
```

Вердикт: `mismatches: 0` ⇒ K2 (local-vs-server) выполнен байт-точно. Ненулевое число читается по
полям `detail[]`: разошёлся `fileSha` с `want` — растр зависит от клиента (баг харнеса или разные
входы); разошёлся `receiptSha` с `fileSha` — receipt описывает не тот кадр, который доехал до
диска (баг доставки); разошёлся `fingerprint` — сравниваются **разные рендереры**, и сверка sha
бессмысленна до устранения расхождения.

**Где это выполнимо.** Обеим ногам нужен рабочий docker-демон. В dev-контейнере разработки его
нет (`docker` CLI есть, сокета нет), поэтому полная проверка гоняется в CI (job `renderer-corpus`
уже поднимает образ — вторая нога добавляется тем же скриптом) либо на хосте с docker. Без docker
проверяется тот же инвариант против **локального** Bun-сервера (нужен собранный `dist` —
`npm run build`):

```bash
rm -rf .measure-data/k2-dev && mkdir -p .measure-data/k2-dev
EASYUI_RENDERER_FLAGS=1 REUSE_GATE=shadow SERVE_DIST=dist DATA_DIR=.measure-data/k2-dev \
  PORT=4199 PUBLIC_ORIGIN=http://127.0.0.1:4199 \
  ADMIN_NAME='Corpus Admin' ADMIN_PASSWORD='corpus-admin-password' \
  ~/.bun/bin/bun server/main.ts &   # дождаться "ready" в логе
node scripts/renderer-corpus.mjs --verify --report --bootstrap --truncated \
  --server-url http://127.0.0.1:4199 --out /tmp/k2-http.json
# шаг 2 (CLI-нога): EASYUI_API=http://127.0.0.1:4199/api driver.mjs snap --receipt (и сверка sha)
``` Результат такого прогона (dev-хост,
`source: "fallback"`, усечённая матрица 9 pixel-фикстур × 3 варианта = **27 капчуров**):
`mismatches: 0` — то есть CLI-нога и HTTP-нога сходятся байт-в-байт, а `receipt.output.pngSha256`
совпадает с sha скачанного PNG. Отличие от docker-прогона — только отпечаток рендерера (`fallback`
против `manifest`), сам инвариант от него не зависит.

### Тёплый пул воркеров капчура (волна R9a, план 2026-08-03 renderer-contract-2)

До этой волны каждая джоба капчура стоила **отдельного процесса**: спавн node, `chromium.launch()`,
поднятие deny-proxy, один кадр, `browser.close()`. Запуск браузера — это ~0,5 с чистых накладных
расходов на каждый кадр, и на матричной приёмке (десятки кадров подряд) они складываются в минуты.

Пул (`scripts/screenshot-pool-worker.mjs`) — **долгоживущий** процесс: один `browser` обслуживает
много джоб, NDJSON-протокол по stdin/stdout, ответы разбираются по `id` джобы.

**Включение.** `EASYUI_RENDERER_POOL=1`. Выбор имплемента делает сам `RunJob`
(`server/screenshot/worker-runner.ts`) на каждой джобе, поэтому флаг флипается без пересборки:
`1` — пул, любое другое значение — доволновой процесс-на-джобу (`spawnPerJobWorker`, остаётся
каноном и не трогается волной).

**Что пул НЕ меняет — и почему.** Канон поведения капчура — strict-воркер
`scripts/screenshot-worker.mjs`: готовность, handshake, типизированные коды (R3), поля receipt'а
(R5). Всё, что влияет на растр и на границу egress, пул **импортирует** из него
(`buildLaunchArgs`, `CAPTURE_CONTEXT_OPTIONS`, `matchAllowed`, `canonicalStringify`,
`readyToExpected`, `WORKER_FAILURE_CODES`), а не переписывает: собственного списка launch-аргументов
у пула нет вовсе (тест `server/screenshot-pool-worker.test.ts`). Детерминизм-args, как и раньше,
приезжают **в payload джобы** — окружение воркер не читает (T-m17).

**Изоляция джоб.** Браузер общий, **контекст — свой на каждую джобу**, `context.close()` в
`finally`. Cookie, `localStorage`, service workers и initScript-бутстрап
(`__EUI_CAPTURE_BOOTSTRAP__`) живут внутри контекста и между джобами не переживают — это
проверяется живым тестом, а не рассуждением: фикстурная страница логирует то, что видит, **до**
того как пачкает контекст, и вторая джоба того же браузера обязана увидеть чистый лист и свой
собственный бутстрап.

**Ресайкл.** Deny-proxy долгоживущий, и его порт зашит в launch-аргументы — поэтому смена
`captureOrigin` (или набора детерминизм-args) переиспользованием браузера быть не может.
Причины ресайкла, в порядке проверки:

| Причина | Условие | Зачем |
|---|---|---|
| `origin_changed` | `captureOrigin`/`determinismArgs` джобы ≠ те, с которыми запущен браузер | launch-аргументы фиксируют порт deny-proxy и bypass-list |
| `job_failed` | предыдущая джоба вернула не-`ok` | упавшая джоба могла оставить браузер в неизвестном состоянии |
| `job_budget` | `jobs >= EASYUI_POOL_MAX_JOBS` (20) | верхняя граница накопленной утечки chromium |
| `ttl` | возраст браузера `>= EASYUI_POOL_TTL_MS` (10 мин) | то же по времени простоя |
| `rss` | RSS **дерева** процессов пула `>= EASYUI_POOL_RSS_MB` (1500 МБ) | ~37% `mem_limit: 4g` — ресайкл срабатывает задолго до 75%-бюджета контейнера |

RSS меряется по всему дереву (node пула + chromium + рендереры): память пула — это память
браузера. `/proc` недоступен ⇒ `null`, и порог RSS просто не участвует в решении.

**Живучесть.** Дедлайн джобы в пуле — событие **процесса**, а не джобы: клиент убивает всю группу
процессов (как и per-job воркер) и поднимает пул заново на следующей джобе; смерть процесса
пула отвечает всем ожидающим обычным `{ok:false}`, а не висящим промисом.

#### Замер (K7): cold/warm p95 и RSS

`npm run measure:capture -- --pool 1 --cases 30` (канон `scripts/measure-acceptance.mjs`): скрипт
поднимает изолированный Bun preview, публикует компонент-пробник и делает N последовательных
капчуров через публичный API, семплируя RSS дерева процессов сервера. Первый капчур — **cold**,
остальные — **warm** (p50/p95/max). Вердикт печатается полем `verdict`:

> **прод ON, если warm p95 ≤ 1,0 с/case и устойчивый RSS ≤ 75% `mem_limit`; иначе пул остаётся
> dev/CI-only — это валидный результат волны, а не провал.**

Факты dev-хоста (8 vCPU, `EASYUI_RENDERER_FLAGS=1`, 30 капчуров, по два прогона на конфигурацию;
`mem_limit` прода — 4 ГБ, бюджет 75% = 3072 МБ) — в §4 плана.

#### Конкуренция и «один тяжёлый подпроцесс»

Правило family-плана «один тяжёлый подпроцесс» волной **не отменяется**: конкуренция capture в
`ScreenshotService` остаётся жёсткой единицей, джобы внутри пула исполняются строго
последовательно, ручка конкуренции волной не вводится. Основание — замер: выигрыш пула получен на
последовательном потоке (−44% warm p95) без единого нового конкурентного подпроцесса, а поднятие
конкуренции меняет профиль RSS (каждый параллельный контекст — это ещё один рендерер chromium) и
обязано мериться отдельно. Если ручка появится, то — отдельным env с дефолтом 1 и собственным
замером.
