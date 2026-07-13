# Persist/deep-link стейта плеера (share-ссылка + авто-персист) — без своего StateStore

> **SUPERSEDED (2026-07-13):** заменён планом `2026-07-13-ui-ux-improvements.md` — sessionStorage-resume и state в share-query противоречат принятой политике состояния флоу (entryReason/reset-banner) и hardened store из `2026-07-12-feedback-fixes.md`. Share решается scoped-токенами (W3-3 нового плана).

> **Аддендум 2026-07-10** (из adversarial-ревью серверного плана `2026-07-10-server-api-versioning.md`; этот план исполняется **после** серверного, перед исполнением пересмотреть с учётом нового async-PlayerShell):
> 1. Persist-ключ и `baseline` должны включать ревизию/версию прототипа (после серверного плана doc приходит с `rev`/`version`) + hash манифеста кастомных компонентов — иначе снапшот от старой ревизии подхватится новой с тем же initial state.
> 2. Share-ссылка на опубликованный прототип пинует `version` в пути (`/p/:id/v/:version/...`), а не только screen+state.
> 3. Reserved-path guard: экспортировать из `validate.ts` общий predicate `isReservedStatePointer(pointer)` вместо массива JSON Pointer'ов — sanitizer сравнивает top-level ключи (`currentScreen`), а массив хранит пойнтеры (`/currentScreen`), прямое сравнение ничего не запретит.
> 4. Эффект «cancel + очистка storage по смене sessionNonce» обязан пропускать первый mount, иначе сотрёт только что загруженный persisted state.

## Context

Обсуждение «нужен ли нам StateStore» → вывод: **нет**. Стейт данных полностью делегирован `@json-render/react` (uncontrolled `JSONUIProvider` + сброс через `key`-remount), библиотека уже экспортирует `StateStore`/`createStateStore` как pluggable-шов на будущее. Реальная потребность пользователя — **persist/deep-link стейта**: (1) share-ссылка «текущий экран + заполненный стейт», (2) авто-персист сессии через reload. Обе решаются без controlled store: захват через `onStateChange` + `useStateStore().getSnapshot()`, восстановление через уже существующую точку `initialState` в `PlayerShell.tsx:35`.

Проверенные факты API (`node_modules/@json-render/react/dist/index.d.ts`, `dist/index.js`):
- `onStateChange` отдаёт **дельты** (`Array<{path, value}>`), не снапшот → пара с `useStateStore().getSnapshot()` через бридж-компонент внутри провайдера.
- `onStateChange` не срабатывает на init; все мутации v1-формата (`setState`/`pushState`/`removeState`, `$bindState`) через него проходят.
- `StateProvider` диффит `initialState` **по ссылке** и при смене identity пишет в store в обход `onStateChange` → передаваемый `initialState` обязан быть референциально стабильным (не инлайн-объект).
- Bootstrap-replace в `src/player/navigation.tsx:43` уходит на голый pathname → `?flow` естественно стирается из адресной строки после потребления. `LoadedPlayer` монтируется только после bootstrap-гейта → параметр читать уровнем выше (новый `PlayerSession`).
- Стейты прототипов крошечные (14–75 байт) → **без lz-string**, base64url(JSON) хватает; новая зависимость не нужна.

## Ключевые решения

| Вопрос | Решение |
|---|---|
| Носитель share | query-param `?flow=<base64url(JSON {v:1, screen, state})>`; кап encoded 2000 симв., при превышении share недоступен с сообщением |
| Авто-персист | **sessionStorage** (per-tab — совпадает с моделью per-tab sessionNonce; не течёт между людьми/днями), ключ `easy-ui:flow:v1:<protoId>`, значение с `baseline = JSON.stringify(doc.state)` — несовпадение (док изменился) → discard; debounce ~200мс + flush на `pagehide`/unmount; quota → тихий skip |
| Приоритет на входе | валидный `?flow` (screen == :screenId) → валидный persisted → `doc.state` |
| Restart | единственный источник смены nonce → эффект на смену `sessionNonce`: cancel debounce + очистка storage-ключа; entry-nonce guard игнорирует `?flow` после restart. `navigation.tsx` **не трогаем** |
| Валидация снапшота | недоверенный ввод: кап длины, try/catch на всё, plain non-array object, top-level ключи не из reserved-неймспейса (`/currentScreen`,`/navStack`,`/_viewer` — экспортировать из `src/prototype/validate.ts:9`); любая ошибка → фолбэк на следующий уровень, плеер не падает |
| Контракт формата | `docs/prototype-format.md:24` переписать: reload резюмит сессию (sessionStorage), share-ссылка восстанавливает снапшот (приоритет над авто-персистом), restart = чистый `doc.state` + очистка, вход всегда flowDepth 0 (Back выключен) |

## Новые модули (все в `src/player/`)

- **`flowSnapshot.ts`** — тип `FlowShareSnapshotV1 {v:1, screen, state}`, `sanitizeSnapshotState()` (plain-object + reserved-keys guard; reserved-список импортом из `validate.ts`).
- **`shareCodec.ts`** — `SHARE_PARAM="flow"`, `encodeShareParam(screen, state): string|null` (кап 2000), `decodeShareParam(raw): FlowShareSnapshotV1|null` (кап raw 4000, все ошибки → null).
- **`flowPersistence.ts`** — `loadPersistedFlowState(doc)`, `clearPersistedFlowState(protoId)`, `createFlowStatePersister(doc)` → `{save (debounce), flush, cancel}`; persister держит pending-снапшот сам (flush без чтения store).
- **`ShareFlowButton.tsx`** — кнопка в `ScreensSidebar` рядом с Back/Restart (внутри провайдера → `useStateStore()` доступен): `getSnapshot()` + `useParams().screenId` → encode → `navigator.clipboard.writeText` c fallback (readonly input «Copy manually»), aria-live статус («Link copied» / «too large»).

## Изменения существующих файлов

- **`src/prototype/validate.ts`** — одна строка: `const forbiddenPaths` → `export const reservedStatePaths` (переименовать 2 внутренних использования).
- **`src/player/PlayerShell.tsx`** — центральная перестройка:
  - `PlayerShell` → рендерит `<PlayerSession key={doc.id} doc={doc}>` (key поднимается с `PlayerNavigationProvider`);
  - `PlayerSession`: лениво (`useState(() => …)`) резолвит entry-стейт из `location.search`/storage **до** bootstrap-replace, оборачивает `PlayerNavigationProvider` + `LoadedPlayer`;
  - `LoadedPlayer`: `initialState = entryState && nonce === entryNonce ? entryState : doc.state` (референциально стабильно); `onStateChange` → `getSnapshotRef.current?.()` → `persister.save()`; `StateCaptureBridge` (внутри провайдера) кладёт `getSnapshot` в ref; эффект на смену nonce → `persister.cancel()` + `clearPersistedFlowState`; `pagehide`/unmount → `flush()`. Существующий `navigationRef`+runtime `useMemo` без изменений.
- **`src/player/ScreensSidebar.tsx`** — рендер `ShareFlowButton`.
- **`src/test/setup.ts`** — `sessionStorage.clear()` в `afterEach` (иначе персист из одного теста травит существующий тест «restart and prototype changes create a clean store»).
- **`docs/prototype-format.md`** — новый контракт персистентности (см. таблицу).

Не трогаем: `src/player/navigation.tsx` (+ его тесты), `src/catalog/*`, stale-гейт.

## Тесты

- Юнит: `shareCodec.test.ts` (roundtrip, unicode, все reject-ветки, кап), `flowPersistence.test.ts` (roundtrip после debounce/flush, baseline-mismatch, corrupt, quota-throw, cancel).
- RTL `PlayerShell.test.tsx`: reload-персист (тип → unmount/flush → свежий рендер по тому же пути → значение на месте); приоритет (?flow > storage > doc.state, invalid ?flow → storage, screen-mismatch → ignore); restart чистит storage; share-кнопка (стаб clipboard, распарсить скопированный URL); оба существующих теста зелёные без правок.
- e2e `e2e/dev/persistence.spec.ts`: (1) checkout: заполнить → reload → стейт на месте; Restart → чисто; reload → всё ещё чисто. (2) share: `grantPermissions(clipboard)` → скопировать → открыть в **новом browser context** → экран+стейт восстановлены, `flow=` стёрт из адресной строки. Опционально: share-ссылка через SPA-fallback в preview.

## Риски

- Дельты вместо снапшота в `onStateChange` — закрыто бриджем с `getSnapshot()`.
- Referential-diff `initialState` — закрыто стабильными ссылками + комментарий в коде.
- Hard-kill в 200мс debounce-окне теряет последний ввод — приемлемо (pagehide-flush покрывает reload).
- Вставка share-ссылки на уже открытый прототип через in-app навигацию не переприменяется (entry резолвится раз на вход) — принятое ограничение, комментарий в коде.
- StrictMode: ленивые инициализаторы — чистые чтения, эффекты идемпотентны.

## Исполнение (workflow проекта, CLAUDE.md)

1. **Stage 1**: сохранить этот план как `docs/plans/2026-07-10-flow-state-persist-share.md`, закоммитить.
2. **Stage 2**: `export CODEX_HOME="$PWD/.codex-home"` → adversarial-ревью плана Codex gpt-5.6-sol (config-level max), stdin-промпт из файла, `task --background` без `--write`; зомби-вотчер по status+pid. Триаж находок в план, при существенных правках — `--resume` того же треда.
3. **Stage 3**: 4 Codex-задачи `--fresh --write --effort medium`, «не коммитить», file ownership:
   - **T1** (без зависимостей): `flowSnapshot.ts`, `shareCodec.ts`, `flowPersistence.ts`, `validate.ts` (экспорт), `src/test/setup.ts`, юнит-тесты codec/persistence. Done: test/typecheck/lint зелёные, UI не тронут.
   - **T2** (после T1): `PlayerShell.tsx` (PlayerSession/бридж/wiring), `PlayerShell.test.tsx` (persist/приоритет/restart). Done: новые + оба старых теста зелёные, `navigation.tsx` untouched, `initialState` стабилен.
   - **T3** (после T1–T2): `ShareFlowButton.tsx`, `ScreensSidebar.tsx`, share-тесты, `docs/prototype-format.md`. Done: кнопка работает + fallback-ветки, доки обновлены.
   - **T4** (после T3): `e2e/dev/persistence.spec.ts` (+опц. preview). Done: `npm run verify` и `npm run e2e` целиком зелёные (включая нетронутый stale-history сценарий).
   Оркестратор независимо верифицирует done-критерии каждой волны, коммитит позонно; финал — `npm run verify` + `npm run e2e` + runtime-прогон `/verify`.
