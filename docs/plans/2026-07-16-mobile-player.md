# Мобильный плеер: fluid-презентация на телефоне + QR из галереи

## Контекст

Большинство прототипов easy-ui — мобильные UI, но сейчас даже present-режим рисует их на телефоне как масштабированную карточку 390×844 с рамкой и десктопным футером. Нужно: отправил ссылку/QR на телефон → прототип открывается на весь экран и ощущается как мобильное приложение. Инфраструктура уже есть: share-ссылки с cookie-обменом (`/share/:token`, без BasicAuth у зрителя), QR (`qrcode.react`) в ShareDialog, bare-маршруты present вне `Layout`.

Решения, принятые с пользователем:
- **Рендер — fluid**: 100% реальной ширины/высоты телефона (100dvw×100dvh), без scale-трансформа и рамки.
- **Вход — автодетект** в PresentShell: те же URL (`/p/:id/present`, `/share/.../present`); на телефоне — fluid, на десктопе — как сейчас. Override `?mobile=1|0`.
- **App-feel — скрытый мини-HUD** (FAB → панель: рестарт, счётчик, выход), без PWA и свайпов.
- **Шеринг — QR прямо в галерее** (пилл на карточке, переиспользующий извлечённый ShareDialog).

## Процесс (workflow CLAUDE.md)

После одобрения: сохранить план в `docs/plans/2026-07-16-mobile-player.md`, закоммитить → адверсариальное Codex-ревью (gpt-5.6-sol, max) → триаж → исполнение волнами через Codex (`--write --effort medium`), верификация done-критериев оркестратором, поэтапные коммиты → финальный `npm run verify` + `npm run e2e` + runtime-приёмка (`/verify`).

## Проверенные факты (основа решений)

- `src/app/routes.tsx:39-46` — present/share/capture уже вне `Layout`; маршруты не меняем.
- `src/player/PresentShell.tsx` — единственная точка ветвления; паттерн латча на маунт уже есть (`directEntry`, строка 40). Футер (точки/счётчик/Restart/exit) — строки 159-176; `DeviceFrame` с `fitZoom` — строка 148.
- `src/player/DeviceFrame.tsx` — **не модифицируется** (им пользуются плеер и десктопный present; риск регрессий снимается отдельным компонентом). Референс паттернов: `SurfaceSpacingScope`, `stageHostRef`/`HostStageSurface`, ResizeObserver.
- Overlay-примитивы портализуются в `stageHostRef` (`position:absolute; inset:0`) → во fluid-режиме stage-host обязан быть контейнером размера вьюпорта, а скролл контента — **вложенным** скроллером, иначе bottom-Overlay уедет вниз длинного контента.
- Canvas-экраны (`screen.canvas`) рендерятся жёстким размером (`CanvasLayers`) — во fluid масштабируем по ширине.
- Share-авторизация матчит **только pathname** (`server/main.ts:55` → `shares.authorize(request, decodedPath)`) → `?mobile=1` проходит share-гейт, **серверных изменений нет**.
- `ShareDialog` — приватный компонент `src/player/ScreenView.tsx:72-170` (версии/TTL/QR/список грантов); галерея (`src/gallery/GalleryPage.tsx:166-171`) share-действий не имеет, у карточки есть `latestVersion`.
- `index.html` — meta viewport без `viewport-fit=cover` (нужен для safe-area HUD).
- e2e-референсы: `e2e/dev/present.spec.ts`, `e2e/share/scoped-share.spec.ts`; Playwright позволяет per-file `test.use({ ...devices["iPhone 13"] })`.

## Сквозные решения

1. **Детекция — латч на маунт PresentShell** (не реактивная; ротация не переключает режим на лету, перезагрузка переоценит). Чистая функция `detectMobilePresent(search, env)`: `override ?? (coarsePointer && Math.min(innerWidth, innerHeight) < 768)`, `coarsePointer` через `matchMedia("(pointer: coarse)")` с guard для jsdom. Override `?mobile=1` → fluid, `?mobile=0` → рамка; query переживает навигацию по флоу (существующее поведение W1-5 прошлого плана).
2. **`FluidStage` — новый компонент**, DeviceFrame не трогаем. Структура: host `relative; w-full; h-dvh; overflow-hidden` + `data-eui-stage-viewport="present-fluid"` = якорь `HostStageSurface` (Overlay прибит к вьюпорту) + `SurfaceSpacingScope`; внутри — ContentScroller (`h-full; overflow-y-auto; overscroll-behavior-y: contain; touch-action: manipulation`, контент `min-h-full`).
3. **Фиксированные размеры**: flow-экраны любых устройств — fluid как есть (компоненты responsive); canvas-экраны сохраняют авторский размер, scale-to-width (`scale = hostWidth / canvas.width`, `transform-origin: top left`, вертикальный overflow скроллится в ContentScroller).
4. **HUD**: постоянная полупрозрачная FAB ~36px в правом нижнем углу (safe-area отступы через `env(safe-area-inset-*)`), тап → компактная панель (Restart, счётчик «3 / 7», «Открыть в easy-ui» только при `directEntry && !share`, закрыть), автоскрытие 4 с. Никаких жестов (конфликт с интеракциями прототипа). `pointer-events` только на своих узлах; десктопный футер во fluid не рендерится.
5. **ShareDialog извлекается** в `src/player/ShareDialog.tsx` с контрактом `{ prototypeId, versions?, currentVersion?, onClose }`: без `versions` диалог сам грузит `listPrototypeVersions`; плеер передаёт версии из контекста — поведение бит-в-бит. Дефолты как сейчас (TTL неделя, последняя версия).
6. **Сервер и `docs/server-api.md` — без изменений.**
7. **`viewport-fit=cover`** в `index.html`; страховка — pixel-check капчера до/после.

## Волны исполнения

DAG: `W0 → W1 → W2 → W5`, параллельно `W3 → W4 → W5`. Ownership эксклюзивный; `PresentShell.tsx` — последовательно W1→W2; W3 новых строк не добавляет (share-строки уже в `strings/player.ts`), строки галереи — в `strings/gallery.ts` (W4).

### W0 — детекция и viewport-мета
- **W0-1**: `src/player/mobilePresent.ts` — чистая `detectMobilePresent(search, env)` + хук `useMobilePresent()` (латч `useState(() => ...)`); юниты на все ветки (override 1/0/мусор, coarse+узкий/широкий, fine+узкий, без matchMedia, landscape 844×390). Файлы: `src/player/mobilePresent.ts`, `mobilePresent.test.ts`. Done: юниты зелёные, функция не трогает window напрямую.
- **W0-2**: `viewport-fit=cover` в `index.html`. Done: build ок, контрольный капчер совпадает с baseline.

### W1 — fluid-рендер
- **W1-1**: `src/player/FluidStage.tsx` (+ тест) по решениям 2–3; юниты: Overlay-якорь = host (портал в host, host — предок скроллера), canvas 390×2000 на host 320 → scale 320/390, скролл в ContentScroller.
- **W1-2**: интеграция в `PresentShell.tsx`: `useMobilePresent()` → `<FluidStage>` вместо `<DeviceFrame>`, футер не рендерится, фон `bg-background` вместо графита; хоткеи остаются. Обновить `PresentShell.test.tsx` (mock matchMedia; `?mobile=1` → `present-fluid`, `?mobile=0`/desktop → как раньше). Done: старые тесты зелёные без изменения desktop-ожиданий, `e2e/dev/present.spec.ts` зелёный.

### W2 — мини-HUD
- **W2-1**: `src/player/PresentHud.tsx` (+ тест), монтаж в mobile-ветку `PresentShell.tsx`, строки в `strings/player.ts` (блок `presentHud`). Юниты: раскрытие/автозакрытие (fake timers), exit только при `directEntry && !share`, Restart дергает `navigation.restart`, pointer-events не перекрывают прототип.

### W3 — извлечение ShareDialog (параллельно W0–W2)
- **W3-1**: вынести `ShareDialog` + `shareTtlOptions` из `ScreenView.tsx` в `src/player/ShareDialog.tsx` (контракт из решения 5, самозагрузка версий по образцу `VersionsMenu`); `ScreenView` импортирует — поведение плеера бит-в-бит. Done: тесты ScreenView и e2e share зелёные.

### W4 — QR в галерее
- **W4-1**: пилл «QR на телефон» в ряду действий карточки (`GalleryPage.tsx:166-171`), только при `latestVersion !== null`; открывает `ShareDialog` без `versions` (`currentVersion = latestVersion`); один открытый диалог на страницу (`useState<string|null>`). Строки — `strings/gallery.ts`. Ошибки — существующие внутри диалога. Done: клик → создать → QR-SVG с share-URL; без версий пилла нет.

### W5 — e2e, доки, приёмка
- **W5-1**: `e2e/dev/present-mobile.spec.ts` (`test.use({...devices["iPhone 13"]})`): fluid-рендер + полный тап-флоу; HUD (FAB → панель → Restart → чистый стейт); `?mobile=0` → рамка; один кейс на честную эвристику (iPhone-эмуляция даёт `pointer: coarse`), остальные через `?mobile=1` (стабильность CI). Кейс в `e2e/share/scoped-share.spec.ts`: share-URL в mobile-эмуляции → fluid, ресурсы под share-сессией отдаются.
- **W5-2**: строка «Present, mobile fluid» в таблицу поверхностей `docs/prototype-format.md` + абзац про автодетект/`?mobile`.
- **W5-3**: runtime-приёмка по `/verify`: скриншоты `/p/<id>/present?mobile=1` в iPhone-вьюпорте (экраны флоу, HUD открыт/закрыт), share-путь через галерею-QR на preview-сборке, регрессия desktop-present и капчера. Ручной пункт: открыть share-QR с реального телефона (iOS Safari, dvh/safe-area).

## Риски

- **iOS Safari адресная строка** — `h-dvh` уже используется; не применять `100vh`. Проверяется на реальном устройстве (W5-3).
- **Pull-to-refresh** сбрасывает флоу — `overscroll-behavior-y: contain` минимизирует, существующий FlowResetBanner объясняет.
- **`position:fixed` внутри прототипов** — во fluid совпадает с вьюпортом (лучше, чем в рамке); зафиксировать в доке.
- **Playwright pointer:coarse** — нестабильность эвристики страхуется `?mobile=1` в большинстве кейсов.
- **Overlay-якорь** — обязательное правило «host = вьюпорт, скролл вложенный», покрыто юнитом W1-1.

## Верификация

`npm run verify` (агрегат) + `npm run e2e` (оба проекта) + runtime-приёмка W5-3. Не ломаем: desktop-present, плеер, capture/visual (DeviceFrame и capture-поверхность не тронуты), share-allowlist (сервер без изменений).
