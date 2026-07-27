# Easy UI — предложения по развитию продукта после production-like прототипов

Дата: 2026-07-27

## Статус реализации (2026-07-27)

План: `docs/plans/2026-07-27-product-improvements-v2.md` (ревизия v2 после двух адверсариальных ревью).

| # | Пункт | Статус | Коммит |
|---|---|---|---|
| 1 | First-class resource `Composition` | ✅ реализовано | `2d5da75`, `b1be679` |
| 2 | Architecture/ownership lint как publish gate | ✅ реализовано (warn-only; blocking — по конфигу) | `a69eee3` |
| 3 | Component Tree Inspector | ✅ реализовано | `a269825` |
| 4 | Catalog discovery через usages | ✅ реализовано | `7afb3f4` |
| 5 | Dependency graph и безопасные migrations | ✅ реализовано | `7afb3f4`, `7efb82c` |
| 6 | Единый `Ready to publish` gate | ✅ реализовано (report-only по умолчанию) | `7efb82c` |
| 7 | Interaction recorder/replayer | ✅ реализовано (без серверного headless-replay) | `5362db2` |
| 8 | Надёжный screenshot/geometry contract | ✅ реализовано | `315ff75` |
| 9 | Asset Workbench | ✅ реализовано (без перцептивного хеша) | `fac5c2f` |
| 10 | Batch API и long-lived CLI session | ✅ реализовано в `driver.mjs` | `315ff75`, `c2e7e7a` |
| 11 | Prototype lifecycle и library hygiene | ✅ реализовано | `ab831fd` |
| 12 | Typed authoring SDK | ✅ реализовано | `ab4a332` |

### Сознательные отступления от исходного предложения

Обоснования — в разделе «Триаж ревью» плана.

- **Гейты выключены по умолчанию.** Обязательный dry-run отчёта готовности на копии прод-данных (27 прототипов) показал: гейт `schema` упал бы на 14 из 27, и это дрейф каталога (ужесточённые props-схемы новых версий компонентов), а не сломанные документы — `screens` при этом проходит у всех 27. Блокирующий набор задаётся `EASYUI_PUBLISH_GATES` и по умолчанию пуст.
- **Архитектурные правила смотрят только на явно объявленный `scope`.** 96 из 124 прод-экранов — одиночный custom-компонент в корне; вывод scope из `atomicLevel` затопил бы предупреждениями 16 из 27 прототипов. Для проставления метаданных есть `scripts/backfill-component-scope.ts` (dry-run по умолчанию).
- **Правило `canonical-bypass` не реализовано**: внутри `validatePrototype` нет обзора всего каталога, а «canonical» не имеет арбитра при конфликте ролей. Канонические/устаревшие компоненты и замены сурфейсятся в библиотеке и в гейте `deprecated`.
- **Композиции v1** не несут `region`/`@eui/FlowRoot` (анализ регионов идёт по авторской спеке) и не вкладываются друг в друга.
- **Вырезано как непропорциональное**: перцептивный хеш ассетов, отдельный `server/cli/easyui.ts` (вместо него расширен `driver.mjs`), серверный headless-replay сценариев и таблица runs, per-prototype колонка `publish_gates`, майнинг «рекомендованной композиции» по co-occurrence (n=27 статистически бессмысленно).
- **Гейты `capture` и `interactions`** честно возвращают `unknown`, а не выдуманный `pass`: `ScreenshotService` держит очередь job'ов только в памяти и не умеет перечислять их по прототипу (оставлен порт `CaptureLookup`).

## Главный вывод

Easy UI уже вышел из стадии хранилища React-компонентов: есть version pins, assets, render-status, immutable prototype versions, Figma metadata и semantic warnings. Следующий bottleneck — не возможность отрисовать экран, а способность **быстро найти правильные компоненты, собрать из них проверяемую композицию и доказать её корректность до публикации**.

Показательный кейс: `YpCtypMagnitPaymentSuccess` визуально проходил screenshot и browser QA, но архитектурно скрывал весь CTYP screen внутри одного custom organism. Значит, визуального и runtime gate недостаточно — Easy UI нужен отдельный composition/ownership gate.

---

# P0 — максимальный эффект

## 1. First-class resource `Composition`

### Проблема

Сейчас есть два полюса:

- отдельные reusable components;
- полный prototype screen.

Между ними нет versioned declarative composition. Поэтому повторяемую анатомию вроде CTYP success приходится либо копировать как JSON graph, либо скрывать в screen-sized React-компоненте.

### Предложение

Добавить ресурс:

```text
Component → Composition → Screen → Prototype
```

Composition должна содержать:

- declarative element graph;
- named slots;
- параметры;
- component pins;
- regions;
- events/state bindings;
- допустимые root contexts;
- source/provenance;
- собственные revisions и published versions.

Пример:

```text
CtypPaymentSuccessComposition
├── nav slot
├── merchant slot
├── accrual slot
├── offer slot
├── payment-method slot
└── footer slot
```

Magnit-сценарий передаёт только logo, merchant, amount, accrual, offer и actions, не копируя анатомию CTYP и не создавая page React-компонент.

### Эффект

- меньше screen-sized custom components;
- reuse не только визуальных блоков, но и экранной анатомии;
- централизованные исправления layout/regions;
- component tree остаётся видимым и проверяемым.

---

## 2. Architecture/ownership lint как publish gate

### Проблема

Монолит можно формально спрятать под `@eui/FlowRoot`, после чего простая root-проверка перестаёт его видеть. Runtime и screenshot остаются зелёными.

### Предложение

Добавить component metadata:

```json
{
  "scope": "primitive | section | shell | screen",
  "allowedAsRoot": false,
  "canonicalFor": ["payment-info"],
  "sourceBounded": true,
  "replacement": null
}
```

Recursive lint должен находить:

- `FlowRoot → one custom organism` без slots;
- custom screen/page, дублирующий canonical components;
- footer/header, владеющий всей страницей;
- screen geometry внутри bounded component;
- custom component без объяснения ownership boundary;
- component type `screen`, используемый как способ скрыть JSON graph.

Исключение допускается только с явным reason и provenance.

### Эффект

Ошибка уровня `YpCtypMagnitPaymentSuccess` ловится до save/publish, а не после ручного code review.

---

## 3. Component Tree Inspector в editor/player

### Проблема

Чтобы понять ownership экрана, сейчас приходится скачивать prototype JSON, искать root, children, slots и pins вручную.

### Предложение

Панель:

```text
Screen tree
├── region: header · YpPayboxNavBar · v7 · canonical
├── content · YpCpqrSheetFrame · v9 · canonical
│   ├── YpPaymentInfo · v8
│   ├── YpMagnitPostPaymentBanner · v2 · custom/source-bounded
│   └── YpSuccessPaymentCard · v3
└── region: footer · YpCpqrActionFooter · v4
```

Для каждого узла показывать:

- scope и atomic level;
- component source/version;
- canonical/custom/deprecated status;
- slots/regions;
- props diff от defaults;
- реальные размеры в player;
- Figma/reference provenance;
- другие usages.

Нужен overlay mode: клик по области экрана подсвечивает owning component.

### Эффект

Архитектура становится частью продукта и review, а не скрытым свойством JSON/TSX.

---

## 4. Catalog discovery через реальные usages

### Проблема

В live catalog `yandex-pay` больше 100 компонентов. По имени трудно понять, какой из нескольких banners/navbars/footers является каноническим для конкретного product surface.

В текущей работе пришлось вручную:

- выгружать catalog;
- получать exact published source;
- искать соседние prototype docs;
- сравнивать usage в `cpqr-scenario` и `ctyp-paybox-scenario`;
- отдельно проверять supported props и slots.

### Предложение

В каталоге добавить:

- поиск по product job: `CTYP success navbar`, `merchant payment info`;
- canonical badge для surface/role;
- visual thumbnails examples;
- “Used in current heads”;
- “Show usages” с точным component tree;
- “Similar/overlapping components”;
- “Recommended composition”;
- active source и props schema рядом;
- verified reference status;
- obsolete/deprecated replacement.

### Эффект

Правильный путь становится проще монолитного workaround.

---

## 5. Dependency graph и безопасные migrations

### Проблема

Перед удалением или заменой компонента нужно вручную проверять все prototype heads и отдельно помнить об immutable pins. После soft-delete обычный `get component` возвращает 404 и не показывает tombstone.

### Предложение

Перед delete/deprecate показывать:

```text
Current-head usages: 0
Immutable usages: 2
Compositions: 0
Replacement: CtypPaymentSuccessComposition v1
Safe to remove from active catalog: yes
```

Добавить:

- component tombstones;
- reason и replacement link;
- usage graph;
- route-level pins;
- “repin compatible heads”;
- before/after dependency diff;
- проверку старых immutable bundles после migration.

### Эффект

Можно чистить catalog, не боясь сломать историю и не оставляя отвергнутые компоненты активными.

---

## 6. Единый `Ready to publish` gate

### Проблема

Сейчас доказательство готовности собирается из отдельных шагов:

- save warnings;
- render-status каждого screen;
- geometry;
- screenshots;
- custom browser traversal;
- console/page/network diagnostics;
- ручной component-tree audit;
- read-back после publish.

### Предложение

Один отчёт:

```text
Architecture       PASS
Schema             PASS
All routes         5/5 ready
Interactions       9/9 replayed
Visual states      6/6 captured
Console/page       0 errors
Assets             0 missing
Component pins     resolved
Deprecated usage   0
Publish diff       reviewed
```

Publish может быть заблокирован по configurable P0 gates.

### Эффект

Immutable version публикуется только после одинакового воспроизводимого набора проверок.

---

## 7. Interaction recorder/replayer

### Проблема

Для каждого нетривиального flow приходится писать отдельный Playwright verifier. В Magnit flow вручную проверялись:

- переход через 5 экранов;
- `0/5` и `5/5`;
- блокировка шестой категории;
- возврат к selector;
- `Позже`;
- сохранение state;
- derived reminder;
- отсутствие console/network errors.

### Предложение

В player записывать сценарий:

```text
click “Получить бонусы”
expect screen “magnit-acceptor”
click “Продолжить”
expect text “124 бонуса начислены”
...
set state fixture selected=[...]
expect selector count=5/5
expect sixth option disabled
```

Запись хранится рядом с prototype и переигрывается для draft и immutable version.

### Эффект

Сложные CJM получают versioned acceptance tests без внешнего скрипта.

---

# P1 — ускорение ежедневной работы

## 8. Надёжный screenshot/geometry contract

Нужны:

- отдельные статусы `imageProduced`, `captureClean`, `runtimeWarnings`;
- exit code `0`, если PNG успешно создан и product errors отсутствуют;
- инфраструктурные browser noise/errors отдельно от ошибок прототипа;
- встроенный retry;
- safe-area и viewport ownership в geometry;
- фактические rects panel/frame/region, а не только union bounds;
- проверка clipping/overlap/footer ownership;
- visual diff, привязанный к exact revision/state/viewport.

Текущий болезненный пример: `snap` возвращает exit code `1`, хотя валидный PNG создан.

---

## 9. Asset Workbench

Для content-addressed assets нужен визуальный интерфейс:

- preview grid;
- dimensions/MIME/alpha;
- source/Figma node;
- usage graph;
- duplicate/near-duplicate detection;
- original vs crop/derivative;
- human-readable aliases;
- merchant/brand/category tags;
- проверка прозрачности, clipping и `naturalWidth`;
- предупреждение о raster asset, извлечённом из screenshot, если существует canonical SVG.

Сейчас opaque `asset_<sha>` сложно отличать друг от друга без отдельного download/preview.

---

## 10. Batch API и long-lived CLI session

Нужны команды:

```text
easyui get prototype <id> --head --doc
easyui status <id> --all-screens
easyui snap <id> --all-screens --states fixtures.json
easyui audit --design-system yandex-pay
easyui publish <id> --verify
```

И свойства:

- один auth session на batch;
- retry/backoff;
- machine-readable JSON;
- стабильные exit codes;
- polling screenshot jobs внутри CLI;
- не нужно знать скрытый `/revisions/:rev` endpoint, чтобы получить exact head document.

Это устранит локальные `single-session-runner` и специальные audit scripts.

---

## 11. Prototype lifecycle и library hygiene

Добавить тип/теги:

```text
product-flow
composition-fixture
component-gallery
evidence
visual-reference
experiment
archived
```

Плюс:

- owner/team;
- active/archived;
- current recommended version;
- source prototype;
- “derived from” lineage;
- скрытие fixtures из основной product library.

Это важно, когда рядом живут рабочие CJM, galleries, evidence screens и одноразовые visual candidates.

---

## 12. Typed authoring SDK

Генерировать из live catalog:

- TypeScript types компонентов;
- union names;
- props/slots/events;
- typed element builders;
- IDE autocomplete;
- schema validation до API save.

Пример:

```ts
screen.flowRoot({
  header: component("YpPayboxNavBar", {...}),
  content: composition("CtypPaymentSuccessComposition", {...}),
  footer: component("YpCpqrActionFooter", {...})
});
```

Это снизит число ошибок в ручных JSON transformations.

---

# Предлагаемый порядок

## Этап 1 — сделать архитектуру видимой

1. Component Tree Inspector.
2. `scope/allowedAsRoot/canonicalFor` metadata.
3. Recursive architecture lint.
4. Usage/dependency graph.
5. Catalog search по usages и product roles.

## Этап 2 — сделать правильную композицию проще монолита

1. Versioned `Composition` resource.
2. Screen/composition templates.
3. Typed authoring SDK.
4. Migration/repin tooling.

## Этап 3 — закрыть доказательство качества

1. `Ready to publish` gate.
2. Interaction recorder/replayer.
3. Integrated visual references/diff.
4. Stable batch screenshot/geometry API.
5. Asset Workbench.

---

# Если выбрать только три задачи

1. **Versioned declarative Composition** — убирает структурную причину screen-monoliths.
2. **Component Tree Inspector + architecture lint** — делает неправильную ownership-модель сразу видимой.
3. **Ready-to-publish gate с interaction replay** — объединяет runtime, architecture и visual quality в одно доказательство.

Именно эти три изменения сильнее всего переведут Easy UI из “можно собрать прототип” в “можно системно собирать и поддерживать продуктовые сценарии”.
