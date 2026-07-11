# Применение дизайн-системы «Финтех» к app-шеллу easy-ui

Дата: 2026-07-11 · Статус: v2 после раунда ревью №1 (триаж в §7)
Источник дизайна: claude.ai/design проект `d0ce77d7-5be4-4403-8271-f32125e901e0` («easy-ui — CJM и UI»), реализованная статичная страница `public/design/cjm-ui/index.html` (b9acfe3) — эталон визуала.

## 1. Контекст и цель

Дизайн-проект задаёт визуальный язык: лавандовая палитра (бренд `#844EDC`), плоские плашки с крупными радиусами (24–32px), pill-кнопки, шрифты Coil (заголовки) и YS Text (интерфейсный текст), тёмная графитовая сцена плеера. Сейчас app-шелл easy-ui стилизован дефолтными shadcn-токенами и системным шрифтом.

**Цель:** привести хром приложения (Layout/nav, галерея, плеер, CJM-вид, редактор, библиотека, служебные страницы) к дизайн-системе из макетов.

**Не-цели:**
- Не менять рендеринг прототипов: дизайн-системы прототипов (`src/designSystems/*`) и их shadcn-токены остаются байт-в-байт.
- Не менять поведение/маршруты/логику/aria — только представление.
- Не строить UI-kit; минимальный локальный модуль классов (§2.4).

## 2. Ключевые архитектурные решения

### 2.1 Инвариант: рендер прототипа не меняется

Плеер (`ScreenView` → `<Renderer>`), CJM-тайлы (`CjmScreenTile`), канвас редактора (`EditorCanvas`) и `/debug` (`SmokeSpec`) рендерят прототип **инлайн в общем DOM**; порталы shadcn (Dialog/Popover/…) уходят в `body`. Отсюда жёсткие запреты:

- **Не менять** существующие shadcn-переменные (`--primary`, `--background`, `--radius`, …) ни в `:root`, ни в `.dark`.
- **Не назначать** `font-family` на `body`, `:root`, `h1..h6`, `button`, `input` и не переопределять `--font-sans`. (Иначе меняются метрики: переносы и `scrollHeight` в масштабировании CJM-тайлов, `Range.getClientRects()` в hit-test редактора, контент порталов.)
- **Не использовать** класс `.dark` и наследуемый `color-scheme: dark` над зоной, содержащей `<Renderer>`: `@custom-variant dark` в index.css перекрасит inline-прототип. Тёмный плеер строится только прямыми `eui-*` утилитами на элементах хрома.

Инвариант проверяется автоматически (§5, пункт «invariant-spec»).

### 2.2 Токены: примитивы + семантические роли в неймспейсе `eui-*`

В `@theme` (Tailwind 4, index.css) добавляются токены с префиксом — коллизий с дефолтной палитрой и shadcn-переменными нет:

```css
@theme {
  /* primitives */
  --color-eui-ink: #020205;
  --color-eui-graphite: #2F3033;
  --color-eui-lav: #F1EBF6;
  --color-eui-lilac-100: #E8E8FF;
  --color-eui-lilac-200: #E1CFFF;
  --color-eui-lilac-300: #D8D0E5;
  --color-eui-brand: #844EDC;
  --color-eui-magenta: #C62CD0;
  --color-eui-orange: #FF9A00;
  --color-eui-slate-500: #4D5566;
  --color-eui-slate-400: #8F96A5;
  --color-eui-ondark-2: #B8BAC0;
  /* fonts */
  --font-eui-display: "Coil", Georgia, serif;
  --font-eui-ui: "YS Text", system-ui, sans-serif;
}
```

Семантика задаётся не CSS-каскадом, а модулем `chrome.ts` (§2.4): роли (surface/text/border/focus) фиксируются в общих строках классов, а не размазываются по JSX. Полноценный слой семантических CSS-переменных не вводим — для одного приложения с шестью зонами это лишний уровень косвенности; примитивы + chrome.ts дают ту же дисциплину дешевле.

### 2.3 Шрифты: файлы в `public/fonts/`, применение адресно

- `@font-face` в index.css: Coil 400 (woff2) / 500 (otf) / 700 (otf); YS Text 400/500/700 (woff2); всё `font-display: swap`, кириллица покрыта обоими семействами (Coil — кириллический шрифт Brownfox; YS — Яндекс). Синтетических начертаний не допускаем: используем только веса, для которых есть файлы.
- Файлы переезжают из `public/design/cjm-ui/fonts/` в `public/fonts/`; статичная страница переключается на `/fonts/...` — перенос, правка её URL и `@font-face` делаются **атомарно в одном коммите T0**. Хеширования у public-ассетов нет; `server/static.ts` не выставляет агрессивных cache-заголовков, поэтому stale-cache риска нет — версионирование имён не требуется.
- Применение шрифтов — только через утилиты `font-eui-ui` / `font-eui-display` на app-owned контейнерах (header, aside, панели, main галереи/CJM/библиотеки, верхние бары плеера/редактора). Контейнеры, внутри которых рендерится прототип (`DeviceFrame` внутренность, `CjmFrame`, `EditorFrame`, SmokeSpec-рендер), шрифтовых утилит не получают.
- Лицензия Coil: коммерческий шрифт Brownfox из дизайн-проекта пользователя, использование авторизовано им (файлы в репо с b9acfe3).

### 2.4 Общие паттерны хрома — `src/app/chrome.ts`

Экспортируемые константы строк классов (не компоненты): `pillPrimary`, `pillGhost`, `pillGhostOnDark`, `chip`, `chipActive`, `plate`, `card`, `kicker`, `kickerOnDark`, `inputBase`, `headingPage`, `headingBar`. Все зоны импортируют отсюда; правки ролей делаются в одном месте.

### 2.5 Контракт высоты Layout

`Layout.tsx` переходит на `min-h-dvh grid grid-rows-[auto_1fr]`, outlet-строка получает `min-h-0`. Страницы **перестают** считать собственный viewport: `h-screen`/`min-h-screen`/`calc(100vh-4rem)` в EditorView/LibraryPage/ScreenView/CjmView заменяются на `h-full`/`min-h-0`/flex-раскладку от родителя. Это снимает зависимость от высоты хедера (Coil-хедер может стать выше 4rem).

## 3. Спецификация по экранам (эталон — макеты в `public/design/cjm-ui/index.html`)

### 3.0 Layout / навигация / служебные (`src/app/Layout.tsx`, `routes.tsx`)
- Хедер: белый, нижний хэрлайн `border-eui-ink/10`; логотип «easy-ui» — `font-eui-display font-bold` 18px.
- Навигация: `font-eui-ui` 14px; активный пункт `font-bold text-eui-brand border-b-2 border-eui-brand`. Debug — обычный пункт. Аватар из макета **не** добавляем (нет пользователей).
- 404-роут (`routes.tsx`): заголовок `font-eui-display`, ссылка-pill назад в галерею.
- Grid-контракт высоты (§2.5).

### 3.1 Галерея (`src/gallery/GalleryPage.tsx`)
- Заголовок «Прототипы» `font-eui-display font-medium text-3xl`; подзаголовок `text-eui-slate-500`.
- Фильтры: pill-чипы, активный `bg-eui-brand text-white`, неактивный `border-eui-ink/15`.
- Карточка: `rounded-3xl bg-eui-lav p-6`, без рамки/тени; чипы метаданных `bg-eui-lilac-200` (система) и `bg-white` (экраны/версия); действия — pill-primary «Открыть» + pill-ghost «CJM», «Редактор». Состав контента карточки не менять.
- Состояния: loading/error/empty/«ничего по фильтру» — стилизуются в этой же задаче (плашка `bg-eui-lav`, текст `text-eui-slate-500`, ошибка — `text-eui-magenta`).

### 3.2 Плеер (`src/player/ScreenView.tsx`, `ScreensSidebar.tsx`, `DeviceFrame.tsx`, `PlayerShell.tsx`)
- Тёмная сцена **только утилитами**: `bg-eui-graphite text-white`, разделители `border-white/15`. Без `.dark`, без `color-scheme` (§2.1).
- Верхняя панель: «← Галерея», название `font-eui-display font-medium text-white`, чип версии `bg-white/10`; существующие действия («Заново», «CJM», …) — pill-ghost `border-white/25`; кнопку «Поделиться» из макета не добавляем.
- Сайдбар: kicker «ЭКРАНЫ · N» `text-eui-ondark-2`; активный экран `rounded-xl bg-eui-brand/35 text-white`, номер `text-eui-lilac-200`; неактивные `text-eui-ondark-2`.
- Зона устройства: `radial-gradient` подсветка rgba(132,78,220,0.18); host DeviceFrame — `rounded-[28px] shadow-[0_20px_60px_rgba(2,2,5,0.35)]`, фон host'а остаётся `bg-background` (это поверхность прототипа — не трогаем); переключатели устройств — pill-ghost на `border-white/25`.
- Контраст (пары зафиксированы): white/graphite ≈ 12.6:1; `#B8BAC0`/graphite ≈ 7.3:1; white/`#844EDC` ≈ 4.6:1 (текст 700 ≥14px — ок); `#E1CFFF`/graphite ≈ 9.9:1; focus-ring на тёмном — `outline-white/80`. Ошибочные состояния на графите — `text-eui-orange` (≈7.9:1), не magenta.
- Хотспот-обводка в `CanvasLayers` (общий файл — ownership T0.5): цвет на `--color-eui-orange`, если визуализация уже существует; новой механики не добавлять.

### 3.3 CJM-вид (`src/cjm/CjmView.tsx`, `CjmShell.tsx`)
- Фон страницы `bg-eui-lav`; хедер: заголовок `font-eui-display font-medium`, подзаголовок `text-eui-slate-500`; действия — pill белая + pill-primary (существующие).
- Подпись тайла: номер `font-eui-display text-eui-brand` + название `font-bold`; заметка `text-xs text-eui-slate-500`. Сам тайл-фрейм (`CjmScreenTile`) — ownership T0.5.
- Стрелки-коннекторы: stroke `#844EDC`, width 2.5, `stroke-linecap="round"`.

### 3.4 Редактор (`src/editor/*`, `e2e/dev/editor.spec.ts`)
- Светлая тема. Верхняя панель: название `font-eui-display font-medium`, чип статуса `bg-eui-lilac-100 text-eui-slate-500`, кнопка сохранения — pill-primary; ошибки валидации/409 — существующие блоки, перекрасить (`text-eui-magenta`, плашки `bg-eui-lilac-100`).
- Дерево: kicker-заголовок; выбранный узел `rounded-lg bg-eui-lilac-100 font-bold`.
- Канвас: подложка `bg-eui-lav`; рамка выделения — `border-eui-magenta`, и добавить `data-testid="editor-selection-frame"`; e2e-селектор `.border-primary` (editor.spec.ts:86) заменить на этот testid. Бейдж типа компонента не добавляем.
- Перед геометрическими ассертами в editor.spec.ts добавить `await page.evaluate(() => document.fonts.ready)` — поздний reflow хедера от webфонтов не должен сдвигать canvas между измерениями.
- Инспектор: kicker «ИНСПЕКТОР»; `inputBase` из chrome.ts (`rounded-xl border-eui-ink/15`); variant-переключатели — pill-чипы.
- Лента экранов (`EditorScreenStrip`): подписи/чипы стилизуются здесь, но `CjmFrame` импортируется из cjm — его не трогать (T0.5).

### 3.5 Библиотека (`src/library/LibraryPage.tsx`)
- Сайдбар: «Библиотека» `font-eui-display font-medium text-xl`; чипы систем pill; группы — kicker; активная стори `rounded-lg bg-eui-lilac-100 font-bold`.
- Правая зона: заголовок `font-bold`, ссылка «Открыть в Storybook» `underline text-eui-slate-500`; контейнер iframe `rounded-3xl border border-eui-ink/10` (внутрь iframe не лезем — Storybook preview импортирует общий index.css и остаётся неизменным, т.к. body-шрифт мы не меняем).
- Состояния loading/unavailable — стилизовать.

### 3.6 Служебное
- `/debug` (`SmokeSpec`): только заголовок/обёртку страницы в стиль (`font-eui-display`), рендер-зону не трогать.
- `PrototypeLoader` (общий для плеера/CJM/редактора; ownership T0.5): состояния loading/error/missing получают **нейтральное** оформление, читаемое и на светлом, и на графите: центрированная плашка `rounded-2xl bg-eui-lilac-100 text-eui-ink p-6` + для loading заменить невидимый пустой div на текст «Загрузка прототипа…». Никаких appearance-пропов не вводим — нейтральная плашка одинаково легитимна на обоих фонах.

## 4. Декомпозиция на Codex-задачи и file ownership

Последовательность: **T0 → T0.5 → (T1‥T5 параллельно) → I (интеграция)**.

| # | Задача | Файлы (ownership) |
|---|---|---|
| T0 | Фундамент: `@theme` токены + `@font-face`; перенос шрифтов `public/design/cjm-ui/fonts/*` → `public/fonts/` с правкой URL статичной страницы (атомарно); `src/app/chrome.ts`; рестайл `Layout.tsx` + grid-контракт высоты; 404 в `routes.tsx`; `/debug` обёртка `SmokeSpec.tsx` | `src/styles/index.css`, `public/fonts/*`, `public/design/cjm-ui/index.html`, `src/app/Layout.tsx`, `src/app/routes.tsx`, `src/app/chrome.ts`, `src/smoke/SmokeSpec.tsx` |
| T0.5 | Общие рендер-поверхности: `PrototypeLoader` (состояния, §3.6), `CanvasLayers` (хотспот-цвет), `CjmScreenTile`/`CjmFrame` (карточка тайла §3.3, без изменения scale-логики) | `src/player/PrototypeLoader.tsx`, `src/player/CanvasLayers.tsx`, `src/cjm/CjmScreenTile.tsx` (+ их тесты) |
| T1 | Галерея + её состояния | `src/gallery/GalleryPage.tsx` (+ тест) |
| T2 | Плеер (тёмная сцена) + screen-not-found/render-error состояния | `src/player/ScreenView.tsx`, `ScreensSidebar.tsx`, `DeviceFrame.tsx`, `PlayerShell.tsx` (+ тесты) |
| T3 | CJM-вид (хедер/фон/подписи/стрелки) | `src/cjm/CjmView.tsx`, `CjmShell.tsx` (+ тесты) |
| T4 | Редактор + селектор рамки и fonts.ready в e2e | `src/editor/**` (кроме импортов из cjm), `e2e/dev/editor.spec.ts` |
| T5 | Библиотека + состояния | `src/library/LibraryPage.tsx` (+ тест) |
| I | Invariant-spec (§5.3) + финальная верификация | `e2e/dev/restyle-invariant.spec.ts` (новый) |

Каждой задаче в промпт: этот план и её §§, эталон `public/design/cjm-ui/index.html`, запреты §2.1 дословно, «только представление, не менять поведение/aria/роли/testid (кроме оговорённых)», «читай `.d.ts` в node_modules», «не коммить».

## 5. Done-критерии и гейты

Пер-задача (проверяет оркестратор):
1. `npm run verify` зелёный.
2. aria/роли/testid без изменений (кроме T4-оговорки); греп по зоне: не осталось `bg-primary|text-primary-foreground|text-muted-foreground|bg-card|bg-muted` в файлах зоны; `src/designSystems/`, `src/catalog/` не тронуты (git diff пуст).
3. Скриншот зоны (Playwright, 1440×900) визуально соответствует моку; спот-чек 390×844 без нецелевого горизонтального скролла.

Интеграционный гейт (задача I + оркестратор):
1. `npm run e2e` (dev + preview) зелёный.
2. **Invariant-spec**: новый Playwright-тест открывает плеер, CJM, редактор и `/debug` с фикстурным прототипом и ассертит внутри отрендеренного shadcn-элемента: computed `font-family` начинается с системного стека (не Coil/YS), и `getComputedStyle(document.documentElement).getPropertyValue('--primary'|'--background'|'--radius')` равны базовым значениям (захардкоженным из текущего index.css). Для библиотеки — те же проверки внутри Storybook iframe.
3. `document.fonts.check('16px Coil')` и `('14px "YS Text"')` истинны на галерее; `/design/cjm-ui/index.html` и оба семейства в `/fonts/` отвечают 200 в preview-режиме.
4. Runtime-прогон по `.claude/skills/verify/SKILL.md` (галерея → флоу → библиотека) + скриншоты всех пяти зон.
5. Контраст: соответствие парам из §3.2 — проверяется по зафиксированной таблице (расчётные коэффициенты в плане), без автоматических ассертов.

## 6. Риски и отступления от макета

- Лик токенов/шрифтов в прототипы — закрыт запретами §2.1 и invariant-spec §5.
- Webfont-reflow и геометрия e2e — `document.fonts.ready` в editor.spec (T4).
- Высотный контракт — §2.5, правится в T0 + каждой зоной у себя.
- Отступления: без аватара (§3.0), без «Поделиться» (§3.2), без бейджа выделения (§3.4), хинт-бар плеера — только если уже существует; моковые данные из макета не переносятся.
- Coil — коммерческий (Brownfox), авторизован пользователем.

## 7. Триаж ревью (раунд 1, Codex gpt-5.6-sol, 2026-07-11)

| Находка | Severity | Решение |
|---|---|---|
| Глобальный body-шрифт ломает метрики прототипов/порталов/hit-test | blocker | **Принято.** §2.1/§2.3: body не трогаем, шрифты только адресно на app-owned контейнерах |
| Тёмный плеер через `.dark` перекрасит прототип | blocker | **Принято** (план и не предлагал `.dark`, теперь запрет явный в §2.1 + запрет `color-scheme`) |
| Верификация не доказывает инвариант прототипов | blocker | **Принято.** Новая задача I: invariant-spec на computed styles (§5.3) |
| Токены: примитивы + семантические роли, не размазывать по JSX | major | **Принято частично.** Примитивы в @theme + роли централизованы в chrome.ts; отдельный слой семантических CSS-переменных отклонён как лишняя косвенность для одного приложения |
| Ownership пересекается (PrototypeLoader, CjmFrame↔EditorScreenStrip, CanvasLayers) | major | **Принято.** Введена T0.5 «общие поверхности», зоны от них отрезаны |
| PrototypeLoader: состояния и появление на светлом/тёмном | major | **Принято.** §3.6: нейтральная плашка + видимый loading; appearance-проп отклонён (не нужен для нейтрального решения) |
| Не хватает /debug, 404, состояний зон | major | **Принято.** §3.0/3.1/3.2/3.5/3.6 + маршрутная матрица в §5 |
| Высотный контракт Layout (100vh/4rem) | major | **Принято.** §2.5 grid-rows-[auto_1fr], зоны переходят на h-full/min-h-0 |
| Storybook в границе риска | major | **Принято** — закрывается отказом от body-шрифта; отдельный Storybook-regression сверх invariant-spec (который проверяет iframe) отклонён |
| Шрифты в src/assets с хешами; cache policy; атомарность | major | **Частично.** Атомарность переноса — принята (T0, один коммит). Перенос в src/assets отклонён: статичной странице нужны нехешированные public-URL, дублировать 350KB файлов ради хешей при сервере без cache-заголовков — неоправданно |
| Контраст: конкретные пары | major | **Принято.** §3.2 таблица пар с коэффициентами; автоматические contrast-ассерты отклонены (фиксированная палитра, аудит по таблице) |
| fonts.ready перед геометрией в editor e2e | major | **Принято.** §3.4 |
| `.border-primary` → data-testid | minor | **Принято.** §3.4 `editor-selection-frame` |
| Точные @font-face и лицензия | minor | **Принято.** §2.3 |
| Gate: viewport-матрица 3 размеров | — | **Частично.** 1440 полный + 390 спот-чек; 834 отклонён (нет планшетных layout-веток в хроме) |
