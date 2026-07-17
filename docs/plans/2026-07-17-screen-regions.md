# План: screen regions — header / footer / OS status bar в прототипах

## Context

Мобильные компонентные (flow) прототипы часто содержат: (1) имитацию OS-статус-бара (время, wifi) вверху экрана — она избыточна, когда прототип открыт на реальном телефоне (fluid mobile present), где есть настоящий статус-бар; (2) шапки (app bar) и футеры (таб-бары), которые сейчас живут в обычном потоке документа — уезжают со скроллом контента, а нижние бары визуально конфликтуют с адресной строкой мобильного браузера. Нужно: статус-бар автоматически скрывать в mobile present (на десктопе/в редакторе — тумблер у зрителя), шапку прибивать сверху, футер — снизу видимого вьюпорта, контент скроллится между ними.

Решения, согласованные с пользователем:
- Фокус v1 — компонентные flow-экраны; canvas-скриншоты вне скоупа (валидация запрещает `region` при `canvas`).
- statusBar: в mobile fluid present скрыт всегда; на desktop present / в плеере — тумблер у зрителя; editor/CJM показывают всегда.
- Авторинг: явный маркер в документе + консервативная авто-подсказка в редакторе (без runtime-магии).

## Ключевые решения

### Маркер — element-level `region?: "statusBar" | "header" | "footer"`

Поле на элементе (direct child от `spec.root`), по точному прецеденту side-channel-поля `slot`: schema → strip в `toRuntimeSpec` (`src/prototype/runtimeSpec.ts:111`) → `ElementMetadata` → element-diff (`src/prototype/revisionDiff.ts:161`) → `elementChangedSchema` в `server/contracts.ts` → авто-протекание в discovery JSON-схему (`z.toJSONSchema(inputPrototypeDocSchema)` в `server/routes/meta.ts:91`). Против screen-level map: нет висячих id при удалении элемента, естественнее в редакторе (пометил элемент — готово), дешевле в диффе. Шаринга элементов между экранами в формате нет — шаринг футера = future work.

### Рендер в mobile fluid present — flex-колонка stage-host (не absolute-оверлап)

```
host (h-dvh, flex flex-col, overflow-hidden, isolate)   ← FluidStage flow-ветка
├─ header-slot   (shrink-0)                             ← region:"header" (портал)
├─ ContentScroller (flex-1 min-h-0 overflow-y-auto)     ← контент без region-поддеревьев
└─ footer-slot   (shrink-0; safe-area padding внутри портального wrapper'а, не на слоте)
```

- Flex резервирует реальную высоту баров — не нужны измерения, нет scroll-under.
- Host уже `h-dvh` → футер всегда над адресной строкой браузера; `env(safe-area-inset-bottom)` закрывает home-indicator.
- `region:"statusBar"` в mobile fluid не рендерится вообще (drop при split).
- Доставка: новый `splitRegions` в `runtimeSpec.ts` (по образцу `splitHostPrimitives`) вырезает поддеревья; `ScreenSurface` порталит их в слоты через новый контекст `ScreenRegionsContext {statusBarHidden, headerSlot?, footerSlot?}` — порталы внутри того же runtime-провайдера, события/`navigate` в футере работают. Fast-path: экран без regions → исходное дерево по ссылке, ноль новой работы.
- Overlay-якорь (весь host) не двигается — truth table не ломается; Overlay `placement:"bottom"` ляжет поверх футера (документируется как контракт: Overlay — плавающие элементы, region — бары).
- Смена экрана: слоты персистентны, контент keyed по `screen.id`; scrollTop скроллера сбрасывается по `resetKey={screen.id}`.

### Остальные поверхности — inline as authored

Без контекста regions `ScreenSurface` рендерит дерево нетронутым: DeviceFrame, editor, CJM (`src/cjm/CjmScreenTile.tsx` — свой split, не трогаем), capture/screenshots, gallery. Capture детерминирован (не читает localStorage). Тумблер statusBar — только зрительские поверхности: desktop-present футер (`PresentShell.tsx:~180`) + тулбар плеера (`ScreenView`); видим только когда экран содержит `region:"statusBar"`; персист — `localStorage("eui.statusBarHidden")` (не query param — не мусорим в share-ссылках).

### Автодетект — editor-подсказка, source of truth — маркер

Чистая функция `suggestRegion` в `src/editor/regionSuggestion.ts`, все условия сразу: direct child root, без canvas, region не задан и kind свободен; позиция (первый ребёнок → statusBar/header, последний → footer); имя типа (`/status.?bar/`, `/(app.?bar|header|top.?bar|nav.?bar)/`, `/(footer|tab.?bar|bottom.?(nav|bar))/`); для statusBar — позиция И имя одновременно. Подсказка-строка под дропдауном Region: «Похоже на footer — пометить?» + кнопка. Никаких автоправок документа и никакой runtime-магии по имени (ломала бы детерминизм capture и удивляла зрителя).

### Валидация — `src/prototype/regionRules.ts` (по образцу `overlayRules.ts`), VALIDATOR_VERSION → v4

Errors: (1) `region` только на direct child root; (2) ≤1 элемента на region-kind на экран; (3) запрещён при `screen.canvas`; (4) несовместим с `repeat` на том же элементе (repeat внутри поддерева — можно); (5) несовместим со `slot`; (6) запрещён на `Overlay`/`Hotspot`; (7) `Hotspot` внутри region-поддерева запрещён. `visible` на region-элементе разрешён. Device-гейтинга нет (маркер семантический, пиннинг включает поверхность). Bump `VALIDATOR_VERSION = "v4"` в `server/validationRecords.ts:7` (новый класс ошибок → пересчёт кэша validation records; прецедент — flows/v3).

### Сервер

Правки схемы протекают в write path и discovery автоматически (сервер использует общие `inputPrototypeDocSchema`/`storedPrototypeDocSchema`). Точечно: `server/contracts.ts` — `region: elementValueDiffSchema.optional()` в `elementChangedSchema` (рядом со `slot`); `src/prototype/revisionDiff.ts:161` — key list `+ "region"`; `server/routes/meta.ts` — capabilities `features.screenRegions: true` + `regions: ["statusBar","header","footer"]`. Миграций нет (additive optional).

## Фазы (DAG: T1 → T2 → {T3 → T4, T5, T6} → T7; T3/T5/T6 параллелятся, ownership непересекающийся)

### T1 — схема и runtime-plumbing
`src/prototype/schema.ts` (`REGION_KINDS`, `region: z.enum(...).optional()` в elementSchema, тип `RegionKind`), `src/prototype/runtimeSpec.ts` (`ElementMetadata.region`; strip зеркально `slot`; `splitRegions(tree, {dropStatusBar?, extract?})` → `{content, regions}`), юниты, фикстура с regions.
**Done**: strip/metadata/split покрыты (включая fast-path идентичность объекта), `npm run verify` зелёный.

### T2 — валидация + VALIDATOR_VERSION
`src/prototype/regionRules.ts` (новый), вызов из `validate.ts` рядом с `validateOverlayRules`, `server/validationRecords.ts` → `"v4"`, юниты на каждое правило (позитив+негатив).
**Done**: `npm run validate:templates` и серверные validation-records-тесты зелёные.

### T3 — рендер в mobile fluid present
`src/player/ScreenRegions.tsx` (контекст+провайдер), `src/player/ScreenSurface.tsx` (split + порталы + drop statusBar при `statusBarHidden`), `src/player/FluidStage.tsx` (flex-колонка flow-ветки, слоты `data-eui-region="header|footer"`, safe-area в портальном wrapper'е, провайдер `{statusBarHidden:true, ...}`, scroll-reset по `resetKey` от PresentShell; canvas-ветка не трогается).
**Done**: юниты — бары вне скроллера, statusBar отсутствует в DOM, экран без regions даёт прежний DOM (регрессия), Overlay-портал по-прежнему в host, порядок flex-детей, repeat внутри футера работает, scroll-reset; существующие Present/Fluid тесты зелёные.

### T4 — тумблер статус-бара
`src/player/statusBarPreference.ts` (localStorage-hook с guard), `PresentShell.tsx` (кнопка в desktop-present футере), `ScreenView.tsx` (тулбар плеера), строки `src/app/strings/player.ts`.
**Done**: кнопка видна только при наличии statusBar-региона на текущем экране, toggle убирает его из DOM, персист между маунтами; в mobile fluid кнопки нет.

### T5 — editor UX (параллельно)
`src/editor/docMutations.ts` (`setElementRegion` по образцу `setElementProps`), `editorReducer.ts` (action `set-element-region`), `InspectorPanel.tsx` (дропдаун Region в element-секции; только direct child root + не canvas; занятый kind — disabled), `src/editor/regionSuggestion.ts` + подсказка, `ElementTree.tsx` (бейдж региона), строки editor.
**Done**: выбор пишет/удаляет поле (undo/redo через commitDoc), таблица кейсов эвристики покрыта юнитом.

### T6 — серверная поверхность (параллельно)
`server/contracts.ts`, `src/prototype/revisionDiff.ts` (+тест), `server/routes/meta.ts`, серверные тесты (diff add/remove/change region; capabilities; discovery-схема содержит enum region; POST с неверным region → 422), `docs/server-api.md`.
**Done**: перечисленные тесты зелёные.

### T7 — e2e, доки, приёмка
Новый `e2e/dev/screen-regions.spec.ts` (или дополнение present-mobile), e2e-фикстура: мобильный прототип со statusBar-имитацией + header + footer-таббар с navigate + второй экран без regions. Матрица (mobile-Chromium, `?mobile=1`): футер виден при длинном контенте; после скролла boundingBox баров стабилен, statusBar отсутствует; тап по таббару → navigate → скролл нового экрана сверху; экран без regions — слоты пустые; `?mobile=0` — всё inline, statusBar виден, тумблер его скрывает; Overlay bottom + footer — Overlay поверх (фиксация контракта). Доки: `docs/prototype-format.md` — раздел «Screen regions» + правка строки StageViewport в Overlay truth table; `docs/server-api.md` (если не закрыт в T6).
**Done**: `npm run verify` + `npm run e2e` (4 проекта) зелёные; runtime-приёмка по скиллу `/verify` (скриншоты `?mobile=1` и desktop-тумблера); ручной пункт — реальный телефон (адресная строка/home-indicator/клавиатура).

## Риски / edge-cases

- Смешанный флоу (экраны с/без regions): слоты схлопываются без анимации — приемлемо для v1, покрыто e2e.
- Футер выше вьюпорта: `flex-1 min-h-0` сжимает скроллер, бары не обрезаются; вырожденный случай — в доке.
- Клавиатура на мобильном: visual viewport ресайзит `h-dvh` — v1 принимает как есть (с Overlay было бы так же); ручная приёмка на устройстве.
- Overlay bottom перекрывает pinned footer — задокументированный контракт, якорь Overlay не двигаем.
- `visible:false` на region-элементе: слот остаётся 0-высоты; safe-area padding — внутри портального wrapper'а, чтобы не было пустой полоски.
- Старый сервер + документ с region → обычный 422 additive-политики; агенты детектят по capabilities-флагу.

## Верификация

`npm run verify` + `npm run e2e` после каждой волны; финально runtime-прогон по `.claude/skills/verify/SKILL.md`. Не ломаем: DeviceFrame, capture, CJM, Overlay truth table (кроме документированной правки), share-редирект.

## Процесс после одобрения (workflow CLAUDE.md)

1. Сохранить план в `docs/plans/2026-07-17-screen-regions.md`, закоммитить.
2. Stage 2: адверсариальное Codex-ревью (`gpt-5.6-sol`, config-level max, `CODEX_HOME=$PWD/.codex-home`), триаж находок в плане, при существенных правках — `--resume`-раунд.
3. Stage 3: исполнение волнами Codex-задач (`--fresh --write --effort medium`) по DAG T1→T2→{T3,T5,T6}→T4→T7 с независимой верификацией done-критериев и поэтапными коммитами.
