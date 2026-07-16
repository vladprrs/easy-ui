# Bun Server API

Локальный Bun-сервер — единственный источник данных для галереи и плеера. Он хранит прототипы и пользовательские React-компоненты в SQLite, раздаёт API, а при `SERVE_DIST=dist` также SPA и Storybook-статику.

## Auth, сессии и принципалы

Именованные аккаунты используют парольные hash’и Argon2id (`Bun.password`) и opaque cookie-сессии. В SQLite хранится только SHA-256 digest токена. Сессия живёт 30 дней; сервер удаляет протухшие записи и оставляет не более 10 активных сессий на пользователя. Cookie называется `easyui_session` в HTTP dev-режиме и `__Host-easyui_session` при HTTPS; атрибуты: host-only, `Path=/`, `HttpOnly`, `SameSite=Lax`, а при HTTPS также `Secure`. Все session-API ответы имеют `Vary: Cookie` и `Cache-Control: private, no-store`. Ответ приложения `401` — JSON без `WWW-Authenticate`.

Bootstrap выполняется в порядке migrate → admin/backfill → seed. `ADMIN_NAME` и `ADMIN_PASSWORD` создают или обновляют стабильного администратора `user_admin`; изменение bootstrap-пароля отзывает его сессии. В той же транзакции пустые `owner_id` прототипов, компонентов и дизайн-систем получают admin-владельца. Запуск без администратора запрещён; для non-loopback bind администратор должен уже существовать или быть задан обеими переменными. `LEGACY_BASIC_AUTH` — опциональный внешний compatibility-барьер поверх cookie-сессий, а не аккаунт приложения. Health, share exchange/share scope и capture scope обходят этот внешний барьер.

Сервер один раз на запрос выбирает принципал в path-aware порядке: `Capture(scope)` → `Share(scope)` → `User {userId,name,isAdmin}` → `Anonymous`. Capture/share учитываются только когда их credential валиден и текущий `GET`/`HEAD` входит в exact scope. Поэтому валидная share-cookie для другого пути и невалидный capture bearer не перекрывают рабочую user-сессию.

Все unsafe-методы требуют same-origin `Origin`, независимо от типа тела (включая multipart). Login ограничивает длину имени/пароля, валидирует `next` как относительный same-origin путь, rate-limit’ится и выполняет dummy Argon2 verify для неизвестного имени.

| Endpoint / ресурс | Anonymous | User | Share(scope) | Capture(scope) |
|---|---:|---:|---:|---:|
| `GET /api/health` | да | да | да | да |
| `POST /api/auth/login` | да | да | только как anonymous-route | только как anonymous-route |
| `POST /api/auth/logout`, `GET /api/auth/me` | нет | да | нет | нет |
| `POST /api/users`, `GET /api/users` | нет | только admin | нет | нет |
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

## Trust boundary и threat model

Все аккаунты считаются доверенными операторами. Пользовательский TSX исполняется publish-pipeline с правами серверного процесса и исполняется same-origin в браузерах всех пользователей. Песочницы нет. Разделение владельцев и приватность защищают от случайного просмотра и ошибочных действий, но не от злонамеренного коллеги с аккаунтом. Same-origin вредоносный компонент может читать данные и выполнять мутации от лица открывшего его пользователя; cookie/Origin-защита не меняет эту границу доверия.

## Модель версий

Каждое сохранение создаёт неизменяемую ревизию `rev`; `headRev` указывает на текущий draft. Restore копирует старую ревизию в новую. Publish не копирует данные, а присваивает текущей ревизии последовательное имя `version` (v1, v2, …); одну ревизию нельзя публиковать дважды.

При каждом сохранении прототипа сервер разрешает используемые кастомные типы в последние active-версии и записывает точные пины `(componentId, version)`. Поэтому последующий publish компонента не меняет старый draft или опубликованный прототип. Publish компонента проходит состояния `staging → active` либо `staging → failed`; staging/failed невидимы манифесту, новым пинам и bundle endpoint. После рестарта незавершённые staging-записи становятся failed.

Все пути ниже имеют префикс `/api`. JSON-ответы, кроме immutable-ресурсов, имеют `Cache-Control: no-store`. Поля `message` необязательны. Все мутации существующего ресурса требуют `baseRev`.

## Endpoints прототипов

| Метод и путь | Тело / ответ |
|---|---|
| `GET /prototypes` | свои прототипы любого статуса + чужие `published`; `PrototypeListItem[]`: `{id,name,description?,device,designSystem,screenCount,headRev,latestVersion,status,owner:{id,name},updatedAt}` |
| `POST /prototypes` | `{doc,message?}` → 201 `{id,rev,warnings,screens}` и `Location` |
| `GET /prototypes/:id` | `{id,name,designSystem,headRev,latestVersion:number|null,versions:PrototypeVersion[],updatedAt,draftRevision,validatedRevision,publishedVersion,renderable}` |
| `GET /prototypes/:id/draft` | `{doc,rev,builtinCatalogHash,componentManifestHash,components:ComponentPin[],assets:AssetPin[]}` |
| `GET /prototypes/:id/screens/:screenId/render-status?version=n\|rev=n` | Готовность экрана к рендеру — см. [Render status](#render-status) |
| `PUT /prototypes/:id` | `{doc,message?,baseRev}` → `{rev,warnings,screens}`; `doc.id` обязан совпадать с `:id` |
| `DELETE /prototypes/:id` | `{baseRev}` → 204; hard delete с каскадом ревизий |
| `GET /prototypes/:id/revisions?limit&before` | `{rev,message:string|null,createdAt}[]`; `limit` по умолчанию 20, максимум 100 |
| `GET /prototypes/:id/revisions/:rev` | `{rev,doc,components:ComponentPin[],assets:AssetPin[],message:string|null,createdAt}` |
| `GET /prototypes/:id/revisions/:rev/diff?against=n` | Структурный diff ревизий; без `against` сравнивает с `rev-1` |
| `POST /prototypes/:id/restore` | `{rev,baseRev}` → `{rev}` (номер новой head-ревизии) |
| `POST /prototypes/:id/publish` | `{message?,baseRev}` → 201 `{version,rev,screens}` и `Location` |
| `POST /prototypes/:id/status` | owner-only `{status:"private"|"published"|"archived"}`; граф `private↔published`, `private|published→archived`, `archived→private` |
| `GET /prototypes/:id/versions` | `PrototypeVersion[]`: `{version,rev,publishedAt}` |
| `GET /prototypes/:id/versions/:version` | `{version,rev,doc,builtinCatalogHash,componentManifestHash,components:ComponentPin[],assets:AssetPin[],publishedAt}`; immutable |
| `POST /prototypes/:id/share` | `{version,ttlSeconds}` → 201 `{id,prototypeId,version,url,createdAt,expiresAt,activeSessions}`; bearer-token присутствует только в одноразово возвращённом `url` |
| `GET /prototypes/:id/share` | `{shares: ShareGrant[]}` — только активные/неистёкшие grants, без bearer-token |
| `DELETE /prototypes/:id/share/:shareId` | 204; revoke grant и всех выданных им sessions |

`PUT /prototypes/:id` — это осознанный checkpoint, а не no-op. Даже если `doc` не изменился, успешный запрос с актуальным `baseRev` создаёт новую ревизию: сервер заново разрешает и фиксирует пины active custom-бандлов, текущей версии темы дизайн-системы и ассетов, а также сохраняет переданный `message`. CAS по `baseRev` действует как обычно. Сервер намеренно не дедуплицирует такие ревизии, потому что повторное сохранение выражает явное решение зафиксировать актуальное окружение документа.

`ComponentPin` — `{id,name,version,bundleUrl,bundleHash}`. `AssetPin` — `{id,sha256,mime,size}` (пины ревизии из `prototype_revision_assets`; см. [Ассеты](#ассеты)). `componentManifestHash` — SHA-256 канонически отсортированных пинов. `builtinCatalogHash` вычисляется отдельно для системы из документа ревизии и идентифицирует её render/validation-контракт. Дескриптор включает обязательный `renderContractVersion` (сейчас `1`), actions, имена/descriptions/events/slots, input JSON Schema пропсов, `layout`/`layoutNeutral` и resolved spacing scale из **pinned** `design_system_meta_version`. Restore копирует версию темы исходной ревизии, поэтому восстанавливает и соответствующий hash. Хеш остаётся детектором несовместимости, а не pin: рантайм не сравнивает и не блокирует mismatch.

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
        "changed": [{"id": "...", "type": {"from": "...", "to": "..."}, "props": {"added": [], "removed": [], "changed": []}, "children": {"from": V, "to": V}, "on": {"added": [], "removed": [], "changed": []}, "visible": {"from": V, "to": V}, "repeat": {"from": V, "to": V}, "slot": {"from": V, "to": V}}]
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

Owner-endpoints share подчиняются обычному Basic Auth. Grant всегда закреплён за опубликованной immutable version; TTL допускается от 5 минут до 30 дней. Bearer-token генерируется из 32 случайных байт (256 бит) и возвращается только при создании: в SQLite хранится исключительно SHA-256 hash. Поэтому старую ссылку нельзя восстановить из списка — можно отозвать её и создать новую.

Публичный `GET /share/:token` — единственный маршрут перед BasicAuth-гейтом. Живой token обменивается на opaque server-session, после чего сервер ставит host-only cookie `HttpOnly; SameSite=Lax; Path=/` (`Secure` только при HTTPS `PUBLIC_ORIGIN`) и отвечает `303` на абсолютный tokenless URL `/share/p/:id/v/:version/present/s/:startScreen`. Token исчезает из адресной строки и не попадает в referrer.

Если запрос обмена содержит ровно один параметр `mobile` со строгим значением `0` или `1`, сервер переносит его в `Location` ответа `303`. Это позволяет форсировать режим мобильного плеера на принимающем устройстве; дубликаты, другие значения и все остальные query-параметры не переносятся.

Share-cookie авторизует исключительно `GET`/`HEAD` по exact allowlist: share-present маршруты экранов, DTO выбранной version, её pinned component bundles и точные shim/asset/theme-version зависимости. Draft/list/write API, обычные `/p/*` маршруты, другие прототипы и версии не разрешены. Ответы имеют `Cache-Control: no-store`, `Vary: Cookie`, `Referrer-Policy: no-referrer`. Closure текущей SPA-сборки (Vite chunks, fonts, favicon и скопированные public-файлы) перечисляется из текущего `SERVE_DIST` на каждом запросе, не сохраняется в grant/session; уже выданная cookie поэтому продолжает работать после redeploy с новыми hash-именами. Revoke помечает grant и удаляет все его sessions немедленно.

### Матрица `designSystem` в DTO прототипов

Нормализованный `doc` — источник истины. Если ответ содержит `doc`, система находится только в `doc.designSystem` и не дублируется сверху: это draft, конкретная revision и опубликованная version. В list и meta, где документа нет, `designSystem` находится top-level и отражает текущий head. Ответы create, save и restore содержат только номер ревизии (и применимые warnings), поэтому отдельного поля системы в них нет. Старый документ без поля при чтении нормализуется в `designSystem: "shadcn"`.

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

Meta-ответы прототипов и компонентов additively несут lifecycle-поля:

- `draftRevision` — текущая head-ревизия;
- `validatedRevision` — последняя ревизия с прошедшей (`ok`) записью валидации, либо `null`;
- `publishedVersion` — последняя опубликованная версия (для компонента — последняя `active`), либо `null`;
- `renderable: {head, published}` — та же логика, что render-status (document ∧ bundles), без external probe; `published` = `null`, если публикаций нет.

Поле `deployedVersion` намеренно **не** выдаётся: инстанс single-server, поэтому «задеплоенная» версия тождественна опубликованной и отдельное поле было бы тавтологией.

## Endpoints компонентов

Идентификатор — slug, имя — уникальное `^[A-Z][A-Za-z0-9]*$`, не конфликтующее со встроенным каталогом ни одной зарегистрированной системы с builtin provider. Имена компонентов глобально уникальны, а не уникальны в паре с системой: поэтому и в custom-системе нельзя создать `Button`, `Card` и другие builtin-имена. Это ограничение MVP связано с pins, registry и `components.name UNIQUE`. Имя после создания неизменно; систему head можно сменить. Удаление soft: компонент исчезает из списка/манифеста и не доступен новым сохранениям, но ранее опубликованные bundle и пины продолжают работать.

При добавлении builtin-системы коллизия любого её имени с существующим custom-компонентом является dev-time блокером. Startup-инвариант сравнивает объединение builtin-имён всех зарегистрированных систем со всей таблицей `components` и останавливает сервер с явной ошибкой; grandfathering устраняется вручную до регистрации системы. Композитный ключ `(designSystem, name)` отложен на post-MVP.

| Метод и путь | Тело / ответ |
|---|---|
| `GET /components` | `{id,name,designSystem,headRev,latestVersion:number|null,updatedAt}[]` |
| `POST /components` | `{id,name,source,designSystem?,message?}` → 201 `{id,rev}` и `Location`; `designSystem` по умолчанию `shadcn` |
| `GET /components/:id` | `{id,name,designSystem,headRev,versions:ComponentVersion[],updatedAt,draftRevision,validatedRevision,publishedVersion,renderable}` (lifecycle-поля — см. [Lifecycle-модель](#lifecycle-модель)) |
| `PUT /components/:id` | `{source?,designSystem?,message?,baseRev}` → `{rev}`; хотя бы одно из `source`/`designSystem`, смена системы наследует текущий source |
| `DELETE /components/:id` | `{baseRev}` → 204 |
| `GET /components/:id/source` | Текущий `{rev,source,designSystem,message:string|null,createdAt}` |
| `GET /components/:id/draft` | Alias текущего source DTO |
| `GET /components/:id/revisions` | `{rev,designSystem,message:string|null,createdAt}[]` |
| `GET /components/:id/revisions/:rev` | `{rev,source,designSystem,message:string|null,createdAt}` |
| `POST /components/:id/restore` | `{rev,baseRev}` → `{rev}` |
| `POST /components/:id/publish` | `{message?,baseRev}` → 201 `{version,hostAbiVersion,warnings}` и `Location` |
| `GET /components/:id/versions` | `ComponentVersion[]`: `{version,rev,status,statusReason:string\|null,supersededBy:number\|null,statusRev,designSystem,publishedAt}` |
| `GET /components/:id/versions/:version` | Метадата версии **любого статуса**: `{version,rev,status,statusReason,supersededBy,statusRev,source,designSystem,events,eventPayloads?,capabilities?,slots,description,example?,examples?,propsJsonSchema?,atomicLevel?,layoutNeutral?,layout?,bundleHash,hostAbiVersion,assets:AssetPin[],publishedAt}`; `propsJsonSchema` описывает input (до Zod defaults/transforms); immutable |
| `GET /components/:id/versions/:version/bundle.js` | Скомпилированный ESM (`text/javascript`); отдаётся при статусе `active\|deprecated\|superseded`, иначе `404 bundle_unavailable`; immutable |
| `POST /components/:id/versions/:version/status` | `{status, reason?, supersededBy?, baseStatusRev}` → 200 `{status, statusRev}`; см. [Статусы версий](#статусы-версий-компонентов) |

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

## Figma provenance

Ссылка на исходный Figma-файл — **immutable-свойство ревизии**: колонка `figma_json TEXT NULL` в `prototype_revisions` и `component_revisions` (миграция v9, два additive `ALTER`). Поле `figma` принимается опционально рядом с `doc`/`source`:

- Прототипы: `POST /prototypes` и `PUT /prototypes/:id` — `{doc, message?, figma?}`.
- Компоненты: `POST /components` (`{id,name,source,…,figma?}`) и `PUT /components/:id` (`{source?,designSystem?,figma?,baseRev}`; допускается изменение **только** `figma` — создаётся новая ревизия с прежним source).

**Строгая схема** (`z.strictObject`, лишние ключи → `422 validation_failed`):

| Поле | Правило |
|---|---|
| `fileKey` | строка 1..128, `^[A-Za-z0-9_-]+$` |
| `nodeIds` | 1..50 строк, каждая 1..64, `^[A-Za-z0-9:._-]+$` |
| `referenceScreenshots?` | ≤50 asset-id (`asset_<64hex>`); каждый обязан существовать в реестре assets, иначе `422 asset_not_found` |
| `lastSyncedAt?` | ISO-дата (`Date.parse`-валидная), ≤40 символов |

**Семантика.** Значение сохраняется на **создаваемой** ревизии; `restore` копирует `figma_json` исходной ревизии вместе с документом/исходником. `publish` прототипа переиспользует head-ревизию. Для owner read-back additively отдаёт `figma` (объект или `null`). Для любого не-owner принципала, включая Share/Capture, ключ `figma` в meta/draft/version **полностью отсутствует**, а история ревизий закрыта. Легаси-ревизии без ссылки читаются owner-у как `figma: null`.

## Служебные endpoints

### Реестр дизайн-систем

Единственный источник существования и metadata системы — таблица SQLite `design_systems` (`id`, `name`, `description`, внутренний immutable `builtin_provider`, timestamps). `shadcn`, `wireframe` и `yandex-pay` создаются миграцией как обычные registry-записи; API-системы переживают рестарт. Provider связывает запись с кодовым builtin-каталогом, но не является вторым реестром. У системы без provider `components: []`; её доступный каталог формируют опубликованные custom-компоненты.

| Метод и путь | Тело / ответ |
|---|---|
| `GET /design-systems` | `{designSystems: DesignSystemSummary[]}` |
| `GET /design-systems/:id` | `DesignSystemSummary`; неизвестный ID → `404 not_found` |
| `POST /design-systems` | `{id,name,description}` → 201 `DesignSystemSummary` и `Location`; повтор ID → `409 already_exists` |
| `PATCH /design-systems/:id` | Тема (см. §Тема) `{tokens?,fonts?,icons?,baseVersion}` → 200 `DesignSystemSummary`; builtin → `405`; CAS-конфликт → `409 version_conflict` |
| `GET /design-systems/:id/versions/:v` | Immutable `{systemId,version,tokens,fonts,icons,createdAt}`; отсутствует → `404 not_found` |

`DesignSystemSummary` имеет `{id,name,description,builtinCatalogHash,resolvedSpaceScale,components,hostPrimitives}` плюс additively `latestMetaVersion` и содержимое последней версии темы `{tokens,fonts,icons}`; provider не раскрывается. `components[]` сериализует `propsJsonSchema` (input), `layout?` и явный `layoutNeutral`; `hostPrimitives[]` использует ту же generic-схему дескриптора, но в W2b всегда пуст (host-примитивы не входят в bundle-manifest). `resolvedSpaceScale` — итоговые девять `none..4xl` для последней merged-темы системы. Malformed JSON/body не-object даёт `400 invalid_request`; неизвестные поля, неверные типы, невалидный slug, пустые или слишком длинные значения — `422 validation_failed` с `issues[].path`. `PUT` и `DELETE` на collection или `:id`, а также `PATCH` на collection дают `405 method_not_allowed`: registry metadata в этом API неизменяемы. Повтор идентичного POST не идемпотентен и также даёт 409.

#### Тема дизайн-системы (tokens/fonts/icons) и версии

Тема кастомной системы — три строго-валидируемых коллекции, хранимые как **immutable-версии** в `design_system_versions(system_id, version, tokens_json, fonts_json, icons_json, created_at)`. `PATCH /design-systems/:id` доступен **только для кастомных систем** (builtin-provider → `405`) и создаёт версию `baseVersion+1` с CAS по последней версии: `baseVersion≠latest` → `409 version_conflict` с `currentVersion`. Первая тема создаётся при `baseVersion:0`. PATCH-семантика: переданная коллекция заменяет предыдущую, опущенная — наследуется. Версии неизменяемы и читаются через `GET …/versions/:v`.

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
| `GET /health` | `{status:"ready"}` после миграций, seed и ABI-проверки; до готовности 503 `starting` |
| `GET /catalog/manifest?designSystem=<slug>` | `{components:[{id,name,designSystem,version,bundleUrl,bundleHash,hostAbiVersion,events,eventPayloads?,capabilities?,slots,description,example?,examples?,propsJsonSchema?,atomicLevel?,layoutNeutral?,layout?}]}` — последняя active-версия каждого неудалённого custom-компонента для каждой системы или только указанной системы; host-примитивы намеренно не входят |
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

Асинхронный job-API рендерит экран прототипа (или опубликованный компонент) через headless Chromium (playwright) в отдельном node-подпроцессе. Обычный режим создаёт PNG и складывает его в реестр ассетов (D); geometry probe возвращает только DOM-геометрию и не создаёт PNG/asset. Оба режима требуют `SERVE_DIST` **и** установленного chromium; иначе POST сразу отвечает `501 screenshot_unavailable`.

| Метод и путь | Тело / ответ |
|---|---|
| `POST /prototypes/:id/screens/:screenId/screenshot` | `{rev?\|version?, viewport{width,height}, deviceScaleFactor?, theme?, waitForFonts?, probe?:"geometry"}` → `202 {jobId}` |
| `POST /components/:id/versions/:version/screenshot` | `{props?\|exampleName?, viewport, deviceScaleFactor?, theme?, waitForFonts?}` → `202 {jobId}`; `props` и `exampleName` взаимоисключающие |
| `GET /screenshot-jobs/:jobId` | `{status: queued\|running\|done\|error, result?, error?}` |

`result` (при `done`) — discriminated union. Image-ветка сохраняет прежние поля и получает discriminator: `{kind:"image", imageUrl, assetId, width, height, consoleErrors, pageErrors, rendererBuild, browserVersion, componentPins?|bundleHash?}`. Geometry-ветка:

```json
{
  "kind": "geometry",
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
  "total": 2
}
```

Worker обходит production-маркеры `span[data-eui-key]` после `__EUI_CAPTURE_READY__`. `instance` — нулевой ordinal одинакового `key` в DOM-порядке (в том числе для repeat), `parentKey`/`parentInstance` указывают ближайший ancestor-маркер, `domIndex` — общий DOM-порядок. Координаты округлены до 0.01 CSS px и отсчитаны от border box `#eui-capture-surface`; `dpr` не масштабирует их. Rect — union видимых box'ов DOM-поддерева маркера. Портал вне этого поддерева не включается; Overlay-layer включается, потому что его маркеры находятся внутри capture surface; fixed box целиком вне surface отбрасывается. Clipping/scroll не обрезает исходный layout rect.

Состояния различаются так: отсутствующий marker отсутствует и в `rects`; `display:none`/`visibility:hidden` даёт `hidden:true` и нулевой rect; отрендеренный элемент нулевого размера имеет нулевой rect без `hidden`. Число строк ограничено `limits.geometryRects` из `GET /capabilities` (тот же бюджет, что `repeatBudget`); `total` содержит число до усечения, `truncated` сообщает об усечении.

Layout owner вычисляется только из DOM: для непосредственных child-маркеров slot-группы берётся ближайший общий non-`display:contents` предок внутри parent-маркера. Fragment, несколько DOM roots или переход через marker делают owner неоднозначным, поэтому `layoutContext:null`. Из однозначного owner возвращаются computed `display`, `flexDirection`, `flexWrap`, `rowGap`, `columnGap`.

`driver.mjs geometry <protoId> <screenId>` печатает rect и layoutContext. Observed clearance между соседними rect по оси и CSS gap owner'а выводятся только когда definition декларирует `layout.flow`, направление статически известно, owner подтверждает non-wrapped flex нужной оси и группа не содержит repeat/named slots. Во всех остальных случаях печатается `gaps: n/a (<причина>)`. Observed clearance намеренно может отличаться от CSS gap из-за margins.

Для component screenshot `exampleName` выбирается строго из `definition.examples`: неизвестное имя или отсутствие `examples` → `422 unknown_example`, одновременные `props` и `exampleName` → `400 invalid_request`. После выбора набор проходит обычную валидацию props и участвует в `propsHash`.

**Границы (bounds).** `width ∈ [64,2000]`, `height ∈ [64,4000]`, `deviceScaleFactor ∈ {1,2,3}`, `width×height×dsf² ≤ 20 Mpx` — иначе `422 invalid_viewport`. PNG подчиняется лимитам ассетов (5 MiB / 16 Mpx). Пул concurrency 1, очередь ≤5 (`429 queue_full`), hard deadline job 60 s, TTL результата 10 минут (PNG остаётся в ассетах). Jobs хранятся в памяти.

**Snapshot цели при enqueue.** POST атомарно резолвит цель в `expected` (`prototype`: `{prototypeInstanceId,rev,componentManifestHash,builtinCatalogHash,dsMetaVersion,rendererBuild}`; `component`: `{componentId,version,bundleHash,propsHash,dsMetaVersion,rendererBuild}`) и сохраняет в job. Queued job не может «уехать» на более поздний head. Capture-shell (`/capture/:id/s/:screen`, `/capture/component/:id/:version`) выставляет discriminated `window.__EUI_CAPTURE_READY__` той же формы; worker строго канонически сравнивает с `expected` и падает при mismatch/`status:"error"` (быстрый fail вместо таймаута; readiness poll 20 s). Хеши добавлены в revision DTO additively.

Прямой component capture понимает только следующую грамматику. Bootstrap props от screenshot-worker всегда приоритетны. `?example=<name>` выбирает own-key из `examples` без fallback; неизвестное имя — capture error. `?props=example` без `example` выбирает legacy `definition.example`, а при его отсутствии падает. Любое другое значение `props`, а также повтор любого из параметров — ошибка. Без селекторов используются `{}`.

**Session-auth капчера.** При dequeue минтится одноразовая (в рамках job) capture-session: `{token(32B), kind, allowedUrls (точный immutable snapshot), expected, props?}`, TTL = deadline 60 s + 30 s, revoke в `finally`. Worker шлёт `X-EasyUI-Capture: <token>` только на loopback capture-origin (инжект в `context.route` по exact origin). Сервер принимает токен как транспортную авторизацию (обходит BasicAuth) только при: `server.requestIP()` ∈ loopback (`127.0.0.1`/`::1`/`::ffff:127.0.0.1`), метод GET/HEAD, нормализованный decoded-путь ∈ `allowedUrls`. `allowedUrls`: capture-route, revision/version/draft endpoint, pinned bundle URLs, pinned `/api/assets/:id` (из документа и компонентов), `/api/shims/`, транзитивная статика SPA из Vite-манифеста (js/css/`/fonts/*`/index; fallback — префиксы `/assets/`, `/fonts/`). Bootstrap (`__EUI_CAPTURE_BOOTSTRAP__`, включая произвольные `props` компонента) доставляется через `page.addInitScript` — page-JS не нуждается в токене.

**Egress-модель (defense-in-depth).** Network namespace в этом окружении недоступен (нет прав на unshare), поэтому изоляция задаётся Chromium-флагами и контекстом: `--proxy-server=http://127.0.0.1:<deny-port>` (контролируемый deny-proxy — локальный TCP-сокет, немедленно закрывающий соединения), `--proxy-bypass-list=<-loopback>;127.0.0.1:<capture-port>` (port-scoped: `<-loopback>` отключает implicit loopback-bypass, мимо proxy идёт только точный capture-origin), `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`, `--disable-quic`, `--webrtc-ip-handling-policy=disable_non_proxied_udp` + `--force-webrtc-ip-handling-policy`; контекст — `serviceWorkers:"block"`, `routeWebSocket` close, `context.route` в allowlist-режиме (только captureOrigin + путь ∈ allowedUrls, включая redirect-цепочки; иной loopback-порт или `[::1]` — abort). locale `ru-RU`, timezone `Europe/Moscow`, `reducedMotion: reduce`; CSS-анимации/caret глушатся стилем в capture-режиме.

**Остаточный риск.** По [модели доверия](#граница-доверия-и-запуск) published-код равен коду репозитория; egress-блок — defense-in-depth, а не sandbox. Точная строка `--proxy-bypass-list` закреплена unit-тестом; главный allowlist-инвариант покрыт server-side unit-тестами; полный adversarial сетевой сценарий помечен `test.fixme` в `e2e/preview/screenshot.spec.ts` (нестабилен в контейнере).

## Visual regression

Встроенный визуальный gate: reference-baseline (PNG-ассет) закрепляется за **канонической поверхностью** (fingerprint), а candidate снимается тем же screenshot job-пайплайном (параметры капчера берутся **из fingerprint**) и сравнивается в отдельном node-подпроцессе (`scripts/visual-diff-worker.mjs`, `pixelmatch` + `pngjs`). UI — `/visual`.

| Метод и путь | Тело / ответ |
|---|---|
| `PUT /visual-baselines/prototypes/:id` | Атомарная замена полного baseline-set: `{rev,prototypeInstanceId,baseGeneration,members:[{screenId,viewport,deviceScaleFactor,theme,assetId}]}` → `{generation,rev,members:[{…,referenceId}]}` |
| `GET /visual-baselines/prototypes/:id` | Последний set: `{generation,rev,prototypeInstanceId,createdAt,members:[{screenId,viewport,deviceScaleFactor,theme,referenceId}]}` |
| `PUT /visual-references` | `{fingerprint, assetId, note?}` → `200 reference`; upsert по канону fingerprint. Ассет обязан существовать и быть `image/png` (иначе `422`). |
| `GET /visual-references?scope=&prototypeId=&componentId=` | `{references:[reference]}` — каждая с `lastRun`. |
| `GET /visual-references/:id` | `reference` + `runs:[report]` (полная история). |
| `DELETE /visual-references/:id` | `204`; soft-delete активного reference без удаления runs. Повторный DELETE → `404 reference_not_found`. |
| `POST /visual-references/:id/check` | `{threshold?,rev?,version?}` → `202 {runId, jobId?}`. Капчер кандидата + diff-run. `jobId` отсутствует при `reference_missing`. |
| `GET /visual-runs/:runId` | `running`-плейсхолдер `{runId, referenceId, status:"running", jobId}` **или** терминальный evidence-отчёт. |

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
- `GET /api/schemas/prototype-document.json` — JSON Schema (draft 2020-12) формата документа прототипа, производная от `prototypeDocSchema`. Директивы props (`$state`, `$bindState`, `$template`, `$cond`, `$asset`) и param sources событий (`$event`, `$elementId`, `$itemIndex`, `$itemKey`) описаны в `$defs` как `anyOf` с `$comment` — их семантика enforce'ится валидатором `src/prototype/validate.ts`, а не самой схемой.
- `GET /api/schemas/component-definition.json` — JSON Schema контракта `definition` кастомного компонента (props/events/slots/capabilities/description/example/examples/atomicLevel и прочая metadata).
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
  "limits": { "elements": 500, "depth": 50, "bodyMiB": 1, "sourceKiB": 256, "assetMiB": 5, "repeatBudget": 2000, "repeatPerScreen": 20, "screenshotQueue": 5 },
  "designSystems": ["shadcn", "wireframe", "..."],
  "resolvedSpaceScales": { "shadcn": { "none": "0px", "xs": "4px", "sm": "8px", "md": "12px", "lg": "16px", "xl": "24px", "2xl": "32px", "3xl": "48px", "4xl": "64px" } },
  "features": { "renderStatus": true, "screenshots": true, "visualRegression": true, "assets": true, "typedEvents": true, "repeat": true, "namedSlots": true, "themeVersions": true, "layoutContract": true }
}
```

`designSystems` читается из живого реестра БД; `resolvedSpaceScales` резолвится для каждой системы из её последней merged-темы с canonical fallback. Значения `limits` импортируются из модулей, где они реально enforce'ятся (`src/prototype/validate.ts`, `server/assets/validate.ts`, `server/screenshot/service.ts`, `server/http.ts`), — двойного хардкода нет.

**Правило**: каждый новый endpoint обязан регистрироваться в `server/contracts.ts` (`registerContract`) — contract-тест `server/contract.test.ts` требует покрытия каждого контракта, а drift-check заставит перегенерировать `server/openapi.json`.

**Известное ограничение генератора OpenAPI:** numeric path-параметры (`rev`, `version` и подобные) публикуются в схеме как строки, хотя handler преобразует и проверяет их как положительные целые. Это ограничение артефакта генерации, а не runtime API.

## Контракт кастомного компонента

Модуль TSX экспортирует named `definition` и default plain function component. `definition.props` — Zod-схема; допустимы `events`, `slots?: string[]`, `capabilities?`, обязательный `description: string`, legacy `example?: Record<string, unknown>`, именованные `examples?: Record<string, Record<string, unknown>>`, `atomicLevel?: "atom" | "molecule" | "organism" | "template" | "page"`, `layoutNeutral?: boolean` и `layout?` контракта v1. `DefinitionMeta`, сохранённый для published-версии, содержит нормализованные `events`, `slots`, `description` и опциональные `eventPayloads`, `capabilities`, `example`, `examples`, input-`propsJsonSchema`, `atomicLevel`, `layoutNeutral`, `layout`; те же метаданные входят в version DTO и manifest. У custom-компонента уровень опционален для ABI v1 backward compatibility, но publish без него возвращает warning `Atomic design level is not provided; component will be classified as Other` и Library классифицирует компонент как `Other`. Default получает `BaseComponentProps` — объект `{props, emit}`. `memo` и `forwardRef` не поддерживаются.

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

По умолчанию сервер слушает `127.0.0.1` без authentication и предназначен для одного пользователя в workspace. `HOST` позволяет изменить адрес, а `BASIC_AUTH=user:pass` включает Basic authentication для API, статики и SPA fallback; исключение — только `GET /api/health`. Сервер отказывается стартовать на не-loopback адресе без `BASIC_AUTH`.

Код компонента выполняется с правами серверного процесса уже при save во время draft extraction, а при publish также проходит дополнительные стадии исполнения. Загружать следует только код, которому доверяют как коду репозитория. Subprocess и timeout ограничивают сбои extraction, но не являются security sandbox; published-код импортируется сервером и выполняется в браузере. Поэтому для публичного домена authentication обязательна.

Зависимости устанавливает только npm; требуется полный `npm install`, включая TypeScript из devDependencies. Серверный runtime — Bun 1.3.14 из `~/.bun/bin`, версия закреплена `.bun-version`; `~/.bun/bin` должен быть раньше битого `/usr/local/bin/bun` в `PATH`.

`DATA_DIR` обязан находиться внутри корня проекта. Сервер материализует туда TSX-модули, а Bun разрешает их `react`, `zod` и прочие imports через корневой `node_modules`; внешний каталог нарушает это разрешение. Для разработки: `PATH="$HOME/.bun/bin:$PATH" npm run server:dev`. Для собранной SPA: сначала `npm run build`, затем `npm run serve`.

## Deployment

Production разворачивается в Dokploy из корневого `docker-compose.yml` на домене `easy-ui.pay-offline.ru`. Образ **не собирается на прод-сервере**: его строит GitHub Actions (`.github/workflows/build-image.yml`) на каждый push в `main` и публикует в `ghcr.io/vladprrs/easy-ui:{latest,<sha>}` (публичный пакет, анонимный pull); по завершении workflow вызывает `compose.deploy` через Dokploy API (секрет `DOKPLOY_API_KEY`), и Dokploy выполняет только `docker compose pull` + `up` (`pull_policy: always`). Серверная сборка (npm ci + chromium + vite + storybook) трижды роняла хост 2026-07-14 и запрещена; прямой GitHub→Dokploy push-вебхук отключён. Контейнер использует `HOST=0.0.0.0`, `PORT=8787`, `SERVE_DIST=dist`, `DATA_DIR=data`; секрет `BASIC_AUTH=user:pass` и канонический `PUBLIC_ORIGIN=https://easy-ui.pay-offline.ru` обязательны и задаются только в окружении Dokploy. `PUBLIC_ORIGIN` содержит только scheme + host + опциональный port, без path/query/credentials. Для любого non-loopback hostname сервер требует HTTPS; явный HTTP разрешён лишь для loopback auth-preview/e2e. Именно этот origin используется в абсолютных share/QR URL и `303 Location`, поэтому он должен совпадать с внешним origin reverse proxy. Named volume `easy-ui-data` монтируется в `/app/data`.

Compose healthcheck обращается без credentials к открытому `GET http://127.0.0.1:8787/api/health` и считает сервис готовым только при HTTP 200 и JSON `status: "ready"`. Для rollback следует указать в compose известный хороший тег `ghcr.io/vladprrs/easy-ui:<sha>` (каждый коммит main тегируется) либо revert+push; миграции forward-only, поэтому перед рискованными изменениями нужен backup volume.

SQLite работает в WAL-режиме: корректный backup должен учитывать основной `.db` вместе с файлами `-wal` и `-shm` либо выполняться штатным SQLite backup-механизмом. `docker compose down -v` удаляет named volume и все постоянные данные — на production эту команду применять нельзя.
