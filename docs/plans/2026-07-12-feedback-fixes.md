# План: устранение проблем из developer-фидбэка (2026-07-12)

Источник: `docs/easy-ui-developer-feedback.md` (перенос 50+ компонентов Yandex Pay). Покрываем все 14 пунктов: P0 §1–5, P1 §6–10, P2 §11–14. Исполнение — волнами Codex по зонам владения файлов; порядок волн отражает зависимости, а не только приоритеты фидбэка.

## Ключевые факты разведки (на них опирается план)

- **SPA fallback 404** (`server/static.ts:12-14`): `index.html` отдаётся только при `Accept: text/html`, без расширения и вне `/api`. Любой programmatic клиент (curl, screenshot-фетчер) получает 404 на `/p/:id/s/:screenId`. Это корень P0 §1.
- **События без payload**: `events?: string[]` везде (`src/catalog/normalize.ts:4-12`, `server/components/types.ts`, `docs/prototype-format.md:46` «Events carry no payload»). Params действий — только статические литералы (`src/prototype/validate.ts:180`).
- **`setState/pushState/removeState` обрабатывает библиотека** внутри `JSONUIProvider`; наш runtime отдаёт no-op factory (`src/catalog/runtime.ts:54-58`). Чтобы резолвить `$event` в params, придётся отдавать **реальную** SetState-factory/handlers из easy-ui.
- **json-render уже умеет repeat**: `UIElement.repeat {statePath, key?}`, `RepeatScopeProvider`, `$item`/`$index`/`$bindItem` (`@json-render/core` d.ts, `@json-render/react/dist/index.js:1113-1140`). v1 их запрещает искусственно (`schema.ts` strictObject + reserved list).
- **Named slots в Renderer нет**: `slots: string[]` в каталоге — метаданные; все children сливаются в один `children` ReactNode (`@json-render/react/dist/index.js:1076-1108`).
- **Custom-компоненты оборачивает наш loader** (`src/customComponents/loader.ts:33-71`) — легальная точка для slot-роутинга и emit-перехвата без форка библиотеки.
- **Playwright есть только как devDependency e2e**; в prod-образе браузера нет — screenshot endpoint требует правки Dockerfile.
- Ошибочный envelope, sha256-хелперы, immutable-паттерны, CAS/baseRev — уже есть и переиспользуются (`server/http.ts`, `server/components/pipeline.ts:9`).
- Хранилище — SQLite (WAL, strict), миграции forward-only `server/migrations.ts` (user_version=3 сейчас).

## Архитектурные решения

### A. Каноничный URL и render-status (P0 §1, P1 §9)

1. **Починка fallback**: в `serveStatic` отдавать `index.html` для любых `GET/HEAD` запросов вне `/api/`, `/storybook/`-файлов и путей с расширением, **без** проверки `Accept`. 404 остаётся для путей с расширением, которых нет на диске.
2. **`GET /api/prototypes/:id/screens/:screenId/render-status`** (+ вариант `?version=n`): собирает по head-ревизии (или версии) `{status, url, revision, publishedVersion, resolvedPins, bundleStatus, renderable, errors[]}`. Коды ошибок: `prototype_not_found`, `screen_not_found`, `bundle_failed` (пин ссылается на не-active publish), `revision_not_published` (запрошенная версия отсутствует), `route_not_ready` не нужен после починки fallback — оставляем в enum для совместимости, но сервер его не выдаёт.
3. **Canonical URLs в ответах save/publish**: additively — `screens: [{id, url}]` в ответ `POST/PUT /prototypes` и `POST /publish` (url версии — `/p/:id/v/:n/s/:sid`).
4. **Lifecycle-поля** (P1 §9): в `GET /prototypes/:id` и `GET /components/:id` добавить `draftRevision` (=headRev), `validatedRevision` (=headRev — save всегда валидирует), `publishedVersion` (=latestVersion), `deployedVersion` (= publishedVersion — single-server), `renderable: boolean` (агрегат render-status по startScreen для прототипа; для компонента — наличие active-версии). Семантика документируется в `docs/server-api.md`.

### B. Типизированные event payloads + `$event` (P0 §2, часть P2 §12)

1. **Формат объявления**: `events` в definition принимает `string[]` (legacy) **или** `Record<name, ZodSchema>` (custom TSX) / `Record<name, JSONSchema>` (persisted `DefinitionMeta.eventsSchema`, manifest, design-systems API). Нормализация в `src/catalog/normalize.ts` приводит обе формы к `{name, payloadSchema?}`; наружу `events: string[]` сохраняется для обратной совместимости, новое поле `eventPayloads?: Record<name, JSONSchema>` — additive.
2. **Доставка payload**: в loader-обёртке custom-компонентов перехватываем `emit(name, payload?)` — payload валидируется схемой (в dev — ошибка в консоль/inspector, в prod — предупреждение) и кладётся в event-контекст диспатча. Для builtin-компонентов payload появляется только если библиотека его реально передаёт — выяснить по исходникам `@json-render/react`/`shadcn` на исполнении; если emit туда не прокидывает данные, builtin остаются payloadless (допустимо: боль фидбэка — custom).
3. **Свои handlers для state-действий**: `createPlayerRuntime` отдаёт реальную SetState-factory (вместо no-op), реализующую `setState/pushState/removeState` через store с резолвом param-источников:
   - `{"$event": "/json/pointer"}` — указатель внутрь payload (`""` — весь payload);
   - `{"$elementId": true}` — ключ элемента;
   - `{"$itemIndex": true}` / `{"$itemKey": true}` — из repeat-scope (см. C).
   Терминальные действия (`navigate/openUrl`) получают те же источники в params (например, `screenId` из `$event` **не** поддерживаем — навигация остаётся статической, это осознанное сужение против injection; `openUrl.url` тоже остаётся статическим).
4. **Валидация**: `src/prototype/validate.ts` — `$event`-указатель допустим только в событии, чей payload-schema объявлена и указатель типобезопасен по JSON Schema (best-effort: проверка существования property-пути; unknown-путь — warning). Payloadless событие + `$event` — ошибка.
5. **Формат-док**: `docs/prototype-format.md` — снять «Events carry no payload», описать `$event/$elementId/$itemIndex/$itemKey` как источники значений только в `params` действий.

### C. Композиция: repeat/templates + named slots (P0 §3)

1. **Repeat (нативный)**: разрешить в `elementSchema` опциональный `repeat: {statePath, key?}` — passthrough в runtime-spec. Внутри поддерева repeat разрешаются `$item`/`$index` в props (passthrough — библиотека резолвит) и `$bindItem`. Валидация: `repeat.statePath` — валидный указатель; `$item`/`$index` вне repeat-поддерева — ошибка; глубина/лимиты прежние. Это и есть «$each + item template»: template — обычное поддерево children повторяемого элемента.
2. **Named slots — только для custom-компонентов** (боль фидбэка именно там; builtin остаются с одним `children`):
   - в `elementSchema` — опциональный `slot: slug` у ребёнка;
   - loader-обёртка группирует React-children по `data-slot`-маркерам: адаптер `toRuntimeSpec` оборачивает slot-детей в синтетический builtin `SlotMarker` (наш компонент, рендерит `<div data-eui-slot>` прозрачно), а обёртка custom-компонента до рендера разбирает children на `Record<slotName, ReactNode>` и передаёт **новым** полем `slots` в `BaseComponentProps` (ABI-additive: старые компоненты его игнорируют);
   - валидация: `slot` допустим только если родитель — custom-компонент, объявивший это имя в `definition.slots`; неизвестный slot — ошибка; дети без `slot` идут в `default`.
3. **Event bubbling с item-контекстом**: emit внутри repeat-scope дополняет диспатч-контекст `$itemIndex`/`$itemKey` (loader-обёртка читает `useRepeatScope`). Для builtin внутри repeat `$itemIndex` берётся из scope на этапе резолва params (внутри нашей SetState-factory — scope прокидывается через контекст диспатча).
4. **Reusable composite definitions и локальный state scope** — **отложено** (post-scope): закрывается связкой repeat+slots+custom components; фиксируем в плане как declined с обоснованием «дублирует custom components в MVP».

### D. Asset registry (P0 §4)

1. Таблица `assets(id TEXT PK, sha256 TEXT UNIQUE, mime, size INTEGER, original_name, created_at)` + байты на диске `DATA_DIR/assets/<sha256>` (не в SQLite — дешёвый backup, потоковая отдача).
2. `POST /api/assets` — raw body (`Content-Type` = mime) либо multipart c одним файлом; лимит 5 MiB; allowlist mime: png, jpeg, webp, gif, svg+xml, woff2, ttf, otf. Дедуп: существующий sha256 → 200 с тем же `id` (id = `asset_<sha256[0:16]>` — content-addressed). Ответ: `{id, url:"/api/assets/<id>", sha256, mime, size, deduplicated}`.
3. `GET /api/assets/:id` — immutable cache, correct content-type; SVG отдаётся с `Content-Disposition: inline` и CSP-safe заголовками (`Content-Security-Policy: script-src 'none'`) против XSS.
4. **`$asset` директива**: `{"$asset": "asset_..."}` допустима в prop, где ожидается URL (`Image.src` и props custom-компонентов); резолв в `toRuntimeSpec` → строка `/api/assets/<id>`. Валидация на save: asset существует; несуществующий — ошибка. Пины assets по ревизии: таблица `prototype_revision_assets(prototype_id, rev, asset_id)` — read-back показывает hash/pins.
5. Multi-file component package — **отложено** (фидбэк предлагает как альтернативу; asset URL из custom TSX закрывает кейс: `/api/assets/<id>` — same-origin absolute path).

### E. Screenshot endpoint + visual regression (P0 §5, P1 §6)

1. **Worker**: `server/screenshot/worker.ts` — запускается subprocess'ом (`node scripts/screenshot-worker.mjs` c playwright chromium; playwright переезжает из devDependencies в dependencies **только** если прод должен уметь скриншоты — да, должен: Dockerfile добавляет `npx playwright install --with-deps chromium`). Worker открывает `http://127.0.0.1:<port>/p/:id/s/:sid` (или `/v/:n/`), с internal-bypass Basic Auth (loopback-запрос с сгенерированным одноразовым токеном в заголовке — сервер принимает `X-EasyUI-Internal: <token>` только с 127.0.0.1), ждёт fonts/network-idle, собирает console/page errors, снимает PNG.
2. **`POST /api/prototypes/:id/screens/:screenId/screenshot`** `{revision?|version?, viewport{width,height}, deviceScaleFactor?, theme?, waitForFonts?}` → синхронно (таймаут 30s) `{imageUrl, assetId, width, height, consoleErrors, pageErrors, bundleHash: componentManifestHash, componentPins}`. PNG сохраняется в asset registry (дедуп бесплатно). Отсутствие браузера в окружении → 501 `screenshot_unavailable` с понятным message (dev без установленного chromium).
3. **Visual references** (P1 §6): таблицы `visual_references(id, scope('prototype-screen'|'component'), prototype_id?, screen_id?, component_id?, viewport_w, viewport_h, theme, asset_id, note, created_at)` и `visual_runs(id, reference_id, candidate_asset_id, diff_asset_id?, metric('AE'), diff_pixels, total_pixels, diff_percent, status('pass'|'fail'|'error'), created_at, revision/version snapshot)`.
   - `PUT /api/visual-references` (создать/заменить reference: asset + метаданные), `GET /api/visual-references?prototypeId=...`;
   - `POST /api/visual-references/:id/check` — снимает candidate через screenshot-pipeline, сравнивает `pixelmatch` (+`pngjs`; новые прод-зависимости), пишет diff-image в assets, возвращает отчёт с dimensions/sha256 обоих файлов/metric/diff-числами. Несовпадение dimensions → `status:"error"`, без процента.
   - **Evidence guard**: нет reference → `{status:"visual_reference_missing", pixelDiffPercent:null}`; процент выдаётся только при физических файлах + sha256 + dimensions + числителе/знаменателе (все поля обязательны в ответе).
   - UI: страница `/visual` (или вкладка в Library): список references, история runs, side-by-side + diff.

### F. Токены/шрифты/иконки дизайн-системы (P1 §7)

1. Колонки в `design_systems`: `tokens TEXT(JSON)`, `fonts TEXT(JSON)`, `icons TEXT(JSON)`, `meta_rev INTEGER DEFAULT 1` (версия метаданных, инкремент на каждое изменение). `PATCH /api/design-systems/:id` (только custom-систем; builtin — 405) принимает `{tokens?, fonts?, icons?, baseMetaRev}` (CAS по meta_rev). Token-значения: строки/числа; ключи — dot-path. Fonts: `[{family, src: asset_id|url, weight?, style?}]`; icons: `[{name, assetId, viewBox?, themes?}]`.
2. **Доставка в runtime**: player при загрузке системы инжектит `<style>`: токены → CSS custom properties `--eui-<dot-path через ->`, fonts → `@font-face` (src через `/api/assets/...`). Custom-компоненты используют `var(--eui-color-text-primary)`; helper `token("color.text.primary")` — экспорт из нового shim-модуля `easy-ui/tokens` (ABI-allowlist пополняется, shim резолвит из `__easyUiShared.tokens`). Версия tokens пинится в ревизии прототипа: `prototype_revisions.design_system_meta_rev` — read-back показывает, с какой версией темы сохранён прототип (enforcement — post-MVP, как с builtinCatalogHash).
3. Font loading status — секция в interaction inspector (см. H): `document.fonts` статусы.

### G. OpenAPI, JSON Schema, capabilities (P1 §8)

1. `GET /api/openapi.json` — OpenAPI 3.1, генерируется скриптом `scripts/generate-openapi.ts` из декларативной таблицы маршрутов + zod-схем (`z.toJSONSchema`, zod 4 native) в build-time, коммитится как `server/openapi.json`, отдаётся статически; `npm run verify` проверяет свежесть (drift-check).
2. `GET /api/schemas/prototype-document.json` — JSON Schema документа из `prototypeDocSchema` (+ ручные уточнения директив). `GET /api/schemas/component-definition.json` — схема definition-контракта.
3. `GET /api/capabilities` — `{apiVersion, documentVersion: 1, actions:[...], directives:["$state","$bindState","$template","$cond","$event","$asset",...], paramSources, limits{elements:500, depth:50, bodyMiB:1, sourceKiB:256, assetMiB:5}, designSystems:[ids], features:{renderStatus, screenshots, visualRegression, assets, typedEvents, repeat, slots}}`.
4. Validation errors: уже есть `issues[].path` — привести все руты к единому виду (JSON path строкой в поле `pointer` дополнительно к массиву), задокументировать в `docs/server-api.md`.

### H. Interaction inspector (P2 §12) + автогалерея (P1 §10)

1. **Inspector**: панель в player за query `?debug=1` (и кнопка в editor). Источники: внешний `createStateStore` + `onStateChange` (state diff), обёртка action-handlers (наша SetState-factory и терминальные хендлеры логируют `{component, elementId, event, payload, action, params, prev, next, navTarget}`), ошибки payload-валидации, font loading status. Лента последних N=50 записей, кнопка clear. Реализация — отдельный модуль `src/player/inspector/`.
2. **Автогалерея/Library** (P1 §10): custom-компоненты получают живое превью — роут `/library/preview/:componentId/:version` рендерит компонент с `example`-props через существующий loader (изолированный error boundary); карточка Library встраивает превью iframe'ом (как Storybook-карточки). Фильтры Library: по atomicLevel (есть) + по статусу `Published / Visual pending / Verified / Blocked / Rejected` — вычисляется из component_publishes.status + наличия visual reference/последнего run (E.3, K). Данные — только из manifest/API, ручной учёт не нужен.

### I. Semantic validation (P2 §13)

Расширить `validatePrototype` (всё — warnings, кроме отмеченного):
- событие объявлено в definition, но ни один элемент этого типа его не обрабатывает — **не** warning на уровне элемента, а сводный: элемент интерактивного типа без `on` вовсе;
- `navigate` на неизвестный screen — уже ошибка (остаётся);
- недостижимый screen — уже warning (остаётся);
- отсутствующий component pin при чтении ревизии (render-status покрывает);
- `$event`-биндинг без item identity в payload повторяемого элемента;
- интерактивный элемент без accessible label (`aria-label`/`label`/текстовый ребёнок — эвристика);
- `Image.src`/props с base64 > 100KB;
- несколько screens без единого `navigate` между ними;
- экран из единственного custom-компонента-«монолита» (page-level или без children при доступной композиции);
- `Image.src` с относительным путём вне `/api/assets` и не из `public/` — предупреждение о недоступности в player runtime.

### J. Figma provenance (P2 §11)

Опциональное поле `figma` (`{fileKey, nodeIds[], referenceScreenshots[assetIds], lastSyncedAt}`) на компонентах и прототипах: колонка `figma TEXT(JSON)` в `components` и `prototypes` (head-метаданные, не в ревизиях), принимается в POST/PUT (strict-валидация формы), отдаётся в meta/manifest. referenceScreenshots валидируются на существование assets. UI: карточка Library/Gallery показывает бейдж Figma-источника.

### K. Статусы ревизий/версий (P2 §14)

1. Расширить CHECK `component_publishes.status`: `staging|active|failed|rejected|deprecated|superseded` (+ колонки `status_reason TEXT`, `superseded_by INTEGER`). Миграция v4 пересоздаёт таблицу (SQLite CHECK immutable) с переносом данных.
2. `POST /api/components/:id/versions/:version/status` `{status: rejected|deprecated|superseded|active, reason?, supersededBy?, baseRev}` — переходы разрешены только из/в перечисленные (staging/failed — не трогать руками). `superseded` требует `supersededBy`.
3. Резолв пинов и manifest: новые пины и manifest выбирают только `active`; существующие пины на rejected/deprecated версии **продолжают работать** (bundle endpoint отдаёт любую не-staging/failed), render-status помечает их `warnings:["pin_deprecated"]`. Library показывает статус-бейдж и причину.
4. Прототипные версии: аналогичный статус — **отложено** (не запрошено фидбэком явно; компонентных статусов достаточно).

## Отложено (declined) — с обоснованием

- Multi-file component package (D.5) — asset registry закрывает кейс через URL.
- Reusable composite definitions / локальный state scope (C.4) — custom components + slots + repeat покрывают сценарии MVP.
- `$event` в `navigate.screenId`/`openUrl.url` — статичность навигации сохраняется намеренно (безопасность/валидируемость).
- Прототипные version-статусы (K.4).
- Автоматический deploy tokens enforcement (F.2) — пин meta_rev диагностический, как builtinCatalogHash.

## Волны исполнения (file ownership)

Каждая задача — отдельный `--fresh` Codex-диспатч `--write --effort medium`. Верификация оркестратором между волнами. Коммиты — по зонам после верификации.

### Волна 1 (независимые фундаменты, параллельно)
- **T1. SPA fallback + render-status + canonical URLs + lifecycle-поля** (A). Владение: `server/static.ts`, `server/routes/prototypes.ts`, `server/repos/prototypes.ts`, `server/routes/components.ts` (lifecycle-поля meta), новый `server/routes/renderStatus.ts`, `server/main.ts` (маршрут), тесты `server/**/*.test.ts` соответствующих зон, `docs/server-api.md` (§render-status/lifecycle).
- **T2. Asset registry** (D). Владение: `server/migrations.ts` (v4-часть assets — координируется: T2 создаёт migration v4 целиком по спеке плана, включая колонки для F/J/K, чтобы не плодить конфликтующие миграции), новые `server/routes/assets.ts`, `server/repos/assets.ts`, `server/main.ts` (маршрут — non-conflicting добавка согласуется с T1: T1 коммитится раньше, T2 ребейзится оркестратором), `docs/server-api.md` (§assets).
- **T3. Repeat + $item/$index + валидация** (C.1). Владение: `src/prototype/schema.ts`, `src/prototype/validate.ts`, `src/prototype/runtimeSpec.ts`, их тесты, `docs/prototype-format.md`.

Примечание: единственный общий файл волны — `server/main.ts` и `migrations.ts`; чтобы избежать конфликтов, T2 стартует после коммита T1 (полуволна), T3 полностью независим.

### Волна 2 (события и слоты)
- **T4. Typed event payloads + $event + своя SetState-factory** (B). Владение: `src/catalog/normalize.ts`, `src/catalog/runtime.ts`, `src/catalog/actions.ts`, `src/customComponents/loader.ts`, `src/prototype/validate.ts` (после T3), `server/components/{types,pipeline,extract-subprocess}.ts` (eventsSchema в meta), `docs/prototype-format.md`, `docs/server-api.md`.
- **T5. Named slots для custom + SlotMarker + item-контекст событий** (C.2, C.3) — после T4 (общий loader). Владение: `src/customComponents/loader.ts`, `src/prototype/{schema,validate,runtimeSpec}.ts` (координация с T3/T4 — T5 стартует после их коммитов), `src/catalog/` (SlotMarker), docs.

### Волна 3 (скриншоты и visual)
- **T6. Screenshot endpoint + Dockerfile + internal-auth bypass** (E.1, E.2). Владение: `server/screenshot/`, `scripts/screenshot-worker.mjs`, `server/main.ts`, `Dockerfile`, `package.json` (deps), docs.
- **T7. Visual references + diff pipeline + UI /visual** (E.3) — после T6. Владение: `server/routes/visual.ts`, `server/repos/visual.ts`, `src/visual/` (UI), `src/app/routes.tsx`, docs.

### Волна 4 (метаданные системы и API-дискавери, параллельно)
- **T8. Tokens/fonts/icons + PATCH design-systems + инжект CSS-vars + shim easy-ui/tokens** (F). Владение: `server/routes/designSystems.ts`, `server/designSystems.ts`, `server/shims/`, `server/components/compile.ts` (ABI-allowlist), `src/designSystems/`, `src/player/` (инжект), docs.
- **T9. OpenAPI + JSON Schemas + capabilities** (G). Владение: `scripts/generate-openapi.ts`, `server/openapi.json`, `server/routes/meta.ts` (новый), `server/main.ts` (после коммитов волны 3), `package.json` (verify-шаг), docs.
- **T10. Статусы версий компонентов** (K; миграционные колонки уже в v4 от T2). Владение: `server/repos/components.ts`, `server/routes/components.ts`, docs.

### Волна 5 (UX-слой, параллельно)
- **T11. Interaction inspector** (H.1). Владение: `src/player/inspector/`, `src/player/PlayerShell.tsx`, `src/catalog/runtime.ts` (хук логгера — после T4), docs.
- **T12. Library: живые превью custom + статус-фильтры + Figma-бейджи; Figma provenance API** (H.2, J). Владение: `src/library/`, `src/app/routes.tsx` (после T7), `server/routes/{components,prototypes}.ts` + `server/repos/*` (поле figma; после T10), docs.
- **T13. Semantic validation pack** (I). Владение: `src/prototype/validate.ts` (после T5), тесты, docs.

### Волна 6 — интеграция
- **T14. Финал**: `npm run verify`, `npm run e2e`, runtime-прогон `/verify`-скилла, обновление `CLAUDE.md`-описаний зон при необходимости, сквозной demo-прототип в `prototypes/` (repeat+slots+$event+$asset) как living-документация.

## Done-критерии (сквозные)

- `npm run verify` зелёный (typecheck, тесты, validate:prototypes, drift-checks).
- `npm run e2e` зелёный (dev + preview проекты).
- Каждый новый endpoint покрыт серверным тестом (happy + ошибки envelope).
- `curl` без Accept-заголовка получает 200 text/html на `/p/<id>/s/<screen>` (после T1).
- Демо: событие с payload из custom-компонента меняет state через `$event`; repeat-список из state рендерит элементы; `$asset`-картинка отображается; скриншот-endpoint возвращает PNG в dev; visual check выдаёт корректный процент и guard-статусы.
- Обратная совместимость: все существующие `prototypes/*.json` валидны без изменений; старые payloadless events работают; старые компоненты без slots работают.

## Риски

- **Payload у builtin-событий** зависит от внутренностей @json-render — принято решение деградировать до custom-only без блока (B.2).
- **Playwright в Bun**: worker запускается под node subprocess, не в Bun-процессе (E.1) — изоляция рисков рантайма.
- **Пересоздание таблицы component_publishes** в миграции v4 (K.1) — обязательный backup перед прод-деплоем (процедура из `docs/server-api.md#deployment`); миграция тестируется на копии prod-данных из `.backups/`.
- **Одна миграция v4 на все волны** — T2 создаёт её целиком по спеке; последующие задачи колонок не добавляют. Если в ходе исполнения потребуется новое поле — v5, forward-only.
- Rollback прод-деплоя: предыдущий SHA + redeploy; миграции forward-only, поэтому деплоить только после полного verify.

## Триаж ревью

(заполняется после Stage 2)
