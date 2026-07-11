# Bun Server API

Локальный Bun-сервер — единственный источник данных для галереи и плеера. Он хранит прототипы и пользовательские React-компоненты в SQLite, раздаёт API, а при `SERVE_DIST=dist` также SPA и Storybook-статику. Сервер слушает только `127.0.0.1`.

## Модель версий

Каждое сохранение создаёт неизменяемую ревизию `rev`; `headRev` указывает на текущий draft. Restore копирует старую ревизию в новую. Publish не копирует данные, а присваивает текущей ревизии последовательное имя `version` (v1, v2, …); одну ревизию нельзя публиковать дважды.

При каждом сохранении прототипа сервер разрешает используемые кастомные типы в последние active-версии и записывает точные пины `(componentId, version)`. Поэтому последующий publish компонента не меняет старый draft или опубликованный прототип. Publish компонента проходит состояния `staging → active` либо `staging → failed`; staging/failed невидимы манифесту, новым пинам и bundle endpoint. После рестарта незавершённые staging-записи становятся failed.

Все пути ниже имеют префикс `/api`. JSON-ответы, кроме immutable-ресурсов, имеют `Cache-Control: no-store`. Поля `message` необязательны. Все мутации существующего ресурса требуют `baseRev`.

## Endpoints прототипов

| Метод и путь | Тело / ответ |
|---|---|
| `GET /prototypes` | `PrototypeListItem[]`: `{id,name,description?,device,designSystem,screenCount,headRev,latestVersion:number|null,updatedAt}` |
| `POST /prototypes` | `{doc,message?}` → 201 `{id,rev,warnings}` и `Location` |
| `GET /prototypes/:id` | `{id,name,designSystem,headRev,latestVersion:number|null,versions:PrototypeVersion[],updatedAt}` |
| `GET /prototypes/:id/draft` | `{doc,rev,builtinCatalogHash,componentManifestHash,components:ComponentPin[]}` |
| `PUT /prototypes/:id` | `{doc,message?,baseRev}` → `{rev,warnings}`; `doc.id` обязан совпадать с `:id` |
| `DELETE /prototypes/:id` | `{baseRev}` → 204; hard delete с каскадом ревизий |
| `GET /prototypes/:id/revisions?limit&before` | `{rev,message:string|null,createdAt}[]`; `limit` по умолчанию 20, максимум 100 |
| `GET /prototypes/:id/revisions/:rev` | `{rev,doc,components:ComponentPin[],message:string|null,createdAt}` |
| `POST /prototypes/:id/restore` | `{rev,baseRev}` → `{rev}` (номер новой head-ревизии) |
| `POST /prototypes/:id/publish` | `{message?,baseRev}` → 201 `{version,rev}` и `Location` |
| `GET /prototypes/:id/versions` | `PrototypeVersion[]`: `{version,rev,publishedAt}` |
| `GET /prototypes/:id/versions/:version` | `{version,rev,doc,builtinCatalogHash,componentManifestHash,components:ComponentPin[],publishedAt}`; immutable |

`ComponentPin` — `{id,name,version,bundleUrl,bundleHash}`. `componentManifestHash` — SHA-256 канонически отсортированных пинов. `builtinCatalogHash` вычисляется отдельно для системы из документа ревизии и идентифицирует её встроенный каталог. Дескриптор v1 включает имена, descriptions, events, slots и actions, но намеренно не включает `atomicLevel`: классификация может меняться без изменения render-совместимости. В MVP хеш диагностический — рантайм не сравнивает и не блокирует его mismatch; enforcement и таблицы совместимости оставлены на post-MVP.

### Матрица `designSystem` в DTO прототипов

Нормализованный `doc` — источник истины. Если ответ содержит `doc`, система находится только в `doc.designSystem` и не дублируется сверху: это draft, конкретная revision и опубликованная version. В list и meta, где документа нет, `designSystem` находится top-level и отражает текущий head. Ответы create, save и restore содержат только номер ревизии (и применимые warnings), поэтому отдельного поля системы в них нет. Старый документ без поля при чтении нормализуется в `designSystem: "shadcn"`.

## Endpoints компонентов

Идентификатор — slug, имя — уникальное `^[A-Z][A-Za-z0-9]*$`, не конфликтующее со встроенным каталогом ни одной зарегистрированной системы. Имена компонентов глобально уникальны, а не уникальны в паре с системой: это ограничение MVP связано с pins, registry и `components.name UNIQUE`. Имя и `designSystem` после создания неизменны. Удаление soft: компонент исчезает из списка/манифеста и не доступен новым сохранениям, но ранее опубликованные bundle и пины продолжают работать.

При добавлении builtin-системы коллизия любого её имени с существующим custom-компонентом является dev-time блокером. Startup-инвариант сравнивает объединение builtin-имён всех зарегистрированных систем со всей таблицей `components` и останавливает сервер с явной ошибкой; grandfathering устраняется вручную до регистрации системы. Композитный ключ `(designSystem, name)` отложен на post-MVP.

| Метод и путь | Тело / ответ |
|---|---|
| `GET /components` | `{id,name,designSystem,headRev,latestVersion:number|null,updatedAt}[]` |
| `POST /components` | `{id,name,source,designSystem?,message?}` → 201 `{id,rev}` и `Location`; `designSystem` по умолчанию `shadcn` |
| `GET /components/:id` | `{id,name,designSystem,headRev,versions:ComponentVersion[],updatedAt}` |
| `PUT /components/:id` | `{source,message?,baseRev}` → `{rev}` |
| `DELETE /components/:id` | `{baseRev}` → 204 |
| `GET /components/:id/source` | Текущий `{rev,source,message:string|null,createdAt}` |
| `GET /components/:id/draft` | Alias текущего source DTO |
| `GET /components/:id/revisions` | `{rev,message:string|null,createdAt}[]` |
| `GET /components/:id/revisions/:rev` | `{rev,source,message:string|null,createdAt}` |
| `POST /components/:id/restore` | `{rev,baseRev}` → `{rev}` |
| `POST /components/:id/publish` | `{message?,baseRev}` → 201 `{version,hostAbiVersion,warnings}` и `Location` |
| `GET /components/:id/versions` | `ComponentVersion[]`: `{version,rev,status,publishedAt}` |
| `GET /components/:id/versions/:version` | Active-версия: `{version,rev,source,events,slots,description,example?,propsJsonSchema?,atomicLevel?,bundleHash,hostAbiVersion,publishedAt}`; immutable |
| `GET /components/:id/versions/:version/bundle.js` | Скомпилированный ESM (`text/javascript`); immutable |

## Служебные endpoints

| Метод и путь | Ответ |
|---|---|
| `GET /health` | `{status:"ready"}` после миграций, seed и ABI-проверки; до готовности 503 `starting` |
| `GET /design-systems` | `{designSystems:[{id,name,description,builtinCatalogHash,components:[{name,atomicLevel,layoutNeutral,description,events,slots}]}]}` — реестр builtin-систем и их компоненты |
| `GET /catalog/manifest` | `{components:[{id,name,designSystem,version,bundleUrl,bundleHash,hostAbiVersion,events,slots,description,example?,propsJsonSchema?,atomicLevel?}]}` — только последняя active-версия каждого неудалённого компонента; `designSystem` находится в каждой записи |
| `GET /shims/v1/:name.js` | ESM-шим host ABI v1; immutable |

## Ошибки и ограничения HTTP

Единый envelope:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Prototype document is invalid",
    "issues": [],
    "warnings": [],
    "currentRev": 2,
    "currentVersion": 1
  }
}
```

Опциональные поля присутствуют только когда применимы. Типичные статусы: 400 — неверный JSON/DTO или отсутствующий `baseRev`; 404 — ресурс; 405 — метод; 409 — CAS-конфликт, дубликат либо повторный publish ревизии; 413 — лимит; 415 — не `application/json`; 422 — семантическая валидация. JSON body ограничен 1 MiB, source компонента — 256 KiB.

## Контракт кастомного компонента

Модуль TSX экспортирует named `definition` и default plain function component. `definition.props` — Zod-схема; допустимы `events?: string[]`, `slots?: string[]`, обязательный `description: string`, `example?: Record<string, unknown>` и `atomicLevel?: "atom" | "molecule" | "organism" | "template" | "page"`. `DefinitionMeta`, сохранённый для published-версии, содержит нормализованные `events`, `slots`, `description` и опциональные `example`, `propsJsonSchema`, `atomicLevel`; те же метаданные входят в manifest. Если example задан, он обязан проходить props-схему. У custom-компонента уровень опционален для ABI v1 backward compatibility, но publish без него возвращает warning `Atomic design level is not provided; component will be classified as Other` и Library классифицирует компонент как `Other`. Default получает `BaseComponentProps` — объект `{props, emit}`. `memo` и `forwardRef` в ABI v1 не поддерживаются.

```tsx
import { useState } from "react";
import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({ value: z.number().min(0).max(5) }),
  events: ["press"],
  slots: [],
  description: "An interactive five-star rating",
  example: { value: 3 },
  atomicLevel: "atom",
};

type Props = z.output<typeof definition.props>;
export default function RatingStars({ props, emit }: BaseComponentProps<Props>) {
  const [value, setValue] = useState(props.value);
  return <button onClick={() => { setValue(value + 1); emit("press"); }}>{"★".repeat(value)}</button>;
}
```

Канонический полный пример: `server/fixtures/rating-stars.tsx`. Save проверяет синтаксис и контракт в короткоживущем subprocess. Publish дополнительно делает TypeScript-check, сборку, проверку импортов и advisory SSR smoke; SSR-warning не блокирует publish.

### styleContractVersion 1

Гарантированы CSS-переменные темы, inline-стили и классы уже включённого shadcn-набора. Произвольные Tailwind utility-классы не гарантированы, поскольку для пользовательского source отдельный CSS не компилируется. CSS/asset imports отклоняются.

### Shim ABI v1

Bundles могут импортировать только allowlist ниже; сервер переписывает specifier в same-origin immutable shim.

| Исходный specifier | URL bundle |
|---|---|
| `react` | `/api/shims/v1/react.js` |
| `react-dom` | `/api/shims/v1/react-dom.js` |
| `react/jsx-runtime` | `/api/shims/v1/react-jsx-runtime.js` |
| `zod` | `/api/shims/v1/zod.js` |
| `@json-render/react` | `/api/shims/v1/json-render-react.js` |

## Граница доверия и запуск

По умолчанию сервер слушает `127.0.0.1` без authentication и предназначен для одного пользователя в workspace. `HOST` позволяет изменить адрес, а `BASIC_AUTH=user:pass` включает Basic authentication для API, статики и SPA fallback; исключение — только `GET /api/health`. Сервер отказывается стартовать на не-loopback адресе без `BASIC_AUTH`.

Код компонента выполняется с правами серверного процесса уже при save во время draft extraction, а при publish также проходит дополнительные стадии исполнения. Загружать следует только код, которому доверяют как коду репозитория. Subprocess и timeout ограничивают сбои extraction, но не являются security sandbox; published-код импортируется сервером и выполняется в браузере. Поэтому для публичного домена authentication обязательна.

Зависимости устанавливает только npm; требуется полный `npm install`, включая TypeScript из devDependencies. Серверный runtime — Bun 1.3.14 из `~/.bun/bin`, версия закреплена `.bun-version`; `~/.bun/bin` должен быть раньше битого `/usr/local/bin/bun` в `PATH`.

`DATA_DIR` обязан находиться внутри корня проекта. Сервер материализует туда TSX-модули, а Bun разрешает их `react`, `zod` и прочие imports через корневой `node_modules`; внешний каталог нарушает это разрешение. Для разработки: `PATH="$HOME/.bun/bin:$PATH" npm run server:dev`. Для собранной SPA: сначала `npm run build`, затем `npm run serve`.

## Deployment

Production разворачивается в Dokploy из корневого `docker-compose.yml` на домене `easy-ui.pay-offline.ru`. Контейнер использует `HOST=0.0.0.0`, `PORT=8787`, `SERVE_DIST=dist`, `DATA_DIR=data`; секрет `BASIC_AUTH=user:pass` обязателен и задаётся только в окружении Dokploy. Named volume `easy-ui-data` монтируется в `/app/data`.

Compose healthcheck обращается без credentials к открытому `GET http://127.0.0.1:8787/api/health` и считает сервис готовым только при HTTP 200 и JSON `status: "ready"`. Для rollback следует вернуть предыдущий commit SHA и повторно развернуть compose; миграции forward-only, поэтому перед рискованными изменениями нужен backup volume.

SQLite работает в WAL-режиме: корректный backup должен учитывать основной `.db` вместе с файлами `-wal` и `-shm` либо выполняться штатным SQLite backup-механизмом. `docker compose down -v` удаляет named volume и все постоянные данные — на production эту команду применять нельзя.
