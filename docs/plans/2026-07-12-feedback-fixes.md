# План v6: устранение проблем из developer-фидбэка (2026-07-12)

Источник: `docs/easy-ui-developer-feedback.md` (14 пунктов P0–P2). Раунд 1 ревью (Codex gpt-5.6-sol, max): 6 blocker / 18 major / 1 minor — все приняты. Раунд 2: 6 blocker / 5 major — все приняты. Раунд 3: 3 blocker / 6 major — все приняты. Раунд 4: 2 blocker — приняты (рекурсивная render-стоимость в repeat-бюджете + deep-freeze значений custom-коду, C.1; egress через Chromium-флаги proxy/host-resolver/QUIC/WebRTC как enforce-слой при недоступности network namespace, E.2). Раунд 5: 1 blocker — принят (port-scoped proxy-bypass только на capture-origin, deny-proxy как контролируемый сокет, `context.route` в allowlist-режиме по captureOrigin+allowedUrls, e2e с соседним loopback-сервисом, E.2). Триаж всех раундов в конце.

## Ключевые факты разведки и ревью

- **SPA fallback 404** (`server/static.ts:12-14`): `Accept`-гейт режет programmatic-клиентов; но fallback сам по себе не доказывает render readiness — нужны раздельные статусы.
- **`emit` библиотеки — `(event: string) => void`**; `Renderer` сам резолвит `on`-биндинги, `ActionProvider` перехватывает `setState/pushState/removeState` до наших handlers (`@json-render/react/dist/index.js:483,956,1248`). Своей SetState-factory payload не доставить — нужен **собственный event-адаптер для custom-компонентов**.
- **Named slots в Renderer нет**: children сливаются в один `ReactNode`, DOM-маркеры появляются после рендера — слот-роутинг делается **до** создания children, по индексам `element.children`.
- **repeat нативный** (`RepeatScopeProvider/useRepeatScope` экспортированы), но scope = `{item,index,basePath}` без key; `$item` в action params — это path, не значение; лимит элементов не учитывает expansion.
- **`JSONUIProvider` игнорирует `onStateChange` при внешнем store** — inspector строится на инструментированном store.
- **Store уязвим к `__proto__`-сегментам** pointer'ов (`@json-render/core/dist/index.js:649`) — нужен общий safe-pointer parser.
- **Bun.serve закрывает idle in-flight запрос ~10s** — долгие handlers требуют `server.timeout(request, n)`.
- **`DROP TABLE component_publishes` упадёт по FK RESTRICT** от `prototype_revision_components` — нужен строгий rebuild-алгоритм.
- Playwright в prod-образе нет; образ — Node 24 + Bun (`Dockerfile:1`), node-subprocess реалистичен.
- `ApiError.status` не допускает 501; `pathString` в issues не RFC6901-escaped.

## Архитектурные решения

### A. Static serving, render-status, lifecycle (P0 §1, P1 §9)

1. **Fallback**: `serveStatic` отдаёт `index.html` для `GET/HEAD` вне `/api/` и путей с расширением, без `Accept`-гейта. Неизвестный extensionless путь получит SPA (React покажет 404-страницу) — это осознанно; истинность маршрута проверяет render-status, а не HTTP-код статики.
2. **`GET /api/prototypes/:id/screens/:screenId/render-status`** (`?version=n` | `?rev=n`): раздельные проверки и статусы:
   - `document_ready` — документ ревизии/версии существует, screenId в нём есть;
   - `bundles_ready` — все пины резолвятся в рендеримые публикации (см. K: active|deprecated|superseded — с warnings; rejected/failed/staging → `bundle_failed`);
   - `local_route_ready` — SPA-статика доступна процессу (SERVE_DIST); в dev-режиме без dist — `route_not_ready` с message про Vite-origin.
   Ошибки: `prototype_not_found`, `screen_not_found`, `version_not_found`, `revision_not_found`, `bundle_failed`, `route_not_ready`. Ответ: `{status, renderable, url, revision, publishedVersion, resolvedPins, bundleStatus, warnings, errors}`.
3. **Canonical URLs**: additively `screens:[{id,url}]` в ответы create/save/publish.
4. **Lifecycle-модель без фикций**: новая таблица `validation_records(resource_type, resource_id, rev, validator_version, catalog_hash, ok, issues_json, created_at)` — пишется при save (прототипы) и publish-стадиях (компоненты). Meta-ответы получают `{draftRevision, validatedRevision (из validation_records), publishedVersion, renderable: {head: bool, published: bool|null}}` — `renderable` считается той же логикой, что render-status (без external probe). `deployedVersion` не выдумываем: single-server, поле опускаем, семантику фиксируем в docs. Restore прототипа прогоняет `validatePrototype` и пишет validation record.

### B. Typed event payloads + `$event` (P0 §2)

1. **Объявление**: `events` в definition — `string[]` (legacy) или `Record<name, ZodSchema>`; персист в `DefinitionMeta.eventPayloads: Record<name, JSONSchema>` (additive), manifest/design-systems API отдают оба поля (`events: string[]` сохраняется).
2. **Доставка — собственный event-адаптер, только для custom-компонентов** (builtin остаются payloadless — деградация зафиксирована в acceptance matrix):
   - **Side-channel вместо props**: `toRuntimeSpec(spec, {definitionsMeta})` строит **вне props** карту `elementKey → {on (raw), slotIndices, repeatKey, type}` и возвращает её вместе со spec'ом; карта раздаётся через наш React-контекст `EasyUiRuntimeContext` (провайдер в PlayerShell/CJM/Editor/capture). В props custom-элемента инжектится **только** строковый `__euiKey` (строки `resolveElementProps` не трансформирует — литерал passthrough); обёртка по нему берёт raw-метадату из контекста и срезает `__eui*` до вызова компонента. Namespace `__eui*` резервируется: запрещён в document props и в definition props (валидация save/publish). Тест: raw `$state/$item/$cond/$event` внутри `on`-биндинга доходит до адаптера неразрезолвленным.
   - обёртка даёт компоненту `emit(name, payload?)` **и заменяет `on()`** (сохраняя `bound`/`shouldPreventDefault`), чтобы legacy-путь `on("press").emit()` не обошёл адаптер; тип `EasyUIComponentProps` — см. B.5. Payload валидируется Zod-схемой из bundle; используется именно `parsed.data`; после parse — проверка JSON-safe и запрет `$`-префиксных ключей на любой глубине (fail → ошибка в inspector, событие не диспатчится).
   - обёртка резолвит params в литералы и исполняет действия через **`EasyUiActionRuntime`** (вводится в T4, T11 лишь декорирует логированием): hardened store-обёртка (safe-pointer, repeat-бюджет C.1, prev/next для inspector), `screenIds` текущего документа (runtime-guard `navigate`), `dispatchTerminal` (navigate/back/openUrl/restart). State-действия исполняются напрямую store-обёрткой, не `execute()` (тот повторно резолвит `$`-ключи — `resolveAction`/`pushState` интерпретируют `$state/$id`). Формальная семантика resolved params: `setState/pushState {statePath, value}` — value любой JSON-литерал; `removeState {statePath, index}` — index: число | `$event`/`$itemIndex`-source, нецелый/вне диапазона → no-op + inspector error; `navigate {screenId}` — значение ∉ screenIds → no-op + inspector error. `$if` срезается до исполнения. Корреляция — synchronous correlation id на emit.
   - **RuntimeTree**: `toRuntimeSpec` возвращает атомарную пару `{spec, metadata}` (side-channel карта — часть той же структуры); все структурные преобразования — операции над RuntimeTree: `stripEvents` (editor: удаляет `on` и из spec, и из metadata — inert-канвас не может диспатчить из effect/timer), `splitCanvas` (пересобирает metadata после удаления Hotspot-детей и сдвига индексов). Прямые манипуляции spec'ом после конверсии запрещаются (ownership T4 правит `EditorCanvas.tsx:109` и `canvasSpec.ts`).
   - штатные (payloadless) события custom-компонентов идут через тот же адаптер (payload = undefined).
3. **Params-грамматика**: `$event/$elementId/$itemIndex/$itemKey` — **param sources** (не prop-директивы), допустимы **только в событиях custom-компонентов** (builtin-элемент с param source или `$if` → ошибка валидации: их диспатчит штатный Renderer, который эти конструкции не понимает — fail closed). Разрешены в `setState/pushState/removeState` (`value` и вложенные значения) и в `navigate.screenId` (runtime-guard: значение обязано быть существующим screenId, иначе no-op + inspector error). `openUrl.url` — статический (безопасность). **Условное действие `$if`** (custom-only): condition-грамматика v1 + `{"$event":"/ptr"}`-операнд в `eq/neq` и truthiness; false → действие пропускается; статическое правило терминальности прежнее (≤1 терминальное, последним в массиве).
4. **Валидация**: `$event` допустим только на событии с объявленной payload-схемой; указатель проверяется по JSON Schema best-effort (неизвестный путь — warning). Payloadless событие + `$event` — ошибка. `$if` — та же condition-валидация.
5. **ABI/совместимость — shims v2**: ABI v1 неизменен. `hostAbiVersion` вычисляется на publish как **максимум требований**: runtime-import `easy-ui/runtime` в compiled JS **или** любая из `capabilities` (typedEvents/namedSlots) в metadata → ABI 2 (type-only import исчезает из бандла, но capabilities всё равно требуют нового host behavior). Полный export/semantic-контракт `easy-ui/runtime` (тип `EasyUIComponentProps` = BaseComponentProps + `emit(name, payload?)` + `slots`; функции `token(key)`, `Icon`) фиксируется целиком в T4 вместе с `easy-ui-runtime.d.ts` (подключается в publish-typecheck через module-resolution paths); T8 поставляет только versioned-данные темы, shim-код не меняет. Шимы `/api/shims/v2/*` = v1 + easy-ui-runtime (правило версионирования shim manifest соблюдено). Loader поддерживает оба ABI; render-status проверяет host ABI. `definition.capabilities?: {typedEvents?: true, namedSlots?: true}` — по ним валидация отличает custom-возможности; typed events/slots требуют ABI v2.
6. **Сериализация typed-событий — fail closed**: на publish `z.toJSONSchema` для каждой event-схемы обязан успешно давать детерминированную JSON-safe схему; transform/preprocess/custom-схемы без конвертации → 422 `event_schema_not_serializable` (не молчаливый пропуск, как сейчас в `pipeline.ts:39` для props). `eventPayloads` в meta/manifest строится из канонического JSON Schema.
7. **Формат-док**: снять «Events carry no payload», описать param sources и `$if` (custom-only).

### C. Композиция: repeat + named slots (P0 §3)

1. **Repeat**: `elementSchema` получает опциональный `repeat: {statePath, key?}` — passthrough. `$item`/`$index` разрешаются в props **и** в conditions (`visible`, `$cond.if`, `$if`); в action params нативный `$item` — это путь, поэтому в наших param sources `$itemIndex`/`$itemKey` вычисляются адаптером (C.3), а `$item`-в-params не открываем (документируем).
   Валидация: `repeat.statePath` — валидный safe-указатель; effective initial state по нему — массив (иначе warning: может наполняться динамически); `key` — имя поля item (shallow, документируем); `$item/$index` вне repeat-поддерева — ошибка. **Бюджет раскрытия (глобальный, enforce'ится)**: (а) статически — вложенный `repeat` запрещён (v1), ≤20 repeat-элементов на экран, Hotspot внутри repeat запрещён; (б) в runtime — hardened store (B.2/T4) перед первым рендером экрана и перед **каждой** мутацией (наш executor, builtin state actions, `$bindState` — все проходят через store-обёртку) вычисляет **рекурсивную render-стоимость** дерева по prospective state до commit: `cost(el) = 1 + Σ cost(children)`, для repeat-элемента — `1 + len(stateArray) × Σ cost(children)`; превышение бюджета 2000: на загрузке — hard error экрана, на мутации — отклонение мутации + ошибка в inspector. Initial state, превышающий бюджет, — ошибка валидации (не warning). Значения, выдаваемые custom-коду (payload, `$item`, state-чтения адаптера), — deep-frozen/defensive копии: in-place мутация массива не обходит guard. Депс-лимиты v1 остаются.
2. **Named slots — только custom-компоненты, роутинг до рендера**: у ребёнка опциональный `slot: slug`. Слот-карта `{name: [indices]}` (индексы позиций в `element.children`) идёт через side-channel карту `toRuntimeSpec` (B.2), не через props. Адаптер делает `React.Children.toArray(children)` и раскладывает по индексам в `slots: Record<name, ReactNode>` (без `slot` → `default`); для named-slot компонента фиксируем контракт `children === slots.default`; legacy-компоненты без capability получают прежний `children`.
   Валидация: `slot` допустим только если родитель — custom с `capabilities.namedSlots` и имя ∈ `definition.slots`; неизвестный слот — ошибка; builtin-родитель + `slot` — ошибка. **`repeat` на custom-родителе с named slots запрещён** (при `repeat` родитель получает единственный узел `<RepeatChildren>`, индексы неприменимы); repeat допустим на детях слота.
3. **Item-контекст событий**: адаптер custom-компонента читает `useRepeatScope()` (публичный экспорт); `$itemIndex` = scope.index, `$itemKey` = `item[repeat.key]`, где repeat.key берётся из side-channel карты ближайшего repeat-предка. `$itemKey` требует объявленного `repeat.key` — иначе ошибка валидации (никакого молчаливого fallback на index). Вне repeat-scope `$itemIndex/$itemKey` → ошибка валидации.
4. **Declined**: reusable composite definitions, локальный state scope, conditional slot content (частично покрыт: `visible` у slot-детей работает) — в acceptance matrix.

### D. Asset registry (P0 §4)

1. Таблица `assets(id TEXT PK, sha256 TEXT UNIQUE NOT NULL, mime, size, width?, height?, original_name, created_at)`; `id = "asset_" + sha256` (полный, 64 hex — коллизий нет). Байты — `DATA_DIR/assets/<sha256>`, запись атомарная: temp-файл + `rename`; чтение сверяет размер; целостность — `PRAGMA`-независимый аудит-скрипт (orphan-файлы/битые строки) в `npm run verify` не включаем (нужна живая БД), но добавляем `scripts/audit-assets.ts` для ручного/деплойного запуска. Backup-процедура в docs обновляется: db + `-wal/-shm` + `assets/`.
2. `POST /api/assets` — raw body с `Content-Type` (или multipart, один файл). Лимит 5 MiB (413). **Magic-byte-валидация** реального типа (png/jpeg/webp/gif/svg/woff2/ttf/otf); mismatch с заявленным mime → 422. Для растров — decode-check размеров, лимит 16 Mpx (decompression bomb). Дедуп: existing sha256 → 200 `{deduplicated:true}`. Ответ: `{id, url, sha256, mime, size, width?, height?}`.
3. `GET /api/assets/:id` — immutable, correct content-type и жёсткие заголовки: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`. SVG не санитизируем в v1 — политика заголовков + same-origin + BasicAuth-граница; зафиксировано как остаточный риск в docs (admin-only инструмент).
4. **`$asset` в документах**: `{"$asset":"asset_<sha256>"}` в URL-пропах; резолв в `toRuntimeSpec` → `/api/assets/<id>`. Save: `collectAndValidateAssetRefs(db, doc)` до транзакции (422 на несуществующий); пины `prototype_revision_assets(prototype_id, rev, asset_id, FK RESTRICT)`; restore копирует пины; read-back (`/draft`, `/revisions/:rev`, `/versions/:v`) отдаёт `assets:[{id,sha256,mime,size}]`.
5. **Component asset pins**: на publish компилят source — сканируем строковые литералы `/api/assets/asset_<sha256>` в исходнике; найденные валидируются и пишутся в `component_publish_assets(component_id, version, asset_id, FK RESTRICT)`; read-back версии показывает. Отсутствие ссылок — ок.
6. **Declined**: multi-file component package; локальные file-imports в TSX (закрыто asset-URL); в acceptance matrix.

### E. Скриншоты (P0 §5) и visual regression (P1 §6)

1. **Capture-shell**: новый роут `/capture/:protoId/s/:screenId` (+`?rev=n|version=n&theme=&dsf=`) — рендер экрана **без** app-chrome/DeviceFrame, 1:1 поверхность; данные ревизии — существующий `GET /revisions/:rev`. Готовность: shell выставляет `window.__EUI_CAPTURE_READY__ = {revision, componentManifestHash, pins}` после mount + `document.fonts.ready` + `img.decode()` всех изображений; CSS-анимации/caret глушатся стилем в capture-режиме.
2. **Worker**: `scripts/screenshot-worker.mjs` — node subprocess, прямой exact dep `playwright` (dependencies) + `npx --no-install playwright install --with-deps chromium` в Dockerfile; JSON-протокол stdin/stdout, kill process group по таймауту, гарантированный close browser/context, фиксированные locale/timezone (`ru-RU`, `Europe/Moscow`), `colorScheme` из параметра, `reducedMotion: reduce`. Ожидание: `__EUI_CAPTURE_READY__` (poll, 20s дедлайн), не `networkidle`. Консольные/страничные ошибки собираются (лимит 100). Egress — многослойная граница (network namespace в этом окружении недоступен — нет прав на unshare; заменяем enforce'ящими Chromium-флагами):
   - launch-флаги: `--proxy-server=http://127.0.0.1:<deny-port>` — **контролируемый deny-proxy** (worker поднимает локальный TCP-сокет, который немедленно закрывает соединения; не «предположительно свободный» порт) + `--proxy-bypass-list=127.0.0.1:<capture-port>` (**port-scoped**: мимо proxy идёт только точный capture-origin, `<-loopback>` implicit-bypass отключается явным списком), `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"` (DNS side-channel закрыт), `--disable-quic` (WebTransport/HTTP3-UDP закрыт), `--webrtc-ip-handling-policy=disable_non_proxied_udp` + `--force-webrtc-ip-handling-policy` (WebRTC-UDP закрыт);
   - контекст: `serviceWorkers: "block"`, `context.routeWebSocket("**", ws => ws.close())` до создания page, `context.route` — **allowlist-режим**: пропускаются только запросы на точный `captureOrigin` с нормализованным путём ∈ `allowedUrls` (включая redirect-цепочки), всё прочее — включая иной loopback-порт и IPv6 `[::1]` — abort;
   - adversarial e2e: custom-бандл пробует внешние `fetch`, WebSocket, Service Worker, RTCPeerConnection, WebTransport **и GET/POST/redirect на соседний HTTP-сервер на другом loopback-порту** — всё блокируется;
   - остаточный риск фиксируется в docs: published-код по модели доверия проекта равен коду репозитория (см. docs/server-api.md «Граница доверия»), egress-блок — defense-in-depth.
3. **Аутентификация капчера — scoped capture-session**: discriminated запись `{token(32B random), kind: "prototype"|"component", allowedUrls: string[] (точный immutable snapshot), expected (см. E.4), props? (component — только в сессии/bootstrap, не в URL), expiresAt}` в памяти. **Snapshot цели фиксируется при enqueue** (E.4); при dequeue создаются только token и allowedUrls; TTL токена = hard job deadline (60s) + 30s, токен многоразовый в рамках job'а, revoke в `finally`. `allowedUrls`: конкретный capture-route+query, конкретный revision/version endpoint, pinned bundle URLs, pinned `/api/assets/:id` (транзитивно: из документа, компонентов и DS-версии), pinned `/api/design-systems/:id/versions/:v`, `/api/shims/*`, транзитивная статика SPA из Vite-манифеста (js/css/`/fonts/*`/index). **Доставка bootstrap в SPA**: worker перед navigation делает `page.addInitScript()` c frozen-объектом `__EUI_CAPTURE_BOOTSTRAP__ = {kind, target, props?, expected}` — page JS не нуждается в токене; header остаётся транспортной авторизацией запросов. Worker шлёт `X-EasyUI-Capture: <token>` только на loopback-origin (`context.route`-инжект по exact origin). Сервер принимает токен только при: `server.requestIP()` ∈ loopback (все формы), метод GET/HEAD, нормализованный decoded-путь ∈ allowedUrls. `createHandler` переводится на `fetch(request, server)`.
4. **Async job API**: `POST /api/prototypes/:id/screens/:screenId/screenshot` `{rev?|version?, viewport, deviceScaleFactor?, theme?, waitForFonts?}` → `202 {jobId}`; **POST атомарно резолвит цель** в `expected = {kind:"prototype", rev, pins, componentManifestHash, builtinCatalogHash, dsMetaVersion, rendererBuild}` (для component-капчера — `{kind:"component", componentId, version, bundleHash, propsHash, dsMetaVersion, rendererBuild}`) и сохраняет в job — queued job не может «уехать» на более поздний head. `GET /api/screenshot-jobs/:jobId` → `{status: queued|running|done|error, result?, error?}`. **Bounds**: width ∈ [64, 2000], height ∈ [64, 4000], dsf ∈ {1,2,3}, width×height×dsf² ≤ 20 Mpx (422 при превышении); hard job deadline 60s; PNG подчиняется asset-лимитам (5 MiB / 16 Mpx); required-font failure → job error (не тихий fallback). Пул concurrency=1, очередь ≤5 (429). Jobs in-memory, TTL результата 10 минут (PNG остаётся в assets). Без браузера/дистa → 501 `screenshot_unavailable` сразу на POST (ApiError расширяется 429/501). Dev: при `SERVE_DIST` (иначе 501 с message).
   **Доказательство снапшота**: capture-shell выставляет discriminated `__EUI_CAPTURE_READY__` той же формы, что `expected` (плюс `status:"ready"|"error"`, `error?`); worker строго канонически сравнивает все поля с `session.expected` (включая `builtinCatalogHash`; `rendererBuild` инжектится bootstrap'ом и эхом возвращается) и падает при mismatch; `status:"error"` — быстрый fail вместо таймаута. Хеши добавляются в revision DTO additively (сейчас их там нет — `server/repos/prototypes.ts:129`).
5. **Component capture harness** (нужен до visual): роут `/capture/component/:id/:version` — рендер published-компонента через loader, readiness-протокол component-формы (E.4). Props: в браузере (Library-превью) — **только** `?props=example` (example из манифеста, никаких произвольных props в URL); произвольные props — только через capture-session bootstrap (E.3) в worker-капчере.
6. **Visual references**: `visual_references(id, fingerprint_json UNIQUE, asset_id FK, note, created_at)` где fingerprint = `{scope: "prototype-screen"|"component", prototypeId?, screenId?, componentId?, refRevision|refVersion, propsHash?, stateHash?, viewport, deviceScaleFactor, theme}`; `visual_runs(id, reference_id FK, candidate_asset_id, diff_asset_id?, metric, metric_options_json, diff_pixels, total_pixels, diff_percent, status('pass'|'fail'|'error'|'reference_missing'), candidate_meta_json(rev/version/pins/rendererBuild/browser), created_at)`.
   - `PUT /api/visual-references` (upsert по fingerprint), `GET /api/visual-references?scope&id`, `POST /api/visual-references/:id/check {rev?|version?, threshold?}` — capture → сравнение в **worker'е** (pixelmatch+pngjs там же, не в Bun-процессе): метрики честно именуются `exact-rgba` (полное попиксельное равенство) и `pixelmatch-v1` (все options в `metric_options_json`); никакого «AE». Несовпадение dimensions → `error` без процента.
   - **Evidence guard**: нет reference для fingerprint → `{status:"visual_reference_missing", pixelDiffPercent:null}`; отчёт всегда содержит оба sha256, dimensions, числитель/знаменатель, metric+options.
   - UI `/visual`: список references, история runs, side-by-side + diff-изображение.

### F. Tokens/fonts/icons + версии темы (P1 §7)

1. **Immutable-версии**: `design_system_versions(system_id FK, version INTEGER, tokens_json, fonts_json, icons_json, created_at, PK(system_id,version))`. `PATCH /api/design-systems/:id` (custom-only; builtin → 405) с `{tokens?, fonts?, icons?, baseVersion}` создаёт версию `baseVersion+1` (CAS). `GET /api/design-systems/:id` отдаёт `latestMetaVersion` и содержимое последней; `GET .../versions/:v` — immutable.
2. **Грамматика**: token-ключ `^[a-z][a-z0-9]*(\.[a-z0-9-]+)*$`, значение — строка ≤256 без `;{}<>` или конечное число; fonts `[{family(safe), src: assetId, weight?, style?}]` — **только** asset-backed; icons `[{name(slug), assetId, viewBox?, themes?{light?,dark?}}]` — assetId валидируются.
3. **Пин**: `prototype_revisions.design_system_meta_version INTEGER NULL` — на save фиксируется latest; player/capture загружают именно пиновую версию (по head — latest). Acceptance «prototype pins design-system version» выполняется по-настоящему.
4. **Доставка**: инжект `<style>` — токены → `--eui-<key с '.'→'-'>`, шрифты → `@font-face` c `/api/assets/...`; сериализация экранированная (значения через CSS.escape-эквивалент на нашей стороне, генерация только из провалидированной грамматики). Shim `easy-ui/runtime` (только shims v2 / `hostAbiVersion: 2`, см. B.5) экспортирует `token(key)` (читает CSS-переменную/снапшот из `__easyUiShared.tokens`) и `Icon({name,size,theme?})` (рендер `<img src=/api/assets/...>` по icon-registry текущей системы+версии).
5. Font loading status — в inspector (`document.fonts` статусы).

### G. OpenAPI, JSON Schema, capabilities (P1 §8)

1. **Route contracts как единый источник**: декларативный реестр маршрутов `server/contracts.ts` — `{method, path, params, requestSchema?, responseSchema, errors[]}`; runtime-роутер маршрутизирует **по нему** (обёртка над существующими handlers валидирует вход по contract'у), генератор `scripts/generate-openapi.ts` строит OpenAPI 3.1 из того же реестра (`z.toJSONSchema`). `server/openapi.json` коммитится, drift-check в verify. Contract-тест обходит все endpoints и сверяет фактические ответы со схемами.
2. `GET /api/openapi.json`, `GET /api/schemas/prototype-document.json`, `GET /api/schemas/component-definition.json`.
3. `GET /api/capabilities`: `{apiVersion, documentVersion, actions, directives, paramSources:["$event","$elementId","$itemIndex","$itemKey"], conditions, limits, designSystems, features{...}}`.
4. Issues: legacy `path` (как есть) + новое поле `pointer` (RFC6901-корректный string, с escape `~0/~1`) добавляется централизованно в `errorResponse`.

### H. Inspector (P2 §12) и Library/gallery (P1 §10)

1. **Inspector**: инструментированный store — `createStateStore(initial)` оборачивается прокси с логом `set/update` (prev/next diff на уровне store); custom event-адаптер логирует `{correlationId, elementId, component, event, payload, payloadValid, actions[{action, params, $if result}], navTarget}`; терминальные handlers логируют navigate/back/openUrl/restart; + font loading, runtime-ошибки payload/slots/repeat-limit. UI-панель в player за `?debug=1`, лента 50 записей. Модуль `src/player/inspector/`.
2. **Library**: живое превью custom-компонентов — iframe на capture-shell компонента (`/capture/component/:id/:version?props=example`, E.5). Статус-фильтры: `Published / Visual pending / Verified / Blocked / Rejected` — verification key = `{componentId, version, propsHash(example), metaVersion темы, viewport, theme}`; `Verified` только при pass-run последнего check ровно этого ключа. Метадата `variants/states` — **declined** (нет источника в definition-контракте; в acceptance matrix). Figma-бейдж из J.

### I. Semantic validation (P2 §13)

Политика: существующие hard errors **не** ослабляются. Definition metadata расширяется: `capabilities`, `interactive?: boolean` (custom; builtin — таблица в `src/catalog/`), `accessibleLabelProps?: string[]`, `urlProps?: string[]`. Новые warnings:
- interactive-компонент размещён без единого обработчика в `on`;
- событие с payload-схемой обработано действием без использования `$event` при наличии в шаблоне повторяемого контекста без item identity;
- интерактивный элемент без accessible label (по `accessibleLabelProps`/текстовому ребёнку);
- inline base64 в string-props длиной >100KB (любой prop);
- ≥2 screens и ни одного `navigate` между разными screens;
- экран, чей root — единственный custom-компонент уровня page/organism без children (монолит-подсказка);
- `urlProps` со значением-путём вне `/api/assets/` и не начинающимся с `/` public-конвенций — предупреждение о недоступности в runtime.
`$event`/slots/repeat-валидации перечислены в B/C. Unreachable screens, unknown navigate target — уже есть.

### J. Figma provenance (P2 §11)

Immutable на ревизиях: колонка `figma_json TEXT NULL` в `prototype_revisions` и `component_revisions` (принимается в POST/PUT рядом с doc/source, strict-схема `{fileKey, nodeIds[], referenceScreenshots[assetIds], lastSyncedAt}`; referenceScreenshots валидируются по assets). Head-meta отдаёт provenance головной ревизии; read-back ревизии/версии — её собственную. Restore копирует figma_json вместе с ревизией. Library/Gallery — бейдж.

### K. Статусы версий компонентов (P2 §14)

1. Статусы: `staging|active|failed|rejected|deprecated|superseded|archived` (+`status_reason`, `superseded_by`, `status_rev INTEGER DEFAULT 1`). Миграция пересоздаёт `component_publishes` **строгим алгоритмом**: `PRAGMA foreign_keys=OFF` в этой миграции невозможен внутри транзакции → порядок: снять копии **всех** FK-child таблиц parent'а на момент миграции (`prototype_revision_components`, `component_publish_assets` из v5, будущие) во временные, DROP children, rebuild parent (все PK/UNIQUE/FK/CHECK), восстановить children с FK и индексами, `PRAGMA foreign_key_check`, только затем bump `user_version`. Тест на populated-копии v3 (active/failed/staging, soft-deleted, несколько pinned revisions) — фикстура из `.backups/`-подобного снапшота, синтезированного тестом.
2. **Transition matrix** (`POST /components/:id/versions/:version/status {status, reason?, supersededBy?, baseStatusRev}`): `active → rejected|deprecated|superseded|archived`; `deprecated|superseded → archived|active`; `rejected → archived`; `archived → (нет)`; staging/failed — не управляются вручную. CAS по `status_rev` (не headRev). `superseded` требует `supersededBy`: та же component, версия существует, не self, без циклов.
3. **Семантика исполнения**: новые пины/manifest — только `active`. Существующие пины: `active|deprecated|superseded` рендерятся (render-status warning `pin_deprecated|pin_superseded`), `rejected|archived|failed|staging` → `bundle_failed` (rejected может означать вредный код — не исполняем). Metadata любой версии остаётся читаемой. Library — бейдж+reason.

## Acceptance matrix (фидбэк → реализация)

| Критерий фидбэка | Статус | Где |
|---|---|---|
| §1 render-status, коды ошибок, canonical URLs, renderable | ✅ | A |
| §1 «route после publish без ручной диагностики ingress» | ⚠️ частично: external ingress probe вне scope (нет доступа к ingress) | A.2 |
| §2 payload в setState/navigate | ✅ ($event) | B.3 |
| §2 payload в openUrl | ❌ declined: статический URL — security | B.3 |
| §2 conditional actions | ✅ (`$if`, custom-события; builtin — fail-closed отказ валидации) | B.3 |
| §2 payload у builtin events | ⚠️ declined: `emit` библиотеки без payload; custom-only | B.2 |
| §2 debug mode показывает payload | ✅ | H.1 |
| §2 старые payloadless events работают | ✅ | B.2 |
| §3 named slots (несколько regions) | ✅ custom-компоненты | C.2 |
| §3 $each из state, item+index в template, events с item context | ✅ | C.1, C.3 |
| §3 валидация slots/templates, лимиты | ✅ | C.1-2 |
| §3 reusable composites, local state scope | ❌ declined: покрыто custom components | C.4 |
| §4 asset API, dedup SHA-256, MIME/size, content-addressed, read-back pins | ✅ | D |
| §4 multi-file package / локальные imports | ❌ declined: asset-URL закрывает кейс | D.6 |
| §4 «нельзя опубликовать file:// путь» | ✅ (валидации URL v1 + I) | I |
| §5 screenshot: revision+pins, console errors, fonts/idle, themes/viewport, CI-воспроизводимость | ✅ | E.1-4 |
| §6 visual: references, привязка, capture, diff, история, evidence guard | ✅ (метрики exact-rgba + pixelmatch-v1, не «AE») | E.6 |
| §7 tokens versioned, token helper, font status, icon registry, prototype pin версии темы | ✅ | F |
| §8 OpenAPI, JSON Schemas, capabilities, validation errors с path | ✅ | G |
| §9 lifecycle-модель | ✅ (validation records; deployedVersion опущен как тавтология single-server) | A.4 |
| §10 автогалерея: превью, фильтры статусов | ✅ | H.2 |
| §10 variants/states metadata | ❌ declined: нет источника в контракте definition | H.2 |
| §11 Figma provenance на ревизиях | ✅ | J |
| §12 interaction inspector | ✅ | H.1 |
| §13 semantic warnings | ✅ (список скорректирован под существующие hard errors) | I |
| §14 статусы rejected/deprecated/superseded/archived + reason | ✅ | K |

## Сквозная безопасность

- Safe JSON Pointer parser (`src/prototype/pointer.ts` + серверный реюз): запрет `__proto__/prototype/constructor`-сегментов во **всех** записях/биндингах/repeat/`$event`-путях; store оборачивается hardened-обёрткой (null-prototype контейнеры при set).
- Asset-заголовки (D.3), magic bytes, pixel limits.
- Capture-token: TTL = job deadline + 30s, discriminated audience + allowedUrls, loopback `server.requestIP`, GET/HEAD allowlist, egress-блок в worker (SW block, WS close, route abort).
- Rejected-бандлы не исполняются (K.3).

## Волны исполнения (file ownership; каждая задача — свежий Codex-диспатч)

Миграции: **по одной на фичу**, нумерация строго по merge-порядку волн (runner назначает версии позицией в массиве — пропуски невозможны): v4 validation_records (T1) → v5 assets (T2) → v6 visual (T7) → v7 design_system_versions (T8) → v8 statuses (T10) → v9 figma (T12). Правки `migrations.ts` сериализуются: внутри волны 4 T8 коммитится до T10; T12 (волна 5) — после T10. Rebuild `component_publishes` (v8) обязан сохранять/пересоздавать **все** FK-child таблицы на момент миграции, включая `component_publish_assets` из v5 (+их индексы), с `PRAGMA foreign_key_check`; тесты: populated v3→latest и populated pre-status→latest.

### Волна 1 (последовательно внутри, T3 параллельно)
- **T1. Static fallback + render-status + canonical URLs + lifecycle + contracts-каркас** (A, G.1-каркас: реестр contracts вводится сразу, чтобы новые endpoints регистрировались в нём). Файлы: `server/static.ts`, `server/main.ts` (переход на `fetch(request, server)`), `server/contracts.ts` (новый), `server/routes/{prototypes,components}.ts`, `server/repos/prototypes.ts`, `server/routes/renderStatus.ts` (новый), миграция validation_records, `server/http.ts` (статусы 429/501, pointer в issues), тесты, `docs/server-api.md`.
- **T2. Asset registry + $asset + пины** (D целиком, включая фронтовую часть $asset). Файлы: миграция assets, `server/routes/assets.ts`, `server/repos/assets.ts`, `server/assets/validate.ts` (magic bytes), `server/validation.ts` (collectAndValidateAssetRefs), `src/prototype/{schema,validate,runtimeSpec}.ts` ($asset), `src/prototype/pointer.ts` (safe parser — вводится здесь, T3/T4 переиспользуют), тесты, docs. Старт после коммита T1.
- **T3. Repeat + $item/$index + лимиты** (C.1). Файлы: `src/prototype/{schema,validate,runtimeSpec}.ts` — конфликт с T2! → T3 стартует после коммита T2. Итого волна 1: T1 → T2 → T3 последовательно (общие файлы), зато задачи маленькие.

### Волна 2 (события/слоты)
- **T4. Event-адаптер: typed payloads, $event, $if, EasyUIComponentProps, shims v2, side-channel runtimeSpec** (B). Файлы: `src/customComponents/loader.ts`, `src/catalog/{normalize,runtime,actions}.ts`, `src/prototype/{validate,runtimeSpec}.ts` (новая сигнатура `toRuntimeSpec(spec, {definitionsMeta})` + карта side-channel), **все callsites**: `src/player/{PlayerShell,ScreenView,PrototypeLoader}.tsx`, `src/cjm/`, `src/editor/EditorCanvas.tsx`, `server/components/{types,pipeline,extract-subprocess,compile}.ts`, `server/shims/` (v2), docs.
- **T5. Named slots + item-context событий** (C.2-3). После T4 (loader общий). Файлы: loader, `src/prototype/{schema,validate,runtimeSpec}.ts`, docs.

### Волна 3 (капчер)
- **T6. Capture-shell (prototype+component) + worker + screenshot endpoint + Dockerfile + capture-auth** (E.1-5). Файлы: `src/capture/` (новый), `src/app/routes.tsx`, `scripts/screenshot-worker.mjs`, `server/screenshot/`, `server/main.ts`, `Dockerfile`, `package.json`, docs.
- **T7. Visual references + runs + UI /visual** (E.6). После T6. Файлы: миграция visual, `server/routes/visual.ts`, `server/repos/visual.ts`, `src/visual/`, `src/app/routes.tsx`, docs.

### Волна 4 (параллельно: серверные зоны не пересекаются)
- **T8. Design-system versions: tokens/fonts/icons + PATCH + инжект + token()/Icon** (F). Файлы: миграция ds-versions, `server/routes/designSystems.ts`, `server/designSystems.ts`, `server/shims/`, `src/designSystems/`, `src/player/` (инжект), docs.
- **T9. OpenAPI-генератор + schemas + capabilities + contract-тест** (G, поверх каркаса T1). Файлы: `scripts/generate-openapi.ts`, `server/openapi.json`, `server/routes/meta.ts`, `package.json` (verify), тесты, docs.
- **T10. Статусы версий + миграция rebuild + transition matrix** (K). Файлы: миграция statuses (+populated-тест), `server/repos/components.ts`, `server/routes/components.ts`, docs.

### Волна 5 (параллельно)
- **T11. Inspector** (H.1). Файлы: `src/player/inspector/`, `src/player/PlayerShell.tsx`, хуки в loader/runtime (после T4/T5), docs.
- **T12. Library-превью + статус-фильтры + Figma provenance (API+UI)** (H.2, J). Файлы: миграция figma, `src/library/`, `server/routes/*` (figma поля), `server/repos/*`, docs.
- **T13. Semantic validation pack + definition metadata** (I). Файлы: `src/prototype/validate.ts`, `src/catalog/`, `server/components/*` (metadata), docs.

### Волна 6
- **T14. Интеграция**: демо-прототип (repeat+slots+$event+$asset+tokens), `npm run verify`, `npm run e2e`, runtime-прогон `/verify`, обновление CLAUDE.md-зон.

## Done-критерии (сквозные)

- `npm run verify` и `npm run e2e` зелёные после каждой волны.
- Каждый endpoint зарегистрирован в contracts и покрыт тестом (happy + error envelope); contract-тест зелёный.
- `curl` без `Accept` → 200 text/html на `/p/<id>/s/<screen>`.
- Демо-сценарии волны 6 работают в runtime-прогоне.
- Обратная совместимость: существующие `prototypes/*.json` валидны; payloadless events и компоненты без capabilities работают; ABI v1 не изменён.
- Миграции проходят на populated v3-копии.

## Триаж ревью v1 (Codex, 2026-07-12)

Blockers 1–6: **приняты** — event-адаптер вместо SetState-factory (B.2), слот-роутинг по индексам до рендера + EasyUIComponentProps (C.2), capture-shell с rev/version + 501 в dev без dist (E.1, E.4), `server.timeout` + очередь (E.4), capture-session c requestIP/allowlist/egress-блоком (E.3), строгий rebuild-алгоритм миграции + populated-тест (K.1).
Majors 7–24: **приняты** — acceptance matrix добавлена (7); repeat-лимиты/семантика уточнены, $itemKey через метадату (8); readiness-протокол и пул (9); fingerprint + честные метрики + component harness до visual (10); transition matrix + statusRev + rejected не исполняется (11); validation records вместо фиктивных полей, deployedVersion опущен (12); asset-заголовки/magic bytes/лимиты (13); полный sha256-id, atomic write, component asset pins (14); $asset-декомпозиция исправлена (15); immutable design_system_versions + грамматика + Icon API (16); инструментированный store (17); safe-pointer hardening (18); route contracts + pointer + статусы 429/501 (19); figma на ревизиях (20); verification key (21); политика hard-errors + definition metadata (22); раздельные статусы route/document/bundles, `route_not_ready` сохранён (23); миграция на фичу (24). Minor 25: **принят** (exact `playwright`, протокол worker, diff в worker'е).
Отклонений нет; сужения scope перечислены в acceptance matrix как declined с обоснованиями.

## Триаж ревью v3, раунд 3 (Codex, 2026-07-12)

Все 9 находок **приняты**: (1) глобальный repeat-бюджет 2000 в hardened store на загрузке и каждой мутации + статические запреты (nested repeat, ≤20 repeat/экран, Hotspot в repeat), initial overflow — ошибка (C.1); (2) bootstrap через `page.addInitScript`, props только в сессии, отдельная component-форма ready-схемы, base64-props удалены из E.5/H.2 (E.3–E.5); (3) `serviceWorkers:"block"` + `routeWebSocket` close + adversarial e2e (E.2); (4) RuntimeTree с атомарными `stripEvents`/`splitCanvas`, editor-metadata без `on`, Hotspot-в-repeat запрещён (B.2); (5) snapshot цели при enqueue, discriminated expected/ready, сравнение builtinCatalogHash, транзитивная статика в allowedUrls (E.3–E.4); (6) bounds viewport/DSF/Mpx + hard deadline 60s + font-failure=error (E.4); (7) `EasyUiActionRuntime` в T4 с screenIds/dispatchTerminal и формальной семантикой params (B.2); (8) ABI = max(imports, capabilities), контракт easy-ui/runtime целиком в T4, T8 — только данные (B.5); (9) противоречия K.1/TTL/E.5/H.2 устранены в первичных секциях.

## Триаж ревью v2, раунд 2 (Codex, 2026-07-12)

Все 11 находок **приняты**: (1) side-channel карта через `EasyUiRuntimeContext`, в props — только строковый `__euiKey`, namespace `__eui*` зарезервирован (B.2); (2) `$if`/param sources — custom-only c fail-closed валидацией, адаптер заменяет и `emit`, и `on()` (B.2–B.3); (3) собственный executor вместо `execute()` для state-действий + запрет `$`-ключей в payload (B.2); (4) запрет `repeat`+named slots на одном элементе, `children === slots.default`, `$itemKey` требует `repeat.key` (C.2–C.3); (5) async job API 202+poll, токен при dequeue, TTL от job deadline, revoke в finally (E.3–E.4); (6) discriminated capture-session с точным `allowedUrls`-снапшотом, props в сессии (E.3); (7) readiness-union ready|error + канонсравнение с session.expected + хеши в revision DTO (E.4); (8) перенумерация миграций по merge-порядку + сериализация правок migrations.ts + rebuild сохраняет все FK-children включая `component_publish_assets` (§Волны); (9) shims v2 + `hostAbiVersion: 2` для компонентов с `easy-ui/runtime` (B.5); (10) `toRuntimeSpec(spec, {definitionsMeta})` + все callsites в ownership T4 (B.2, T4); (11) fail-closed сериализация event-схем, `parsed.data`, канонический JSON Schema (B.6).
