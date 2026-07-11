# Пользовательские дизайн-системы в easy-ui: registry API, Yandex Pay и миграция

**Версия плана: v2** (v1 отревьюирована адверсариально Codex gpt-5.6-sol + Fable 5; триаж находок — в конце документа). План продолжает реализованную мультисистемность из `2026-07-11-design-systems-atomic.md`: `designSystem` уже присутствует в prototype document, компонентах, DTO, runtime и UI. Эта итерация добавляет персистентный реестр пользовательских систем, `POST /api/design-systems`, регистрацию `yandex-pay`, безопасный перенос существующих компонентов и поддержку authoring driver.

## Context

WebView-компоненты production-приложения Yandex Pay импортируются в easy-ui для интерактивных прототипов. Сейчас сервер знает только кодовые системы `shadcn` и `wireframe`. Неизвестная система отклоняется с `422`, а отсутствие поля нормализуется в `shadcn`, поэтому уже импортированные Yandex Pay компоненты и `yp-design-system-gallery` оказались в неверной системе.

Целевое состояние:

```json
{
  "id": "yandex-pay",
  "name": "Yandex Pay Design System",
  "description": "Production-like Yandex Pay WebView components for interactive prototypes."
}
```

Система должна существовать после деплоя независимо от компонентов, создаваться также через authoring API, принимать custom-компоненты и prototype documents и отображаться отдельно от Shadcn. Старые документы без `designSystem` продолжают означать `shadcn`.

## Scope

Входит в итерацию:

- персистентный registry пользовательских дизайн-систем;
- `GET /design-systems`, `GET /design-systems/:id`, `POST /design-systems`;
- автоматическая регистрация `yandex-pay` миграцией;
- создание custom-компонентов в зарегистрированной системе;
- безопасная смена системы существующего custom-компонента;
- фиксация системы в component revisions (publish-версии наследуют её через join);
- создание и обновление прототипов с выбранной системой;
- миграция `yp-design-system-gallery` без смены ID и потери истории;
- фильтры/названия систем в gallery и каталоге custom-компонентов;
- `--design-system` и `EASYUI_DESIGN_SYSTEM` в authoring driver;
- документация и тесты.

Не входит:

- загрузка builtin React-компонентов через API;
- редактирование и удаление дизайн-систем;
- перенос builtin-компонентов между системами;
- переименование ID системы;
- ACL/auth-модель отдельных систем;
- защита от гонки конкурентной файловой материализации source (существующее поведение, см. триаж C7).

## Ключевые решения

| Вопрос | Решение |
|---|---|
| Источник систем | Единственный registry — таблица `design_systems` в SQLite. `shadcn`, `wireframe` и `yandex-pay` регистрируются одинаковыми строками миграции |
| Регистрация Yandex Pay | Миграция БД делает `INSERT` при создании таблицы; наличие системы не зависит от seed prototypes или компонентов |
| Кодовые каталоги | `shadcn` и `wireframe` имеют внутренний `builtin_provider`, который связывает строку registry с реализацией каталога в bundle. Provider — реализация системы, а не отдельный источник регистрации |
| `POST /design-systems` | Создаёт обычную строку registry без `builtin_provider`; ответ `201`, повтор ID — `409 already_exists` |
| Пользовательские builtins | Не поддерживаются в этой итерации. Поэтому `components` у созданной системы изначально `[]`; её каталог формируют published custom-компоненты |
| Валидация | Любой `designSystem` валиден, если найден в таблице registry. Definitions системы без provider начинаются с `{}` и дополняются только published custom-компонентами этой системы |
| Hash | Для системы без provider `builtinCatalogHash` считается **тем же canonical-алгоритмом** от дескриптора `{actions: [...], definitions: []}` — action names включены, поэтому он **не равен** `emptyComponentManifestHash` (golden test обязателен) |
| Default | `designSystem` отсутствует → `shadcn`; значение default не меняется |
| История компонента | `design_system` фиксируется в каждой **component revision**. Publish-версия систему **не дублирует**: она иммутабельно связана с ревизией составным FK `(component_id, rev)` и получает систему через join с `component_revisions` — второго источника истины нет, инвариант равенства не нужен |
| Канонический источник системы | Для head — `components.design_system`; для ревизии — `component_revisions.design_system`; для publish-версии — join на её ревизию. Полная query-matrix ниже |
| Перенос компонента | `PUT /components/:id` принимает опциональный `designSystem`; смена создаёт новую ревизию с переданным либо текущим source. Для использования в новой системе эту ревизию нужно опубликовать |
| Старые pins | Pin указывает на published version, а её система (система её ревизии) иммутабельна. Старые prototype revisions продолжают работать в прежней системе |
| Компонент в двух системах | После move+publish компонент имеет active-версии в обеих системах. Это **осознанная семантика**: старые прототипы старой системы продолжают резолвить его по последней publish-версии своей системы (включая новые ревизии таких прототипов), но в `catalog/manifest` компонент виден только в системе последней active-версии. Задокументировать в `docs/server-api.md` |
| Перенос прототипа | Обычный `PUT /prototypes/:id` создаёт новую ревизию с новым `doc.designSystem` и пересчитывает pins относительно целевой системы; прежние ревизии и версии неизменны |
| Имена компонентов | Глобальная уникальность `components.name` сохраняется, и имя не может совпадать с builtin-именем **любой** provider-системы (т.е. в yandex-pay нельзя создать `Button`, `Card` и т.п.). Ограничение MVP, явно документируется |
| Клиентский fallback | Клиент имеет кодовую карту provider-реализаций (`shadcn`, `wireframe`). Для любого другого ID `resolveBuiltinSystem(id)` возвращает пустую builtin-систему (definitions `{}`, components `{}`). Гейт от опечаток — серверная валидация при save; клиент не делает собственную проверку существования системы |
| Удаление системы | Не поддерживается: это исключает dangling references из документов, revisions и versions |

## Единый registry

Сделать серверный модуль, например `server/designSystems.ts`, единственной точкой чтения registry:

```ts
interface RegisteredDesignSystem {
  id: string;
  name: string;
  description: string;
  builtinProvider: string | null;
  definitions: Record<string, ComponentDefinition>;
}

listRegisteredDesignSystems(db): RegisteredDesignSystem[]
getRegisteredDesignSystem(db, id): RegisteredDesignSystem | null
requireRegisteredDesignSystem(db, id, path): RegisteredDesignSystem
```

Правила:

1. Существование системы определяется только строкой `design_systems`; записи нет — система неизвестна.
2. `src/designSystems` по смыслу становится registry реализаций builtin providers: он не регистрирует системы и не содержит пользовательские metadata.
3. `builtin_provider = "shadcn" | "wireframe"` выбирает definitions/components/fixtures соответствующей кодовой реализации. `NULL` означает пустой builtin-каталог.
4. Поле `builtin_provider` внутреннее, неизменяемое и не принимается публичным `POST` (публичный `DesignSystemSummary` его не содержит).
5. Startup-инвариант требует, чтобы каждый ненулевой provider существовал в кодовой карте, а один provider не был назначен нескольким строкам.
6. Все серверные проверки начинают с DB lookup системы и только затем, при наличии provider, берут кодовые definitions.

### Клиентский resolution-контракт

Сервер и клиент делят модуль `src/designSystems`, поэтому семантика разделяется явно:

- `designSystems` (кодовая карта) и строгий `getDesignSystem(id)` (throw на неизвестный ID) **сохраняются** для серверных путей, где ID уже проверен по DB registry, и для CLI `validate:prototypes` (локальные seed-прототипы используют только provider-системы).
- Добавляется `resolveBuiltinSystem(id): DesignSystem` — возвращает provider-систему из карты либо пустую систему `{id, name: id, definitions: {}, components: {}}` для любого другого ID. Не бросает.
- Клиентские потребители переходят на `resolveBuiltinSystem`: `src/catalog/runtime.ts:31` (`createPlayerRuntime`), `src/editor/EditorView.tsx:39`, fallback в `src/prototype/validate.ts:125` — **только когда definitions не переданы явно** (сервер всегда передаёт snapshot, поэтому серверная строгость не ослабляется).
- Документы доезжают до клиента только пройдя серверную валидацию по registry, поэтому «пустой рендер» для незарегистрированного ID на клиенте недостижим штатно; controlled error на клиенте не требуется.
- Человекочитаемое имя системы клиент берёт из `GET /design-systems` (gallery уже так делает), а не из кодовой карты.

Таким образом, у `shadcn`, `wireframe`, `yandex-pay` и созданной через `POST` системы одинаковый lifecycle регистрации и одинаковая адресация через DB. Различается только наличие внутреннего renderer/catalog provider.

## Схема БД и миграция

Новая миграция (v3) в `server/migrations.ts`:

```sql
CREATE TABLE design_systems (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  builtin_provider TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO design_systems
  (id, name, description, builtin_provider, created_at, updated_at)
VALUES
  ('shadcn', 'Shadcn', :shadcn_description, 'shadcn', :now, :now),
  ('wireframe', 'Wireframe', :wireframe_description, 'wireframe', :now, :now),
  ('yandex-pay',
   'Yandex Pay Design System',
   'Production-like Yandex Pay WebView components for interactive prototypes.',
   NULL,
   :now,
   :now);

ALTER TABLE component_revisions
  ADD COLUMN design_system TEXT NOT NULL DEFAULT 'shadcn';
```

`component_publishes` колонку **не получает** (см. «Ключевые решения»): система publish-версии всегда читается join'ом `component_publishes (component_id, rev) → component_revisions.design_system`.

После добавления колонки выполнить backfill не default-значением, а текущим значением владельца:

```sql
UPDATE component_revisions
SET design_system = (
  SELECT c.design_system FROM components c WHERE c.id = component_id
);
```

Это корректно для данных до появления операции переноса: все исторические ревизии компонента до миграции принадлежали одной системе из `components.design_system`.

### Опасность рабочего DEFAULT

SQLite требует DEFAULT для `ADD COLUMN NOT NULL`, и убрать его без rebuild таблицы нельзя. Оставшийся DEFAULT означает: забытый write path молча запишет `'shadcn'` вместо системы компонента. Компенсации (обязательны):

1. **Каждый insert в `component_revisions` передаёт `design_system` явно** — `create`, `save`, `restore` в `server/repos/components.ts` (строки 11, 12, 18); grep-тест или code review, что ни один `INSERT INTO component_revisions` не полагается на DEFAULT.
2. **Startup-аудит равенства head**: `components.design_system` обязан совпадать с `design_system` ревизии `head_rev`. Расхождение = забытый write path → сервер падает с явной ошибкой.
3. Юнит-тест каждого insert-пути (create/save/move/restore) с non-default системой, проверяющий записанное значение в БД.

### Startup: порядок и инварианты

Текущий порядок в `server/main.ts:44` — `openDatabase (migrate)` → `failStagingPublishes` → `verifyShimAbi` → `seedPrototypes`. Аудит целостности обязан выполняться **до любых мутаций прикладных данных**:

```
schema migration (+ seed design_systems rows + backfill)
→ read-only integrity audit (падение = сервер не стартует, данные не тронуты)
→ failStagingPublishes
→ verifyShimAbi
→ seedPrototypes
→ ready
```

Аудит (внутри `migrate()` после миграций, как текущий `assertBuiltinNamesDoNotCollide`, либо отдельной функцией сразу после):

- `components.design_system`, `component_revisions.design_system` и `prototypes.design_system` ссылаются только на зарегистрированные системы;
- `components.design_system` равен системе head-ревизии (см. выше);
- `prototypes.design_system` равен `doc.designSystem` head-ревизии прототипа;
- каждый ненулевой `builtin_provider` существует в кодовой карте; provider не назначен дважды (UNIQUE это уже гарантирует — проверка кодовой карты остаётся);
- builtin-имена provider-систем не конфликтуют с custom component names (существующий `assertBuiltinNamesDoNotCollide`).

Исторические `prototype_revisions.doc` на startup **не парсятся** (дорого и практически невозможно получить dangling-ссылку: системы не удаляются, а save всегда валидировал систему). Тест на провал аудита обязан проверять, что staging publishes и seed не были изменены.

Ссылки из существующих таблиц остаются без SQL FK: SQLite не умеет добавить его через простой `ALTER TABLE`, а rebuild крупных таблиц не нужен для MVP. Целостность обеспечивается application-level validation во всех write paths и startup-аудитом выше.

Исторический prototype document остаётся источником системы своей ревизии; отдельная колонка в `prototype_revisions` не нужна.

## Каноническая query-matrix системы

Центральный инвариант итерации: **иммутабельные читатели никогда не смотрят на mutable `components.design_system`**. Полный список запросов и канонический источник:

| Запрос | Место сейчас | Канонический источник системы |
|---|---|---|
| Snapshot custom types при save прототипа | `server/validation.ts:15-18` (сейчас `c.design_system`) | `component_revisions.design_system` ревизии выбираемой publish-версии: join `cp → cr`, фильтр `cr.design_system = doc.designSystem`, latest active version в этой системе |
| Prototype restore: проверка пинов | `server/repos/prototypes.ts:80-83` (сейчас `c.design_system`) | Система ревизии пиновой publish-версии (join `prc → cp → cr`) |
| Prototype publish: проверка пинов | `server/repos/prototypes.ts:99-101` (сейчас `c.design_system`) | То же |
| `catalog/manifest` | `server/routes/components.ts:34` (сейчас `c.design_system`) | Система ревизии latest active publish (join `cp → cr`) |
| Component version DTO | `server/repos/components.ts:24` (уже join'ит `cr`) | Добавить `cr.design_system` в SELECT |
| Component list/meta | `server/repos/components.ts:14-15` | Head: `components.design_system` (корректно, mutable by design) |
| Component source/draft/revisions DTO | `server/repos/components.ts:16-17` | `component_revisions.design_system` соответствующей ревизии (добавить в DTO, см. ниже) |
| Prototype pins read (`draft`/`revision`/`version`) | `server/repos/prototypes.ts:29-35` | Систему не возвращает и не проверяет — менять не нужно; воспроизведение идёт по immutable bundle URL |

Без изменения restore/publish перенос компонента **сломал бы** restore старых Shadcn-ревизий и publish прототипов, чей пиновый компонент уехал в другую систему, — вопреки гарантиям иммутабельности. Эти два места обязательны в той же задаче, что и snapshot.

## API

Все пути ниже находятся под `/api`.

### Дизайн-системы

| Метод/путь | Запрос → ответ |
|---|---|
| `GET /design-systems` | → `200 {designSystems: DesignSystemSummary[]}` |
| `GET /design-systems/:id` | → `200 DesignSystemSummary` \| `404 not_found` |
| `POST /design-systems` | `{id,name,description}` → `201 DesignSystemSummary` + `Location: /api/design-systems/:id` |

`DesignSystemSummary`:

```ts
interface DesignSystemSummary {
  id: string;
  name: string;
  description: string;
  builtinCatalogHash: string;
  components: DesignSystemComponent[];
}
```

В `components` остаются definitions подключённого builtin provider, как в текущем контракте. Для систем без provider это `[]`. Published custom-компоненты возвращаются через `/catalog/manifest` и не дублируются здесь. `builtinProvider` наружу не отдаётся.

Семантика ошибок `POST` (фиксируется тестами, единообразно с будущим стилем):

| Вход | Ответ |
|---|---|
| malformed JSON / body не object | `400 invalid_request` |
| неизвестные ключи, неверный тип, пустые/длинные значения, невалидный slug | `422 validation_failed` + `issues[{path: [<field>]}]` |
| `id` уже существует (builtin или custom) | `409 already_exists` |
| `PUT`/`DELETE`/`PATCH` на collection или `:id` | `405 method_not_allowed` |

Ограничения полей: `id` — slug `^[a-z0-9]+(?:-[a-z0-9]+)*$`; `name` — непустая после trim, ≤120; `description` — непустая после trim, ≤500. Успешные ответы и `GET` — `Cache-Control: no-store`. Идемпотентности нет: повторный `POST` тем же payload — `409`.

### Компоненты

Создание уже имеет нужную форму, но проверяет систему через единый DB registry:

```json
{
  "id": "yp-amount",
  "name": "YpAmount",
  "designSystem": "yandex-pay",
  "source": "...",
  "message": "Initial Yandex Pay import"
}
```

Обновлённый контракт сохранения:

```http
PUT /api/components/:id
Content-Type: application/json

{
  "source": "...",
  "designSystem": "yandex-pay",
  "message": "Move component to Yandex Pay",
  "baseRev": 3
}
```

`source` и `designSystem` опциональны по отдельности, но хотя бы одно из них обязательно. Если `source` отсутствует, новая ревизия копирует source текущего head. Если `designSystem` отсутствует, наследуется система текущего head. Неизвестная система → `422`; неизменившиеся source и system → `400 invalid_request`.

Изменения хранения:

- `components.design_system` — система head для list/meta и новых saves;
- `component_revisions.design_system` — иммутабельная система ревизии; каждый insert передаёт её явно;
- publish систему **не хранит** — она однозначно определяется ревизией через существующий составной FK; CAS-проверка `head_rev` при publish сохраняется;
- restore component revision создаёт новый head с source **и системой** исходной ревизии;
- version DTO и manifest берут систему join'ом на `component_revisions`;
- prototype snapshot/restore/publish — по query-matrix выше.

DTO-матрица компонента (где появляется `designSystem`):

| DTO | Источник |
|---|---|
| `GET /components` (list) | head (`components.design_system`) — уже есть |
| `GET /components/:id` (meta) | head — уже есть; элементы `versions[]` дополняются системой их ревизии |
| `GET /components/:id/source` и `/draft` | система head-ревизии (`component_revisions`) |
| `GET /components/:id/revisions` | каждый элемент — система своей ревизии |
| `GET /components/:id/revisions/:rev` | система этой ревизии |
| `GET /components/:id/versions/:v` | система ревизии версии (join `cr`) |
| `catalog/manifest` | система ревизии latest active publish |

После смены head system ранее опубликованные версии остаются доступны по immutable URL и старым pins. Компонент не появляется в новой системе до publish новой ревизии. Компонент с active-версиями в двух системах остаётся резолвимым в обеих (см. «Ключевые решения»), но в manifest виден только в системе последней active-версии.

### Прототипы

Prototype document сохраняет текущий контракт:

```json
{
  "version": 1,
  "id": "yp-design-system-gallery",
  "name": "Yandex Pay Design System Gallery",
  "designSystem": "yandex-pay",
  "device": "mobile",
  "startScreen": "overview",
  "state": {},
  "screens": []
}
```

Практический документ обязан соответствовать текущей schema, включая непустой `screens` и существующий `startScreen`; пустой массив выше — сокращённый пример authoring-контракта, а не валидный сохраняемый prototype.

При `POST`/`PUT` сервер:

1. нормализует отсутствие `designSystem` в `shadcn`;
2. проверяет систему через DB registry;
3. берёт definitions её builtin provider либо `{}` для системы без provider;
4. резолвит custom types только среди active publishes, чья **ревизия** принадлежит той же системе;
5. валидирует документ по объединённому snapshot;
6. сохраняет новую prototype revision и точные pins в одной транзакции;
7. обновляет `prototypes.design_system` из head document.

Draft, revision и version возвращают систему внутри `doc`. List/meta возвращают систему head top-level по существующей DTO-матрице. Save/restore никогда не подставляют default поверх явно переданного значения.

## Миграция существующих Yandex Pay данных

Миграция выполняется через публичный authoring API, без прямого редактирования prototype history.

### Операционный manifest и идемпотентность

Прогон управляется manifest-файлом (не по префиксу имени — ID не является доказательством принадлежности):

```json
{
  "targetSystem": "yandex-pay",
  "components": [
    {"id": "yp-amount", "expectedHeadRev": 3, "expectedSourceHash": "sha256..."}
  ],
  "prototypes": ["yp-design-system-gallery"]
}
```

Протокол каждого шага — read-back перед действием, никаких слепых retry:

- перед move: `GET /components/:id`; если `designSystem` уже `targetSystem` и есть active-версия в ней — шаг **пропускается** (уже перенесён); если `headRev`/source hash не совпадают с ожидаемыми — **стоп**, ручной разбор;
- `409 revision_conflict` → перечитать meta и решить заново (не повторять вслепую: retry `PUT` создаёт лишнюю ревизию);
- `409 already_published` при publish → проверить, что существующая версия принадлежит целевой системе, и считать шаг выполненным;
- обрыв между move и publish безопасен: возобновление начинает с read-back и допубликовывает;
- после каждого шага — запись фактического результата (rev/version) в deployment log.

### Порядок (обязателен)

1. Убедиться, что `GET /design-systems` содержит `yandex-pay`; после DB migration это уже так.
2. Для каждого компонента manifest вызвать `PUT /components/:id` с `designSystem: "yandex-pay"`, текущим `baseRev` и без `source`.
3. Опубликовать полученную ревизию. Это создаёт новую version в `yandex-pay`; прежние Shadcn versions остаются неизменны.
4. Получить текущий draft `yp-design-system-gallery`.
5. Сохранить тот же полный doc через `PUT /prototypes/yp-design-system-gallery`, изменив только `designSystem` и при необходимости несовместимые builtin types.
6. Сервер перепривяжет используемые custom types к последним published Yandex Pay versions.
7. Проверить draft/read-back, список, UI и при необходимости опубликовать новую prototype version.

Гарантии:

- prototype ID, screens, state и старые revisions/versions сохраняются;
- старые Shadcn revisions сохраняют прежние pins и продолжают воспроизводиться (включая restore — см. query-matrix);
- новая revision получает новые Yandex Pay pins;
- pins не «перекрашиваются» задним числом;
- если компонент ещё не опубликован в целевой системе, save прототипа атомарно отклоняется с `422`, не создавая частичную ревизию.

Перед production-прогоном — backup SQLite. Manifest и результаты read-back приложить к deployment log.

## UI

### Gallery прототипов

Текущий фильтр уже объединяет registry и legacy IDs. После расширения API проверить:

- отдельный chip/filter `Yandex Pay Design System`;
- badge `System: Yandex Pay Design System` у `yp-design-system-gallery`;
- Shadcn и Wireframe остаются отдельными;
- пустая зарегистрированная система отображается в фильтре независимо от числа прототипов.

### Каталог компонентов

Текущий `LibraryPage` строится только из Storybook index, делает early-return при недоступном Storybook (`src/library/LibraryPage.tsx:34`) и всегда рендерит story-iframe (`:45`). Простого добавления manifest fetch недостаточно — страница декомпозируется:

- **три независимых источника** со своими loading/error-состояниями: registry (`GET /design-systems`), Storybook index (опционален), custom manifest (`GET /catalog/manifest`);
- отказ Storybook **не** прячет custom-каталог: показывается баннер про Storybook, registry-системы и manifest-карточки остаются;
- selection-модель — discriminated union `{kind: "story", storyId} | {kind: "custom", componentId}`; story открывает iframe, custom — metadata-card без iframe preview (MVP);
- список систем берётся из registry; builtin stories группируются по своей кодовой системе; custom-карточки — по `component.designSystem` из manifest;
- `yandex-pay` виден даже до публикации первого компонента; в его группе нет Shadcn/Wireframe компонентов.

Так API metadata и UI не смешивают понятия builtin story и published custom component.

## Authoring driver

Текущий `driver.mjs` не готов к добавлению флага «в лоб»: `headRev()` выбрасывает всё meta кроме номера ревизии (`.claude/skills/author/driver.mjs:44`), аргументы деструктурируются без проверки количества/неизвестных флагов, `readFile(sourcePath)` выполняется до валидации CLI. Порядок работ:

1. Общий парсер: позиционные аргументы + флаги; неизвестный флаг или флаг без значения → ошибка **до** любых `readFile`/HTTP.
2. `headRev()` → `getMeta()` (возвращает весь meta: `headRev`, `designSystem`, `versions`).
3. Команды и семантика системы:

```bash
node driver.mjs component yp-amount YpAmount ./components/yp-amount.tsx --design-system yandex-pay
EASYUI_DESIGN_SYSTEM=yandex-pay node driver.mjs component yp-amount YpAmount ./components/yp-amount.tsx
node driver.mjs design-system yandex-pay "Yandex Pay Design System" "Production-like ..."
```

Приоритет: `--design-system` → `EASYUI_DESIGN_SYSTEM` → поле не отправляется (сервер применит default/наследование).

| Сценарий | Поведение |
|---|---|
| create без выбора | `designSystem` не отправляется (сервер → `shadcn`) |
| create с выбором | `designSystem` в `POST /components` |
| update без выбора | поле не отправляется; head-система сохраняется сервером |
| update с выбором = текущая | поле не отправляется (не плодить no-op проверки на сервере) |
| update с выбором ≠ текущая | `designSystem` в `PUT` (+ `source`, если файл передан) |
| system-only move | `PUT` c `designSystem` без `source` |
| `409 revision_conflict` | перечитать meta, сообщить пользователю, не ретраить вслепую |
| `design-system` команда: `201` | успех, напечатать summary |
| `design-system` команда: `409` | считать существующей, `GET /design-systems/:id` и напечатать фактические metadata (без попытки их изменить) |

Driver печатает систему после save/publish и не меняет prototype document: его система по-прежнему задаётся в JSON.

## Изменения по файлам

### Сервер и БД

- `server/migrations.ts` — таблица `design_systems`, seed-строки, `component_revisions.design_system`, backfill, расширенный startup-аудит (см. «Startup»).
- `server/main.ts` — порядок startup (аудит до мутаций), передать DB в design-systems route, разрешить `POST`.
- `server/designSystems.ts` — единый DB registry, lookup provider.
- `server/routes/designSystems.ts` — DB-aware `GET` (list + `:id`), новый `POST`, строгая schema.
- `server/routes/components.ts` — registry validation, optional system/source в `PUT`, manifest join на `cr`.
- `server/repos/components.ts` — `design_system` во всех insert'ах ревизий, move/save/restore semantics, DTO-матрица.
- `server/routes/prototypes.ts` и `server/validation.ts` — registry-aware definitions, snapshot по системе ревизии publish-версии.
- `server/repos/prototypes.ts` — restore/publish pin-проверки по системе ревизии publish-версии (строки 80-83, 99-101).
- `server/builtinHash.ts` — hash provider catalog либо canonical hash пустого дескриптора для системы без provider; golden test.

### Клиент и runtime

- `src/designSystems/index.ts` — `resolveBuiltinSystem` (клиентский fallback), строгий `getDesignSystem` сохраняется.
- `src/catalog/runtime.ts` — `createPlayerRuntime` через `resolveBuiltinSystem`.
- `src/editor/EditorView.tsx` — то же (строка 39).
- `src/prototype/validate.ts` — fallback на `resolveBuiltinSystem` только при отсутствии переданных definitions.
- `src/api/client.ts` — `createDesignSystem`, `getDesignSystem(:id)` при необходимости.
- `src/gallery/GalleryPage.tsx` — проверить отображение пустых систем.
- `src/library/LibraryPage.tsx` — декомпозиция источников и selection-модели (см. UI).

### Driver и документация

- `.claude/skills/author/driver.mjs` — парсер, `getMeta`, команда `design-system`, флаг/env.
- `.claude/skills/author/SKILL.md` — мультисистемная грамматика и примеры.
- `docs/server-api.md` — lifecycle систем, POST, immutable version system, перенос, семантика «компонент в двух системах», ограничение глобальных имён.
- `docs/prototype-format.md` — единый registry и системы с/без builtin provider.
- `.claude/skills/author/reference/builtin-catalog.json` — не добавлять Yandex Pay custom-компоненты как builtins.

## Порядок реализации

1. Migration + registry helpers + startup-аудит и порядок в `main.ts`; миграционные тесты на populated v2 DB.
2. `GET /design-systems` (list + `:id`) на DB registry, `POST` со строгой schema.
3. Все серверные lookup систем: code-only map → DB registry + provider lookup.
4. `design_system` в component revisions, move через `PUT`, DTO-матрица компонентов.
5. Query-matrix прототипов: snapshot, restore, publish, manifest — на систему ревизии publish-версии.
6. Клиентский `resolveBuiltinSystem` + runtime/editor/validate.
7. Gallery/Library.
8. Authoring driver + skill docs.
9. Управляемая миграция Yandex Pay (manifest + read-back протокол), затем gallery prototype.
10. API/format docs, полный verify/e2e.

Порядок 4 → 5 → 9 принципиален: нельзя переписывать prototype system, пока в целевой системе нет опубликованных версий его custom-компонентов.

## Тестовая матрица

### Registry API

- миграция пустой и populated v2 DB добавляет `yandex-pay` один раз; повторный startup не меняет metadata/timestamps;
- `GET` list возвращает три миграционные строки и API-системы; `components: []` для Yandex Pay; `GET /:id` — `200`/`404`;
- `POST` → `201`, `Location`, `no-store`; duplicate builtin/custom ID → `409`;
- полная таблица error semantics (`400`/`422` с path/`409`/`405`);
- API-created система переживает перезапуск сервера.

### Integrity/startup

- startup падает на dangling system reference в `components`/`component_revisions`/`prototypes`;
- startup падает при `components.design_system` ≠ система head-ревизии (симуляция забытого write path);
- startup падает при `prototypes.design_system` ≠ `doc.designSystem` head-ревизии;
- registry-строка с неизвестным provider → падение; UNIQUE provider — на уровне схемы;
- провал аудита не мутирует staging publishes и не сеет seed.

### Компоненты

- create Yandex Pay component → list/meta/draft/source/revisions DTO содержат систему;
- publish → version DTO и manifest берут систему join'ом (искусственная порча head-системы не влияет на version DTO);
- каждый insert-путь ревизии (create/save/move/restore) записывает явную non-default систему в БД;
- source update без поля сохраняет систему; смена системы создаёт новую revision, старые revision/version неизменны;
- новая publish version принадлежит новой системе; restore старой revision возвращает head в старую систему новой ревизией;
- неизвестная система → `422`; неизменившиеся source и system → `400`;
- конкурирующий move/save/publish соблюдает `baseRev`; failed/staging publish после move не ломает манифест;
- компонент с active-версиями в двух системах: manifest показывает систему последней; snapshot из старой системы резолвит её последнюю версию;
- soft-deleted component: старый pin/bundle читается, новый snapshot его не выбирает.

### Прототипы

- create/read/list/meta/revision/version round-trip для `yandex-pay`;
- legacy doc без поля нормализуется в `shadcn` на всех read paths;
- неизвестная система → `422 path: ["designSystem"]`;
- custom Yandex Pay component резолвится только из Yandex Pay prototype; provider-компоненты не резолвятся из системы без provider;
- **restore старой Shadcn-ревизии работает после переноса её пинового компонента в другую систему** (проверка по системе publish-ревизии);
- **publish прототипа работает после переноса head пинового компонента** (то же);
- сохранение новой revision не сбрасывает систему; restore старой Shadcn revision возвращает Shadcn head и её pins;
- миграция gallery создаёт новую revision, сохраняет ID/history и получает Yandex Pay pins;
- попытка миграции до publish всех компонентов отклоняется атомарно.

### Client fallback

- player/editor рендерят прототип зарегистрированной системы без provider (пустой builtin, custom pins);
- editor открывает такой прототип без исключения при пустом списке custom-компонентов;
- `resolveBuiltinSystem` для provider ID возвращает кодовую систему, для прочих — пустую;
- серверные пути не используют `resolveBuiltinSystem` для проверки валидности;
- golden test: `builtinCatalogHashFor` системы без provider ≠ `emptyComponentManifestHash` и стабилен.

### UI и driver

- gallery показывает readable Yandex Pay name и отдельный filter;
- Library: registry-системы и custom-карточки видны при недоступном Storybook; пустая система видна; selection story/custom работает;
- driver: flag/env приоритет, create/update семантика по таблице, malformed CLI падает до запроса, `design-system` команда обрабатывает `201`/`409`;
- operational retry: повторный прогон миграционного протокола пропускает выполненные шаги и не плодит ревизии.

## Проверка

```bash
npm run verify
npm run e2e
```

Дополнительный API smoke на чистой временной БД:

1. `GET /api/design-systems` → `shadcn`, `wireframe`, `yandex-pay`.
2. `POST /api/design-systems` с новым ID → `201`; повтор → `409`; `GET /:id` → `200`.
3. Создать и опубликовать компонент в новой системе.
4. Создать прототип на этом компоненте; проверить draft pins и manifest.
5. Перенести component head в другую систему и опубликовать.
6. Убедиться, что старая prototype revision воспроизводится со старым bundle и **restore на неё работает**.
7. Сохранить новую prototype revision в целевой системе и проверить новые pins.
8. Рестарт сервера → API-created система и все инварианты на месте.

Перед production migration сохранить backup SQLite. Операционный manifest Yandex Pay component IDs и результаты read-back приложить к deployment log; автоматический перенос по имени или префиксу не выполнять.

## Критерии готовности

- `yandex-pay` присутствует после deploy без ручного POST и без компонентов;
- такую же систему без builtin provider можно создать через `POST /api/design-systems`;
- custom component создаётся, обновляется, переносится и публикуется с корректной системой во всех DTO по матрице (list/meta/source/revisions/version/manifest);
- старые component versions и prototype pins не меняют систему задним числом; restore/publish прототипов работают после переноса компонентов;
- prototype явно выбирает систему, сохраняет её во всех новых revisions и не видит компоненты других систем;
- legacy documents продолжают работать как Shadcn;
- `yp-design-system-gallery` переносится через `PUT` без удаления, смены ID или потери истории;
- gallery и component catalog показывают Yandex Pay отдельно; Library живёт без Storybook;
- authoring driver поддерживает API-регистрацию, `--design-system` и `EASYUI_DESIGN_SYSTEM`;
- API и authoring документация описывают единый registry, builtin providers, семантику двух систем у компонента и ограничения MVP.

## Триаж ревью v1 (Codex gpt-5.6-sol, max + Fable 5)

Ревью-тред Codex: `019f5283-7663-7ff3-9862-3c0ee82d2482`. C# — находки Codex, F# — находки Fable.

| # | Находка | Решение |
|---|---|---|
| C1/F1 (blocker) | Клиентский resolution-контракт не определён; `getDesignSystem` бросает в runtime/EditorView/validate | **Принято**: секция «Клиентский resolution-контракт», `resolveBuiltinSystem`, файлы добавлены в scope. Client-side проверка существования по registry отклонена: гейт — серверная валидация при save |
| C2 (blocker) | Дублирование `design_system` в publishes без инварианта равенства | **Принято радикальнее**: колонка в `component_publishes` не добавляется вовсе; система publish — join через существующий составной FK |
| C3 (major) | Startup-аудит пропускает исторические документы | **Принято частично (minor)**: dangling-история недостижима штатно (save всегда валидировал, delete систем нет); head-проверки добавлены, парсинг всей истории отклонён как дорогой |
| C4/F2/F3 (major) | Query-matrix mutable head → snapshot неполна (restore/publish/manifest) | **Принято**: секция «Каноническая query-matrix», restore/publish в одной задаче со snapshot; семантика «компонент в двух системах» зафиксирована явно |
| C5 (major) | DTO ревизий компонента не определён | **Принято**: DTO-матрица компонента |
| C6 (major) | DEFAULT 'shadcn' → тихая порча истории | **Принято**: явный insert везде + startup-аудит равенства head + тесты insert-путей. Rebuild таблицы отклонён (SQLite, MVP); для publishes неактуально после C2 |
| C7 (major) | Гонка файловой материализации при конкурентных PUT | **Принято частично (minor, out of scope)**: гонка существует до плана; publish/snapshot рематериализуют source из БД. Вынесено в «Не входит» |
| C8 (major) | Миграция YP без retry/idempotency стратегии | **Принято**: manifest с expectedHeadRev/sourceHash, read-back протокол, различение 409 |
| C9 (major) | Library не переживает отсутствие Storybook | **Принято**: декомпозиция источников, discriminated selection, независимые error states |
| C10 (major) | Driver требует структурной переделки | **Принято**: парсер, `getMeta`, таблица семантики сценариев |
| C11 (major) | Startup-порядок: аудит после мутаций | **Принято**: явная последовательность, тест на отсутствие мутаций при провале аудита |
| C12 (minor) | Error semantics не унифицирована | **Принято**: таблица ошибок POST |
| C13 (minor) | Hash пустой системы не определён точно | **Принято**: canonical дескриптор с actions, golden test |
| C14 (major) | Пробелы тестовой матрицы | **Принято**: блоки Integrity/startup, Client fallback, кейсы two-system/soft-delete/failed-publish/retry. Кейс «historical revision с неизвестной системой» отклонён вместе с C3 |
| F4 (minor) | `Location` указывает на несуществующий роут | **Принято**: добавлен `GET /design-systems/:id` |
| F5 (minor) | Глобальная уникальность имён скрыто запрещает `Button` и т.п. в yandex-pay | **Принято**: явно в «Ключевых решениях» и docs |
