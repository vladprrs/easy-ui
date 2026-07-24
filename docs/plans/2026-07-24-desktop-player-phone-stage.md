# Desktop player: телефонная сцена с внутренним скроллом и пиннед-регионами

Дата: 2026-07-24 · Статус: draft → на адверсариальное ревью

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
(`data-eui-region="header|footer"`, скроллер `data-eui-content-scroller`,
overlay-слой `data-eui-overlay-layer`), своим `ScreenRegionsProvider`
(`header/footer: "extract"`) и `HostStageSurface`. Параметры: `statusBarDisposition`
(`"extract" | "drop"` — см. T3), `scrollResetKey`, `scrollerName`
(значение `data-eui-content-scroller`), `children`.
`FluidStage` (no-canvas ветка) переходит на него без изменения поведения
(маркеры/классы сохранить — на них завязаны e2e и mobilePresent).

### T2. DeviceFrame: фиксированный фрейм = канонический viewport

Fixed-viewport ветка `DeviceFrame`:

- **No-canvas (mobile/tablet):** размер фрейма остаётся `canonicalViewport[device]`;
  внутрь транформ-обёртки (`width/height` каноник, `transform: scale`) вставляется
  `RegionStage` — контент скроллится внутри телефона, header/footer/statusBar пиннед.
- **Canvas-экраны:** фрейм больше не равен canvas-высоте. Размер фрейма:
  ширина `canvas.width`, высота `min(canvas.height, canonicalViewport[device]?.height ?? canvas.height)`
  (для desktop-flow canvas-экранов cap — `playerDesktopMinStageHeight`? — нет:
  desktop+canvas сохраняет текущее поведение, cap только при наличии канонической
  высоты устройства). Внутри — вертикальный скроллер с `CanvasLayers` натурального
  размера (паттерн canvas-ветки FluidStage, scale=1; зум остаётся внешним
  `transform: scale`). `stageHost` (якорь Overlay) — canvas-размерный див внутри
  скроллера, как в FluidStage: Overlay скроллится вместе с canvas.
- Fit-масштаб считается от размера фрейма (как сейчас), который теперь ≤ каноника —
  «телефон» всегда телефонной длины.
- Провайдер регионов переезжает из `ScreenView`/`PresentShell` внутрь `DeviceFrame`
  (в `RegionStage`); из обоих вызовов убрать внешний `ScreenRegionsProvider`
  с `targets: {}` и `viewerRegionDisposition`.

### T3. statusBar и тумблер

Сегодня: тумблер «статусбар» в хроме плеера → `statusBar: "inline" | "drop"`.
Новая семантика: `statusBar: "extract"` в верхний пиннед-слот (над header) при
включённом тумблере, `"drop"` при выключенном. Тумблер прокидывается в
`DeviceFrame` пропом `statusBarHidden`. В `FluidStage` статусбар остаётся `"drop"`
(реальный телефон показывает свой). Present-десктоп — та же логика, что в плеере.

### T4. Тесты

- Unit `DeviceFrame`: (a) no-canvas mobile — фрейм 390×844, header/footer
  извлечены в слоты, контент в скроллере; (b) canvas 390×1722 — фрейм 390×844,
  внутри скроллер с canvas-дивом 1722; (c) desktop fluid ветка не изменилась;
  (d) statusBar extract/drop по пропу.
- Обновить `ScreenView.test.tsx` / `PresentShell.test.tsx` / `FluidStage.test.tsx`
  под новую структуру (провайдер внутри DeviceFrame).
- e2e (`test/`): прод-подобная фикстура — mobile-экран с header/footer и контентом
  >844px: футер виден без скролла и прижат к низу фрейма, контент скроллится
  колёсиком внутри фрейма, header остаётся на месте; canvas-фикстура 390×1722 —
  высота фрейма 844, вертикальный скролл до низа canvas.

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
| T4 e2e | `test/` (новые спеки/фикстуры) |

T1 → T2/T3 → T4 последовательно (T2 зависит от T1; тесты частично в составе задач).

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
- **e2e-геометрия.** Существующие geometry-пробы и скриншот-снапы плеера могли
  полагаться на inline-регионы — прогнать `npm run e2e` целиком, обновить снапы
  осознанно (только desktop-плеерные).
- **Регресс коротких экранов.** Контент ниже 844px: скроллер не должен давать
  лишний скролл (`min-h-full` внутри), footer — прижат к низу слотом, а не
  `margin-top:auto` контента.

## Верификация

`npm run verify` + `npm run e2e` + runtime-прогон по `.claude/skills/verify/SKILL.md`:
открыть локально прод-слепки cpqr-scenario (регионы+длинный контент),
pay-app-home-v1 (canvas 1722), ctyp-single-offer (короткий экран с футером),
magnit-loyalty-july (без регионов) в `/p/:id` и `/present` на десктопном вьюпорте.

## Триаж ревью

(заполняется после Stage 2)
