---
name: yandex-pay
description: Author and edit components and prototypes in the yandex-pay design system of easy-ui — pick the right primitive/role, write defensive render code, keep definitions clean, and reference assets from the registry. Use when asked to create, add, update, or fix a yandex-pay component or prototype (yp-* / design system yandex-pay).
---

# Авторинг в дизайн-системе yandex-pay

Скилл — how-to для добавления и правки компонентов и прототипов **в дизайн-системе yandex-pay** (custom-only, 100 компонентов `yp-*`). Источник истины по канону/шкалам/ролям — **`docs/design/yandex-pay.md`** (читай его перед работой). Механика публикации (driver.mjs, setup, скриншоты, версии) — общий скилл **`.claude/skills/author/SKILL.md`**; здесь она не дублируется.

Перед авторингом получи актуальный каталог: `node driver.mjs catalog yandex-pay` — только возвращённые exact definitions и `resolvedSpaceScale`.

## 1. Главное правило: Renderer НЕ применяет zod-дефолты

Props приходят в рендер **как есть из дока**; `.default(X)` в схеме — только подсказка редактору. Это причина №1 находок аудита (77 находок, 51 компонент): краш / NaN-геометрия / неверная ветка при валидном по схеме доке.

**Каждый `.default(X)` схемы обязан дублироваться `?? X` в render-коде.** Дефолт в `??` **всегда равен дефолту схемы этого файла** (не «разумному значению»). Схему при этом НЕ менять (non-breaking). Эталон — компонент `yp-box` из каталога (исходник: `GET /api/components/yp-box`, определение — в `node driver.mjs catalog yandex-pay`).

```
const size  = props.size ?? "16";               // скаляр
const m     = metrics[props.size ?? "16"];       // lookup по ключу
const style = table[props.k] ?? table.default;   // lookup с fallback-объектом
const open  = props.isOpen ?? true;              // булев default(true)
const items = props.items ?? [];                 // массив (иначе .map крашит)
```

### Чек-лист самопроверки перед публикацией

- [ ] каждый `.default()` в схеме имеет парный `?? <тот же дефолт>` в рендере;
- [ ] каждый `props.arr.map/.length` защищён `?? []`; каждая арифметика (`Number(props.x)`, `props.w - N`) — fallback (нет NaN-геометрии);
- [ ] каждый `metrics[props.k]` / деструктуризация lookup имеет fallback-ветку;
- [ ] каждый булев с `default(true)` читается `(props.f ?? true)` (нет тихой ветки B);
- [ ] проверил `{}` (пустые props) на видимом child — рендер совпадает с дефолтами схемы пиксельно;
- [ ] правка строго non-breaking: поведение при явно заданных пропах не изменилось.

## 2. Выбор примитивов и ролей

Выбирай примитив **по роли**, не смешивай (полная таблица — design.md §3):

- **`yp-box`** — эталонный layout-примитив (ABI v3, `space()`-паддинги/gap, оборонительное `??`). Layout стройь на нём.
- **`yp-panel`** — голая структура (section flex-column, header/content/footer, sticky-футер).
- **`yp-screen`** — decorated organism (navigation, subtitle, preFooter, тень футера, fullscreen). Нужна голая структура → `yp-panel`; нужны навигация/футер/тени → `yp-screen`.
- **`yp-spacer`** — legacy; предпочитать `gap` родителя `yp-box`.
- Radio — две **разные** сущности: `yp-radio-button` (слот-фасад групп, typed-событие) и `yp-pseudo-radio` (автономный radio с label). Не путать.

## 3. Канон литералов и `color()` (ABI v4)

Прод-тема yandex-pay — **v5** (волна 2): помимо spacing она несёт **8 пилотных `color.*`-токенов** (design.md §1.4). Остальные ~173 цвета токенов пока нет — они резолвятся во fallback-литерал. Канон = канон fallback (design.md §1). Кратко:

- **font-стек**: `'YS Text','Helvetica Neue',Arial,sans-serif` (лишний `Helvetica` — легаси, убирать).
- **`--shadow-medium`**: `0 8px 24px rgba(0,0,0,.12)` (alpha **.12**); восходящая тень футера `yp-screen` — `0 -8px 24px rgba(0,0,0,.12)`.
- **градиент Плюса**: `linear-gradient(135deg, #ff2e93 0%, #8b3dff 52%, #3277ff 100%)` (135deg, стопы 0/52/100).
- **fontWeight**: только **400 / 500 / 700** (400 текст, 500 medium/CTA/суммы, 700 bold/глиф Плюса). **600/800/900 → 700** (иначе faux-bold).
- **spacing**: `space()`-токены (`none/xs4/sm8/md12/lg16/xl24/2xl32/3xl48/4xl64`), не сырые px. Значения брать из `resolvedSpaceScale` каталога.
- **`20px` gutter** (боковые поля экрана) — осознанное исключение вне шкалы; к `lg16`/`xl24` НЕ приводить.
- Прочие fallback-цвета выравнивать **внутри своего семейства**; кросс-семейный `--text-color-primary` (три fallback) НЕ сводить (канонизация — H2).

**Цвет через `color()` (новые/обновляемые компоненты):**

```
import { color } from "easy-ui/runtime/v4";   // ровно ОДИН runtime-специфаер на компонент (нельзя мешать v1–v3)
background: color("surface-primary", "#fff")  // key без префикса "color."; → var(--eui-color-surface-primary, #fff)
```

- `fallback` **обязателен** и **равен канон-литералу** соответствующего токена из design.md §1.4 (побайтово — это держит пиксель-no-op при откате темы).
- Пилотные ключи (без `color.`): `surface-primary` `#fff`, `surface-overlay` `rgba(255,255,255,.98)`, `surface-secondary` `#edeff2`, `fill-dark` `#2e2f33`, `fill-muted-f3f5f7` `#f3f5f7`, `fill-muted-f2f3f5` `#f2f3f5`, `fill-muted-f5f7f9` `#f5f7f9`, `badge-discount` `#ffdc60`.
- **Дивергентные семьи не токенизировать до H2**: `--text-color-primary` (три fallback), фиолетовый Split/Plus, тени/градиенты — оставлять литералами/legacy-`var`, пока канон не утверждён.

**`currency` — enum (не свободная строка).** В `yp-split-discount-info` и `yp-discount-info-with-cashback` валюта — `z.enum(["RUB","UZS"])`, включая вложенный `limits.currency`. Расширение enum новой валютой требует обновления форматтера (`symbol()`/`money()`); для валюты без утверждённого символа печатать код — текущее безопасное поведение.

**`yp-random-avatar` — `seed` для детерминизма.** Проп `seed: z.union([z.string(), z.number()]).optional()`; при заданном seed аватар детерминирован (mulberry32 от хеша), без seed — прежнее `Math.random`-поведение. Для скриншот-гейтов использовать `examples`-вариант с фиксированным `seed` (иначе снимок недетерминирован и исключается из pixelmatch).

## 4. Definition-гигиена

- **`atomicLevel` обязателен** и не завышен (иначе publish-warning + категория Other в Library).
- **`examples`-мапа**: slug-ключи 1–32 символа (`default` зарезервирован), ≤8 наборов, каждый **обязан парситься текущей strict-схемой**; не удалять существующий `example`. Обязательны для топ-используемых (`yp-box`, `yp-icon`, `yp-text`, `yp-payment-method-card`, `yp-button`, `yp-badge`).
- **`description`** — актуальный, без стейл-примечаний (напр. «YS Text font files not provided» устарело с v4).

## 5. Ассеты

Картинки/шрифты/иконки **не встраивать base64 в исходник** (запрещено — раздувает bundle, минует пиннинг/дедуп). Загружать через `POST /api/assets` и ссылаться литералом `/api/assets/asset_<sha256>` (из TSX — строковый URL; в доке — `{"$asset":"asset_<sha256>"}`). Механика загрузки — author §Ассеты.

**Знак Плюса** = registry-ассет (`asset_2a907dc8…`, как в `yp-plus-badge`/`yp-snippet-plus`). Легаси-глифы `«Я»`/`✦` в новых компонентах не использовать (design.md §4.3).

## 6. Слоты

Слот, объявленный в `definition.slots`, **обязан рендериться** (`slots.header` и т.д.). Добавляй рендер слота как **дополнение**, `children` (`slots.default`) остаётся fallback — non-breaking. Мёртвые объявленные слоты (напр. `yp-navigation` left/center/right) — баг, не образец.

## 7. Публикация

Через driver.mjs общего скилла: `node driver.mjs component <id> <Name> <file.tsx> --design-system yandex-pay`, затем прототип `node driver.mjs prototype <doc.json>`. Полная механика (setup, версии/publish, `snap`/`baseline`/`check`, troubleshooting) — **`.claude/skills/author/SKILL.md`**. Не изобретать заново.
