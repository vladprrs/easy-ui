# План v3: мульти-поверхностные прототипы (`doc.surfaces`) — флоу через две поверхности

Дата: 2026-08-02. Статус: **v3 после двух раундов Stage 2 (раунд 1 — 3 ревьюера Opus по линзам корректность/продукт/риски; раунд 2 — верификационный: «блокеров нет», 7 major внесены). Триаж — §11. Готов к одобрению; Stage 3 — только по отдельной команде.**

> Очередь исполнения: **строго после** посадки `2026-08-02-agent-iteration-dx.md` (W1–W5) и `2026-08-02-computed-state.md` (T1–T6) — пересечения по `src/prototype/schema.ts`, `src/prototype/validate.ts`, `src/player/*`, `src/capture/*`, `server/contracts.ts`, `server/screenshot/service.ts`. Перед Stage 3 — чек-лист синка §9. RFC candidate-acceptance не пересекается (компонентный lifecycle).

## 1. Задача

Продемонстрировать **полноценный флоу через две взаимодействующие поверхности**: КСО ↔ приложение покупателя, касса продавца ↔ приложение. Часть шагов выполняется на одной поверхности, часть на другой; важно видеть не только экран пользователя, но и смену статусов/состояний второй поверхности (внутренние состояния, corner-кейсы: таймаут оплаты, отмена на кассе, повторное сканирование). У каждой поверхности может быть своя дизайн-система (КСО — брендовая ДС терминала, приложение — `yandex-pay-v2`).

Сегодня это невыразимо: `designSystem`, `device`, `startScreen` — скаляры документа; плеер показывает один экран (URL — источник истины); двум документам нельзя разделить состояние.

## 2. Решение в одном абзаце

Аддитивное опциональное поле `doc.surfaces` (ровно 2 поверхности в v1: `id`, `name`, `device`, `startScreen`, опц. `designSystem`) + обязательный при наличии `surfaces` тег `screen.surface`. Плеер получает **дуо-сцену**: по одному `DeviceFrame` на поверхность бок о бок, **один общий state-store и один `EasyUiActionRuntime`** на сессию (демо смены статусов — бесплатно: КСО пишет `/order/status`, экран приложения читает `$state`; подтверждено R1-m7). `navigate` не меняется: целевой экран принадлежит какой-то поверхности — переход меняет текущий экран **этой** поверхности и переносит на неё фокус. Карта текущих экранов несфокусированных поверхностей живёт **в query-строке URL** — share-ссылка, deep-link и CJM-переход воспроизводят состояние обеих панелей (capture — нет: съёмка поэкранна, см. D14). Темизация per-surface — `ScopedThemeSurface` + `SurfaceSpacingScope`; сервер учится резолвить компоненты, пины, темы, share-ресурсы и capture-allowlist по множеству ДС документа. Прод защищён write-path kill-switch'ем `EASYUI_SURFACES` до зелёной приёмки.

Документ без `surfaces` ведёт себя байт-в-байт как сегодня.

## 3. Формат (аддитивно, `version: 1` не бампается)

```json
{
  "surfaces": [
    { "id": "kso", "name": "КСО", "device": "desktop", "startScreen": "kso-idle" },
    { "id": "app", "name": "Приложение", "device": "mobile", "designSystem": "yandex-pay-v2", "startScreen": "app-home" }
  ],
  "screens": [ { "id": "kso-idle", "surface": "kso", "canvas": { "width": 1080, "height": 1920 }, "spec": { … } }, … ]
}
```

### Дизайн-решения

- **D1. Поверхность** — `{ id: slug, name: 1..60, device: mobile|tablet|desktop, startScreen: slug, designSystem?: slug }`. `SURFACES_LIMIT = 2` в v1 (ровно две; сцена, бюджеты рендера и очередь скриншотов рассчитаны на пару — R3-m2; расширение лимита аддитивно). Минимум 2 (одна поверхность не добавляет ничего — ошибка авторинга). `id` уникальны. Константа — в `src/prototype/schema.ts`, capabilities импортирует оттуда (правило `server-api.md:865`).
- **D2. Принадлежность экрана**: при наличии `surfaces` **каждый** экран обязан нести `surface` с существующим id; при отсутствии `surfaces` поле `surface` на экране — ошибка. Никаких молчаливых дефолтов.
- **D2a. Desktop-поверхность дуо-дока обязана давать всем своим экранам `canvas`** (ошибка валидации): desktop-fluid ветка `DeviceFrame` (`DeviceFrame.tsx:205-213`) не масштабируется и не имеет spacing-скоупа — КСО в пол-окна без canvas это сломанный лейаут, а не уменьшенный терминал (R2-B1, R1-m4). С canvas работает fixed-viewport ветка с fit-scale. **Записанное следствие** (R4-M7): canvas-экраны запрещают `region` (`runtimeSpec.ts:110`) — desktop-поверхность дуо-дока не использует `@eui/FlowRoot`-регионы (статус-бар/шапку КСО автор рисует в макете экрана); фиксируется в доке и скилле. Mobile/tablet-поверхности регионы сохраняют.
- **D3. Инварианты совместимости** (не-переведённые читатели `doc.device`/`doc.designSystem` деградируют осмысленно — меряют по primary): `surfaces[0]` — **primary**; `doc.startScreen === surfaces[0].startScreen`; `doc.device === surfaces[0].device`; `surface.designSystem` опционален, дефолт — `doc.designSystem` (ДС primary). Продуктовое следствие (осознанное): галерея/visual/плейсхолдеры CJM до их перевода меряют дуо-док по КСО-поверхности.
- **D4. Zod, две ветки**: **референциальная целостность** (`screen.surface → surfaces[].id`, полнота тегов, уникальность id) — в `refinePrototypeDocStructure`, т.е. в **обеих** ветках: на неё напрямую опирается код (`surfaceOf` вызывается на stored-документах из плеера/капчера) — канон `schema.ts:172-176` (R1-M5). Авторские лимиты и D3-равенства — только в input-ветке. `surfaceOf(doc, screenId)` при любом сюрпризе stored-данных возвращает primary-фолбэк (тест).
- **D5. Flows**: шаги ссылаются на экраны любых поверхностей; лейны/дерево не меняются. **Новое опциональное поле шага `step.companions?: Record<surfaceId, screenId>`** — «что в этот момент на другой поверхности»: ключ — существующая не-своя поверхность, значение — её экран. Референциальная целостность — в `refinePrototypeDocStructure` (обе ветки, канон D4); stored-фолбэк — неизвестные записи игнорируются (R4-m2). Потребители: guided browse и deep-link из CJM выставляют **обе** панели; вид «Сценарии» рисует парный тайл companion-экрана рядом с тайлом шага (R2-B4). `step.note` — каноническое место текстовой аннотации «что происходит на кассе» (фиксируется в скилле). Тайлы второй поверхности используют `stateOverrides` для показа нужного статуса (механизм существует, приводится в фикстуре).
- **D6. Навигация**: `navigate {screenId}` без новых параметров. **Источник истины карты текущих экранов — URL**: path несёт сфокусированный экран (`/p/:id/s/:screenId`), query — экраны остальных поверхностей (`?on.<surfaceId>=<screenId>`). Владелец записи — `PlayerNavigationProvider`, не actionRuntime (R1-B1): `deps.navigate` уже принимает только `screenId` (`actionRuntime.ts:223`), провайдер сам знает `surfaceOf(target)` и переписывает path+query; рантайм остаётся stateless относительно навигации. Следующая карта (и `flowDepth` — та же болезнь, R4-m1) вычисляется из **актуального** `window.location` в момент вызова, не из React-замыкания — два `navigate` в одном событии обновляют обе поверхности (R1-B1b, тест обязателен). Ранний выход `target === screenId` (`navigation.tsx:96`) становится «target == текущий экран **его** поверхности». `back` — `routerNavigate(-1)`: URL-история хранит полные карты. `restart` — все поверхности на свои `startScreen`, новый `sessionNonce`, **`on.*` удаляются из query** (`flow`/`step`/`debug` сохраняются). Deep-link без `on.*` — остальные поверхности на `startScreen`; неизвестный screenId в `on.*` (включая переключение версий со stale-query, `ScreenView.tsx:189`) — фолбэк на `startScreen` поверхности (R4-m5). `browseToScreen` получает опциональный аргумент companions — guided browse выставляет обе панели одним replace (R4-m1). Query-механика подтверждена R4: `navigate`/`browse`/`restart` переносят `search` (`navigation.tsx:75,89,97,104,120`), `withScenarioQuery` мержит поверх `URLSearchParams` — `on.*` выживает.
- **D7. Состояние — общее.** Один store, один `EasyUiActionRuntime`. `stateOverrides` в живом плеере по-прежнему не применяются. `computed` работает без изменений — воронка записи одна. **Гард бюджета рендера**: `setScreenSpec` становится per-surface (`setScreenSpec(surfaceId, spec)`), `withinBudget` проверяет **каждую активную спеку против бюджета отдельно** (не сумму — сумма молча урезала бы вместимость панели вдвое, R4-m4; итог ограничен `SURFACES_LIMIT × budget`) — иначе вторая сцена затирает спеку первой (R1-M7).
- **D8. Per-surface ДС**: резолв типа элемента — в ДС поверхности его экрана. Коллизии имён компонентов исключены **глобальной уникальностью** `components.name UNIQUE` (`server/migrations.ts:32`), не реестрами (R1-m1, R3-m1) — плоские name-keyed карты (пины, classify, loader) остаются корректными; per-surface резолв — это ограничение *политики* (тип чужой ДС на экране — ошибка), фиксируется инвариантом. Рантайм: один `JSONUIProvider` (реестр он не потребляет — `@json-render/react` принимает registry пропом `Renderer`, R1-m1) + **реестр на поверхность** в `ScreenSurface`.
- **D9. Темизация**: primary — глобальный `ThemeStyle` (как сегодня). Не-primary с другой ДС — `ScopedThemeSurface` на её панель с **`resetAnimations={false}`**, причём reset-стили получают **собственный opt-in атрибут** (`data-eui-scoped-reset`) вместо ключевания на `data-eui-scoped-surface` — иначе любой другой scoped-инстанс на странице (CJM-тайлы W4, Library-превью) замораживает панель через глобальный refcounted-стиль (`ScopedThemeSurface.tsx:29-54`; R1-M4, R4-M5; Library — регрессионная поверхность, тест) — и flex-классами под раскладку `DeviceFrame`; шрифты — через `fontRegistry`-механизм. **Ограничения v1** (в доку + warnings валидации): (а) `token()` и `Icon` читают глобальный снапшот primary **целиком — и tokens, и icons** (`theme.tsx:126-131`): компоненты не-primary ДС получают чужие значения независимо от наличия иконок в её теме; warning — **безусловный, не-блокирующий, при ≥2 различных ДС в документе** (R4-M6) + рецепт в скилле «иконко/токен-зависимую ДС (yandex-pay) делай primary»; снятие — ABI v5 (контекстные токены) → RFC. (б) `fontRegistry` фильтрует **только по family** (`fontRegistry.ts:43-45`) — совпадающие family двух ДС → побеждает primary; warning при пересечении family пиннутых тем (R1-M3); скоупинг переименованием family → v2. Канал темы в валидацию: сервер передаёт карту `ds → ThemeContent` через options `validatePrototype` (паттерн уже есть в `screenshot/service.ts:239-243`); клиентская валидация редактора эти warnings не эмитит — осознанно (R4-m3).
- **D10. Девайс-рамки**: каждая поверхность — свой `DeviceFrame` (`canonicalViewport[surface.device]`; `screen.canvas` работает как сегодня; для desktop — D2a). Правило Overlay-на-desktop (`overlayRules.ts:35`), спейсинг-линты (`layoutLints.ts:131`) и `hostPrimitivesAllowed` (**оба сайта**: `ScreenView.tsx:361`, `CapturePrototype.tsx:83` — R4-M7) считаются от поверхности экрана. Player-переключатель девайса на surfaces-доках скрывается. Зум: fit-scale per-панель; ручной зум v1 применяется к сфокусированной панели.
- **D11. Фокус**: сфокусированная панель — рамка + заголовок `surface.name`; `navigate` на другую поверхность переносит фокус; несфокусированные панели **живые** (кликабельны — corner-кейсы и есть цель). **Все поверхности всегда смонтированы** — включая present-mobile (скрытая панель — `hidden`, не unmount): иначе таймеры/эффекты второй поверхности умирают, а на них опирается §10 (R2-M5). Инвариант — в доку и тестом.
- **D12. Навигационный хром** (R1-M10, R2-M8): сайдбар экранов группируется по поверхностям; стрелки ←/→ и пейджер present ходят **в пределах сфокусированной поверхности**; `browseToScreen` переписывает карту (replace); шаг guided browse выставляет обе панели (D5); recorded-сценарии: `restart` сбрасывает все поверхности, `expectScreen` сверяется с картой (экран любой поверхности — по его surface), контракт шага не меняется. Мобильный present: сфокусированная поверхность + переключатель поверхностей в HUD.
- **D13. Редактор — минимально**: канвас/strip рисуют экран рамкой его поверхности; инспектор экрана — select `surface`; **контролы `device`/`startScreen`/ДС документа на surfaces-доках дизейблятся** (иначе любой клик по ним даёт неисправимый в UI 422 по D3 — R1-M6, R3-m4); список поверхностей в UI — v2, авторинг через API/скилл. Round-trip без потерь. `revisionDiff`/`docDiff` учат секцию `surfaces` (правки поверхностей видны в истории — R3-M5).
- **D14. Скриншоты**: viewport = `screen.canvas ?? canonicalViewport[surfaceOf(screen).device]`. **Съёмка дуо-дока — поэкранная, в дефолтном состоянии, без companion-панели** (R4-M1): `CapturePrototype` рендерит один экран от `doc.state`; corner-статусы второй поверхности снимаются живым плеером/share-ссылкой, не capture (продуктовая приёмка §6 так и построена). **Серверная часть капчера становится мульти-ДС** (R1-B2, R3-B1): allowlist — объединение тем/ассетов всех ДС документа с их пиннутыми версиями; `CaptureExpected`/`CaptureReady` несут резолвнутую пару `(ds, metaVersion)` снимаемого экрана (иначе дрейф темы второй ДС не детектируется handshake'ом); geometry-probe берёт `resolvedSpaceScale` от ДС поверхности экрана (R3-M6); `CapturePrototype` грузит тему/скоуп по поверхности. Композитный дуо-кадр — вне скоупа v1. Done-критерий пиксельный, не exit-код: снап экрана второй поверхности содержит её шрифт/иконку.
- **D15. Capabilities/discovery**: `features.surfaces: true`, `limits.surfaces`; JSON-схема — автоматически из input-ветки (`z.toJSONSchema`, `meta.ts:144`).
- **D16. Kill-switch**: `EASYUI_SURFACES`, **дефолт — фича выключена** (полярность обратна `EASYUI_PUBLISH_GATES`, у которого пусто = разрешено — R4-M4): без `EASYUI_SURFACES=1` сохранение дока с `surfaces` → 422 со стабильным кодом; прод не накапливает surfaces-доки до подтверждённой приёмки (R3-M7). `EASYUI_SURFACES=1` добавляется в e2e-`webServer`-команды (`playwright.config.ts`) и dev-скрипты — иначе e2e W2 не пройдут; файлы — во владении W1. Share-гранты на surfaces-доки — только после зелёного W5.

## 4. Инвентарь single-DS-предположений сервера (полный, R3)

Каждый пункт — реализовать или закрыть стабильной 422 в v1; «молча работает неправильно» не остаётся.

| Точка | Код | Решение v1 |
|---|---|---|
| Резолв компонентов при сохранении | `snapshotDefinitions` (`server/validation.ts:100-126`) — SQL по одной ДС | реализовать: резолв по множеству ДС, карта definitions пер-ДС, резолвер «экран → definitions» в `validatePrototype` (options уже есть — R1-m2) |
| Пины компонентов | guard `server/repos/prototypes.ts:224-225`, restore `:195-200` | реализовать: принадлежность множеству ДС документа |
| Пин темы | колонка `prototype_revisions.design_system_meta_version` (`repos/prototypes.ts:26`), пишется `insertRevision:119-127`, restore `:192,201`, **migrationRunner:909-911 напрямую** | новая таблица `prototype_revision_theme_pins(prototype_id, rev, design_system, meta_version)`; **read-правило: нет строк → карта `{primary: колонка}`** — бэкфила нет by design (записать в `server-api.md`); колонка остаётся primary-значением (совместимость) |
| Производные пина | `resolvedSpacingScale`, `builtinCatalogHash` — от одной ДС (`insertRevision`), `builtin_catalog_hash` входит в capture-handshake | для surfaces-доков: шкала — карта пер-ДС; хэш — детерминированно по отсортированному множеству `(ds, metaVersion)`; одно-поверхностные доки — байт-в-байт как раньше (R1-M1, R3-M1) |
| Триггеры retired-DS | тела шага v15 (`migrations.ts:354-367`) — forward-only, задним числом не переиграются (R1-M2) | **новый шаг миграции**: `DROP TRIGGER`+`CREATE` тех же двух имён с `OR EXISTS (SELECT 1 FROM json_each(json_extract(NEW.doc,'$.surfaces')) …)` — список `RETIRED_DESIGN_SYSTEM_TRIGGER_NAMES` не меняется, старый `assertRegistryIntegrity` зелёный (R3-M3, json_each в триггере проверен эмпирически) |
| Ретайр ДС | `RETIRE_BLOCKERS` считает только `prototypes.design_system` (`routes/designSystems.ts:66-70`) | blocker-запрос по `json_each(doc,'$.surfaces')` на головах; surface-скан в `assertRegistryIntegrity` (R3-M2). Принятое ограничение: опубликованные не-head версии не сканируются — тот же класс, что сегодняшнее поведение по `prototypes.design_system` (R4-m6) |
| Catalog migration | `migrationRunner.ts:870-877` резолвит пины по primary; `:909-911` пишет ревизию в обход репо; `currentDataFingerprint:198-203` не видит новую таблицу | реализовать: multi-DS резолв, копирование theme-pin-строк, таблица в fingerprint (R3-B2) |
| Share-гранты | `server/share/repo.ts:126-131` — ресурсы одной темы | реализовать: ресурсы всех ДС документа (R2-B3, R3-B4) |
| Capture-allowlist/handshake | `server/screenshot/service.ts:242-256, 331-349` | реализовать (D14) |
| Bundle export/import | `exporter.ts:237,241`, `src/bundle/schema.ts:73` (скаляр), `importer.ts:434-446` (ключ `ds::type`) | **422 `surfaces_not_exportable` в v1** (стабильный код); формат манифеста мульти-ДС → v2 (R3-B3) |
| Композиции | `resolveCompositionPins(..., doc.designSystem)` (`validation.ts:91`), `repos/compositions.ts:672`, `composition.ts:566-568` | **422 `composition_foreign_design_system` в v1**: композиции допустимы только на экранах, чья ДС == `doc.designSystem`; per-screen резолв → v2 (R1-M9, R2-M1, R3-M4) |
| Readiness | `server/readiness.ts:162,168` — один снапшот | реализовать: тот же резолвер, что валидация |
| Diff-контракт | `revisionDiff.ts:262` — списки полей без `surfaces` | реализовать (D13) |

## 5. Волны (пересобраны: продуктовая ценность — раньше, R2-M3; ownership без дыр, R1-M8/R3-M5)

Волны **строго последовательны W1 → W5**, без параллельного исполнения: `server/routes/prototypes.ts`, `server/contracts.ts`/`openapi.json`, `src/capture/*` намеренно появляются в нескольких волнах (R4-m7).

**W1 — формат и валидация.**
Владеет: `src/prototype/schema.ts`, `src/prototype/validate.ts`, `src/prototype/surfaces.ts` (нов.), `src/prototype/overlayRules.ts`, `src/prototype/layoutLints.ts` (+тесты), `server/contracts.ts`, `server/routes/meta.ts`, `server/openapi.json`, `server/routes/prototypes.ts` (kill-switch D16), `playwright.config.ts`, `package.json` (env для e2e/dev — R4-M4).
D1–D5, D15, D16; `step.companions`; **на W1–W2 `surface.designSystem ≠ doc.designSystem` → 422 `surface_design_system_not_supported`** (снимается в W3).
Done: unit-тесты D1–D5 (позитив/негатив, stored-фолбэк `surfaceOf`), tolerant-stored читает surfaces-док; kill-switch выключен → 422; capabilities/схема; `npm run verify`.

**W2 — плеер: дуо-сцена (одна ДС) + фикстура + e2e.** Продуктовая ценность здесь: флоу через две поверхности работает end-to-end на общей ДС.
Владеет: `src/player/navigation.tsx`, `src/player/PlayerShell.tsx`, `src/player/ScreenView.tsx`, `src/player/PresentShell.tsx`, `src/player/DuoStage.tsx` (нов.), `src/player/ScreensSidebar.tsx`, `src/player/ScenarioBar.tsx`, `src/player/scenarioRunner.ts`, `src/player/scenarioRecording.ts` (R4-M3), `src/player/actionRuntime.ts` (только `setScreenSpec(surfaceId, …)`), `src/player/ScreenSurface.tsx` (вызов `setScreenSpec` — R4-M3), `src/player/DeviceFrame.tsx`, `test/fixtures/duo-pos.json` (нов., одна ДС), `e2e/dev/surfaces.spec.ts` (нов.).
Done: клик на КСО навигирует app-панель и переносит фокус; **два `navigate` в одном событии обновляют обе поверхности** (тест R1-B1b); Back/Forward восстанавливают обе панели из URL; deep-link `?on.app=…` работает; restart — оба startScreen; стрелки/сайдбар/пейджер — по D12; guided browse с `companions` выставляет обе панели; recorded-сценарий на дуо-доке проходит; e2e: клик киоска → смена экрана приложения + текст статуса из общего стейта.

**W3 — сервер multi-DS.**
Владеет: `server/validation.ts`, `server/repos/prototypes.ts`, `server/routes/prototypes.ts`, `server/routes/designSystems.ts`, `server/migrations.ts` (новый шаг: таблица theme-pins + пересоздание триггеров), `server/migrationRunner.ts`, `server/share/repo.ts`, `server/screenshot/service.ts`, **`src/capture/protocol.ts` + `scripts/screenshot-worker.mjs` + `src/capture/CapturePrototype.tsx` (handshake-поля `(ds, metaVersion)` — обе стороны в одной волне, R4-M2)**, `server/readiness.ts`, `server/bundle/*` (422), `server/repos/compositions.ts` (422), contracts/openapi.
Done: публикация дока с двумя ДС проходит, снятие 422 из W1; пины обеих ДС; theme-pins карта в DTO + read-правило без бэкфила; хэш/шкала по §4; триггеры пересозданы новым шагом, `assertRegistryIntegrity` зелёный на старом и новом образе; ретайр ДС блокируется surface-ссылками; share-грант дуо-дока несёт обе темы (тест: аноним получает ресурсы второй ДС); catalog-migration план с duo-доком в базе готовится и применяется (тест); export → 422, композиция чужой ДС → 422 (тесты); **снап одно-поверхностного дока по-прежнему проходит handshake** (R4-M2); **миграция прогнана на копии прод-БД**.

**W4 — клиент multi-DS + периферия.**
Владеет: `src/api/client.ts` (карта theme-pins, `PrototypeComponentPin.designSystem`), `src/player/PrototypeLoader.tsx` (runtimeKey, бандлы по поверхностям), `src/customComponents/loader.ts`, `src/catalog/runtime.ts` + `src/player/ScreenSurface.tsx`/`easyUiRuntime.tsx` (реестр на поверхность — R4-M3), `src/designSystems/theme.tsx`/`ScopedThemeSurface.tsx` (opt-in reset-атрибут D9)/`fontRegistry.ts`, `src/capture/CapturePrototype.tsx` (per-surface тема/скоуп/`hostPrimitivesAllowed` — продолжение файлов W3, волны последовательны), `src/cjm/*` (рамка/бейдж поверхности, парный тайл companions, scoped-тема тайла), `src/editor/*` (D13), `src/gallery/GalleryPreview.tsx` (бейдж «2 поверхности»), `src/visual/VisualPage.tsx`, `src/prototype/revisionDiff.ts`, `src/editor/docDiff.ts`.
Done: дуо-док с двумя ДС рендерится в плеере (вторая панель — своя тема и шрифты, анимации живы — включая тест «CJM-тайл со scoped-темой на той же странице не замораживает панель», R4-M5; Library-превью без регрессий); снап экрана второй поверхности **пиксельно** содержит её шрифт/иконку; geometry-probe второй поверхности — её шкала; CJM: парные тайлы + `stateOverrides`-статусы; редактор: surface-select, дизейбл `device`/`startScreen`, round-trip; дифф показывает правку surfaces.

**W5 — харнес, доки, скиллы, приёмка.**
Владеет: `.claude/skills/author/driver.mjs` (**viewport от поверхности** — `resolveViewport` сейчас берёт `doc.device`: `:457,:637,:731-733` — R3-M5), `.claude/skills/author/SKILL.md`, `.claude/skills/yp-prototype/SKILL.md`, share-зеркала через `scripts/sync-share-skills.mjs`, `docs/prototype-format.md`, `docs/server-api.md`, `test/fixtures/duo-kso.json` (нов., две ДС), e2e-дополнение.
Done: доки описывают D1–D16 (включая ограничения token()/Icon и family-шрифтов, canon `step.note`, `companions`); скилл строит дуо-док без вопросов к человеку; снятие kill-switch — только после продуктовой приёмки §6.

## 6. Верификация

Инженерный гейт: `npm run verify` + `npx playwright test e2e/dev/surfaces.spec.ts` + `npm run e2e` + runtime-прогон по `/verify`: публикация дуо-фикстуры, `driver.mjs snap <id> --all-screens` exit 0 **плюс** визуальная сверка снапа второй поверхности (тема/шрифт её ДС).

Продуктовая приёмка (R2-M9), до снятия kill-switch на проде:
1. Человек по share-ссылке без объяснений проходит «оплата на КСО → чек в приложении» и три corner-кейса (таймаут оплаты, отмена на кассе, повторное сканирование); каждый corner-кейс воспроизводится с deep-link-ссылки (query-карта).
2. Агент собирает дуо-док по обновлённому скиллу без вопросов к человеку.
3. Ноль регрессий на одно-поверхностных документах: свип фикстур + прод-смоук галереи/плеера/CJM.

## 7. Взаимодействие с предыдущими планами

| План | Пересечение | Правило |
|---|---|---|
| computed-state (T1–T6) | `schema.ts` (третий generic `prototypeDocShape`), `validate.ts`, `hardenedStore`, player-шеллы | старт после мержа; computed на общем сторе — без правок (воронка одна) |
| agent-iteration-dx (W1–W5) | `CapturePrototype.tsx`/`protocol.ts` (bootstrap.target, rev-дискриминант), `server/screenshot/service.ts`, contracts/openapi, `driver.mjs`, sync-скрипт | старт после; хэндшейк-поля этого плана добавляются к фактическим сигнатурам; done W4: **duo-док с `track:head` снимается корректно** (общая точка — `CapturePrototype`, R3) |
| candidate-acceptance RFC | нет пересечений | — |

Оговорка (R3): `track:head`-доки непубликуемы/нешерабельны по P2.2 — демо-док не может быть одновременно track и share; в доку авторинга.

## 8. Риски

| Риск | Sev | Митигация |
|---|---|---|
| Откат образа до фичи: 422 на чтение surfaces-доков; **шире computed** — surfaces-доки шерятся наружу, публичные ссылки ломаются; любой surfaces-док валит catalog-migration старого образа | high | kill-switch D16 (прод не пишет surfaces-доки до приёмки); share на surfaces-доки — после W5; старт сервера не падает (integrity читает сырым JSON.parse — R3-M7); дальше — принятый класс бэкап/roll-forward |
| `token()`/`Icon` — глобальный снапшот primary | med | D9(а): warning + рецепт «иконко-зависимую ДС делай primary»; ABI v5 → RFC |
| Шрифты: fontRegistry фильтрует по family — коллизия family двух ДС молча берёт primary | med | D9(б): warning валидации при пересечении family пиннутых тем; переименование family → v2 |
| Гонка/замыкание при двух navigate в одном событии | med | D6: карта из актуального location; обязательный тест W2 |
| Миграция theme-pins на populated-базе | med | read-правило без бэкфила; primary-колонка сохраняется; прогон на копии прод-БД в done W3 |
| Размер/стоимость ревизий дуо-доков (два набора экранов в одном json) | low | лимиты на экран не меняются; строка в доку; probe-практика показывает 124 КБ/16 экранов терпимо |
| Две живые сцены: бюджет рендера, очередь скриншотов | low | D7 (сумма по спекам), SURFACES_LIMIT=2; очередь: снап по-прежнему поэкранный, 429-ретрай уже в драйвере |
| Мобильный present дуо-дока | low | D12: сфокусированная поверхность + переключатель; скрытая панель смонтирована (D11) |

## 9. Чек-лист синка перед Stage 3

- [x] agent-iteration-dx W1–W5 смержены; фактические `CaptureExpected`/`CaptureReady`/`bootstrap` сверены с D14 (2026-08-02: `PrototypeReady` несёт `revision`, `*Expected` — `rev`; `bootstrap.target: Record<string,unknown>`)
- [x] computed-state T1–T6 смержены; фактическая сигнатура `prototypeDocShape` учтена в W1 (`<S,F,C>(screens, flows, computed)`, schema.ts:203; `refinePrototypeDocStructure` 232-249, обе ветки: 353/363)
- [x] Сверены фактические сигнатуры share-грантов (`dependencySnapshot`, share/repo.ts:126-131) и capture-allowlist (`prototypeAllowedUrls`, service.ts:348-375; enqueue 244-278)
- [x] Line-цитаты плана перепроверены по HEAD 1e1e0cd. Поправки: `src/player/composition.ts` не существует — композиционная 422 реализуется в `server/repos/compositions.ts:672` + `server/validation.ts:91`; ключ импортёра — `${designSystem}::${type}` (importer.ts:390,453); RETIRE_BLOCKERS — designSystems.ts:133-137; deps.navigate — actionRuntime.ts:271

## 10. Вне скоупа v1 (→ v2/RFC)

- ABI v5: контекстные `token()`/`Icon`, скоупинг шрифтов переименованием family;
- bundle export/import мульти-ДС (v1 — стабильная 422) и композиции на не-primary поверхностях (v1 — 422);
- композитный дуо-скриншот и дуо-visual-baseline;
- >2 поверхностей; >1 экземпляра одной поверхности;
- авторинг поверхностей в UI редактора; лейны CJM, сгруппированные по поверхностям;
- пер-поверхностные `state`-неймспейсы (общий стор — цель фичи);
- симуляция задержек/push (таймеры выразимы custom-компонентами; инвариант D11 гарантирует их жизнь).

## 11. Триаж ревью Stage 2, раунд 1

Ревьюеры: R1 — корректность против кода, R2 — продукт/скоуп, R3 — риски/миграции. ✅ принято, 🟡 частично, ❌ отклонено.

### Blockers
| Находка | Вердикт | Как отражено |
|---|---|---|
| R1-B1/B1b: `currentBySurface` в actionRuntime разъезжается с историей; stale-замыкание при двух navigate | ✅ | D6 переписан: владелец — navigation provider, карта в URL, вычисление из актуального location; тест в done W2 |
| R2-B2: карта в `location.state` не переживает share/deep-link/capture | ✅ | D6: карта в query (`?on.<surface>=`) — share/deep-link/CJM воспроизводят обе панели (capture — поэкранный by design, см. D14/R4-M1) |
| R2-B1/R1-m4: desktop-поверхность не выражается (fluid-ветка без scale и spacing-скоупа) | ✅ | D2a: canvas обязателен для desktop-поверхностей дуо-дока |
| R1-B2/R3-B1: capture-конвейер однодизайнсистемный (allowlist, dsMetaVersion, spaceScale, loadTheme) | ✅ | D14 + §4; `service.ts`/`protocol.ts`/worker — во владении W3/W4; пиксельный done-критерий |
| R3-B2: catalog-migration валится на surfaces-доке; fingerprint не видит новую таблицу | ✅ | §4: `migrationRunner.ts` в W3, done-тест |
| R3-B3: bundle export теряет вторую ДС (формат манифеста скалярный) | ✅ | v1 — 422 `surfaces_not_exportable`; мульти-ДС манифест → v2 (§10) |
| R3-B4/R2-B3: share-грант несёт одну тему | ✅ | §4: `share/repo.ts` в W3, done-тест с анонимом |
| R2-B4: артефакты объяснения (CJM/flows) одноэкранны — цель фичи не закрывается | ✅ | D5: `step.companions` + парный тайл + канон `step.note` + `stateOverrides`-статусы в фикстуре |

### Majors
| Находка | Вердикт | Как отражено |
|---|---|---|
| R1-M1/R3-M1: пин темы — ещё `resolvedSpacingScale`/`builtinCatalogHash`; полный список read/write-точек; read-правило вместо бэкфила | ✅ | §4 (строки «пин темы», «производные пина») |
| R1-M2/R3-M3: триггеры — только новым шагом миграции, DROP+CREATE тех же имён | ✅ | §4 |
| R3-M2: ретайр ДС не видит surface-ссылок; integrity-скан | ✅ | §4 |
| R1-M9/R2-M1/R3-M4: композиции жёстко primary-ДС | ✅ | v1 — 422 со стабильным кодом; per-screen резолв → v2 |
| R1-M3: fontRegistry-посылка риска неверна (family-only) | ✅ | D9(б) и §8 переписаны |
| R1-M4: ScopedThemeSurface заморозит анимации; flex-классы | ✅ | D9 |
| R1-M5: референциальные инварианты — в обе ветки (`refinePrototypeDocStructure`) | ✅ | D4 |
| R1-M6/R3-m4/R2-M7: редактор ломает D3 (device/startScreen селекты → 422) | ✅ | D13: дизейбл контролов, done W4 |
| R1-M7: `setScreenSpec` одно поле — гард бюджета недостоверен | ✅ | D7, done W2 |
| R1-M8/R3-M5: дыры ownership (api/client, PrototypeLoader, customComponents/loader, bundle, readiness, screenshot, driver.mjs, overlayRules, layoutLints, revisionDiff, designSystems.ts, migrationRunner, share) | ✅ | §4-инвентарь + волны пересобраны, каждый файл назначен |
| R1-M10/R2-M8: хром навигации (стрелки, сайдбар, пейджер, ScenarioBar, scenarioRunner) не определён | ✅ | D12, done W2 |
| R2-M3: весь продуктовый эффект в конце | ✅ | волны пересобраны: дуо-плеер на одной ДС + e2e — W2 |
| R2-M4: W3 перегружена и недоукомплектована | ✅ | разделение: W2 (плеер) / W3 (сервер) / W4 (клиент multi-DS + периферия) |
| R2-M5: unmount второй поверхности убивает таймеры, на которые опирается §10 | ✅ | D11: инвариант «всегда смонтированы», present-mobile — hidden |
| R2-M6: token()/Icon — предлагался error вместо warning | 🟡 | Warning + рецепт «иконко-зависимую ДС делай primary» (D9): error запретил бы пару, где обе ДС используют иконки, а флагманский кейс закрывается выбором primary; предметный warning — по непустому `icons`-словарю не-primary темы. ABI v5 — настоящее снятие |
| R2-M9: нет продуктовых done-критериев | ✅ | §6: сценарная приёмка (share-проход + corner-кейсы с deep-link, агент по скиллу, 0 регрессий) |
| R3-M6: geometry-probe — чужая шкала для второй поверхности | ✅ | D14 |
| R3-M7: масштаб отката шире computed; kill-switch | ✅ | D16 + §8 |
| R3-M5(driver): харнес снимает вторую поверхность в чужом вьюпорте | ✅ | W5: `driver.mjs` во владении |

### Minors
Приняты: R1-m1/R3-m1 (D8 переписан: UNIQUE-имя, registry — проп Renderer, не Provider), R1-m2 (посылка про classify устарела — §4 переформулирован), R1-m3 (line-цитаты поправлены; актуализация — §9), R1-m4 (в D2a), R1-m5 (терминология `version: 1`), R1-m6 (D15: схема автоматична), R2-m1 (overlayRules/layoutLints — W1), R2-m2 (bundle — код, не тест: закрыт 422), R2-m3 (галерея: бейдж «2 поверхности», W4), R2-m4 (риск размера ревизий — §8), R2-m5 (следствие D3 записано), R2-m6 (§9), R3-m2 (SURFACES_LIMIT=2), R3-m3 (композитный кадр вне скоупа с оговоркой очереди), R3-m5 (scenarioRunner в D12/W2), R3-m6 (лимит из schema.ts), R3-m7 (§9).
Отклонено: R2 (частично) «горизонтальная раскладка всегда?» — v1 фиксирует горизонталь (пара panels fit-scale); вертикаль/переключение — v2, не влияет на формат ❌.

### Раунд 2 — верификационное ревью v2 (R4): «блокеров нет», триаж в v3

Положительно верифицировано R4: query переносится всеми переходами (`navigation.tsx:75,89,97,104,120`), `withScenarioQuery` мержит — `on.*` выживает; capture-allowlist path-only — query на capture-URL не режется и не противоречит P2.3 (то правило — про `snapshotUrl`); `companions`/`surface` в shared-шейпах — stored-чтение безопасно; `json_each` по доку без `surfaces` даёт 0 строк — пересозданный триггер не ломает обычные ревизии; все выборочные line-цитаты §4 подтверждены.

| Находка | Вердикт | Как отражено |
|---|---|---|
| R4-M1: «capture воспроизводит обе панели» — ложь (съёмка одноэкранна, `doc.state` без overrides); corner-статус второй поверхности не снимается capture'ом вовсе | ✅ | Клауза убрана из §2/D6; D14: съёмка поэкранная в дефолтном состоянии, corner-кейсы — живой плеер/share |
| R4-M2: handshake-поля `(ds, metaVersion)` рвутся между W3 (producer) и W4 (protocol/worker) — все снапы падают между волнами | ✅ | `protocol.ts`/worker/`CapturePrototype` (handshake-часть) перенесены в W3; done W3: снап одно-поверхностного дока проходит |
| R4-M3: дыры ownership (`ScreenSurface.tsx` — setScreenSpec и registry; `easyUiRuntime.tsx`; `scenarioRecording.ts`; playwright/package.json) | ✅ | Назначены: W2 (`ScreenSurface` setScreenSpec, `scenarioRecording`), W4 (registry-провод), W1 (env-файлы) |
| R4-M4: полярность kill-switch не задана; e2e W2 не пройдут без env | ✅ | D16: дефолт — выключено; `EASYUI_SURFACES=1` в e2e/dev; файлы в W1 |
| R4-M5: reset-стили ScopedThemeSurface глобальны по атрибуту — CJM-тайл замораживает панель | ✅ | D9: отдельный opt-in атрибут `data-eui-scoped-reset`; тест + Library-регрессия в done W4 |
| R4-M6: warning D9(а) недопокрывает (`token()` отдаёт чужие tokens И icons при пустом словаре иконок) | ✅ | D9(а): безусловный не-блокирующий warning при ≥2 ДС |
| R4-M7: D2a отнимает регионы у desktop-поверхности (canvas ⇒ нет FlowRoot/statusBar) — незаписанное следствие; `hostPrimitivesAllowed` от `doc.device` в двух сайтах | ✅ | D2a: следствие записано (КСО рисует статус-бар в макете); D10: оба сайта `hostPrimitivesAllowed` |
| R4-m1 (механизм «актуального location», stale `flowDepth`, ранний выход per-surface, restart чистит `on.*`, companions-аргумент `browseToScreen`) | ✅ | D6 переписан |
| R4-m2 (ветка валидации `companions` + stored-фолбэк) | ✅ | D5 |
| R4-m3 (канал `ds → ThemeContent` в валидацию; редактор warnings не эмитит) | ✅ | D9 |
| R4-m4 (сумма бюджета режет вместимость панели вдвое) | ✅ | D7: проверка per-spec, не сумма |
| R4-m5 (stale `on.*` при переключении версий) | ✅ | D6: фолбэк на startScreen поверхности |
| R4-m6 (ретайр-скан только head'ов — принять как ограничение) | ✅ | §4 |
| R4-m7 (последовательность волн и повторяющиеся файлы — явно) | ✅ | Шапка §5 |

## Статус процесса

- [x] Stage 1: план составлен (2 Explore, Opus)
- [x] Stage 2, раунд 1: 3 адверсариальных ревьюера (Opus) — 8 blocker, ~20 major; все оттриажены, план переработан (v2)
- [x] Stage 2, раунд 2: верификационное ревью v2 (Opus) — «блокеров нет», 7 major + 7 minor; все внесены (v3)
- [x] Одобрение пользователя (2026-08-02, команда на Stage 3 без деплоя)
- [x] Stage 3: W1–W5 выполнены 2026-08-03 (b4112bc, aeed6ca, d4d4305, 1ef0339, ba389cc); инженерный гейт §6 зелёный: `npm run verify`, `npm run e2e` (125 passed), runtime-приёмка — `snap --all-screens` duo-pos/duo-kso exit 0, снап второй поверхности несёт тему её ДС (визуально сверено). Не задеплоено: kill-switch `EASYUI_SURFACES` на проде выключен; продуктовая приёмка §6 (share-проход человеком, corner-кейсы, 0 регрессий на проде) — до снятия
