# Применение дизайн-системы «Финтех» к app-шеллу easy-ui

Дата: 2026-07-11 · Статус: draft → на ревью
Источник дизайна: claude.ai/design проект `d0ce77d7-5be4-4403-8271-f32125e901e0` («easy-ui — CJM и UI»), реализованная статичная страница `public/design/cjm-ui/index.html` (закоммичена, b9acfe3) — она же эталон визуала.

## 1. Контекст и цель

Дизайн-проект задаёт визуальный язык: лавандовая палитра (бренд `#844EDC`), плоские плашки с крупными радиусами (24–32px), pill-кнопки, шрифты Coil (заголовки) и YS Text (интерфейсный текст), тёмная графитовая сцена плеера. Сейчас app-шелл easy-ui стилизован дефолтными shadcn-токенами (oklch-нейтрали) и системным шрифтом.

**Цель:** привести хром приложения (Layout/nav, галерея, плеер, CJM-вид, редактор, библиотека) к дизайн-системе из макетов пяти экранов.

**Не-цели:**
- Не менять рендеринг прототипов: дизайн-системы прототипов (`src/designSystems/shadcn`, `wireframe`) и их токены остаются как есть.
- Не менять поведение/маршруты/логику — только представление.
- Не строить библиотеку UI-примитивов «на вырост»; допускается минимальный локальный модуль классов (см. §4).
- Не трогать Storybook-стори каталога.

## 2. Ключевые архитектурные решения

### 2.1 Изоляция токенов: новые цвета — в отдельном неймспейсе `eui-*`

Факт (из аудита кода): плеер (`ScreenView` → `@json-render/react` `<Renderer>`), CJM-тайлы (`CjmScreenTile`) и канвас редактора (`EditorCanvas`) рендерят прототип **инлайн в общем DOM** под общим `src/styles/index.css`. Изменение `--primary`/`--background` и т.п. перекрасит и превью прототипов.

Решение: существующие shadcn-переменные (`--primary`, `--background`, …) **не трогаем** — они обслуживают отрендеренные прототипы. Для хрома добавляем в `@theme` новые токены с префиксом (безопасно от коллизий с дефолтной палитрой Tailwind):

```css
@theme {
  --color-eui-ink: #020205;
  --color-eui-graphite: #2F3033;
  --color-eui-lav: #F1EBF6;        /* фон-подложка */
  --color-eui-lilac-100: #E8E8FF;  /* светлая плашка */
  --color-eui-lilac-200: #E1CFFF;
  --color-eui-lilac-300: #D8D0E5;
  --color-eui-brand: #844EDC;
  --color-eui-magenta: #C62CD0;    /* селекшн в редакторе */
  --color-eui-orange: #FF9A00;     /* хотспоты/акценты */
  --color-eui-slate-500: #4D5566;
  --color-eui-slate-400: #8F96A5;
  --color-eui-ondark-2: #B8BAC0;   /* вторичный текст на графите */
  --font-eui-display: "Coil", "YS Display", Georgia, serif;
  --font-eui-ui: "YS Text", system-ui, sans-serif;
}
```

Хром переводится с `bg-primary`/`text-muted-foreground` на `bg-eui-brand`/`text-eui-slate-500` и т.д. Хэрлайны — `border-eui-ink/10` (или `rgba(2,2,5,0.10)` через `/10`).

### 2.2 Шрифты: подключаем глобально, применяем адресно

`@font-face` для Coil (400 woff2, 500/700 otf) и YS Text (400/500/700 woff2) добавляются в `index.css`. Файлы переезжают из `public/design/cjm-ui/fonts/` в `public/fonts/` (единый источник); статичная страница `public/design/cjm-ui/index.html` переключается на абсолютные `/fonts/...` URL.

Применение:
- `body { font-family: var(--font-eui-ui) }` в `@layer base`. Следствие: shadcn-прототипы в превью унаследуют YS Text вместо системного стека. Это **осознанно**: макеты показывают контент прототипов в YS Text, а «применить дизайн-систему к проекту» включает типографику. Wireframe-система не затрагивается (у неё явный `font-mono`; юнит `src/catalog/runtime.test.ts:19` не ломается). Storybook-превью (`.storybook/preview.tsx` импортирует тот же index.css) станет консистентным автоматически.
- Заголовки хрома — утилита `font-eui-display` + `font-medium` (Coil Medium — базовое начертание заголовков системы).

### 2.3 Общие паттерны хрома — один локальный модуль

Повторяющиеся строки утилит (pill-кнопка primary/ghost, чип, карточка-плашка, подпись-«kicker») выносятся в `src/app/chrome.ts` как экспортируемые константы строк классов (не компоненты — минимальная инвазивность):

```ts
export const pillPrimary = "rounded-full bg-eui-brand px-4 py-2 text-sm font-bold text-white ...";
export const pillGhost   = "rounded-full border border-eui-ink/15 px-4 py-2 text-sm ...";
export const chip        = "rounded-full bg-eui-lilac-100 px-3 py-1 text-xs font-medium";
export const plate       = "rounded-3xl bg-eui-lav p-6";
export const kicker      = "text-[11px] font-bold uppercase tracking-[0.08em] text-eui-slate-400";
```

Каждая зона импортирует их; дублирование утилит между зонами устраняется без рефакторинга JSX-структуры.

## 3. Спецификация по экранам (эталон — макеты)

### 3.0 Layout / навигация (`src/app/Layout.tsx`)
- Хедер: белый, нижний хэрлайн `border-eui-ink/10`; логотип «easy-ui» — Coil 700, 18px.
- Пункты навигации: YS Text 14px; активный — `font-bold text-eui-brand` с подчёркивающей полосой 2px `border-b-2 border-eui-brand` (вместо underline).
- Справа — круглый аватар-плейсхолдер 32px `bg-eui-lilac-200 text-eui-brand` с инициалами (статично «ВП» не хардкодить — берём первые буквы из ничего нет → просто убрать либо оставить декоративный кружок; решение: НЕ добавлять аватар, у приложения нет пользователей — отступление от макета фиксируем).
- Пункт Debug остаётся, стилизуется как обычный пункт.

### 3.1 Галерея (`src/gallery/GalleryPage.tsx`)
- Заголовок «Прототипы» — Coil 500, ~30px; подзаголовок YS Text `text-eui-slate-500`.
- Фильтры систем: pill-чипы; активный `bg-eui-brand text-white`, неактивный `border-eui-ink/15`.
- Карточка: `rounded-3xl bg-eui-lav p-6`, без тени и рамки (плоская плашка); превью-зона внутри `rounded-2xl bg-eui-lilac-100` (существующий контент карточки не менять по составу); чипы метаданных (`bg-eui-lilac-200` — система, `bg-white` — счётчик экранов/версия); действия — pill «Открыть» (primary, растянутая) + pill-ghost «CJM», «Редактор».
- Сетка остаётся `sm:grid-cols-2 lg:grid-cols-3`.

### 3.2 Плеер (`src/player/ScreenView.tsx`, `ScreensSidebar.tsx`, `DeviceFrame.tsx`, `PlayerShell.tsx`)
- Вся сцена тёмная: `bg-eui-graphite text-white`, разделители `border-white/15`.
- Верхняя панель: «← Галерея», название прототипа (Coil 500 16px, белый), чип версии `bg-white/10`; справа pill-ghost «Заново», «CJM» (рамка `border-white/25`) и pill-primary «Поделиться» — если действия «Поделиться» нет в текущем UI, НЕ добавлять (отступление фиксируем), существующие действия перекрасить в эту стилистику.
- Сайдбар экранов: заголовок-kicker «ЭКРАНЫ · N» (`text-eui-ondark-2`); активный пункт `rounded-xl bg-eui-brand/35 text-white`, номер `text-eui-lilac-200`; неактивные `text-eui-ondark-2`.
- Зона устройства: по центру, фоновая подсветка `radial-gradient(... rgba(132,78,220,0.18) ...)`; сам DeviceFrame — белая «карточка» `rounded-[28px] shadow-[0_20px_60px_rgba(2,2,5,0.35)]`; переключатели устройств перекрасить под тёмную тему (pill-ghost на белой рамке).
- Хотспот-подсветка кликабельных зон: акцент `--color-eui-orange` (если сейчас есть визуализация хотспотов в `CanvasLayers` — цвет обводки на orange; если нет — не добавлять новую механику).
- Нижняя подсказка-бар (если есть текущий аналог) — стилизовать; новую не добавлять.

### 3.3 CJM-вид (`src/cjm/CjmView.tsx`, `CjmScreenTile.tsx`)
- Фон `bg-eui-lav`, всё в одной крупной плашке (страница и есть плашка — допустимо просто фон страницы).
- Хедер: заголовок Coil 500 ~24px, подзаголовок YS Text `text-eui-slate-500`; действия — pill белая «Открыть плеер» и pill-primary (существующие действия, перекрасить).
- Тайл: белая карточка `rounded-[20px] p-3 shadow-sm`, рендер экрана внутри `rounded-xl`; подпись: номер Coil `text-eui-brand` + название `font-bold`; заметка автора под тайлом `text-xs text-eui-slate-500`.
- Стрелки-коннекторы: обводка `#844EDC`, толщина 2.5, скруглённые концы (заменить текущий цвет stroke в inline-SVG).

### 3.4 Редактор (`src/editor/EditorView.tsx`, `EditorScreenStrip.tsx`, `InspectorPanel.tsx`, `ElementTree.tsx`, `propsForm/PropsForm.tsx`, `EditorCanvas.tsx`)
- Светлая тема. Верхняя панель: название (Coil 500 16px), чип статуса `bg-eui-lilac-100 text-eui-slate-500` («черновик · сохранено»/dirty), справа pill-ghost «Предпросмотр» (если есть) и pill-primary «Опубликовать vN» (существующая кнопка сохранения).
- Дерево элементов: kicker-заголовок; выбранный узел `rounded-lg bg-eui-lilac-100 font-bold`.
- Канвас: подложка `bg-eui-lav`; **рамка выделения**: цвет на `--color-eui-magenta` (#C62CD0) с бейджем типа компонента как в макете — БЕЙДЖ не добавлять (новая механика), только цвет рамки. ВНИМАНИЕ: e2e `e2e/dev/editor.spec.ts:86` селектит `.border-primary` — при смене класса рамки обновить селектор в тесте (файл в ownership этой задачи).
- Инспектор: kicker «ИНСПЕКТОР · <ТИП>»; инпуты `rounded-xl border-eui-ink/15`; переключатели variant — pill-чипы.
- Лента экранов: pill-чипы (активный `bg-eui-brand text-white`), «+ Экран» — pill с dashed-рамкой, если такой элемент существует; не добавлять новый.

### 3.5 Библиотека (`src/library/LibraryPage.tsx`)
- Сайдбар: заголовок «Библиотека» Coil 500 20px; чипы систем pill (активный primary); группы уровней — kicker; активная стори `rounded-lg bg-eui-lilac-100 font-bold`.
- Правая зона: заголовок стори `font-bold` + ссылка «Открыть в Storybook» (существующая, стилизовать `underline text-eui-slate-500`); iframe-контейнер `rounded-3xl border-eui-ink/10 bg-eui-lav` (фон внутри iframe не трогаем).

## 4. Декомпозиция на Codex-задачи и file ownership

| # | Задача | Файлы (ownership) | Блокирует |
|---|---|---|---|
| T0 | Фундамент: токены `eui-*` и `@font-face` в `src/styles/index.css`; перенос шрифтов в `public/fonts/`; правка URL в `public/design/cjm-ui/index.html`; рестайл `src/app/Layout.tsx`; создание `src/app/chrome.ts` | `src/styles/index.css`, `public/fonts/*`, `public/design/cjm-ui/index.html`, `src/app/Layout.tsx`, `src/app/chrome.ts` | T1–T5 |
| T1 | Галерея | `src/gallery/GalleryPage.tsx` (+ его тест при падении) | — |
| T2 | Плеер (тёмная сцена) | `src/player/ScreenView.tsx`, `ScreensSidebar.tsx`, `DeviceFrame.tsx`, `PlayerShell.tsx`, `CanvasLayers.tsx` (+ их тесты) | — |
| T3 | CJM-вид | `src/cjm/CjmView.tsx`, `CjmScreenTile.tsx`, `CjmShell.tsx` (+ тесты) | — |
| T4 | Редактор | `src/editor/*.tsx`, `src/editor/propsForm/*`, `e2e/dev/editor.spec.ts` (только селектор рамки) | — |
| T5 | Библиотека | `src/library/LibraryPage.tsx` (+ тест) | — |

T1–T5 параллелятся после T0 (непересекающиеся файлы). Каждой задаче в промпт: ссылка на этот план и §§, эталон `public/design/cjm-ui/index.html` (открыть и смотреть соответствующий мок), «только представление, не менять поведение/aria-имена/роли», «читай `.d.ts` в node_modules, не угадывай API», «не коммить».

## 5. Done-критерии (проверяет оркестратор)

Общие для каждой задачи:
1. `npm run verify` зелёный (юниты, типы, линт, validate:prototypes).
2. aria-имена, роли и `data-testid` не изменены (кроме оговорённого селектора в T4).
3. В зоне не осталось старых токен-утилит хрома (`bg-primary`, `text-muted-foreground`, `bg-card`, `bg-muted*`) — проверка грепом по файлам зоны; прототипный рендер-путь (`src/designSystems`, `src/catalog`) не тронут.
4. Скриншот зоны визуально соответствует моку (оркестратор снимает Playwright'ом и сравнивает глазами с `public/design/cjm-ui/index.html`).

Финально: `npm run e2e` (dev + preview) зелёный; runtime-прогон по `.claude/skills/verify/SKILL.md`.

## 6. Риски и отступления от макета

- **Лик токенов в прототипы** — закрыт неймспейсом `eui-*` (§2.1). Шрифт — осознанный глобальный (§2.2).
- **Тёмный плеер и контраст**: role-based e2e не зависят от цветов; проверить визуально читаемость валидационных/ошибочных состояний плеера на графите.
- **`.border-primary` в e2e** — ownership у T4 (§3.4).
- Отступления: без аватара в хедере (§3.0), без кнопки «Поделиться» (§3.2), без бейджа типа у рамки выделения (§3.4), нижний хинт-бар плеера — только если уже существует (§3.2). Из макета НЕ переносятся моковые данные.
- Coil — коммерческий шрифт (Brownfox), уже используется в дизайн-проекте пользователя; файлы уже в репозитории с b9acfe3.

## 7. Триаж ревью

(заполняется после раунда Codex-ревью: принято/отклонено с обоснованием)
