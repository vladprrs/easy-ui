# Agent-iteration DX (harness-DX v6): меньше итераций на компонент при пересборке DS из Figma

Дата: 2026-08-02. Статус: **v6 после трёх раундов Stage 2 (раунд 1 — R1/R2/R3; раунд 2 — верификационный R4; раунд 3 — узкий финальный R5: «blocking-возражений нет», 4 major внесены). Готов к Stage 3 по отдельной команде.**

История: v3 — исходный draft; v4 — + интеграция `docs/EASYUI_PRODUCT_IMPROVEMENTS.md` (P8/P9, расширения P1/P3/P5/P6); v5 — триаж 40+ находок раунда 1 (§5): исправлены ложные посылки диагноза, P1 разделён на харнес/сервер, `track` перенесён из документа в lifecycle-колонку, P5.3 отправлен в RFC, волны пересобраны по файловым зонам; v6 — триаж раунда 2 (§5, «Раунд 2»): P2 переписан на read-путь DTO, P1b дополнен capture-подсистемами, spacing-фикс версионирован, §3 без переобещаний, топология харнес-зеркал зафиксирована фактически.

## 1. Диагноз: на чём агент теряет время

Замер по проду (`yandex-pay-v2`, агент yp-figma-rebuild, 2026-08-01 18:27 → 2026-08-02 10:52, ~16,5 ч):

| Метрика | Значение |
| --- | --- |
| Опубликовано атомов | 13 (`pay-*`) |
| Ревизий компонентов | 35 (в среднем 2,7; `pay-box` — 8, `pay-button-group` — 6) |
| Ревизий `ypv2-probe-atoms` | **40** (док 124 КБ, 16 экранов) + `ypv2-probe-molecules` — 7 |
| Версий темы | **13** |
| Итого записей на сервер | ~95 ≈ **7 записей на принятый атом** |

### 1.1 Церемония «пере-сохрани probe» (стоимость: ~40 публикаций 124-КБ дока)
Ревизия прототипа пинует manifest-hash компонентов и `designSystemMetaVersion`. После **каждой** публикации компонента и каждого PATCH темы агент обязан пересохранить probe-прототип до снапа, иначе snap показывает старое. 40 ревизий probe против 35 ревизий компонентов — почти 1:1: подавляющая часть — чистая церемония. Забытый шаг даёт «фикс не сработал»: в истории есть точный no-op (`pay-button-group` rev 2→3 идентичны; создан через PUT с `figma` — см. P5).

### 1.2 Покомпонентный рендер есть в продукте, но не в харнесе _(исправлено в v5)_
Ревью опровергло посылку v3/v4 «нет покомпонентного рендера»: `POST /api/components/:id/versions/:version/screenshot` уже принимает `props`/`exampleName`/`viewport`/`deviceScaleFactor`/`theme` (`server/routes/screenshots.ts:47`, `server/screenshot/service.ts:238`), а воркер снимает **элемент**, не вьюпорт — PNG уже content-box/hug (`scripts/screenshot-worker.mjs:132`, `src/capture/CaptureComponent.tsx:92`). Но `driver.mjs` умеет только прототипные съёмки — верба нет, скилл про эндпоинт не знает. Значит значительная часть 40 probe-ревизий — дефект **харнеса/скилла**, лечится за часы (P1a), а не серверной фичей. Чего в продукте действительно нет: рендер **сохранённой, но не опубликованной ревизии** (publish работает только с head, `server/routes/components.ts:94`) и geometry-probe для компонентной поверхности (`server/screenshot/service.ts:357` кидает на не-прототипном expected).

### 1.3 Слепой пиксельный дифф → серии 1-px итераций
Обратная связь — только «N px differ = X%» и красный diff-PNG. Агент угадывает правку: `gap: 2→4`, `position: top 1px`, зажим высоты — по 2–3 итерации там, где числовое сравнение геометрии против выписки из Figma дало бы ответ за одну. Geometry-probe есть, но только для прототипов и без сравнения с эталоном.

### 1.4 Churn темы: 13 версий × каскад пересохранений
Каждая правка темы = полный словарь токенов + пересохранение всех probe. Посылка v3 про «молчаливый откат `space.*`» уточнена ревью: PATCH **уже** 422-ит нарушения `space.*` (`server/designSystemsMeta.ts:34-55,169`). Реальные дыры другие (см. P6): патч, из которого `space.*` выпали целиком, проверку не запускает — для DS вне `systemScales` (включая пользовательские вроде `yandex-pay-v2`) шкала молча уезжает на каноническую, для wireframe/shadcn возвращается их базовая (`src/designSystems/spacingScale.ts:44,46`); и баг мерджа — overrides ложатся на `canonicalSpacingScale`, а не на базу DS (`:44` vs `:54`) — для yandex-pay невидимо (шкалы совпадают), для wireframe/shadcn один `space.*`-токен молча меняет md/lg/xl.

### 1.5 Длинный цикл «посмотреть один фикс»
5 команд на взгляд: publish → re-save probe → snap enqueue → poll/download → локальный pixelmatch.

### 1.6 Независимое подтверждение: прогон `yandex-pay-v2` (docs/EASYUI_PRODUCT_IMPROVEMENTS.md)
Второй агент на переносе YP DS в `yandex-pay-v2` собрал совпадающую картину и добавил новые классы потерь:

- **Version churn публичных версий**: 15 принятых компонентов → 36 опубликованных версий (2,4/компонент); `pay-button-group` v1–v5 и `pay-timer` v1–v4 — superseded pre-acceptance итерации (11 публикаций ради 2 принятых head'ов). Все промежуточные версии временно были `active`.
- **Probe churn**: 57 ревизий на два probe-дока при поверхности 30 экранов; тема дошла до v14, PATCH ради 2 токенов был full-replacement (104 токена + 3 шрифта + 15 иконок) → **43 byte-identical пересъёмки**.
- **Publish-time 422, ловимый префлайтом**: provenance `pageNodeId` — неподдерживаемое поле, убило publish после всей подготовки.
- **Metadata-only версии**: ButtonGroup v2↔v3, Timer v2↔v3 — одинаковый bundle hash, версии ради provenance-правок.
- **Warning-шум в галереях**: ради нуля предупреждений и зелёного readiness — 30 технических `Hotspot`, 256 `on`-bindings, 3 warning-only ревизии. (Уточнение ревью: reachability/handlers — warnings, не errors, `src/prototype/validate.ts:390,517`; арх-линты уже kind-aware. Реальная связка — readiness поднимает warn в статус, `server/readiness.ts:216`.)
- **Один diff-процент не описывает приёмку**: 7 из 15 компонентов потребовали ad-hoc политик (ROI, alpha, AA-диагностика); Timer: canonical 3,55% при structural 0% и geometry exact.
- **Ручная evidence-сборка**: 1 629 файлов, 24 самописных verifier/compare-скрипта, 32 SHA256SUMS — вне продукта.

## 2. Что меняем

Приоритет по соотношению «убитые итерации / стоимость». Разделение «харнес» (share-пакеты + зеркала в `.claude/skills`, канон — см. §4) и «сервер».

### P1a (харнес, quick win) — верб `preview` поверх существующего эндпоинта
`driver.mjs preview <componentId> [props.json] [--example name] [--viewport WxH] [--dsf N] [--theme light|dark]` → существующий `POST /api/components/:id/versions/:version/screenshot` (version = head), скачивание PNG. Вывод всегда печатает, **что отрендерено**: version/rev, `bundleHash`, `designSystemMetaVersion` (они уже есть в результатах джобы — `server/screenshot/service.ts:362-385`). Ограничения фиксируются в скилле честно: `--theme` — только режим light/dark, версию темы компонентная съёмка не пинует (берёт последнюю, `src/capture/CaptureComponent.tsx:60`); viewport в пределах серверных лимитов: 64..2000×64..4000 и `w·h·dsf² ≤ 20 000 000` (`server/screenshot/service.ts:127`) — при `--dsf 3` потолок вьюпорта ~2,2 Mpx, скилл пишет формулу с dsf² явно; очередь скриншотов — concurrency 1, cap 5 → драйвер обрабатывает `429 queue_full` ретраем с бэкоффом.
- Убивает: probe-церемонию для приёмки атомов на head-ревизиях (§1.1–1.2) — **без серверных правок**, доступно сразу.

### P1b (сервер + capture) — preview draft-ревизии и geometry для компонентной поверхности
1. Рендер **сохранённой, но не опубликованной head-ревизии** через candidate-bundle из P8: `preview --rev head-draft` — атом доводится до пиксель-perfect **до первой публикации** (удар по churn 2,4 версии/компонент). Полный перечень недостающих путей (весь текущий пайплайн знает только published-версии):
   - draft-ветка capture-роута и загрузчика бандла (`src/capture/CaptureComponent.tsx` резолвит `{id, version}` → `getComponentVersion` → `bundle.js?version`, `:56,110-113`) — нужен job-scoped URL candidate-bundle;
   - `enqueueComponent` для драфта: `bundleHash`/`propsJsonSchema`/`examples` берутся из результата extract драфта (validate/P8), а не из publish-строки (`server/screenshot/service.ts:246-254`);
   - allowlist: asset-ссылки извлекаются из исходника драфта (`collectAndValidateComponentAssetRefs` уже есть в pipeline) — ассеты пиннутся только при publish, для драфта пиннинга нет;
   - candidate-bundle URL job-scoped, не попадает в catalog/latest-active resolution, в bundle-export и в allowlist чужих джоб;
   - handshake-контракт: `ComponentExpected`/`ComponentReady` требуют `version: number` (`src/capture/protocol.ts:20-52`), маппинг воркера перечисляет поля жёстко (`scripts/screenshot-worker.mjs:43-46`) — для драфта нужен `rev`-вариант дискриминанта в `protocol.ts` + воркере, а также `targetOf` и `ScreenshotImageResult` (`service.ts:37,406-409`), чтобы результат сообщал «draft rev N»;
   - доставка props-схемы/examples на поверхность: для драфта published-DTO не существует (`CaptureComponent.tsx:56-63` фетчит `getComponentMeta`+`getComponentVersion`), выбор — **расширить `bootstrap`** (сегодня несёт только `props`, `protocol.ts:62-67`): enqueue кладёт туда propsJsonSchema/examples из extract-результата; job-scoped by construction, отдельный draft-DTO не вводим. Тема/шрифты рисков не несут — компонентная съёмка и так берёт последнюю тему.
   Семантика холодного кэша: если кандидат вычищен GC или не собирался — preview сам собирает его под тем же троттлингом P8 (эквивалент compile-подмножества validate) и переиспользует кэш по `sourceHash`.
2. Geometry-probe для компонентной поверхности: дискриминированный результат (сейчас тип прототип-специфичен и сборка кидает на не-прототипном expected, `service.ts:40-59,357`) + регистрация в `server/contracts.ts`/`openapi.json`/`/api/capabilities.features`.
- Адрес — `/api/components/:id/...` (глобальная адресация компонентов, не `/api/design-systems/:ds/...`).

### P2 (сервер) — Head-tracking для служебных прототипов, как lifecycle-атрибут
1. `track: "head"` — **колонка прототипа**, а не поле документа (документ — `z.strictObject`, неизвестный ключ ломает чтение доков старым образом при откате; lifecycle-поля `kind`/`tags` уже колонки — `server/repos/prototypes.ts:25-33`). Управление — `POST /api/prototypes/:id/lifecycle`. Формат документа (allowlist v1) не меняется, `documentVersion` не бампается.
2. Разрешён только для служебных `kind` (`component-gallery`, `evidence`, …) и пока прототип не опубликован. `publish` прототипа, создание share-гранта, visual-baseline и bundle-export трекающего дока → 422 со стабильным кодом.
3. Точка резолва — **read-путь DTO ревизии** для UI/плеера и **bootstrap.target** для съёмки: `componentManifestHash` уже вычисляется из пинов на read-пути (`server/repos/prototypes.ts:112-116,300-303`), поэтому DTO track-дока отдаёт **резолвнутые head-пины** + `resolvedAt`, и плеер/readiness/classifyRevision (без rev-кэшей — читают пины запросом) видят тот же резолв. Иммутабельность `revisions/:rev` перестаёт быть инвариантом только для track-доков (непубликуемы/нешерабельны по п.2). Гонку «publish между enqueue и рендером» закрывает **существующий канал** `bootstrap.target` (worker уже инжектит его — `server/screenshot/service.ts:406-409`, `scripts/screenshot-worker.mjs:97-103`; `CapturePrototype` сегодня его игнорирует): enqueue резолвит head, кладёт пины в `CaptureExpected` **и** в `bootstrap.target`, поверхность рендерит их вместо DTO-пинов. Записи allowlist остаются path-only (сверка идёт по точному pathname без query — `server/screenshot/sessions.ts:30-35`); никаких query-параметров у `snapshotUrl`. Exact-match handshake сохраняется. Ответ enqueue возвращает разрешённые пины (даёт P5.2 бесплатно).
4. Скоуп резолва — **только компонентные пины**. `designSystemMetaVersion` (и производный `builtinCatalogHash`, и allowlist ассетов темы — всё строится по пиннутой версии, `service.ts:220,275-278`) остаётся пином ревизии: после PATCH темы track-док по-прежнему требует пересохранения. Churn темы снимают P6 (no-op detection + dry-run), а не P2; распространение резолва на тему — RFC.
- Убивает: пересохранения probe для molecule/organism-экранов после публикаций **компонентов** (основной 1:1-источник из §1.1).

### P3 (харнес) — умный дифф в `compare.mjs`, без нового движка
Расширить существующий харнесный `compare.mjs` (единственный канон, зеркалится в share-пакеты): `% mismatch` + diff-PNG + **bounding-box'ы кластеров** («кластер 12×3 px @ (208,41)»); при несовпадении размеров — отчёт «candidate 328×56 vs ref 328×58» вместо exit 3; второй диагностический прогон threshold 0.25 (**AA-diagnostic**) в том же отчёте; опциональные `--region x,y,w,h[:maxDiff%]`; raw-эталон не мутируется. Серверный `server/visual/*` (там уже есть pixelmatch, includeAA, dimensionMismatch — `server/visual/diff-runner.ts`) в этом плане **не трогаем**: он остаётся путём приёмочных baseline'ов на published-версиях; унификация двух путей — в RFC (§6). Третьей реализации диффа не появляется: compare.mjs — уже существующий харнесный движок, мы его дорабатываем.
- Убивает: половину слепых 1-px итераций (§1.3) и большинство из 24 самописных compare-скриптов (§1.6).

### P4 (харнес) — числовая приёмка геометрии
`driver.mjs expect <expected.json> <actual.json>`: сравнение размеров/gap/паддингов с допуском, вывод «gap expected 8, got 6». `expected.json` агент пишет из выписки Figma (§4.1 скилла). Actual — из прототипного geometry-probe (есть сегодня) и компонентного (появится в P1b).
- Убивает: оставшиеся угадывания px — числовой вердикт до пиксельного.

### P5 — No-op-защита и видимость staleness _(переформулировано в v5)_
Ревью показало: повторная публикация неизменённого head **уже** невозможна (`409 already_published`, `server/repos/components.ts:46`; сохранение идентичного исходника — `400`, `server/routes/components.ts:232`). Кейс «rev 2→3 идентичны» возникает только через PUT с `figma` (ветка `figmaProvided`). Поэтому:
1. (сервер) No-op-детекция на PUT с figma-only изменением: если и source, и `figma` byte-идентичны head — ответ `unchanged: true` **плюс обязательный `rev` головы** (PUT всегда возвращал `{rev}` — совместимостный инвариант для старых драйверов именно он; `published.json.version` относится к ответу publish и не затрагивается). Правка provenance при изменившемся `figma` по-прежнему создаёт ревизию — отвязка provenance от ревизий отправлена в RFC (§6).
2. (харнес) Драйвер печатает 409/400/422/429 человекочитаемо («identical to rev N — nothing to publish») и в каждом preview/snap-выводе показывает отрендеренные пины и версию темы (P1a/P2 отдают данные).

### P6 (сервер) — Тема: dry-run, sparse-операции, две настоящие дыры `space.*`
1. `theme --dry-run`: валидация + дифф токенов + итоговая `resolvedSpaceScale` без записи; идентичная тема → no-op detection (не создаёт версию) — именно это, вместе с P2, убирает 13–14-версионный churn, sparse сам по себе версии не экономит.
2. Sparse-операции `addTokens`/`addFonts`/`addIcons` поверх `baseVersion` (политика `appendOnly`): additive-правка из 2 токенов передаёт 2 объекта. Семантика: резолв строго против `baseVersion` (существующий CAS, `server/designSystemsMeta.ts:164`), «токен уже есть с другим значением» → 409 (не тихая перезапись), удаление под `appendOnly` невозможно — остаётся полный PATCH.
3. Дыры `space.*` (посылка v4 «нет 422» опровергнута — 422 уже есть): (а) патч с полным отсутствием `space.*` должен либо наследовать шкалу базовой версии, либо 422 — не молчаливая подмена (для DS вне `systemScales` — канонической, для wireframe/shadcn — их базовой); (б) баг мерджа base-drop (`spacingScale.ts:44` vs `:54`): `resolveSpacingScale` не версионирована и стоит на read-пути, поэтому «исправить баг» и «read-путь прежний» одновременно недостижимы без явной модели — вводим **версионирование резолвера**: поле `spacingResolver` на строке версии темы (существующие версии — `1`, legacy-поведение байт-в-байт; новые — `2`, фикшеный мердж на базу DS). Перед включением — аудит по копии прод-БД всех версий тем всех DS: вывод `(ds, version, fallbackTriggered, baseDropped)`.
4. Ответ PATCH/apply перечисляет прототипы с устаревшими пинами (дёшево — по `prototype_revision_components`). Usage-graph «затронутые компоненты» — RFC.

### P7 (харнес, инкрементально) — Синк скилла `yp-figma-rebuild` в конце каждой волны
Не одной терминальной волной (иначе весь измеримый выигрыш уезжает в конец, а скилл в поле зовёт несуществующие ручки): после каждой волны — обновление соответствующих разделов скилла + пересборка `share/yp-figma-rebuild-skill` (+`.tgz`) и зеркал. Итоговое состояние: атом принимается через `preview --ref` + `expect` до публикации, публикация один раз; probe-доки нужны со стадии молекул, объявляются `track: head` через lifecycle-роут; галереи — `kind: component-gallery` (тоже lifecycle-роут, не поле дока); «warnings галереи — не блокер». Новый драйвер проверяет `/api/capabilities.features` и падает читаемым сообщением на старом сервере.

### P8 (сервер) — Validate-префлайт head-ревизии + эфемерный candidate-bundle
`POST /api/components/:id/validate` (**только head-ревизия**: publish работает только с head; rev-адресный publish — это promote из RFC): прогоняет publish-набор проверок — typecheck, compile, import verification, schema/definition extraction, валидация provenance-полей (кейс `pageNodeId` ловится здесь со стабильным code + указанием поля), плюс parity-предупреждение «schema `.default()` ↔ render `??`-fallback расходятся» (дешёвый compile-time вариант §9.1 improvements-дока). Без создания версии, без изменения public state.
Receipt: `sourceHash`/`bundleHash`/`themeVersion`/`catalogRevision`; гарантия «publish не упадёт на 422» ограничена перечисленным набором проверок — canonical-role, reuse-гейт и прочие каталого-временные проверки receipt **не** покрывает (они остаются на publish, no-op/validate их не обходит).
Ресурсы и безопасность (1-CPU прод, `tsc`+`Bun.build` на каждый вызов): конкурентность 1 на пользователя + общий cap очереди, идемпотентный кэш результата по `sourceHash` с TTL ~24 ч и лимитом суммарных байт, GC на старте и при записи, лимиты в `/api/capabilities.limits`, env-kill-switch. Кэш `importPublished` (`Map` по `id@rev`, `server/components/pipeline.ts:108`) не должен отравляться validate'ом: ключ для validate — `sourceHash` либо отдельный неразделяемый путь, чтобы последующий publish не пропустил собственную import-верификацию. Наоборот работает легально: результат validate передаётся в publish через существующий шов `PublishExtraction`/`preExtracted` (`pipeline.ts:~92-101`, с уже требуемой кодом сверкой `sha256` исходника) — не платим второй раз за `checkSource`/smoke-рендер на 1-CPU проде. Candidate-bundle — строго эфемерный кэш без публичного URL-контракта и без ссылок из evidence (RFC сможет заменить его без миграции).
- Убивает: pre-acceptance публикации (11 из 36 версий в §1.6) — вместе с P1b, и publish-time 422.

### P9 (сервер, дёшево) — Readiness/warning-профиль для служебных `kind`
Сужено по ревью (арх-линты уже kind-aware, reachability/handlers — warnings): (а) kind-aware подавление двух конкретных предупреждений в `src/prototype/validate.ts` (недостижимый экран; интерактивный компонент без handler — для terminal-состояний) для служебных `kind`; (б) readiness-профиль: warn-и служебных доков не поднимают статус; (в) `profile` включается в readiness-отчёт, чтобы «зелёный» нельзя было прочитать двусмысленно; (г) смена `kind` пишет аудит-событие; переход в служебный kind при наличии опубликованных версий запрещён (kind — мутабельная колонка, иначе это самообслуживаемый обход валидаторов задним числом). Ожидаемо: у существующих галерей в проде исчезнут warn-и — это желаемый эффект, гейты публикации и так выключены. Переключатель экранов в плеере — вне скоупа (отдельная UI-задача, `src/player/`).
- Убивает: технические Hotspot/bindings и warning-only ревизии галерей (§1.6).

## 3. Ожидаемый эффект и как меряем

- После W1: probe-док больше не нужен для взгляда на атом, но цикл — 3 команды (`component` → `publish` → `preview`, эндпоинт работает только по published-версии) и публикация на итерацию остаётся. **После W2**: 2 команды без публикаций (`component` → `preview --rev head-draft`); `--ref` и `expect` добавляются в W5.
- Записи на атом ~7 → ~1–2; публичные версии на новый компонент 2,4 → ~1 — **при условии обновлённого скилла** (продукт без lifecycle-статусов не запрещает промежуточные публикации; экономия обеспечивается связкой P8+P1b+P7).
- Исчезают классы ошибок «stale pin», «publish-422 после подготовки», «фикс не сработал из-за no-op/staleness»; «canvas size mismatch» не исчезает, но превращается из exit 3 в диагностический отчёт (а для компонентной поверхности PNG и так hug).
- Baseline и контроль: дешёвый отчёт поверх существующего аудита (`driver.mjs audit --design-system`) — версии/ревизии на компонент за период; снимаем до W1 и после W5 на следующей DS-миграции.

## 4. Волны — по файловым зонам, с критериями приёмки

Фактическая топология харнеса (проверено ревью): `driver.mjs` — канон в `.claude/skills/author/`, копии в `share/easy-ui-authoring-skill` и `share/yp-figma-rebuild-skill` отличаются строкой импорта auth-модуля (побайтовое зеркалирование невозможно by design); `compare.mjs`/`api.mjs`/`easyui-auth.mjs` существуют **только** в `share/yp-figma-rebuild-skill/` — канон там. Скрипта пересборки зеркал сегодня нет, синк ручной. Поэтому пунктом W1 вводится `scripts/sync-share-skills.mjs` (учитывает различие import-строк), и W-волна не считается закрытой без его прогона (+пересборка `.tgz`).

Серверные волны выполняются **последовательно: W2 → W3 → W4** (все трогают `server/contracts.ts` и генерируемый `server/openapi.json` — регенерация в конце каждой волны, `scripts/generate-openapi.ts` + дрейф-чек).

**W1 (харнес, без сервера): P1a + P5.2 + человекочитаемые ошибки + скрипт синка зеркал + синк скилла.**
Файлы: `.claude/skills/author/driver.mjs`, `scripts/sync-share-skills.mjs` (новый), share-зеркала, скилл.
Done: `preview` отдаёт PNG head-версии с props/example/viewport/dsf и печатает version/bundleHash/dsMetaVersion; 429 ретраится с бэкоффом; 409/400 печатаются человекочитаемо; sync-скрипт делает зеркала воспроизводимыми; скилл принимает атом через preview без probe-дока (с оговоркой: до W2 публикация на итерацию остаётся). Миграций нет; деплой не нужен (харнес).

**W2 (сервер + capture: component lifecycle): P8 + P1b + P5.1.**
Файлы: `server/routes/components.ts`, `server/routes/screenshots.ts` (форма ручки с `rev`), `server/components/pipeline.ts|compile.ts`, `server/screenshot/service.ts` (компонентная ветка), `src/capture/CaptureComponent.tsx` (draft-ветка), `src/capture/protocol.ts` + `scripts/screenshot-worker.mjs` (rev-дискриминант handshake), `.claude/skills/author/driver.mjs` (`preview --rev`), `server/contracts.ts`, `server/openapi.json`, `server/routes/meta.ts` (capabilities.features/limits).
Done: validate на head даёт receipt и стабильные коды (тест на кейс `pageNodeId`); preview draft-head отдаёт PNG и geometry, включая asset-ссылки драфта в allowlist (тест); preview после GC кандидата пересобирает его сам (тест); candidate-bundle недоступен вне своей джобы (тест); publish после validate переиспользует `preExtracted` (тест: extract не выполняется дважды); повторный PUT идентичного source+figma → `unchanged:true` c `rev` (тест совместимости старого драйвера); кэш validate не отравляет publish-верификацию (тест); GC/TTL/лимиты покрыты тестом; owner-check на `GET /api/screenshot-jobs/:jobId` и для component-джоб (сейчас перепроверяется только prototype, `server/routes/screenshots.ts:30-32`); env-kill-switch. Миграции: таблица/каталог кэша кандидатов (или файловый кэш без миграции — решить при имплементации, зафиксировать в PR).

**W3 (сервер + capture: prototype lifecycle): P2 + P9.**
Файлы: `server/repos/prototypes.ts`, `server/routes/prototypes.ts`, `server/readiness.ts`, `src/prototype/validate.ts`, `server/screenshot/service.ts` (enqueue-резолв), `src/capture/CapturePrototype.tsx` (резолв из snapshotUrl-параметра), contracts/openapi/capabilities.
Done: `track:head` ставится lifecycle-роутом только на служебные kind; publish/share/baseline/export трекающего дока → 422 (тесты); **снап трекающего дока проходит handshake после публикации новой версии компонента без пересохранения дока** (интеграционный тест); **publish между enqueue и рендером не роняет джобу и не меняет её резолв** (тест гонки через bootstrap.target); DTO track-дока отдаёт резолвнутые пины + `resolvedAt`; readiness-отчёт несёт `profile`; смена kind — аудит-событие; запрет служебного kind при публикациях (тест). Миграции: колонка `track` (+ аудит-событие смены lifecycle — в существующий аудит-лог, без новой колонки), forward-only, документ не трогаем (откат образа безопасен).

**W4 (сервер: тема): P6.**
Файлы: `server/designSystemsMeta.ts`, `server/routes/designSystems.ts`, `src/designSystems/spacingScale.ts`, contracts/openapi.
Done: dry-run возвращает дифф+`resolvedSpaceScale`; no-op тема не создаёт версию; sparse: CAS по baseVersion, 409 на конфликт значения (тесты); аудит прод-копии `(ds, version, fallbackTriggered, baseDropped)` приложен к PR **до** включения фиксов (а)/(б); версии с `spacingResolver: 1` резолвятся legacy-путём байт-в-байт (снапшот-тест на wireframe/shadcn темах), новые (`2`) — фикшеным; env-kill-switch на новое поведение. Миграции: поле `spacingResolver` на версии темы (backfill `1`).

**W5 (харнес): P3 + P4 + финальный P7 + доки.**
Файлы: `share/yp-figma-rebuild-skill/compare.mjs` (канон), `driver.mjs` (expect), share-зеркала через sync-скрипт, скилл, `docs/server-api.md`, `docs/agent-authoring-policy.md` (галереи/track/preview-цикл; `docs/prototype-format.md` не меняется — формат не тронут).
Done: compare печатает кластеры/AA-diag/regions/размерный отчёт (фикстурные тесты); expect даёт «gap expected 8, got 6»; скилл переведён на цикл `preview --rev --ref` + `expect` → publish один раз.

Каждая серверная волна: verify + e2e + runtime-прогон по `/verify`; деплой по `/deploy` (сборка только в GitHub Actions); строка «миграции: …/нет» и kill-switch — обязательные пункты PR.

## 5. Триаж ревью Stage 2

Ревьюеры: R1 — корректность против кода, R2 — скоуп/декомпозиция, R3 — риски/миграции. Вердикты: ✅ принято, 🟡 принято частично, ❌ отклонено (с обоснованием).

### Blockers
| Находка | Вердикт | Как отражено |
|---|---|---|
| R1-B1/R2-B1: покомпонентный рендер уже есть; P1 строил параллельную поверхность; часть §1.2 — дефект скилла | ✅ | §1.2 переписан; P1 разделён на P1a (харнес, W1, первой) и P1b (draft-rev + geometry, W2); новый endpoint `/design-systems/:ds/...` убран |
| R3-B1/R1-M2: `track` в документе ломает откат (strictObject, stored-контракт) и противоречит прецеденту lifecycle-колонок | ✅ | P2: track — lifecycle-колонка + роут; формат/`documentVersion` не тронуты |
| R3-B2/R1-M1: track:head vs frozen-expected handshake, share/publish/baseline/export | ✅ | P2.2–2.3: резолв пинов при enqueue, exact-match сохранён; 422 на publish/share/baseline/export |
| R3-B3: visual references для трекающих доков несравнимы | ✅ | P2.2: baseline для track-доков запрещён (вошло в 422-набор) |
| R1-B2/R2-B3/R3-M8: P5.3 provenance-CAS — изменение модели данных (figma в immutable-ревизии, JOIN в DTO, экспорт), не роут | ✅ | P5.3 исключён из плана → §6 RFC (append-only evidence-таблица); в плане остался только no-op figma-PUT (P5.1) |
| R1-B3: validate для произвольного rev бессмыслен — publish только head | ✅ | P8: validate только head; rev-адресный publish = promote (RFC) |
| R3-B4: validate без троттлинга на 1-CPU проде; нет expiry/GC | ✅ | P8: конкурентность/cap/TTL/GC/лимиты в capabilities/kill-switch; done-критерии W2 |
| R2-B2/R1-M4 vs R3-m13: P3 — «третий движок диффа»; куда класть pixelmatch — сервер или driver | 🟡 | Решено: только харнесный `compare.mjs` (расширение существующего движка, эталоны на диске агента, прод CPU-ограничен); `server/visual/*` не трогаем, унификация — RFC. Рекомендация R1/R2 «расширять server/visual» отклонена для этого плана: тянет политику хранения references и fingerprint-модель draft-ревизий — это RFC-слой |

### Majors
| Находка | Вердикт | Как отражено |
|---|---|---|
| R1-M5: no-op-guard уже есть (409/400); кейс rev2→3 — figma-only PUT; `unchanged` вместо 409 ломает контракт | ✅ | P5 переписан: детекция только figma-only PUT; 409/400 печатает драйвер |
| R3-M10: ответ `unchanged` без `version` уронит старые драйверы; features-флаги; скилл не переписывать раньше сервера | ✅ | P5.1 (обязательные version/rev), P1b/W2 (features), P7 инкрементальный |
| R1-M7: 422 на space.* уже есть; реальные дыры — omission-check и base-drop-баг; рантайм-фолбэк старых версий сохранить | ✅ | §1.4 и P6.3 переписаны; аудит до фикса; снапшот-тест read-пути |
| R3-M6: «фолбэк не активен» непроверяемо; аудит всех версий всех DS; 422 только на write | ✅ | P6.3: аудит `(ds,version,fallbackTriggered,baseDropped)` — done-критерий W4 |
| R3-M7/R2-m14: sparse — CAS против baseVersion, 409 на конфликт, удаления нет; версии экономит no-op, не sparse | ✅ | P6.1–6.2; impact usage-graph → RFC |
| R1-M3/R3-M9/R2-M10: P9 — посылка «валидаторы заставляют» неверна (warnings); kind мутабелен → обход задним числом | ✅ | §1.6 уточнён; P9 сужен: 2 варнинга + readiness-профиль + аудит kind + запрет смены при публикациях |
| R1-M6: geometry для preview — новый серверный тип результата, не «расширение», и не харнесная работа | ✅ | Перенесено в P1b (W2, сервер); в W5 остался только `expect` |
| R1-M8: кэш `importPublished` по `id@rev` отравляется validate'ом | ✅ | P8 (ключ sourceHash/отдельный путь) + тест в done W2 |
| R3-M5: candidate-bundle — новая отдаваемая ручка, изоляция от catalog/share/чужих джоб | ✅ | P1b.1 + тест в done W2 |
| R1-M9/R2-M4: волны пересекаются по файлам, W2 перегружена, W3 «харнес» содержала серверную работу | ✅ | §4 пересобран по файловым зонам (5 волн) |
| R2-M6: receipt без инвалидации по fingerprints; «no 422» переобещано | ✅ | P8: receipt с fingerprints, гарантия ограничена набором проверок |
| R2-M7: метрика «2,4→1» держится на скилле, не на продукте | ✅ | §3: метрика условная; candidate — эфемерный кэш без контракта |
| R2-M8: весь выигрыш в конце (P7 в W4) | ✅ | P7 инкрементально + W1 (quick win) первой |
| R2-M9/R3-m16: нет baseline-инструментария и per-wave done-критериев | ✅ | §3 (audit-отчёт) + done-списки в §4 |
| R2-M11: parity-lint defaults↔fallbacks дёшев и зря отложен | ✅ | Вошёл в P8 как warning-check |
| R2-M12: persistent reuse decision зря отложен молча | 🟡 | Остаётся в RFC, но с обоснованием (§6): адъюдикация человеком случается 1–2 раза за миграцию, admin-обход существует; терпимо против стоимости подписи/fingerprint-модели. Первый кандидат на добор |

### Minors (все ✅, если не отмечено)
Приняты и отражены: R1-m1 (тема не пинуется preview — сказано в P1a), R1-m2 (лимиты 20 Mpx/viewport — P1a; память про «16 Mpx» будет поправлена), R1-m3 (contracts/openapi/capabilities — в файлах волн), R1-m4 (kind через lifecycle-роут — P7), R1-m5 (P5.2 — харнес), R1-m6 (очередь/429 — P1a), R1-m7 (плеер-переключатель — вне скоупа, P9), R2-m13 (P3 разделён: контракт останется в RFC, здесь только отчёт compare), R2-m15/R3-m15 (kill-switch — done W2/W4), R2-m16 (no-op не обходит гейт — P8), R2-m17 (адресация — P1b), R2-m18 (`track` только для служебных kind, экспериментальность — P2), R2-m19 (канон и зеркала — §4 шапка), R2-m20 (миграции/откат в каждой волне — §4), R3-m11 (documentVersion не тронут — P2.1), R3-m12 (нормализация no-op = byte-identical source+figma; `--force` не вводим — пересборка при смене тулчейна создаёт новую ревизию обычным путём: source меняется тулчейном редко, отклонено как YAGNI ❌), R3-m14 (`--theme-version` не поддержан осознанно — P1a говорит это явно).

### Раунд 2 — верификационное ре-ревью (R4), триаж в v6

| Находка | Вердикт | Как отражено |
|---|---|---|
| R4-B1: резолв пинов при enqueue не работает — рендер определяет DTO ревизии (`CapturePrototype.tsx:40-90` ← `prototype_revision_components`); иммутабельность DTO — инвариант | ✅ | P2.3 переписан: read-путь DTO для track-доков (резолвнутые пины + `resolvedAt`), enqueue передаёт резолв через snapshotUrl-параметр (гонка с параллельной публикацией закрыта); `CapturePrototype.tsx` — в файлах W3; интеграционный done-критерий handshake |
| R4-B2: draft-preview не имел пути рендера (capture-роут, загрузчик бандла, props-схема, allowlist ассетов драфта) | ✅ | P1b.1 — полный перечень подсистем; `CaptureComponent.tsx` — в файлах W2; done-критерии дополнены |
| R4-M1: §3 переобещал «2 команды после W1» и `--ref` до W5 | ✅ | §3 переписан честно: после W1 — 3 команды и публикация на итерацию; 2 команды — после W2; `--ref`/`expect` — W5 |
| R4-M2: топология харнеса описана неверно (compare.mjs только в yp-share; скрипта пересборки нет) | ✅ | Шапка §4 — фактическая топология; `scripts/sync-share-skills.mjs` — пункт W1 |
| R4-M3: done W4 взаимоисключающи («фикс base-drop» vs «read-путь прежний») | ✅ | P6.3(б): версионирование резолвера `spacingResolver 1|2` на версии темы; done W4 и миграция переписаны |
| R4-M4: не задана семантика preview при вычищенном/несобранном кандидате | ✅ | P1b.1: auto-build под троттлингом P8, кэш по `sourceHash`; тест «preview после GC» в done W2 |
| R4-m1 (масштаб дыры omission уточнён), R4-m2 (лимит с dsf²), R4-m3 (инвариант — `rev`, не `version`), R4-m4 (`preExtracted`-шов в P8), R4-m5 (W2→W3→W4 последовательно, openapi в конце волны), R4-m6 (миграция W3: одна колонка + аудит-событие), R4-m7 («canvas mismatch» — улучшение диагностики, не исчезновение класса) | ✅ | Внесены в соответствующие пункты |
| R4-m8: осознанный tradeoff P3 не проговорён | ✅ | Фиксируем здесь: пока приёмка идёт на draft-ревизиях, серверной записи приёмочного вердикта нет вовсе, и харнесный compare и `server/visual/*` могут давать разные вердикты на одной паре PNG (разные дефолты threshold/includeAA). Это осознанная цена за отказ от fingerprint-модели draft-ревизий в этом плане; снимается в RFC (унификация + acceptance-runs) |

### Раунд 3 — узкая финальная проверка P2.3/P1b (R5): «blocking-возражений нет»

| Находка | Вердикт | Как отражено |
|---|---|---|
| R5-M1: `snapshotUrl`-параметр — несуществующий канал (allowlist сверяется по path без query; поверхность параметр не читает) | ✅ | P2.3: канал заменён на существующий `bootstrap.target` (worker уже инжектит, поверхность научится читать); allowlist остаётся path-only |
| R5-M2: track компонентных пинов не убирает пересъёмки после PATCH темы — обещание было шире реализации | ✅ | P2.4: скоуп резолва явно сужен до компонентных пинов; тема — пин ревизии, её churn снимает P6; theme-резолв — RFC. Бенефит-буллет P2 переписан |
| R5-M3: в перечне P1b пропущен handshake-контракт (`protocol.ts`, worker-маппинг, `targetOf`, `ScreenshotImageResult`) | ✅ | P1b.1 дополнен; `src/capture/protocol.ts` и `scripts/screenshot-worker.mjs` — в файлах W2 |
| R5-M4: не выбран канал доставки props-схемы/examples для драфта | ✅ | P1b.1: выбран расширенный `bootstrap` (job-scoped by construction), отдельный draft-DTO не вводится |
| R5-m1: нет теста заявленной гонки enqueue↔publish | ✅ | Done W3: тест гонки через bootstrap.target |
| R5-m2: в файлах W2 нет `routes/screenshots.ts` и `driver.mjs`; owner-check component-джоб | ✅ | Файлы W2 дополнены; owner-check — в done W2 |

Положительно верифицировано R5: `componentManifestHash` считается из пинов на read-пути (`server/repos/prototypes.ts:112-116`) — резолв head-пинов автоматически даёт согласованный хэш; rev-кэшей classifyRevision/bundleReadiness, требующих инвалидации, нет; auth-дыры в draft-preview нет (component-съёмка требует владельца, capture-принципал ограничен allowlist'ом).

## 6. Вне скоупа этого плана → отдельный RFC «Candidate Acceptance Pipeline»

`docs/EASYUI_PRODUCT_IMPROVEMENTS.md` предлагает слои, сознательно не входящие в этот план (тяжёлые, требуют своего planning-цикла; план им не противоречит):

- полный lifecycle draft → candidate → accepted → promoted → superseded, атомарный promote, auto-supersede (§3.2–3.4); rev-адресный publish;
- **provenance/evidence отдельно от runtime-версий** (§3.5, §9.2) — append-only evidence-таблица `(component_id, rev, seq, figma_json, author, at)`, резолв при чтении, экспорт с `seq`; существующие metadata-only версии в проде остаются как есть, миграции нет (перенесено сюда из P5.3 v4 по итогам ревью);
- единый `acceptance-runs` оркестратор с evidence bundle, CLI `--out`, UI (§4);
- Visual Diff Contract 2.0 целиком: exception lifecycle с owner/expiry, content-addressed references, renderer/font fingerprints, унификация харнесного compare и `server/visual/*`, fingerprint-модель для draft-ревизий (§5);
- server-side interaction runner (§7);
- schema-defaults parsing на хосте (§9.1, полный вариант — ABI-миграция); parity-lint уже взят в P8;
- usage/dependency impact-граф темы (§8.2) и `latestCompatible`-пиннинг (§8.3 — упрощённая форма взята в P2);
- verification matrix (§10), Figma Source Package (§11), design-system change sets (§13), flow-level release gate (§14), dependency workbench (§15);
- **persistent reuse decisions (§12)** — обоснование отсрочки: человеческая адъюдикация случается 1–2 раза за DS-миграцию, обход `--force-new --reason` существует; стоимость fingerprint/подписной модели выше выигрыша сейчас. Первый кандидат на добор при следующей миграции, если блокировки участятся.

P8 этого плана — совместимый первый шаг RFC: validate-receipt и эфемерный candidate-bundle спроектированы так, чтобы позже стать входом `acceptance-runs`/`promote` (receipt уже несёт fingerprints), не создавая публичных контрактов, которые пришлось бы мигрировать.
