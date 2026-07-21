# Дизайн-система yandex-pay — справочник для авторов

Справочник фактического канона каталога **yandex-pay** (100 компонентов, custom-only) для авторов компонентов и прототипов. Источники: аудит `docs/audit/2026-07-20-yp-catalog-audit.md`, агрегаты `docs/audit/design-facts-agg.json`, находки `docs/audit/2026-07-20-yp-catalog-findings.md`; канон принят фикс-волной 2026-07-20 (`docs/plans/2026-07-20-yp-catalog-fixes.md`, §Конвенции), токенизация палитры завершена волной 3 (`docs/plans/2026-07-21-yp-wave3-backlog-close.md`).

> **Ключевой факт.** Прод-тема yandex-pay — **v7** (`metaVersion 7`, волна 3, 2026-07-21): **78 токенов = 9 `space.*` + 69 `color.*`**, включая namespace `color.shadow-*` и `color.gradient-*`. Бэклог токенизации палитры (H2 семьи цветов, H8 тени/градиенты) **закрыт волной 3**: дивергентные семьи канонизированы, тени и градиенты переведены в тему. Компоненты читают цвет через **ABI v4 `color(key, fallback)`** (`easy-ui/runtime/v4`); тени и градиенты — тем же `color()` (ключи `shadow-*`/`gradient-*`). `fallback` обязателен и равен канон-литералу таблицы §1.1 (держит пиксель-паритет при откате темы). Литералы за пределами реестра (per-case opaque-цвета на фоне, `20px` gutter) — осознанные исключения, см. ниже.

---

## 1. Токен-канон

### 1.1 Канон-таблица (волна 3)

Пиши цвет через `color("<ключ>", "<канон>")` (ключ — без префикса `color.`). Каноны приняты гейтом G1 (+ поправка G1-A) волны 3 и обязательны в правках. Полный реестр — `work/yp-wave3/token-registry-v6.json` (workspace, gitignored).

**canon-now — семьи, сведённые к канону (пиксель меняется осознанно, fallback = канон):**

| Семья | `color()`-ключ | Канон | Примечание |
|---|---|---|---|
| text.primary | `text-primary` | `rgba(0,0,0,.86)` | folds #000000d8 / #1f2023 / #111 |
| text.secondary | `text-secondary` | `rgba(0,0,0,.5)` | folds #00000080 / #6b6d74 / #767779 / #777 |
| text.tertiary | `text-tertiary` | `rgba(0,0,0,.3)` | folds #93979e; #777a85 — отдельно (control, ниже) |
| text.quaternary | `text-quaternary` | `rgba(0,0,0,.2)` | == #0003 |
| text.inverted | `text-inverted` | `#fff` | `rgba(255,255,255,.98)` остаётся `surface-overlay` |
| text.positive | `text-positive` | `#2c9e56` | штатный fallback `--text-color-positive`; folds #13a463 (visualReview) |
| text.negative | `text-negative` | `#f33` | folds #ff4d52 |
| accent.blue | `accent-blue` | `#188fc7` | #0a6cff/#1551e5 — per-case literal-preserve (link/декор) |
| separator | `separator` | `rgba(0,0,0,.08)` | ≈ #00000014 |
| border-hairline | `border-hairline` | `#e1e3e8` | настоящие бордеры карточек (folds #dedfe3/#d9dce1); не-бордеры → `control-*` |
| fill-muted | `fill-muted` | `#f5f7f9` | **свод** #f2f3f5/#f3f5f7 → #f5f7f9; три v5 `fill-muted-*`-ключа остаются в теме орфанами |
| split | `split` | `#5c33d6` | бренд Bank Split |
| plus | `plus` | `#6b47ff` | стоп градиента Плюса; folds #8f42ff/#7b42f6/#7b3fe4 |
| shadow.medium | `shadow-medium` | `0 8px 24px rgba(0,0,0,.12)` | свод alpha .10↔.12 |
| shadow.medium-up | `shadow-medium-up` | `0 -8px 24px rgba(0,0,0,.12)` | восходящая тень футера `yp-screen` |
| shadow.low | `shadow-low` | `0 2px 8px rgba(0,0,0,.08)` | `yp-block` |
| shadow.low-handle | `shadow-low-handle` | `0 1px 3px #0003` | ручка `yp-switch` — **не** сводится с `shadow.low` |
| shadow.high | `shadow-high` | `0 16px 40px rgba(0,0,0,.16)` | `yp-block shadow=high` |
| gradient.plus | `gradient-plus` | `linear-gradient(135deg,#ff2e93 0%,#8b3dff 52%,#3277ff 100%)` | 135deg, стопы 0/52/100; свод 90deg/2-стоп |

**literal-preserve — роль отличается, значение сохранено 1:1 (diff=0), но токенизировано ключом:**

- `positive-badge` `#56c776` (яркая бейдж-зелень, отдельная роль от ядра `#2c9e56`); `control-active-positive` `#56c676` (ручка `yp-switch`).
- `control-active-dark` `#777a85` (control-fill: selected-фоны `yp-checkbox`/`yp-pseudo-radio`, индикатор `yp-split-row`, selected `yp-switch`/`yp-payment-method-card` — **не** text.tertiary, поправка G1-A); `control-disabled` `#d6d7da` (disabled-трек `yp-switch`).
- `control-secondary-hover` `#e8e9ec`, `control-secondary-pressed` `#dfe1e5`, `fill-default-150/200/300`, `accent-blue-*` (#0a6cff link / #1551e5 декор), `plus-solid` `#9f00d6`.
- `gradient.shimmer` — шиммер `yp-skeleton` сохранён литералом (канона формы нет); прочие декоративные градиенты (promo-семья, radial-глоу, rainbow, карточные) — literal-preserve `gradient-*`.

**ship-now (пилот волны 2, в теме, literal-preserving):** `surface-primary` `#fff`, `surface-overlay` `rgba(255,255,255,.98)`, `surface-secondary` `#edeff2`, `fill-dark` `#2e2f33`, `badge-discount` `#ffdc60` (+ три орфан-ключа `fill-muted-*`, §1.3).

**Диспозиция реестра v6 (186 записей):** ship-now 8 · **canon-now 36** · **literal-preserve 43** · **meta 77** (agg/var, развёрнуты пер-вхожденчески по носителям) · **skip 22** (уникальные скримы/аудит-артефакты без семантической роли).

**font-стек** (не цвет, но канон правок): `'YS Text','Helvetica Neue',Arial,sans-serif`. Лишний `Helvetica` в некоторых семействах (`yp-plus-return`, `*-full-payment`, `no-pay`, maps) — легаси, убирать.

### 1.2 ABI v4 `color()`

Мигрируемые/новые компоненты берут цвет так:

```
import { color } from "easy-ui/runtime/v4";
// ключ — без префикса "color.", fallback обязателен и равен канон-литералу таблицы §1.1
background: color("text-primary", "rgba(0,0,0,.86)")   // → var(--eui-color-text-primary, rgba(0,0,0,.86))
boxShadow:  color("shadow-medium", "0 8px 24px rgba(0,0,0,.12)")
```

- Ровно **один** runtime-специфаер на компонент (нельзя мешать `easy-ui/runtime/v4` с v1–v3).
- `fallback` в `.d.ts` **обязателен** — при откате темы компонент никогда не резолвится в `undefined`.
- Тени и градиенты валидируются на PATCH темы отдельными грамматиками (`color.shadow-*` → box-shadow-строка/comma-list; `color.gradient-*` → `linear-`/`radial-gradient(…)`), читаются тем же `color()` — нового ABI нет (`server/designSystemsMeta.ts`).
- `var(--x, <literal>)` в мигрируемом коде переписывается целиком в `color(...)`; legacy-`var` никем не эмитятся.

### 1.3 Свод `fill-muted` и v5-орфаны

Три значения одной семантики `--fill-color-default-50` (#f2f3f5/#f3f5f7/#f5f7f9) волной 3 **сведены** к канону `#f5f7f9` (ключ `fill-muted`) переключением носителей — осознанный diff. Три пилотных v5-ключа `fill-muted-f2f3f5`/`-f3f5f7`/`-f5f7f9` остаются в теме, но больше не читаются ни одним компонентом (**орфаны**, append-only тема их не удаляет).

---

## 2. Шкалы

### 2.1 Spacing (тема v4, `space()`-токены)

Единственная тем-шкала. Используй `space()`-токены (реальные ключи `spaceToken`), не сырые px.

| Токен | px |
|---|---|
| `none` | 0 |
| `xs` | 4 |
| `sm` | 8 |
| `md` | 12 |
| `lg` | 16 |
| `xl` | 24 |
| `2xl` | 32 |
| `3xl` | 48 |
| `4xl` | 64 |

**`20px` — вне шкалы.** Это продуктовый экранный **gutter** (боковые поля экрана). Зафиксирован как осознанное исключение; к `lg`/`xl` не приводить без визуального ревью.

**Union-spacing `yp-text` / `yp-skeleton` (волна 3, H4).** Их spacing-пропы принимают **union**: `number` (legacy px, буквально сохранённый в схеме) **|** строковый ключ шкалы (`z.enum(["none","xs","sm","md","lg","xl","2xl","3xl","4xl"])`). Render: строка → `space(key)`, число → px legacy. Миграция W-E — только exact-match число→ключ (9 значений, diff=0); off-token (напр. `20`) остаются числами. `yp-spacer` не трогается (остаётся legacy).

### 2.2 Радиусы (типовые из агрегатов)

Тем-токенов радиуса нет — только сырые значения. Типовые: **6** (бейджи/чипы), **8**, **10**, **12** (карточки), **14**, **16** (крупные карточки/секции), **20** (экранные блоки), **24** (крупные поверхности/листы), **28/30/32** (кнопки-пилюли), **48**, **50%** / **999px** (круг/пилюля). Топ-частоты: `20` (6), `16` (6), `12` (5), `24` (4), `8` (3), `6` (3).

### 2.3 fontWeight

Тема YS Text поставляет **только 400 / 500 / 700**.

| Вес | Роль |
|---|---|
| 400 | базовый текст |
| 500 | medium (заголовки карточек, CTA, бейджи, суммы) |
| 700 | bold (крупные заголовки, глиф Плюса) |

**Веса 600 / 800 / 900 — вне шкалы** (браузер синтезирует faux-bold, типографика «плывёт»). Канон: `600/800/900 → 700`. Встречаются в 13 компонентах (`yp-badge` 600, `yp-cashback-badge` 800, `yp-app-home-*` 900 и др.) — это долг, не образец.

> **H3, вариант B — закреплено официально (волна 2, 2026-07-21).** Шкала начертаний YS Text — **400 / 500 / 700**, закрывается документированием. Вариант A (добавить в тему файлы начертаний 600/900) **отклонён: файлов начертаний 600/900 не существует** — браузер синтезировал бы faux-bold. Правило `600 / 800 / 900 → 700` — постоянный канон, не временный долг фикс-волны.

---

## 3. Роли примитивов

Разграничение из аудита (класс E, near-duplicates). Выбирай примитив по роли — не смешивай.

| Компонент | Роль | ABI / уровень |
|---|---|---|
| **`yp-box`** | **Эталон** layout-примитива: `space()`-паддинги/gap, оборонительное `??` на каждом пропе, `layoutNeutral`+layout v1 | ABI v3 — образец паттерна |
| **`yp-panel`** | **Bare-структура** molecule: `<section>` flex-column, header/content/footer из строковых пропов, sticky-футер | molecule |
| **`yp-screen`** | **Decorated organism**: та же структура + навигация, subtitle, preFooter, футер с тенью, padding, fullscreen | organism |
| **`yp-scroll-area`** | Viewport со скроллом; **резерв под футер `bottomInset=111`** — ядро компонента (без fallback ломается) | — |
| **`yp-spacer`** | **Legacy**-спейсер (числовые размеры вне токенов). Предпочитать `gap` родителя (`yp-box`) | legacy |
| **`yp-promo-banner`** | **Канон промо-баннера** (organism): кликабельная поверхность заголовок+CTA+артворк. Параметризован под всё семейство banner/*: `imageLayout` (adaptive/fixed-bottom), `ctaSize`, `tone`, `width`/`height` (`number \| enum`). Поглотил `yp-banner-mid` (§4.5) | organism |

Radio (две сущности `role="radio"`, не дубли — разные API):

| Компонент | Роль |
|---|---|
| **`yp-radio-button`** | Слот-фасад для групп: слот `content`, typed-событие `value-identity` |
| **`yp-pseudo-radio`** | Автономный визуальный radio с `label` и SVG-галкой (общая с `yp-checkbox`) |

Выбор `yp-panel` vs `yp-screen`: `yp-panel` — **bare** секция (flex-column header/content/footer, sticky-футер) без декора; `yp-screen` — **decorated** organism поверх той же структуры (навигация, subtitle, preFooter, тень футера `shadow.medium-up`, padding, fullscreen). Нужна голая структура → `yp-panel`; навигация/футер/тени → `yp-screen`. Не дублировать декор `yp-screen` руками в `yp-panel`.

Промо-баннер — всегда `yp-promo-banner` (§4.5). `yp-banner-mid` **deprecated** (слит в канон), новые прототипы его не подхватывают; существующие immutable-пины рендерятся.

---

## 4. Паттерны

### 4.1 Оборонительное чтение пропов (обязательно)

**Renderer НЕ применяет zod-дефолты.** Props приходят как есть из дока; `.default(X)` в схеме — только подсказка редактору. Каждый дефолт обязан дублироваться оборонительным чтением в рендере, иначе — краш / NaN-геометрия / неверная ветка (главный класс проблем аудита: 77 находок).

```
const size = props.size ?? "16";          // скаляр = дефолт схемы
const m = metrics[props.size ?? "16"];     // lookup по ключу с fallback
const style = table[props.k] ?? table.default; // lookup с fallback на объект
const open = props.isOpen ?? true;         // булев с default(true)
const items = props.items ?? [];           // массив (иначе .map крашит)
```

Дефолт в `??` **всегда равен дефолту схемы** этого же файла (не «разумному значению»). Эталон — `yp-box`. Схему при этом **не менять** (non-breaking).

### 4.2 discount-badge

Канон жёлтого discount-бейджа (зафиксирован для будущего извлечения в общий компонент):

| Параметр | Значение |
|---|---|
| фон | `#ffdc60` (`--badge-color-discount`) |
| radius | `6` |
| height | `20` |
| padding | `0 6px` |
| fontWeight | `500` (в `yp-badge` discount-ветка — `italic 600`, привести к 700) |

Реализации расходятся `clipPath` (`polygon(8% 0,...)` vs `polygon(5% 0,...)`) — известный дубль (`yp-badge` ↔ `yp-loyalty-badge`).

### 4.3 Представление знака Плюса

**Канон: registry-ассет `asset_2a907dc8…`** (`<img>`, эталон `yp-plus-badge`/`yp-snippet-plus`/`yp-snippet-discount-plus`). Ассет **обязателен** — глифы запрещены. Легаси-глифы `«Я»` (`yp-cashback-badge`, `yp-loyalty-badge`) и `✦` (`yp-plus-return`) **устранены волной 3 (D4)**: заменены на `<img>` с Плюс-ассетом (визуальная приёмка — паритет с реальным Yandex Pay). В новых/правимых компонентах глиф Плюса не рисовать — только ассет.

### 4.4 Статус-бар / часы

Часовая типографика статус-бара выровнена там, где семейства совпадают: `yp-cpqr-sheet-frame` и `yp-cpqr-status-bar` несут идентичную тройку `fontSize 16 / lineHeight 20px / fontWeight 700` (YS Text), вынесенную в локальный `clockType`-хелпер с маркером `SHARED-SHAPE` (позиционирование отличается по поверхности — не выравнивается; кросс-компонентный импорт невозможен, см. §4.6). `yp-app-home-chrome` **намеренно вне** общей формы: его часы `-apple-system 17/20 w500` (не YS, не 700) — иная роль (нативный OS-хром), не долг. Индикатор батареи у части реализаций опущен по источнику.

### 4.5 Промо-баннер (канон banner/*)

`yp-promo-banner` — единый носитель промо-семейства (поглотил `yp-banner-mid`). Пропы:

| Проп | Тип | Дефолт | Роль |
|---|---|---|---|
| `title` | string ≤50 | — | заголовок (клампится) |
| `subtitle` | string ≤70 | `""` | подзаголовок |
| `ctaLabel` | string ≤24 | — | текст CTA |
| `imageUrl` | **asset-ref** `/api/assets/asset_<64hex>` | — | артворк (внешний URL запрещён; `$asset` резолвится мимо zod) |
| `imageAlt` | string ≤80 | `""` | alt артворка |
| `variant` | `cashback\|discount\|split` | `cashback` | легаси-фон промо (`#fae9f6`/`#fff0d9`/`#e1fae7`) |
| `tone` | `purple\|green\|pink` | — (opt) | **перекрывает** `variant`: `purple`=`#efedf7` (канон-фон mid); `green`=`#e1fae7` (**алиас** split); `pink`=`#fae9f6` (**алиас** cashback) — не новые литералы |
| `theme` | `light\|dark` | `light` | тёмная тема (`#2e2030`, инверт текст/CTA) |
| `imageLayout` | `adaptive\|fixed-bottom` | `adaptive` | **adaptive** = `min(148,max(120,w-160))`, `objectFit:cover`; **fixed-bottom** = mid-колонка `148×120`, `align-self:flex-end`, `objectPosition:center bottom` + mid-ритм текста |
| `ctaSize` | `compact\|wide` | `compact` | **compact** = `minWidth 76 × 36` (промо); **wide** = `134 × 40` (mid) |
| `width` | `number(280–440) \| enum "327"\|"336"\|"343"` | `336` | ширина; enum — mobile/master/CPQR |
| `height` | `number(100–240) \| enum "136"\|"156"\|"176"` | — (opt) | без значения: `height 156 / minHeight 138`; при задании: фикс `height=minHeight` (mid) |

Инвариант: дефолты (adaptive/compact/variant, без tone/height) воспроизводят прежнее `yp-promo-banner` **пиксель-в-пиксель**; `fixed-bottom` + `ctaSize:"wide"` + `tone` воспроизводит `yp-banner-mid` пиксель-в-пиксель (проверено DOM-gate strict diff=0 и md5-идентичностью снимков плеера при миграции 4 живых узлов).

### 4.6 Шаринг кода: невозможен импортом, только выровненные инлайн-хелперы

Кастом-компоненты материализуются как **самостоятельные single-file бандлы** (`Bun.build`, `external` = только shim-ABI-специфаеры `react`/`zod`/`@json-render/*`/`easy-ui/runtime*`; финальная проверка отвергает любой импорт, не являющийся shim-ABI-URL — `server/components/compile.ts`). **Импорт одного компонента из другого или из общего модуля невозможен.** Дедупликация — только **выровненные инлайн-хелперы** внутри каждого файла с маркер-комментарием происхождения (`SHARED-SHAPE(...)` / `SHARED-SURFACE`), рендер-результат байт-в-байт неизменен (DOM-gate strict diff=0). Примеры W-G: `BadgeHeading` (savers↔loans; цвет бейджа расходится по состоянию), `surfaceBg` (tooltip: фон пузыря + fill стрелки), `clockType` (§4.4).

---

## 5. Известный долг

Кратко (подробности и приоритизация — в `docs/product-hypotheses-2026-07-20.md`):

- **Токенизация палитры** — **закрыта волной 3** (H2/H8): theme **v7** (9 space + 69 color, вкл. `shadow-*`/`gradient-*`) + ABI v4 `color()` (§1.1–1.2). Дивергентные семьи канонизированы (canon-now 36), роль-специфичные — literal-preserve (43); реестр `work/yp-wave3/token-registry-v6.json`. Осталось только: per-case opaque-литералы на фоне и `20px` gutter — осознанные исключения.
- **Дивергенция `--text-color-primary`** — **закрыта (H2)**: сведена к `text-primary` `rgba(0,0,0,.86)` (§1.1).
- **fontWeight 600/800/900** вне шкалы (13 компонентов) — **закрыто как H3-B**: канон `→ 700` официален, файлов начертаний нет (§2.3). Вариант «добавить начертания в тему» отклонён.
- **Представление Плюса** — **унифицировано волной 3 (D4)**: глифы устранены, канон = registry-ассет (§4.3). **discount-badge** (2 clipPath) — извлечение общего компонента отложено (§4.2).
- **Near-duplicates**: `yp-promo-banner`≈`yp-banner-mid` — **закрыто (W-G)**: mid слит в канон (`imageLayout`/`ctaSize`/`tone`/`width|height`), deprecated, 4 живых узла мигрированы pixel-identical (§4.5). `yp-app-home-savers`≈`yp-app-home-loans` и статус-бары — выровнены инлайн-хелперами с маркерами (diff=0), но **кросс-файловая консолидация невозможна** (single-file бандлы, §4.6). `yp-panel`⊂`yp-screen` — разграничение ролей в §3, слияние breaking, в бэклоге.
- **Ассеты в исходниках** (`yp-random-avatar`, `yp-maps-review-banner`, `yp-ctyp-payment-page`, ~253KB base64) — вынести в пайплайн ассетов.
