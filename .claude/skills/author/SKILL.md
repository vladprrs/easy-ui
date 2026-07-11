---
name: author
description: Create and add components and prototypes in easy-ui — author a custom TSX component, publish it via the Bun API, build a prototype JSON flow from catalog + custom components, validate it, and screenshot it in the player.
---

# Authoring components & prototypes in easy-ui

Все пути — от корня репозитория. Три пути добавления, от частого к редкому:

1. **Прототип из встроенного каталога** → файл `prototypes/*.json` (сидится в БД) или POST в API.
2. **Кастомный компонент + прототип на нём** → только через Bun API (файловые прототипы кастомные типы не принимают — валидатор отвечает `unknown component type`).
3. **Новый встроенный компонент** → код в `src/catalog/` (путь Hotspot).

Спека формата: `docs/prototype-format.md` (строгий allowlist v1). Контракт компонента и все endpoints: `docs/server-api.md`. Харнес — `.claude/skills/author/driver.mjs` (create-or-update + publish + скриншоты).

## Запуск серверов

```bash
PATH="$HOME/.bun/bin:$PATH" DATA_DIR=.e2e-data/skill PORT=8787 ~/.bun/bin/bun server/main.ts   # API (фон)
npm run dev                                                                                     # vite :5173, proxy /api → :8787 (фон)
curl -s http://127.0.0.1:8787/api/health   # {"status":"ready"} — после миграций и seed из prototypes/*.json
```

`DATA_DIR` обязан лежать внутри корня проекта (материализованные TSX резолвят зависимости из корневого `node_modules`). `.e2e-data/` в gitignore — удобно для одноразовой БД. Реальный порт vite брать из лога, не из флагов (code-server их игнорирует).

Список встроенных компонентов (35 shadcn + `Hotspot`):

```bash
node -e "import('@json-render/shadcn/catalog').then(m=>console.log(Object.keys(m.shadcnComponentDefinitions).join(' ')))"
```

## Путь 1: прототип из встроенных компонентов

Написать `prototypes/<id>.json` по образцу `prototypes/hello-world.json` (`id` = имя файла без `.json`), затем:

```bash
npm run validate:prototypes
```

Сервер сидит файл в SQLite **один раз** (таблица `seed_log` по имени файла) — правки уже засеянного файла в существующую БД не попадут; либо новый `DATA_DIR`, либо PUT через API/драйвер. Для итераций без файла — сразу `driver.mjs prototype` (ниже).

## Путь 2: кастомный компонент + прототип (agent path, основной)

Контракт TSX-модуля: named export `definition` (`props` — Zod strict, `description` обязателен, `events?`/`slots?`/`example?`) + default plain function component, получающий `{props, emit}`. Рабочий пример: `.claude/skills/author/examples/rating-stars.tsx` (канонический — `server/fixtures/rating-stars.tsx`). Импортировать можно только `react`, `react-dom`, `react/jsx-runtime`, `zod`, `@json-render/react` (shim ABI v1); CSS-импорты и произвольные Tailwind-классы — нельзя, стилить inline/CSS-переменными темы.

```bash
node .claude/skills/author/driver.mjs component rating-stars RatingStars .claude/skills/author/examples/rating-stars.tsx
# saved rating-stars rev 1 / published rating-stars version 1
```

Драйвер сам делает create-or-update (CAS по `headRev`) и publish. Имя — уникальное `^[A-Z][A-Za-z0-9]*$`, не конфликтующее со встроенными, после создания неизменно. Save проверяет только синтаксис и контракт; **тип-ошибки ловит publish** (staging → failed), в ответе — вывод tsc:

```
publish failed (422): ... "Type check failed: ... error TS2339: Property 'missingProp' does not exist ..."
```

Прототип, использующий компонент (рабочий пример — `.claude/skills/author/examples/rating-demo.json`):

```bash
node .claude/skills/author/driver.mjs prototype .claude/skills/author/examples/rating-demo.json
# saved rating-demo rev 1
# component pins: [{"id":"rating-stars","name":"RatingStars","version":1,...}]
```

Пины фиксируются на момент save: последующий publish компонента не меняет уже сохранённый прототип — чтобы подтянуть новую версию, пересохранить прототип (повторный `driver.mjs prototype`).

### Посмотреть результат

```bash
node .claude/skills/author/driver.mjs shoot rating-demo
# .e2e-data/author-shots/rating-demo/rate.png
# .e2e-data/author-shots/rating-demo/done.png
```

Скриншотит каждый экран по deep-link `/p/<id>/s/<screen>` и **падает при ошибках консоли браузера** — валидный по схеме прототип всё ещё может не рендериться (см. Gotchas). Интерактив (клики, проверка state) — ad-hoc Playwright-скриптом по образцу скилла `/verify`: `import { chromium } from '/home/coder/project/node_modules/playwright/index.mjs'`.

## Путь 3: новый встроенный компонент (код)

По образцу Hotspot; точки подключения:

- `src/catalog/<name>.definition.ts` + `src/catalog/<name>.tsx` — definition (Zod strict props, `events`, `description`) и React-компонент.
- `src/catalog/definitions.ts` — добавить в `sourceComponentDefinitions`.
- `src/catalog/runtime.ts` — добавить в `builtinComponents` (`createPlayerRuntime`).
- `src/catalog/fixtures.ts` — пример props в `fixtureOverrides` (или `example` в definition); story в `src/catalog/stories/` и, если она в `expectedStoryIds`, её проверяет `scripts/check-storybook-drift.ts`.
- `builtinCatalogHash` (server/builtinHash.ts) пересчитывается сам из definitions — руками не трогать.

Проверка: `npm run verify` (typecheck + тесты + validate:prototypes + build + drift).

## Gotchas

- **`$cond` в props сломан в плеере** (баг, актуален на 2026-07-11): формат v1 и валидатор принимают `{"$cond":{"if":...,"then":...,"else":...}}`, но плеер передаёт props в json-render без трансформации, а рантайм ждёт плоское `{$cond,$then,$else}` → в браузере `Objects are not valid as a React child (found: object with keys {$cond})`. Обход: два элемента с `visible`-условиями (`{"$state":"/path"}` / `{"$state":"/path","eq":0}`) — это работает, проверено.
- Файловые `prototypes/*.json` — только встроенный каталог; кастомные типы валидатор режет (`unknown component type`). Прототипы с кастомными компонентами живут только в БД через API.
- Seed одноразовый по имени файла: правка засеянного JSON молча не применится. Итерации — через `driver.mjs prototype` или свежий `DATA_DIR`.
- Все мутации требуют `baseRev` (409 при гонке) — драйвер берёт `headRev` сам; при ручном curl не забыть.
- Тело компонента — plain function; `memo`/`forwardRef` в ABI v1 не поддерживаются. `example`, если задан, обязан проходить props-схему.
- События без payload; редактируемые значения читать через `$bindState`. У события максимум один терминальный экшен (`navigate`/`back`/`restart`/`openUrl`), и он последний.
- Bun брать из `~/.bun/bin` (npm-шим `/usr/local/bin/bun` битый).
- Длинные JSON-тела в шелле не инлайнить (бэктики выполняются) — payload собирать в файл, `curl --data-binary @file`; драйвер избавляет от этого.

## Troubleshooting

- `422 {"issues":[{"path":["source"],"message":"Type check failed: ..."}]}` на publish — читать вывод tsc в issue; save такие ошибки не ловит.
- `FAIL <file>.json /screens/.../type: unknown component type: X` из validate:prototypes — кастомный тип в файловом прототипе; перенести прототип в API-путь.
- `[json-render] Rendering error in <Text>: Objects are not valid as a React child ({$cond})` — см. первый пункт Gotchas.
- `curl` к :8787 отказывает (exit 7) — API-сервер не запущен либо занят другим портом; health-эндпоинт открыт даже под BASIC_AUTH.
