# Мобильный плеер: fluid-презентация на телефоне + QR из галереи

## Контекст

Большинство прототипов easy-ui — мобильные UI, но сейчас даже present-режим рисует их на телефоне как масштабированную карточку 390×844 с рамкой и десктопным футером. Нужно: отправил ссылку/QR на телефон → прототип открывается на весь экран и ощущается как мобильное приложение. Инфраструктура уже есть: share-ссылки с cookie-обменом (`/share/:token`, без BasicAuth у зрителя), QR (`qrcode.react`) в ShareDialog, bare-маршруты present вне `Layout`.

Решения, принятые с пользователем:
- **Рендер — fluid**: 100% реальной ширины/высоты телефона, без scale-трансформа и рамки (для flow-экранов).
- **Вход — автодетект** в PresentShell: те же URL (`/p/:id/present`, `/share/.../present`); на телефоне — fluid, на десктопе — как сейчас. Override `?mobile=1|0`.
- **App-feel — скрытый мини-HUD** (FAB → панель: рестарт, счётчик, выход), без PWA и свайпов.
- **Шеринг — QR прямо в галерее** (пилл на карточке, переиспользующий извлечённый ShareDialog).

## Триаж адверсариального ревью (раунд 1, gpt-5.6-sol max, 2026-07-16)

Находки: 2 blocker, 7 major, 2 minor.

| # | Находка | Вердикт |
|---|---|---|
| 1 | blocker: `?mobile` теряется на 303-редиректе `/share/:token` (exchange игнорирует query) | **Принято** → новая задача W0-2: сервер переносит валидированный `mobile=0\|1` в Location; e2e на оба значения |
| 2 | blocker: единый viewport-host ломает контракт canvas-Overlay (должен масштабироваться с холстом) + один scale не задаёт layout-высоту | **Принято** → FluidStage получает две ветки (flow / canvas), см. решения 2–3 |
| 3 | major: HUD без выхода при внутреннем PUSH-входе (`directEntry=false`, Esc на телефоне нет) | **Принято** → выход всегда при `!share`; `directEntry` меняет только подпись; Escape сначала закрывает верхний UI |
| 4 | major: Dialog/Drawer портализуются в `document.body` (`position:fixed`, z-50) мимо ContentScroller; stacking-контракт не определён; «fixed = viewport» неверно внутри transform | **Принято** → stacking-контракт в решении 4, browser-тесты в W5; формулировка про fixed исправлена |
| 5 | major: `viewport-fit=cover` — глобальное изменение всех маршрутов без safe-area политики; капчер-проверка ничего не доказывает | **Принято с заменой**: `viewport-fit=cover` НЕ добавляем (старая задача W0-2 снята). HUD использует `env(safe-area-inset-*)` с fallback (без cover = 0, в портрете достаточно). Landscape-letterboxing принят для v1; ручной пункт на реальном устройстве остаётся |
| 6 | major: tablet/desktop flow на телефоне — «components responsive» не доказано; hostPrimitivesAllowed-гард нельзя терять | **Принято** → гард сохраняется буквально (то же выражение), ContentScroller `overflow-x: auto`, тест-матрица в W5 |
| 7 | major: опциональный `versions?` делает ShareDialog недоопределённой async-машиной | **Принято с заменой**: ShareDialog сохраняет обязательный `versions`; в галерее — loader-обёртка `GalleryShareDialog` (загрузка версий → рендер диалога), состояния loading/error/empty у обёртки |
| 8 | major: `devices["iPhone 13"]` тянет webkit (в CI только Chromium), viewport 390×664, `test.use` не влияет на ручные `newContext`, HUD-таймер флакает | **Принято** → явные mobile-Chromium context-опции, Playwright clock, опции в ручной share-context, non-390 canvas-фикстура |
| 9 | major: DAG/ownership неполны (server route, GalleryPage.test, тесты ShareDialog, playwright.config); «e2e оба проекта» устарело (их 4) | **Принято** → волны пересобраны ниже |
| 10 | minor: контракт детектора (coarse compact viewport, а не «телефон»), search из `useLocation`, граница 767/768 | **Принято** |
| 11 | minor: `touch-action: manipulation` на всём скроллере не обоснован | **Принято** → свойство убрано |

## Проверенные факты (основа решений)

- `src/app/routes.tsx:39-46` — present/share/capture уже вне `Layout`; клиентские маршруты не меняем.
- `src/player/PresentShell.tsx` — единственная точка ветвления; паттерн латча на маунт есть (`directEntry`, строка 40). Футер — строки 159-176; `DeviceFrame` с `fitZoom` — 148; `hostPrimitivesAllowed={doc.device !== "desktop" || screen.canvas !== undefined}` — 151.
- `src/player/DeviceFrame.tsx` — **не модифицируется**; референс: scaled-обёртка размером `w×scale / h×scale` + transformed-inner (иначе scale не задаёт scroll-высоту), `SurfaceSpacingScope`, `stageHostRef`/`HostStageSurface`, ResizeObserver.
- Overlay портализуется в `stageHostRef` (`absolute; inset:0`) — якорь должен быть: для flow — вьюпорт, для canvas — сам холст (контракт таблицы поверхностей `docs/prototype-format.md`).
- Builtin Dialog/Drawer портализуются в `document.body` (`position:fixed`, z-50) — минуют скроллер и stage; это учитывает stacking-контракт (решение 4).
- Share-авторизация матчит pathname (`server/main.ts:53`), но **обмен токена** (`server/routes/share.ts:28`, `ShareRepo.exchange` → Location) игнорирует query — `?mobile` без правки сервера теряется.
- `ShareDialog` — приватный компонент `src/player/ScreenView.tsx:72-170`; существующие тесты ScreenView его **не покрывают** — нужны собственные тесты диалога.
- Playwright: 4 проекта в `playwright.config.ts`; CI ставит только Chromium; `devices["iPhone 13"]` → webkit + viewport 390×664.

## Сквозные решения

1. **Детекция — латч на маунт PresentShell** (не реактивная; смена query на смонтированном шелле не переключает режим — задокументировать и покрыть тестом намеренной нереактивности). Чистая функция `detectMobilePresent(search, env)`: `override ?? (coarsePointer && Math.min(innerWidth, innerHeight) < 768)`; `search` — из `useLocation()` (React Router), не из `window.location`; guard на отсутствие `matchMedia` (jsdom). Семантика — «coarse compact viewport», не «телефон» (coarse-планшет с short side ≥768 остаётся в рамке). Override `?mobile=1` → fluid, `?mobile=0` → рамка; query переживает флоу-навигацию (существующее поведение).
2. **`FluidStage` — новый компонент с двумя ветками**, DeviceFrame не трогаем.
   - **Flow-ветка**: host `relative; w-full; h-dvh; overflow-hidden` + `data-eui-stage-viewport="present-fluid"` = якорь `HostStageSurface` (Overlay прибит к вьюпорту) + `SurfaceSpacingScope`; внутри — ContentScroller (`h-full; overflow-y-auto; overflow-x-auto; overscroll-behavior-y: contain`, контент `min-h-full`). Без `touch-action`.
   - **Canvas-ветка** (зеркалит DeviceFrame-семантику, только scale-to-width): внешний ContentScroller; внутри spacer размером `canvas.width*scale × canvas.height*scale`; в нём transformed-inner `width/height = canvas`, `transform: scale(scale)`, `transform-origin: top left` — **он же** StageViewport/`stageHostRef` для `HostStageSurface` → canvas-Overlay масштабируется и скроллится вместе с холстом (контракт сохранён). `scale = scroller.clientWidth / canvas.width` (учитывает вертикальный скроллбар), через ResizeObserver.
   - `hostPrimitivesAllowed` передаётся тем же выражением, что и сейчас (desktop-flow без canvas — примитивы запрещены).
3. **Фиксированные размеры**: flow-экраны любых устройств — fluid на ширину вьюпорта; неадаптивный контент (desktop/tablet) даёт горизонтальный скролл в ContentScroller (`overflow-x: auto`), не clipping. Canvas-экраны — авторский размер, scale-to-width (ветка 2b).
4. **HUD и stacking-контракт**. FAB ~36px, правый нижний угол, отступы `calc(0.75rem + env(safe-area-inset-*, 0px))`; тап → панель (Restart, счётчик, выход, закрыть), автоскрытие 4 с. Выход показывается **всегда при `!share`**: `directEntry` → «Открыть в easy-ui», иначе «Вернуться в плеер» (тот же `exitPath`). Escape: сначала закрывает открытый HUD/help, повторный — выход (при `!share`). Z-порядок (фиксируется в доке): контент прототипа < Overlay (в stage) < FlowResetBanner < Dialog/Drawer (body, z-50) < HUD (`z-[60]`) — HUD доступен поверх authored-scrim и модалок. `pointer-events` только на своих узлах.
5. **ShareDialog извлекается** в `src/player/ShareDialog.tsx` с **обязательным** `versions` (контракт не меняется: `{ prototypeId, versions, currentVersion?, onClose }`) + собственные unit-тесты (create/copy/revoke/error). Галерея использует loader-обёртку `GalleryShareDialog` (в `src/gallery/`): грузит `listPrototypeVersions` → loading/error/empty-состояния → рендер ShareDialog; abort при закрытии; в плеере дополнительного запроса нет.
6. **Сервер — минимальная правка share-обмена**: `/share/:token?mobile=0|1` переносит **только валидированный** `mobile` в Location 303 (произвольный query не копируется). `docs/server-api.md` — абзац в разделе share.
7. **`viewport-fit=cover` не добавляем** (снято по ревью — глобальный риск для app-хрома). `env(safe-area-inset-*)` в HUD с fallback 0. Landscape-letterboxing на iOS принят для v1; проверка на реальном устройстве — ручной пункт приёмки.

## Волны исполнения

DAG: `W0 → W1 → W2 → W5`, параллельно `W3 → W4 → W5`. Ownership эксклюзивный; `PresentShell.tsx` — последовательно W1→W2; строки: W2 — `strings/player.ts` (блок presentHud), W4 — `strings/gallery.ts`; W3 строк не добавляет.

### W0 — детекция и серверный override
- **W0-1**: `src/player/mobilePresent.ts` — `detectMobilePresent(search, env)` + `useMobilePresent()` (латч, search из `useLocation`). Юниты: override 1/0/мусор/дубликат query, coarse+узкий/широкий, fine+узкий, без matchMedia, landscape 844×390, граница 767/768, нереактивность латча. Файлы: `src/player/mobilePresent.ts`, `mobilePresent.test.ts`.
- **W0-2**: перенос `mobile=0|1` через 303 share-обмена. Файлы: `server/routes/share.ts` (и/или `server/share/repo.ts` — где формируется Location), серверный тест (существующий share-тест или новый), `docs/server-api.md`. Done: `/share/<token>?mobile=0` → Location с `?mobile=0`; `?mobile=1` → с `?mobile=1`; посторонний query не переносится; существующие share-тесты зелёные.

### W1 — FluidStage и интеграция
- **W1-1**: `src/player/FluidStage.tsx` (+ тест) по решениям 2–3. Юниты: flow — Overlay-портал в host-вьюпорт (host — предок скроллера), контент min-h-full; canvas 390×2000 на scroller 320 → scale 320/390, spacer 320×(2000·320/390), stageHost = transformed-inner (Overlay внутри масштаба); scale от `clientWidth`.
- **W1-2**: интеграция в `PresentShell.tsx`: `useMobilePresent()` → `<FluidStage>` вместо `<DeviceFrame>`, футер не рендерится, фон `bg-background`; `hostPrimitivesAllowed` — то же выражение; хоткеи остаются (Escape-логика уточняется в W2). Обновить `PresentShell.test.tsx` (mock matchMedia; `?mobile=1` → `present-fluid`, `?mobile=0`/desktop → как раньше). Done: старые тесты зелёные без изменения desktop-ожиданий; `e2e/dev/present.spec.ts` зелёный.

### W2 — мини-HUD
- **W2-1**: `src/player/PresentHud.tsx` (+ тест), монтаж в mobile-ветку `PresentShell.tsx`, Escape-приоритет (закрыть HUD/help → выход), строки в `strings/player.ts`. Юниты: раскрытие/автозакрытие (fake timers), выход виден при `!share` с подписью по `directEntry`, скрыт при `share`; Restart дергает `navigation.restart`; z-[60]; pointer-events не перекрывают прототип.

### W3 — извлечение ShareDialog (параллельно W0–W2)
- **W3-1**: вынести `ShareDialog` + `shareTtlOptions` из `ScreenView.tsx` в `src/player/ShareDialog.tsx` **без изменения контракта** (versions обязателен) + новые unit-тесты диалога (create → QR, copy, revoke, loadError/createError). Файлы: `src/player/ShareDialog.tsx`, `ShareDialog.test.tsx`, `src/player/ScreenView.tsx`. Done: поведение плеера бит-в-бит, e2e share зелёный, новые тесты зелёные.

### W4 — QR в галерее
- **W4-1**: `src/gallery/GalleryShareDialog.tsx` (loader-обёртка: версии → loading/error/empty → ShareDialog, abort при закрытии) + пилл «QR на телефон» на карточке (только при `latestVersion !== null`, один открытый диалог на страницу). Файлы: `GalleryShareDialog.tsx` (+ тест), `GalleryPage.tsx`, `GalleryPage.test.tsx` (создать/обновить), `strings/gallery.ts`. Done: клик → загрузка версий → создать → QR-SVG; ошибка загрузки версий показывается в обёртке; без версий пилла нет.

### W5 — e2e, доки, приёмка
- **W5-1**: `e2e/dev/present-mobile.spec.ts` — **явные mobile-Chromium опции** (viewport 390×844, `isMobile: true, hasTouch: true`, без `devices[...]`-дескриптора с webkit), Playwright clock для HUD-таймера. Матрица: mobile flow fluid + полный тап-флоу + Overlay прибит к вьюпорту; HUD (FAB → панель → Restart → выход при internal-входе); `?mobile=0` → рамка; один кейс честной эвристики (context с `pointer: coarse`, предусловие `matchMedia` проверяется); canvas-фикстура **non-390** (напр. 420×1200) → scale-to-width + canvas-Overlay масштабирован; tablet/desktop flow на телефоне → горизонтальный скролл без clipping, desktop-flow без canvas → Overlay не рендерится; Dialog/Drawer открыты → фон не скроллится, HUD доступен поверх. Кейс в `e2e/share/scoped-share.spec.ts`: ручной `newContext` с mobile-опциями, `/share/<token>?mobile=1` → 303 с override → fluid; `?mobile=0` → рамка. Файлы: `e2e/dev/present-mobile.spec.ts`, `e2e/share/scoped-share.spec.ts`, при необходимости `playwright.config.ts`, фикстура canvas-прототипа в e2e-сиде.
- **W5-2**: доки: строка «Present, mobile fluid» в таблицу поверхностей `docs/prototype-format.md` (flow: StageViewport = вьюпорт, скролл вложенный; canvas: авторский размер scale-to-width, Overlay в масштабе) + абзац про автодетект/`?mobile` + stacking-контракт + примечание про fixed внутри transform-контейнера.
- **W5-3**: runtime-приёмка по `/verify`: скриншоты `/p/<id>/present?mobile=1` в mobile-вьюпорте (экраны флоу, HUD открыт/закрыт, canvas-экран), share-путь через галерею-QR на preview-сборке (включая `?mobile=0/1` через редирект), регрессия desktop-present и капчера. Ручной пункт: открыть share-QR с реального телефона (iOS Safari: dvh, home-indicator, landscape).

## Риски

- **iOS Safari адресная строка** — `h-dvh` уже используется; не применять `100vh`. Реальное устройство — W5-3.
- **Pull-to-refresh** сбрасывает флоу — `overscroll-behavior-y: contain` минимизирует, FlowResetBanner объясняет.
- **`position:fixed` внутри scaled canvas** ведёт себя как absolute относительно transform-контейнера — это существующее поведение рамки, во fluid canvas-ветке оно сохраняется; фиксируется в доке (W5-2).
- **Playwright pointer:coarse** — большинство кейсов через `?mobile=1`, эвристика — один выделенный кейс.
- **HUD-таймер во флаки-CI** — Playwright clock (W5-1).
- **Canvas-Overlay** — контракт сохранён canvas-веткой FluidStage, покрыт юнитом W1-1 и e2e non-390 фикстурой.

## Верификация

`npm run verify` (агрегат) + `npm run e2e` (все 4 Playwright-проекта) + runtime-приёмка W5-3. Не ломаем: desktop-present, плеер, capture/visual (DeviceFrame и capture-поверхность не тронуты), share-allowlist (правка только редиректа обмена — allowlist не меняется).
