# Аудит каталога дизайн-системы yandex-pay — 2026-07-20

Аудит компонентов и прототипов прода `easy-ui.pay-offline.ru` по свежим логическим бэкапам
`.backups/prod-components-20260720-130019/` (100 компонентов, все published) и
`.backups/prod-prototypes-20260720-130408/` (33 прототипа, все драфты).
План: `docs/plans/2026-07-20-yp-catalog-audit.md`. **Фаза только аудита — фиксы и обновление прода не выполнялись** (по явному указанию).

## Методология

1. **Workspace**: исходники всех компонентов и доки прототипов извлечены из ZIP-бандлов; мета (версия, rev, sourceHash) — из манифестов.
2. **Baseline-валидация**: чистый локальный сервер (порт 8791, отдельный `DATA_DIR`), импорт всех 134 бандлов через `POST /api/bundles/import?mode=apply` — каждый компонент прошёл полный publish-пайплайн (strict tsc + Bun.build + линты + SSR-smoke).
3. **Fan-out аудит**: Workflow из 21 Opus-агента по семействам (~7 компонентов на агента; большие сценарии — индивидуально). Линзы: defensive-props, abi-hygiene, definition-quality, assets, props-schema, code-quality, prototype-doc; параллельно собраны design-facts (палитра/радиусы/типографика/тени) как сырьё для будущего `design.md`.
4. **Адверсариальный verify**: каждая blocker/major-находка проверена отдельным агентом-скептиком с установкой «опровергнуть» (дефолт при неопределённости — refuted).
5. **Completeness-critic**: финальный агент искал пропущенные классы проблем и дыры покрытия.

Объём: 42 агента, ~2.0M токенов субагентов, 354 tool-вызова. Механическая статистика перепроверена скриптами напрямую по исходникам.

## Executive summary

1. **Каталог компилируется идеально, но рантайм-хрупок**: 99/100 компонентов публикуются без ошибок, при этом **19 blocker-находок — гарантированные краши рендера** при валидных по схеме доках (все подтверждены verify). Корневая причина одна: **Renderer не применяет zod-дефолты**, а 51 компонент из 100 написан так, будто применяет.
2. **39/100 компонентов имеют серьёзные (blocker/major) проблемы**; 43 полностью чистые.
3. **ABI-адопция минимальна**: `space()`-токены (ABI v3) используют 3 компонента, runtime v2 — 25, **72 компонента не используют runtime вообще** — вся геометрия и палитра хардкодом.
4. **Палитра не токенизирована**: 181 уникальная строка цвета, 32 варианта теней, ~78 записей радиусов; одинаковые семантические значения записаны по-разному (вплоть до расходящихся fallback одного CSS-токена `--shadow-medium` в соседних примитивах).
5. **Definition-гигиена отстаёт**: 85/100 компонентов без множественных `examples` (страдают витрина Library и агенты), 8 стейл-описаний, 8 проблем с `atomicLevel`.
6. **Мёртвый контент на проде**: `ui-rating-stars` ссылается на retired ДС (не публикуется вовсе), 6 shadcn-демо прототипов ссылаются на удалённые builtin-компоненты. Решение (согласовано): архивировать демо и evidence-драфты, депрекейтнуть `ui-rating-stars`.
7. **Прототипы в целом здоровы**, но: `pay-app-home-v1` обрезает нижний CTA (canvasHeight), в галерее ДС экран `icon-bank` рендерит пустоту, в `cpqr-scenario` — крупный дублирующийся поддерево-фрагмент.

## Baseline-валидация (полный publish-пайплайн локально)

| Результат | Кол-во | Комментарий |
|---|---|---|
| Компоненты published OK | 99/100 | ни одной ошибки и ни одного warning пайплайна |
| Компоненты failed | 1 | `ui-rating-stars`: `retired design system reference` — мёртв и на проде |
| Прототипы imported OK | 27/33 | включая все 20 аудитированных |
| Прототипы failed | 6 | shadcn-демо: `dependency_failed` на удалённые builtin (`Stack`, `Card`, …) |

## Механический срез каталога

| Метрика | Значение |
|---|---|
| ABI v3 (`space()`) | 3: `yp-box`, `yp-block`, `yp-app-home-shell` |
| ABI v2 (`token()`/`Icon`) | 25 |
| Без runtime-импорта (v1) | 72 |
| Base64 data-URI в исходнике | `yp-random-avatar` ~143KB (22 URI), `yp-maps-review-banner` ~107KB, `yp-ctyp-payment-page` ~3KB |
| Без множественных `examples` | 85/100 |
| Stateful (`useState`/`useEffect`) | 7 |

## Систематические классы проблем

### A. Дефолты схемы не применяются рантаймом (главный класс: 77 находок в 51 компоненте, 45 серьёзных)

Renderer хранит и отдаёт props до применения zod-дефолтов, поэтому «`.default(X)`» в схеме — это только подсказка редактору. Три подкласса по механике отказа:

- **A1 — краш**: lookup/деструктуризация/метод на undefined. Примеры: `yp-text` — `const [fontSize, lineHeight] = metrics[props.size]`; `yp-crossed-amount` — `props.amount.length`; `yp-auth-phone-field` — `masks[props.tld]`; `yp-split-row` — `props.payments.map(...)`.
- **A2 — NaN-геометрия**: арифметика на undefined. Примеры: `yp-banner-mid` — `Number(props.width)`; `yp-promo-banner` — `props.width - 160`; `yp-spinner`, `yp-processing-gate`, `yp-custom-carousel`, `yp-app-home-shell`.
- **A3 — неверная ветка рендера**: `props.flag ? A : B` при задекларированном `default(true)` тихо даёт B. Примеры: `yp-screen` (fullscreen/padding), `yp-scroll-area` (bottomInset=111 — ломается главное назначение компонента), `yp-full-payment-block` (expanded), `yp-cpqr-tab-bar` (selected), `yp-shimmer` (active), `yp-animated-collapse` (isOpen).

Все фиксы — механические `?? default` / `lookup[key ?? "default"]`, строго non-breaking. Эталон паттерна уже в каталоге: `yp-box`.

### B. Ассеты в исходниках (3 компонента, ~253KB base64)

`yp-random-avatar` (22 webp), `yp-maps-review-banner` (1 webp ~107KB), `yp-ctyp-payment-page` (2 мелких). Минуют пайплайн ассетов (пиннинг, дедуп, кэширование), раздувают исходник и каждый bundle-экспорт.

### C. Токенизация палитры отсутствует

181 уникальная строка цвета, 32 тени, десятки радиусов. Конкретные несогласованности: fallback `--shadow-medium` в `yp-screen` (`0 -8px 24px rgba(0,0,0,.10)`) vs `yp-block` (`0 8px 24px rgba(0,0,0,.12)`); градиент Plus в `yp-plus-progress` (90deg) vs остальных Plus-компонентов (135deg). Тема v4 содержит только spacing-токены — цвета некуда выносить. Это кандидат №1 в продуктовые гипотезы (theme v5 + `color()` в ABI v4), не в фикс-волну.

### D. Definition-гигиена

85 компонентов без `examples` (одиночный `example`, часто `{}`); стейл-описания (8) — например, `yp-text` всё ещё «Visual parity remains blocked if YS Text font files are not provided», хотя шрифты в теме с v4; `atomicLevel` отсутствует или завышен (8, включая `yp-amount` — publish-warning и категория Other в Library).

### E. Near-duplicates

`yp-promo-banner` ≈ `yp-banner-mid`; `yp-app-home-savers` ≈ `yp-app-home-loans` (идентичные section-обёртка/бейдж/rail — verify понизил до minor: осознанный fork); `yp-panel` пересекается с `yp-screen`. Консолидация — breaking, в бэклог; для design.md нужно зафиксировать разграничение ролей.

### F. Мёртвые пропы и слоты

`yp-navigation` объявляет slots `left/center/right`, но рендерит только `children`; `yp-screen.embedded` не читается; `yp-animated-amount.from`/`forceInitialAnimation` мертвы (анимация не запускается); `yp-skeleton.m` перекрыт `margin:"0 auto"`.

### G. Прототипы

- `pay-app-home-v1`: `canvasHeight` populated-экрана меньше контента — нижний CTA витрины обрезан.
- `yp-design-system-gallery`: экран `icon-bank` рендерит пустоту (`YpIconBank` возвращает `null` при пустом `exactAssetUrl`).
- `cpqr-scenario`: экраны `qr-curtain-ready`/`qr-curtain-return` — почти полный дубль поддерева (просится компонент/переиспользование).
- Atoms-стенды местами не показывают заявленные состояния (`yp-atoms-snippet-plus-states`: 8 «состояний» визуально одинаковы).
- Flows везде в пределах лимитов; regions-нарушений не найдено.

## Дополнительные механические свипы (закрытие дыр, указанных критиком)

**Реальная экспозиция блокеров в живых доках.** Скрипт сверил все 33 дока прототипов с опасными пропами из blocker/major-находок: лишь **2 комбинации** реально опускают опасный проп — `yp-app-home-shell` без `payButtonTop` (`pay-app-home-v1`) и `yp-payment-method-card` без `surface` (`ctyp-paybox-scenario`). Вывод: блокеры — **латентные мины** для будущих доков (особенно генерируемых ИИ-агентами, которые полагаются на дефолты схемы), а не массовые поломки текущего прода. Это не снижает приоритет фиксов: контракт «дефолт в схеме = поведение в рантайме» — базовое ожидание любого автора дока.

**Слоты объявлены, но не рендерятся** (полный проход по 100 компонентам): 4 случая — `yp-navigation` (left/center/right; major из аудита), `yp-platform-modal` (content), `yp-animated-collapse` (content), `yp-tooltip` (trigger/title/subtitle/link). Два последних аудит-агенты не нашли — добавлены в фикс-волну.

**fontWeight вне шрифтовой шкалы темы** (в теме только YS Text 400/500/700): 13 компонентов используют 600/800/900 → браузер синтезирует faux-bold, типографика «плывёт» относительно реального Yandex Pay: `yp-badge` (600), `yp-cashback-badge` (800), `yp-loyalty-badge` (600, 800), `yp-screen`, `yp-cpqr-sheet-frame`, `yp-cpqr-status-bar`, `yp-best-profit-base-card-mini`, `yp-ctyp-payment-page` (600), `yp-app-home-loans/savers/vitrina/more-important` (900). Решение для фикс-волны: округлить к 700 (или добавить в тему начертания 600/900 — вопрос к理 theme v5, см. гипотезы).

**Парсибельность `example`/`examples` против схем** — закрыта baseline-импортом: publish-пайплайн валидирует каждый пример на сохранении, все 100 компонентов прошли без warning'ов.

**Используемость каталога**: топ — `yp-box` (61 вхождение), `yp-icon` (43), `yp-text` (23), `yp-payment-method-card` (19). Не используются ни в одном прототипе: `ui-rating-stars` (deprecate), `yp-app-home-surface`, `yp-ctyp-payment-page`, `yp-scroll-area`.

## Полные списки серьёзных находок

> Полный реестр всех 234 находок (включая minor/info, с evidence и фиксами по каждой): [`2026-07-20-yp-catalog-findings.md`](2026-07-20-yp-catalog-findings.md).

### Blocker-находки (все подтверждены адверсариальным verify)

| Компонент | Находка | Fix (non-breaking) |
|---|---|---|
| `yp-text` | Деструктуризация metrics[props.size] падает при undefined size | Читать через fallback на дефолт схемы: const [fontSize, lineHeight] = metrics[props.size ?? "16"]; (или metrics[props.size] ?? metrics["16"]). Non-bre |
| `yp-text` | Tag = props.as undefined -> createElement(undefined) крашит | const Tag = props.as ?? "span";. Non-breaking. |
| `yp-crossed-amount` | props.amount.length крашит при undefined amount | const amount = props.amount ?? "1 290 ₽"; далее amount.length и {amount}. Non-breaking. |
| `yp-animated-amount` | metrics[props.size] деструктуризация крашит при undefined | const [fs,lh]=metrics[props.size ?? "32"]; Non-breaking. |
| `yp-animated-amount` | props.to.split крашит при undefined to | const to = props.to ?? "990"; далее to.split(""). Non-breaking. |
| `yp-auth-phone-field` | masks[props.tld] падает при undefined tld | Брать ключ через безопасный fallback: `const phone = masks[props.tld ?? 'ru'];` (значение уже в схеме как default, non-breaking). |
| `yp-chips` | metrics[props.size] падает при undefined size | `const m=metrics[props.size ?? 'm'];` — использовать дефолт схемы через ?? fallback (non-breaking). |
| `yp-button` | Деструктуризация sizes[props.size] падает при undefined size | Ввести безопасный ключ: `const [height, radius, fontSize, pad, gap, iconSize] = sizes[props.size ?? "l"];` (совпадает с дефолтом схемы, non-breaking). |
| `yp-button` | palette!/invertedGray падают при undefined variant или state | Подставлять дефолты локально: `props.variant ?? "action"` в вычислении palette/isInvertedGray и `invertedGrayColors[state ?? "default"]` (state уже но |
| `yp-animated-button` | sizes[props.size] и props.phrases.length падают при undefined | `sizes[props.size ?? "l"]` и завести `const phrases = props.phrases ?? ["Проверяем","Оплачиваем","Почти готово"];`, использовать phrases везде вместо  |
| `yp-tooltip` | Деструктуризация offs[props.offset] падает при отсутствии offset | Безопасный ключ: const [left,tx]=offs[props.offset ?? "center"] (non-breaking, дефолт схемы не меняется). |
| `yp-spinner` | props.size без fallback ломает геометрию (NaN) | Локально const size = props.size ?? 24 и использовать во всех вычислениях и атрибутах (non-breaking). |
| `yp-processing-gate` | size undefined -> NaN-геометрия, сломанный SVG | Локальный fallback без изменения схемы: `const size = props.size ?? 40;` и использовать size во всех вычислениях/стилях (по образцу yp-box `props.mode |
| `yp-banner-list` | Краш на props.miniItems/midItems undefined (дефолты не применяются) | Читать массивы оборонительно: `const miniItems = props.miniItems ?? []; const midItems = props.midItems ?? [];` и использовать локальные переменные вм |
| `yp-promo-base` | Краш buttonStyle.border когда buttonVariant undefined | `const buttonStyle = buttonColors[props.buttonVariant] ?? buttonColors.action;` — гарантирует объект. Non-breaking. |
| `yp-app-home-shell` | Числовые geometry-пропы без ?? fallback → NaN/схлопнутый шелл | Читать каждый числовой проп с фолбэком, равным дефолту схемы: `const canvasHeight = props.canvasHeight ?? 1722; const navHeight = props.navHeight ?? 1 |
| `yp-split-row` | props.payments.map падает при expanded=true без payments | Ввести локальную константу с fallback: `const payments = props.payments ?? DEFAULT_PAYMENTS;` (продублировать массив из схемы) и мапить по ней. Non-br |
| `ui-rating-stars` | definition не соответствует контракту публикации: нет atomicLevel, поле example вместо examples | Добавить atomicLevel: "atom" и заменить одиночное `example: { value: 3 }` на `examples: { default: { value: 3 }, empty: { value: 0 }, full: { value: 5 |
| `yp-button` | YpButton: недефенсивные lookup sizes[props.size] и invertedGrayColors[state] крашат рендер | Добавить fallback без изменения схемы: `sizes[props.size ?? 'l']`, вычислять `const rawState = props.isProgress ? 'processing' : props.disabled ? 'dis |

### Major-находки

| Компонент/прототип | Находка | Verify |
|---|---|---|
| `yp-screen` | fullscreen: дефолт true не honored при undefined | ✓ |
| `yp-screen` | padding: дефолт true не honored при undefined | ✓ |
| `yp-scroll-area` | bottomInset: дефолт 111 не honored, ломается ядро компонента | ✓ |
| `yp-scroll-x` | gap: дефолт 12 не honored при undefined | ✓ |
| `yp-scroll-x` | alignItems[props.align]: lookup без fallback | ✓ |
| `yp-animated-amount` | Мёртвые пропы from и forceInitialAnimation; анимация не запускается | ✓ |
| `yp-badge` | size undefined ломает discount-ветку (NaN height, undefined fontSize) | ✓ |
| `yp-badge` | discountRate undefined даёт «−NaN%» | ✓ |
| `yp-badge` | variant undefined проваливается в discount вместо дефолтного accent | ✓ |
| `yp-discount-info-with-cashback` | hasPlus default true не применяется оборонительно — неверная ветка рендера при отсутствии пропа | ✓ |
| `yp-slide-button` | props.progress undefined даёт NaN-геометрию (сломанный рендер) | ✓ |
| `yp-custom-payment-button` | amount/currency undefined выводят «Оплатить undefined undefined» | ✓ |
| `yp-countdown` | Часы/минуты/секунды без fallback рендерят строку "undefined" | ✓ |
| `yp-shimmer` | props.active без fallback отключает шиммер (главную функцию) | ✓ |
| `yp-skeleton` | Проп m не имеет эффекта: перекрывается margin:"0 auto" | ✓ |
| `yp-processing-gate` | durationMs undefined -> setTimeout(0), мгновенный emit | ✓ |
| `yp-animated-collapse` | isOpen default true, но undefined -> схлопнут и aria-hidden | ✓ |
| `yp-navigation` | Объявлены slots left/center/right, но рендерятся только children | ✓ |
| `yp-list` | metricsByVariant[props.variant] без fallback -> undefined-метрики | ✓ |
| `yp-custom-carousel` | carouselPadding undefined -> NaN в ширине шейдов и padding трека | ✓ |
| `yp-banner-mid` | Number(props.width/height) = NaN → баннер схлопывается | ✓ |
| `yp-promo-banner` | props.width - 160 = NaN → колонка картинки ломается | ✓ |
| `yp-maps-review-banner` | Base64 webp data-URI ~146KB зашит в исходник | ✓ |
| `yp-promo-banner` | Near-duplicate с yp-banner-mid | ✓ |
| `yp-random-avatar` | 22 инлайновых base64 webp раздувают исходник до ~197 КБ, минуя пайплайн ассетов | ✓ |
| `yp-app-home-savers` | Near-duplicate компонента yp-app-home-loans: идентичная section-обёртка, бейдж-градиент и rail | ✓ |
| `yp-cpqr-widget-surface` | mode-дефолт не применяется: без mode виджет схлопывается в inactive | ✓ |
| `yp-cpqr-tab-bar` | selected-дефолт не применяется: без selected ни одна вкладка не активна | ✓ |
| `yp-payment-method-card` | surfaces[props.surface] даёт undefined-фон при опущенном surface | ✓ |
| `yp-full-payment-block` | expanded default=true не применяется → блок схлопнут и прячет methods | ✓ |
| `yp-best-profit-base-card-mini` | Не-defensive булевы пропы дают dimmed/disabled по умолчанию | ✓ |
| `yp-base-card-mini` | Не-defensive булевы пропы дают disabled-состояние по умолчанию | ✓ |
| `ui-rating-stars` | Счётчик рейтинга инкрементится без ограничения, уходит за max(5) | ✓ |
| `pay-app-home-v1` | canvasHeight populated-экрана обрезает нижний CTA витрины | ✓ |
| `yp-app-home-shell` | Числовая геометрия shell читается без ?? при .default() в схеме | ✓ |
| `yp-design-system-gallery` | Экран icon-bank рендерит пустоту (YpIconBank возвращает null при пустом exactAssetUrl) | ✓ |
| `yp-badge` | YpBadge: дефолт variant='accent' не соблюдается в рантайме, недефенсивная арифметика даёт NaN% | ✓ |
### Распределение minor/info по линзам

| Линза | minor | info |
|---|---|---|
| abi-hygiene | 10 | 7 |
| assets | 1 | 0 |
| code-quality | 27 | 18 |
| defensive-props | 31 | 1 |
| definition-quality | 27 | 10 |
| props-schema | 10 | 4 |
| prototype-doc | 25 | 7 |
## Триаж (оркестратор)

Сводка: 234 находки → после verify: **19 blocker + 37 major** (55/56 подтверждены адверсариально, 0 опровергнуто, 7 понижены), 131 minor, 47 info.

| Категория | Решение | Объём |
|---|---|---|
| **Фикс-волна A (non-breaking)** — принято | Все blocker/major класса A (defensive-доступ), вынос data-URI в ассеты (B), рендер объявленных слотов `yp-navigation`, стейл-описания и `atomicLevel` (D), согласование fallback-теней/градиентов (C-точечно), фиксы прототипов (G: canvasHeight, icon-bank, дубль-поддерево) | ~70 правок в ~45 компонентах + 3–4 прототипа |
| **Фикс-волна A' (дёшево и полезно)** — принято | `examples` для топ-используемых компонентов (по факту использования в прототипах), минорная гигиена по месту | по остаточному принципу в тех же файлах |
| **Бэклог B (breaking/продуктовое)** — отложено | Токенизация палитры (theme v5 + ABI v4 `color()`), миграция numeric spacing → токены (`yp-text`, `yp-spacer`), консолидация near-duplicates, enum для `currency`, asset-URL контракт для URL-пропов | вошло в продуктовые гипотезы |
| **Отклонено** | Хардкод-цвета как таковые (нет токенов в теме v4 — некуда выносить); `yp-spacer` numeric scale (заявленный legacy-режим с линтами); near-duplicate savers/loans (осознанный fork, verify понизил) | — |

## Мёртвый/служебный контент прода (решения согласованы с пользователем)

| Контент | Решение |
|---|---|
| `hello-world`, `checkout`, `settings`, `wireframe-demo`, `scale-demo`, `composition-demo` | архивировать (мертвы: зависят от удалённых builtin shadcn) |
| `cpqr-card-geometry-evidence`, `cpqr-mini-banner-evidence`, `cpqr-navbar-evidence`, `cpqr-payment-info-evidence`, `cpqr-success-row-evidence`, `ctyp-sticky-footer-evidence`, `atoms-selector-slice-candidate` | архивировать (отработавшие артефакты visual-regression циклов) |
| `ui-rating-stars` | deprecated (демо-компонент, ссылается на retired ДС, не публикуется) |

Эти 13 прототипов глубоко не аудитировались (решение об архивации принято до аудита).

## Следующие шаги (не выполнялись — ждут отмашки)

1. Адверсариальное ревью плана реализации (CLAUDE.md Stage 2) с учётом этого отчёта.
2. Фикс-волна A на локальном стенде (гейт: publish + скриншот-дифф с baseline), затем канарейка и батч-обновление прода, re-pin прототипов, архивации/deprecate, свежий бэкап.
3. Документы: продуктовые гипотезы, `design.md` (сырьё готово: `design-facts-agg.json`), скилл `.claude/skills/yandex-pay/`.

## Оценка полноты (completeness critic, Opus xhigh)

Вердикт критика: «Аудит по содержанию находок сильный и добросовестный: компонентное покрытие 100/100 (проверено diff-ом), defensive-props-класс отработан широко и точно… Спот-чеки не выявили ни одного пропущенного блокера-краша: severity-калибровка адекватна». Критик перечитал 10 компонентов и 2 прототипа, включая «чистые» (0 находок) — подтвердил правомерность нулей.

Указанные критиком пробелы и их закрытие:

| Пробел | Статус |
|---|---|
| Реальная экспозиция блокеров в живых доках не проверялась | **Закрыто свипом**: только 2 комбинации в проде опускают опасный проп (см. «Дополнительные свипы») |
| Sweep «слоты объявлены, но не рендерятся» несистемный | **Закрыто свипом** по всем 100: +2 новых кейса (`yp-tooltip`, `yp-animated-collapse`) |
| fontWeight вне шкалы 400/500/700 флагался точечно | **Закрыто свипом**: полный список из 13 компонентов |
| Парсибельность `examples` против strictObject-схем | **Закрыто baseline-импортом**: publish валидирует каждый пример; 100/100 без ошибок |
| Шов прототип↔компонент (slot-имена, `on`-ключи vs `events`, props vs схема) | **Закрыто**: props валидированы сервером при импорте (exact definitions); механическая сверка slot/on по всем 33 докам — 0 несоответствий |
| 7 in-scope evidence-прототипов не аудитированы | **Осознанно**: решение архивировать их принято пользователем до аудита (задекларировано в триаже) |
| Кросс-батчевые семантические кластеры-дубли (plus-glyph, status-bar, nav-bar, amount-форматтеры) ищутся только внутри батчей | **Остаточный пробел** — перенесён в фазу реализации: fix-агенты семейств получат кросс-семейный контекст; кластеризация констант войдёт в подготовку design.md |

Отдельные наблюдения критика, добавленные в бэклог находок: глиф Плюса, рендерящийся кириллической «Я» вместо фирменного знака (`yp-cashback-badge` и родственные), дублирующиеся реализации статус-бара с часами в разных семействах.

## Design-facts (сырьё для design.md)

**Топ-цвета каталога** (из 181 уникальной строки цвета):

`#fff`, `rgba(255,255,255,.98)`, `rgba(0,0,0,.86)`, `rgba(0,0,0,.5)`, `#edeff2`, `#2e2f33`, `#1f2023`, `#f3f5f7`, `#ffdc60`, `#111`, `#f2f3f5`, `#f5f7f9`, `#111214`, `#121214`, `#56c776`, `#000000d8`, `#e1e3e8`, `#777a85`, `#5c33d6`, `#f1f2f4`, `#fffffffa`, `#f0f1f3`, `var(--background-color-primary,#fff)`, `#6b47ff`, `#2c9e56`

Радиусов зафиксировано: ~78 вариантов записей; теней: 32; типографических записей: 127.
Полные агрегаты: `design-facts-agg.json`, находки: `audit-merged.json`, экспозиция: `exposure.json` (workspace аудита; при переносе в реализацию — приложить к плану фиксов).

## Приложение: повердиктный список (100 компонентов + 20 прототипов)

| id | Вердикт | Резюме |
|---|---|---|
| `ui-rating-stars` | ⚠️ | shadcn-атом рейтинга: definition не по контракту (нет atomicLevel, поле example вместо examples), счётчик уходит за max(5) без клампа, stale useState не синхронится с props, кнопка без aria-label и пу |
| `yp-amount` | ⚠️ | Оборонительный по Number/Intl (краша нет), но отсутствует atomicLevel -> publish warning + Library Other; мелкие пустые currency/amount при undefined. |
| `yp-animated-amount` | ⚠️ | Два блокера-краша (metrics[props.size], props.to.split); мёртвые пропы from/forceInitialAnimation, анимация фактически не запускается (статичный рендер). |
| `yp-animated-button` | ⚠️ | Blocker: sizes[props.size] и props.phrases.length падают при undefined; variant-дефолт не применяется (рендер secondary); код в одну строку; расхождение радиуса L. |
| `yp-animated-collapse` | ⚠️ | isOpen default true, но при undefined блок скрывается (aria-hidden + maxHeight 0); maxHeight undefined снимает кламп высоты. |
| `yp-app-home-chrome` | ⚠️ | Строгие assetUrl-пропы обязательны и безопасны; проблема — time default может быть undefined (пустой статус-бар) и литерал #fff вместо токена; 2 example (nav/tab) покрывают оба kind. |
| `yp-app-home-loans` | ⚠️ | Все пропы обязательные, доступ безопасен; thirdImageUrl optional обработан тернаром; замечание — h2 fontWeight 900 вне шкалы YS Text 400/500/700. |
| `yp-app-home-more-important` | ⚠️ | Пропы безопасны, но в example thirdTitle==fourthTitle и textOverflow:ellipsis без whiteSpace:nowrap неэффективен; fontWeight 900. |
| `yp-app-home-payment-button` | ⚠️ | В целом корректный (ABI v2, label защищён, ассет по контракту); минор — accessibleLabel не защищён, aria-label может быть undefined. |
| `yp-app-home-product` | ✅ | Все 10 пропов обязательные и используются, ProductCard/Communication defensive по optional-полям, дубликатов и мёртвых пропов нет. |
| `yp-app-home-savers` | ⚠️ | Рендер корректен и defensive, но структурно near-duplicate yp-app-home-loans (та же section/бейдж/rail) + fontWeight 900. |
| `yp-app-home-section` | ✅ | Доступ к пропам безопасен (kind/height обязательны, loading default false корректно падает в loaded-ветку); мелочь — examples только loading:true. |
| `yp-app-home-shell` | ⚠️ | Blocker: числовые geometry-пропы (canvasHeight/navHeight/feedTop/tabHeight) без ?? → NaN/схлопнутый шелл на валидном доке; защищён только feedGap; legacy singular example. |
| `yp-app-home-surface` | ✅ | Полностью оборонительный: geometry/tone — обязательные enum, lookup-таблицы безопасны; тонкие examples (только promo + savers/loans) и токены-тона на hex-фолбэках. |
| `yp-app-home-vitrina` | ⚠️ | Пропы обязательны и безопасны, но url-схема свободная строка (не asset-url), role=presentation+aria-label на инертной кнопке противоречивы, fontWeight 900 вне шкалы темы. |
| `yp-arrow-button` | ✅ | Оборонительный (state ?? default, stateStyle[...] ?? default), examples присутствуют; только info про нестандартное поле interactive. |
| `yp-auth-phone-field` | ⚠️ | BLOCKER: masks[props.tld] крашит рендер при undefined tld (нет ?? fallback); также value без ?? '' (uncontrolled). |
| `yp-badge` | ⚠️ | Много не-defensive доступов (size→NaN, discountRate→NaN%, variant→не та ветка, verticalOffset/currency), бедные examples, несогласованные имена токенов — самый проблемный в батче. |
| `yp-banner-list` | ⚠️ | Блокер: props.miniItems/midItems читаются без ?? — краш при omit (дефолты не применяются); инлайновые Mini/Mid дублируют атомы. |
| `yp-banner-mid` | ⚠️ | Major: Number(props.width/height)=NaN при omit → баннер схлопывается; ctaLabel без фоллбэка; near-duplicate с yp-promo-banner. Ассет-URL корректный. |
| `yp-banner-mini` | ⚠️ | Крэшей нет (truthy-защита), но title/subtitle рендерятся сырыми → пустой контент при omit дефолтных пропов. |
| `yp-base-card-mini` | ⚠️ | Не-defensive булевы (isSelectable/isDisabled) дают disabled+dimmed по умолчанию; near-duplicate с best-profit; расхождение цветовых фолбэков. |
| `yp-base-card-oneline` | ⚠️ | Defensive-доступ безопасен (text required), но только один example без покрытия isToken:true. |
| `yp-best-profit-base-card-mini` | ⚠️ | Не-defensive булевы дают disabled по умолчанию; мёртвый проп currency; цветовые фолбэки расходятся с соседними карточками. |
| `yp-block` | ✅ | Decorated surface, ABI v3, все обращения к props defensive; fallback теней расходится с yp-screen (вынесено в отдельную находку). |
| `yp-box` | ✅ | Эталон: ABI v3 space(), layoutNeutral+layout v1, оборонительное ?? на каждом пропе; только legacy example:{} без named examples. |
| `yp-button` | ⚠️ | Два blocker'а: деструктуризация sizes[props.size] и palette!/invertedGray падают при undefined size/variant/state; плюс минорные — description L/M/S без xs, вес 600 вне шкалы темы. |
| `yp-cashback-badge` | ⚠️ | cashbackPercent обязателен, рендер безопасен; замечания — «Я» вместо registry-ассета, фолбэк градиента чуть иной, atomicLevel molecule для одиночного бейджа сомнителен. |
| `yp-chart-informer-default` | ✅ | Оборонительный (variant[duration] ?? fallback), 7 examples покрывают весь enum, единый accent var(--color-split,#5c33d6) и track; корректно. |
| `yp-chart-informer-recurring` | ✅ | Оборонительный (segmentCount[length] ?? fallback, activeIndex через Math.min), 8 examples по осям length×product; согласован с default по стилю сегментов. |
| `yp-chart-informer-sheet` | ✅ | Одно состояние, фиксированные 4 сегмента 303×48, accessibleLabel required; стиль сегментов идентичен другим chart-informer; корректно. |
| `yp-checkbox` | ⚠️ | Не крашит, но fallback размера даёт 's'-геометрию при схемном default 'm'; variant — мёртвый литерал; ABI v2, галка-SVG общая с pseudo-radio. |
| `yp-chips` | ⚠️ | BLOCKER: metrics[props.size] крашит при undefined size; плюс dangling @keyframes yp-chip-shimmer и text-primary #000000d8 (расходится с семейством). |
| `yp-chips-group` | ✅ | Простой flex-контейнер (gap 6/8 по size, hug/fill), все доступы к props безопасны при undefined; находок нет. |
| `yp-collapsible` | ✅ | Полностью defensive (internal useState, интерполяция строк), краши исключены; смысловой дубль с yp-animated-collapse — info. |
| `yp-confetti` | ⚠️ | Minor: height/autoStart без fallback; emit в типе, но events отсутствуют в definition; defensive для startArea ок. |
| `yp-context-banner` | ✅ | Оборонительный (props.state ?? default, message/label required), named example hover есть; только info по нестандартному accessibleLabelProps. |
| `yp-countdown` | ⚠️ | Major: hours/minutes/seconds без fallback рендерят "undefined"; несогласованный fallback --text-color-primary. |
| `yp-cpqr-action-footer` | ✅ | Минимальный слот-контейнер, все доступы к props безопасны; тень/радиус совпадают с footer-блоком sheet-frame; замечаний нет (atomicLevel organism для single-slot спорен, но не баг). |
| `yp-cpqr-home-card` | ⚠️ | Defensive OK (size/surface обязательны, backgrounds покрывает enum, serviceImageGeometry с ??); только бедный единственный example не покрывает feature/qr-tile/image-состояния. |
| `yp-cpqr-sheet-frame` | ⚠️ | statusTime рендерится без fallback (пустые часы), fontWeight 600 вне шкалы темы; fixed-canvas дублирует status-bar и опускает battery; ABI чистый (type-only import). |
| `yp-cpqr-status-bar` | ⚠️ | time без fallback (пустое время) и fontWeight 600 вне шкалы; tone/surface обрабатываются оборонительно, role=img оправдан. |
| `yp-cpqr-tab-bar` | ⚠️ | major: selected-дефолт не применяется → ни одна вкладка не активна; плюс 'Circe Rounded' вне темы; url-пропсы обязательны, a11y (nav/button/aria-current) корректны. |
| `yp-cpqr-widget-surface` | ⚠️ | major: mode-дефолт active не применяется → без mode виджет схлопывается в inactive без карусели; в остальном простая слот-поверхность. |
| `yp-crossed-amount` | ⚠️ | Блокер: props.amount.length крашит при undefined; градиент зашит на фикс. координаты; минифицирован, нет examples. |
| `yp-ctyp-payment-page` | ⚠️ | Два инлайновых base64 data-URI (~5KB) минуют пайплайн ассетов (assetIds пуст); initialMethod без fallback; примеры не покрывают paycard-ветку. |
| `yp-custom-carousel` | ⚠️ | carouselPadding undefined -> NaN в ширине шейдов/padding; itemPress эмитится на клик по всему треку без role. |
| `yp-custom-payment-button` | ⚠️ | Major: amount/currency undefined выводят «Оплатить undefined undefined»; мёртвые пропы disableGosuslugiLabel/isCredlim; тёмный цвет rgb(18,23,37) расходится с батчем. |
| `yp-discount-info-with-cashback` | ⚠️ | major: props.hasPlus (default true) читается без ?? → при опущенном пропе неверная колоночная ветка рендера; плюс нет examples, organism завышен, currency свободная строка. |
| `yp-full-payment-block` | ⚠️ | Major: expanded default=true не применяется рантаймом → блок схлопывается и прячет slots.methods при опущенном пропе; fill-fallback #f2f3f5 расходится с семейством. |
| `yp-icon` | ⚠️ | Крашей нет; при undefined mode рендерит null вместо иконки; alt/aria на url-режиме неполны. |
| `yp-icon-bank` | ✅ | Эталонно defensive (?? на bank/network/width/height, guard на exactAssetUrl), литеральный ассет, есть examples plural. |
| `yp-link` | ⚠️ | Крашей нет; мелочь — colors[props.color] без fallback даёт наследуемый цвет при undefined. |
| `yp-list` | ⚠️ | metricsByVariant[props.variant] без fallback -> undefined-метрики при опущенном variant; один legacy example на 12-вариантный организм. |
| `yp-loyalty-badge` | ⚠️ | Оба пропа обязательны, доступ безопасен; знак Плюса «Я» цветом #7b42f6 и near-duplicate discount-chevron с yp-badge — несогласованность батча. |
| `yp-maps-review-banner` | ⚠️ | Major: base64 webp ~146KB зашит в исходник (148KB, минует asset-пайплайн); emit объявлен и не используется. props.href required — краша нет. |
| `yp-material-text-field` | ⚠️ | value/type без ?? fallback → controlled/uncontrolled прыжок при undefined value; size/variant — мёртвые литералы; краша нет. |
| `yp-merchant-name` | ⚠️ | Крашей нет (guard на null/loading), но fallback primary #1f2023 расходится с батчем; atomicLevel molecule спорен. |
| `yp-navigation` | ⚠️ | Пропы-строки безопасны, но объявлены slots left/center/right, а рендерятся только children — боковые слоты нефункциональны. |
| `yp-no-pay-card-info` | ⚠️ | Пропсов нет → defensive-рисков нет; minor: fontFamily-стек с лишним Helvetica, инлайновый тип props вместо EasyUIComponentProps, atomicLevel molecule спорный. |
| `yp-notification` | ⚠️ | Пропсы required (defensive ок), рендер безопасен; minor: процессное Figma-описание, одиночный example. |
| `yp-panel` | ✅ | molecule bare-структура header/content/footer из строк, все обращения defensive; роль пересекается с yp-screen (info). |
| `yp-paybox-nav-bar` | ✅ | Defensive корректный (все cpqr-URL через truthy-проверки, geometry-фолбэк совпадает с дефолтом paybox); только info: стейл Figma-node в description и .32/.30 расхождение muted-тона. |
| `yp-payment-accrual-badge` | ⚠️ | text/accessibleLabel обязательны; iconLabel undefined→пустой alt при иконке, фолбэк text-color-primary rgba(0,0,0,.86) расходится с #111, molecule сомнителен. |
| `yp-payment-info` | ⚠️ | geometry/цена/мерчант безопасны при undefined (default-ветка = ctyp совпадает), но accessibleLabel с дефолтом даёт undefined aria-label; описание точное, ABI type-only, ассетов нет. |
| `yp-payment-method-card` | ⚠️ | Major: surfaces[props.surface] без fallback даёт прозрачный фон при опущенном surface (default white не применяется); остальные lookup-ветки совпадают с дефолтами; a11y через <button> корректна. |
| `yp-payment-method-carousel` | ✅ | Children.map(slots.default) устойчив к undefined, geometry undefined→ctyp совпадает с дефолтом; role=region+aria-label ок; лишь info-несогласованность events:[] |
| `yp-platform-modal` | ⚠️ | Строковые пропы безопасны, но platform undefined -> ветка desktop вместо mobile-default; slot 'content' объявлен, а рендерятся children. |
| `yp-plus-badge` | ✅ | Оборонительный (?? на amount/variant/withGradientBg/exactAssetUrl), registry-ассет Плюса, есть examples-мапа; замечание только по расхождению фолбэка plus-glyph-gradient с соседями. |
| `yp-plus-progress` | ⚠️ | Логика деления защищена, пропы обязательны или ??; главное замечание — фолбэк plus-glyph-gradient 90deg расходится с 135deg в остальном батче, плюс #edeff2 vs #f2f3f5. |
| `yp-plus-return` | ⚠️ | Числа через n()-обёртку безопасны, ветвление корректно; замечания: ✦ вместо ассета Плюса, псевдо-radio без role, лишний Helvetica в шрифт-стеке, одиночный example. |
| `yp-plus-text` | ✅ | Чисто: variant/iconHeight/exactAssetUrl через ??, metric/iconSizes покрывают весь enum, children обязателен, examples присутствуют. |
| `yp-processing-gate` | ⚠️ | ABI v2, typed events; но size undefined -> NaN-геометрия SVG (blocker), durationMs undefined -> мгновенный emit, variant undefined -> цвет теряется. |
| `yp-promo-banner` | ⚠️ | Major: props.width-160=NaN при omit → колонка картинки ломается; near-duplicate с yp-banner-mid. |
| `yp-promo-base` | ⚠️ | Блокер: buttonColors[buttonVariant].border краш при omit variant + заданном buttonText; ряд цветов/радиуса/фона теряется без фоллбэков. |
| `yp-promo-tooltip` | ⚠️ | Пропсы required (defensive ок), рендер безопасен; info: Figma-описание, дублирование tooltip-поверхности с yp-tooltip. |
| `yp-pseudo-radio` | ⚠️ | Оборонителен и не крашит, но fallback text-color-primary #000000d8 расходится с checkbox/switch (#1f2023); смысловое пересечение с yp-radio-button. |
| `yp-radio-button` | ✅ | Чистый слот-фасад radio (easy-ui/runtime, typed events, namedSlots); required value/ariaLabel без дефолтов; оборонителен, находок нет. |
| `yp-random-avatar` | ⚠️ | isLoading (default false) безопасен при undefined, но 22 инлайн-base64 webp (~197 КБ) минуют пайплайн ассетов + Math.random даёт недетерминированный рендер. |
| `yp-screen` | ⚠️ | organism: дефолты fullscreen/padding не honored при undefined (major misrender), мёртвый embedded, redundant stickyShadow, несогласованный --shadow-medium, off-scale 20px. |
| `yp-scroll-area` | ⚠️ | bottomInset default 111 не honored → ломается заявленный резерв под футер (major); atomicLevel organism завышен. |
| `yp-scroll-x` | ⚠️ | alignItems[props.align] и gap читаются без fallback → неверный рендер (stretch вместо start, нулевой gap) при опущенных дефолтных пропах. |
| `yp-separator` | ✅ | Тривиальный hr без пропов, border-top через --separator-color; дефектов нет. |
| `yp-shimmer` | ⚠️ | Major: props.active без fallback отключает сам шиммер; width/height/borderRadius без fallback схлопывают размер. |
| `yp-skeleton` | ⚠️ | Major: проп m перекрыт margin:"0 auto" (нет эффекта); сырые числовые spacing-токены мимо темы; width/height без fallback. |
| `yp-slide-button` | ⚠️ | Major: props.progress undefined → NaN-геометрия; мёртвый idleBounce и стейл-описание idle-bounce/420ms; кликабельный div role=group без клавиатуры; label undefined. |
| `yp-snippet-discount` | ✅ | Оборонительный (state/discountFor через ??, text required), 6 examples парсятся схемой; state/discountFor чисто метаданные (data-*), визуально не влияют — info. |
| `yp-snippet-discount-plus` | ✅ | Оборонительный, ассет литеральный /api/assets/asset_2a90... по контракту; examples покрывает только subscription-кейс (minor), subscription — метаданный проп (info). |
| `yp-snippet-plus` | ✅ | Оборонительный (state ?? default, exactAssetUrl \|\| DEFAULT), promo меняет геометрию 366×36; 7 examples + example покрывают все 8 состояний enum; ассет по контракту. |
| `yp-spacer` | ✅ | Legacy-спейсер без ABI-импорта, size/axis читаются с ?? ; числовые размеры вне токенов, но это заявленный legacy-режим. |
| `yp-spinner` | ⚠️ | Blocker: props.size без fallback даёт NaN-геометрию; variant без fallback теряет цвет; стейл-описание и одиночный example. |
| `yp-split-discount-info` | ⚠️ | Рендер безопасен, но нет examples/покрытия isDisabled (minor); бейдж дублирует yp-discount-info-with-cashback (info); хардкод gap (info). |
| `yp-split-row` | ⚠️ | Blocker: props.payments.map крашится при expanded:true с опущенным payments (default не применяется); title/funding-дефолты дают пустой текст; asset-fallback по контракту. |
| `yp-sticky-native-footer` | ⚠️ | Пропы required (defensive не нужен), ассет через реестр — ок; расхождение CTA-фона с батчем (#111 vs #2e2f33) и текста. |
| `yp-sticky-payment-footer` | ⚠️ | Рендер безопасен (undefined-строки дают пусто), но мёртвый импорт React, только singular example и спорный atomicLevel organism. |
| `yp-success-payment-card` | ✅ | Все обязательные пропы без дефолтов, geometry undefined→ctyp-card совпадает; доступ к props безопасен; ассетов нет, цвета внутренне согласованы (#f3f5f7). |
| `yp-switch` | ✅ | Полностью оборонительный (size/activeTone/isReadOnly через сравнения), геометрия m/l корректна, токены/тень аккуратные; находок нет. |
| `yp-text` | ⚠️ | Два блокера-краша (metrics[props.size] деструктуризация и Tag=props.as undefined), стейл-примечание про YS Text, ABI v1 с сырыми числовыми margin. |
| `yp-text-field` | ⚠️ | Образцово оборонительный (?? на каждом пропе, 7 slug-examples), минорно: глобальная <style> ::placeholder, мёртвый size-литерал, три написания text-secondary. |
| `yp-tooltip` | ⚠️ | Blocker: деструктуризация offs[props.offset] крашится без offset; crossOffset без fallback даёт невалидный transform. |
| `cpqr-scenario` | ⚠️ | 5 экранов, все ссылки на компоненты/host-примитивы валидны и пропы проходят схемы (проверил enum'ы YpBox/YpText/YpButton/YpSwitch/YpPaymentMethodCard/Carousel/HomeCard/StatusBar/SheetFrame/WidgetSurfa |
| `ctyp-paybox-scenario` | ⚠️ | 3 экрана (payment/processing/success), все type валидны и в каталоге, слоты и события компонентов сопоставлены верно, пропы проходят strictObject-схемы без нарушений; regions (header/footer на @eui/Fl |
| `pay-app-home-v1` | ⚠️ | Композиция чистая (shell+named slots, без spacer-цепочек), все type/пропы валидны по схемам; но canvasHeight populated обрезает CTA витрины, второй экран недостижим (0 flows) и есть default-props-nois |
| `yp-app-home-chrome` | ✅ | nav/tab chrome, assetUrl-regex совпадает с $asset-ссылками дока, examples nav/tab полные; time имеет дефолт (продублирован в доке). |
| `yp-app-home-loans` | ✅ | 3 loan-карточки, thirdImageUrl опционален и защищён тернаром, thirdCaption опущен корректно (нет caption у 3-й). |
| `yp-app-home-more-important` | ✅ | Карусель из 4 offer-карточек, все пропы обязательные и переданы, безопасный рендер. |
| `yp-app-home-payment-button` | ✅ | Плавающая pill-кнопка, label/accessibleLabel с дефолтами и защитой ??; корректна, но label дублирует дефолт в доке. |
| `yp-app-home-product` | ✅ | Populated product-блок, все пропы обязательные и переданы, доступ к props без риска undefined. |
| `yp-app-home-savers` | ✅ | 3 saver-карточки, все пропы обязательные и присутствуют; заголовок h2 весом 900 вне тем-шкалы. |
| `yp-app-home-section` | ✅ | Скелетон-секция product/savers/loans/vitrina, доступ к пропам безопасен; мелко: нет тени (в отличие от populated) и loading-высота vitrina 766≠650. |
| `yp-app-home-shell` | ⚠️ | Organism с 4 слотами; feedGap защищён space(?? sm), но canvasHeight/navHeight/feedTop/tabHeight читаются без ?? при .default() — хрупко к отсутствию дефолтов в Renderer. |
| `yp-app-home-vitrina` | ✅ | 2×2 + широкая карточка + кнопка, все пропы переданы; фикс-высота 650 создаёт нехватку места в populated-стеке (см. prototype-doc). |
| `yp-atoms-arrow-button-states` | ✅ | 3 экрана state-matrix (default/hover/pressed) для YpArrowButton, пропы валидны, компонент дефенсивен; único замечание — no-op press-хендлер в /lastPress (info). |
| `yp-atoms-badge-caption-states` | ⚠️ | 4 варианта YpBadge валидны, но каждый экран содержит default-props-noise (8+ дефолтных пропов); тримминг блокирован недефенсивностью самого yp-badge. |
| `yp-atoms-button-states` | ⚠️ | 6 состояний YpButton inverted-gray L рендерятся корректно (state передан явно), но label/before/after/isProgress/disabled — default-props-noise. |
| `yp-atoms-chart-informer-default` | ✅ | 7 duration-вариантов, только duration+accessibleLabel, все значения в enum, компонент дефенсивен (variant[...] ?? fallback), шума нет. |
| `yp-atoms-chart-informer-recurring` | ✅ | 8 экранов (length×product) — все length/product в enum, компонент дефенсивен, чистые пропы. |
| `yp-atoms-chart-informer-sheet` | ✅ | 1 экран, только accessibleLabel, полностью соответствует схеме, дефенсивный компонент. |
| `yp-atoms-context-banner-states` | ✅ | Единственный в батче использует layout-примитив YpBox (mode col, gap lg) для стека 2 состояний YpContextBanner; пропы валидны, композиция корректна. |
| `yp-atoms-icon-bank-states` | ✅ | 2 экрана YpIconBank с литеральным /api/assets/asset_<64hex>, width/height в пределах 16-256, bank/network в enum, компонент дефенсивен (guard на exactAssetUrl). |
| `yp-atoms-notification` | ⚠️ | Валиден, ссылки/пропы корректны; canvas 375×96 против заявленной/рендеримой высоты 64 (minor), нет screen.note. |
| `yp-atoms-plus-badge-states` | ⚠️ | 3 экрана валидны, YpPlusBadge оборонительный; default-props-noise (6/7 пропов = дефолты), нет screen.note. |
| `yp-atoms-plus-text-states` | ✅ | Композиция через YpBox (col/gap/padding валидны), 3 YpPlusText с валидными `as`; #plus-icon# маркеры корректны, крашей нет. |
| `yp-atoms-promo-tooltip` | ✅ | YpBox+2 YpPromoTooltip, все обязательные пропы (variant/text/accessibleLabel) заполнены; хеджированное описание (parity pending) — info. |
| `yp-atoms-snippet-discount-plus` | ⚠️ | Валиден, но subscription:true/false рендерятся идентично (компонент меняет только data-атрибут), два «варианта» неотличимы. |
| `yp-atoms-snippet-discount-states` | ⚠️ | 1 экран на оси state(5)×discountFor(3); в компоненте оси — только data-атрибуты, визуальной разницы нет, покрытие тонкое. |
| `yp-atoms-snippet-plus-states` | ⚠️ | 8 YpSnippetPlus, все пропы валидны, но 7 из 8 состояний визуально идентичны (различается только promo) — «eight states» вводит в заблуждение (major). |
| `yp-atoms-text-field-filled-stroke` | ⚠️ | 7 экранов = 7 examples определения, YpTextField полностью оборонительный, крашей нет; default-props-noise (size/type/inputMode/mask/isClearable = дефолты). |
| `yp-design-system-gallery` | ⚠️ | Витрина 59 компонентов (по 1 на экран, 0 flows): все element.type существуют в каталоге и все проп-значения валидны по схемам; 1 major (icon-bank рендерит пусто из-за пустого exactAssetUrl) + placehol |