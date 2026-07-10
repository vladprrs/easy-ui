# easy-ui — просмотрщик кликабельных прототипов поверх Storybook + json-render (MVP)

**Версия плана: v3.** Раунд 1 ревью: 41 находка (4 blocker — устранены). Раунд 2: **«блокеров нет, можно приступать к Stage E»** + 8 major-уточнений исполнительного контракта — все приняты и внесены (§12).

## 1. Контекст

Продукт: веб-UI поверх [vercel-labs/json-render](https://github.com/vercel-labs/json-render) для просмотра **кликабельных прототипов** — многоэкранных флоу из живых React-компонентов дизайн-системы. Клик по компоненту/хотспоту переключает экраны (как в Figma), но компоненты настоящие: инпуты, hover, условная видимость, общий стейт флоу.

**Источник истины MVP — каталог/registry json-render** (`shadcnComponentDefinitions` + `shadcnComponents` + наши расширения). Storybook — **витрина и браузер** этого каталога (не хранилище): стории документируют компоненты, страница Library даёт обзор ДС внутри продукта. Подключение реальной внешней ДС — через adapter-интерфейс (roadmap, §11).

MVP = просмотрщик: галерея + плеер + Library. Вне скоупа (архитектура не должна блокировать): редактор, drag-and-drop конструктор, AI-генерация.

Репозиторий: `easy-ui` (github.com/vladprrs/easy-ui). Окружение: Node 24.18, **npm** (`npm ci` + committed `package-lock.json` — воспроизводимость), codex-cli 0.144.1 (`gpt-5.6-sol`, effort `max` в конфиге).

## 2. Зафиксированные решения (согласованы с пользователем)

| Решение | Выбор |
|---|---|
| Рендеринг | Нативно из кода: registry json-render, реальная интерактивность, навигация через actions |
| ДС для MVP | `@json-render/shadcn` (36 компонентов) + наш `Hotspot` |
| Стек | Vite SPA (React + TS), без бэкенда; прототипы — JSON в репо |
| Storybook | Витрина каталога: стории через наш Renderer; Library читает `index.json` и встраивает стории `iframe.html?id=…` |

## 3. Проверенные факты о json-render (по исходникам; ссылки в отчётах ревью)

- Пакеты `@json-render/*` = **0.19.0**, кросс-пин exact; обновление только связкой. Apache-2.0.
- Peer deps: эффективно React ≥19.2.3, zod 4, Tailwind 4. **Фактический floor React задаёт react-router 8.2: `react >=19.2.7`.**
- `@json-render/shadcn` не несёт CSS → Tailwind v4 в хосте: `@source` на dist пакета + shadcn oklch-токены + `@theme inline` + `tw-animate-css`.
- **`Renderer` требует visibility context; обвязка — `JSONUIProvider` целиком** (State → Visibility → Validation → Action + Functions + confirmation). Не собирать стек вручную.
- **`defineRegistry` требует implementations для custom actions каталога**; встроенные (`setState`/`pushState`/`removeState`/`validateForm`) уже в React schema — им implementations не нужны. `defineRegistry().handlers` — фабрика, не готовый объект: wiring выбрать явно (§4).
- События **не несут payload**: значение читается из `$bindState`. `Link.press` предотвращает browser-переход только при `preventDefault: true`. Матрица событий генерируется из `definitions[*].events`.
- `validateSpec(spec, {checkOrphans:true})` — только структура → наш семантический валидатор (§5).
- **Props в shadcn definitions — required-but-nullable** → валидатор работает по **рекурсивно нормализованным** схемам (nullable → optional+nullable на всех уровнях, без мутации исходных схем, required non-nullable сохраняются) + запрет неизвестных ключей и во вложенных объектах.
- `example` есть лишь у ~12 из 36 definitions → фикстуры = `example ?? fixtureOverrides[name]` (владение — T5), равенство ключей fixtures == definitions тестом.
- `ActionProvider` фиксирует handlers при монтировании; внутренние `push`/`pop` и пути `/currentScreen`, `/navStack` зарезервированы (запрещены в v1).
- `StateProvider` uncontrolled: store создаётся один раз → remount по `key`.
- Storybook: **стабильная линия 10.4.6** (10.5 — только prerelease) → pin exact. Vite 7.3.6 совместим, Node 24 ок.
- `@json-render/devtools-react` — dev-only lazy.

## 4. Архитектура

```
/ (npm, "type": "module")
  .storybook/               # main.ts (react-vite 10.4.6), preview.tsx (index.css + декоратор JSONUIProvider)
  .github/workflows/ci.yml
  prototypes/               # hello-world.json (T2), checkout.json + settings.json (T4)
  src/
    styles/index.css        # ⚠ tailwind + @source shadcn dist + токены shadcn + tw-animate-css
    catalog/
      definitions.ts        #   { ...shadcnComponentDefinitions, Hotspot } + normalizeDefinitions (рекурсивно, без мутации)
      hotspot.tsx           #   Hotspot: def (props x,y,width,height,ariaLabel — только статические; events:["press"]) + impl <button>
      actions.ts            #   customCatalogActions {navigate,back,openUrl,restart} + prototypeActionSchemas (+setState/pushState/removeState) для валидатора
      catalog.ts            #   defineCatalog(schema, { components, actions: customCatalogActions })
      runtime.ts            #   createPlayerRuntime(deps): implementations ТОЛЬКО custom actions; wiring через фабрику defineRegistry (иначе — stable handlers в JSONUIProvider; выбрать один вариант и назвать разными именами)
      fixtures.ts           #   (T5) example ?? fixtureOverrides — валидный спек на КАЖДЫЙ из 37
      events.ts             #   матрица событий из definitions
      stories/              #   *.stories.tsx через Renderer
    prototype/
      schema.ts             #   zod v4 «грамматика» PrototypeDoc (env-agnostic)
      validate.ts           #   validateSpec(core) + семантический валидатор + графовые проверки
      loader.ts             #   import.meta.glob → валидированные документы
      types.ts
    player/
      PlayerShell.tsx       #   /p/:protoId: JSONUIProvider key=`${doc.id}:${sessionNonce}` initialState={doc.state} + gate + <Outlet/>
      ScreenView.tsx        #   ErrorBoundary(диагностика+Restart) → canvas-бокс + overlay-слой хотспотов (одна система координат)
      navigation.ts         #   ЕДИНЫЙ nav-API: sessionNonce/flowDepth в location.state; back-guard; same-screen no-op; stale-gate
      DeviceFrame.tsx       #   mobile 390×844 / tablet 834×1112 / desktop; масштаб контента+overlay одним transform
      ScreensSidebar.tsx
    library/                #   LibraryPage (дерево index.json + iframe) + storybookIndex.ts (защитный парсинг)
    gallery/GalleryPage.tsx
    app/                    #   main.tsx, routes.tsx (react-router 8.2), Layout; базовый CSP в index.html (согласован с Image.src-политикой)
    smoke/SmokeSpec.tsx     #   /debug (T1)
  scripts/
    validate-prototypes.ts  # tsx: все prototypes/*.json + doc.id===basename; exit 1 при ошибке
    check-storybook-drift.ts# (T5) --index <path>: ожидаемые story-id присутствуют в index.json
    check-css.mjs           # по Vite-манифесту app-чанка: sentinel-классы shadcn
  e2e/smoke.spec.ts, playwright.config.ts   # webServer: [vite dev, storybook dev]; отдельный проект для built preview
  docs/plans/…  docs/prototype-format.md
```

Маршруты: `/` → `/p/:protoId` (redirect на startScreen) → `/p/:protoId/s/:screenId`; `/library`; `/debug`.

Механики плеера:
- **Сессия — один nonce**: `sessionNonce` атомарно и в `key={doc.id}:{sessionNonce}` у `JSONUIProvider`, и в `location.state` каждой записи. `initialState={doc.state}` — явно. Restart = новый nonce + replace на startScreen.
- **Stale-история**: физически стереть browser history нельзя — контракт: «stale-экран никогда не отображается». До проверки nonce рендерится gate (не старый ScreenView — без flash); запись с чужим nonce при посещении замещается стартовым экраном текущей сессии.
- **Все переходы через один navigation API** (`navigation.ts`): actions, sidebar, redirect стартового route, Gallery — иначе разъедутся flowDepth/sessionNonce. `back` — no-op при `flowDepth === 0`; `navigate` на текущий экран — no-op.
- **Стейт**: переживает навигацию **только для `$bindState`-props** (контракт в доке). Reload/deep-link = свежий стейт (session-only); deep link на любой экран валиден.
- **Canvas/Hotspot**: экран с `canvas` рендерится боксом фиксированного размера; хотспоты — в отдельном overlay-слое, absolute в той же системе координат (positioned ancestor между ними исключён по построению); DeviceFrame масштабирует контент и overlay одним transform. Координаты только статические.
- **Ошибки**: ErrorBoundary на каждый ScreenView (диагностика + Restart).
- **Storybook**: dev — Vite proxy `/storybook` → `:6006`; prod — `dist/storybook` (канонический путь).

## 5. Формат прототипа v1 — замкнутая грамматика

```jsonc
{
  "version": 1,
  "id": "checkout",                    // slug == basename файла (проверяется)
  "name": "Checkout Flow",
  "description": "…",
  "device": "mobile",                  // mobile | tablet | desktop (default desktop)
  "startScreen": "cart",
  "state": { "cart": { "items": 2 } }, // ЕДИНСТВЕННЫЙ источник initial state
  "screens": [
    { "id": "cart", "name": "Корзина",
      "canvas": { "width": 390, "height": 844 },   // обязателен при использовании Hotspot
      "spec": { "root": "main", "elements": { … } } }
  ]
}
```

**Разрешено в v1** (всё прочее отвергается схемой/валидатором):
- Поля элемента: `type`, `props`, `children`, `visible`, `on`.
- Динамические значения props: `$state`, `$bindState`, `$template`, `$cond`. **Замкнутый набор операторов условий**: `eq`, `neq`, `gt`, `gte`, `lt`, `lte` (бинарные: путь+literal), `not` (унарный флаг), `$and`, `$or` (массивы условий), truthiness (голый `$state`). Неизвестный оператор — ошибка.
- События: значение — action или массив actions; **максимум одно terminal-действие (`navigate`/`back`/`restart`/`openUrl`) на событие, всегда последним**; имена событий ⊆ `definitions[type].events`.
- **Params действий — только статические literals** (динамические значения в params запрещены). `navigate.params.screenId` — статический slug.
- **URL-несущие props (`openUrl.url`, `Image.src`, `Link.href`) — только статические literals**: `https:`/`http:` или относительный путь (`/…`) для `Image.src`; `javascript:`/`data:` и динамика — ошибка. `Link` с navigation-action обязан иметь `preventDefault: true` (проверяет валидатор).

**Запрещено в v1** (зарезервировано): `repeat`, `watch`, `$computed`, `$item`, `$index`, `$bindItem`, `confirm`, `onSuccess/onError`, `spec.state`/`screen.state`, действия `validateForm`/`push`/`pop`, state-пути `/currentScreen`, `/navStack`, `/_viewer`. Формы v1 — без валидации (`submitForm` — backlog §11).

**Контракт действий** — `prototypeActionSchemas` (zod params на каждое; custom подмножество `customCatalogActions` идёт в каталог и registry):

| action | params | поведение | тип |
|---|---|---|---|
| `navigate` | `{ screenId: static slug }` | push через nav-API (+flowDepth, sessionNonce); same-screen no-op | terminal, custom |
| `back` | `{}` | no-op при flowDepth 0 | terminal, custom |
| `openUrl` | `{ url: static https }` | всегда `window.open(url, "_blank", "noopener,noreferrer")` | terminal, custom |
| `restart` | `{}` | новый sessionNonce + replace на startScreen; stale-контракт §4 | terminal, custom |
| `setState`/`pushState`/`removeState` | схемы core; `statePath` — абс. RFC 6901, не служебный | встроенные, implementations не нужны | non-terminal, built-in |

**Семантический валидатор** (`validate.ts`), после zod-грамматики и `validateSpec(spec,{checkOrphans:true})`:
1. `type` ∈ definitions; неизвестные ключи props — ошибка (и во вложенных объектах); required (после нормализации) присутствуют.
2. Статические значения — `safeParse` по нормализованной схеме; `$`-значения — замкнутая discriminated-грамматика (§5), тип-совместимость output — best-effort.
3. `on`: события ⊆ definitions; каждый action по `prototypeActionSchemas`; ≤1 terminal и он последний; цели `navigate` существуют; `Link`+navigation → `preventDefault:true`.
4. Граф: **дерево**, DFS-циклы, лимиты (≤500 элементов, глубина ≤50).
5. State-пути: RFC 6901, абсолютные; служебные — ошибка; `$state` вне `doc.state` — warning.
6. `Hotspot`: только статические координаты; требует `canvas`; `x+width ≤ canvas.width`, `y+height ≤ canvas.height`.
7. Документ: уникальность/slug id; `id === basename`; `startScreen` существует; reachability (warning); URL-политика.

## 6. Зависимости (точные)

deps: `@json-render/{core,react,shadcn}` **exact 0.19.0**; `react`/`react-dom` **^19.2.7**; `react-router` **^8.2.0**; `zod` **^4.3.6**.
devDeps: `@json-render/devtools-react` 0.19.0; `vite ^7.3.6`; `@vitejs/plugin-react ^5`; `@types/react ^19.2` + `@types/react-dom ^19.2`; `tailwindcss ^4.1` + `@tailwindcss/vite` + `tw-animate-css ^1.4`; `typescript ^5.9`; `storybook` + `@storybook/react-vite` + `@storybook/addon-docs` — **exact 10.4.6**; `vitest ^4.1` + `jsdom` + `@testing-library/react ^16`; `@playwright/test`; `tsx ^4.21`; `eslint ^9` + `typescript-eslint` + `eslint-plugin-react-hooks`. `engines.node >= 24`. Committed `package-lock.json`, CI через `npm ci`.

`src/styles/index.css`: `@import "tailwindcss"` + `@import "tw-animate-css"` + `@source "../../node_modules/@json-render/shadcn/dist/*.{js,mjs}"` + `@custom-variant dark` + shadcn oklch-токены + `@theme inline` (образец — `examples/chat/globals.css`).

**Бюджет бандла**: T1 замеряет gzip app-чанка; порог внимания 600 KB gzip; решение при превышении — отдельной задачей (code-split реестра).

## 7. Процесс выполнения (по CLAUDE.md)

1. ✅ Stage 0 — план в `docs/plans/`, коммит.
2. ✅ **Stage R**: раунд 1 — 41 находка, триаж → v2; раунд 2 — **«блокеров нет, можно приступать к Stage E»**, 8 major → v3 (§12). Диспатч Codex — `codex-companion task --background` из шелла оркестратора (форвардер-subagent убивает раннер).
3. **Stage E** — задачи через Codex `--effort medium` (+`--write`), эскалация high/xhigh/max. Порядок/ownership — §8. Оркестратор верифицирует done-criteria, коммитит поэтапно.
4. Финал — §9 + `/verify`.

## 8. Задачи

```
T1 → T2 → (T3 ∥ T5) → (T4 ∥ T6) → T7
```

Владение файлами и handoff (последовательная передача, а не вечная заморозка):
- T1 создаёт всё базовое; далее `package.json`+vite.config переходят: T5 (скрипты storybook уже заведены в T1) → **T6 (финальная склейка build, proxy)**; `app/routes.tsx`: T1 каркас → T3 маршруты плеера → T6 Layout/навигация.
- `fixtures.ts` + drift-скрипт — T5. Тест «все прототипы валидны» (T2) обходит `prototypes/*.json` **динамически** (glob) — T4 не трогает код вообще.

**T1 — Скаффолд + вертикальный spike** (фундамент).
Все deps §6; Tailwind; `catalog/` целиком: `normalizeDefinitions` (рекурсивно, без мутации исходных схем), Hotspot (`<button>`, ariaLabel), `actions.ts` (customCatalogActions отдельно от prototypeActionSchemas), `catalog.ts` (в каталог — только custom), `runtime.ts` (implementations только custom actions; wiring фабрики выбран и задокументирован в коде); `/debug` через полный `JSONUIProvider` c `initialState`: Card + Heading + Input `$bindState` + Switch + `visible`-элемент + Button `on.press → setState` + `$template` + Button с **custom `navigate`** (заглушка-роутер: пишет в на-странице лог) + Hotspot с custom `restart`-заглушкой. `check-css.mjs`. Vitest+RTL: клик Button зовёт spy custom action; `visible` реагирует на стейт; **нормализация**: omitted nullable (верхний и вложенный уровни) проходит, `null` проходит, required non-nullable без значения — падает, unknown key (вложенный) — падает, исходные definitions не мутированы. Замер gzip.
✅ `typecheck+lint+test+build:app+check:css` зелёные; `/debug` стилизован; петля emit→custom action и emit→setState→re-render доказаны; отчёт с размером бандла. Исполнителю: **читать `node_modules/@json-render/react/dist/index.d.ts` и `@json-render/core` типы, не гадать**.

**T2 — Формат v1: грамматика + семантический валидатор + доки** (после T1).
(a) zod-грамматика (§5, strictObject, superRefine); (b) семантический валидатор §5.1–5.7. `hello-world.json`; CLI (per-file отчёт, exit 1, id===basename); `docs/prototype-format.md` (поля, замкнутая грамматика операторов, terminal-правило, контракт `$bindState`-персистентности и событий-без-payload, URL-политика, чеклист). Vitest: позитив — representative-фикстуры валидатора (не все 37 — это T5) + `{props:{}}` контейнеров; негативы — цикл/не-дерево, неизвестный type/prop(вложенный)/событие/действие/оператор, битые params, динамика в params, два terminal-действия, navigate в никуда, `spec.state`, `watch`, `repeat`, служебный statePath, `javascript:`-URL, динамический URL, `Link`+navigation без preventDefault, Hotspot без canvas / вне границ. Тест «все prototypes/*.json валидны» — динамический glob.
✅ npm test зелёный; validate:prototypes exit 0 на hello-world.

**T3 — Плеер** (после T2; ∥ T5).
`JSONUIProvider key=${doc.id}:${sessionNonce} initialState={doc.state}`; `navigation.ts` — единственный nav-API (actions, sidebar, redirect, gallery-переход); gate до проверки nonce (без flash старого экрана); ScreenView: canvas-бокс + overlay-слой Hotspot, ErrorBoundary; DeviceFrame (transform на контент+overlay вместе); ScreensSidebar; 404. RTL-тесты: bound input → смена спека → возврат → значение живо; новый nonce → чистый store; `/p/a → /p/b` → чистый store; back при flowDepth 0 — no-op; same-screen navigate — no-op; stale-запись → замещение стартовым без рендера старого экрана; битый runtime-prop → ErrorBoundary. Unit navigation.ts.
✅ typecheck+test+build:app зелёные; ручной прогон hello-world.

**T5 — Storybook 10.4.6 витрина** (после T2; ∥ T3).
`.storybook/` (main.ts, preview.tsx: index.css + декоратор JSONUIProvider + SB `action()`); `fixtures.ts`: `example ?? fixtureOverrides`, тест равенства ключей fixtures == definitions (все 37) **и рендер каждой фикстуры через Renderer без исключений**; кураторские стории (Button, Input+$bindState, Card, Tabs, Dialog, Select, Table, Alert, Hotspot) + генерируемая галерея; `check-storybook-drift.ts` (--index) + экспорт ожидаемых story-id.
✅ `storybook --smoke-test`, `storybook build -o dist/storybook` зелёные; drift-скрипт зелёный по `dist/storybook/index.json`; npm test зелёный.

**T4 — Сэмплы** (после T3; ∥ T6). Чистый JSON: `checkout.json` (5 экранов, mobile: каталог → товар Hotspot+canvas → корзина `$state`/`visible`/`$template` → форма `$bindState` → успех: restart) и `settings.json` (desktop: Tabs, **Switch через `$bindState` + `visible`** (не setState-от-change), Dialog, openUrl, back).
✅ validate:prototypes зелёный на 3 файла; динамический тест валидности и reachability зелёные.

**T6 — Галерея + Library + склейка** (после T3+T5). GalleryPage (переход через nav-API); LibraryPage (дерево index.json, iframe, «открыть в Storybook», graceful empty-state); Layout/шапка; vite proxy `/storybook`; `"build": "vite build && storybook build -o dist/storybook"`; SPA fallback для preview (`vite preview` отдаёт deep links).
✅ typecheck+test+`build` (полный) зелёные, `dist/storybook/index.json` есть; /library живой SB + graceful без SB; `vite preview` открывает `/p/hello-world/s/…` напрямую.

**T7 — E2E + CI + README** (после T4+T6).
Playwright: dev-проект (**два webServer**: vite+storybook) — чекаут-флоу (CTA → URL/экран → Back → форма живa → Restart → **многократный Back не показывает старые экраны**), settings-флоу (Tabs/Dialog/back), Library smoke; отдельный проект **preview** (built dist): прямой заход `/p/checkout/s/<mid-screen>` работает; Library graceful без SB. CI: `npm ci`, `playwright install --with-deps chromium`, typecheck, lint, test, validate:prototypes, build, check:css, drift, e2e. README-runbook; `npm run verify` — агрегат.
✅ e2e зелёный локально; `npm run verify` зелёный; CI ссылается только на существующее.

## 9. Верификация (финальная)

`npm run verify` (tsc, eslint, vitest — включая рендер всех 37 фикстур, validate:prototypes, полный build, check-css, drift) + `npx playwright test` (dev + preview проекты).

Ручной клик-скрипт: (1) dev+storybook; (2) `/debug`; (3) `/` — 3 карточки; (4) checkout: мобильная рамка; (5) Hotspot (Tab-фокусируемый) → товар; (6) «в корзину» → бейдж; (7) форма живёт через Back/Forward; (8) Restart → чистый старт, многократный Back не возвращает старую сессию; (9) `/p/checkout → /p/settings` → чистый стейт; (10) `/library` + убитый SB → graceful; (11) `vite preview` → deep link на середину флоу.

## 10. Риски

1. **Tailwind @source из dist** → check-css по манифесту + визуальный критерий T1 до остальной работы.
2. **0.x API** → exact-pin; T1-spike доказывает провайдеры/registry/actions; импорты только через `src/catalog/` и `src/player/`; читать `.d.ts`.
3. **Стейт/сессии/stale-история** → RTL в T3, e2e в T7; fallback — свой `createStateStore`.
4. **SB 10.4 + общий vite-конфиг** → preview на нашем Renderer, `--smoke-test`, `viteFinal` escape-hatch.
5. **Library ↔ index.json** → прокси/статика, защитный парсинг, graceful.
6. **Валидатор vs динамика** → рекурсивная нормализация + замкнутая грамматика, негативы в T2.
7. **Бандл** → замер T1, порог 600 KB gzip.
8. **URL/безопасность** → статические literals, политика §5, CSP согласован с Image.src.

## 11. Вне скоупа MVP (backlog)

Редактор; конструктор из палитры; AI-генерация; `submitForm`/`validateForm`; `repeat`/`watch`; `$computed`; динамические params/URL с runtime-sanitizer; code-split реестра; adapter внешних ДС + contract-suite; подсветка кликабельных зон; шаринг/деплой.

## 12. Триаж ревью

**Раунд 1 (41):** блокеры → SB exact 10.4.6, `JSONUIProvider` целиком, `createPlayerRuntime`+actions, нормализация props. Major/minor — приняты в v2 (список в истории git). Отклонены с обоснованием: warning про unbound-компоненты (→ дока), `submitForm` (scope cut), downgrade router 7 (пин react 19.2.7 достаточен), сплит T2.
**Раунд 2 (8 major, вердикт «блокеров нет»):** все приняты в v3 —
1. Разделение custom/built-in actions: `customCatalogActions` vs `prototypeActionSchemas`; implementations только custom; wiring фабрики выбирается явно; T1 доказывает custom navigate/restart.
2. Нормализация: рекурсивность, без мутации, сохранение required non-nullable, вложенные unknown keys — тесты в T1.
3. Один `sessionNonce` (key + location.state), явный `initialState={doc.state}`, единый nav-API, gate до рендера.
4. Restart-контракт переопределён: «stale никогда не отображается» (замена при посещении), gate против flash, e2e многократным Back — вместо невозможного «стирания» истории.
5. Замкнутая грамматика: перечислены операторы; params только статические; ≤1 terminal-действия последним; Switch-пример через `$bindState`; негативы.
6. URL: только статические literals; `Link`+navigation требует `preventDefault`; `window.open(url,"_blank","noopener,noreferrer")` (3 аргумента); CSP согласован.
7. Canvas/Hotspot: статические координаты, canvas-бокс + overlay в одной системе координат, общий transform, bounds-тесты.
8. Ownership/handoff исправлены: 37 фикстур → T5; drift → T5; `build:app` в T1, полный `build` после T5 (T6); динамический glob-тест вместо hardcode-списков (T4 — чистый JSON); e2e рендерит все 37 фикстур, покрывает settings и built-preview deep links.
