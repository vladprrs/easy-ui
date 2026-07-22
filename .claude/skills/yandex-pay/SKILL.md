---
name: yandex-pay
description: Author and edit components and prototypes in the yandex-pay design system of easy-ui — pick the right primitive/role, write defensive render code, keep definitions clean, and reference assets from the registry. Use when asked to create, add, update, or fix a yandex-pay component or prototype (yp-* / design system yandex-pay).
---

# Авторинг в дизайн-системе yandex-pay

Скилл — how-to для добавления и правки компонентов и прототипов **в дизайн-системе yandex-pay** (custom-only, 100 компонентов `yp-*`). Источник истины по канону/шкалам/ролям — **`docs/design/yandex-pay.md`** (читай его перед работой). Механика публикации (driver.mjs, setup, скриншоты, версии) — общий скилл **`.claude/skills/author/SKILL.md`**; сборка **прототипов** в YP (скелет экрана, FlowRoot-футер, грабли YpBox/state) — скилл **`.claude/skills/yp-prototype/SKILL.md`**; здесь они не дублируются.

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

Прод-тема yandex-pay — **v7** (волна 3): **78 токенов = 9 `space.*` + 69 `color.*`** (вкл. `color.shadow-*`/`color.gradient-*`). Токенизация палитры **завершена** — цвет пиши через `color()`, не через сырой литерал/legacy-`var`. **Полная канон-таблица — design.md §1.1** (не дублировать здесь). Кратко:

- **Цвет — только `color("<ключ>", "<канон>")`**, ключ без префикса `color.`, `fallback` = канон-литерал таблицы §1.1 (побайтово — держит пиксель-паритет при откате темы). Ровно **ОДИН** runtime-специфаер на компонент (нельзя мешать `v4` с v1–v3).
- **Тени и градиенты — тоже через `color()`**: `shadow-medium` `0 8px 24px rgba(0,0,0,.12)`, `shadow-medium-up` `0 -8px 24px rgba(0,0,0,.12)` (футер `yp-screen`), `shadow-low` `0 2px 8px rgba(0,0,0,.08)`, `shadow-low-handle` `0 1px 3px #0003` (ручка `yp-switch`, не сводится), `shadow-high` `0 16px 40px rgba(0,0,0,.16)`, `gradient-plus` `linear-gradient(135deg,#ff2e93 0%,#8b3dff 52%,#3277ff 100%)`.
- **font-стек**: `'YS Text','Helvetica Neue',Arial,sans-serif` (лишний `Helvetica` — легаси, убирать).
- **fontWeight**: только **400 / 500 / 700** (400 текст, 500 medium/CTA/суммы, 700 bold/знак Плюса). **600/800/900 → 700** (иначе faux-bold).
- **spacing**: `space()`-токены — реальные ключи `none/xs/sm/md/lg/xl/2xl/3xl/4xl` (не суффиксные), значения из `resolvedSpaceScale` каталога. **`20px` gutter** — осознанное исключение вне шкалы, к `lg`/`xl` НЕ приводить.

```
import { color } from "easy-ui/runtime/v4";   // ровно ОДИН runtime-специфаер на компонент
background: color("text-primary", "rgba(0,0,0,.86)")   // ключ без "color."; → var(--eui-color-text-primary, rgba(0,0,0,.86))
boxShadow:  color("shadow-medium", "0 8px 24px rgba(0,0,0,.12)")
```

- В мигрируемом коде `var(--x, <literal>)` (вкл. вложенные `var(--x, var(--y, …))`) переписывается **целиком** в `color(...)`; legacy-`var` никем не эмитятся.
- **Union-spacing `yp-text`/`yp-skeleton`** (волна 3): spacing-пропы — `number` (legacy px, буквально сохранён в схеме) **|** строковый ключ шкалы (`z.enum(["none","xs","sm","md","lg","xl","2xl","3xl","4xl"])`). Render: строка → `space(key)` (кидает TypeError на неизвестном ключе), число → px legacy. Числовой union не пере-выводить (потеря литерала → 422 на re-pin). `yp-spacer` не трогать.

**asset-url контракт (волна 3, H7).** url-пропы компонентов, ожидающие ассет — строгий regex `/^\/api\/assets\/asset_[a-f0-9]{64}$/` (для optional — плюс `""`); внешние/inline-URL запрещены на re-pin. `$asset`-директивы в доках идут **мимо** zod (резолвятся рантаймом). Свободные url-пропы (напр. `yp-icon mode:"url"`) классифицированы явно и **не** сужаются этим regex.

**banner-канон.** Промо-баннер — всегда `yp-promo-banner` (параметризован `imageLayout`/`ctaSize`/`tone`/`width`/`height`, поглотил mid — design.md §4.5). `yp-banner-mid` **deprecated**: не в active-манифесте, новые прототипы его не подхватывают, immutable-пины рендерятся.

**`currency` — enum (не свободная строка).** В `yp-split-discount-info` и `yp-discount-info-with-cashback` валюта — `z.enum(["RUB","UZS"])`, включая вложенный `limits.currency`. Расширение enum новой валютой требует обновления форматтера (`symbol()`/`money()`); для валюты без утверждённого символа печатать код — текущее безопасное поведение.

**`yp-random-avatar` — `seed` для детерминизма.** Проп `seed: z.union([z.string(), z.number()]).optional()`; при заданном seed аватар детерминирован (mulberry32 от хеша), без seed — прежнее `Math.random`-поведение. Для скриншот-гейтов использовать `examples`-вариант с фиксированным `seed` (иначе снимок недетерминирован и исключается из pixelmatch).

## 4. Definition-гигиена

- **`atomicLevel` обязателен** и не завышен (иначе publish-warning + категория Other в Library).
- **`examples`-мапа**: slug-ключи 1–32 символа (`default` зарезервирован), ≤8 наборов, каждый **обязан парситься текущей strict-схемой**; не удалять существующий `example`. Обязательны для топ-используемых (`yp-box`, `yp-icon`, `yp-text`, `yp-payment-method-card`, `yp-button`, `yp-badge`).
- **`description`** — актуальный, без стейл-примечаний (напр. «YS Text font files not provided» устарело с v4).

## 5. Ассеты

Картинки/шрифты/иконки **не встраивать base64 в исходник** (запрещено — раздувает bundle, минует пиннинг/дедуп). Загружать через `POST /api/assets` и ссылаться литералом `/api/assets/asset_<sha256>` (из TSX — строковый URL; в доке — `{"$asset":"asset_<sha256>"}`). Механика загрузки — author §Ассеты.

**Знак Плюса** = registry-ассет (`asset_2a907dc8…`, `<img>`, как в `yp-plus-badge`/`yp-snippet-plus`). Глифы `«Я»`/`✦` **запрещены** — устранены из всех носителей волной 3 (D4, design.md §4.3); в любых правках рисовать только ассет.

## 6. Слоты

Слот, объявленный в `definition.slots`, **обязан рендериться** (`slots.header` и т.д.). Добавляй рендер слота как **дополнение**, `children` (`slots.default`) остаётся fallback — non-breaking. Мёртвые объявленные слоты (напр. `yp-navigation` left/center/right) — баг, не образец.

## 7. Публикация

Через driver.mjs общего скилла: `node driver.mjs component <id> <Name> <file.tsx> --design-system yandex-pay`, затем прототип `node driver.mjs prototype <doc.json>`. Полная механика (setup, версии/publish, `snap`/`baseline`/`check`, troubleshooting) — **`.claude/skills/author/SKILL.md`**. Не изобретать заново.

**Грабли (волна 3):**
- **База правки — актуальный active-source с прода** (`GET /api/components/<id>/versions/<v>` для текущей версии), **не** локальный снапшот `work/*`. Публикация со stale-снапшота теряет уже выкаченные изменения (в W-C `yp-payment-method-card` v15 откатил ABI 4→2 с отставшего снапшота — пришлось republish v16). `?version=` в url source **игнорируется** сервером — версию брать через путь `/versions/:v`.
- Тема **append-only**: новые ключи (`fill-muted`, `control-active-dark`, `control-disabled` в v7) добавляются PATCH `baseVersion:N → N+1`, существующие значения байт-в-байт неизменны; v5-орфаны `fill-muted-*` не удаляются.
- Публичный API имеет **login rate-limit** — не спамить авторизацией в циклах.
