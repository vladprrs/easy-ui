# easy-ui — просмотрщик кликабельных прототипов поверх Storybook + json-render (MVP)

## 1. Контекст

Продукт: веб-UI, работающий поверх Storybook (хранилище/витрина дизайн-системы) и [vercel-labs/json-render](https://github.com/vercel-labs/json-render), который позволяет просматривать **кликабельные прототипы** — многоэкранные флоу, собранные из живых компонентов дизайн-системы. Клик по компоненту (кнопка, хотспот) переключает экраны, как в Figma-прототипах, но компоненты настоящие: работают инпуты, hover-состояния, условная видимость, общий стейт флоу.

MVP = **просмотрщик**: галерея прототипов + плеер + страница-браузер дизайн-системы (через Storybook). Позже (вне скоупа, но архитектура не должна блокировать): редактор прототипов, drag-and-drop конструктор экранов из палитры, AI-генерация прототипов (json-render создан для AI-generated UI, есть streaming).

Репозиторий: `easy-ui` (github.com/vladprrs/easy-ui), пустой (1 initial commit), git инициализирован, remote есть. Окружение: Node 24.18, npm 12 (**pnpm не установлен → используем npm**), codex-cli 0.144.1 с конфигом `gpt-5.6-sol` / effort `max`.

## 2. Зафиксированные решения (согласованы с пользователем)

| Решение | Выбор |
|---|---|
| Рендеринг компонентов | **Нативно из кода** — компоненты регистрируются в registry json-render; реальная интерактивность; навигация через actions (не iframe-embed сторей) |
| Дизайн-система MVP | **`@json-render/shadcn`** — 36 готовых shadcn/ui-компонентов, уже связанных с json-render |
| Стек приложения | **Vite SPA** (React + TS), без бэкенда; прототипы = JSON-файлы в репо |
| Роль Storybook | Витрина/хранилище ДС: стории документируют компоненты каталога (рендер через тот же Renderer); страница Library в приложении читает `index.json` Storybook и встраивает стории через `iframe.html?id=…` |

## 3. Ключевые факты о json-render (проверено по исходникам/npm)

- Все пакеты `@json-render/*` версии **0.19.0**, кросс-пиннинг точными версиями → ставим exact `0.19.0`, обновляем только в связке. Лицензия Apache-2.0.
- Peer deps: **React ^19.2.3** (React 18 невозможен), **zod ^4** (пишем схемы на zod v4), **tailwindcss ^4**.
- **`@json-render/shadcn` не несёт CSS.** Стилизация — на хост-приложении: Tailwind v4 + `@source` на dist пакета (Tailwind не сканирует node_modules сам) + полный набор shadcn oklch-токенов + `@theme inline` + `tw-animate-css`. Это точка отказа №1.
- Spec — плоская карта: `{ root, elements: { key: { type, props, children: [ids], visible, on, watch } } }`. События: `"on": { "press": { "action": "navigate", "params": {…} } }`. Кастомные действия — `<ActionProvider handlers={{…}}>`; встроенные бесплатно: `setState`, `pushState`, `removeState`, `validateForm`. Стейт: `<StateProvider initialState>`, JSON-pointer, `$state` / `$bindState` / `$template` / `$cond` / `$computed`, `visible`-условия.
- События компонентов shadcn: `press` (Button, Link), `change` (Tabs, Checkbox, Radio, Switch, Slider, Toggle, ToggleGroup, Pagination), `submit`/`focus`/`blur` (Input), `select` (DropdownMenu). Контейнеры (Card и пр.) **не** эмитят → нужен кастомный **Hotspot** (прозрачная позиционируемая кликабельная область) — обязателен для Figma-подобных сценариев.
- `@json-render/core` экспортирует `validateSpec` — но проверяет **только структуру** (root, висячие children, misplaced `on`/`visible`). Типы/пропсы/действия против каталога не проверяет → пишем свой обход (walk) по `shadcnComponentDefinitions` (у определений есть `props` zod-схема, `events: string[]`, `example`).
- Определения компонентов содержат `example` — используем для автогенерации галереи сторей и фикстур.
- `@json-render/devtools-react` — drop-in `<JsonRenderDevtools/>`, подключаем только в dev (lazy).
- Storybook актуальный — **^10.5** (ESM-only, ок на Node 24), `@storybook/react-vite`. Vite берём **^7.3.6** (проверенная связка с plugin-react 5, @tailwindcss/vite, vitest 4, SB10).

## 4. Архитектура

Однопакетный репозиторий (ДС приходит из npm — локальный ui-пакет не нужен, монорепо избыточно):

```
/ (npm, "type": "module")
  .storybook/               # main.ts (react-vite, SB 10.5), preview.tsx (импорт index.css, декоратор с провайдерами)
  .github/workflows/ci.yml
  prototypes/               # JSON-документы прототипов (данные, не код)
    hello-world.json        #   минимальный 2-экранный (T2)
    checkout.json           #   мобильный e-commerce флоу, 5 экранов (T4)
    settings.json           #   настройки: Tabs/Switch/Dialog (T4)
  src/
    styles/index.css        # ⚠ несущий файл: tailwind + @source shadcn dist + токены shadcn + tw-animate-css
    catalog/
      hotspot.tsx           #   Hotspot: zod-def (events: ["press"]) + React-имплементация
      definitions.ts        #   { ...shadcnComponentDefinitions, Hotspot } — единый источник истины
      catalog.ts            #   defineCatalog(schema, { components, actions: {navigate, back, openUrl, restart} })
      registry.tsx          #   defineRegistry(catalog, { ...shadcnComponents, Hotspot })
      fixtures.ts           #   демо-спеки по `example` из определений (галерея + тесты)
      stories/              #   *.stories.tsx — стории каталога через Renderer
    prototype/
      schema.ts             #   zod v4 схема PrototypeDoc (без Vite API — нужна скриптам)
      validate.ts           #   validateSpec (core) + обход каталога + проверка целей navigate
      loader.ts             #   Vite: import.meta.glob("/prototypes/*.json") → валидированные документы
      types.ts
    player/
      PlayerShell.tsx       #   /p/:protoId — StateProvider(key=restartNonce) + ActionProvider + <Outlet/>, devtools в dev
      ScreenView.tsx        #   /p/:protoId/s/:screenId — <Renderer/> в position:relative обёртке (якорь Hotspot)
      actions.ts            #   buildActionHandlers({doc, navigate, restart}) — чистая, тестируемая
      DeviceFrame.tsx       #   mobile 390×844 / tablet 834×1112 / desktop + переключатель
      ScreensSidebar.tsx
    library/
      LibraryPage.tsx       #   браузер ДС: дерево из index.json + iframe-превью + graceful empty state
      storybookIndex.ts     #   fetch("/storybook/index.json"), защитный парсинг
    gallery/GalleryPage.tsx #   карточки прототипов
    app/                    #   main.tsx, routes.tsx (react-router v8), Layout
    smoke/SmokeSpec.tsx     #   /debug — доказательство пайплайна рендера (T1)
  scripts/
    validate-prototypes.ts  # tsx: валидация всех prototypes/*.json, exit 1 при ошибке
    check-storybook-drift.ts# каталог ↔ storybook-static/index.json: на каждый компонент есть стория
    check-css.mjs           # после build: sentinel-классы shadcn присутствуют в dist CSS (guard @source)
  e2e/smoke.spec.ts, playwright.config.ts
  docs/plans/2026-07-10-prototype-viewer-mvp.md
  docs/prototype-format.md  # спецификация формата + контракт действий + чеклист автора
```

Маршруты: `/` галерея → `/p/:protoId` (redirect на startScreen) → `/p/:protoId/s/:screenId` плеер; `/library`; `/debug`.

Ключевые механики плеера:
- **Стейт живёт выше экранов**: `StateProvider` в `PlayerShell`, `Renderer` в `ScreenView` меняет спеки под ним → данные форм/переключателей переживают навигацию. Restart = bump `key` у StateProvider + replace на startScreen. (Fallback, если провайдер пересеивает стейт: свой `createStateStore` в ref — core его экспортирует.)
- **URL-синхронизация**: `navigate` = router push → браузерный Back == Back прототипа.
- **Storybook в dev** через Vite proxy `/storybook` → `localhost:6006` (снимает CORS); в prod Storybook собирается в `dist/storybook` (same-origin).

## 5. Формат прототипа v1 и контракт действий

```jsonc
{
  "version": 1,
  "id": "checkout",                     // slug == имя файла
  "name": "Checkout Flow",
  "description": "Мобильный e-commerce checkout",
  "device": "mobile",                   // mobile | tablet | desktop (default desktop)
  "startScreen": "cart",
  "state": { "cart": { "items": 2 } },  // единый стейт прототипа (переживает навигацию)
  "screens": [
    { "id": "cart", "name": "Корзина",
      "spec": { "root": "main", "elements": { "main": { "type": "Stack", "props": {}, "children": [] } } } }
  ]
}
```

Zod v4, `strictObject` везде; per-screen `state` **отвергается схемой** намеренно; `superRefine`: уникальность id экранов, `startScreen ∈ screens`. `validatePrototype(doc)` по каждому экрану: (a) core `validateSpec`; (b) обход каталога — `type` известен, ключи/значения props против zod-определения (динамические `$`-объекты проверяются только структурно), ключи `on` ⊆ `def.events`, имена действий ∈ контракт ∪ встроенные, `navigate.params.screenId` существует; (c) reachability-проверка экранов от startScreen (warning).

| action | params | поведение плеера |
|---|---|---|
| `navigate` | `{ screenId }` | router push на `/p/:protoId/s/:screenId` |
| `back` | `{}` | router `navigate(-1)`, guard на входе во флоу |
| `openUrl` | `{ url, newTab?: true }` | `window.open(url, "_blank", "noopener")` |
| `restart` | `{}` | сброс стейта (key bump) + replace на startScreen |
| встроенные | `setState`, `pushState`, `removeState`, `validateForm` | обрабатывает json-render |

## 6. Зависимости (точные)

deps: `@json-render/{core,react,shadcn}@0.19.0` (exact), `react`/`react-dom` `^19.2.4`, `react-router ^8.2`, `zod ^4.3.6`.
devDeps: `@json-render/devtools-react@0.19.0`, `vite ^7.3.6`, `@vitejs/plugin-react ^5`, `tailwindcss ^4.1`, `@tailwindcss/vite ^4.3`, `tw-animate-css ^1.4`, `typescript ^5.9`, `storybook ^10.5` + `@storybook/react-vite` + `@storybook/addon-docs`, `vitest ^4.1` + `jsdom` + `@testing-library/react ^16`, `@playwright/test`, `tsx ^4.21`, `eslint ^9` + `typescript-eslint` + `eslint-plugin-react-hooks`. `engines.node >= 24`.

`src/styles/index.css` (несущий): `@import "tailwindcss"` + `@import "tw-animate-css"` + `@source "../../node_modules/@json-render/shadcn/dist/*.{js,mjs}"` + `@custom-variant dark` + полный набор shadcn oklch-токенов в `:root`/`.dark` + `@theme inline` маппинг (образец — `examples/chat/globals.css` в репо json-render).

## 7. Процесс выполнения (по CLAUDE.md)

1. **Stage 0** — скопировать этот план в `docs/plans/2026-07-10-prototype-viewer-mvp.md`, закоммитить.
2. **Stage R — adversarial review**: `/codex:adversarial-review --model gpt-5.6-sol` по файлу плана (effort max берётся из конфига Codex — уже выставлен). Если команда в сессии недоступна — fallback: ревью через codex-rescue-агента с промптом «адверсариально оспорь подход/допущения/декомпозицию» без `--effort` (упадёт в config-max). Триаж находок → правки плана → при существенных изменениях повторное ревью. Код не трогаем, пока есть блокирующие возражения.
3. **Stage E — исполнение**: задачи T1–T7 через `/codex:rescue --model gpt-5.6-sol --effort medium <задача>`; параллельные дорожки — `--background`; связанные доработки — `--resume`, независимые — `--fresh`. Я (Fable 5) верифицирую done-criteria каждой задачи перед следующей, разруливаю конфликты, коммичу поэтапно. Застряло/неудовлетворительно после 1 итерации → эскалация `--effort high`/`xhigh` или без флага (config max).
4. Финал — интеграционная проверка: `npm run verify` + e2e + ручной клик-скрипт (§9), затем `/verify`.

## 8. Задачи T1–T7 (каждая — самодостаточный Codex-запуск)

```
T1 → T2 → T3 ─┐
 │       └ T4 ┼→ T7        параллельные дорожки после T1: {T2→(T3 ∥ T4)} ∥ {T5}
 └→ T5 → T6 ──┘             T6 требует T3+T5
```

**T1 — Скаффолд + доказательство рендера/стилизации** (фундамент).
Vite 7 + React 19.2 + TS strict (npm); Tailwind v4 по §6; json-render трио exact 0.19.0; весь `src/catalog/` (definitions + Hotspot + catalog + registry); страница `/debug` с хардкод-спеком: Card + Heading + Input `$bindState` + Switch + Button `on.press → setState` + текст `$template` + Hotspot с alert-handler; `scripts/check-css.mjs`; eslint flat; vitest+jsdom с 1 RTL-тестом (Renderer рендерит Button, клик вызывает spy-handler). Исполнителю: **читать `node_modules/@json-render/react/dist/index.d.ts` как источник истины по именам props, не гадать**.
✅ `npm run typecheck && npm run lint && npm test && npm run build && npm run check:css` зелёные; на `/debug` компоненты визуально стилизованы (primary-кнопка с фоном), клик по Button меняет связанный текст (петля emit → action → state → re-render доказана).

**T2 — Библиотека формата + валидация + доки** (после T1).
`src/prototype/{schema,validate,loader,types}.ts` по §5; `prototypes/hello-world.json` (2 экрана: navigate + back + одна привязка стейта); `scripts/validate-prototypes.ts`; `docs/prototype-format.md` (поля, контракт действий, правила динамических значений, чеклист автора); vitest: schema accept/reject (per-screen state отвергнут, дубли id, битый startScreen), негативы валидатора (неизвестный type, битый prop, неизвестное событие, navigate в никуда), hello-world проходит.
✅ `npm test` зелёный; `npm run validate:prototypes` exit 0 с per-file отчётом.

**T3 — Плеер** (после T2).
Маршруты по §4; PlayerShell (loader, StateProvider с restart-key, ActionProvider из `buildActionHandlers`, lazy devtools в dev); ScreenView (relative-обёртка); DeviceFrame (device из документа + ручной переключатель); ScreensSidebar; дружелюбный 404 на неизвестный proto/screen; unit-тесты `actions.ts`.
✅ typecheck+test+build зелёные; вручную: `/p/hello-world` → redirect на стартовый экран → клик CTA → URL `/p/hello-world/s/<screen2>`, контент сменился → браузерный Back вернул → Switch переключён, ушёл-вернулся — стейт жив → Restart сбросил.

**T4 — Сэмплы прототипов** (после T2, параллельно T3).
`checkout.json` — 5 экранов (каталог → товар [Hotspot на Image] → корзина [счётчик из стейта, `visible` empty-state, `$template` итоги] → форма [`$bindState` Input/Select/Radio] → успех), mobile; `settings.json` — 3–4 экрана (Tabs, Switch → setState → `visible`-секции, Dialog, openUrl, back), desktop. Строго по docs/prototype-format.md, код не менять (кроме списков фикстур в тестах).
✅ `npm run validate:prototypes` зелёный на все 3 файла; тест «все прототипы валидны против каталога» зелёный; все экраны достижимы от startScreen.

**T5 — Storybook 10 как браузер ДС** (после T1, параллельно T2–T4).
Ручная установка SB ^10.5 (`main.ts` ESM, react-vite, addon-docs; `preview.tsx` импортирует `index.css`, глобальный декоратор: StateProvider + ActionProvider с логированием через SB `action()`); `fixtures.ts` из `example`-полей определений; кураторские стории: Button, Input ($bindState-демо), Card, Tabs, Dialog, Select, Table, Alert, Hotspot (args ↔ props элемента); стория-галерея `Catalog/All Components` по фикстурам; тест: ключи фикстур ⊇ ключи определений.
✅ `npm run storybook -- --smoke-test` exit 0; `npm run build-storybook` зелёный; в `storybook-static/index.json` есть id всех кураторских сторей; `npm test` зелёный.

**T6 — Галерея + Library, единый билд** (после T3+T5).
GalleryPage из loader (имя/описание/device/число экранов); LibraryPage по §4 (дерево из `/storybook/index.json`, iframe `?id=<storyId>`, ссылка «открыть в Storybook», empty-state с инструкцией при недоступном SB); навигация в шапке; `"build": "vite build && storybook build -o dist/storybook"`.
✅ typecheck+test+build зелёные, `dist/storybook/index.json` существует; dev+storybook параллельно: /library показывает дерево и рендерит сторию в iframe; со стоящим SB — инструкция вместо краха.

**T7 — E2E + drift-check + CI + README** (после T3,T4,T5,T6).
Playwright smoke (webServer: dev): `/` → карточка Checkout → экран 1 → CTA → URL+заголовок экрана 2 → Back → до формы → ввод в связанный Input → уход/возврат — значение живо → Restart — сброшено; `check-storybook-drift.ts`; `.github/workflows/ci.yml` (npm ci → typecheck, lint, test, validate:prototypes, build, check:css, drift, playwright chromium); README-runbook; агрегат `npm run verify`.
✅ `npx playwright test` зелёный; `npm run verify` зелёный целиком; CI-файл ссылается только на существующие скрипты.

## 9. Верификация (финальная)

Автоматика: `npm run verify` = tsc --noEmit + eslint + vitest + validate:prototypes + vite build + storybook build + check-css + drift; затем `npx playwright test`.

Ручной клик-скрипт: (1) `npm run dev` + `npm run storybook`; (2) `/debug` — стилизованная карточка, клик мутирует текст; (3) `/` — 3 карточки; (4) Checkout — мобильная рамка, стартовый экран; (5) Hotspot на товаре → экран товара, URL обновился; (6) «в корзину» → бейдж-счётчик из стейта; (7) значения формы переживают Back/Forward; (8) экран успеха → Restart → чистый старт; (9) браузерный Back зеркалит историю прототипа; (10) `/library` — дерево сторей + превью в iframe, совпадает со Storybook на :6006.

## 10. Риски

1. **Tailwind не эмитит классы из dist пакета** (риск №1) → `@source` на `@json-render/shadcn/dist` (паттерн подтверждён примером в самом репо), guard `check-css.mjs` в T1, визуальный критерий на `/debug` до всей остальной работы.
2. **Экспериментальные 0.x API** (README ≠ реальность) → exact-pin 0.19.0 связкой; T1 доказывает полную петлю до зависимых задач; исполнители читают shipped `.d.ts`; все импорты json-render — только через `src/catalog/` и `src/player/actions.ts` (швы для замены).
3. **Персистентность стейта между экранами** держится на StateProvider-над-Renderer → закреплено критериями T3 и e2e T7; fallback: свой `createStateStore`.
4. **SB10 ESM + общий vite-конфиг** (двойная загрузка плагинов, CSS в preview) → preview импортирует тот же index.css, стории через наш Renderer, `--smoke-test` в критериях, `viteFinal` как escape-hatch.
5. **Связка Library ↔ внутренности index.json** → dev-прокси (same-origin), статика в prod, защитный парсинг, graceful degradation: фича — только список+iframe.
6. **Валидатор vs динамические props** (`$state` в `z.string()`-поле) → правило: `$`-объекты проверяются только структурно; позитивные и негативные кейсы в T2.

## 11. Вне скоупа MVP (следующие итерации)

Редактор прототипов (json-patch поверх spec), drag-and-drop конструктор из палитры (палитра уже есть: definitions + fixtures + стории), AI-генерация флоу (streaming `createSpecStreamCompiler` + AI SDK), подсветка кликабельных зон по «мёртвому клику», шаринг/деплой, подключение чужих ДС (адаптер: свои definitions+registry по образцу shadcn).
