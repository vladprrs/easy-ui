# Desktop player: телефонная сцена с внутренним скроллом и пиннед-регионами

Дата: 2026-07-24 · Статус: approved (ревью пройдено, триаж в конце файла)

## Проблема

На десктопе плеер (`/p/:id`) и десктопная презентация рендерят mobile-прототипы «криво»:
экран то длиннее, то короче телефона, скролл не работает, header/footer не позиционируются.

Диагноз по коду (`src/player/DeviceFrame.tsx`, `ScreenView.tsx`, `PresentShell.tsx`) и
продовым прототипам (cpqr-scenario, ctyp-*, pay-app-home-v1, magnit-loyalty-july):

1. **Нет внутреннего скролла.** Fixed-viewport ветка `DeviceFrame` — фрейм ровно
   390×844 (`canonicalViewport.mobile`) с `overflow-hidden` на карточке и без скроллера
   внутри. Экран, чей контент выше 844px (cpqr `qr-curtain-ready`, 41 элемент),
   просто обрезается: «скролл не работает», «экран короткий».
2. **Регионы inline.** `ScreenView`/`PresentShell` передают
   `header/footer: "inline"` и `targets: {}` — header/footer рендерятся в потоке
   контента. Footer у короткого экрана висит сразу после контента посреди фрейма,
   а не прижат к низу телефона; у длинного — обрезан вместе с контентом.
   Прод-прототипы активно используют регионы: cpqr (statusBar+header+footer),
   ctyp-paybox, ctyp-single-offer.
3. **Canvas-экраны растягивают «телефон».** Для canvas-экранов фрейм принимает
   размер canvas: у prod `pay-app-home-v1` это 390×**1722** и 390×**1880** —
   «телефон» в 2+ раза длиннее реального, fit-масштаб ужимает его до нечитаемого:
   «экран слишком длинный».

Эталон корректного поведения уже есть в кодовой базе: **мобильная презентация**
(`FluidStage`) — header/footer извлекаются (`extract`) в пиннед-слоты через
портальные `targets` из `ScreenRegionsContract`, контент скроллится между ними,
overlay-слой — absolute поверх; canvas скейлится по ширине и скроллится вертикально.
Механизм `applyRegionPolicy("extract")` + `ScreenSurface.regionPortals` полностью
готов — десктопная сцена его просто не использует.

## Решение

Перенести FluidStage-паттерн внутрь fixed-viewport ветки `DeviceFrame`: фрейм всегда
канонического размера устройства (mobile 390×844, tablet 834×1112), внутри — колонка
`[statusBar+header slot] / [scroller flex-1] / [footer slot]` + absolute overlay-слой.

### T1. Общая внутренняя сцена регионов

Извлечь из no-canvas ветки `FluidStage` переиспользуемый компонент
`RegionStage` (файл `src/player/RegionStage.tsx`): владеет slot-DOM
(**три** слота `data-eui-region="statusBar|header|footer"`, statusBar над header;
все три в `targets`), скроллер `data-eui-content-scroller`, overlay-слой
`data-eui-overlay-layer`, свой `ScreenRegionsProvider`
(`header/footer: "extract"`, `statusBar: statusBarDisposition`) и `HostStageSurface`.
Параметры: `statusBarDisposition` (`"extract" | "drop"` — см. T3), `scrollResetKey`,
`surfaceName` (значение обоих маркеров `data-eui-content-scroller` и
`data-eui-overlay-layer`), `children`.

Done-критерии:
- **RegionStage height-agnostic**: корень `h-full`/fill-parent, никакого `h-dvh` —
  высоту задаёт обёртка вызывающего (`FluidStage` — свой `h-dvh`-враппер,
  `DeviceFrame` — фрейм 390×844).
- `FluidStage` (no-canvas ветка) переходит на него без изменения поведения:
  маркеры `data-eui-content-scroller="present-fluid"`,
  `data-eui-overlay-layer="present-fluid"`, `data-eui-stage-viewport="present-fluid"`
  и классы сохранить (e2e/mobilePresent/FluidStage.test завязаны); statusBar-слот
  при `"drop"` пуст и скрыт (`[&:empty]:hidden`).
- `SurfaceSpacingScope` остаётся у вызывающих (FluidStage/DeviceFrame), RegionStage
  его не оборачивает — двойного скоупа нет.

### T2. DeviceFrame: фиксированный фрейм = канонический viewport

Fixed-viewport ветка `DeviceFrame`:

- **No-canvas (mobile/tablet):** размер фрейма остаётся `canonicalViewport[device]`;
  внутрь транформ-обёртки (`width/height` каноник, `transform: scale`) вставляется
  `RegionStage` — контент скроллится внутри телефона, header/footer/statusBar пиннед.
  Точная DOM-структура (фиксируем осознанно, переписывая unit-тесты Overlay):
  `frameCard` → транформ-обёртка **сохраняет** маркер
  `data-eui-stage-viewport="player"` и роль `stageHost` НЕ несёт — `HostStageSurface`
  делегируется `RegionStage` (DeviceFrame свой не оборачивает — двойного провайдера
  нет); внутри RegionStage: слоты statusBar/header → скроллер
  `data-eui-content-scroller="player-stage"` (контент в `min-h-full`) → слот footer →
  absolute overlay-слой `data-eui-overlay-layer="player-stage"` (= `stageHost`,
  якорь Overlay: пиннед к вьюпорту телефона, при скролле не уезжает — паритет
  с no-canvas FluidStage). `SurfaceSpacingScope` остаётся на транформ-обёртке
  (носитель `--eui-space-md` — как сейчас).
- **Canvas-экраны:** фрейм больше не равен canvas-высоте. Для устройств с
  каноническим viewport высота фрейма — **всегда каноническая** (844/1112), и для
  canvas выше, и для canvas ниже каноника («телефон» всегда телефонной длины;
  короткий canvas прижат к верху без скролла); ширина — `canvas.width`.
  Desktop+canvas сохраняет текущее поведение (фрейм = canvas, `canonicalViewport.desktop
  === null`). Внутри — вертикальный скроллер `data-eui-content-scroller="player-canvas"`
  с `CanvasLayers` натурального размера (паттерн canvas-ветки FluidStage, scale=1;
  зум остаётся внешним `transform: scale`). `stageHost` (якорь Overlay) —
  canvas-размерный див внутри скроллера, как в FluidStage: Overlay скроллится
  вместе с canvas. `HostStageSurface` здесь остаётся у DeviceFrame.
- Внешний пан-скроллер стейджа `data-eui-content-scroller="player"` (для manual
  zoom) сохраняется как есть — итого три различимых имени скроллеров:
  `player` (внешний), `player-stage` (внутри телефона), `player-canvas` (canvas).
- Fit-масштаб считается от размера фрейма (как сейчас), который теперь ≤ каноника.
- Провайдер регионов переезжает из `ScreenView`/`PresentShell` внутрь `DeviceFrame`
  (в `RegionStage`); из обоих вызовов убрать внешний `ScreenRegionsProvider`
  с `targets: {}` и `viewerRegionDisposition`.
- **Desktop-fluid ветка**: чтобы тумблер статусбара не превратился в no-op
  (`useScreenRegions() === null` ⇒ всё inline), DeviceFrame держит на этой ветке
  минимальный провайдер `{ statusBar: hidden ? "drop" : "inline", header: "inline",
  footer: "inline" }` с `targets: {}` — текущее поведение сохранено.

### T3. statusBar и тумблер

Сегодня: тумблер «статусбар» в хроме плеера → `statusBar: "inline" | "drop"`.
Новая семантика: `statusBar: "extract"` в верхний пиннед-слот (над header) при
включённом тумблере, `"drop"` при выключенном. Тумблер прокидывается в
`DeviceFrame` пропом `statusBarHidden`. В `FluidStage` статусбар остаётся `"drop"`
(реальный телефон показывает свой). Present-десктоп — та же логика, что в плеере.

### T4. Тесты

- Unit `DeviceFrame`: (a) no-canvas mobile — фрейм 390×844, header/footer
  извлечены в слоты, контент в скроллере `player-stage`; (b) canvas 390×1722 —
  фрейм 390×844, внутри скроллер `player-canvas` с canvas-дивом 1722; (b2) canvas
  390×600 — фрейм всё равно 390×844; (c) desktop fluid ветка не изменилась,
  тумблер статусбара работает; (d) statusBar extract/drop по пропу; (e) tablet —
  фрейм 834×1112 с теми же слотами.
- Обновить `ScreenView.test.tsx` (в т.ч. осознанно переписать тесты Overlay-якоря
  стр. ~293–339: Overlay теперь в overlay-слое RegionStage, пиннед при скролле;
  `--eui-space-md` читается с транформ-обёртки) / `PresentShell.test.tsx` /
  `FluidStage.test.tsx` под новую структуру.
- e2e: **переписать player+present-блок** `e2e/dev/screen-regions.spec.ts`
  (тест «framed player and desktop present keep authored regions inline…» фиксирует
  старую семантику — заменить на extract-ассерты; блоки editor/CJM/capture/gallery
  не трогать, там inline сохраняется) и зеркальный `e2e/preview/screen-regions.spec.ts`.
  Новые сценарии: mobile-экран с header/footer и контентом >844px — футер виден без
  скролла и прижат к низу фрейма, контент скроллится внутри фрейма (в т.ч. при
  manual zoom ≠ 1), header на месте; canvas-фикстура 390×1722 — высота фрейма 844,
  вертикальный скролл до низа canvas. Фикстуры — `test/fixtures/`.

### T5. Документация

`docs/prototype-format.md`: переписать §«Screen regions» (утверждение «In framed
player, desktop present … the same tree remains inline», ~стр. 160) и таблицу
StageViewport-поверхностей — rows 1 (Player mobile/tablet flow: появился in-stage
скроллер, Overlay пиннед к вьюпорту фрейма), 2 (Player canvas: высота фрейма
каноническая, canvas скроллится, Overlay скроллится с canvas), 4 (Present framed
«As rows 1–2») и столбец «Overlay after scrolling». `docs/server-api.md` не
меняется (формат/схема/discovery не затронуты).

### Не трогаем

- Капчер/скриншоты: `canonicalViewport` неприкосновенен, capture-шелл не использует
  DeviceFrame (свой рендер, регионы inline) — семантика скриншотов не меняется.
- Мобильная презентация (`FluidStage` поведение), редактор, превью-тайлы
  (CJM/галерея/лента) — свои компоненты.
- Формат документа и API — изменений нет, миграций нет.

## Порядок и владение файлами

| Задача | Файлы |
|---|---|
| T1 RegionStage + FluidStage рефакторинг | `src/player/RegionStage.tsx` (new), `src/player/FluidStage.tsx`, `FluidStage.test.tsx` |
| T2+T3 DeviceFrame + вызовы | `src/player/DeviceFrame.tsx`, `ScreenView.tsx`, `PresentShell.tsx`, их тесты |
| T4 e2e | `e2e/dev/screen-regions.spec.ts`, `e2e/preview/screen-regions.spec.ts`, новые спеки; фикстуры в `test/fixtures/` |
| T5 docs | `docs/prototype-format.md` |

T1 → T2/T3 → T4 → T5 последовательно (T2 зависит от T1; unit-тесты в составе задач).

## Риски

- **Overlay-якорь.** `stageHostRef` сейчас — транформ-обёртка целиком; с внутренним
  скроллером Overlay, заякоренный на stage, не должен уезжать при скролле там, где
  автор ждёт пиннед-поведение (шторки cpqr `qr-curtain-*` — это Overlay?). Проверить
  на прод-данных: Overlay должен позиционироваться от **вьюпорта телефона**
  (absolute-слой RegionStage, не скроллится) — как в no-canvas FluidStage, где
  overlay-слой absolute во вьюпорте. Для canvas-экранов — как в canvas-ветке
  FluidStage (скроллится с canvas). Расхождение плеера с мобильным present недопустимо.
- **Скролл под transform: scale.** Колесо/тач над трансформированным скроллером —
  проверить в e2e при manual zoom ≠ 1.
- **e2e-геометрия.** Прогнать `npm run e2e` целиком; скриншот-бейзлайнов
  (`toHaveScreenshot`) в проекте нет, `e2e/preview/screenshot.spec.ts` гоняет
  серверный screenshot-job (capture-поверхность) — не затронут.
- **Регресс коротких экранов.** Контент ниже 844px: скроллер не должен давать
  лишний скролл (`min-h-full` внутри), footer — прижат к низу слотом, а не
  `margin-top:auto` контента.

## Верификация

`npm run verify` + `npm run e2e` + runtime-прогон по `.claude/skills/verify/SKILL.md`:
открыть локально прод-слепки cpqr-scenario (регионы+длинный контент),
pay-app-home-v1 (canvas 1722), ctyp-single-offer (короткий экран с футером),
magnit-loyalty-july (без регионов) в `/p/:id` и `/present` на десктопном вьюпорте;
плюс шаринговый маршрут `/share/p/:id/v/N` (идёт через тот же PresentShell/DeviceFrame).

## Триаж ревью (Stage 2, 2026-07-24)

Два адверсариальных ревьюера (Opus): корректность/архитектура и скоуп/регрессии.
Все находки **приняты**, отклонённых нет; план обновлён:

1. (major) statusBar-слот не создавался в T1 при extract-политике T3 → T1: три слота,
   statusBar в `targets` и disposition.
2. (major) `h-dvh` FluidStage внутри 844-фрейма переполнял бы его → T1: RegionStage
   height-agnostic, `h-dvh` остаётся у FluidStage-обёртки.
3. (major) два `data-eui-content-scroller` в плеере ломали бы селекторы → T2: три
   различимых имени (`player`/`player-stage`/`player-canvas`).
4. (minor) двойной `HostStageSurface`/`SurfaceSpacingScope` → T1/T2: владение
   зафиксировано (HostStageSurface — RegionStage в no-canvas, DeviceFrame в canvas;
   SurfaceSpacingScope — у вызывающих).
5. (minor) desktop-fluid терял тумблер статусбара → T2: минимальный провайдер на ветке.
6. (blocker) `docs/prototype-format.md` фиксирует inline-семантику → новая T5.
7. (blocker) `e2e/dev|preview/screen-regions.spec.ts` запирает inline player/present →
   T4: переписать player+present-блоки явно.
8. (major) `min(canvas.height, каноник)` давал «короткий телефон» для canvas<844 →
   T2: высота фрейма всегда каноническая при наличии канонического viewport.
9. (major) DOM-структура/Overlay-якорь недоспецифицированы → T2: точная структура,
   T4: осознанное переписывание Overlay-тестов ScreenView.
10. (minor) tablet без тестов → T4(e); пути e2e поправлены (`e2e/`, не `test/`);
    ложный риск скриншот-снапов убран; share добавлен в верификацию.

Ревизии — дословное применение рекомендаций ревьюеров без смены подхода,
повторный раунд ревью не требуется.
