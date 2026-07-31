# План: Library Performance and Prioritized Preview (проект 1 из 3)

Дата: 2026-07-31
Версия: v3 (после двух раундов адверсариального ревью)
Спека: `docs/superpowers/specs/2026-07-30-library-performance-design.md`
Зонт: `docs/superpowers/specs/2026-07-30-library-reuse-architecture-design.md`

## 0. Границы

Реализуется **только проект 1**. Проекты 2 (reuse enforcement) и 3 (composition v2 +
migration) — отдельные планы после деплоя этого.

Из спеки §6 явно откладывается на проект 2: поиск по композициям (спека это
разрешает: «During the first project it searches components only»).

Не делаем: серверные PNG-превью, feature-flag двойного рантайма, изменения
`/api/catalog/manifest` и `/capture/component/...` (их потребители — плеер,
скриншоты, SDK, старые клиенты).

## 1. Что не так сейчас (подтверждено чтением кода)

- `src/library/LibraryPage.tsx:21-33` — `loadLibraryStatuses()` делает
  `getComponentMeta()` на **каждый** компонент (N+1, неограниченный параллелизм).
  Ключ карты — только `component.id`, что схлопывает компонент, активный в двух
  дизайн-системах.
- `LibraryPage.tsx:75-76` — `statusSignature` входит в deps `useApi`, поэтому смена
  системы/фильтра перезапускает весь fan-out.
- `src/library/components/ComponentPreview.tsx:59-96` — на каждую карточку
  same-origin iframe `/capture/component/:id/:version`, каждый бутает полный SPA.
  `IntersectionObserver` (L69-71) **защёлкивает** `visible=true` и никогда не
  размонтирует iframe.
- Статусы (`published/verified/visualPending/blocked/rejected`) считаются на клиенте
  в `src/library/libraryModel.ts:143-159` из полной истории версий + визуальных ссылок.

## 2. Триаж ревью v1

| # | Находка | Решение |
|---|---|---|
| B1 | `verified` через `EXISTS(pass-run)` не воспроизводит `lastRun` семантику | **Принято**, §2.1 переписан на `ROW_NUMBER()`-предикат |
| B2 | не исключены soft-deleted визуальные ссылки | **Принято**, `vr.deleted_at IS NULL` |
| B3 | per-`(id,ds)` статус расходится с легаси `componentLibraryStatus` | **Принято частично**: расхождение намеренное (этого требует спека §2), но фиксируется таблицей расхождений и тестом; manifest не трогаем |
| B4 | `token()`/`Icon` читают глобальный снапшот `__easyUiShared` — per-card тем не существует | **Принято**, архитектура темы переработана (§4.3): гибрид «один глобальный владелец темы + per-card CSS-переменные» |
| M1 | `buildPreviewSpec` нужны `slots`/`capabilities`, их нет в `ComponentPreviewData` | **Принято**, добавлены в ответ |
| M2 | `position:fixed`/`100vh` компоненты вылезут из карточки | **Принято**, `FitToBox` всегда создаёт containing block |
| M3 | порталы уходят из scoped-поддерева | **Решается B4-гибридом**: глобальный владелец темы даёт `:root`-фолбэк |
| M4 | теряется `CaptureChrome` reset анимаций | **Принято**, scoped-reset в обёртке превью |
| M5 | `catalogRevision` неполон и не snapshot-consistent | **Принято**: считается из собранных строк ответа, хендлер в `db.transaction` |
| M6 | `systems[]` self-contradictory | **Принято**: всегда по нефильтрованному каталогу |
| M7 | perf-датасет через HTTP publish неподъёмен | **Принято**: сидинг напрямую через `ComponentRepo` |
| M8 | абсолютные perf-гейты флапают в контейнере | **Принято**: baseline-арм + относительная дельта + абсолютный потолок |
| minors | коды ошибок, узкий SELECT, параметризация error boundary, владение файлами, и т.д. | **Приняты**, разнесены по разделам |

Раунд 2 (по плану v2):

| # | Находка | Решение |
|---|---|---|
| B‑1 | SQL из v2 считал `ROW_NUMBER()` по всем прогонам и только потом фильтровал по `asset_id` — переоткрытие B1 | **Принято**, партиционирование по `(reference_id, reference_asset_id)`, §3.1 |
| M‑1 | гейт «≤12 смонтированных» арифметически несовместим с порогом размонтирования 800 px | **Принято**: вводится жёсткий бюджет смонтированных превью с вытеснением по расстоянию (§4.4) — он строго сильнее правила 800 px, поэтому спека §5 не нарушается |
| M‑2 | документный `ThemeStyle` переобъявит `@font-face "YS Text"` и переключит шрифт всей страницы (+3 запроса, +133 KB) | **Принято**: глобальный владелец темы работает в tokens-only режиме, `@font-face` целиком у `fontRegistry`, который **не регистрирует семейство, уже доступное документу** |
| M‑3 | §4.1 и §7 противоречат друг другу про владельца `src/api/client.ts` | **Принято**: владелец — T3 |
| M‑4 | смена доминирующей системы фильтром оставляет смонтированные превью со старым снапшотом `token()`/`Icon` | **Принято**: scoped-переменные на **каждой** карточке безусловно; доминирующая система фиксируется один раз на загрузку каталога и не пересчитывается фильтром |
| M‑5 | прямой сидинг через `ComponentRepo` требует четырёх незаявленных предпосылок | **Принято**, §5 дополнен |
| M‑6 | `catalogRevision` считался от отфильтрованного ответа ⇒ описывает вид, а не каталог | **Принято**: считается от нефильтрованного набора |
| m‑1…m‑9 | экранирование значений токенов, владение тестами/строками, фикстура для `Icon`, «семантика, а не грамматика» селектора, арм `libraryPreviews=off`, определение «одновременности ≤4», порядок cleanup, битая ссылка B4→§3.3, переоценка роли порталов | **Приняты**, разнесены по разделам |

## 3. Серверная часть

### 3.1 `GET /api/catalog/library?designSystem=<slug?>`

Новый `server/routes/libraryCatalog.ts` → `routeLibraryCatalog(request, db): Response`.
Регистрация inline в `server/main.ts` рядом с `/api/catalog/manifest` (`main.ts:165`).

**Весь хендлер выполняется в `db.transaction(...)`** — иначе `catalogRevision` может
описывать не тот снапшот, что `components[]` (M5).

- **Идентичность `(componentId, designSystem)`** во всех внутренних картах;
  helper `libraryKey(ds, id)` экспортируется.
- **Набор строк** — общий helper `activeCatalogRows(db, designSystem?)`, вынесенный из
  `catalogManifest` (`server/routes/components.ts:99`), чтобы семантика активной
  версии не разъехалась. Manifest переводится на этот же helper, его выходной
  формат не меняется.
- **Статусы — set-based.** Три запроса на весь ответ, независимо от размера каталога:

  1. **published/rejected/blocked/deprecated.** Один
     `SELECT p.component_id, r.design_system, p.version, p.status
      FROM component_publishes p
      JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev`,
     группировка в JS по `(component_id, design_system)`:
     - `published = группа содержит status='active'`
     - `latest = строка с max(version)` внутри группы
     - `rejected = latest.status === 'rejected'`
     - `blocked = latest.status ∈ {deprecated, superseded, archived}`
     - `deprecated = latest.status ∈ {deprecated, superseded}` (как в manifest)

     **Намеренное расхождение с легаси (B3):** `componentLibraryStatus` считает
     `latest` по *всем* версиям компонента без разбиения по системам
     (`server/repos/components.ts:51`). Read-model разбивает по системе — этого
     прямо требует спека §2. Расхождение проявляется только для компонента с
     активными версиями в двух системах. Фиксируется таблицей расхождений в
     `server/library-catalog.test.ts` (легаси-значение / новое значение / причина).
     `/api/catalog/manifest` **не меняется** — у него другие потребители; расхождение
     `deprecated` между manifest и library для таких компонентов документируется.

  2. **verified.** Один запрос с оконной функцией, воспроизводящий `referencePublic()`
     (`server/visual/repo.ts:220-233`) и фильтр `listReferences` (`repo.ts:135`):

     ```sql
     SELECT vr.id, vr.fingerprint_json, run.status
     FROM visual_references vr
     LEFT JOIN (
       SELECT r.reference_id, r.reference_asset_id, r.status,
              ROW_NUMBER() OVER (
                PARTITION BY r.reference_id, r.reference_asset_id
                ORDER BY r.created_at DESC, r.id DESC) AS rn
       FROM visual_runs r
     ) run ON run.reference_id = vr.id
          AND run.reference_asset_id = vr.asset_id
          AND run.rn = 1
     WHERE vr.deleted_at IS NULL
     ```

     **Партиционирование обязано включать `reference_asset_id`.** Легаси
     (`server/visual/repo.ts:224`) берёт *самый свежий прогон среди тех, что шли
     против текущего эталона*, а не «самый свежий вообще, если он против текущего
     эталона». Контрпример: эталон переzалит, новейший прогон — против старого
     asset, а более старый прогон против текущего asset прошёл. Легаси ⇒
     `verified`; партиционирование только по `reference_id` ⇒ `visualPending`.
     Прогоны с `reference_asset_id IS NULL` не матчатся ни при каком партиционировании —
     это совпадает с легаси.

     `fingerprint_json` парсится один раз, отбираются `scope='component'`.
     `verified = published && ∃ ссылка с (componentId, refVersion === активная версия)
     и её lastRun.status === 'pass'`. **`.some()`-семантика**: у одного
     `(componentId, refVersion)` легитимно несколько ссылок (viewport / theme /
     propsHash — `server/visual/fingerprint.ts:19-25,38-41`), достаточно одной
     проходящей. `visualPending = published && !verified`.

  3. **headUsageCount** — `headUsageCounts(db)` **без фильтра по системе**
     (`server/usageGraph.ts:222`), матчинг по `componentId`: он фильтрует по
     `components.design_system`, а каталог — по `component_revisions.design_system`,
     и для перемещённого компонента они расходятся. Кэш там по стемпу
     `updated_at`; число запросов константно, латентность при промахе — нет
     (полное сканирование пинов), это принято.

- **`figma`** — `{fileKey, nodeCount}` из `component_revisions.figma_json` head-ревизии
  (`parseFigmaStored`), одним `SELECT`; `null` при отсутствии/битом JSON.
- **`preview`** — сервер решает селектор ровно правилом карточки
  (`ComponentCard.tsx:32`): `definition_meta.example` **истинно** → `{selector:"legacy"}`;
  иначе первый по `sort()` ключ `examples` → `{selector:"named", name}`; иначе `null`.
  Truthiness (а не `Object.hasOwn`) — сознательно, чтобы не отдавать пустой `{}` как
  превью; пинится тестом. Логика — `server/components/previewSelector.ts`,
  переиспользуется preview-эндпоинтом.
- **`systems`** — `{id, name, count}` по **нефильтрованному** каталогу активных
  (не retired) систем; `components[]` фильтруется. Системы с нулём компонентов
  не отдаются (сегодняшнее поведение тулбара, `LibraryPage.tsx:59-62`).
- **`catalogRevision`** — sha256 канонического JSON собранных строк **нефильтрованного**
  каталога (сортировка по `(kind, designSystem, id)`), включая статусы и
  `headUsageCount`. Считать от отфильтрованного `components[]` нельзя: два клиента с
  разными `?designSystem=` получили бы разные «ревизии каталога» на одном и том же
  состоянии БД, а проект 2 сравнивает это значение в `reuseOverride.catalogRevision`.
  Нефильтрованный набор хендлер всё равно собирает — он нужен для `systems[]`.
  Детерминизм обеспечен `canonicalStringify` (`src/capture/canonicalJson.ts:11-18`),
  который сортирует ключи на всех уровнях, поэтому порядок ключей из
  `JSON.parse(definition_meta)` не влияет.
  `server/catalogRevision.ts`, сигнатура сразу с `kind`, чтобы проект 2 добавил
  композиции без слома. Канонизация — существующий `src/capture/canonicalJson.ts`.
  Потребитель в проекте 1 — только диагностика и e2e; реальный потребитель —
  проект 2 (`reuseOverride.catalogRevision`).
- Не отдаём: `source`, `propsJsonSchema`, `example`/`examples`, историю версий.
  Покрывается тестом.
- `designSystem` неизвестна или retired → `404 not_found` (как manifest).

### 3.2 `GET /api/components/:id/versions/:version/preview?selector=legacy|named&name=`

В `routeComponents` (`server/routes/components.ts:135-139`), ветка
`tail[0]==="versions" && tail.length===3 && tail[2]==="preview"`.

- **Строгая семантика селектора, как в Capture** (`src/capture/CaptureComponent.tsx`
  `propsSelection`): читаем `searchParams.getAll()` вручную (`parseQuery` схлопывает
  повторы, last-wins — `server/contracts.ts:70-74`). Дубли `selector`/`name` → `400
  invalid_request`; `named` без параметра `name` → `400`; `legacy` с `name` → `400`.
  Грамматика **намеренно другая** (m‑4): Capture использует `?props=example` /
  `?example=<n>`, здесь — `?selector=&name=`; пинится семантика, а не строка запроса.
  Отдельно фиксируется `name=` (пустая строка): это *присутствующий* параметр, то
  есть именованный поиск примера с пустым именем → `422 unknown_example`, как в
  Capture, а не `400`.
- **Узкий SELECT**, а не `repo.version()` — тот отдаёт `source` и весь
  `definition_meta` включая `propsJsonSchema`/`examples`
  (`server/repos/components.ts:55`).
- Коды ошибок — **существующие**: версия не найдена → `404 not_found`; версия не
  renderable → `404 bundle_unavailable` (`repos/components.ts:53-55`, тот же код
  вернёт следующий запрос за бандлом). `selector=named` и нет такого примера →
  `422 unknown_example` (прецедент: `server/screenshot/service.ts:249`,
  объявлен в `server/contracts.ts:315`). `selector=legacy` без `example` →
  `422 example_unavailable` (новый код; `ApiError` допускает 422 —
  `server/http.ts:4`).
- Ответ = `ComponentPreviewData` из спеки §2 **плюс `slots: string[]` и
  `capabilities?`** — они нужны `buildPreviewSpec` (`componentPage/model.ts:42-57`)
  для слот-плейсхолдеров (M1). Оба поля уже лежат в `definition_meta`.
- Тело ограничено существующим `MAX_EXAMPLE_BYTES = 16 KiB`
  (`server/components/exampleValidate.ts:3`).
- `noStore`; `private, no-store` навешивает `protectSessionResponse` автоматически.

### 3.3 Контракты

- `server/contracts.ts`: `catalogLibraryContract`, `componentPreviewContract` с
  полными zod response-схемами и списком `errors`.
- `npm run generate:openapi` → `server/openapi.json` (гейт `npm run verify:openapi`).
- `server/contract.test.ts` требует **биекции ключей контрактов и case-list**
  (`contract.test.ts:238-242`), кейсы идут одним последовательным `orderedCases()`
  пайплайном — добавляем 200-кейс на каждый контракт и по кейсу на каждый
  заявленный код ошибки в этом же пайплайне.
- SDK не меняется (генератор читает только manifest).

## 4. Клиент

### 4.1 API-слой

`src/api/client.ts` (владелец — **T3**; T4 потребляет эти типы, поэтому T3 идёт раньше):
типы `LibraryCatalogResponse`, `LibraryCatalogEntry`, `ComponentPreviewData`
+ `getLibraryCatalog(params, signal)`, `getComponentPreview(id, version, selector, signal)`.

### 4.2 `PreviewScheduler`

Новый `src/library/preview/previewScheduler.ts`. База — `PreviewLoadQueue`
(`src/gallery/GalleryPreview.tsx:31-65`), плюс ключи и приоритеты:

```ts
export type PreviewPriority = 0 | 1 | 2 | 3;
export class PreviewScheduler {
  run<T>(key: string, priority: PreviewPriority, task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T>;
  reprioritize(key: string, priority: PreviewPriority): void;
}
export const PREVIEW_LOAD_LIMIT = 4;
```

- меньший numeric priority раньше; ties — FIFO по монотонному `seq`;
- `run()` с уже стоящим `key` не создаёт дубль: возвращает существующий промис и
  поднимает приоритет, если новый строже (покрывает StrictMode-двойной mount);
- abort до старта — снятие из очереди + reject `signal.reason`; abort после старта
  прокидывается в `task(signal)`, начатый `import()` не отменяем;
- модульный синглтон `previewScheduler` + `resetPreviewSchedulerForTests()`.

### 4.3 Тема: гибрид «один глобальный владелец + per-card переменные»

**Причина переработки (B4).** Опубликованные бандлы получают `token(key)` и `Icon`
из **единственного глобального снапшота** `globalThis.__easyUiShared.tokens/.icons`
(`server/shims/abi-v4.ts:23,28-29,40-42`; то же в v2/v3), который пишет только
`applyActiveTheme` (`src/designSystems/theme.tsx:118-120`). Per-card темы для этих
двух API технически невозможны без смены ABI. Раньше это работало, потому что
каждый iframe — свой JS-realm.

Замер реального каталога (локальная БД, 47 активных компонентов): `token()` — **0**,
`Icon` — **0**, `color()` — **26**. `color()`/`space()` — чистые
`var(--eui-color-*)` / `var(--eui-space-*)` (`abi-v4.ts:34-38`), они работают через
наследуемые CSS-переменные. То есть цена ограничения сегодня нулевая, но её нужно
явно ограничить и покрыть.

Решение:

1. **Один документный владелец темы, tokens-only.** Библиотека монтирует ровно один
   существующий `ThemeStyle` (`src/designSystems/theme.tsx:153`) для *доминирующей*
   системы. Он нужен ровно за одним: заполнить `shared.tokens`/`shared.icons`, чтобы
   `token()`/`Icon` вообще работали (плюс бесплатный `:root`-фолбэк для
   компонентских `createPortal(..., document.body)`; хостовый `Overlay` портирует
   внутрь сцены — `src/catalog/hostPrimitives/Overlay.tsx:24-35` — и в фолбэке не
   нуждается).

   **Доминирующая система фиксируется один раз на загрузку каталога** (система с
   наибольшим числом записей в нефильтрованном ответе) и **не пересчитывается при
   смене фильтра** (M‑4): `applyActiveTheme` мутирует глобальный объект
   (`theme.tsx:118-120`), React смонтированные превью не перерисовывает, а шим
   читает снапшот в момент рендера (`server/shims/abi-v4.ts:28-31,39-49`) — смена
   доминирующей системы «на лету» оставила бы живые карточки с чужими иконками.

   **`ThemeStyle` работает в tokens-only режиме** (M‑2): `serializeThemeCss`
   (`theme.tsx:59-65`) эмитит и `:root`-токены, и `@font-face`. Тема `yandex-pay`
   объявляет семейство **"YS Text"**, которым набран сам хром приложения
   (`--font-eui-display/-ui`, `src/styles/index.css:49-60,124-125`), но с
   `/api/assets/...`-источниками. Документный `<style>` добавляется в `head`
   последним ⇒ вся страница перерисовалась бы теми же байтами по новым URL: +3
   запроса, +133 KB против бюджетов ≤30 / ≤3.0 MiB, плюс page-wide font swap на
   экране, где раньше этого не было вовсе (iframes изолировали). Поэтому
   `serializeThemeCss` получает флаг `{ fonts: false }`, а `@font-face` целиком
   переходит к `fontRegistry` (п. 4).

   Утечки токенов нет: хром читает `--color-eui-*`/`--font-eui-*`, темы эмитят
   `--eui-color-*`/`--eui-space-*`; ни один файл в `src/app/**` и `src/styles/*.css`
   не читает `--eui-*`.
2. **Per-card CSS-переменные — на каждой карточке безусловно.** 
   `src/designSystems/ScopedThemeSurface.tsx`: токены (кроме `space.*`, их
   пропускает и `serializeThemeCss`, `theme.tsx:56`) кладутся как inline custom
   properties на обёртку превью и наследуются только в поддерево карточки.
   Scoped-переменные ставятся и карточкам **доминирующей** системы тоже (M‑4):
   иначе они зависели бы от `:root` и сломались бы при любом изменении глобального
   владельца.

   **Значения — сырые, без `cssEscapeString`** (m‑1): `serializeThemeCss`
   экранирует значения (`theme.tsx:13-22`), потому что они попадают в текст CSS,
   а React ставит `--*` через `setProperty` с сырой строкой — экранированное
   значение дало бы литеральные `\22 `. Имена переменных — через существующий
   `tokenCssVar()`. Юнит-тест: scoped-значение рендерится идентично `:root`-варианту.
3. **`space.*`** — через существующий `SurfaceSpacingScope`
   (`surfaceSpacingStyle`) **на том же элементе**: он `cloneElement`-ит
   единственного ребёнка и дописывает `style` после его собственного
   (`SurfaceSpacingScope.tsx:19`). Ребёнком обязан быть настоящий элемент
   (`<div className="contents">`, как `ComponentPage.tsx:399-401`) — `CaptureSurface`
   не принимает `style` и молча его потеряет.
4. **`@font-face`** — единственный владелец `src/designSystems/fontRegistry.ts`:
   один `<style data-eui-fonts="<ds>@<metaVersion>">` на пару, refcount, дедуп,
   регистрация только когда смонтировано хотя бы одно превью этой системы.
   `metaVersion` — из `DesignSystemSummary.latestMetaVersion`
   (`src/api/client.ts:271`), который и так приходит в `themeCache`.
   **Семейство, уже доступное документу, не регистрируется** (проверка по
   `document.fonts` / `FontFace.family`): это ровно случай "YS Text", где тема
   дублирует байты шрифтов хрома под другими URL. Правило снимает +133 KB и
   page-wide swap; покрывается юнит-тестом.
5. **Ограничение документируется** в `docs/prototype-format.md`/README библиотеки:
   в инлайн-превью `token()` и `Icon` разрешаются темой доминирующей системы.
   E2E-фикстура (m‑3): ни одна DS-версия в БД сейчас не несёт иконок
   (`icons_json = "[]"`), и 0 из 47 активных бандлов импортируют `Icon` — поэтому
   T7 обязана завести asset-иконку, версию дизайн-системы с ней и компонент,
   импортирующий `Icon`, иначе критерий неисполним. Проверки: компонент с `Icon`
   доминирующей системы рендерит непустой `img[data-eui-icon]`; компонент с
   `color()` в недоминирующей системе — корректный цвет.
6. **Сброс анимаций (M4).** Эквивалент `CaptureChrome` (`src/capture/CaptureChrome.tsx:16-22`)
   scoped-селектором `[data-component-preview] *` в обёртке превью.
   `useCaptureTheme` **не** переиспользуем — он переключает классы на
   `document.documentElement` (`CaptureChrome.tsx:6-13`).

`src/designSystems/themeCache.ts` — `Map<designSystem, Promise<ThemeContent>>` поверх
`getDesignSystemById`, чтобы 120 карточек дали ≤ (число систем) запросов.
Ответ `getDesignSystemById` тяжёлый (весь список дескрипторов компонентов,
`src/api/client.ts:271`) — учитываем в бюджете 3.0 MiB; если не влезаем, добавляем
проекцию `?fields=theme` отдельной задачей.

### 4.4 `InlineComponentPreview`

Новый `src/library/preview/InlineComponentPreview.tsx` — замена
`ComponentPreview.tsx` (iframe удаляется).

1. `IntersectionObserver` (`rootMargin: "240px 0px"`, **не защёлкивающий**) →
   near-viewport;
2. `previewScheduler.run(key, priority, …)`, задача = `getComponentPreview()` +
   `themeCache.get(designSystem)` + `loadCustomComponents([ref])`;
3. рендер: обёртка со scoped-токенами + `SurfaceSpacingScope` →
   `PreviewErrorBoundary` → `CaptureSurface` с деревом `buildPreviewSpec()`.
   Общий рендер-путь выносится из `ComponentPage.tsx:336-453` в
   `src/library/preview/renderPreview.tsx` (`RuntimePreview`,
   `RuntimeComponentErrorReporter`, placeholder) и переиспользуется обеими
   поверхностями;
4. **`FitToBox`** (`src/library/preview/FitToBox.tsx`): `ResizeObserver` на реальном
   DOM-узле + `transform: scale(k)` **всегда** (даже при k=1) — трансформ создаёт
   containing block для `position:fixed` детей; плюс `overflow:hidden`,
   `isolation:isolate`, `contain: layout paint` на превью-зоне (M2). Публикация
   лишь *предупреждает* про `h-screen|100vh|fixed inset-0`
   (`server/routes/components.ts:44-46,59-62`), такие исходники существуют и
   раньше их «вьюпортом» был iframe;
5. **Бюджет смонтированных превью — 12, с вытеснением по расстоянию** (M‑1).
   Правило спеки «размонтировать дальше 800 px» и гейт спеки «≤12 смонтированных»
   несовместимы напрямую: карточка ≈ 320–360 px (превью 170 + тело), сетка
   `lg:grid-cols-3` (`LibraryPage.tsx:152`), полоса удержания при 800 px сверху и
   снизу ≈ 2500 px ⇒ ~7 рядов × 3 ≈ 21 смонтированное превью — гейт не прошёл бы
   никогда. Поэтому вводится реестр смонтированных превью с жёстким лимитом 12:
   при превышении вытесняется превью с наибольшим расстоянием до вьюпорта.
   Правило 800 px сохраняется как обязательный минимум (второй наблюдатель,
   `rootMargin: "800px 0px"`) — бюджет строго сильнее его, поэтому спека §5 не
   нарушается, а гейт §8 достижим. Реестр ведётся по идентичности регистрации, а не по
   ключу записи каталога: ключ уникален на странице (§4.5 — витрина повышает, а не
   копирует), но зависеть от этого реестр не имеет права — схлопни он две живые
   регистрации в одну, счётчик вернул бы 1 на два превью, а вытеснение сняло бы одно из
   двух. Модуль остаётся в кэше `loadCustomComponents`, поэтому возврат в зону — без сети;
6. ошибки: metadata/bundle/render/theme различаются в `data-*`-диагностике, UI —
   одна компактная плашка + «Повторить»; retry поднимает generation;
   `FullDocumentReloadRequiredError` (`src/customComponents/loader.ts:28`) →
   предложение перезагрузить страницу (как `ComponentPage.tsx:317`);
   `preview === null` → `ComponentPreviewMissing`, без ретраев.

`PreviewErrorBoundary` (`src/library/componentPage/PreviewErrorBoundary.tsx`)
**параметризуется**: сейчас у него жёсткий `ErrorState` без ретрая и импорт
componentPage-строк; добавляем проп `fallback`, Component Page передаёт текущий.

Атрибуты для e2e/perf: `data-component-preview={key}`,
`data-component-preview-mounted`, `data-component-preview-state`
(`idle|queued|loading|ready|error|missing`).

### 4.5 Ранжирование и ярусы

`src/library/libraryTiers.ts`:
- `rankRecommended(entries)` — спека §6: непустой `canonicalFor` → `headUsageCount`
  desc → verified перед visualPending → уровень сборки desc → локализованное имя;
  исключая deprecated/rejected/blocked; cap 12; дедуп против нижних секций;
- `partitionTiers(entries)` → `{recommended, high(page|template|organism),
  molecules, atoms(atom|layoutNeutral), retired(deprecated|replacement)}`.
  **Дедуп против нижних секций = повышение:** ключи витрины вычитаются из нижних ярусов,
  поэтому пять ярусов взаимно исключительны и в сумме дают весь каталог, а запись
  рендерится ровно один раз. Иначе один компонент был бы двумя одинаковыми ссылками и
  двумя превью под одним `libraryEntryKey` — реестр смонтированных (§4.4.5) схлопнул бы
  пару в одну запись, и бюджет ≤12 вместе с гейтом §8 считали бы неправду;
- приоритеты: явный выбор → 0, recommended+high → 1, molecules → 2,
  near-viewport prefetch и retired → 3.
  **Атом и лэйаут-нейтральная обёртка не встают в очередь автоматически ни в каком ярусе**
  (спека §5), включая «Рекомендуем»: `previewPriorityFor` возвращает для них `null` —
  «сам не грузится». Приоритет 0 значит «выбрано пользователем», а не «атом»; повышенный
  на витрину атом показывает на карточке ту же кнопку «Показать превью», и уже нажатие
  даёт интент `explicit` с приоритетом 0.

Компактный индекс атомов — `src/library/components/CompactIndex.tsx`: строка с
именем/бейджами и `<button>` «Показать превью» (клавиатура), раскрытие → priority 0,
автозагрузки нет. Кнопка — общий
`src/library/components/PreviewDisclosureButton.tsx`: её же рисует `ComponentCard`,
получив `priority === null`, чтобы клавиатурный контракт и строка были ровно одни.

Поиск — существующий `searchComponents` (`libraryModel.ts:91`), идёт по всем ярусам;
выбранный результат получает priority 0 через `previewScheduler.reprioritize`.

### 4.6 `LibraryPage`

- один обязательный запрос `getLibraryCatalog`; `listDesignSystems`,
  `getCatalogManifest`, `getComponentMeta`, `listVisualReferences` из LibraryPage
  уходят (`systems[]` теперь из read-model);
- `loadLibraryStatuses` и `statusMap` удаляются: статус лежит в записи;
- `componentLibraryStatus` в `libraryModel.ts` становится мёртвым для LibraryPage —
  **оставляем** его и `libraryModel.test.ts` как исполняемую спецификацию легаси
  семантики, на которую ссылается серверная таблица расхождений; удаление —
  отдельным шагом после деплоя;
- `applicableLibraryStatusKeys` перебазируется на `entry.status`;
- `data-library-ready` выставляется по одному запросу ⇒ «searchable before previews»
  выполняется по построению;
- скелет из 6 карточек — только на этот единственный запрос;
- `LibraryPage.test.tsx:38` (проверка `src` iframe) переписывается;
- **арм `?libraryPreviews=off`** (m‑5): превью не монтируются вовсе, метаданные
  рендерятся как есть. Прецедент — `src/gallery/GalleryPage.tsx:67` +
  `scripts/perf-gallery.mjs:36`. Нужен perf-харнессу как baseline-арм и полезен
  как аварийный тумблер.

## 5. Perf-гейт

`scripts/perf-library.mjs` + `scripts/perf-library-dataset.ts`, префикс `perf-library-`.
Датасет: 45 atoms, 35 molecules, 35 organisms, 5 pages/templates, ≥3 дизайн-системы,
смешанные статусы/figma/визуальные прогоны/usage, реальные examples, бандлы разного
размера.

**Сидинг напрямую через `openDatabase()` + `ComponentRepo`** (M7), а не через HTTP
`POST /api/components`: публикация одного компонента = `extractDefinition` (подпроцесс)
+ `typecheckComponent` + `compileComponent` (`server/routes/components.ts:67-84`), для
120 компонентов это неподъёмно; плюс `components.name` глобально UNIQUE
(`server/migrations.ts:28`), а `DELETE` требует `baseRev` и даёт 409 при использовании
(`routes/components.ts:116-126`) — то есть провалившийся прогон навсегда засорял бы
БД. Используем ~6 предкомпилированных бандлов, размноженных по id/именам.

Предпосылки прямого сидинга, которые обязана выполнить реализация (M‑5):

- **`host_abi_version`.** `stage()` жёстко пишет `1` (`server/repos/components.ts:46`),
  реальный пайплайн патчит его отдельным UPDATE (`routes/components.ts:74-75`) —
  сидер обязан повторить UPDATE, иначе read-model рекламирует ABI 1 для v4-бандлов.
- **Дизайн-системы.** Не-retired локально только `yandex-pay` и `e2e-custom-ds`;
  `shadcn`/`wireframe` имеют `retired=1`, а триггеры
  `components_/component_revisions_reject_retired_design_system_insert`
  (`server/migrations.ts:6-11,337-348`) дадут `RAISE(ABORT)`, и read-model джойнит
  `ds.retired=0`. Для «≥3 систем» сидер создаёт свежие `design_systems` (с `owner_id`)
  **и** `design_system_versions` с токенами/шрифтами — без них превью рендерятся без
  темы и трафик темы, заложенный в бюджет, вообще не возникает.
- **Визуальные и usage-строки.** `visual_references.asset_id` — FK RESTRICT на
  `assets`, нужна синтетическая строка `assets` (id/sha256 UNIQUE/mime/size; байты
  не нужны, read-model их не открывает). Usage требует
  `prototypes` + `prototype_revisions` + `prototype_revision_components`.
- **Где лежит БД.** `perf-gallery.mjs` сидит по HTTP через `--url`; прямой
  `openDatabase()` работает только на одном хосте с сервером и требует явного
  `--data-dir`. `perf:library` объявляется local-only.
- **Порядок cleanup** (m‑7): сначала `prototype_revision_components` (FK RESTRICT на
  `component_publishes`) и `visual_runs`/`visual_references` (FK RESTRICT на
  `assets`), затем родители. Всё — по префиксу `perf-library-`, в одной транзакции.

Окружение — как в `perf-gallery.mjs:8-9` (1440×900, 40 ms, 5/1 Mbit, cold context).
Медианы ≥5 прогонов. **Два арма** (M8): `?libraryPreviews=off` (метаданные) и полный.
Гейты: относительная деградация < 20 % (как `perf-gallery.mjs:103`) **и** абсолютные
потолки спеки §8 как «предупреждение + запись в отчёт», блокирующими абсолютными
делаем только детерминированные метрики:

| Метрика | Гейт |
|---|---|
| Точных `GET /api/components/:id` при первичной навигации | = 0 (блокирующий) |
| iframe превью | = 0 (блокирующий) |
| Пиковая одновременность **задач планировщика** | ≤ 4 (блокирующий) |
| Запросов до первого превью | ≤ 30 (блокирующий) |
| Трафик до первого превью | ≤ 3.0 MiB (блокирующий) |
| Смонтированных превью после успокоения | ≤ 12 (блокирующий) |
| Прирост JS heap после полного скролла | ≤ 80 MiB (блокирующий) |
| Searchable ready / first preview ready | относительная дельта < 20 %, абсолют — в отчёт |

«Одновременность» считается по **задачам планировщика**, а не по HTTP-запросам
(m‑6): одна задача выпускает три запроса (preview-мета + тема + бандл), поэтому
сетевой счётчик показал бы до 12. Измеряем по `data-component-preview-state` или по
счётчику in-flight задач, выставляемому планировщиком в `data-*` на корне страницы.

Отчёт — `docs/perf-library-report.md`, `process.exitCode = 2` при провале,
npm-скрипт `perf:library` (в `verify` не включаем: нужен собранный SPA и сеть —
как и `perf-gallery`).

## 6. Тесты

**Юнит (vitest, `src/**`):** `previewScheduler` (конкурентность, FIFO при равном
приоритете, дедуп по ключу, reprioritize, abort до/после старта, StrictMode);
`libraryTiers` (ранжирование, разбиение, дедуп recommended); `ScopedThemeSurface`
(две системы на странице не пересекаются; scoped-переменные перекрывают `:root`);
`fontRegistry` (дедуп по `ds@metaVersion`, refcount); `InlineComponentPreview`
(состояния, ретрай, `FullDocumentReloadRequiredError`, missing, unmount-порог);
`LibraryPage` (один запрос; поиск до превью; композитный ключ).

**Сервер (bun test):** `server/library-catalog.test.ts` — **таблица расхождений** с
`componentLibraryStatus` (легаси / новое / причина), включая компонент, активный в
двух системах; `verified` кейсы: re-upsert эталона + pass→fail, прогон только против
старого asset, несколько ссылок на одну версию (одна pass ⇒ verified),
soft-deleted ссылка; отсутствие `source`/`propsJsonSchema` в обоих ответах; грамматика
селектора == Capture; `not_found`/`bundle_unavailable`/`unknown_example`/
`example_unavailable`; truthiness-правило выбора примера.
`server/library-catalog-queries.test.ts` — обёртка над `db.query` инстанса
(проверено: свойство перезаписываемо, счётчик работает; `db.run`/`db.prepare` не
перехватываются, поэтому read-model обязан ходить только через `db.query`) —
число запросов ограничено константой и **не растёт** при 10 vs 100 компонентах.
Контракт-кейсы — в `server/contract.test.ts`.

**E2E (playwright):** метаданные ищутся до первого превью; превью организма раньше
превью атома; поиск поднимает офскрин-результат; превью атома раскрывается с
клавиатуры; скролл прочь размонтирует, возврат переиспользует модуль; две темы на
странице не портят хром; `position:fixed`-компонент не перекрывает тулбар;
`Icon`-компонент доминирующей системы рендерится; один сломанный компонент не ломает
соседей; ноль iframe.

## 7. Волны и владение файлами

| Волна | Задача | Владеет |
|---|---|---|
| W1 | **T1 сервер**: read-model, preview-эндпоинт, `activeCatalogRows`, `catalogRevision`, `previewSelector`, контракты, openapi, серверные тесты | `server/routes/libraryCatalog.ts`, `server/routes/components.ts`, `server/main.ts`, `server/catalogRevision.ts`, `server/components/previewSelector.ts`, `server/contracts.ts`, `server/openapi.json`, `server/library-catalog*.test.ts`, `server/contract.test.ts` |
| W1 | **T2 клиент-инфра**: scheduler, themeCache, ScopedThemeSurface, fontRegistry, tokens-only режим `serializeThemeCss` | `src/library/preview/previewScheduler.ts`, `src/designSystems/ScopedThemeSurface.tsx`, `src/designSystems/themeCache.ts`, `src/designSystems/fontRegistry.ts`, `src/designSystems/theme.tsx`, `src/designSystems/theme.test.tsx` + новые тесты |
| W2 | **T3 API-типы + ярусы** | `src/api/client.ts`, `src/library/libraryTiers.ts` + тесты |
| W3 | **T4 рендер превью**: вынос общего пути из ComponentPage, InlineComponentPreview, FitToBox, реестр смонтированных превью, параметризация PreviewErrorBoundary | `src/library/preview/renderPreview.tsx`, `InlineComponentPreview.tsx`, `FitToBox.tsx`, `mountedRegistry.ts`, `src/library/componentPage/ComponentPage.tsx`, `componentPage/ComponentPage.test.tsx`, `componentPage/PreviewErrorBoundary.tsx`, `componentPage/model.ts`, `componentPage/index.ts`, **`src/app/strings/library.ts`** (строки плашки/ретрая; T5 их только использует) |
| W4 | **T5 страница**: LibraryPage, карточки, компактный индекс, арм `libraryPreviews=off`; удаление `ComponentPreview.tsx` | `src/library/LibraryPage.tsx`, `src/library/components/*`, `src/library/libraryModel.ts`, `src/library/*.test.tsx` |
| W5 | **T6 perf-харнесс** | `scripts/perf-library.mjs`, `scripts/perf-library-dataset.ts`, `package.json` |
| W5 | **T7 e2e** | `e2e/**` |

T1 ‖ T2. T3 после T1 (нужны серверные типы). T4 после T2+T3. T5 после T4. T6 ‖ T7 после T5.

## 8. Критерии готовности

- `npm run verify` зелёный;
- `npm run e2e` зелёный;
- `npm run perf:library` — блокирующие гейты §5 пройдены, отчёт закоммичен;
- ноль iframe превью в библиотеке; `ComponentPreview.tsx` удалён;
- ноль `GET /api/components/:id` при первичной навигации в библиотеку;
- runtime-приёмка по `.claude/skills/verify/SKILL.md`.

## 9. Остаточные риски

1. **`token()`/`Icon` в недоминирующей системе** резолвятся темой доминирующей.
   Сегодня затронуто 0 компонентов; ограничение задокументировано и покрыто e2e.
   Настоящее исправление — ABI v5 со scope-aware резолвом (шим отдаётся динамически
   из `server/routes/shims.ts:16`, поэтому републикация компонентов не понадобится) —
   выносится в бэклог, не в проект 1.
2. **Утечка стилей опубликованных компонентов в хром библиотеки** (глобальные
   селекторы, коллизии имён `@font-face`). Спека §4 прямо оставляет это в
   trusted-модели; покрываем e2e-проверкой хрома.
3. **Латентность `headUsageCounts`** при промахе кэша — полное сканирование пинов.
   Число запросов константно; при росте каталога потребуется индекс (отдельная
   задача).
4. **Расхождение статусов** между `/api/catalog/manifest` и `/api/catalog/library`
   для компонента, активного в двух системах — намеренно, задокументировано,
   покрыто таблицей расхождений.
