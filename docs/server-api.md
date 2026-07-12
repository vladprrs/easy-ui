# Bun Server API

Локальный Bun-сервер — единственный источник данных для галереи и плеера. Он хранит прототипы и пользовательские React-компоненты в SQLite, раздаёт API, а при `SERVE_DIST=dist` также SPA и Storybook-статику. Сервер слушает только `127.0.0.1`.

## Модель версий

Каждое сохранение создаёт неизменяемую ревизию `rev`; `headRev` указывает на текущий draft. Restore копирует старую ревизию в новую. Publish не копирует данные, а присваивает текущей ревизии последовательное имя `version` (v1, v2, …); одну ревизию нельзя публиковать дважды.

При каждом сохранении прототипа сервер разрешает используемые кастомные типы в последние active-версии и записывает точные пины `(componentId, version)`. Поэтому последующий publish компонента не меняет старый draft или опубликованный прототип. Publish компонента проходит состояния `staging → active` либо `staging → failed`; staging/failed невидимы манифесту, новым пинам и bundle endpoint. После рестарта незавершённые staging-записи становятся failed.

Все пути ниже имеют префикс `/api`. JSON-ответы, кроме immutable-ресурсов, имеют `Cache-Control: no-store`. Поля `message` необязательны. Все мутации существующего ресурса требуют `baseRev`.

## Endpoints прототипов

| Метод и путь | Тело / ответ |
|---|---|
| `GET /prototypes` | `PrototypeListItem[]`: `{id,name,description?,device,designSystem,screenCount,headRev,latestVersion:number|null,updatedAt}` |
| `POST /prototypes` | `{doc,message?}` → 201 `{id,rev,warnings,screens}` и `Location` |
| `GET /prototypes/:id` | `{id,name,designSystem,headRev,latestVersion:number|null,versions:PrototypeVersion[],updatedAt,draftRevision,validatedRevision,publishedVersion,renderable}` |
| `GET /prototypes/:id/draft` | `{doc,rev,builtinCatalogHash,componentManifestHash,components:ComponentPin[],assets:AssetPin[]}` |
| `GET /prototypes/:id/screens/:screenId/render-status?version=n\|rev=n` | Готовность экрана к рендеру — см. [Render status](#render-status) |
| `PUT /prototypes/:id` | `{doc,message?,baseRev}` → `{rev,warnings,screens}`; `doc.id` обязан совпадать с `:id` |
| `DELETE /prototypes/:id` | `{baseRev}` → 204; hard delete с каскадом ревизий |
| `GET /prototypes/:id/revisions?limit&before` | `{rev,message:string|null,createdAt}[]`; `limit` по умолчанию 20, максимум 100 |
| `GET /prototypes/:id/revisions/:rev` | `{rev,doc,components:ComponentPin[],assets:AssetPin[],message:string|null,createdAt}` |
| `POST /prototypes/:id/restore` | `{rev,baseRev}` → `{rev}` (номер новой head-ревизии) |
| `POST /prototypes/:id/publish` | `{message?,baseRev}` → 201 `{version,rev,screens}` и `Location` |
| `GET /prototypes/:id/versions` | `PrototypeVersion[]`: `{version,rev,publishedAt}` |
| `GET /prototypes/:id/versions/:version` | `{version,rev,doc,builtinCatalogHash,componentManifestHash,components:ComponentPin[],assets:AssetPin[],publishedAt}`; immutable |

`ComponentPin` — `{id,name,version,bundleUrl,bundleHash}`. `AssetPin` — `{id,sha256,mime,size}` (пины ревизии из `prototype_revision_assets`; см. [Ассеты](#ассеты)). `componentManifestHash` — SHA-256 канонически отсортированных пинов. `builtinCatalogHash` вычисляется отдельно для системы из документа ревизии и идентифицирует её встроенный каталог. Дескриптор v1 включает имена, descriptions, events, slots и actions, но намеренно не включает `atomicLevel`: классификация может меняться без изменения render-совместимости. В MVP хеш диагностический — рантайм не сравнивает и не блокирует его mismatch; enforcement и таблицы совместимости оставлены на post-MVP.

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
| `GET /components/:id/versions` | `ComponentVersion[]`: `{version,rev,status,designSystem,publishedAt}` |
| `GET /components/:id/versions/:version` | Active-версия: `{version,rev,source,designSystem,events,eventPayloads?,capabilities?,slots,description,example?,propsJsonSchema?,atomicLevel?,bundleHash,hostAbiVersion,assets:AssetPin[],publishedAt}`; immutable |
| `GET /components/:id/versions/:version/bundle.js` | Скомпилированный ESM (`text/javascript`); immutable |

## Служебные endpoints

### Реестр дизайн-систем

Единственный источник существования и metadata системы — таблица SQLite `design_systems` (`id`, `name`, `description`, внутренний immutable `builtin_provider`, timestamps). `shadcn`, `wireframe` и `yandex-pay` создаются миграцией как обычные registry-записи; API-системы переживают рестарт. Provider связывает запись с кодовым builtin-каталогом, но не является вторым реестром. У системы без provider `components: []`; её доступный каталог формируют опубликованные custom-компоненты.

| Метод и путь | Тело / ответ |
|---|---|
| `GET /design-systems` | `{designSystems: DesignSystemSummary[]}` |
| `GET /design-systems/:id` | `DesignSystemSummary`; неизвестный ID → `404 not_found` |
| `POST /design-systems` | `{id,name,description}` → 201 `DesignSystemSummary` и `Location`; повтор ID → `409 already_exists` |

`DesignSystemSummary` имеет `{id,name,description,builtinCatalogHash,components}` и не раскрывает provider. Malformed JSON/body не-object даёт `400 invalid_request`; неизвестные поля, неверные типы, невалидный slug, пустые или слишком длинные значения — `422 validation_failed` с `issues[].path`. `PUT`, `PATCH` и `DELETE` на collection или `:id` дают `405 method_not_allowed`: registry metadata в этом API неизменяемы. Повтор идентичного POST не идемпотентен и также даёт 409.

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
| `GET /catalog/manifest` | `{components:[{id,name,designSystem,version,bundleUrl,bundleHash,hostAbiVersion,events,eventPayloads?,capabilities?,slots,description,example?,propsJsonSchema?,atomicLevel?}]}` — последняя active-версия каждого неудалённого компонента для каждой системы |
| `GET /shims/v1/:name.js` | ESM-шим host ABI v1; immutable |
| `GET /shims/v2/:name.js` | ESM-шим host ABI v2 (v1 + `easy-ui-runtime.js`); immutable |

### Ассеты

Content-addressed реестр бинарных ассетов (изображения и шрифты). `id = "asset_" + полный sha256` (64 hex-символа) — контент-адрес, коллизий нет. Байты хранятся в `DATA_DIR/assets/<sha256>` атомарной записью (temp-файл + `rename`); таблица `assets(id,sha256,mime,size,width?,height?,original_name?,created_at)`. Пины `prototype_revision_assets` и `component_publish_assets` держат FK `ON DELETE RESTRICT`: пиновые байты нельзя удалить.

| Метод и путь | Тело / ответ |
|---|---|
| `POST /assets` | Raw body с `Content-Type` (или `multipart/form-data` с ровно одним файлом). Новый ассет → 201 `{id,url,sha256,mime,size,width?,height?}` и `Location`; существующий sha256 → 200 с тем же телом и `deduplicated:true` |
| `GET /assets/:id` | Байты ассета; корректный `Content-Type`, immutable cache и жёсткие inert-заголовки (см. ниже). Неизвестный `id` → `404 asset_not_found` |

Приём: реальный тип определяется по magic-байтам и обязан совпадать с заявленным `Content-Type` — иначе `422 asset_type_mismatch`; неподдерживаемый заявленный тип — `422 unsupported_asset_type`. Допустимы `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/svg+xml`, `font/woff2`, `font/ttf`, `font/otf`. Лимит размера — 5 MiB (`413 asset_too_large`). Для растров декодируются размеры из заголовков (png/jpeg/webp/gif) и применяется лимит 16 Mpx (`413 asset_too_large`, decompression-bomb guard). SVG в v1 не санитизируется — вместо этого отдаётся инертно.

Заголовки `GET /assets/:id`: `Cache-Control: public, max-age=31536000, immutable`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`. Ассеты остаются за границей BasicAuth и same-origin (остаточный риск SVG зафиксирован здесь как admin-only инструмент).

**Ссылки из документов.** В URL-пропах документа допустима директива `{"$asset":"asset_<sha256>"}` (см. [формат](prototype-format.md#assets)); резолвится в `/api/assets/<id>` при построении runtime-спека. На save `collectAndValidateAssetRefs` проверяет существование до транзакции (`422 asset_not_found`) и пинует ассеты в `prototype_revision_assets` на каждой ревизии; restore копирует пины. Read-back (`/draft`, `/revisions/:rev`, `/versions/:v`) отдаёт `assets:[{id,sha256,mime,size}]`.

**Ссылки из компонентов.** На publish source сканируется на строковые литералы `/api/assets/asset_<sha256>`; найденные ассеты валидируются (`422 asset_not_found` при dangling) и пинуются в `component_publish_assets`; read-back версии показывает `assets`.

**Backup.** Логический снапшот прод-данных должен включать БД (`easy-ui.db` + `-wal`/`-shm`) **и** каталог `DATA_DIR/assets/`. Целостность (orphan-файлы, битые/недостающие байты, unpinned) проверяет ручной/деплойный скрипт `scripts/audit-assets.ts` (в `npm run verify` не входит — требует живую БД).

## Скриншоты

Асинхронный job-API рендерит экран прототипа (или опубликованный компонент) в PNG через headless Chromium (playwright) в отдельном node-подпроцессе. PNG складывается в реестр ассетов (D). Требует `SERVE_DIST` **и** установленного chromium; иначе POST сразу отвечает `501 screenshot_unavailable`.

| Метод и путь | Тело / ответ |
|---|---|
| `POST /prototypes/:id/screens/:screenId/screenshot` | `{rev?\|version?, viewport{width,height}, deviceScaleFactor?, theme?, waitForFonts?}` → `202 {jobId}` |
| `POST /components/:id/versions/:version/screenshot` | `{props?, viewport, deviceScaleFactor?, theme?, waitForFonts?}` → `202 {jobId}` (props валидируются) |
| `GET /screenshot-jobs/:jobId` | `{status: queued\|running\|done\|error, result?, error?}` |

`result` (при `done`): `{imageUrl, assetId, width, height, consoleErrors, pageErrors, rendererBuild, browserVersion, componentPins?|bundleHash?}`.

**Границы (bounds).** `width ∈ [64,2000]`, `height ∈ [64,4000]`, `deviceScaleFactor ∈ {1,2,3}`, `width×height×dsf² ≤ 20 Mpx` — иначе `422 invalid_viewport`. PNG подчиняется лимитам ассетов (5 MiB / 16 Mpx). Пул concurrency 1, очередь ≤5 (`429 queue_full`), hard deadline job 60 s, TTL результата 10 минут (PNG остаётся в ассетах). Jobs хранятся в памяти.

**Snapshot цели при enqueue.** POST атомарно резолвит цель в `expected` (`prototype`: `{rev, componentManifestHash, builtinCatalogHash, dsMetaVersion, rendererBuild}`; `component`: `{componentId, version, bundleHash, propsHash, dsMetaVersion, rendererBuild}`) и сохраняет в job. Queued job не может «уехать» на более поздний head. Capture-shell (`/capture/:id/s/:screen`, `/capture/component/:id/:version`) выставляет discriminated `window.__EUI_CAPTURE_READY__` той же формы; worker строго канонически сравнивает с `expected` и падает при mismatch/`status:"error"` (быстрый fail вместо таймаута; readiness poll 20 s). Хеши добавлены в revision DTO additively.

**Session-auth капчера.** При dequeue минтится одноразовая (в рамках job) capture-session: `{token(32B), kind, allowedUrls (точный immutable snapshot), expected, props?}`, TTL = deadline 60 s + 30 s, revoke в `finally`. Worker шлёт `X-EasyUI-Capture: <token>` только на loopback capture-origin (инжект в `context.route` по exact origin). Сервер принимает токен как транспортную авторизацию (обходит BasicAuth) только при: `server.requestIP()` ∈ loopback (`127.0.0.1`/`::1`/`::ffff:127.0.0.1`), метод GET/HEAD, нормализованный decoded-путь ∈ `allowedUrls`. `allowedUrls`: capture-route, revision/version/draft endpoint, pinned bundle URLs, pinned `/api/assets/:id` (из документа и компонентов), `/api/shims/`, транзитивная статика SPA из Vite-манифеста (js/css/`/fonts/*`/index; fallback — префиксы `/assets/`, `/fonts/`). Bootstrap (`__EUI_CAPTURE_BOOTSTRAP__`, включая произвольные `props` компонента) доставляется через `page.addInitScript` — page-JS не нуждается в токене.

**Egress-модель (defense-in-depth).** Network namespace в этом окружении недоступен (нет прав на unshare), поэтому изоляция задаётся Chromium-флагами и контекстом: `--proxy-server=http://127.0.0.1:<deny-port>` (контролируемый deny-proxy — локальный TCP-сокет, немедленно закрывающий соединения), `--proxy-bypass-list=<-loopback>;127.0.0.1:<capture-port>` (port-scoped: `<-loopback>` отключает implicit loopback-bypass, мимо proxy идёт только точный capture-origin), `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`, `--disable-quic`, `--webrtc-ip-handling-policy=disable_non_proxied_udp` + `--force-webrtc-ip-handling-policy`; контекст — `serviceWorkers:"block"`, `routeWebSocket` close, `context.route` в allowlist-режиме (только captureOrigin + путь ∈ allowedUrls, включая redirect-цепочки; иной loopback-порт или `[::1]` — abort). locale `ru-RU`, timezone `Europe/Moscow`, `reducedMotion: reduce`; CSS-анимации/caret глушатся стилем в capture-режиме.

**Остаточный риск.** По [модели доверия](#граница-доверия-и-запуск) published-код равен коду репозитория; egress-блок — defense-in-depth, а не sandbox. Точная строка `--proxy-bypass-list` закреплена unit-тестом; главный allowlist-инвариант покрыт server-side unit-тестами; полный adversarial сетевой сценарий помечен `test.fixme` в `e2e/preview/screenshot.spec.ts` (нестабилен в контейнере).

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

Каждый элемент `issues[]` дополнительно получает поле `pointer` — корректный RFC 6901 JSON Pointer с escape `~0`/`~1` (легаси-поле `path` сохраняется как есть). Pointer добавляется централизованно в `errorResponse`: для массивных `path` каждый сегмент экранируется, строковые pointer-подобные `path` проходят без изменений.

## Контракт кастомного компонента

Модуль TSX экспортирует named `definition` и default plain function component. `definition.props` — Zod-схема; допустимы `events`, `slots?: string[]`, `capabilities?`, обязательный `description: string`, `example?: Record<string, unknown>` и `atomicLevel?: "atom" | "molecule" | "organism" | "template" | "page"`. `DefinitionMeta`, сохранённый для published-версии, содержит нормализованные `events`, `slots`, `description` и опциональные `eventPayloads`, `capabilities`, `example`, `propsJsonSchema`, `atomicLevel`; те же метаданные входят в manifest. Если example задан, он обязан проходить props-схему. У custom-компонента уровень опционален для ABI v1 backward compatibility, но publish без него возвращает warning `Atomic design level is not provided; component will be classified as Other` и Library классифицирует компонент как `Other`. Default получает `BaseComponentProps` — объект `{props, emit}`. `memo` и `forwardRef` не поддерживаются.

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

Production разворачивается в Dokploy из корневого `docker-compose.yml` на домене `easy-ui.pay-offline.ru`. Контейнер использует `HOST=0.0.0.0`, `PORT=8787`, `SERVE_DIST=dist`, `DATA_DIR=data`; секрет `BASIC_AUTH=user:pass` обязателен и задаётся только в окружении Dokploy. Named volume `easy-ui-data` монтируется в `/app/data`.

Compose healthcheck обращается без credentials к открытому `GET http://127.0.0.1:8787/api/health` и считает сервис готовым только при HTTP 200 и JSON `status: "ready"`. Для rollback следует вернуть предыдущий commit SHA и повторно развернуть compose; миграции forward-only, поэтому перед рискованными изменениями нужен backup volume.

SQLite работает в WAL-режиме: корректный backup должен учитывать основной `.db` вместе с файлами `-wal` и `-shm` либо выполняться штатным SQLite backup-механизмом. `docker compose down -v` удаляет named volume и все постоянные данные — на production эту команду применять нельзя.
