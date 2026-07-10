# easy-ui — просмотрщик кликабельных прототипов поверх Storybook + json-render (MVP)

**Версия плана: v2** (после адверсариального ревью Codex, раунд 1: 41 находка — 4 blocker, 27 major, 10 minor; все блокеры устранены, триаж в §12).

## 1. Контекст

Продукт: веб-UI поверх [vercel-labs/json-render](https://github.com/vercel-labs/json-render) для просмотра **кликабельных прототипов** — многоэкранных флоу из живых React-компонентов дизайн-системы. Клик по компоненту/хотспоту переключает экраны (как в Figma), но компоненты настоящие: инпуты, hover, условная видимость, общий стейт флоу.

**Источник истины MVP — каталог/registry json-render** (`shadcnComponentDefinitions` + `shadcnComponents` + наши расширения). Storybook — **витрина и браузер** этого каталога (не хранилище): стории документируют компоненты, страница Library даёт обзор ДС внутри продукта. Подключение реальной внешней ДС — через adapter-интерфейс (roadmap, §11).

MVP = просмотрщик: галерея + плеер + Library. Вне скоупа (архитектура не должна блокировать): редактор, drag-and-drop конструктор, AI-генерация.

Репозиторий: `easy-ui` (github.com/vladprrs/easy-ui), git инициализирован. Окружение: Node 24.18, **npm** (pnpm нет), codex-cli 0.144.1 (`gpt-5.6-sol`, effort `max` в конфиге).

## 2. Зафиксированные решения (согласованы с пользователем)

| Решение | Выбор |
|---|---|
| Рендеринг | Нативно из кода: registry json-render, реальная интерактивность, навигация через actions |
| ДС для MVP | `@json-render/shadcn` (36 компонентов) + наш `Hotspot` |
| Стек | Vite SPA (React + TS), без бэкенда; прототипы — JSON в репо |
| Storybook | Витрина каталога: стории через наш Renderer; Library читает `index.json` и встраивает стории `iframe.html?id=…` |

## 3. Проверенные факты о json-render (по исходникам; ссылки в отчёте ревью)

- Пакеты `@json-render/*` = **0.19.0**, кросс-пин exact; обновление только связкой. Apache-2.0.
- Peer deps по пакетам: `react` — react `^19.2.3`, shadcn `^19.0.0`; `zod` — core dep `^4.3.6`, shadcn peer `^4.0.0`; `tailwindcss` — shadcn peer `^4.0.0`. Эффективно: React ≥19.2.3, zod 4, Tailwind 4. **Фактический floor React задаёт react-router 8.2: `react >=19.2.7`.**
- `@json-render/shadcn` не несёт CSS → Tailwind v4 в хосте: `@source` на dist пакета + shadcn oklch-токены + `@theme inline` + `tw-animate-css`.
- **Провайдеры: `Renderer` безусловно требует visibility context; правильная обвязка — `JSONUIProvider` целиком** (StateProvider → VisibilityProvider → ValidationProvider → ActionProvider → Functions + confirmation manager). Не собирать стек вручную.
- **`defineRegistry` требует `actions`, если `catalog.actions` непуст** — components-only не пройдёт typecheck.
- Spec: `{ root, elements: { key: { type, props, children, visible, on, watch?, repeat? } }, state? }` — runtime шире нашего v1; v1 — строгий allowlist (§5).
- События **не несут payload**: `emit("change")` без значения — данные читаются из `$bindState`. `Link.press` предотвращает browser-переход только при `preventDefault: true`. Матрица событий генерируется из `definitions[*].events`, вручную не поддерживается (в т.ч. `Select.change`, `ButtonGroup.change`; у `Input` только `submit/focus/blur`).
- `validateSpec(spec, {checkOrphans:true})` — только структура: root, битые children, misplaced `visible/on/repeat/watch`, orphans. Не проверяет: типы, props, события, actions, циклы, state-пути → наш семантический валидатор (§5).
- **Props в shadcn definitions — required-but-nullable** (не optional): `Stack.props: {}` рендерится (runtime-defaults), но сырой `safeParse` его отвергнет → валидатор работает по **нормализованным** схемам (nullable → optional+nullable) + явный запрет неизвестных ключей.
- `example` есть лишь у ~12 из 36 definitions → фикстуры = `example ?? fixtureOverrides[name]`, покрытие всех 36 проверяется тестом на **равенство** множеств ключей.
- `ActionProvider` фиксирует handlers при монтировании (`useState(initialHandlers)`) и перехватывает внутренние `push`/`pop` через `/currentScreen`, `/navStack` → эти имена и пути **зарезервированы** (запрещены в v1).
- `StateProvider` (uncontrolled) создаёт store один раз; смена `initialState` не пересоздаёт store → remount по `key`.
- Storybook: **стабильная линия 10.4.6** (10.5 — только prerelease) → pin exact 10.4.6. Vite 7.3.6 совместим (peer `^5||^6||^7||^8`), Node 24 ок.
- `@json-render/devtools-react` — drop-in, dev-only lazy.

## 4. Архитектура

Однопакетный репозиторий:

```
/ (npm, "type": "module")
  .storybook/               # main.ts (react-vite 10.4.6), preview.tsx (index.css + декоратор JSONUIProvider)
  .github/workflows/ci.yml
  prototypes/               # hello-world.json (T2), checkout.json + settings.json (T4)
  src/
    styles/index.css        # ⚠ tailwind + @source shadcn dist + токены shadcn + tw-animate-css
    catalog/
      definitions.ts        #   { ...shadcnComponentDefinitions, Hotspot } + normalizeDefinition (nullable→optional)
      hotspot.tsx           #   Hotspot: def (props x,y,width,height,ariaLabel; events:["press"]) + impl (настоящий <button>)
      actions.ts            #   actionDefinitions: zod-схемы params ВСЕХ действий v1 (навигационные + встроенные)
      catalog.ts            #   defineCatalog(schema, { components, actions })
      runtime.ts            #   createPlayerRuntime(deps): typed action map → defineRegistry({components, actions}) + handlers
      fixtures.ts           #   example ?? fixtureOverrides — по одному валидному спеку на КАЖДЫЙ из 37 компонентов
      events.ts             #   матрица событий, генерируется из definitions
      stories/              #   *.stories.tsx через Renderer
    prototype/
      schema.ts             #   zod v4 «грамматика» PrototypeDoc (env-agnostic)
      validate.ts           #   validateSpec(core) + семантический валидатор + графовые проверки
      loader.ts             #   import.meta.glob → валидированные документы
      types.ts
    player/
      PlayerShell.tsx       #   /p/:protoId: JSONUIProvider key=`${doc.id}:${restartNonce}` + <Outlet/>; devtools dev-only
      ScreenView.tsx        #   /p/:protoId/s/:screenId: ErrorBoundary(диагностика+Restart) → relative-обёртка → <Renderer/>
      navigation.ts         #   sessionNonce/flowDepth в location.state; back-guard; same-screen no-op; restart-семантика
      DeviceFrame.tsx       #   mobile 390×844 / tablet 834×1112 / desktop + переключатель
      ScreensSidebar.tsx
    library/                #   LibraryPage (дерево index.json + iframe) + storybookIndex.ts (защитный парсинг)
    gallery/GalleryPage.tsx
    app/                    #   main.tsx, routes.tsx (react-router 8.2), Layout; базовый CSP в index.html
    smoke/SmokeSpec.tsx     #   /debug (T1)
  scripts/
    validate-prototypes.ts  # tsx: все prototypes/*.json + doc.id===basename; exit 1 при ошибке
    check-storybook-drift.ts# --index <path>: сгенерированные story-id присутствуют в index.json
    check-css.mjs           # по Vite-манифесту app-чанка (не Storybook CSS): sentinel-классы shadcn
  e2e/smoke.spec.ts, playwright.config.ts   # webServer: [vite dev, storybook dev]
  docs/plans/…  docs/prototype-format.md
```

Маршруты: `/` → `/p/:protoId` (redirect на startScreen) → `/p/:protoId/s/:screenId`; `/library`; `/debug`.

Механики плеера:
- **Провайдер**: `JSONUIProvider` целиком в `PlayerShell`, `key = ${doc.id}:${restartNonce}` — покрывает и restart, и смену прототипа (`/p/a → /p/b`), и застывшие handlers ActionProvider (пересоздаются при remount; сами handlers — стабильные closures через ref на текущий doc/router).
- **Стейт**: живёт над экранами, переживает навигацию **только для props с `$bindState`** (локальный useState несвязанных компонентов гибнет с экраном — это контракт, задокументирован). Reload/deep-link = свежий стейт: MVP — session-only.
- **Навигация**: push с `location.state = {sessionNonce, flowDepth}`; `back` — no-op при `flowDepth === 0`; `navigate` на текущий экран — no-op (без push); записи с чужим `sessionNonce` (после restart) при popstate замещаются стартовым экраном. Deep link на любой экран валиден (свежий стейт).
- **Ошибки**: ErrorBoundary вокруг каждого ScreenView (диагностика: prototype/screen + кнопка Restart) — битый runtime-prop не роняет приложение.
- **Storybook**: dev — Vite proxy `/storybook` → `:6006`; prod — сборка в `dist/storybook` (канонический путь везде).

## 5. Формат прототипа v1 — строгий allowlist

```jsonc
{
  "version": 1,
  "id": "checkout",                    // slug, валидатор проверяет id === basename файла
  "name": "Checkout Flow",
  "description": "…",
  "device": "mobile",                  // mobile | tablet | desktop (default desktop)
  "startScreen": "cart",
  "state": { "cart": { "items": 2 } }, // ЕДИНСТВЕННЫЙ источник initial state
  "screens": [
    { "id": "cart", "name": "Корзина",
      "canvas": { "width": 390, "height": 844 },   // опционально; обязателен при использовании Hotspot
      "spec": { "root": "main", "elements": { … } } }
  ]
}
```

**Разрешено в v1** (всё прочее схема/валидатор отвергают, а не «молча работает»):
- Поля элемента: `type`, `props`, `children`, `visible`, `on`. Динамические значения: `$state`, `$bindState`, `$template`, `$cond` (+`$then/$else`, операторы eq/gt/not/and…).
- События: `action` или **массив** `action[]` (последовательно) на событие; имена событий ⊆ `definitions[type].events`.
- Действия: см. контракт ниже; `navigate.params.screenId` — **статический literal** (граф переходов проверяем).

**Запрещено в v1** (зарезервировано): `repeat`, `watch`, `$computed`, `$item`, `$index`, `$bindItem`, `confirm`, `onSuccess/onError`, `spec.state` (и `screen.state`), действия `validateForm`/`push`/`pop`, state-пути с префиксами `/currentScreen`, `/navStack`, `/_viewer`. Формы в сэмплах v1 — без валидации; атомарный `submitForm` — backlog (§11).

**Контракт действий** — единый `actionDefinitions` (zod-схема params для каждого):

| action | params (zod) | поведение |
|---|---|---|
| `navigate` | `{ screenId: literal-slug }` | push + {sessionNonce, flowDepth+1}; на текущий экран — no-op |
| `back` | `{}` | `navigate(-1)`; no-op при flowDepth 0 |
| `openUrl` | `{ url, newTab?: true }` | только `http(s):`; `window.open(…, "noopener,noreferrer")` |
| `restart` | `{}` | remount по nonce + replace на startScreen; старые записи истории — stale |
| `setState` / `pushState` / `removeState` | схемы по типам core | встроенные; `statePath` — абсолютный RFC 6901, не служебный |

**Семантический валидатор** (`validate.ts`), после zod-грамматики и `validateSpec(spec,{checkOrphans:true})`, по каждому экрану:
1. `type` ∈ definitions; ключи `props`: неизвестные — ошибка; required (после нормализации nullable→optional) — присутствуют.
2. Значения props: статические — `safeParse` по нормализованной поле-схеме; динамические `$`-объекты — собственная discriminated-грамматика (тип-совместимость output — best-effort, задокументировано).
3. `on`: ключи ⊆ `definitions[type].events`; каждое действие — по `actionDefinitions`; цели `navigate` существуют.
4. Граф элементов: **дерево** (один родитель, root без родителя), DFS-проверка циклов, лимиты (≤500 элементов, глубина ≤50).
5. State-пути: RFC 6901, абсолютные; запись в служебные — ошибка; `$state` на путь вне `doc.state` — warning.
6. `Hotspot` требует `screen.canvas`; координаты в границах canvas.
7. Документ: уникальность/slug id, `startScreen` существует, reachability всех экранов от startScreen (warning), URL-политика для `openUrl`/`Image.src`/`Link.href` (запрет `javascript:`/`data:`).

## 6. Зависимости (точные)

deps: `@json-render/{core,react,shadcn}` **exact 0.19.0**; `react`/`react-dom` **^19.2.7** (floor от router); `react-router` **^8.2.0**; `zod` **^4.3.6**.
devDeps: `@json-render/devtools-react` 0.19.0; `vite ^7.3.6`; `@vitejs/plugin-react ^5`; `@types/react ^19.2` + `@types/react-dom ^19.2` (прямые!); `tailwindcss ^4.1` + `@tailwindcss/vite` + `tw-animate-css ^1.4`; `typescript ^5.9`; **`storybook`, `@storybook/react-vite`, `@storybook/addon-docs` — exact `10.4.6`** (стабильного 10.5 нет); `vitest ^4.1` + `jsdom` + `@testing-library/react ^16`; `@playwright/test`; `tsx ^4.21`; `eslint ^9` + `typescript-eslint` + `eslint-plugin-react-hooks`. `engines.node >= 24`.

`src/styles/index.css`: `@import "tailwindcss"` + `@import "tw-animate-css"` + `@source "../../node_modules/@json-render/shadcn/dist/*.{js,mjs}"` + `@custom-variant dark` + полный набор shadcn oklch-токенов + `@theme inline` (образец — `examples/chat/globals.css` json-render).

**Бюджет бандла**: T1 замеряет gzip основного чанка (весь `shadcnComponents` + Radix/Embla/Vaul/Lucide попадут в SPA). Порог внимания 600 KB gzip: превышение — зафиксировать число, решение (code-split реестра / урезанный registry) — отдельной задачей, лёгкий viewer не обещаем до замера.

## 7. Процесс выполнения (по CLAUDE.md)

1. ✅ Stage 0 — план в `docs/plans/`, коммит.
2. **Stage R** — адверсариальное ревью Codex (effort max из конфига). Раунд 1 пройден: 41 находка, триаж в §12, план обновлён до v2. **Раунд 2: повторное ревью v2** (диспатч `codex-companion task --background` из моего шелла — форвардер-subagent убивает раннер, проверено). Итерация до снятия блокеров.
3. **Stage E** — задачи T1–T7 через Codex (`--effort medium`, эскалация high/xhigh/max при затыке). Порядок и file ownership — §8. Я верифицирую done-criteria каждой задачи, коммичу поэтапно.
4. Финал — §9 + `/verify`.

## 8. Задачи (порядок пересобран после ревью: без параллельных конфликтов по файлам)

```
T1 → T2 → (T3 ∥ T5) → (T4 ∥ T6) → T7
```

| Задача | Владеет файлами (никто другой их не трогает) |
|---|---|
| T1 | scaffold: package.json (все deps и scripts сразу), конфиги, styles/, catalog/{definitions,hotspot,actions,catalog,runtime,events}, smoke/, app/ каркас |
| T2 | prototype/*, scripts/validate-prototypes.ts, prototypes/hello-world.json, docs/prototype-format.md |
| T3 | player/*, app/routes.tsx (маршруты плеера) |
| T5 | .storybook/*, catalog/stories/*, catalog/fixtures.ts |
| T4 | prototypes/checkout.json, prototypes/settings.json (+ списки фикстур в тестах) |
| T6 | gallery/, library/, app/Layout, vite proxy, build-склейка |
| T7 | e2e/, scripts/check-storybook-drift.ts, .github/, README |

**T1 — Скаффолд + вертикальный spike рендера** (фундамент).
Все зависимости из §6 сразу (дальше package.json заморожен; скрипты storybook/build-storybook тоже добавляются в T1); Tailwind-настройка; `src/catalog/` целиком: definitions+нормализация, Hotspot (`<button>` с ariaLabel), `actionDefinitions`, `createPlayerRuntime` (typed actions → и в `defineRegistry({components, actions})`, и в handlers — иначе typecheck не пройдёт); `/debug` через **полный `JSONUIProvider`**: Card + Heading + Input `$bindState` + Switch + элемент с `visible`-условием + Button `on.press → setState` + `$template`-текст + Hotspot с локальным custom action (alert). `check-css.mjs` по Vite-манифесту. Vitest+RTL: Button рендерится и клик зовёт spy; элемент с `visible` скрывается/показывается по стейту. Замер gzip бандла.
✅ typecheck+lint+test+build+check:css зелёные; `/debug` стилизован, петля emit→action→state→re-render и `visible` работают; размер бандла зафиксирован в отчёте задачи. Исполнителю: **читать `node_modules/@json-render/react/dist/index.d.ts`, не гадать API**.

**T2 — Формат v1: грамматика + семантический валидатор + доки** (после T1).
Две части: (a) zod-грамматика PrototypeDoc (§5, strictObject, superRefine); (b) семантический валидатор §5.1–5.7 по нормализованным definitions. `hello-world.json`; CLI-скрипт (per-file отчёт, exit 1, проверка id===basename); `docs/prototype-format.md` (поля, allowlist/запреты, контракт действий и событий-без-payload, правила `$bindState`-персистентности, чеклист автора). Vitest: позитив — фикстуры **всех 37** компонентов проходят + минимальный `{props:{}}` для контейнеров; негативы — цикл/не-дерево, неизвестные type/prop/событие/действие, битые params, navigate в никуда, `spec.state`, `watch`, `repeat`, служебный statePath, `javascript:`-URL, Hotspot без canvas.
✅ npm test зелёный; validate:prototypes exit 0 на hello-world (и падает на битых фикстурах в тестах).

**T3 — Плеер** (после T2; ∥ T5).
`JSONUIProvider key=${doc.id}:${restartNonce}`; `navigation.ts` (sessionNonce/flowDepth/guards/stale-записи); ScreenView с ErrorBoundary; DeviceFrame; ScreensSidebar; 404. **RTL-интеграционные тесты сразу здесь** (не ждать T7): bound input заполняется → смена спека под тем же провайдером → возврат → значение живо (identity store); restart-bump → чистый store; смена `/p/a → /p/b` → чистый store; back при flowDepth 0 — no-op; битый runtime-prop → ErrorBoundary с Restart. Unit-тесты navigation.ts.
✅ typecheck+test+build зелёные; ручной прогон hello-world по чеклисту задачи.

**T5 — Storybook 10.4.6 как витрина каталога** (после T2; ∥ T3).
`.storybook/main.ts` + `preview.tsx` (index.css, декоратор JSONUIProvider + SB `action()` логирование); `fixtures.ts`: `example ?? fixtureOverrides` — **равенство** ключей fixtures == definitions тестом; кураторские стории (Button, Input+$bindState, Card, Tabs, Dialog, Select, Table, Alert, Hotspot) + генерируемая галерея по фикстурам; список ожидаемых story-id экспортируется для drift-скрипта.
✅ `storybook --smoke-test` и `storybook build -o dist/storybook` зелёные; ожидаемые story-id присутствуют в `dist/storybook/index.json`; npm test зелёный.

**T4 — Сэмплы** (после T3; ∥ T6). `checkout.json` (5 экранов, mobile: каталог → товар с Hotspot+canvas → корзина: счётчик `$state`, `visible` empty-state, `$template` → форма `$bindState` Input/Select/Radio, без валидации → успех: restart) и `settings.json` (desktop: Tabs, Switch→setState→`visible`, Dialog, openUrl, back). Только JSON + списки фикстур.
✅ validate:prototypes зелёный на 3 файла; «все прототипы валидны» и reachability зелёные.

**T6 — Галерея + Library + склейка** (после T3+T5). GalleryPage; LibraryPage (дерево index.json, iframe, «открыть в Storybook», graceful empty-state); `"build": "vite build && storybook build -o dist/storybook"`; drift-скрипт принимает `--index dist/storybook/index.json`.
✅ build зелёный, `dist/storybook/index.json` есть; /library работает с живым SB и деградирует без него.

**T7 — E2E + CI + README** (после T4+T6).
Playwright: **два webServer** (vite + storybook), `playwright install --with-deps chromium` в CI; сценарии: чекаут-флоу (CTA → URL/экран → Back → форма переживает навигацию → Restart сбрасывает и стирает stale-историю) + Library smoke (SB жив) + Library graceful (по флагу без SB — отдельный проект конфига); `check-storybook-drift.ts`; ci.yml (typecheck, lint, test, validate:prototypes, build, check:css, drift, e2e); README; `npm run verify` — агрегат.
✅ e2e зелёный локально; `npm run verify` зелёный; CI ссылается только на существующее.

## 9. Верификация (финальная)

`npm run verify` (tsc, eslint, vitest, validate:prototypes, vite build, storybook build, check-css по манифесту, drift) + `npx playwright test`.

Ручной клик-скрипт: (1) dev+storybook; (2) `/debug` — стили, клик мутирует текст, `visible` реагирует; (3) `/` — 3 карточки; (4) checkout: мобильная рамка; (5) Hotspot (Tab-фокусируемый!) → экран товара; (6) «в корзину» → бейдж из стейта; (7) форма переживает Back/Forward; (8) Restart → чистый старт, Back не возвращает в старую сессию; (9) `/p/checkout → /p/settings` без захода в галерею → чистый стейт; (10) `/library` — дерево + iframe-превью; убить SB → инструкция, не краш.

## 10. Риски

1. **Tailwind @source из dist** → guard `check-css.mjs` (по манифесту app-чанка) + визуальный критерий T1 до всей остальной работы.
2. **0.x API** → exact-pin; T1-spike доказывает JSONUIProvider/defineRegistry/actions до зависимых задач; импорты json-render только через `src/catalog/` и `src/player/`; исполнители читают `.d.ts`.
3. **Стейт/restart-механика** → RTL-тесты в T3 (не в T7), e2e в T7; fallback — свой `createStateStore`.
4. **SB 10.4 ESM + общий vite-конфиг** → preview на нашем Renderer, `--smoke-test` в критериях, `viteFinal` как escape-hatch.
5. **Library ↔ index.json** → прокси в dev, статика в prod, защитный парсинг, graceful degradation.
6. **Валидатор vs динамические props** → нормализация схем + discriminated-грамматика `$`-значений, позитив/негатив тесты в T2.
7. **Бандл 36 компонентов** → замер в T1, порог 600 KB gzip, решение отдельной задачей.
8. **Небезопасные URL в прототипах** (в т.ч. будущая AI-генерация) → политика §5.7 + базовый CSP в index.html.

## 11. Вне скоупа MVP (backlog)

Редактор; конструктор из палитры (fixtures+definitions уже дают палитру); AI-генерация (`createSpecStreamCompiler` + AI SDK); `submitForm` (атомарный validate→navigate) и включение `validateForm`; `repeat`/`watch` (с анализом зависимостей и лимитом диспатчей); `$computed` с реестром функций; code-split реестра при превышении бюджета; adapter-интерфейс внешних ДС + contract-suite; подсветка кликабельных зон по «мёртвому клику»; шаринг/деплой.

## 12. Триаж ревью, раунд 1 (41 находка)

**Принято — блокеры**: SB → exact 10.4.6; провайдеры → `JSONUIProvider` целиком; `defineRegistry` + actions → `createPlayerRuntime`; props-валидация → нормализация nullable→optional + запрет неизвестных ключей.
**Принято — major/minor** (в тексте v2): react 19.2.7 floor; прямые @types/react*; per-package peer matrix; checkOrphans; события без payload + генерируемая матрица; резерв push/pop и служебных путей; строгий allowlist v1 (запрет repeat/watch/$computed/confirm/…); actionDefinitions со схемами params; static literal у navigate; sessionNonce/flowDepth-навигация и restart-семантика; session-only стейт; key=doc.id:nonce; стабильные handlers; RTL-тесты стейта в T3; fixtures = example ?? overrides + равенство ключей; drift definitions↔fixtures + story-id list; канонический dist/storybook; CSS-check по манифесту; переупорядочение задач + file ownership; 2×webServer + playwright install; полный allowlist-контракт формата; цикл/дерево/лимиты; slug==basename; спецификация Hotspot (canvas, координаты, `<button>`, ariaLabel); переформулировка «источник истины — каталог, Storybook — витрина»; ErrorBoundary на экран; бюджет бандла; URL-политика + CSP.
**Отклонено/скорректировано (с обоснованием)**:
- *#16 warning про unbound-интерактивные компоненты*: шумно для валидатора — оставлено как правило в доке автора.
- *#36 submitForm*: не реализуем в v1 — вместо этого `validateForm` запрещён, формы в сэмплах без валидации, `submitForm` в backlog. Честный scope cut вместо полуработающего контракта.
- *#2 downgrade на router v7*: остаёмся на 8.2 с корректным пином react 19.2.7 — установка воспроизводима, v7-миграция ничего не даёт.
- *#20 split T2 на две задачи*: оставлена одна задача с двумя явными частями (грамматика/семантика) и расширенными критериями; при затыке — второй codex-запуск по части (b).
