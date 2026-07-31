# Typed authoring SDK (`sdk/`)

Типизированный SDK для сборки документов прототипа в TypeScript вместо ручных JSON-трансформаций
(план `docs/plans/2026-07-27-product-improvements-v2.md` §7.3, фидбэк §12).

Две части:

1. **Генерируемые типы каталога** — `sdk/catalog.<designSystem>.d.ts`, собираются из
   `GET /api/catalog/manifest?designSystem=…` скриптом `scripts/generate-sdk.ts`.
2. **Рукописные билдеры** — `sdk/builders.ts`: элементы, регионы, экраны и документ в плоской
   форме `{root, elements}` из `src/prototype/schema.ts`, с валидацией `inputPrototypeDocSchema`
   **до** отправки в API.

## Генерация типов

```bash
# из живого API (auth — те же переменные, что и у остальных скриптов: scripts/easyui-auth.mjs)
EASYUI_USERNAME=admin EASYUI_PASSWORD=… \
  npm run generate:sdk -- --design-system yandex-pay --api http://127.0.0.1:8787/api

# из офлайн-снапшота (так работает drift-проверка и тесты)
npm run generate:sdk -- --design-system sdk-demo --from sdk/fixtures/catalog.sdk-demo.json

# сохранить снапшот каталога рядом с типами (диффабельный JSON)
npm run generate:sdk -- --design-system yandex-pay --snapshot-out sdk/fixtures/catalog.yandex-pay.json
```

Флаги: `--design-system <id>` (обязателен), `--api <base>` (по умолчанию `EASYUI_API` или
`http://127.0.0.1:8787/api`), `--from <snapshot.json>`, `--out <file.d.ts>`, `--snapshot-out <file.json>`.

Вывод детерминирован: компоненты и свойства сортируются по имени, поэтому повторный запуск на
неизменённом манифесте — no-op.

### Discovery summary: фаза reuse-гейта

В живом режиме генератор дополнительно читает `GET /api/capabilities` → `reuseGate` и печатает
строку вида:

```
Reuse gate: enforce · intent required for new components · policy v1
```

Та же строка попадает **в шапку** `sdk/catalog.<ds>.d.ts` и в снапшот (`--snapshot-out`), если он
сохраняется из живого API:

```ts
// Reuse gate: enforce · intent required for new components · policy v1 (GET /api/capabilities)
```

Смысл для авторинга: `intentRequired` истинно ровно в фазе `enforce`, и тогда `POST /api/components`
без `intent` отвечает `400 invalid_request`. Клиент, который умеет обе фазы, шлёт `intent` всегда —
политика и разбор `409` описаны в `docs/agent-authoring-policy.md`, контракт полей — в
`docs/server-api.md`. `policyVersion` — версия политики матчинга, та же, что в ответах
`/api/catalog/candidates` и в записях аудита.

Офлайн-режим (`--from snapshot.json`) capabilities не выдумывает: снапшот без поля `reuseGate`
даёт типы без этой строки, а генератор печатает `Reuse gate: unknown (…)`. Поэтому drift-проверка
остаётся детерминированной и не требует сервера. Недоступное или не отдающее `reuseGate` API
тоже не роняет генерацию — строка просто не появляется.

Что попадает в `catalog.<ds>.d.ts` на каждый компонент:

| Тип | Источник в манифесте |
|---|---|
| `<Name>Props` (каждый проп обёрнут в `Authored<T>` — литерал или директива `$state`/`$bindState`/…) | `propsJsonSchema` |
| `<Name>Slots` — union имён слотов или `never` | `slots` |
| `<Name>Events` — union имён событий или `never` | `events` |
| `<Name>EventPayloads` — типы payload'ов | `eventPayloads` |
| `CatalogComponents[Name]` — `id`, `version`, `atomicLevel`, `namedSlots`, `typedEvents`, `scope`, `canonicalFor` | манифест; `scope`/`canonicalFor` читаются защитно (сервер их пока не отдаёт → `undefined`/`never`) |

Плюс агрегаты: `ComponentName`, `PropsOf<N>`, `SlotsOf<N>`, `EventsOf<N>`, `EventPayloadsOf<N>`.

## Билдеры

```ts
import { createAuthoring } from "../sdk";
import type { CatalogComponents } from "../sdk/catalog.yandex-pay";

const { component, screen, doc, host, actions } = createAuthoring<CatalogComponents>();

const success = screen({
  id: "success",
  name: "Успех",
  root: screen.flowRoot({
    statusBar: component("YpStatusBar", { time: "15:07" }),
    header: component("YpPayboxNavBar", { title: "Оплата" }),
    content: component("YpBox", { direction: "column" }, { children: [/* … */] }),
    footer: component("YpCpqrActionFooter", { label: "Готово" }, { on: { press: actions.navigate("start") } }),
    overlays: [host.overlay({ placement: "bottom" }, { children: [/* … */] })],
  }),
});

const document = doc({
  id: "payment-success",
  name: "Payment success",
  designSystem: "yandex-pay",
  device: "mobile",
  state: {},
  screens: [success],
});
```

- `component(name, props, options?)` — `options`: `key`, `children`, `on`, `repeat`, `region`,
  `slot`, `visible`. `on` сужен до событий компонента (компонент без событий не принимает ни одного
  обработчика).
- `screen.flowRoot({statusBar, header, content, footer, overlays})` — корень `@eui/FlowRoot`,
  region-маркеры проставляются автоматически; `content` — узел или массив узлов.
- `host.image/hotspot/overlay/flowRoot` — host-примитивы (их определения живут в runtime, а не в
  каталоге).
- `actions.navigate/back/restart/openUrl/setState/pushState/removeState` — конструкторы действий из
  `src/catalog/actions.ts`.
- Ключи элементов детерминированы: явные ключи резервируются первыми, остальные генерируются как
  camelCase имени типа с суффиксом `-2`, `-3` при коллизии (`$` в авторских ключах запрещён — этот
  символ зарезервирован под ключи композиций).
- `doc()` подставляет `version: 1`, `state: {}` и `startScreen` = id первого экрана, затем валидирует
  документ `inputPrototypeDocSchema` и бросает `SdkValidationError` со списком zod-issue
  (`/screens/0/spec/root: …`). `validateDoc(value)` — та же проверка для готового документа.
- `createAuthoring<C>({ knownComponents })` дополнительно отвергает неизвестные имена компонентов в
  рантайме (передайте имена из снапшота каталога).

## Проверки

```bash
npm run verify:sdk   # tsc -p sdk/tsconfig.json + drift-проверка + vitest-тесты sdk/
```

- `scripts/check-sdk-drift.ts` сравнивает закоммиченный `sdk/catalog.sdk-demo.d.ts` с тем, что
  генератор даёт из `sdk/fixtures/catalog.sdk-demo.json` — сервер не нужен.
- Тесты `sdk/*.test.ts` запускаются собственным конфигом `sdk/vitest.config.ts` (корневой vitest
  включает только `src/**/*.test.{ts,tsx}` в jsdom).
- `sdk/tsconfig.json` — отдельный проект (корневой `tsconfig.json` не включает `sdk/`), он же даёт
  типизированный ESLint для директории.
