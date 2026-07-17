# План v3: screen regions — header / footer / OS status bar в прототипах

## Context

Мобильные компонентные (flow) прототипы часто содержат: (1) имитацию OS-статус-бара (время, wifi) вверху экрана — она избыточна, когда прототип открыт на реальном телефоне (fluid mobile present), где есть настоящий статус-бар; (2) шапки (app bar) и футеры (таб-бары), которые сейчас живут в обычном потоке документа — уезжают со скроллом контента, а нижние бары визуально конфликтуют с адресной строкой мобильного браузера. Нужно: статус-бар автоматически скрывать в mobile present (на десктопе/в плеере — тумблер у зрителя), шапку прибивать сверху, футер — снизу видимого вьюпорта, контент скроллится между ними.

Решения, согласованные с пользователем:
- Фокус v1 — компонентные flow-экраны; canvas-скриншоты вне скоупа (валидация запрещает `region` при `canvas`).
- statusBar: в mobile fluid present скрыт всегда; на desktop present / в плеере — тумблер у зрителя; editor/CJM показывают всегда.
- Авторинг: явный маркер в документе + консервативная авто-подсказка в редакторе (без runtime-магии).

## Ключевые решения

### Маркер — element-level `region?: "statusBar" | "header" | "footer"`

Поле на элементе (direct child от `spec.root`), по прецеденту side-channel-поля `slot`: schema → strip в `toRuntimeSpec` (`src/prototype/runtimeSpec.ts:111`) → `ElementMetadata` → element-diff → contracts → авто-протекание в discovery JSON-схему. Против screen-level map: нет висячих id при удалении элемента, естественнее в редакторе, дешевле в диффе. Шаринг футера между экранами = future work.

### Root-контракт: новый host primitive `FlowRoot` (закрывает blockers ревью №1 и №2)

Извлечение region-поддеревьев в отдельные Renderer-порталы теряет контекст authored root: `repeat`-scope, `visible`, named-slot семантику custom root, а также layout/наследуемые свойства контейнера (gap/padding/direction, `color`/`font`, containing block). После custom-only cutover (v15) builtin-контейнеров в новых документах нет — root практически всегда custom, поэтому «запретить custom root» неисполнимо.

Решение — **host-owned нейтральный контейнер `FlowRoot`** (`src/catalog/hostPrimitives/`, рядом с Image/Hotspot/Overlay, доступен каждой системе):
- нулевой контракт: без props (кроме служебных), без событий, без named slots, без layout-вклада — рендерит детей простым блочным потоком; ничего не наследует и не задаёт;
- `region` допустим **только когда root экрана — `FlowRoot`** (+ на самом region-элементе нет `repeat`/`slot`); eligibility проверяется по одному документу, definitions не нужны;
- `FlowRoot` допустим только как root экрана (не вложенно), без `repeat`/`visible`/`on` на нём;
- **regions — self-contained поддеревья**: стилизация баров и контента живёт внутри соответствующих поддеревьев (типовая структура: `FlowRoot → [statusBar?, header?, content-контейнер, footer?]`); это документируется в формате как контракт, извлечение ничего не теряет, т.к. FlowRoot ничего не даёт детям;
- отсутствие custom root закрывает и blocker №2 (нет `slotIndices` у root).

Существующие экраны для использования regions переводятся автором на `FlowRoot`-root (документируется в format/author-скилле; editor-affordance «обернуть в FlowRoot» — future work). Новый примитив меняет host-каталог → попадает в builtin catalog hash; `RENDER_CONTRACT_VERSION` и так повышается в этой же волне.

### Рендер в mobile fluid present — flex-колонка stage-host

```
host (h-dvh, flex flex-col, overflow-hidden, isolate)   ← FluidStage flow-ветка
├─ header-slot   (shrink-0, z-10)                       ← region:"header" (портал)
├─ ContentScroller (flex-1 min-h-0 overflow-y-auto, z-0) ← контент без region-поддеревьев
└─ footer-slot   (shrink-0, z-10)                        ← region:"footer" (портал)
   … Overlay-слой поверх (z-20 wrapper внутри host)
```

- Flex резервирует реальную высоту баров — нет измерений и scroll-under; host `h-dvh` → футер над адресной строкой браузера.
- **Slot-регистрация — callback-ref со state** (прецедент `FluidStage.tsx:20`), не `useRef`: обычный ref не вызывает ре-рендер и порталы навсегда останутся без таргета. До готовности таргета region-контент не рендерится (drop-until-ready, без inline-fallback → без визуального скачка при первом кадре).
- **Disposition per kind вместо опциональных слотов**: структурный режим на уровне split — `"inline" | "drop" | "extract"` (в `runtimeSpec`, без DOM-типов); portal-таргеты (`HTMLElement | null`) живут только в `ScreenSurface`/контексте, и смена callback-ref-таргета не пересобирает split-деревья. Владельцы политики — **player и present (оба)**: fluid = statusBar drop + header/footer extract→portal; desktop present и framed player = header/footer inline, statusBar drop при включённом тумблере. Editor/CJM/capture/gallery — без провайдера → всё inline; `DeviceFrame` сам политикой не владеет. Это исключает утечку viewer-преференса в capture.
- **Pipeline split фиксируется**: `toRuntimeSpec → splitHostPrimitives → (canvas ? splitCanvas : applyRegionPolicy)`. Region-политика применяется только к flow-контенту после извлечения Overlay; canvas-ветка её обходит полностью. Тесты: region + Overlay-sibling; Hotspot на canvas не затронут; невалидный черновик с region не роняет рендер.
- **Стекинг явными слоями**: content z-0 < region-слоты z-10 < Overlay-обёртка z-20 внутри изолированного host. Контракт «Overlay выше баров» обеспечивается слоем, а не document order; тест с authored `z-index:999` внутри футера и Overlay со scrim.
- **Safe-area**: `viewport-fit=cover` в v1 НЕ добавляем (консистентно с решением mobile-player плана; глобальная правка index.html затронула бы все маршруты). `env(safe-area-inset-bottom, 0px)` остаётся progressive enhancement (0 в браузере, работает в standalone/PWA). Padding живёт в портальном wrapper'е и схлопывается, когда region-контент не отрендерен (`visible:false` → wrapper пуст → без пустой полоски); тест с динамическим `visible`.
- Смена экрана: слоты персистентны, контент keyed по `screen.id`. Scroll-reset: `useLayoutEffect` по `resetKey={screen.id}` сбрасывает `scrollTop` и `scrollLeft`; контракт v1 — navigate/back/restart всегда открывают экран сверху (restart и так ремоунтит через `sessionNonce`); покрыть тестами все три случая.
- Патологически высокие бары: обрезаются `overflow-hidden` host'а — поведение фиксируется в доке; критерии тестов — behavioral equivalence, не «идентичный DOM».

### Остальные поверхности — inline as authored

Без провайдера контекста `ScreenSurface` рендерит дерево нетронутым: DeviceFrame/framed player, editor canvas/strip, CJM (`src/cjm/CjmScreenTile.tsx` — свой pipeline, не трогаем), capture (`src/capture/CaptureSurface.tsx` — общий ScreenSurface, провайдера нет), gallery. Тумблер statusBar — только зрительские шеллы: desktop-present футер (`PresentShell.tsx`) + тулбар плеера (`ScreenView`); видим только когда экран содержит `region:"statusBar"`; персист — `localStorage("eui.statusBarHidden")` (глобальная настройка, share-ссылки не мусорим query-параметром), чтение/запись в try/catch со строгим парсом, `aria-pressed` на кнопке.

### Автодетект — editor-подсказка, source of truth — маркер

Чистая функция `suggestRegion` в `src/editor/regionSuggestion.ts`, все условия сразу: direct child root, без canvas, region не задан и kind свободен; позиция (первый ребёнок → statusBar/header — при матче обоих приоритет у statusBar; последний → footer); имя типа case-insensitive с явными разделителями: `/status[-_ ]?bar/i`, `/(app[-_ ]?bar|header|top[-_ ]?bar|nav[-_ ]?bar)/i`, `/(footer|tab[-_ ]?bar|bottom[-_ ]?(nav|bar))/i`; для statusBar — позиция И имя одновременно. Подсказка-строка под дропдауном Region + кнопка. Никаких автоправок и runtime-магии по имени.

### Валидация — `src/prototype/regionRules.ts`, parent multimap

Не копировать обход `overlayRules` (он идёт только по reachable root и пропустит orphan-маркеры). Общая функция **`regionEligibility(screen)`** (root — `FlowRoot`, нет `canvas`) используется валидатором, инспектором и suggestion — одна логика на три поверхности. Сначала собрать **parent multimap по всем `elements`**, затем:
1. для каждого элемента с `region`: ровно один родитель и он равен `spec.root` (orphan, множественные родители, глубина — ошибки);
2. ≤1 элемента на region-kind на экран (уникальность считается по валидным маркерам; невалидные дают собственные ошибки и в уникальности не участвуют);
3. `region` запрещён при `screen.canvas`;
4. root-контракт: `region` только при root = `FlowRoot`; `FlowRoot` только как root (не вложенно, не в других экранах деревом ниже), без `repeat`/`visible`/`on` на нём;
5. `region` несовместим с `repeat` и `slot` на самом элементе;
6. запрещён на `Overlay`/`Hotspot`;
7. `Hotspot` внутри region-поддерева запрещён; вложенный `region` внутри region-поддерева невозможен по правилу 1, но получает точечную ошибку.
`visible` на region-элементе разрешён (условный футер). Device-гейтинга нет.

Тесты: orphan-маркер, маркер внутри маркера, region при не-FlowRoot root, вложенный FlowRoot, FlowRoot с repeat/visible/on, duplicate child reference, все правила позитив+негатив; позитивные фикстуры — на production-like custom-only системе (не legacy builtin).

### Версии и кэши

- `VALIDATOR_VERSION` → `"v4"` — **audit-label** для новых записей validation records; никакого пересчёта кэша он не делает (`latestValidatedRev` намеренно игнорирует версию — `server/validationRecords.ts:4-7`), и план этого не заявляет.
- `RENDER_CONTRACT_VERSION` 3 → 4 (`server/builtinHash.ts:9`): новое поле элемента и новый класс валидации — вход, влияющий на validation/rendering; новые ревизии не должны получать старую catalog identity.

### Сервер, contracts, propagation checklist

Правки схемы протекают в write path и discovery автоматически. Полный чеклист ручных перечислений (дополнен по ревью):
- `server/contracts.ts`: `region: elementValueDiffSchema.optional()` в `elementChangedSchema`; `capabilitiesResponseSchema` (+`features.screenRegions`, `regions`).
- `src/prototype/revisionDiff.ts:161`: key list `+ "region"`.
- `server/routes/meta.ts`: capabilities `features.screenRegions: true` + `regions: ["statusBar","header","footer"]`.
- `src/api/client.ts:~147`: клиентский тип capabilities.
- `server/openapi.json`: регенерация (drift-check `verify:openapi` входит в `npm run verify` → регенерить в той же фазе, что и правка схемы).
- `src/editor/docDiff.ts:~59`: humanized paths / conflict diff + строка `diffRegionLabel`.
- `docs/prototype-format.md`: строгий allowlist (строка ~9) + раздел Screen regions + Overlay truth table.
- `.claude/skills/author/SKILL.md`: authoring-грамматика элемента.
- Аудит `server/driver-mjs.d.ts` (ручной element-тип).

**Rollback-политика** (ревью №11): «additive optional» не даёт безопасного отката образа — строгий `storedPrototypeDocSchema` старого сервера не распарсит уже записанный документ с `region` при чтении. В `docs/server-api.md` фиксируем: после деплоя фичи запись `region`-документов делает откат на предыдущий образ несовместимым с новыми ревизиями; перед деплоем — обязательный логический бэкап (стандарт прод-процедуры), rollback-window упоминается в приёмке деплоя (та же политика, что для flows).

### Editor UX

Дропдаун Region в element-секции инспектора; условия показа/активности — через общую `regionEligibility(screen)` (root = FlowRoot, нет canvas) + direct child root; при неэлигибельном экране контрол disabled с объяснением («Регионы доступны на экранах с корнем FlowRoot»), занятый kind — disabled. `suggestRegion` тоже проверяет eligibility. Бейдж в `ElementTree`, мутатор `setElementRegion` + action `set-element-region`. **Canvas-переход** (ревью №12): установка `canvas` через `CanvasEditor` на экране с region-маркерами — подтверждение и один undoable commit, очищающий все region-поля экрана (иначе UI прячет маркеры, а документ перестаёт сохраняться); reducer/integration-тест, не только unit дропдауна.

## Триаж ревью-раунда 1 (Codex gpt-5.6-sol, 2026-07-17)

Принято с правками плана: blocker 1 (root-контракт вместо renderer-spike — вариант, допущенный самим ревью; spike отклонён как избыточный при сужении контракта), blocker 2 (закрыт root-контрактом «root не custom»; общий rebuild-helper для `slotIndices` в существующих `splitHostPrimitives`/`splitCanvas` — pre-existing баг, чинится в T1 с тестом custom-root + Overlay-sibling + slotted children), major 3 (callback-ref slots, tri-state), 4 (disposition per kind), 5 (pipeline order), 6 (parent multimap), 7 (явные z-слои), 8 (viewport-fit=cover не добавляем — решение зафиксировано; padding схлопывается), 9 (v4 = audit label; RENDER_CONTRACT_VERSION → 4), 10 (полный propagation-чеклист), 11 (rollback-политика в доки), 12 (canvas-переход очищает regions), 13 (cross-surface fixture-матрица в T7), 14 (перекомпоновка фаз: OpenAPI-реген в T1, PresentShell в ownership T3, T4 после T3), minor 15–17 (scroll-контракт, регексы `/i`, behavioral-критерии).

Отклонено: T0 design spike (нужда отпала после сужения root-контракта — blocker 1 решается валидацией, а не новой renderer-механикой).

## Триаж ревью-раунда 2 (2026-07-17)

Принято: blocker (builtin plain-container root не существует после custom-only cutover) → **вариант FlowRoot** (host-owned нейтральный контейнер; capability-вариант `screenRegionRoot` отклонён как расширяющий scope на capabilities/extraction/loader/ABI без выигрыша для v1); major 2 (semantic-нейтральность) → закрыт нулевым контрактом FlowRoot + контракт «regions self-contained» в format-доке + тесты root-стилей; major 3 → общая `regionEligibility` для валидатора/инспектора/suggestion, definitions не нужны (проверка по типу root); major 4 (небезопасный промежуточный контракт T1/T2) → T1+T2 объединены в одну неделимую волну W1; major 5 → OpenAPI-реген и в T6 (contracts меняются повторно); minor 6 → зафиксировано владение политикой (player+present owners; структурные режимы inline|drop|extract в runtimeSpec, DOM-таргеты только в ScreenSurface); minor 7 → helper определён как **remap** slotIndices по паре original/filtered children (slot-имена из trimmed spec невосстановимы), пустые slot-группы сохраняются, + symmetric-тест для splitCanvas.

## Фазы (DAG: W1(T1+T2) → {T3 → T4, T5, T6} → T7; T3/T5/T6 параллелятся)

### W1 — FlowRoot + схема + runtime-plumbing + валидация + версии (неделимая волна, ревью-2 major 4)

T1 и T2 выполняются и коммитятся одной волной: схема с `region` без валидационного гейта — небезопасный промежуточный контракт (документы с region прошли бы запись до появления правил).

**T1 — примитив, схема, runtime-plumbing, OpenAPI.**
Файлы: `src/catalog/hostPrimitives/` (**новый `FlowRoot`**: definition + компонент по образцу Overlay — нулевой props-контракт, без событий/slots/layout-вклада, простой блочный поток; регистрация в `index.ts`/`definitions.ts` → попадает в builtin catalog hash), `src/prototype/schema.ts` (`REGION_KINDS`, `region: z.enum(...).optional()`, тип `RegionKind`), `src/prototype/runtimeSpec.ts` (`ElementMetadata.region`; strip зеркально `slot`; `applyRegionPolicy(tree, policy)` → `{content, regions}` по direct children root, режимы `inline | drop | extract`; общий **remap-helper `slotIndices`** по паре original/filtered children — фикс pre-existing бага в `splitHostPrimitives`/`splitCanvas`, пустые slot-группы сохраняются), `server/openapi.json` (реген — drift-check в verify), юниты, фикстура с regions на custom-only системе.

**T2 — валидация + версии.**
Файлы: `src/prototype/regionRules.ts` (новый: **`regionEligibility(screen)`** — экспорт для инспектора/suggestion; parent multimap; правила 1–7), вызов из `validate.ts`, `server/validationRecords.ts` → `"v4"`, `server/builtinHash.ts` → `RENDER_CONTRACT_VERSION = 4`, юниты на каждое правило + orphan/duplicate-parent кейсы + FlowRoot-правила (вложенный FlowRoot, repeat/visible/on на нём).

**Done (волна целиком)**: strip/metadata/split покрыты (fast-path идентичность объекта; custom-root + Overlay-sibling + slotted children — slotIndices корректны после split; symmetric-тест для `splitCanvas`); тесты нулевого контракта FlowRoot (не наследует/не задаёт стили детям); `npm run validate:templates`, серверные validation/hash-тесты зелёные (обновить ожидания контрактной версии); `npm run verify` зелёный.

### T3 — рендер в mobile fluid present
Файлы: `src/player/ScreenRegions.tsx` (контекст disposition per kind + типы), `src/player/ScreenSurface.tsx` (pipeline `splitHostPrimitives → applyRegionPolicy`, порталы, drop), `src/player/FluidStage.tsx` (flex-колонка, callback-ref слоты `data-eui-region`, z-слои, safe-area wrapper со схлопыванием, провайдер fluid-политики, scroll-reset `useLayoutEffect`), `src/player/PresentShell.tsx` (проброс `resetKey` — ownership здесь, не в T4).
**Done**: юниты — бары вне скроллера; statusBar отсутствует в DOM; экран без regions behaviorally прежний; Overlay поверх футера при authored z-index:999; drop-until-ready без inline-flash (первый кадр); repeat внутри футера; `visible:false` футер не оставляет полоску; scroll-reset navigate/back/restart; существующие Present/Fluid тесты зелёные.

### T4 — тумблер статус-бара (после T3)
Файлы: `src/player/statusBarPreference.ts` (localStorage-hook, try/catch, строгий парс), `PresentShell.tsx` (кнопка в desktop-present футере, `aria-pressed`), `ScreenView.tsx` (тулбар плеера), строки `src/app/strings/player.ts`.
**Done**: кнопка видна только при statusBar-регионе на текущем экране; toggle переключает disposition statusBar inline↔drop (header/footer остаются inline); персист между маунтами; в mobile fluid кнопки нет.

### T5 — editor UX (параллельно T3)
Файлы: `src/editor/docMutations.ts` (`setElementRegion`), `editorReducer.ts` (`set-element-region`; canvas-переход очищает regions одним commit), `InspectorPanel.tsx` (дропдаун; показ/активность через `regionEligibility`, disabled-объяснение; подтверждение canvas-перехода), `src/editor/regionSuggestion.ts` (проверяет eligibility), `ElementTree.tsx` (бейдж), `src/editor/docDiff.ts` (`diffRegionLabel` + путь), строки editor.
**Done**: выбор пишет/удаляет поле (undo/redo); canvas-переход с regions — подтверждение + очистка, reducer-тест; таблица кейсов эвристики; docDiff показывает region-изменение.

### T6 — серверная поверхность (параллельно T3)
Файлы: `server/contracts.ts` (elementChangedSchema + capabilitiesResponseSchema), `src/prototype/revisionDiff.ts` (+тест), `server/routes/meta.ts`, `src/api/client.ts`, аудит `server/driver-mjs.d.ts`, серверные тесты (diff add/remove/change; capabilities; discovery-схема содержит enum region; POST с неверным region → 422), `docs/server-api.md` (+rollback-политика).
**Done**: перечисленные тесты зелёные, `npm run verify` зелёный.

### T7 — cross-surface интеграция, e2e, доки, приёмка
Единая region-фикстура прогоняется по всем поверхностям: framed player, desktop present, editor canvas/strip, CJM, gallery, capture (в capture предустановить `eui.statusBarHidden=true` в localStorage и доказать inline-рендер). Новый `e2e/dev/screen-regions.spec.ts`; e2e-сид: мобильный прототип со statusBar-имитацией + header + footer-таббар с navigate + второй экран без regions. Матрица (mobile-Chromium, `?mobile=1`): футер виден при длинном контенте; после скролла boundingBox баров стабилен, statusBar отсутствует; тап по таббару → navigate → новый экран сверху; экран без regions — контент на всю высоту; `?mobile=0` — inline, statusBar виден, тумблер скрывает; Overlay bottom + footer — Overlay поверх. Доки: `docs/prototype-format.md` (раздел Screen regions, allowlist, root-контракт, Overlay truth table: StageViewport = flex-колонка, Overlay-слой z-20), `.claude/skills/author/SKILL.md`.
**Done**: `npm run verify` + `npm run e2e` (4 проекта) зелёные; runtime-приёмка по скиллу `/verify` (скриншоты `?mobile=1` и тумблера); ручной пункт — реальный телефон (адресная строка/home-indicator/клавиатура).

## Риски / edge-cases

- Смешанный флоу (экраны с/без regions): слоты схлопываются без анимации — v1, покрыто e2e.
- Клавиатура на мобильном: visual viewport ресайзит `h-dvh` — v1 принимает как есть; ручная приёмка на устройстве.
- Патологически высокие бары: обрезка `overflow-hidden` — задокументировано.
- Rollback образа после записи region-документов — несовместим (см. rollback-политику в T6-доках); стандартный логический бэкап перед деплоем обязателен.
- Root-контракт сужает применимость (custom root, repeat-root) — осознанный trade-off v1; ослабление = future work.

## Верификация

`npm run verify` + `npm run e2e` после каждой волны; финально runtime-прогон по `.claude/skills/verify/SKILL.md`. Не ломаем: DeviceFrame, capture, CJM, Overlay truth table (кроме документированной правки), share-редирект.
