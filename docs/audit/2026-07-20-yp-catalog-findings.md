# Реестр находок аудита каталога yandex-pay — 2026-07-20

Полный реестр всех находок аудита (детализация к отчёту [`2026-07-20-yp-catalog-audit.md`](2026-07-20-yp-catalog-audit.md)). Источник: `audit-merged.json` (машиночитаемая форма с теми же данными). Severity указана **эффективная** (после адверсариального verify: 0 находок опровергнуто, 7 понижено). Пометка `[breaking]` — фикс ломающий, уведён в бэклог; остальные фиксы non-breaking.

**Итого: 234 находок** — 19 blocker, 37 major, 131 minor, 47 info.


## Компоненты


### Семейство `layout-primitives` (12 находок)

#### `yp-panel` — molecule bare-структура header/content/footer из строк, все обращения defensive; роль пересекается с yp-screen (info).

- **ℹ️ info** · *code-quality* — **Пересечение роли с yp-screen**
  - Evidence: yp-panel (строка 5) — `<section>` flex-column со sticky-футером, fullscreen→100vh, header/content/footer из строковых пропов; yp-screen решает ту же структурную задачу расширенно (навигация, subtitle, preFooter, тени, padding). Функции частично дублируются, что размывает выбор примитива в каталоге.
  - Fix: Зафиксировать в design.md разграничение: yp-panel — bare-структура (molecule), yp-screen — decorated organism. При консолидации возможно свести yp-panel к обёртке над yp-box (breaking).

#### `yp-screen` — organism: дефолты fullscreen/padding не honored при undefined (major misrender), мёртвый embedded, redundant stickyShadow, несогласованный --shadow-medium, off-scale 20px.

- **🟧 MAJOR** · *defensive-props* — **fullscreen: дефолт true не honored при undefined**
  - Evidence: `minHeight:props.fullscreen?"100vh":undefined` (строка 5). Схема задаёт `fullscreen:z.boolean().default(true)`, но Renderer не применяет zod-дефолты: если проп опущен в доке, `props.fullscreen===undefined` → тернарник даёт ветку false → `minHeight` не ставится, и экран НЕ занимает всю высоту вопреки задекларированному дефолту.
  - Fix: Читать оборонительно: `(props.fullscreen ?? true)?"100vh":undefined`. Non-breaking, дефолт схемы не меняется.
- **🟧 MAJOR** · *defensive-props* — **padding: дефолт true не honored при undefined**
  - Evidence: `padding:props.padding?"0 20px":0` (строка 5). Схема `padding:z.boolean().default(true)`, но при опущенном пропе `props.padding===undefined` → ветка false → `padding:0`, контент прилипает к краям экрана, хотя дефолт обещает боковые отступы.
  - Fix: `(props.padding ?? true)?"0 20px":0`. Non-breaking.
- **🟨 minor** · *code-quality* — **Несогласованный fallback токена --shadow-medium**
  - Evidence: yp-screen футер: `var(--shadow-medium,0 -8px 24px rgba(0,0,0,.10))` (строка 5); yp-block: `var(--shadow-medium,0 8px 24px rgba(0,0,0,.12))` (строка 25). Один и тот же токен `--shadow-medium` имеет два разных fallback (знак Y-смещения и альфа .10 vs .12). При отсутствии токена в теме соседние компоненты дадут визуально разную «среднюю» тень.
  - Fix: Для восходящей тени футера ввести отдельный токен-имя (напр. `--shadow-footer`) или согласовать альфу с yp-block. Non-breaking (меняется только fallback-строка).
- **🟨 minor** · *props-schema* — **Мёртвый проп embedded**
  - Evidence: В схеме объявлен `embedded:z.boolean().default(false)` и он присутствует в `example`, но в теле рендера (строка 5) `props.embedded` не читается ни разу — проп не влияет на вывод.
  - Fix: Либо задействовать `embedded` (например, отключать `minHeight:100vh` и sticky-футер во встроенном режиме), либо удалить из схемы (breaking). Non-breaking минимум — задокументировать назначение и применить его в стилях.
- **🟨 minor** · *props-schema* — **stickyShadow дублирует эффект shadow**
  - Evidence: `boxShadow:props.shadow||props.stickyShadow?"var(--shadow-medium,...)":"none"` (строка 5) — оба булевых пропа OR-ятся и дают идентичную тень; `stickyShadow` не создаёт отдельного визуального состояния, то есть проп без самостоятельного эффекта.
  - Fix: Либо развести семантику (stickyShadow — тень только при прилипании), либо оставить один проп. Non-breaking: дать stickyShadow отдельный стиль/условие.
- **ℹ️ info** · *abi-hygiene* — **Хардкод-отступ 20px вне spacing-шкалы yandex-pay**
  - Evidence: В yp-screen многократно `padding:"16px 20px"`, `"0 20px"`, `"8px 20px 20px"`, `"12px 20px"` (строка 5). Значение 20px отсутствует в шкале темы (none/xs4/sm8/md12/lg16/xl24/2xl32...), тогда как 16=lg,12=md,8=sm,24=xl попадают в шкалу. Горизонтальные 20px — off-scale.
  - Fix: Сырьё для design.md: зафиксировать 20px как продуктовый экранный gutter либо привести к xl(24)/lg(16). Правка значений визуально ломающая — оформить отдельно.

#### `yp-scroll-area` — bottomInset default 111 не honored → ломается заявленный резерв под футер (major); atomicLevel organism завышен.

- **🟧 MAJOR** · *defensive-props* — **bottomInset: дефолт 111 не honored, ломается ядро компонента**
  - Evidence: `paddingBottom: props.bottomInset` (строка 38) при `bottomInset:...default(111)`. Без применения zod-дефолтов опущенный проп даёт `paddingBottom:undefined` → 0. Тогда описанный в description «reserves the exact 111px sticky payment-footer inset so the final row remains reachable» перестаёт работать: последняя строка перекрывается фиксированным футером — это ровно тот баг, который компонент призван предотвращать.
  - Fix: `paddingBottom: props.bottomInset ?? 111`. Non-breaking.
- **🟨 minor** · *definition-quality* — **atomicLevel organism сомнителен для scroll-viewport**
  - Evidence: `atomicLevel:"organism"` (строка 11) для компонента, который лишь оборачивает children в скроллируемый `<main>` с paddingBottom. Это структурный контейнер уровня atom/molecule, а не organism (в отличие от yp-screen, у которого навигация+футер+контент).
  - Fix: Понизить до `molecule` (или `atom`). Non-breaking изменение метаданных.

#### `yp-scroll-x` — alignItems[props.align] и gap читаются без fallback → неверный рендер (stretch вместо start, нулевой gap) при опущенных дефолтных пропах.

- **🟧 MAJOR** · *defensive-props* — **gap: дефолт 12 не honored при undefined**
  - Evidence: `gap:props.gap` во внутреннем flex (строка 22) при `gap:z.number().min(0).max(64).default(12)`. При опущенном пропе `props.gap===undefined` → CSS `gap` не задаётся → элементы слипаются без зазора, вопреки дефолту 12.
  - Fix: `gap:props.gap ?? 12`. Non-breaking.
- **🟧 MAJOR** · *defensive-props* — **alignItems[props.align]: lookup без fallback**
  - Evidence: `alignItems:alignItems[props.align]` (строка 22), где `alignItems={start,center,end}`. При опущенном `align` (дефолт "start") `props.align===undefined` → `alignItems[undefined]===undefined` → CSS align-items не задаётся и flex по умолчанию растягивает элементы (stretch) вместо flex-start. Эталонный yp-box делает `jc[props.justify ?? "start"]` — здесь fallback пропущен.
  - Fix: `alignItems[props.align ?? "start"]`. Non-breaking.

#### `yp-spacer` — Legacy-спейсер без ABI-импорта, size/axis читаются с ?? ; числовые размеры вне токенов, но это заявленный legacy-режим.

- **ℹ️ info** · *abi-hygiene* — **Числовые размеры вне spacing-токенов (осознанно legacy)**
  - Evidence: `size:z.union([...4,8,12,16,20,24...])` и прямое `width/height:size` (строки 6,27-30) минуют space-токены темы. Description честно помечает: «for legacy documents; prefer gap on the parent», а `layout:{spacer:true}` активирует продуктовые линты spacer-heavy/legacy-numeric-spacing.
  - Fix: Оставить как есть для обратной совместимости; новые макеты направлять на gap родителя (yp-box). Изменение шкалы на токены — breaking.


### Семейство `typography-amounts` (22 находок)

#### `yp-amount` — Оборонительный по Number/Intl (краша нет), но отсутствует atomicLevel -> publish warning + Library Other; мелкие пустые currency/amount при undefined.

- **🟨 minor** · *defensive-props* — **currency undefined -> пустой символ валюты**
  - Evidence: Строки 32-33: sign = currencyFallback[props.currency] || props.currency. При undefined currency (у currency есть .min(1).default("RUB"), но дефолт не применяется) currencyFallback[undefined] || undefined === undefined; Intl в try бросает и ловится catch -> sign остаётся undefined, символ валюты не рендерится.
  - Fix: const currency = props.currency || "RUB"; далее использовать currency. Non-breaking.
- **🟨 minor** · *defensive-props* — **amount undefined -> пустое значение**
  - Evidence: Строки 22-24: Number(undefined) === NaN -> displayAmount возвращает raw (undefined) -> {value} рендерит пусто. Не краш (Number/Intl терпимы), но пустая сумма при отсутствии amount.
  - Fix: displayAmount(props.amount ?? "0", ...). Non-breaking.
- **🟨 minor** · *definition-quality* — **Отсутствует atomicLevel -> publish warning + классификация Other** (понижена verify)
  - Evidence: Строки 4-17: definition без поля atomicLevel (в отличие от остальных компонентов батча). По server-api.md publish без уровня возвращает warning 'Atomic design level is not provided' и Library классифицирует как Other.
  - Fix: Добавить atomicLevel: "atom" as const. Non-breaking.

#### `yp-animated-amount` — Два блокера-краша (metrics[props.size], props.to.split); мёртвые пропы from/forceInitialAnimation, анимация фактически не запускается (статичный рендер).

- **🟥 BLOCKER** · *defensive-props* — **metrics[props.size] деструктуризация крашит при undefined**
  - Evidence: Строка 6: const [fs,lh]=metrics[props.size]. size .default("32") не применяется -> metrics[undefined] undefined -> TypeError при деструктуризации.
  - Fix: const [fs,lh]=metrics[props.size ?? "32"]; Non-breaking.
- **🟥 BLOCKER** · *defensive-props* — **props.to.split крашит при undefined to**
  - Evidence: Строка 6: props.to.split("").map(...). to .default("990") не применяется -> undefined.split бросает TypeError.
  - Fix: const to = props.to ?? "990"; далее to.split(""). Non-breaking.
- **🟧 MAJOR** · *props-schema* — **Мёртвые пропы from и forceInitialAnimation; анимация не запускается**
  - Evidence: Строка 3 объявляет from и forceInitialAnimation, но в рендере (строки 5-6) они нигде не используются — props.from/props.forceInitialAnimation не читаются. Drum рендерит статичный translateY(-h*5) без смены состояния, поэтому transition (750ms cubic-bezier) никогда не срабатывает: 'slot-machine' анимация из description фактически не воспроизводится, показывается только целевое число.
  - Fix: Либо реализовать анимацию from->to (стартовать с translateY по from, затем к to через useEffect/state, учитывая forceInitialAnimation), либо честно описать статичное поведение. Удаление пропов было бы breaking; фикс поведения non-breaking.
- **🟨 minor** · *defensive-props* — **currency undefined -> пустой символ**
  - Evidence: Строка 6: signs[props.currency]||props.currency. При undefined -> undefined, символ валюты пустой.
  - Fix: const currency = props.currency ?? "RUB"; signs[currency]||currency. Non-breaking.

#### `yp-crossed-amount` — Блокер: props.amount.length крашит при undefined; градиент зашит на фикс. координаты; минифицирован, нет examples.

- **🟥 BLOCKER** · *defensive-props* — **props.amount.length крашит при undefined amount**
  - Evidence: Строка 5: const w=Math.max(58,props.amount.length*8). amount имеет .default("1 290 ₽"), но без применения дефолтов props.amount может быть undefined -> undefined.length бросает TypeError и рушит рендер.
  - Fix: const amount = props.amount ?? "1 290 ₽"; далее amount.length и {amount}. Non-breaking.
- **🟨 minor** · *code-quality* — **Градиент зашит на userSpaceOnUse x2=65 при переменной ширине**
  - Evidence: Строка 5: linearGradient x1=1 x2=65 gradientUnits=userSpaceOnUse, а w=Math.max(58,amount.length*8) переменная -> для длинных сумм градиент обрывается/повторяется в фиксированных координатах, не растягиваясь на всю линию.
  - Fix: Использовать objectBoundingBox (gradientUnits по умолчанию, x1=0 x2=1) либо пересчитывать x2 от w. Non-breaking.
- **🟨 minor** · *definition-quality* — **Один legacy example, нет examples; минифицированный исходник**
  - Evidence: Строка 3: единственный example, поле examples отсутствует; весь компонент в одну минифицированную строку (строки 3-5) — снижает читаемость/ревью.
  - Fix: Добавить examples для коротких/длинных сумм; при желании разбить минификацию. Non-breaking.

#### `yp-icon` — Крашей нет; при undefined mode рендерит null вместо иконки; alt/aria на url-режиме неполны.

- **🟨 minor** · *code-quality* — **alt={props.label} undefined и aria на url-режиме**
  - Evidence: Строка 17: <img alt={props.label}> — при undefined label alt отсутствует (a11y). В url-режиме нет aria-hidden как у sprite-ветки.
  - Fix: alt={props.label ?? ""}; при пустом label добавить aria-hidden и на img/button. Non-breaking.
- **🟨 minor** · *defensive-props* — **mode undefined -> компонент рендерит null**
  - Evidence: Строки 16-22: ветки проверяют props.mode==="url" и props.mode==="sprite". mode .default("sprite") не применяется -> при undefined mode обе ветки ложны, return null: иконка не рисуется, хотя sprite/url заданы.
  - Fix: const mode = props.mode ?? "sprite"; использовать mode в ветках. Non-breaking.

#### `yp-link` — Крашей нет; мелочь — colors[props.color] без fallback даёт наследуемый цвет при undefined.

- **🟨 minor** · *defensive-props* — **colors[props.color] без fallback**
  - Evidence: Строка 13: color: colors[props.color]. При undefined color (дефолт 'normal' не применяется) -> colors[undefined] undefined -> цвет наследуется вместо link-цвета. Не краш.
  - Fix: color: colors[props.color] ?? colors.normal. Non-breaking.

#### `yp-merchant-name` — Крашей нет (guard на null/loading), но fallback primary #1f2023 расходится с батчем; atomicLevel molecule спорен.

- **🟨 minor** · *code-quality* — **Расхождение fallback-цвета primary (#1f2023) с остальным батчем**
  - Evidence: Строка 20: color: var(--text-color-primary,#1f2023). В yp-text/yp-animated-amount тот же токен имеет fallback #000000d8, в yp-amount — var(--foreground,#111). Три разных fallback для одного семантического primary-цвета в соседних компонентах.
  - Fix: Согласовать fallback одного токена (например #000000d8 как в yp-text) во всём семействе. Non-breaking.
- **ℹ️ info** · *definition-quality* — **atomicLevel molecule для одиночного текста/скелетона**
  - Evidence: Строка 11: atomicLevel: 'molecule'. Компонент — один <span> текста или скелетон-плашка, ближе к atom; сомнительная классификация.
  - Fix: Рассмотреть atomicLevel: 'atom'. Non-breaking, но влияет на группировку в Library.
- **ℹ️ info** · *props-schema* — **isLoading/merchantName без дефолтов (editor-controls)**
  - Evidence: Строки 6-7: isLoading z.boolean() и merchantName z.string().nullable() без .default() — оба обязательны в strictObject, editor не получит удобных значений по умолчанию.
  - Fix: Добавить .default(false) / .default("...") или .optional() для controls (не сужая типы). Non-breaking.

#### `yp-text` — Два блокера-краша (metrics[props.size] деструктуризация и Tag=props.as undefined), стейл-примечание про YS Text, ABI v1 с сырыми числовыми margin.

- **🟥 BLOCKER** · *defensive-props* — **Деструктуризация metrics[props.size] падает при undefined size**
  - Evidence: Строка 29: const [fontSize, lineHeight] = metrics[props.size]. size имеет .default("16"), но Renderer НЕ применяет zod-дефолты — при доке без size приходит undefined, metrics[undefined] === undefined, деструктуризация массива из undefined бросает TypeError и рушит рендер (тот же класс бага из ТЗ).
  - Fix: Читать через fallback на дефолт схемы: const [fontSize, lineHeight] = metrics[props.size ?? "16"]; (или metrics[props.size] ?? metrics["16"]). Non-breaking.
- **🟥 BLOCKER** · *defensive-props* — **Tag = props.as undefined -> createElement(undefined) крашит**
  - Evidence: Строки 29,31: const Tag = props.as; ... return <Tag ...>. as имеет .default("span"), но без применения дефолтов props.as может быть undefined; рендер <undefined> даёт React 'Element type is invalid' и падение.
  - Fix: const Tag = props.as ?? "span";. Non-breaking.
- **🟨 minor** · *defensive-props* — **colors[props.color] без fallback -> undefined цвет**
  - Evidence: Строка 30: color: colors[props.color]. При undefined color (дефолт не применён) colors[undefined] === undefined -> CSS color игнорируется (наследование) вместо primary. Не краш, но неверный цвет.
  - Fix: color: colors[props.color] ?? colors.primary. Non-breaking.
- **🟨 minor** · *definition-quality* — **Стейл-примечание в description про недоступность YS Text** (понижена verify)
  - Evidence: Строка 20: '...Visual parity remains blocked if YS Text font files are not provided by the host page.' Шрифты YS Text 400/500/700 давно в теме yandex-pay v4 — примечание устарело и вводит в заблуждение.
  - Fix: Убрать хвост про 'blocked if YS Text font files are not provided'; описать реальное поведение (шрифт из темы). Non-breaking (правка текста description).
- **🟨 minor** · *definition-quality* — **Только один legacy example, нет named examples**
  - Evidence: Строка 21: единственный legacy example; поле examples отсутствует. Компонент с ~40 пропами (size/color/align/overflow/italic) покрыт одним набором — состояния ellipsis, bold, invert-цвета, заголовки h1-h4 не показаны.
  - Fix: Добавить definition.examples (slug-ключи, <=8): напр. heading, ellipsis, invert, muted. Каждый парсится props-схемой. Non-breaking.
- **ℹ️ info** `[breaking]` · *abi-hygiene* — **ABI v1 (без easy-ui/runtime), сырые числовые margin вместо space-токенов**
  - Evidence: Строки 1-2 импортируют только zod и BaseComponentProps; space(props) (строка 27) кладёт сырые числа в margin/gap (напр. s.margin = props.m -> px). Это legacy-numeric-spacing относительно space()-токенов темы, но пропы существующие — ломающая правка.
  - Fix: Для новых внутренних отступов использовать space() (ABI v3); существующие числовые spacing-пропы не трогать. Ломающий перевод шкалы на токены — breaking, отдельно.


### Семейство `badges-plus-loyalty` (15 находок)

#### `yp-badge` — Много не-defensive доступов (size→NaN, discountRate→NaN%, variant→не та ветка, verticalOffset/currency), бедные examples, несогласованные имена токенов — самый проблемный в батче.

- **🟧 MAJOR** · *defensive-props* — **size undefined ломает discount-ветку (NaN height, undefined fontSize)**
  - Evidence: L40-41: `const legacySize = props.size === "s" || props.size === "m" ? "14" : props.size; const height = Number(legacySize); const fontSize = fontSizes[legacySize];`. size имеет .default("14"), но Renderer дефолты не применяет → при валидном доке с variant:"discount" и опущенным size приходит undefined → legacySize=undefined, Number(undefined)=NaN (minHeight:NaN), fontSizes[undefined]=undefined (fontSize отваливается на inherited). Бейдж рендерится в неправильном размере.
  - Fix: Ввести локальный безопасный fallback: `const size = props.size ?? "14";` и далее считать legacySize/height/fontSize от него (по образцу yp-box, где на каждом пропе стоит ??). Пропы и схему не трогаем.
- **🟧 MAJOR** · *defensive-props* — **discountRate undefined даёт «−NaN%»**
  - Evidence: L42-43: `const percent = Math.round(props.discountRate * 10000) / 100; ... `${props.isMarketing ? "до " : ""}${sign}${percent}%``. discountRate .default(0.1) не применяется Renderer'ом → undefined*10000=NaN → в контент попадает строка `−NaN%` при доке без discountRate.
  - Fix: `const percent = Math.round((props.discountRate ?? 0.1) * 10000) / 100;` — безопасный fallback без изменения дефолта схемы.
- **🟧 MAJOR** · *defensive-props* — **variant undefined проваливается в discount вместо дефолтного accent**
  - Evidence: Цепочка L27-40 сравнивает props.variant с конкретными строками; ни одна не матчит undefined, поэтому исполнение доходит до L40+ (discount-ветка). Схема объявляет .default("accent"), т.е. дизайнер ожидает accent при отсутствии пропа, но фактически рендерится жёлтый discount-бейдж.
  - Fix: В начале компонента `const variant = props.variant ?? "accent";` и сравнивать с ним во всех ветках.
- **🟨 minor** · *abi-hygiene* — **Несогласованные имена токенов «инвертированного» белого и нумерации fill-color**
  - Evidence: L38 `--text-color-primary-invert-static`, L33 `--text-icon-primary-static-inverted`, при этом yp-plus-badge L87 и yp-cashback L5 используют `--text-color-primary-inverted-static` — три написания одного семантического белого. Плюс L33 `--fill-color4-400` (#56c776) против L38 `--fill-color-4-400` (#6b47ff): нумерация то с дефисом, то без.
  - Fix: Задать единые имена токенов (inverted-static, единая схема fill-color-N-400) и применить консистентно; фиксируется в design.md как token-map.
- **🟨 minor** · *defensive-props* — **verticalOffset undefined → невалидный transform translateY(undefinedpx)**
  - Evidence: L38 accent: `transform: `translateY(${props.verticalOffset}px)``. verticalOffset .default(0) не применяется → `translateY(undefinedpx)` — невалидное значение, весь transform игнорируется браузером.
  - Fix: `translateY(${props.verticalOffset ?? 0}px)`.
- **🟨 minor** · *defensive-props* — **currency undefined печатает literal 'undefined' в сумме**
  - Evidence: L43: `${sign}${props.discountAmount} ${currencySigns[props.currency] || props.currency}`. При заданном discountAmount и опущенном currency: currencySigns[undefined]=undefined, `undefined || undefined`=undefined → строка «−300 undefined».
  - Fix: `const cur = props.currency ?? "RUB";` и использовать `currencySigns[cur] || cur`.
- **🟨 minor** · *definition-quality* — **Бедное покрытие examples: одна singular-запись, ключевые ветки не показаны**
  - Evidence: L20 только `example: {variant:"noCommission", ...}`; нет `examples`-мапы. Ветки point (нужен exactAssetUrl), accent (shadow/verticalOffset), highlight, discount (size/discountRate/currency) не покрыты — в галерее компонент показывает лишь одно состояние из семи вариантов.
  - Fix: Добавить `examples` со slug-ключами accent/discount/highlight/point, каждый парсится схемой (для point указать exactAssetUrl).

#### `yp-loyalty-badge` — Оба пропа обязательны, доступ безопасен; знак Плюса «Я» цветом #7b42f6 и near-duplicate discount-chevron с yp-badge — несогласованность батча.

- **🟨 minor** · *code-quality* — **Символ Плюса как буква «Я» + свой оттенок фиолетового расходится с батчем**
  - Evidence: L5 рисует знак Плюса текстом: `<span aria-hidden style={{fontWeight:800,color:"#7b42f6"}}>Я</span>`, тогда как yp-plus-badge/yp-plus-text используют registry-ассет asset_2a907dc8… как символ Плюса, yp-plus-return — символ ✦, yp-cashback — «Я» белым. Четыре разных представления одного знака; #7b42f6 — ещё один оттенок фиолетового рядом с #6b47ff и #8b3dff.
  - Fix: Свести представление знака Плюса к единому подходу (предпочтительно registry-ассет, как в yp-plus-badge) и единому фиолетовому; наблюдение для design.md.
- **ℹ️ info** · *code-quality* — **Near-duplicate жёлтого discount-бейджа с yp-badge (разный clipPath)**
  - Evidence: yp-loyalty-badge L5 discount-ветка: `background:var(--text-product-split,#ffdc60),fontStyle:italic,fontWeight:600,clipPath:polygon(8% 0,92% 0,100% 50%,92% 100%,8% 100%,0 50%)` — почти идентична yp-badge L44, но там polygon(5% 0,95% 0,...). Одинаковый по смыслу элемент нарисован двумя чуть разными clipPath.
  - Fix: Выделить общий discount-chevron или согласовать геометрию clipPath; кандидат на переиспользование.

#### `yp-payment-accrual-badge` — text/accessibleLabel обязательны; iconLabel undefined→пустой alt при иконке, фолбэк text-color-primary rgba(0,0,0,.86) расходится с #111, molecule сомнителен.

- **🟨 minor** · *abi-hygiene* — **Фолбэк --text-color-primary расходится с батчем (rgba(0,0,0,.86) vs #111)**
  - Evidence: L38: `color: var(--text-color-primary, rgba(0,0,0,.86))`. В yp-plus-text L38, yp-plus-progress L5, yp-loyalty-badge L5 тот же токен имеет фолбэк `#111`. Разные значения фактически рендерятся (в теме нет цветовых токенов).
  - Fix: Выровнять фолбэк основного текста к единому значению (#111 либо rgba(0,0,0,.86)) во всём семействе.
- **🟨 minor** · *defensive-props* — **iconLabel undefined → alt='' при наличии иконки (a11y)**
  - Evidence: L50-51: `<img src={props.iconUrl} alt={props.iconLabel} .../>`. iconLabel имеет .default("Знак баллов Яндекса"), но Renderer дефолт не применяет → при заданном iconUrl и опущенном iconLabel alt становится undefined (пустой alt у смысловой иконки).
  - Fix: `alt={props.iconLabel ?? "Знак баллов Яндекса"}`.
- **🟨 minor** · *definition-quality* — **atomicLevel molecule сомнителен для одиночной капсулы**
  - Evidence: L13 `atomicLevel:"molecule"`, но компонент — единственный span с текстом и опциональной иконкой (L26-55), без вложенной композиции нескольких сущностей. Ближе к atom. Аналогичное сомнение к yp-cashback-badge (molecule для одного бейджа).
  - Fix: Пересмотреть atomicLevel на atom для одиночных бейджей; гигиена каталога.

#### `yp-plus-progress` — Логика деления защищена, пропы обязательны или ??; главное замечание — фолбэк plus-glyph-gradient 90deg расходится с 135deg в остальном батче, плюс #edeff2 vs #f2f3f5.

- **🟨 minor** · *abi-hygiene* — **Фолбэк --plus-glyph-gradient расходится с остальным батчем (90deg vs 135deg)** (понижена verify)
  - Evidence: L5: `var(--plus-glyph-gradient,linear-gradient(90deg,#ff2e93,#8b3dff,#3277ff))`. В yp-plus-badge L54 тот же токен = `linear-gradient(135deg, #ff2e93 0%, #8b3dff 52%, #3277ff 100%)`, в yp-cashback-badge L5 = `linear-gradient(135deg,#ff2e93,#8b3dff 52%,#3277ff)`. Тема yandex-pay v4 не содержит цветовых токенов, поэтому CSS-var всегда undefined и фактически рендерится фолбэк — один и тот же семантический градиент выглядит по-разному (угол 90° против 135°, разные позиции стопов).
  - Fix: Согласовать литерал во всех трёх компонентах (единый угол 135° и позиции стопов #ff2e93 0% / #8b3dff 52% / #3277ff 100%); сырьё для design.md.

#### `yp-plus-return` — Числа через n()-обёртку безопасны, ветвление корректно; замечания: ✦ вместо ассета Плюса, псевдо-radio без role, лишний Helvetica в шрифт-стеке, одиночный example.

- **🟨 minor** · *abi-hygiene* — **Фолбэк --fill-color-default-50 расходится (#f2f3f5 vs #edeff2)**
  - Evidence: yp-plus-return L6 дважды использует `var(--fill-color-default-50,#f2f3f5)`, а yp-plus-progress L5 — `var(--fill-color-default-50,#edeff2)`. Токен одинаковый, фолбэк (который и рендерится, т.к. цветовых токенов в теме нет) разный.
  - Fix: Свести к одному значению фолбэка для --fill-color-default-50 по всему семейству.
- **🟨 minor** · *code-quality* — **Псевдо-radio индикатор без role и fontFamily расходится с батчем**
  - Evidence: L6 в кнопке pay-offer: `<span>{props.payOfferSelected?"●":"○"}</span>` — состояние выбора передаётся только символом, без role="radio"/aria-checked. Также fontFamily здесь `'YS Text','Helvetica Neue','Helvetica','Arial'` (лишний 'Helvetica') против `'YS Text','Helvetica Neue','Arial'` в остальном батче.
  - Fix: Добавить aria-checked/role на индикатор выбора; выровнять fontFamily-стек к общему по семейству.


### Семейство `snippets-informers` (11 находок)

#### `yp-discount-info-with-cashback` — major: props.hasPlus (default true) читается без ?? → при опущенном пропе неверная колоночная ветка рендера; плюс нет examples, organism завышен, currency свободная строка.

- **🟧 MAJOR** · *defensive-props* — **hasPlus default true не применяется оборонительно — неверная ветка рендера при отсутствии пропа**
  - Evidence: Схема: hasPlus:z.boolean().default(true). В рендере ветвление else if(props.hasPlus)content=<>Скидка {badge} и кешбэк {plus} {total} баллов</>; else content=<span column>...с Плюсом</span>. Renderer НЕ применяет zod-дефолты, поэтому при доке без hasPlus проп приходит undefined → falsy → срабатывает else-ветка (двухстрочная колоночная раскладка «Скидка / и кешбэк ✦ total с Плюсом») вместо задуманного дефолтом одностроч��ого варианта. Реалистичное состояние (проп опущен) даёт визуально другой макет, чем декларированный default:true.
  - Fix: Читать проп оборонительно: const hasPlus = props.hasPlus ?? true; и использовать его в ветвлении вместо props.hasPlus. Non-breaking, схему не трогаем.
- **🟨 minor** · *definition-quality* — **Нет examples для многосостояночного организма**
  - Evidence: description: «...summary with Plus, VTB, limit, disabled, and details-link states», но в definition только example (singular) с одним набором пропов; блока examples нет. Ключевые состояния (VTB, limit, disabled, hasPlus=false, detailsHref) в примерах не покрыты — редактор/галерея не показывают вариативность.
  - Fix: Добавить examples (<=8, slug-ключи) для vtb / limit / disabled / no-plus / details-link, каждый парсящийся текущей схемой. Non-breaking.
- **🟨 minor** · *definition-quality* — **atomicLevel: organism завышен для одностроч��ого текст-бейджа**
  - Evidence: atomicLevel:"organism" as const, тогда как компонент рендерит один инлайновый блок текста с бейджем скидки и глифом (<div>...<span>{content}</span></div>), без под-структуры уровня организма. Соседний по смыслу yp-split-discount-info помечен molecule.
  - Fix: Понизить atomicLevel до molecule для согласованности с yp-split-discount-info. Non-breaking (метаданные).
- **🟨 minor** `[breaking]` · *props-schema* — **currency — свободная строка вместо enum**
  - Evidence: currency:z.string().min(1), при этом money(v,c)=`${v} ${c==="RUB"?"₽":c}` спецкейсит только RUB, иначе печатает код валюты как есть. Свободная строка допускает опечатки и не даёт editor-controls выбор.
  - Fix: Рассмотреть z.enum(["RUB",...]) для currency (аналогично в yp-split-discount-info) — но это сужение схемы, ломающее существующие доки со строковыми значениями, поэтому breaking.
- **ℹ️ info** · *code-quality* — **Plus представлен глифом ✦ вместо ассета, в отличие от snippet-plus семейства**
  - Evidence: Здесь Plus = <span style={{color:"var(--plus-color,#8f42ff)",fontWeight:700}}>✦</span>, тогда как yp-snippet-plus и yp-snippet-discount-plus рисуют Plus как <img src=asset_2a907dc8...> (registry-ассет). Несогласованность представления одного бренд-символа внутри батча.
  - Fix: Наблюдение для design.md: унифицировать символ Плюса (ассет vs глиф #8f42ff). Выбор источника — отдельное решение.

#### `yp-snippet-discount` — Оборонительный (state/discountFor через ??, text required), 6 examples парсятся схемой; state/discountFor чисто метаданные (data-*), визуально не влияют — info.

- **ℹ️ info** · *props-schema* — **state и discountFor не влияют на визуальный рендер**
  - Evidence: props state/discountFor читаются оборонительно (state ?? "common", discountFor ?? "pay") и прокидываются только в data-state / data-discount-for; ни одна ветка стиля/текста от них не зависит — рендерится лишь props.text. Согласно description это намеренный facade осей без вывода ассетов/интеракций.
  - Fix: Наблюдение: если оси задумывались как визуальные — привязать к стилю; если только метаданные — оставить как есть. Действий не требуется.

#### `yp-snippet-discount-plus` — Оборонительный, ассет литеральный /api/assets/asset_2a90... по контракту; examples покрывает только subscription-кейс (minor), subscription — метаданный проп (info).

- **🟨 minor** · *definition-quality* — **examples покрывает только subscription-вариант**
  - Evidence: В examples единственный ключ subscription (subscription:true); не-subscription состояние показано лишь в example (singular). Проп subscription влияет только на data-subscription, визуально не меняет рендер, но галерея всё равно выигрывает от явного не-подписочного примера.
  - Fix: Добавить в examples не-subscription кейс (subscription:false с иным текстом). Non-breaking.
- **ℹ️ info** · *props-schema* — **subscription не влияет на визуальный рендер**
  - Evidence: subscription = props.subscription ?? false используется только в data-subscription={subscription?"yes":"no"}; ни стиль, ни разметка от пропа не зависят.
  - Fix: Наблюдение: проп чисто метаданный, как и оси в yp-snippet-discount. Действий не требуется.

#### `yp-split-discount-info` — Рендер безопасен, но нет examples/покрытия isDisabled (minor); бейдж дублирует yp-discount-info-with-cashback (info); хардкод gap (info).

- **🟨 minor** · *definition-quality* — **Нет examples и не покрыто состояние isDisabled**
  - Evidence: В definition только example:{discountAmount:"350",currency:"RUB",isDisabled:false}; блока examples нет, состояние isDisabled=true (opacity .5) в примерах не показано.
  - Fix: Добавить examples с вариантом isDisabled:true и другой валютой. Non-breaking.
- **ℹ️ info** · *abi-hygiene* — **Хардкод внутренних отступов вместо space-токенов**
  - Evidence: gap:4 (=space xs), padding:"0 6px" в бейдже — числовые px; компонент не импортирует easy-ui/runtime/v3, поэтому space() недоступен. Фиксированные Figma-габариты (h20) оправданы, но внутренние gap маппятся на токены.
  - Fix: Опционально: импортировать space из easy-ui/runtime/v3 и заменить gap:4 → space("xs") для согласованности с эталоном yp-box. Низкий приоритет, non-breaking.
- **ℹ️ info** · *code-quality* — **Бейдж скидки дублируется с yp-discount-info-with-cashback**
  - Evidence: Оба компонента рендерят идентичный бейдж: height:20, padding:"0 6px", borderRadius:6, background:"var(--badge-color-discount,#ffdc60)", fontWeight:500, color:"#1f2023", с префиксом −{amount}. Отличается только хвостовой текст («на весь заказ — в Сплит» vs «на заказ при полной оплате — с Пэй»). Константы бейджа продублированы, риск расхождения при правках.
  - Fix: Наблюдение для design.md: зафиксировать единый токен/паттерн discount-badge (жёлтый #ffdc60, radius 6, h20, pad 0 6px, weight 500). Извлечение в общий компонент — отдельная задача.


### Семейство `form-controls` (12 находок)

#### `yp-auth-phone-field` — BLOCKER: masks[props.tld] крашит рендер при undefined tld (нет ?? fallback); также value без ?? '' (uncontrolled).

- **🟥 BLOCKER** · *defensive-props* — **masks[props.tld] падает при undefined tld**
  - Evidence: Строка 23: `const phone = masks[props.tld];`, далее строка 26 `placeholder={phone.placeholder}` и строка 29 `{props.error || phone.mask}`. Renderer НЕ применяет zod-дефолт `tld: default('ru')`, поэтому в валидном по схеме доке без tld `masks[undefined]` === undefined, и обращение к `phone.placeholder`/`phone.mask` крашит рендер (тот же класс бага, что `metrics[props.size]`).
  - Fix: Брать ключ через безопасный fallback: `const phone = masks[props.tld ?? 'ru'];` (значение уже в схеме как default, non-breaking).

#### `yp-checkbox` — Не крашит, но fallback размера даёт 's'-геометрию при схемном default 'm'; variant — мёртвый литерал; ABI v2, галка-SVG общая с pseudo-radio.

- **🟨 minor** · *defensive-props* — **Fallback размера рендерит 's'-геометрию при default 'm'**
  - Evidence: Строка 5: `const d=props.size==='m'?26:20,tick=props.size==='m'?13:10`. Схема декларирует `size default('m')` (26px), но при отсутствии size в доке (Renderer дефолт не применяет) тернарник даёт ветку 20/10 — то есть меньшую геометрию, не совпадающую с задекларированным дефолтом. Краша нет, но рендер по умолчанию неверный. Для сравнения yp-pseudo-radio (стр.24) с default 's' даёт совпадающий fallback.
  - Fix: Нормализовать вход: `const size=props.size??'m';` и вести вычисления от него, чтобы fallback совпадал с дефолтом схемы. Non-breaking.
- **🟨 minor** · *props-schema* — **Проп variant — z.literal('default') без эффекта**
  - Evidence: Строка 3: `variant:z.literal('default').default('default')` объявлен в схеме, но в теле компонента (стр.5) `props.variant` нигде не читается. Проп с единственным значением и без влияния на рендер.
  - Fix: Оставить для обратной совместимости, но пометить в docs как зарезервированный/no-op; при будущей мажорной версии — удалить (breaking). Немедленных non-breaking правок не требует.

#### `yp-chips` — BLOCKER: metrics[props.size] крашит при undefined size; плюс dangling @keyframes yp-chip-shimmer и text-primary #000000d8 (расходится с семейством).

- **🟥 BLOCKER** · *defensive-props* — **metrics[props.size] падает при undefined size**
  - Evidence: Строка 24: `const m=metrics[props.size], loading=...`; далее используются `m.gap`, `m.minWidth`, `m.height`, `m.radius`, `m.font`, `m.line`. Дефолт `size: default('m')` Renderer'ом не применяется, поэтому при доке без size `metrics[undefined]` === undefined и чтение `m.*` крашит компонент.
  - Fix: `const m=metrics[props.size ?? 'm'];` — использовать дефолт схемы через ?? fallback (non-breaking).
- **🟨 minor** · *abi-hygiene* — **text-color-primary записан как #000000d8 (расходится с #1f2023)**
  - Evidence: Строка 25: `color:'var(--text-color-primary,#000000d8)'`. В соседях батча (yp-checkbox стр.5, yp-switch стр.58, yp-text-field стр.158) тот же семантический токен --text-color-primary имеет fallback `#1f2023`. Один смысл — два разных hardcoded-значения.
  - Fix: Привести fallback к единому значению `#1f2023` во всём семействе (или задокументировать в design.md какое каноническое). Non-breaking правка литерала fallback.
- **🟨 minor** · *code-quality* — **Ссылка на @keyframes yp-chip-shimmer без определения**
  - Evidence: Строка 26: скелетон использует `animation:'yp-chip-shimmer 1s infinite alternate'`, но keyframes `yp-chip-shimmer` в модуле не объявлены (нет <style>/@keyframes). Если глобально они не определены — анимация загрузки молча не работает (краша нет).
  - Fix: Добавить локальный `<style>{'@keyframes yp-chip-shimmer{from{opacity:1}to{opacity:.5}}'}</style>` внутри компонента, чтобы скелетон анимировался независимо от глобального CSS.

#### `yp-material-text-field` — value/type без ?? fallback → controlled/uncontrolled прыжок при undefined value; size/variant — мёртвые литералы; краша нет.

- **🟨 minor** · *defensive-props* — **input value={props.value} без ?? '' — controlled/uncontrolled прыжок**
  - Evidence: Строка 5: `<input ... value={props.value} .../>`. Дефолт `value default('')` не применяется Renderer'ом, поэтому при доке без value React получает `value={undefined}` → инпут становится uncontrolled, а после первого ввода — controlled, с варнингом и потенциально потерянным первым символом. Соседний yp-text-field (стр.166) защищён `value={props.value ?? ''}`.
  - Fix: `value={props.value ?? ''}` (и `type={props.type ?? 'text'}` для единообразия). Non-breaking.
- **🟨 minor** · *props-schema* — **Пропы size/variant — одиночные литералы без эффекта**
  - Evidence: Строка 3: `size:z.literal('m')` и `variant:z.literal('filled')` объявлены, но в рендере (стр.5) не используются. Мёртвые пропы с единственным значением.
  - Fix: Оставить для совместимости; задокументировать как зарезервированные. Удаление — breaking, немедленно не требуется.

#### `yp-pseudo-radio` — Оборонителен и не крашит, но fallback text-color-primary #000000d8 расходится с checkbox/switch (#1f2023); смысловое пересечение с yp-radio-button.

- **🟨 minor** · *abi-hygiene* — **text-color-primary fallback #000000d8 расходится с checkbox/switch**
  - Evidence: Строка 26: `color:'var(--text-color-primary,#000000d8)'`, тогда как визуально-родственный yp-checkbox (стр.5) для того же токена использует `#1f2023`. Компоненты выглядят как пара, но fallback-цвет текста разный.
  - Fix: Синхронизировать fallback text-color-primary в pseudo-radio и checkbox (единое значение #1f2023). Non-breaking.
- **ℹ️ info** · *code-quality* — **Смысловое пересечение с yp-radio-button**
  - Evidence: Оба компонента — role='radio': yp-radio-button (стр.36) — фасад со слотом content и typed-событием value-identity; yp-pseudo-radio (стр.26) — самостоятельный визуальный radio с label и SVG-галкой. Не полные дубли (разные API), но в каталоге две сущности 'radio' плюс общая галка-SVG с yp-checkbox.
  - Fix: Задокументировать в design.md разграничение ролей (radio-button = слот-фасад для групп, pseudo-radio = автономный визуал). Правок кода не требует.

#### `yp-text-field` — Образцово оборонительный (?? на каждом пропе, 7 slug-examples), минорно: глобальная <style> ::placeholder, мёртвый size-литерал, три написания text-secondary.

- **🟨 minor** · *code-quality* — **Глобальная инъекция ::placeholder через <style> и мёртвый size-литерал**
  - Evidence: Строка 142: `<style>{'[data-yp-text-field]::placeholder{color:var(--text-color-secondary,#767779);opacity:1}'}</style>` вставляет неизолированное глобальное правило (селектор по атрибуту снижает риск, но правило всё же document-wide). Плюс строка 22 `size:z.literal('xl')` — одиночный литерал, не влияет на рендер. Остальной компонент образцово оборонительный (?? на каждом пропе).
  - Fix: Оставить <style> (работает), но осознавать глобальность; при желании — сузить селектор до уникального класса инстанса. Мёртвый size оставить для совместимости. Non-breaking.
- **ℹ️ info** · *abi-hygiene* — **text-color-secondary записан тремя разными значениями**
  - Evidence: В пределах компонента --text-color-secondary имеет разные fallback: `#767779` (placeholder, стр.142), `#6b6d74` (кнопка очистки, стр.192) и `#777` (hint, стр.207). Один семантический токен — три литерала.
  - Fix: Свести fallback text-color-secondary к одному значению по всему семейству (сырьё для design.md). Non-breaking.


### Семейство `buttons` (18 находок)

#### `yp-animated-button` — Blocker: sizes[props.size] и props.phrases.length падают при undefined; variant-дефолт не применяется (рендер secondary); код в одну строку; расхождение радиуса L.

- **🟥 BLOCKER** · *defensive-props* — **sizes[props.size] и props.phrases.length падают при undefined**
  - Evidence: Строка 5-6: `const [h,r,fs,p]=sizes[props.size];` — при undefined size деструктуризация undefined → TypeError. Строка 6: `const active=props.isAnimated&&props.isProgress&&props.phrases.length>0;` — при isAnimated=true,isProgress=true и пропущенном phrases (`.default([...])` не применяется Renderer) `props.phrases.length` бросает TypeError. Также useEffect и рендер `props.phrases[idx]` зависят от phrases.
  - Fix: `sizes[props.size ?? "l"]` и завести `const phrases = props.phrases ?? ["Проверяем","Оплачиваем","Почти готово"];`, использовать phrases везде вместо props.phrases (non-breaking, совпадает с дефолтом схемы).
- **🟨 minor** · *code-quality* — **Несогласованность font-family внутри батча (Helvetica то есть, то нет)**
  - Evidence: yp-animated-button/yp-slide-button/yp-custom-payment-button/yp-app-home-payment-button используют `"'YS Text','Helvetica Neue',Helvetica,Arial,sans-serif"`, тогда как yp-button (строка 54) и yp-arrow-button (строка 82) используют `"'YS Text', 'Helvetica Neue', Arial, sans-serif"` без `Helvetica`. Один семантический стек шрифтов записан по-разному.
  - Fix: Унифицировать стек шрифтов во всех кнопках батча (одна строка-константа).
- **🟨 minor** · *defensive-props* — **variant default "action" не применяется — при undefined рендерится secondary**
  - Evidence: Строка 6: `background:props.variant==="action"?...:"var(--button-color-secondary,#edeff2)"`. Схема даёт variant `.default("action")`, но при пропущенном пропе `props.variant==="action"` ложно → кнопка рисуется как secondary вместо ожидаемого action (аналогично для color).
  - Fix: Нормализовать: `const variant = props.variant ?? "action";` и сравнивать с ним.
- **ℹ️ info** · *code-quality* — **Весь модуль в одну минифицированную строку — плохо ревьюится/диффится**
  - Evidence: Строки 4-6: definition и весь компонент записаны без переносов (одна физическая строка на définition, одна на компонент). Затрудняет ревью, диффы и локализацию будущих багов.
  - Fix: Отформатировать исходник (prettier) при следующей ревизии; поведение не меняется.
- **ℹ️ info** · *code-quality* — **Радиус L-размера расходится: 20 (animated) против 16 (button) при одинаковой высоте 56**
  - Evidence: yp-animated-button sizes (строка 5) `l:[56,20,...]` → radius 20; yp-button sizes (строка 26) `l:[56,16,...]` → radius 16. При одинаковой высоте 56px радиус кнопки разный между двумя компонентами семейства.
  - Fix: Свериться с макетом и унифицировать радиус L-кнопки в батче.

#### `yp-app-home-payment-button` — Плавающая pill-кнопка, label/accessibleLabel с дефолтами и защитой ??; корректна, но label дублирует дефолт в доке.

- **🟨 minor** · *defensive-props* — **accessibleLabel undefined → aria-label без значения**
  - Evidence: Строка 28: `aria-label={props.accessibleLabel}`. accessibleLabel имеет `.default("Оплатить")`, не применяемый Renderer; при пропущенном пропе aria-label === undefined, тогда как label в теле защищён (`props.label ?? "Оплатить"`, строка 53) — несимметрично.
  - Fix: `aria-label={props.accessibleLabel ?? "Оплатить"}`.

#### `yp-arrow-button` — Оборонительный (state ?? default, stateStyle[...] ?? default), examples присутствуют; только info про нестандартное поле interactive.

- **ℹ️ info** · *definition-quality* — **Нестандартное поле interactive в definition**
  - Evidence: Строка 34: `interactive: true` — поле не входит в известный контракт definition (props/events/slots/atomicLevel/description/examples/capabilities/accessibleLabelProps/urlProps). Скорее всего игнорируется публикацией; не подтверждено как поддерживаемое.
  - Fix: Сверить с docs/server-api.md; если поле не распознаётся — убрать, чтобы не создавать ложного впечатления о поведении.

#### `yp-button` — Два blocker'а: деструктуризация sizes[props.size] и palette!/invertedGray падают при undefined size/variant/state; плюс минорные — description L/M/S без xs, вес 600 вне шкалы темы.

- **🟥 BLOCKER** · *defensive-props* — **Деструктуризация sizes[props.size] падает при undefined size**
  - Evidence: Строка 45: `const [height, radius, fontSize, pad, gap, iconSize] = sizes[props.size];`. size имеет .default("l"), но Renderer не применяет zod-дефолты — при отсутствии size в доке `sizes[undefined]` === undefined, деструктуризация undefined выбрасывает TypeError и рушит рендер валидного по схеме прототипа.
  - Fix: Ввести безопасный ключ: `const [height, radius, fontSize, pad, gap, iconSize] = sizes[props.size ?? "l"];` (совпадает с дефолтом схемы, non-breaking).
- **🟥 BLOCKER** · *defensive-props* — **palette!/invertedGray падают при undefined variant или state**
  - Evidence: Строка 49: `const palette = props.variant === "inverted-gray" ? null : palettes[props.variant];` — при undefined variant `palettes[undefined]` === undefined, затем строка 52 `var(${palette![0]}, ...)` разыменовывает undefined → TypeError. Аналогично при variant="inverted-gray" и undefined state строка 50 `invertedGrayColors[state]` === undefined, строка 52 `invertedGray[0]` падает. Оба пропа имеют .default(), не применяемый Renderer.
  - Fix: Подставлять дефолты локально: `props.variant ?? "action"` в вычислении palette/isInvertedGray и `invertedGrayColors[state ?? "default"]` (state уже нормализуется строкой 46, но при variant=inverted-gray и явно пропущенном state он остаётся undefined — нормализовать через `?? "default"`).
- **🟨 minor** · *abi-hygiene* — **fontWeight 600 не входит в шкалу темы YS Text (400/500/700)**
  - Evidence: Строка 54: `fontWeight: isInvertedGray ? 500 : 600`. Тема yandex-pay v4 определяет YS Text только в 400/500/700; вес 600 отсутствует в шкале и рискует зарендериться синтетическим bold/несогласованно с остальным семейством кнопок (arrow/animated/slide используют 500).
  - Fix: Привести основной вес к 500 (как у соседних кнопок) либо 700, если нужен акцент; согласовать со шкалой темы.
- **🟨 minor** · *definition-quality* — **description говорит L/M/S, но size включает xs; единственный example не покрывает состояния**
  - Evidence: Строка 10: `size: z.enum(["l", "m", "s", "xs"])`, но description (строка 21) заявляет «supports L/M/S». Есть только singular `example` (строка 22) с одним variant/state, при 12 вариантах и 6 состояниях ключевые состояния (disabled/processing/skeleton, action/outline) не показаны.
  - Fix: Актуализировать description до «L/M/S/XS» и добавить набор `examples` (slug-ключи, <=8), покрывающий action/outline/inverted и processing/disabled/skeleton.

#### `yp-custom-payment-button` — Major: amount/currency undefined выводят «Оплатить undefined undefined»; мёртвые пропы disableGosuslugiLabel/isCredlim; тёмный цвет rgb(18,23,37) расходится с батчем.

- **🟧 MAJOR** · *defensive-props* — **amount/currency undefined выводят «Оплатить undefined undefined»**
  - Evidence: Строка 5: `...:`Оплатить ${props.amount} ${signs[props.currency]||props.currency}``. amount `.default("990")` и currency `.default("RUB")` не применяются Renderer: при пропущенных пропах строка становится «Оплатить undefined undefined» (signs[undefined] === undefined, `||props.currency` === undefined). Реалистичное состояние (проп не задан в доке) → вводящий в заблуждение текст.
  - Fix: `const amount = props.amount ?? "990"; const currency = props.currency ?? "RUB";` и использовать их в шаблоне.
- **🟨 minor** · *code-quality* — **Тёмный цвет кнопки выражен тремя способами в батче**
  - Evidence: yp-animated-button (строка 6) и yp-slide-button (строка 5) используют `#2e2f33` (`--fill-color-default-800`), yp-custom-payment-button (строка 5) — `rgb(18,23,37)`/`rgba(18,23,37,.5)` (#121725), yp-button inverted (строка 32) — fallback `#111`. Один семантический «тёмный primary» кнопки различается между соседними компонентами.
  - Fix: Согласовать основной тёмный цвет кнопок (одно значение/переменная) через дизайн-ревью; зафиксировать в design.md как источник расхождения.
- **🟨 minor** · *props-schema* — **Мёртвые пропы disableGosuslugiLabel и isCredlim**
  - Evidence: Строка 3: `disableGosuslugiLabel:z.boolean().default(false)` и `isCredlim:z.boolean().default(false)` объявлены, но в рендере (строка 5) не используются — не влияют на вывод.
  - Fix: Либо задействовать их в логике title/лейбла согласно исходнику, либо задокументировать как зарезервированные; удаление из схемы было бы breaking (не делать).

#### `yp-slide-button` — Major: props.progress undefined → NaN-геометрия; мёртвый idleBounce и стейл-описание idle-bounce/420ms; кликабельный div role=group без клавиатуры; label undefined.

- **🟧 MAJOR** · *defensive-props* — **props.progress undefined даёт NaN-геометрию (сломанный рендер)**
  - Evidence: Строка 5: `const p=Math.max(0,Math.min(1,props.progress));` — при пропущенном progress (`.default(0)` не применяется) `Math.min(1,undefined)` === NaN, `Math.max(0,NaN)` === NaN. Далее `x=p*319` === NaN → `transform:translateX(NaNpx)`, `op` и повороты SVG считаются от NaN — трек и knob рендерятся некорректно.
  - Fix: `const p=Math.max(0,Math.min(1,props.progress ?? 0));`
- **🟨 minor** · *code-quality* — **Кликабельный div с role="group" не доступен с клавиатуры**
  - Evidence: Строка 5: `<div ... role="group" aria-live="polite" ... onClick={()=>emit("slideFinish")}>`. role="group" неинтерактивен, у элемента нет tabIndex/keydown-обработчика и роли button — действие slideFinish недоступно с клавиатуры и не анонсируется как элемент управления.
  - Fix: Добавить интерактивную семантику: role="button", tabIndex={0} и onKeyDown (Enter/Space → emit), либо вынести действие на вложенный `<button>`.
- **🟨 minor** · *defensive-props* — **label/aria-label undefined при пропущенных пропах**
  - Evidence: Строка 5: `const label=props.byNewCard?...:props.isSbpBindingAndPaymentFullpayment?...:props.label;` — при undefined всех трёх пропов label === undefined; используется в `aria-label={label}` и как текстовое содержимое → пустая метка.
  - Fix: `...:props.label ?? "Проведите для оплаты"` (совпадает с дефолтом схемы).
- **🟨 minor** · *props-schema* — **idleBounce — мёртвый проп; description описывает несуществующую idle-анимацию**
  - Evidence: Строка 3: проп `idleBounce:z.boolean().default(true)` объявлен, но в рендере (строка 5) нигде не используется. Description заявляет «1600ms/8px idle bounce ... 420ms complete snap», однако в коде нет ни keyframes idle-bounce, ни 420ms — только `transition:"transform .3s ease-out"` (300ms).
  - Fix: Либо реализовать idle-bounce, завязанный на idleBounce, либо (non-breaking) убрать из description упоминания idle-bounce/420ms, приведя описание к фактической реализации; проп idleBounce оставить (не удалять схему), пометив как зарезервированный.


### Семейство `feedback-motion` (19 находок)

#### `yp-confetti` — Minor: height/autoStart без fallback; emit в типе, но events отсутствуют в definition; defensive для startArea ок.

- **🟨 minor** · *code-quality* — **emit в типе пропсов, но events отсутствуют в definition**
  - Evidence: Строка 26: сигнатура { props }: { props: Props; emit: (event: string) => void }, при этом definition (строки 8-20) не содержит поля events. emit объявлен, но не используется и не задекларирован — несоответствие контракту (у остальных компонентов events:[]).
  - Fix: Добавить events:[] и slots:[] в definition для явности; убрать неиспользуемый emit из типа сигнатуры.
- **🟨 minor** · *defensive-props* — **height без fallback схлопывает контейнер**
  - Evidence: Строка 38: height:props.height. height .default(280) не применяется → при доке без height контейнер div height:undefined = auto, canvas 100% высоты от 0 → эффект не виден. autoStart .default(false) тоже не применяется (строка 29 early-return), но пример использует autoStart:true.
  - Fix: height:props.height ?? 280; при желании const autoStart = props.autoStart ?? false.

#### `yp-countdown` — Major: hours/minutes/seconds без fallback рендерят "undefined"; несогласованный fallback --text-color-primary.

- **🟧 MAJOR** · *defensive-props* — **Часы/минуты/секунды без fallback рендерят строку "undefined"**
  - Evidence: Строки 30-38: pad(props.hours) где pad=v=>String(v).padStart(2,"0") → String(undefined)="undefined"; ruLabel(props.hours,...) при undefined: undefined%100=NaN, все ветки false → возвращает many. hours/minutes/seconds имеют .default() но не применяются Renderer'ом → при валидном доке без полей на экране буквально "undefined" и aria-label "undefined часов, ...".
  - Fix: Ввести const h=props.hours??0, m=props.minutes??0, s=props.seconds??0 и использовать их в cells и aria-label.
- **🟨 minor** · *definition-quality* — **Единственный example, нет граничных состояний (0/склонения)**
  - Evidence: Строки 10-11: example: { hours:4, minutes:15, seconds:59 } — один вариант; логика ruLabel (склонения) и pad не покрыты примерами вроде hours:1/minutes:0.
  - Fix: Добавить examples с 1/21 час, 0 минут для демонстрации плюрализации.
- **ℹ️ info** · *abi-hygiene* — **Несогласованный fallback для --text-color-primary (#1f1f1f)**
  - Evidence: Строки 26,35: background/color:"var(--text-color-primary,#1f1f1f)". Тот же семантический токен в этом же батче имеет разные хардкод-fallback: yp-spinner/yp-tooltip #000000d8, yp-notification #111214, yp-countdown #1f1f1f — три разных значения одного цвета.
  - Fix: Согласовать fallback одного токена по всему семейству (единая величина); сырьё для design.md.

#### `yp-notification` — Пропсы required (defensive ок), рендер безопасен; minor: процессное Figma-описание, одиночный example.

- **ℹ️ info** · *definition-quality* — **Description ссылается на внутренний Figma-node/процесс**
  - Evidence: Строки 12-14: "...from Figma Atoms node 7617:21817. The strict asset-free contract exposes only the source-proven informational message responsibility." — язык про источник/контракт вместо описания поведения.
  - Fix: Переписать в терминах поведения: фикс 375x64, двухстрочный clamp, вторичный фон, YS Text 14/18.

#### `yp-promo-tooltip` — Пропсы required (defensive ок), рендер безопасен; info: Figma-описание, дублирование tooltip-поверхности с yp-tooltip.

- **ℹ️ info** · *definition-quality* — **Description содержит Figma-node и мета-оговорки**
  - Evidence: Строки 15-16: "...facade for the two source-proven Atoms variants at Figma node 7643:54699... without inferring interactions or unavailable artwork." — процессные оговорки в описании.
  - Fix: Сжать до фактов: два варианта sbp-only/sbp-plus, тёмная tooltip-поверхность, стрелка снизу, YS Text 13/16.

#### `yp-shimmer` — Major: props.active без fallback отключает сам шиммер; width/height/borderRadius без fallback схлопывают размер.

- **🟧 MAJOR** · *defensive-props* — **props.active без fallback отключает шиммер (главную функцию)**
  - Evidence: Строка 16: {props.active ? <span .../> : null}. active .default(true) не применяется Renderer'ом → при валидном доке без active props.active===undefined (falsy) → анимированный оверлей НЕ рендерится, компонент показывает статичный фон вместо шиммера — противоречит назначению и дефолту схемы.
  - Fix: {(props.active ?? true) ? <span .../> : null}.
- **🟨 minor** · *defensive-props* — **width/height/borderRadius без fallback схлопывают размер**
  - Evidence: Строка 13: width:props.width, height:props.height, borderRadius:props.borderRadius. Дефолты ("100%"/"100%"/0) не применяются → при доке без этих полей style-значения undefined, элемент inline-span схлопывается до contentless; не краш, но неверный рендер.
  - Fix: props.width ?? "100%", props.height ?? "100%", props.borderRadius ?? 0.

#### `yp-skeleton` — Major: проп m перекрыт margin:"0 auto" (нет эффекта); сырые числовые spacing-токены мимо темы; width/height без fallback.

- **🟧 MAJOR** · *props-schema* — **Проп m не имеет эффекта: перекрывается margin:"0 auto"**
  - Evidence: Строки 14,16: space(props) кладёт s.margin=props.m, затем в style объект `{ ...space(props), display, margin: "0 auto", ... }` — литерал margin:"0 auto" всегда переопределяет shorthand из спреда. Значит проп m объявлен в схеме, но в рендере не даёт эффекта (мёртвый проп для margin-shorthand). mx/my тоже конфликтуют с margin:"0 auto" по left/right.
  - Fix: Не задавать margin:"0 auto" безусловно: заменить на marginLeft/marginRight:"auto" по умолчанию и пропускать их, если задан m/mx/ml/mr; либо перенести ...space(props) ПОСЛЕ margin:"0 auto", чтобы пользовательские отступы выигрывали (non-breaking).
- **🟨 minor** · *abi-hygiene* — **Сырые числовые spacing-токены вместо space()-шкалы темы**
  - Evidence: Строка 5,14: spacingScale = union литералов 0,1,2,3,4,6,8,10...256 (пиксели) для props m/mt/.../gap; в space() значения кладутся как есть (margin:props.m число → px). Это legacy-numeric-spacing: собственная числовая шкала не согласована с темой yandex-pay v4 (space xs=4/sm=8/md=12/lg=16/xl=24...) и эталоном yp-box (space()).
  - Fix: Для НЕ ломающего варианта оставить проп, но замапить значения на var(--eui-space-*) там, где числа совпадают со шкалой; либо задокументировать как отход от токенов (сырьё для design.md). Ломающий фикс (token-enum вместо чисел) пометить breaking.
- **🟨 minor** · *defensive-props* — **width/height без fallback схлопывают плейсхолдер**
  - Evidence: Строка 16: width:props.width, height:props.height. Дефолты ("100%"/24) не применяются Renderer'ом → при доке без полей размеры undefined, скелетон высотой 0.
  - Fix: props.width ?? "100%", props.height ?? 24.

#### `yp-spinner` — Blocker: props.size без fallback даёт NaN-геометрию; variant без fallback теряет цвет; стейл-описание и одиночный example.

- **🟥 BLOCKER** · *defensive-props* — **props.size без fallback ломает геометрию (NaN)**
  - Evidence: Строки 14-19: const stroke=Math.max(2,props.size/22); const radius=(props.size-stroke)/2; circumference=2*Math.PI*radius; viewBox=`0 0 ${props.size} ${props.size}`; width:props.size. size .default(24) не применяется — при валидном доке без size все вычисления дают NaN, viewBox="0 0 NaN NaN", width/height=NaN, спиннер не отрисовывается.
  - Fix: Локально const size = props.size ?? 24 и использовать во всех вычислениях и атрибутах (non-breaking).
- **🟨 minor** · *defensive-props* — **colorByVariant[props.variant] без fallback** (понижена verify)
  - Evidence: Строка 15: color:colorByVariant[props.variant]. variant .default("primary") не применяется → colorByVariant[undefined]===undefined, цвет currentColor не задаётся; при типизации Record<Props["variant"],string> лишний ключ undefined не покрыт.
  - Fix: color: colorByVariant[props.variant ?? "primary"].
- **🟨 minor** · *definition-quality* — **Стейл-примечание про недоступность ProgressCircle в description**
  - Evidence: Строка 7: "...Exact ProgressCircle internals remain unavailable in easy-ui." — мета-заметка о процессе портирования в пользовательском описании компонента, не относится к поведению.
  - Fix: Убрать оговорку из description, оставить фактическое описание (variant-цвета, stroke-формула, transparent track).
- **🟨 minor** · *definition-quality* — **example (singular) вместо examples, нет покрытия состояний variant/size**
  - Evidence: Строка 8: example: { variant:"primary", size:24, testId:"" } — одиночный example, тогда как контракт публикации предполагает examples (slug-ключи, до 8). Нет примеров inverse/inherit и крупного size, editor-controls обеднены.
  - Fix: Добавить examples: { primary:{...}, inverse:{...,variant:"inverse"}, large:{...,size:48} } (каждый парсится схемой).

#### `yp-tooltip` — Blocker: деструктуризация offs[props.offset] крашится без offset; crossOffset без fallback даёт невалидный transform.

- **🟥 BLOCKER** · *defensive-props* — **Деструктуризация offs[props.offset] падает при отсутствии offset**
  - Evidence: Строки 4-5: const offs={...} as const и в компоненте const [left,tx]=offs[props.offset]. props.offset имеет .default("center"), но Renderer НЕ применяет дефолты — при валидном по схеме доке без offset props.offset===undefined, offs[undefined]===undefined, деструктуризация const [left,tx]=undefined бросает TypeError и роняет рендер (классический класс бага metrics[props.size]).
  - Fix: Безопасный ключ: const [left,tx]=offs[props.offset ?? "center"] (non-breaking, дефолт схемы не меняется).
- **🟨 minor** · *defensive-props* — **crossOffset без fallback даёт невалидный transform**
  - Evidence: Строка 5: transform:`translateX(calc(${tx} + ${props.crossOffset}px))`. props.crossOffset .default(0) не применяется Renderer'ом — при undefined выходит calc(-50% + undefinedpx), невалидный transform, смещение игнорируется браузером.
  - Fix: Использовать ${props.crossOffset ?? 0}px.
- **ℹ️ info** · *code-quality* — **Дублирование tooltip-поверхности с yp-promo-tooltip**
  - Evidence: yp-tooltip (строка 5) и yp-promo-tooltip (строки 40-83) независимо рисуют одну тёмную поверхность var(--background-color-tooltip,var(--fill-color-default-800,#2e2f33)), радиус 12, стрелку 24x8 — near-duplicate стилей стрелки/фона в двух компонентах.
  - Fix: Наблюдение для консолидации (общая surface-константа/примитив); не требует немедленного фикса.


### Семейство `overlays-nav` (14 находок)

#### `yp-animated-collapse` — isOpen default true, но при undefined блок скрывается (aria-hidden + maxHeight 0); maxHeight undefined снимает кламп высоты.

- **🟧 MAJOR** · *defensive-props* — **isOpen default true, но undefined -> схлопнут и aria-hidden**
  - Evidence: Схема `isOpen: z.boolean().default(true)`. В рендере `aria-hidden={!props.isOpen}` и `maxHeight:props.isOpen?props.maxHeight:0`, `opacity:props.isOpen?1:0`, `pointerEvents:props.isOpen?"auto":"none"`. При опущенном isOpen (валидно по схеме, default true) все тернарники берут ветку false -> блок, задуманный открытым по умолчанию, рендерится скрытым.
  - Fix: `const isOpen = props.isOpen ?? true;` и использовать его во всех тернарниках.
- **🟨 minor** · *defensive-props* — **maxHeight undefined -> нет клампа высоты**
  - Evidence: `maxHeight:props.isOpen?props.maxHeight:0`: при isOpen=true и опущенном maxHeight (default 96) style.maxHeight=undefined -> ограничение высоты пропадает, анимация max-height не работает.
  - Fix: `const maxHeight = props.maxHeight ?? 96;`.

#### `yp-collapsible` — Полностью defensive (internal useState, интерполяция строк), краши исключены; смысловой дубль с yp-animated-collapse — info.

- **ℹ️ info** · *code-quality* — **Смысловой дубль с yp-animated-collapse**
  - Evidence: yp-collapsible (внутренний useState, заголовок+шеврон+reveal через grid-template-rows) и yp-animated-collapse (controlled max-height/opacity wrapper) — оба «раскрывающийся блок» в батче overlays-nav. Разное управление (internal vs controlled), но перекрывающаяся роль.
  - Fix: Свести к одному компоненту с пропом controlled/uncontrolled либо явно развести в описаниях (collapsible = self-contained строка, animated-collapse = controlled max-height обёртка).

#### `yp-custom-carousel` — carouselPadding undefined -> NaN в ширине шейдов/padding; itemPress эмитится на клик по всему треку без role.

- **🟧 MAJOR** · *defensive-props* — **carouselPadding undefined -> NaN в ширине шейдов и padding трека**
  - Evidence: `const edge = props.itemsVisibleOffTheEdges ? props.carouselPadding * 2 : props.carouselPadding;` — при опущенном carouselPadding (default 20) edge=undefined или NaN. Используется в `width:edge+10` шейдов (`NaN`px), `left:edge`/`right:edge` кнопок и `paddingLeft/paddingRight:edge` трека. При showShade=true и опущенном padding шейды получают невалидную ширину.
  - Fix: `const carouselPadding = props.carouselPadding ?? 20;` и считать edge от него.
- **🟨 minor** · *code-quality* — **itemPress эмитится на клик по всему треку, без role**
  - Evidence: Скролл-контейнер `<div ref={track} onScroll={...} onClick={()=>emit("itemPress")} ...>` без role: любой клик по треку (включая завершение перетаскивания) эмитит itemPress, а не клик по конкретному элементу; событие не различает элементы карусели.
  - Fix: Эмитить itemPress с ближайшего интерактивного потомка (делегирование по e.target/data-index) либо документировать, что itemPress — «клик по области карусели»; на контейнер добавить role="group".

#### `yp-list` — metricsByVariant[props.variant] без fallback -> undefined-метрики при опущенном variant; один legacy example на 12-вариантный организм.

- **🟧 MAJOR** · *defensive-props* — **metricsByVariant[props.variant] без fallback -> undefined-метрики**
  - Evidence: `const base = metricsByVariant[props.variant]`: при опущенном variant (default 'plain' не применяется) base=undefined; далее `metrics = props.size === 0 ? base : {...base, ...sizeOverrides[props.size]}` при size=undefined даёт `{}`. Тогда padding=`${undefined}px ${undefined}px` ('undefinedpx' — невалидный CSS), gap/marginTop/separator left/right = undefined, resolvedRadius=undefined. Рендер деградирует (нулевые отступы, сепараторы без позиционирования) — класс бага lookup-таблицы без ??.
  - Fix: `const base = metricsByVariant[props.variant ?? "plain"]; const size = props.size ?? 0;` и далее по size.
- **🟨 minor** · *definition-quality* — **Один legacy example на organism с 12 вариантами**
  - Evidence: `example: { variant: "plain", ... }` — единственный legacy-набор для организма с 12 variant и 3 size-override; ключевые состояния (paymentMethods, splitPlans, cart, cashback, size 20/16/14) не покрыты примерами, editor-превью бедное.
  - Fix: Добавить named `examples` (slug-ключи, <=8) на ключевые варианты (paymentmethods, splitplans, cart, cashback); legacy example оставить.

#### `yp-navigation` — Пропы-строки безопасны, но объявлены slots left/center/right, а рендерятся только children — боковые слоты нефункциональны.

- **🟧 MAJOR** · *definition-quality* — **Объявлены slots left/center/right, но рендерятся только children**
  - Evidence: `slots: ["left", "center", "right"]`, но компонент принимает `{ props, children }` (BaseComponentProps) и выводит только `{children}` в центральной колонке (строка 29). Именованные слоты left/right/center нечем заполнить — они нефункциональны и вводят автора в заблуждение: боковые действия задаются лишь через backAction/closeAction, а слоты — мёртвый контракт.
  - Fix: Либо принимать `slots` и рендерить `slots.left/slots.center/slots.right` в соответствующих колонках, либо привести объявление к фактическому (один default-слот в центре). Первое — non-breaking расширение; сведение к одному слоту — breaking для доков, использующих несколько.
- **ℹ️ info** · *abi-hygiene* — **Несогласованные fallback text-color-secondary/primary в батче**
  - Evidence: text-color-primary fallback: platform-modal '#1f2023', collapsible/navigation/animated-collapse '#000000d8', list 'rgba(0,0,0,.85)'. fill-color-default-100 fallback: animated-collapse/list '#edeff2', platform-modal '#f1f2f4'. button-color-quaternary fallback: carousel '#f2f3f5', list '#f5f7f9'. Один семантический цвет записан по-разному в соседних компонентах.
  - Fix: Унифицировать fallback-значения одного семантического токена по всему семейству (сырьё для design.md).

#### `yp-platform-modal` — Строковые пропы безопасны, но platform undefined -> ветка desktop вместо mobile-default; slot 'content' объявлен, а рендерятся children.

- **🟨 minor** · *defensive-props* — **platform undefined -> ветка desktop вместо default mobile**
  - Evidence: `const mobile=props.platform==="mobile"`: схема `platform: z.enum([...]).default("mobile")`, но при опущенном props.platform mobile=false -> рендерится desktop-модалка (centered), хотя задуманный дефолт — mobile-drawer.
  - Fix: `const mobile = (props.platform ?? "mobile") === "mobile";`.
- **🟨 minor** · *definition-quality* — **slot 'content' объявлен, но рендерятся children**
  - Evidence: `slots: ["content"]`, компонент выводит `{children}` (строка 28) через BaseComponentProps, а не именованный слот content. Формально слот content не подключён; работает лишь дефолтный children.
  - Fix: Привести объявление к дефолтному слоту (`slots: ["default"]`) либо принимать slots и рендерить slots.content. Первое — согласование метаданных, non-breaking для доков без явного имени слота.

#### `yp-processing-gate` — ABI v2, typed events; но size undefined -> NaN-геометрия SVG (blocker), durationMs undefined -> мгновенный emit, variant undefined -> цвет теряется.

- **🟥 BLOCKER** · *defensive-props* — **size undefined -> NaN-геометрия, сломанный SVG**
  - Evidence: props.size имеет .default(40), но Renderer дефолты не применяет. При опущенном size: `const stroke = Math.max(2, props.size / 22)` -> Math.max(2, NaN)=NaN; `radius = (props.size - stroke)/2` -> NaN; `circumference = 2*Math.PI*radius` -> NaN; `viewBox=`0 0 ${props.size} ${props.size}`` -> '0 0 undefined undefined'; width/height:props.size -> undefined. SVG схлопывается, круги с r=NaN не рисуются — спиннер невидим при валидном по схеме доке.
  - Fix: Локальный fallback без изменения схемы: `const size = props.size ?? 40;` и использовать size во всех вычислениях/стилях (по образцу yp-box `props.mode ?? "row"`).
- **🟧 MAJOR** · *defensive-props* — **durationMs undefined -> setTimeout(0), мгновенный emit**
  - Evidence: `window.setTimeout(() => emit("complete", {status:"success"}), props.durationMs)`: при опущенном durationMs (default 3000 не применяется) delay=undefined трактуется как 0, гейт эмитит success почти сразу при монтировании, минуя видимую фазу обработки.
  - Fix: `const durationMs = props.durationMs ?? 3000;` — передавать его в setTimeout и в deps useEffect.
- **🟨 minor** · *defensive-props* — **variant undefined -> colorByVariant[undefined]**
  - Evidence: `color: colorByVariant[props.variant]`: при опущенном variant (default primary не применяется) lookup даёт undefined, цвет спиннера падает в inherit вместо primary-токена.
  - Fix: `colorByVariant[props.variant ?? "primary"]`.


### Семейство `banners-promo` (13 находок)

#### `yp-banner-list` — Блокер: props.miniItems/midItems читаются без ?? — краш при omit (дефолты не применяются); инлайновые Mini/Mid дублируют атомы.

- **🟥 BLOCKER** · *defensive-props* — **Краш на props.miniItems/midItems undefined (дефолты не применяются)**
  - Evidence: Строка 19: `{props.miniItems.length?...props.miniItems.map(...)}` и `{props.midItems.map(...)}`. Оба пропа объявлены `z.array(...).default([])`, но Renderer НЕ применяет zod-дефолты, поэтому валидный по схеме док `{}` (или с одним заданным массивом) отдаёт другой массив как `undefined`. `undefined.length` / `undefined.map` → TypeError, компонент падает при рендере.
  - Fix: Читать массивы оборонительно: `const miniItems = props.miniItems ?? []; const midItems = props.midItems ?? [];` и использовать локальные переменные вместо прямого `props.*`. Non-breaking, схему/дефолты не трогает.
- **🟨 minor** · *code-quality* — **Инлайновые Mini/Mid дублируют standalone yp-banner-mini/yp-banner-mid**
  - Evidence: Внутренние `Mini` (стр.17, 161×166, fon #f3f5f7, тот же badge-градиент) и `Mid` (стр.18, 327×h, tone-фоны #e1fae7/#fae9f6/#efedf7, layout `20px 0 20px 20px`) повторяют геометрию/цвета отдельных компонентов yp-banner-mini и yp-banner-mid, но неинтерактивны (без press). Риск рассинхрона констант между организмом и атомарными баннерами; изображения idут с жёстким `alt=""` без проп-альта.
  - Fix: Зафиксировать в design.md общий источник токенов баннеров; при рефакторинге переиспользовать атомы. Non-breaking (наблюдение/гигиена).

#### `yp-banner-mid` — Major: Number(props.width/height)=NaN при omit → баннер схлопывается; ctaLabel без фоллбэка; near-duplicate с yp-promo-banner. Ассет-URL корректный.

- **🟧 MAJOR** · *defensive-props* — **Number(props.width/height) = NaN → баннер схлопывается**
  - Evidence: Строки 35-36: `const width = Number(props.width); const height = Number(props.height);`. `width`/`height` — enum с `.default("327")`/`.default("176")`, но дефолты не применяются; при omit `Number(undefined)` = `NaN`. Дальше `style={{...width,height,...}}` → фиксированный по замыслу баннер получает NaN-размеры (игнорируются браузером → auto/0), визуально ломается.
  - Fix: `Number(props.width ?? "327")` и `Number(props.height ?? "176")`. Non-breaking, повторяет значения дефолтов схемы.
- **🟨 minor** · *defensive-props* — **ctaLabel undefined → 'undefined' в aria-label и пустая кнопка**
  - Evidence: Строка 38 `aria-label={`${props.title}. ${props.ctaLabel}`}` при omit ctaLabel даёт `"Title. undefined"`; строка 44 `{props.ctaLabel}` рендерит пусто. `ctaLabel` имеет `.default("Подробнее")`, но дефолт не применяется.
  - Fix: `const ctaLabel = props.ctaLabel ?? "Подробнее";` и использовать в aria и в разметке. Non-breaking.

#### `yp-banner-mini` — Крэшей нет (truthy-защита), но title/subtitle рендерятся сырыми → пустой контент при omit дефолтных пропов.

- **🟨 minor** · *defensive-props* — **title/subtitle рендерятся сырыми → пустой контент при omit**
  - Evidence: Строки 42,52 `{props.title}` и 43,53 `{props.subtitle}` выводятся без фоллбэка; оба имеют `.default("Яндекс Пэй")`/`.default("Открой карту Пэй и получи")`, которые не применяются → при omit баннер без заголовка/подзаголовка. Крэша нет (badgeText/iconUrl/ctaLabel/adLabel защищены truthy-проверками, geometry undefined корректно уходит в ctyp-ветку).
  - Fix: `props.title ?? "Яндекс Пэй"` и `props.subtitle ?? "Открой карту Пэй и получи"` в разметке и aria-label. Non-breaking.

#### `yp-context-banner` — Оборонительный (props.state ?? default, message/label required), named example hover есть; только info по нестандартному accessibleLabelProps.

- **ℹ️ info** · *definition-quality* — **Нестандартное поле accessibleLabelProps в definition**
  - Evidence: Строка 29: `accessibleLabelProps: ["accessibleLabel"]` — поле вне перечня контракта definition (props/events/slots/capabilities/description/example/examples/atomicLevel/layout). Скорее всего игнорируется при публикации, но вводит в заблуждение как якобы поддерживаемая метадата.
  - Fix: Удалить неиспользуемое поле либо подтвердить его поддержку по `GET /api/schemas/component-definition.json`. Non-breaking.

#### `yp-maps-review-banner` — Major: base64 webp ~146KB зашит в исходник (148KB, минует asset-пайплайн); emit объявлен и не используется. props.href required — краша нет.

- **🟧 MAJOR** · *assets* — **Base64 webp data-URI ~146KB зашит в исходник**
  - Evidence: Строка 2: `const MAPS_PIN = "data:image/webp;base64,UklGRtSsAQB..."` длиной 146427 символов; общий sourceBytes компонента 148460 (в 40+ раз больше соседей по батчу ~3-4KB). Используется дважды в строке 17 (`src={MAPS_PIN}`). Это минует пайплайн ассетов (`/api/assets/asset_<sha256>`), раздувает бандл и версионирование исходника.
  - Fix: Загрузить пин как ассет через asset-пайплайн и заменить `MAPS_PIN` на литеральный проп/константу `/api/assets/asset_<sha256>` (как сделано в yp-banner-mid). Требует републикации с assetIds; сам по себе non-breaking для схемы пропов.
- **🟨 minor** · *code-quality* — **emit объявлен, но не используется; events не декларированы**
  - Evidence: Строка 11: сигнатура `({props}:{props:Props;emit:(event:string)=>void})` — `emit` в типе есть, но не деструктурируется и не вызывается; в `definition` нет поля `events`. Взаимодействие целиком нативное через `<a href>`. Мёртвый параметр в контракте.
  - Fix: Убрать `emit` из типа сигнатуры (оставить `{props}: BaseComponentProps<Props>`). Non-breaking (событий не было).

#### `yp-promo-banner` — Major: props.width-160=NaN при omit → колонка картинки ломается; near-duplicate с yp-banner-mid.

- **🟧 MAJOR** `[breaking]` · *code-quality* — **Near-duplicate с yp-banner-mid**
  - Evidence: yp-promo-banner и yp-banner-mid — почти идентичные горизонтальные промо-организмы: одинаковый layout (`minWidth:160`, `padding:"20px 0 20px 20px"`, `justifyContent:"space-between"`), тот же тёмный CTA `#2e2f33`/текст `rgba(255,255,255,.98)`, те же tone-фоны (`#e1fae7`/`#fae9f6`), borderRadius 20, событие `press`, картинка справа `objectFit:cover`. Отличия — набор enum tone/variant и ширины. Дублирование ведёт к рассинхрону при правках.
  - Fix: Свести к одному компоненту (например, оставить более конфигурируемый как канонический, второй пометить deprecated/alias). Слияние API ломающее → зафиксировать как отдельное breaking-предложение; на данном этапе задокументировать дубль в design.md.
- **🟧 MAJOR** · *defensive-props* — **props.width - 160 = NaN → колонка картинки ломается**
  - Evidence: Строка 38: `const imageWidth = Math.min(148, Math.max(120, props.width - 160));`. `width` — `z.number().default(336)`, дефолт не применяется; при omit `undefined - 160` = `NaN` → `imageWidth` = NaN, далее `style={{width:imageWidth,flex:`0 0 ${imageWidth}px`}}` (строка 73) → колонка изображения с NaN-шириной рендерится неверно. Также `width: props.width` (строка 51) = undefined.
  - Fix: Ввести `const w = props.width ?? 336;` и использовать `w` в вычислении imageWidth и в style.width. Non-breaking.

#### `yp-promo-base` — Блокер: buttonColors[buttonVariant].border краш при omit variant + заданном buttonText; ряд цветов/радиуса/фона теряется без фоллбэков.

- **🟥 BLOCKER** · *defensive-props* — **Краш buttonStyle.border когда buttonVariant undefined**
  - Evidence: Строка 76: `const buttonStyle = buttonColors[props.buttonVariant];` — при omit `buttonVariant` (default("action") не применяется) `buttonColors[undefined]` = `undefined`. Строка 90 в ветке с `props.buttonText`: `border: buttonStyle.border || 0` (и в `<a>`, и в `<button>`) → чтение `.border` у `undefined` = TypeError. Достижимо валидным доком, где задан `buttonText`, но опущен `buttonVariant`.
  - Fix: `const buttonStyle = buttonColors[props.buttonVariant] ?? buttonColors.action;` — гарантирует объект. Non-breaking.
- **🟨 minor** · *defensive-props* — **Цвет/радиус/фон/art-position теряются при omit пропов с дефолтами**
  - Evidence: `colors[props.titleColor]` (стр.82,88) и `colors[props.descriptionColor]` (стр.89) при undefined → `undefined` (цвет не задаётся, наследуется). `borderRadius: props.radius` (стр.80) undefined → радиус пропадает. `background: props.backgroundColor` (стр.80) undefined → фон прозрачный. `props.backgroundTransform === "noTransform"` (стр.74,85): при omit (default noTransform) выражение false → art-position ошибочно "bottom right" вместо "bottom center".
  - Fix: Добавить `?? `-фоллбэки на значения дефолтов: `colors[props.titleColor ?? "primary"]`, `props.radius ?? 24`, `props.backgroundColor ?? "var(--fill-color-default-0, #fff)"`, `props.backgroundTransform ?? "noTransform"`. Non-breaking.
- **ℹ️ info** · *code-quality* — **Несогласованность семантического primary-текста по батчу**
  - Evidence: Один по смыслу «основной текст» записан по-разному: `rgba(0,0,0,.86)` (yp-banner-list стр.19, yp-banner-mid стр.38, yp-banner-mini, yp-promo-banner стр.36), `var(--text-color-primary, #1f2023)` (yp-promo-base стр.55), `var(--text-color-primary,#1f1f1f)` (yp-maps-review-banner стр.12). Также font-family: часть использует `'YS Text','Helvetica Neue',Arial`, а yp-promo-base/yp-maps добавляют `Helvetica` (`'YS Text','Helvetica Neue',Helvetica,Arial`).
  - Fix: Свести к единому значению primary-текста и единой font-family в design.md/токенах темы. Non-breaking (сырьё для design.md).


### Семейство `app-home-shell` (12 находок)

#### `yp-app-home-chrome` — nav/tab chrome, assetUrl-regex совпадает с $asset-ссылками дока, examples nav/tab полные; time имеет дефолт (продублирован в доке).

- **🟨 minor** · *defensive-props* — **time default может быть undefined → пустое время в статус-баре**
  - Evidence: `time: z.string().regex(...).default("15:07")` (стр. 9); дефолты не применяются. На стр. 65 `{props.time}` выводится напрямую — при омиссии пропа статус-бар покажет пустую строку вместо времени.
  - Fix: `{props.time ?? "15:07"}`. Non-breaking.
- **ℹ️ info** · *code-quality* — **Один семантический цвет записан по-разному в батче**
  - Evidence: Белый фон: chrome литерал `background: "#fff"` (стр. 64/90), а shell/section — токен `var(--background-color-primary,#fff)`. Первичный текст выражен тремя способами: chrome `rgba(0,0,0,.86)` (стр. 64), shell `var(--text-color-primary,#000000db)` (стр. 46), vitrina `var(--text-color-primary,rgba(0,0,0,.86))` (стр. 48). Значения эквивалентны, но форма несогласована.
  - Fix: Унифицировать: везде использовать `var(--background-color-primary,#fff)` и единую запись первичного текста (`var(--text-color-primary,rgba(0,0,0,.86))`). Non-breaking, сырьё для design.md.
- **ℹ️ info** · *definition-quality* — **Нераспознаваемые definition-поля urlProps/accessibleLabelProps**
  - Evidence: chrome объявляет `urlProps: [...]` (стр. 24), vitrina — `urlProps`/`accessibleLabelProps` (стр. 27-28). В контракте definition (server-api.md §567: events/slots/capabilities/description/example/examples/atomicLevel/layoutNeutral/layout) таких полей нет; strictObject стоит только на props, поэтому эти аннотации молча игнорируются платформой и не дают эффекта.
  - Fix: Удалить неиспользуемые аннотации либо подтвердить, что это осознанная документация для авторов; на рендер/публикацию они не влияют. Non-breaking.

#### `yp-app-home-section` — Скелетон-секция product/savers/loans/vitrina, доступ к пропам безопасен; мелко: нет тени (в отличие от populated) и loading-высота vitrina 766≠650.

- **🟨 minor** · *definition-quality* — **examples только для loading:true, загруженное состояние не покрыто**
  - Evidence: Все 4 набора (стр. 17-20) имеют `loading:true`; ни один не демонстрирует loaded-ветку со слотами (header/cards/communications/banner/content), которая занимает большую часть кода рендера (стр. 91-97).
  - Fix: Добавить хотя бы один набор с `loading:false` для превью загруженной геометрии секции. Non-breaking.

#### `yp-app-home-shell` — Organism с 4 слотами; feedGap защищён space(?? sm), но canvasHeight/navHeight/feedTop/tabHeight читаются без ?? при .default() — хрупко к отсутствию дефолтов в Renderer.

- **🟥 BLOCKER** · *defensive-props* — **Числовые geometry-пропы без ?? fallback → NaN/схлопнутый шелл**
  - Evidence: Пропы имеют .default() и, т.к. Renderer НЕ применяет zod-дефолты, приходят undefined на валидном по схеме доке. Строка 34 `const feedHeight = props.canvasHeight - props.feedTop - props.tabHeight;` при отсутствии любого пропа даёт NaN; строка 41 `height: props.canvasHeight` → undefined → height:auto, а дети абсолютны → секция схлопывается в 0 и ничего не видно; строки 55/71 `inset: \`${props.feedTop}px 0 auto 0\`` → 'undefinedpx 0 auto 0' (невалидный CSS). Автор явно знал о проблеме — только для feedGap стоит защита `space(props.feedGap ?? "sm")` (стр. 61), а числовые пропы забыл.
  - Fix: Читать каждый числовой проп с фолбэком, равным дефолту схемы: `const canvasHeight = props.canvasHeight ?? 1722; const navHeight = props.navHeight ?? 100; const feedTop = props.feedTop ?? 76; const tabHeight = props.tabHeight ?? 83;` и использовать локальные переменные во всех вычислениях/стилях (как в эталонном yp-box). Non-breaking.
- **🟨 minor** · *defensive-props* — **accessibleLabel default может быть undefined в aria-label**
  - Evidence: `accessibleLabel: z.string()...default("Главный экран Яндекс Пэй")` (стр. 14), но дефолты не применяются; на стр. 37 `aria-label={props.accessibleLabel}` при омиссии пропа станет undefined → секция без доступного имени.
  - Fix: `aria-label={props.accessibleLabel ?? "Главный экран Яндекс Пэй"}`. Non-breaking.
- **ℹ️ info** · *definition-quality* — **Legacy singular `example` vs именованные `examples` в батче**
  - Evidence: shell (стр. 21) и vitrina (стр. 29) используют legacy-поле `example` (даёт лишь чип `default`), тогда как chrome/section/surface используют именованные `examples` (сортированные чипы превью). Оба поля валидны по контракту (server-api.md §Named examples), но форма в батче несогласована.
  - Fix: Перевести shell и vitrina на именованные `examples` со slug-ключом (например `{ "home": {...} }`) для единообразных превью-чипов. Non-breaking.

#### `yp-app-home-surface` — Полностью оборонительный: geometry/tone — обязательные enum, lookup-таблицы безопасны; тонкие examples (только promo + savers/loans) и токены-тона на hex-фолбэках.

- **🟨 minor** · *definition-quality* — **examples покрывают лишь promo + savers/loans, остальные geometry/tone не показаны**
  - Evidence: `examples` (стр. 16-18) содержит только `{geometry:"promo", tone:"savers"|"loans"}`. Из enum geometry (bank/promo/market-m/market-l) показан 1 из 4, из tone (savers/loans/secondary/pay-black) — 2 из 4. Ключевые размеры (bank 172×116, market-l 350×146) и тона secondary/pay-black не имеют превью-набора.
  - Fix: Добавить наборы examples для bank/market-l и для secondary/pay-black (в пределах лимита 8), например `{geometry:"market-l", tone:"secondary"}`. Non-breaking.
- **ℹ️ info** · *definition-quality* — **description про "verified color-token tones", хотя цветовых токенов в теме нет**
  - Evidence: description (стр. 14) заявляет "verified color-token tones", но тема yandex-pay v4 определяет только spacing-токены; тона (стр. 28-33) всегда резолвятся к hex-фолбэкам (#b3acff/#ffaa80/#edeff2/#242424), т.к. CSS-переменных --product-* в теме нет.
  - Fix: Уточнить формулировку описания (тона держатся на hex-фолбэках, токены — форвард-совместимость) либо оставить как есть — фолбэки работают. Non-breaking.

#### `yp-app-home-vitrina` — 2×2 + широкая карточка + кнопка, все пропы переданы; фикс-высота 650 создаёт нехватку места в populated-стеке (см. prototype-doc).

- **🟨 minor** · *abi-hygiene* — **fontWeight 900 при доступных в теме только 400/500/700**
  - Evidence: Стр. 62 заголовок `fontWeight: 900`, тогда как тема yandex-pay v4 поставляет YS Text только 400/500/700 — 900 недоступен, браузер применит ближайший (700) или синтетический bold, что расходится с source-начертанием и с остальными весами в этом же файле (500/400).
  - Fix: Заменить на 700 для согласованности со шкалой начертаний темы. Non-breaking.
- **🟨 minor** · *code-quality* — **role="presentation" вместе с aria-label на кнопке — противоречие a11y**
  - Evidence: Стр. 79: `<div role="presentation" aria-label={props.buttonLabel} ...>{props.buttonLabel}` — role=presentation убирает семантику элемента, из-за чего aria-label игнорируется скринридером; при этом текст кнопки всё равно виден как контент. Смешение presentation + aria-label некорректно.
  - Fix: Убрать role="presentation" (оставить обычный div с видимым текстом) либо, если элемент декоративен, убрать aria-label. Non-breaking (правка рендера, не пропов).
- **🟨 minor** `[breaking]` · *props-schema* — **URL-пропы — свободная строка вместо asset-url контракта**
  - Evidence: `const url = z.string().min(1).max(500)` (стр. 5) и все *ImageUrl используют её (стр. 12-21), тогда как соседний yp-app-home-chrome применяет строгий `assetUrl = z.string().regex(/^\/api\/assets\/asset_[a-f0-9]{64}$/)`. Схема допускает произвольные/внешние URL, минующие пайплайн ассетов, хотя example ссылается на /api/assets/...
  - Fix: Сузить *ImageUrl до asset-url регекспа как в chrome. Это ломающее изменение схемы (сужение), поэтому breaking:true; альтернатива — оставить как есть и полагаться на дисциплину авторов.


### Семейство `app-home-content` (6 находок)

#### `yp-app-home-loans` — 3 loan-карточки, thirdImageUrl опционален и защищён тернаром, thirdCaption опущен корректно (нет caption у 3-й).

- **🟨 minor** · *definition-quality* — **fontWeight 900 у h2 вне шкалы темы yandex-pay (YS Text 400/500/700)**
  - Evidence: Строка 59: h2 style fontWeight:900. Тема yandex-pay v4 несёт YS Text только 400/500/700, 900 не загружен → браузер откатывается к ближайшему доступному (700), реальный вес не соответствует задуманному. Тот же fontWeight:900 в yp-app-home-savers.tsx стр.62 и yp-app-home-more-important.tsx стр.54 — несогласованность по всему семейству.
  - Fix: Non-breaking: привести вес заголовков к 700 (максимум шкалы YS Text) во всех трёх компонентах; правка только inline-стиля, пропы/схема не меняются.

#### `yp-app-home-more-important` — Карусель из 4 offer-карточек, все пропы обязательные и переданы, безопасный рендер.

- **🟨 minor** · *code-quality* — **textOverflow:'ellipsis' на заголовке карточки не работает без whiteSpace:nowrap**
  - Evidence: Строка 45: <div style={{ ..., overflow:"hidden", ..., textOverflow:"ellipsis" }}> — но нет whiteSpace:"nowrap" и высота не ограничена, поэтому title (до 64 символов, text max64) переносится на несколько строк и многоточие не применяется; длинный заголовок может наезжать на картинку снизу.
  - Fix: Non-breaking: добавить whiteSpace:"nowrap" (одна строка + эллипсис) либо display:"-webkit-box" с line-clamp для контролируемого обрезания; правка только inline-стиля, пропы не трогаются.
- **🟨 minor** · *definition-quality* — **В example thirdTitle и fourthTitle идентичны ("Секрет распродаж") — вероятная copy-paste ошибка**
  - Evidence: Строки 31–34: thirdTitle: "Секрет распродаж", fourthTitle: "Секрет распродаж" — одинаковый заголовок у двух разных карточек (при этом thirdImageUrl и fourthImageUrl различаются). Example вводит в заблуждение относительно реального контента четвёртой карточки.
  - Fix: Non-breaking: заменить fourthTitle в example на осмысленное отличное значение (правка только строки примера, схема не меняется).

#### `yp-app-home-savers` — 3 saver-карточки, все пропы обязательные и присутствуют; заголовок h2 весом 900 вне тем-шкалы.

- **🟧 MAJOR** `[breaking]` · *code-quality* — **Near-duplicate компонента yp-app-home-loans: идентичная section-обёртка, бейдж-градиент и rail**
  - Evidence: savers.tsx строки 58–73 и loans.tsx строки 55–71 совпадают почти дословно: та же section (height 256, borderRadius 24, boxShadow "0 4px 10px rgba(0,0,0,.05)"), тот же заголовочный блок h2 fontWeight 900 + span-бейдж с градиентом "linear-gradient(90deg,#ff5c4d 0%,#eb469f 25%,#8341ef 72%,#3f68f9 100%)", тот же горизонтальный rail из трёх карточек 172×172 с fill "var(--fill-color-default-50,#f3f5f7)". Отличие лишь в data-атрибуте (data-populated-savers vs -loans) и в том, что у loans третья карточка допускает отсутствие caption/image.
  - Fix: Правильный фикс ломающий: слить в один параметризованный блок (общий компонент rail+heading+badge с пропом-массивом карточек), из-за чего меняются id/схемы обоих компонентов. Non-breaking альтернатива: оставить как есть, но вынести общую section-обёртку и BadgeHeading во внутренний шаред-хелпер на уровне сборки без изменения публичных пропов.

#### `yp-random-avatar` — isLoading (default false) безопасен при undefined, но 22 инлайн-base64 webp (~197 КБ) минуют пайплайн ассетов + Math.random даёт недетерминированный рендер.

- **🟧 MAJOR** · *assets* — **22 инлайновых base64 webp раздувают исходник до ~197 КБ, минуя пайплайн ассетов**
  - Evidence: Строки 3–24: массив AVATARS = ["data:image/webp;base64,UklGR...", ... ×22]. components-meta.json подтверждает: yp-random-avatar sourceBytes=197246, assetIds=[] (ни один ассет не извлечён). Каждый data-URI ~8 КБ, суммарно ~192 КБ base64 прямо в TSX. Правило аудита: data-URI > ~2 КБ — находка, > 8 КБ — major.
  - Fix: Non-breaking: загрузить 22 webp через /api/assets, заменить элементы массива AVATARS на литеральные ссылки /api/assets/asset_<sha256> и прописать их в assetIds. Схема пропов и рантайм-логика не меняются (массив остаётся, меняются только значения строк).
- **🟨 minor** · *code-quality* — **Math.random в useMemo делает рендер недетерминированным (ломает визуальные снапшоты)**
  - Evidence: Строки 34–35: const avatar=useMemo(()=>AVATARS[Math.floor(Math.random()*AVATARS.length)],[]); const background=useMemo(()=>COLORS[Math.floor(Math.random()*COLORS.length)],[]); При каждом маунте выбираются случайные аватар и фон, поэтому capture/visual-регресс дают разный результат от прогона к прогону.
  - Fix: Non-breaking: добавить опциональный проп seed (seed:z.number().optional()) и при его наличии выбирать индекс детерминированно (seed % length); при отсутствии сохранять текущее случайное поведение. Существующие пропы/дефолты не трогаются.


### Семейство `cpqr` (10 находок)

#### `yp-cpqr-home-card` — Defensive OK (size/surface обязательны, backgrounds покрывает enum, serviceImageGeometry с ??); только бедный единственный example не покрывает feature/qr-tile/image-состояния.

- **🟨 minor** · *definition-quality* — **Единственный example не покрывает ключевые состояния**
  - Evidence: Строки 21-29: один `example` с size=service-tall/surface=service-pink и пустым imageUrl. Не показаны состояния feature (другая геометрия/паддинг, стр.54,80), imageVariant=qr-tile (спец-геометрия стр.56-57) и вариант с реальным imageUrl (ветка img стр.91). Editor-controls и витрина Library недополучают покрытие состояний.
  - Fix: Добавить второй/третий example (feature + qr-tile, service с imageUrl на literal /api/assets/...). Non-breaking.

#### `yp-cpqr-sheet-frame` — statusTime рендерится без fallback (пустые часы), fontWeight 600 вне шкалы темы; fixed-canvas дублирует status-bar и опускает battery; ABI чистый (type-only import).

- **🟨 minor** · *defensive-props* — **statusTime рендерится сырым, без fallback**
  - Evidence: Строка 72: `{props.statusTime}` при `statusTime: ...default("15:07")`. Дефолт не применяется → при отсутствии пропа часы в статус-баре fixed-canvas пусты (пустой блок 44px). Не краш, но визуально сломанный OS-хром.
  - Fix: `{props.statusTime ?? "15:07"}` (совпадает с дефолтом схемы). Non-breaking.
- **ℹ️ info** · *code-quality* — **fixed-canvas дублирует ответственность status-bar и опускает battery**
  - Evidence: Строки 62-101: sheet-frame в режиме fixed-canvas сам рисует статус-строку (время стр.72 + inline-ассеты cellular/wifi стр.87-100), тогда как в батче есть отдельный yp-cpqr-status-bar со слотами cellular/wifi/battery. При этом battery в sheet-frame отсутствует (только 2 иконки), а status-bar его поддерживает — расхождение анатомии между двумя источниками одной OS-строки.
  - Fix: Наблюдение: рассмотреть переиспользование yp-cpqr-status-bar внутри sheet-frame либо задокументировать намеренное отсутствие battery. Не требует немедленного фикса.

#### `yp-cpqr-status-bar` — time без fallback (пустое время) и fontWeight 600 вне шкалы; tone/surface обрабатываются оборонительно, role=img оправдан.

- **🟨 minor** · *abi-hygiene* — **fontWeight 600 вне шрифтовой шкалы темы (400/500/700)**
  - Evidence: Строка 45 status-bar: `fontWeight: 600`; то же в yp-cpqr-sheet-frame строка 69 (`fontWeight: 600`). Тема yandex-pay v4 поставляет YS Text только 400/500/700 — 600 отсутствует и будет отрисован ближайшим/синтетическим начертанием. Соседние cpqr-компоненты используют 400/500/700 (home-card 400|500, tab-bar 700).
  - Fix: Заменить 600 → 500 или 700 в обоих компонентах для согласованности со шкалой темы. Non-breaking (только визуальная константа).
- **🟨 minor** · *defensive-props* — **time рендерится сырым, без fallback**
  - Evidence: Строка 46: `{props.time}` при `time: ...default("15:07")`. При отсутствии пропа время в строке состояния пусто. Аналог проблемы в sheet-frame.
  - Fix: `{props.time ?? "15:07"}`. Non-breaking.

#### `yp-cpqr-tab-bar` — major: selected-дефолт не применяется → ни одна вкладка не активна; плюс 'Circe Rounded' вне темы; url-пропсы обязательны, a11y (nav/button/aria-current) корректны.

- **🟧 MAJOR** · *defensive-props* — **selected-дефолт не применяется: без selected ни одна вкладка не активна**
  - Evidence: Строка 40: `const active = props.selected === tab.id;` при `selected: z.enum(["home","cart","profile"]).default("home")`. Дефолты не применяются рантаймом → при отсутствии selected props.selected === undefined → active=false для всех вкладок → нет aria-current и все иконки/подписи в rgba(0,0,0,.30), тогда как дефолт схемы подсвечивает home. Неверный рендер в реалистичном состоянии.
  - Fix: `const active = (props.selected ?? "home") === tab.id;`. Non-breaking.
- **🟨 minor** · *definition-quality* — **fontFamily 'Circe Rounded' отсутствует в теме и расходится с батчем**
  - Evidence: Строка 38: `fontFamily: "'Circe Rounded','YS Text','Helvetica Neue',Arial,sans-serif"`. Все остальные cpqr-компоненты стартуют с 'YS Text' (sheet-frame стр.37/59, status-bar стр.42, widget стр.39, paybox стр.48). 'Circe Rounded' не входит в тему yandex-pay v4 → всегда фолбэк на YS Text, при этом создаёт несогласованность стека шрифтов в семействе.
  - Fix: Убрать 'Circe Rounded' из головы стека, начать с 'YS Text' как в остальных cpqr-компонентах. Non-breaking.

#### `yp-cpqr-widget-surface` — major: mode-дефолт active не применяется → без mode виджет схлопывается в inactive без карусели; в остальном простая слот-поверхность.

- **🟧 MAJOR** · *defensive-props* — **mode-дефолт не применяется: без mode виджет схлопывается в inactive**
  - Evidence: Строка 25: `const active = props.mode === "active";` при схеме `mode: z.enum(["active","inactive"]).default("active")`. Renderer не применяет zod-дефолты, поэтому при отсутствии mode в доке props.mode === undefined → active=false → рендерится высота 96px без carousel (строка 45 `active ? ... : null`), хотя дефолт схемы — active (200px с каруселью). Реалистичный док, полагающийся на дефолт, получает неверный (свёрнутый) виджет.
  - Fix: Ввести оборонительный fallback как в эталоне yp-box: `const active = (props.mode ?? "active") === "active";`. Non-breaking, дефолт схемы не меняется.

#### `yp-paybox-nav-bar` — Defensive корректный (все cpqr-URL через truthy-проверки, geometry-фолбэк совпадает с дефолтом paybox); только info: стейл Figma-node в description и .32/.30 расхождение muted-тона.

- **ℹ️ info** · *code-quality* — **Несогласованность muted-цвета и источника типа пропсов по батчу**
  - Evidence: paybox pullbar `rgba(0,0,0,.32)` (стр.61) против tab-bar неактивной вкладки `rgba(0,0,0,.30)` (стр.41) — один семантический «приглушённый» тон записан двумя близкими значениями. Плюс home-card/tab-bar импортируют BaseComponentProps из @json-render/react, а sheet-frame/status-bar/widget/action-footer/paybox — EasyUIComponentProps из easy-ui/runtime (оба type-only, оба валидны, но источник в батче смешан).
  - Fix: Свести muted-тон к одному значению (.30 или .32) при сборке design.md; унифицировать источник типа пропсов по батчу. Non-breaking.
- **ℹ️ info** · *definition-quality* — **Description ссылается на внутренний Figma-node**
  - Evidence: Строка 17: «The default preserves CTYP node 10284:76932...». Внутренний идентификатор макета не несёт смысла пользователю каталога/агенту и потенциально стейл.
  - Fix: Переформулировать описание в терминах поведения (paybox-строка навигации vs cpqr-sheet анатомия 84px с pullbar), убрав внутренний node-id. Non-breaking.


### Семейство `payment-core` (8 находок)

#### `yp-full-payment-block` — Major: expanded default=true не применяется рантаймом → блок схлопывается и прячет slots.methods при опущенном пропе; fill-fallback #f2f3f5 расходится с семейством.

- **🟧 MAJOR** · *defensive-props* — **expanded default=true не применяется → блок схлопнут и прячет methods**
  - Evidence: Схема: `expanded: z.boolean().default(true)`. Рантайм-дефолты не применяются, поэтому при опущенном `expanded` приходит undefined. Строки 44/53/114: `minHeight: props.expanded ? 184 : 88`, `gap: props.expanded ? 20 : 0`, `{props.expanded ? <div>...{slots.methods}</div> : null}` → блок рендерится СХЛОПНУТЫМ и не показывает слот methods, хотя схема декларирует раскрытое состояние по умолчанию. Автор дока, опустивший expanded в расчёте на default=true, получает сломанный вид.
  - Fix: Локальная константа `const expanded = props.expanded ?? true;` и использовать её во всех трёх местах + в `aria-expanded`. Non-breaking.
- **🟨 minor** · *code-quality* — **fill-default-50 fallback #f2f3f5 расходится с соседями (#f3f5f7)**
  - Evidence: Строка 48: `background: "var(--fill-color-default-50, #f2f3f5)"`. В yp-success-payment-card (строки 39,69) и yp-split-row (строка 73) тот же семантический fill default-50 записан как `#f3f5f7`. Один токен — два разных hardcoded-значения в одном семействе.
  - Fix: Согласовать fallback на #f3f5f7 (или наоборот) во всём семействе payment-core. Non-breaking (только значение цвета).

#### `yp-no-pay-card-info` — Пропсов нет → defensive-рисков нет; minor: fontFamily-стек с лишним Helvetica, инлайновый тип props вместо EasyUIComponentProps, atomicLevel molecule спорный.

- **🟨 minor** · *definition-quality* — **fontFamily-стек расходится с большинством компонентов семейства**
  - Evidence: Строка 15: `fontFamily:"'YS Text','Helvetica Neue','Helvetica',Arial,sans-serif"` (с лишним 'Helvetica'), так же в yp-full-payment-block (строка 50). Остальные (payment-info, method-card, carousel, split-row, success) используют `'YS Text','Helvetica Neue',Arial,sans-serif` без Helvetica. Мелкая несогласованность fallback-шкалы шрифтов.
  - Fix: Унифицировать стек шрифтов во всём семействе. Non-breaking.
- **ℹ️ info** · *code-quality* — **Инлайновый тип пропсов вместо EasyUIComponentProps; atomicLevel спорный**
  - Evidence: Строка 13: `export default function YpNoPayCardInfo({ props: _props }: { props: Props })` — не использует `EasyUIComponentProps<Props>` как остальные компоненты семейства. atomicLevel="molecule" (строка 6) для статичной текстовой строки с одним inline-бейджем ближе к atom.
  - Fix: Импортировать `EasyUIComponentProps` для единообразия (тип props пустой — эффект нулевой); рассмотреть atomicLevel "atom". Оба изменения non-breaking.

#### `yp-payment-info` — geometry/цена/мерчант безопасны при undefined (default-ветка = ctyp совпадает), но accessibleLabel с дефолтом даёт undefined aria-label; описание точное, ABI type-only, ассетов нет.

- **🟨 minor** · *defensive-props* — **accessibleLabel default не применяется → aria-label undefined**
  - Evidence: Схема: `accessibleLabel: z.string()...default("Информация о платеже")`, строка 32: `aria-label={props.accessibleLabel}`. При опущенном пропе дефолт не применяется → aria-label=undefined, секция теряет доступное имя (не краш, но a11y-регресс относительно декларированного дефолта).
  - Fix: `aria-label={props.accessibleLabel ?? "Информация о платеже"}`. Non-breaking.

#### `yp-payment-method-card` — Major: surfaces[props.surface] без fallback даёт прозрачный фон при опущенном surface (default white не применяется); остальные lookup-ветки совпадают с дефолтами; a11y через <button> корректна.

- **🟧 MAJOR** · *defensive-props* — **surfaces[props.surface] даёт undefined-фон при опущенном surface**
  - Evidence: Строки 55-60 объявляют lookup `surfaces`, строка 79: `background: props.backgroundImageUrl ? "#f1eff8" : surfaces[props.surface]`. `surface` default="white", но дефолт не применяется рантаймом; при опущенном surface `props.surface === undefined` → `surfaces[undefined] === undefined` → фон карточки становится прозрачным вместо белого. Неверный рендер в реалистичном состоянии (док полагается на дефолт).
  - Fix: Индексировать с fallback: `surfaces[props.surface ?? "white"]`. Non-breaking.

#### `yp-payment-method-carousel` — Children.map(slots.default) устойчив к undefined, geometry undefined→ctyp совпадает с дефолтом; role=region+aria-label ок; лишь info-несогласованность events:[]

- **ℹ️ info** · *definition-quality* — **events: [] (массив) против events: {} в соседях**
  - Evidence: Строка 10: `events: []`. yp-payment-info (стр.11) и yp-full-payment-block (стр.14) используют `events: {}`. Эталон yp-box тоже `events: []`, так что оба формата принимаются, но внутри семейства формат «нет событий» записан двумя способами.
  - Fix: Выбрать единый пустой-events формат по семейству. Non-breaking.

#### `yp-split-row` — Blocker: props.payments.map крашится при expanded:true с опущенным payments (default не применяется); title/funding-дефолты дают пустой текст; asset-fallback по контракту.

- **🟥 BLOCKER** · *defensive-props* — **props.payments.map падает при expanded=true без payments**
  - Evidence: Строка 155: `{props.payments.map((payment, index) => (`. `payments` имеет `.default([...])` в схеме, но Renderer НЕ применяет zod-дефолты. Валидный по схеме док (`expanded: true` задан, `payments` опущен) даёт `props.payments === undefined`, и `.map` на undefined крашит рендер. `expanded` default=false, поэтому крах требует явного expanded:true — но это основной сценарий компонента.
  - Fix: Ввести локальную константу с fallback: `const payments = props.payments ?? DEFAULT_PAYMENTS;` (продублировать массив из схемы) и мапить по ней. Non-breaking, схему/дефолты не трогаем.


### Семейство `payment-cards-footers` (13 находок)

#### `yp-base-card-mini` — Не-defensive булевы (isSelectable/isDisabled) дают disabled+dimmed по умолчанию; near-duplicate с best-profit; расхождение цветовых фолбэков.

- **🟧 MAJOR** · *defensive-props* — **Не-defensive булевы пропы дают disabled-состояние по умолчанию**
  - Evidence: `const disabled = props.isDisabled || !props.isSelectable;` (строка 24) и `opacity:props.isSelectable?1:.5` (строка 26). Без применённых дефолтов при отсутствии полей в доке `isSelectable`=undefined → disabled=true и opacity=.5; карточка выглядит выключенной вопреки дефолту схемы isSelectable=true.
  - Fix: Ввести локальные fallback: `const isSelectable = props.isSelectable ?? true; const isDisabled = props.isDisabled ?? false;` и использовать их в disabled/opacity, по образцу yp-box.
- **🟨 minor** · *code-quality* — **Дубль-семейство: near-duplicate с yp-best-profit-base-card-mini**
  - Evidence: Оба — compact selectable payment card (molecule) с variant card/token, isSelected/isSelectable/isDisabled, иконкой+title+description и событием press (строки 4-18 vs best-profit строки 4-21). Различаются раскладкой (row vs column), border-радиусами (20 vs 12) и cashback-полем.
  - Fix: Зафиксировать в описаниях обоих компонентов различие ролей (base vs best-profit), чтобы автор не путал их в каталоге; либо рассмотреть слияние в один компонент с флагом layout (breaking). Non-breaking минимум: уточнить description каждого.

#### `yp-base-card-oneline` — Defensive-доступ безопасен (text required), но только один example без покрытия isToken:true.

- **🟨 minor** · *definition-quality* — **Только singular example, нет examples для состояний isToken**
  - Evidence: Определение содержит лишь `example: { text, cardText, icon, isToken:false }` (строка 13); проп `isToken` влияет на размер иконки (строка 23), но состояние isToken:true примером не покрыто.
  - Fix: Добавить slug-keyed `examples` с кейсом token: `examples: { token: { text:"Способ оплаты", cardText:"Токен •• 1234", icon:"●", isToken:true } }`.

#### `yp-best-profit-base-card-mini` — Не-defensive булевы дают disabled по умолчанию; мёртвый проп currency; цветовые фолбэки расходятся с соседними карточками.

- **🟧 MAJOR** · *defensive-props* — **Не-defensive булевы пропы дают dimmed/disabled по умолчанию**
  - Evidence: `const disabled = props.isDisabled || !props.isSelectable;` (строка 26) и `opacity:props.isSelectable?1:.5` (строка 29). Renderer НЕ применяет zod-дефолты, поэтому при доке без этих полей `isSelectable`=undefined → `disabled = undefined || !undefined = true`, `opacity=.5`. Карточка рендерится выключенной и полупрозрачной, хотя дефолты схемы обещают isSelectable=true/isDisabled=false.
  - Fix: Читать булевы пропы с fallback как в эталоне yp-box: `const isSelectable = props.isSelectable ?? true; const isDisabled = props.isDisabled ?? false; const disabled = isDisabled || !isSelectable;` и `opacity: (props.isSelectable ?? true) ? 1 : .5`.
- **🟨 minor** · *code-quality* — **Расхождение семантических цветов с соседними карточками**
  - Evidence: Здесь вторичный текст = `var(--text-color-secondary,#777)` (строки 32-33) и первичный = `var(--text-color-primary,#1f1f1f)`. В соседних yp-base-card-mini/yp-base-card-oneline те же семантические роли зашиты как `#00000080` и `#000000d8`. Один и тот же токен даёт разные фолбэки в родственных компонентах батанка.
  - Fix: Согласовать фолбэки одного семантического токена по батчу (выбрать единый #00000080/#000000d8 либо единый #777/#1f1f1f). Это сырьё для design.md; фикс non-breaking — только значения фолбэков.
- **🟨 minor** · *props-schema* — **Мёртвый проп currency**
  - Evidence: В схеме объявлен `currency: z.string().default("RUB")` (строка 13), но в теле компонента `props.currency` не используется ни разу — рендер не ссылается на валюту. Проп попадёт в editor-controls, но не даёт визуального эффекта.
  - Fix: Либо задействовать currency в рендере (например, приписать к cashback: `{props.cashback}% {props.currency}`), либо задокументировать в description, что проп зарезервирован. Non-breaking: не удаляем проп.

#### `yp-ctyp-payment-page` — Два инлайновых base64 data-URI (~5KB) минуют пайплайн ассетов (assetIds пуст); initialMethod без fallback; примеры не покрывают paycard-ветку.

- **🟨 minor** · *assets* — **Два base64 data-URI в исходнике минуют пайплайн ассетов** (понижена verify)
  - Evidence: `BANNER_IMAGE = "data:image/webp;base64,UklGRiAL..."` (строка 5, WebP ~2.8KB → ~3.8KB base64 в исходнике) и `AVATAR_IMAGE = "data:image/webp;base64,UklGRggE..."` (строка 6, ~1KB → ~1.4KB base64). Суммарно ~5KB инлайна; в components-meta.json у yp-ctyp-payment-page `assetIds: []` — картинки не проходят через реестр ассетов и раздувают sourceBytes до 16057.
  - Fix: Загрузить обе картинки в реестр ассетов и заменить константы на литеральные URL `/api/assets/asset_<sha256>` (как в yp-icon-bank/yp-sticky-native-footer). Non-breaking: значения src, не пропы.
- **🟨 minor** · *defensive-props* — **initialMethod без fallback в useState**
  - Evidence: `const [selected,setSelected]=useState<PaymentMethod>(props.initialMethod)` (строка 46). Без применённого дефолта `props.initialMethod`=undefined → selected=undefined, ни один метод не выбран, banner=false. Не краш, но начальное состояние расходится с дефолтом схемы "sbp".
  - Fix: `useState<PaymentMethod>(props.initialMethod ?? "sbp")`.
- **🟨 minor** · *definition-quality* — **examples не покрывают состояния initialMethod**
  - Evidence: Есть только `example: { initialMethod: "sbp" }` (строка 16); enum допускает 6 значений (строка 11), включая ключевое "paycard" (переключает баннер), но примеры этих ветвей нет.
  - Fix: Добавить slug-keyed `examples` минимум с `paycard` (ветка BannerMid) и ещё одним методом.

#### `yp-icon-bank` — Эталонно defensive (?? на bank/network/width/height, guard на exactAssetUrl), литеральный ассет, есть examples plural.

- **ℹ️ info** · *props-schema* — **bank/network влияют только на alt при пустом label**
  - Evidence: Пропы-enum bank/network (строки 9-10) в рендере используются лишь как фолбэк alt: `alt={props.label || \`${bank} ${network}\`}` (строка 36); собственной картинки по ним не выбирается (это заявлено в description как semantic metadata).
  - Fix: Оставить как есть — поведение задокументировано; наблюдение как сырьё. Если требуется, вынести в отдельные необязательные метаданные вне визуального контракта (breaking).

#### `yp-sticky-native-footer` — Пропы required (defensive не нужен), ассет через реестр — ок; расхождение CTA-фона с батчем (#111 vs #2e2f33) и текста.

- **🟨 minor** · *code-quality* — **CTA-фон расходится с батчем (#111 vs #2e2f33)**
  - Evidence: `background:"var(--button-color-inverted, #111)"` (строка 52). В yp-sticky-payment-footer и в yp-ctyp-payment-page та же CTA рендерится как `#2e2f33` (footer строка 57, ctyp StickyBottomTouch/BannerMid). Текст тоже `#fff` vs `rgba(255,255,255,.98)`.
  - Fix: Согласовать фолбэк CTA-фона по батчу: `var(--button-color-inverted, #2e2f33)` и текст `rgba(255,255,255,.98)`. Non-breaking, только значения.

#### `yp-sticky-payment-footer` — Рендер безопасен (undefined-строки дают пусто), но мёртвый импорт React, только singular example и спорный atomicLevel organism.

- **🟨 minor** · *code-quality* — **Неиспользуемый импорт React**
  - Evidence: `import React from "react";` (строка 1) при автоматическом JSX-runtime не нужен и не используется в теле — мёртвый импорт.
  - Fix: Удалить строку импорта React (JSX-runtime не требует явного React). Non-breaking.
- **🟨 minor** · *definition-quality* — **atomicLevel organism завышен для простого футера**
  - Evidence: `atomicLevel: "organism"` (строка 6) при том, что компонент — единственная CTA-кнопка + строка лигала (строки 46-96). По масштабу ближе к molecule.
  - Fix: Рассмотреть понижение atomicLevel до "molecule"; либо оставить organism, если считается самостоятельной экранной зоной. Значение метаданных, non-breaking.


### Семейство `misc` (5 находок)

#### `ui-rating-stars` — shadcn-атом рейтинга: definition не по контракту (нет atomicLevel, поле example вместо examples), счётчик уходит за max(5) без клампа, stale useState не синхронится с props, кнопка без aria-label и пустая при value=0.

- **🟥 BLOCKER** · *definition-quality* — **definition не соответствует контракту публикации: нет atomicLevel, поле example вместо examples**
  - Evidence: definition = { props: z.strictObject(...), events: ["press"], slots: [], description: "An interactive five-star rating", example: { value: 3 } }. Контракт компонента требует atomicLevel (atom|molecule|organism|template|page) — его нет; и поле называется `examples` (map со slug-ключами, каждый парсится props-схемой), а тут одиночное `example` (singular), которое пайплайн не распознаёт как примеры — редактор/галерея не покажут ни одного примера.
  - Fix: Добавить atomicLevel: "atom" и заменить одиночное `example: { value: 3 }` на `examples: { default: { value: 3 }, empty: { value: 0 }, full: { value: 5 } }` (slug-ключи, каждый валиден по props-схеме). Пропы/схему не трогаем — правки только метаданных.
- **🟧 MAJOR** · *code-quality* — **Счётчик рейтинга инкрементится без ограничения, уходит за max(5)**
  - Evidence: onClick={() => { setValue(value + 1); emit("press"); }} и рендер {"★".repeat(value)}. Схема объявляет value.min(0).max(5), а компонент называется "five-star rating", но каждый клик прибавляет 1 без клампа: после 5 кликов получаем 6, 7, 8… звёзд — рендер противоречит и названию, и границе схемы.
  - Fix: Кламп в обработчике: setValue((v) => Math.min(5, (v ?? 0) + 1)) (или циклический сброс на 0 после 5). Схему и пропы не меняем.
- **🟨 minor** · *code-quality* — **Кликабельная кнопка без aria-label и с пустым содержимым при value=0**
  - Evidence: <button onClick={...}>{"★".repeat(value)}</button>. При value=0 "★".repeat(0) === "" — кнопка рендерится пустой (нулевая ширина, нечем кликнуть), а у самой кнопки нет aria-label — скринридер объявит её как безымянную.
  - Fix: Добавить aria-label={`Rating ${value ?? 0} of 5`} и рендерить фон из 5 пустых звёзд ("☆".repeat(5 - n) + "★".repeat(n)), чтобы область клика существовала при 0. Non-breaking.
- **🟨 minor** · *props-schema* — **Внутренний useState не синхронизируется с props.value (stale state)**
  - Evidence: const [value, setValue] = useState(props.value); значение читается только при первом рендере. Если прототип поменяет props.value (другой стейт экрана / stateOverrides в CJM), отображаемое число звёзд не обновится — компонент проигнорирует новый проп.
  - Fix: Синхронизировать при изменении пропа: useEffect(() => setValue(props.value ?? 0), [props.value]); либо выводить отображаемое значение как props.value с локальным оверрайдом. Non-breaking, пропы не трогаются.
- **ℹ️ info** · *defensive-props* — **value допускает дробные значения, repeat усекает их**
  - Evidence: props: z.strictObject({ value: z.number().min(0).max(5) }) — целочисленности нет, валиден value: 3.5. "★".repeat(3.5) усекает счётчик до 3 (ToInteger), краха нет, но 3.5 и 3 рендерятся одинаково — незаметная потеря точности. value обязателен (нет .default()/.optional()), поэтому undefined при валидном доке не приходит — краша нет.
  - Fix: Если нужны только целые — задокументировать/ужесточить схему до z.number().int() (breaking для схемы, поэтому только как предложение); non-breaking-минимум — округлять при рендере: "★".repeat(Math.round(value ?? 0)).


## Прототипы


### Семейство `scenario-cpqr-scenario` (7 находок)

#### `cpqr-scenario` — 5 экранов, все ссылки на компоненты/host-примитивы валидны и пропы проходят схемы (проверил enum'ы YpBox/YpText/YpButton/YpSwitch/YpPaymentMethodCard/Carousel/HomeCard/StatusBar/SheetFrame/WidgetSurface/BannerMini/BannerMid); регионы корректны (≤1 statusBar/header/footer, без Hotspot); краш-блокеров нет; проблемы — дубль ready/return шторок, offset-цепочки, flows:0, инертные клики, тупик return, default-props-noise.

- **🟨 minor** · *prototype-doc* — **Экраны qr-curtain-ready и qr-curtain-return — почти полный дубль поддерева** (понижена verify)
  - Evidence: Оба экрана содержат идентичные ~40 элементов: activeWidget/activeHeader/activeBrand/activeSwitch/activeTips + activeCarousel с пятью картами (tbank, alfa, pay, newSbp, allCards) и всеми их иконками/бейджами, а также цепочка activeOffset64A→B→C→24 и activeBody. Различие ровно одно: в ready `activeQr` имеет `"interactive":true` и `on.press → navigate processing`, в return — `"interactive":false` без `on`. Весь остальной JSON (пропы карт, $cond-селекция, тексты) продублирован дословно.
  - Fix: Формат прототипа не поддерживает переиспользование поддеревьев между экранами, поэтому фикс non-breaking — организационный: генерировать оба curtain-экрана из одного источника (скрипт/шаблон), чтобы правки карт не расходились, либо, если пост-оплатная шторка не несёт отдельной ценности, свести return к минимальному экрану без полного каталога карт.
- **🟨 minor** · *prototype-doc* — **Цепочки offset-боксов вместо нормального выравнивания (spacer-heavy аналог)**
  - Evidence: На qr-curtain-ready/return вертикальный отступ набран вложением одиночных YpBox: activeOffset64A(paddingY 4xl)→activeOffset64B(paddingY 4xl)→activeOffset64C(paddingY 4xl)→activeOffset24(paddingY xl)→activeBody, т.е. 64+64+64+24 = 216px сверху четырьмя пустыми обёртками. То же на processing (processingOffset64→processingOffset16, paddingY 4xl→lg) и success (successOffset64→successOffset16). Это прямой аналог линтов spacer-heavy/spacer-chain, только на paddingY вместо YpSpacer.
  - Fix: Схлопнуть цепочку в один YpBox с явным paddingY (или padding-токеном), либо центрировать контент средствами region-content/FlowRoot; магические 64+64+64+24 заменить на один осмысленный отступ.
- **🟨 minor** · *prototype-doc* — **flows:0 при заявленном «Five-stage CPQR CJM»**
  - Evidence: description прототипа: «Five-stage CPQR CJM with bidirectional in-route widget toggle», meta показывает `"flows":0`. Пятистадийный путь (main-connected → qr-curtain-ready → processing → success → qr-curtain-return) нигде не оформлен как doc.flows, хотя прототип позиционируется как CJM.
  - Fix: Добавить один flow, перечисляющий 5 стадий с шагами/notes для CJM-читаемости (в пределах лимитов ≤12 flows / ≤50 шагов).
- **🟨 minor** · *prototype-doc* — **Множество интерактивных элементов пишут в state, который нигде не читается**
  - Evidence: dogWalking/feedback/petSitting/petProducts, tabs (homePress/cartPress/profilePress), activeHow/activeSettings, promoPay/promoStart, successMidPromo — все делают только setState в пути /lastMainAction, /lastTip, /promoPressed. Эти пути не встречаются ни в одном $state/$cond/visible и не ведут navigate, т.е. клики не дают ни визуального эффекта, ни перехода. Реальную навигацию несёт только qrEntry (→qr-curtain-ready), activeQr на ready (→processing), processingStatus complete (→success), successFooter (→qr-curtain-return).
  - Fix: Либо связать хотя бы часть кликов с видимой реакцией (stateOverrides/navigate), либо явно задокументировать в screen.note, что это intent-capture, чтобы ревьюер не принял инертные клики за баг.
- **🟨 minor** · *prototype-doc* — **qr-curtain-return — терминальный тупик без выхода**
  - Evidence: На qr-curtain-return `activeQr` = `"interactive":false` без `on`, и других navigate-целей на экране нет (переключатель/кнопки tips пишут только в state). Попав на возвратную шторку, пользователь не может ни продолжить, ни вернуться — только тумблерить виджет.
  - Fix: Добавить navigate на activeQr (например повторный заход в processing) или явную кнопку/close, чтобы завершить/зациклить сценарий осознанно; либо пометить в note, что это конечное состояние CJM.
- **🟨 minor** · *prototype-doc* — **default-props-noise и одиночные обёртки-боксы**
  - Evidence: YpText-элементы несут полный набор дефолтов: например servicesTitle с `align:"left"`, `inline:false`, `nowrap:false`, `prewrap:false`, `breakspace:false`, `capitalize:false`, `italic:false`, `fontCond:false`, `htmlFor:""`, `testId:""` — все равны дефолтам схемы YpText. Плюс обёртки с единственным ребёнком: mainContent→[mainAfterStatus], mainAfterTitle(gap:"xl")→[servicesGrid] (gap при одном ребёнке бесполезен). activeCarousel дублирует guard: `visible:{$state:/widgetEnabled}` при том, что YpCpqrWidgetSurface рендерит slot carousel только в mode active (тоже завязан на widgetEnabled).
  - Fix: Убрать пропы, повторяющие дефолт схемы; схлопнуть одиночные обёртки; снять дублирующий visible на activeCarousel — всё non-breaking, разгружает 36KB-документ.
- **ℹ️ info** · *prototype-doc* — **Статус-бар и карусель имеют фиксированную 375/335px ширину внутри fluid-экрана**
  - Evidence: YpCpqrStatusBar рендерит `width:"375px"` (mainStatus/activeStatus), YpCpqrWidgetSurface `width:"343px"`, YpPaymentMethodCarousel geometry cpqr `width:335`. Экран device:mobile fluid (note каждого экрана: «mobile present now drops the authored statusBar and uses the real OS/browser viewport»). Все с `maxWidth:100%`, так что на узком вьюпорте сожмётся, но при иной ширине статус-бар не тянется на всю ширину.
  - Fix: Наблюдение для design.md: зафиксировать, что CPQR-хром опирается на исходную 375px-сетку; при желании адаптива — вынести ширины в пропы. Правка не требуется.


### Семейство `scenario-ctyp-paybox-scenario` (7 находок)

#### `ctyp-paybox-scenario` — 3 экрана (payment/processing/success), все type валидны и в каталоге, слоты и события компонентов сопоставлены верно, пропы проходят strictObject-схемы без нарушений; regions (header/footer на @eui/FlowRoot, без Hotspot) и навигация (все экраны достижимы, цели navigate валидны) корректны; находки только гигиенические: spacer-chain vs gap, мёртвый paymentPressed, default-props-noise, спорная подпись ассета.

- **🟨 minor** · *prototype-doc* — **Экран payment собран на цепочке YpSpacer вместо gap (расходится с экраном success)**
  - Evidence: В `content` (YpBox mode=col, без gap) вставлены три спейсера: `paymentGapTop`{"type":"YpSpacer","size":8}, `paymentGapAfterBanner`{size:8, visible:showPayBanner}, `paymentGapBeforeSplit`{size:8} — это паттерн spacer-vs-gap/spacer-chain (layoutLints). При этом на экране success тот же эффект достигнут корректно через `successBody` YpBox с props.gap="sm". Несогласованность внутри одного прототипа.
  - Fix: Задать `content` YpBox props.gap="sm" (8px) и убрать элементы paymentGapTop/paymentGapAfterBanner/paymentGapBeforeSplit из children и elements. Это правка структуры дока (не схемы), non-breaking; conditional-gap вокруг баннера при скрытии showPayBanner естественно схлопнется до единого 8px gap.
- **🟨 minor** · *prototype-doc* — **Мёртвое состояние paymentPressed: пишется, но нигде не читается**
  - Evidence: state.paymentPressed=false в корне; footer press делает setState /paymentPressed=true; successFooter press делает setState /paymentPressed=false. Ни в одном `visible` или `$cond`/`$state` дока значение /paymentPressed не читается (читаются только /showPayBanner, /selectedSplit, /selectedMethod). Write-only состояние.
  - Fix: Либо удалить paymentPressed из state и обоих setState-обработчиков (упрощение), либо привязать его к реальному визуалу (например disabled/лоадер CTA). Правка дока, non-breaking.
- **🟨 minor** · *prototype-doc* — **default-props-noise: элементы несут пропы, равные дефолтам схемы**
  - Evidence: YpText `raiffeisenRewardText`/`payCardRewardText` перечисляют bold:false, prewrap:false, breakspace:false, capitalize:false, italic:false, fontCond:false, htmlFor:"", testId:"", overflow:"none", align:"left" — все совпадают с .default() в yp-text. Множество YpIcon несут color:"inherit", filter:"none" (дефолты yp-icon). Шум, затрудняющий чтение дока (lint default-props-noise).
  - Fix: Удалить из props дока ключи, значение которых равно дефолту схемы (color/filter у YpIcon, bold/prewrap/... у YpText). Схему/дефолты не трогаем — правка только дока, non-breaking.
- **🟨 minor** · *prototype-doc* — **Один и тот же ассет подписан по-разному: leading «Полная оплата» = reward «Плюс»**
  - Evidence: `fullPaymentLeading` (YpIcon slot=leading) использует url $asset=asset_db1424095ec6b209329db8fb2a232a93dda5dad8de83fca777db68227d4c9a3b с label:"Полная оплата". Тот же самый ассет asset_db1424095... используют `raiffeisenRewardIcon` и `payCardRewardIcon` с label:"Плюс". Один битмап описан двумя разными alt — как минимум одна подпись вводит в заблуждение (вероятно это глиф Плюса, а leading для «Полная оплата» подписан неверно).
  - Fix: Проверить содержимое ассета: если это знак Плюса — исправить label у fullPaymentLeading на корректный (например "Плюс" или пустой alt для декоративной иконки); если leading задуман иным глифом — подставить правильный asset_ URL. Правка значения пропа label/url, non-breaking.
- **ℹ️ info** · *prototype-doc* — **Нет doc.flows для линейного 3-экранного платёжного сценария**
  - Evidence: prototypes-meta: flows:0; в доке ключ flows отсутствует. Сценарий payment→processing→success→payment — готовый линейный CJM-путь, но flow не описан, поэтому в CJM-виде journey не читается как именованный сценарий.
  - Fix: Опционально добавить один flow (<=12) со шагами payment/processing/success и короткими notes для CJM-читаемости. Чистое дополнение, non-breaking.
- **ℹ️ info** · *prototype-doc* — **Легальная ссылка footer не подключена (no-op)**
  - Evidence: YpStickyPaymentFooter объявляет events ["press","legalPress"] и рендерит кнопку `legalLinkText`="лежит тут" с emit("legalPress"). В `footer.on` описан только press (setState+navigate); обработчика legalPress нет — клик по ссылке лигала ничего не делает.
  - Fix: Либо добавить footer.on.legalPress (например navigate на экран лигала или setState), либо оставить как есть, если no-op приемлем для прототипа. Дополнение дока, non-breaking.
- **ℹ️ info** · *prototype-doc* — **screen.note описывают провенанс, а не пользовательский контекст**
  - Evidence: Заметки экранов посвящены происхождению («Fluid successor of the composed golden-flow payment state», «The exact 375×812 reference boundary remains preserved in immutable version 3», «no unverified copy or artwork is introduced») вместо описания шага в CJM. Все <=500 символов, но для CJM-вида малополезны.
  - Fix: Переписать note в терминах пользовательского шага (что видит/делает пользователь, состояние), провенанс вынести в описание версии. Правка текста, non-breaking.


### Семейство `scenario-pay-app-home-v1` (6 находок)

#### `pay-app-home-v1` — Композиция чистая (shell+named slots, без spacer-цепочек), все type/пропы валидны по схемам; но canvasHeight populated обрезает CTA витрины, второй экран недостижим (0 flows) и есть default-props-noise.

- **🟧 MAJOR** · *prototype-doc* — **canvasHeight populated-экрана обрезает нижний CTA витрины**
  - Evidence: populated-shell props canvasHeight=1769, feedTop=76, tabHeight=83. Shell считает feedHeight = props.canvasHeight - props.feedTop - props.tabHeight = 1769-76-83 = 1610 и рендерит <main> с overflow:hidden. Фактический контент ленты (высоты компонентов зашиты): product 260 + savers 256 + loans 256 + more-important 196 + vitrina 650 + 4×feedGap(sm=8) = 1650px > 1610px. Нижние ~40px клипаются: кнопка «Все продукты» витрины (в YpAppHomeVitrina position:absolute bottom:20 height:48) обрезается снизу и вдобавок перекрывается плавающей payment-кнопкой (slot payment: inset auto/0/83/0 height 72). В loading-экране расчёт сходится точно (1538+3×8=1562 ≈ feed 1563), поэтому дефект только в populated.
  - Fix: Поднять populated-shell canvasHeight минимум до 1809 (76+1650+83), а чтобы CTA витрины не уходил под плавающую payment-кнопку — до ~1880. Значение в пределах схемы (max 2400), изменение только в доке.
- **🟨 minor** · *prototype-doc* — **home-populated недостижим: нет flow/навигации loading→populated**
  - Evidence: startScreen="home-first-state"; flows отсутствуют (meta flows:0); ни одного navigate-действия или Hotspot нигде в доке. Второй экран home-populated достижим только из редактора — в present/play-режиме зритель видит вечный skeleton и не попадает на заполненное состояние. В note явно указано «Omitted: all interactions», т.е. это осознанный пропуск, но для батча-«scenario» это разрыв сценария loading→populated.
  - Fix: Добавить переход loading→populated: либо flow с шагом-нотой, либо авто-advance/Hotspot со startScreen на home-populated. Non-breaking (доп. flow/элемент, существующие пропы не трогаются).
- **🟨 minor** · *prototype-doc* — **Пропы, дублирующие дефолты схемы (default-props-noise)**
  - Evidence: home-first-state shell повторяет ВСЕ дефолты схемы: canvasHeight 1722, navHeight 100, feedTop 76, tabHeight 83, accessibleLabel «Главный экран Яндекс Пэй». Все 4 chrome-инстанса задают time «15:07» (=default в YpAppHomeChrome). populated-payment задаёт label «Оплатить» и accessibleLabel «Оплатить» (=default в YpAppHomePaymentButton).
  - Fix: Убрать ТОЛЬКО безопасно-опускаемые: payment.label (компонент делает `props.label ?? "Оплатить"`) и chrome.time (рендерится напрямую, при undefined — пустые часы, не краш). Числовые пропы shell в home-first-state удалять НЕЛЬЗЯ — см. defensive-props shell (Renderer не инжектит дефолты, будет NaN). accessibleLabel лучше оставить для a11y.

#### `yp-app-home-savers` — 3 saver-карточки, все пропы обязательные и присутствуют; заголовок h2 весом 900 вне тем-шкалы.

- **🟨 minor** · *code-quality* — **Заголовки h2 используют fontWeight 900 вне тем-шкалы YS Text**
  - Evidence: Секционные заголовки заданы весом 900: YpAppHomeSavers line 62 `fontWeight: 900`, YpAppHomeLoans line 59, YpAppHomeMoreImportant line 54, YpAppHomeVitrina line 62. Тема yandex-pay объявляет только веса YS Text 400/500/700 — 900 отсутствует в шкале и даст синтетический bold или подмену начертания, несогласованно с остальной типографикой (тайтлы карточек 500).
  - Fix: Привести заголовки к весу 700 (ближайший объявленный тем-вес). Значение стиля, non-breaking; при необходимости точного соответствия исходнику — вынести в проп с дефолтом 700.

#### `yp-app-home-section` — Скелетон-секция product/savers/loans/vitrina, доступ к пропам безопасен; мелко: нет тени (в отличие от populated) и loading-высота vitrina 766≠650.

- **ℹ️ info** · *code-quality* — **loading-секции без тени, populated-секции с тенью — скачок между состояниями**
  - Evidence: YpAppHomeSection (loading) рендерит `background: sectionSurface` без boxShadow, тогда как populated-блоки (YpAppHomeProduct/Savers/Loans/MoreImportant/Vitrina) имеют `boxShadow: "0 4px 10px rgba(0,0,0,.05)"`. Плюс loading vitrina занимает 766px, а реальная YpAppHomeVitrina — фикс 650px: один и тот же раздел в двух состояниях имеет разную высоту и наличие тени, из-за чего переход loading→populated даёт визуальный сдвиг геометрии.
  - Fix: Добавить в YpAppHomeSection тот же boxShadow, что у populated-блоков, и согласовать высоту vitrina (766 в loading ↔ 650 populated). Non-breaking (только стили/дефолт-высоты).

#### `yp-app-home-shell` — Organism с 4 слотами; feedGap защищён space(?? sm), но canvasHeight/navHeight/feedTop/tabHeight читаются без ?? при .default() — хрупко к отсутствию дефолтов в Renderer.

- **🟧 MAJOR** · *defensive-props* — **Числовая геометрия shell читается без ?? при .default() в схеме**
  - Evidence: Схема: canvasHeight/navHeight/feedTop/tabHeight объявлены с .default(1722/100/76/83), но в теле компонента доступ без fallback: `const feedHeight = props.canvasHeight - props.feedTop - props.tabHeight;`, `height: props.navHeight`, `height: props.tabHeight`, `inset: \`${props.feedTop}px 0 auto 0\``. Renderer НЕ применяет zod-дефолты, поэтому автор, опустивший эти пропы (полагаясь на дефолт из definition), получит undefined → NaN-геометрию и сломанный layout. feedGap защищён (`space(props.feedGap ?? "sm")`), accessibleLabel безопасен как атрибут — а четыре числовых нет. В текущем доке все переданы явно, поэтому живого краша нет, но компонент хрупкий.
  - Fix: Добавить fallback на каждый числовой проп: `props.canvasHeight ?? 1722`, `props.navHeight ?? 100`, `props.feedTop ?? 76`, `props.tabHeight ?? 83` (значения дефолтов схемы). Non-breaking, только добавляет защиту.


### Семейство `scenario-yp-design-system-gallery` (8 находок)

#### `yp-design-system-gallery` — Витрина 59 компонентов (по 1 на экран, 0 flows): все element.type существуют в каталоге и все проп-значения валидны по схемам; 1 major (icon-bank рендерит пусто из-за пустого exactAssetUrl) + placeholder example.com-картинки, legacy-экран, отсутствие screen.note, мёртвый state /pressed.

- **🟧 MAJOR** · *prototype-doc* — **Экран icon-bank рендерит пустоту (YpIconBank возвращает null при пустом exactAssetUrl)**
  - Evidence: Скрин "icon-bank": props {"bank":"Sberbank","network":"Mir","exactAssetUrl":"","width":40,"height":24,"label":""}. В yp-icon-bank.tsx:29-30 `const exactAssetUrl = props.exactAssetUrl; if (!exactAssetUrl) return null;` — компонент игнорирует bank/network и рисует картинку только по exactAssetUrl. При exactAssetUrl:"" ячейка галереи для YpIconBank остаётся пустой, хотя проп-набор валиден по схеме.
  - Fix: Задать exactAssetUrl реальным URL ассета банка/сети (`/api/assets/asset_<sha256>`), как в example компонента (RAIFFEISEN_ASSET). Non-breaking — только значение пропа.
- **🟨 minor** · *prototype-doc* — **Битые placeholder-URL картинок example.com в баннерах**
  - Evidence: Скрин "promo-banner": imageUrl:"https://example.com/banner.png"; "banner-mini": iconUrl:"https://example.com/icon.png"; "banner-list": miniItems[].iconUrl и midItems[].imageUrl тоже "https://example.com/...". Компоненты рендерят <img src=...> (yp-promo-banner.tsx:74, yp-banner-mini.tsx:39/50) → broken-image. Соседний "banner-mid" использует настоящий {"$asset":"asset_c7109..."} — несогласованность.
  - Fix: Заменить example.com-URL на реальные {"$asset":"asset_<sha256>"} (или загруженные /api/assets URL) по образцу banner-mid. Non-breaking.
- **🟨 minor** · *prototype-doc* — **В галерею включён legacy/отклонённый компонент с самоуничижительным именем экрана**
  - Evidence: Скрин id "promo-banner", name: "CTYP Promo Banner (legacy, architecture rejected)", type YpPromoBanner. Хранить в витрине дизайн-системы явно "отклонённый архитектурно" компонент вводит в заблуждение зрителя галереи.
  - Fix: Убрать экран promo-banner из галереи (или заменить на актуальный баннер YpBannerMid/YpBannerMini). Non-breaking — удаление экрана из витрины.
- **🟨 minor** · *prototype-doc* — **Ни у одного из 59 экранов нет screen.note**
  - Evidence: Во всём документе отсутствует поле screen.note; каждый экран имеет только name = имя компонента ("Amount", "Button", ...). Для витрины дизайн-системы (CJM-читаемость, лимит note <=500) отсутствие пояснений снижает ценность showcase.
  - Fix: Добавить короткий screen.note на каждый экран: назначение компонента и демонстрируемое состояние. Non-breaking.
- **🟨 minor** · *prototype-doc* — **Мёртвое состояние /pressed: устанавливается, но нигде не читается**
  - Evidence: doc.state = {"pressed":false,"radioSelected":false,"selectedRadio":""}. Экран "button" по press делает setState /pressed=true, но ни один элемент галереи не привязан к /pressed (в отличие от /radioSelected и /selectedRadio, которые читает экран radio-button). Мёртвый state-override.
  - Fix: Убрать ключ pressed из state и обработчик press на кнопке, либо привязать /pressed к видимому изменению (например YpButton state). Non-breaking.
- **🟨 minor** · *prototype-doc* — **Шум в пропах YpIcon: sprite при mode=url, id 'icon-unused'**
  - Evidence: Скрин "icon": YpIcon props {"mode":"url","url":{"$asset":...},"sprite":{"id":"icon-unused","viewBox":"0 0 24 24"},...}. sprite опционален и при mode:"url" не используется компонентом; id буквально "icon-unused" — явный мусор/шум в доке.
  - Fix: Удалить проп sprite из этого экрана (mode:"url" использует только url). Non-breaking.
- **ℹ️ info** · *prototype-doc* — **Плоская галерея без flows/navigation/regions — ожидаемо для витрины**
  - Evidence: doc: flows отсутствуют (meta flows:0), startScreen:"amount", навигации navigate между экранами нет (только setState в button/radio-button), @eui/FlowRoot regions не используются. 59 независимых экранов достижимы только через UI-список галереи, не in-canvas. Для design-system gallery это штатно, битых navigate-целей нет.
  - Fix: Действий не требуется; при желании сгруппировать экраны по семействам (atoms/molecules/organisms) в именах для навигации по списку.
- **ℹ️ info** · *prototype-doc* — **Явное перечисление всех пропов (default-props-noise) — намеренная защита от Renderer-no-defaults**
  - Evidence: Почти все экраны задают каждый проп явно, включая равные дефолту схемы (напр. YpText: medium/bold/inline/... все false, htmlFor/testId ""; YpBox все дефолты). Формально это default-props-noise, но учитывая, что Renderer НЕ применяет zod-дефолты, явные пропы защищают компоненты от undefined в рантайме — корректный приём, не дефект.
  - Fix: Оставить как есть. Все проверенные проп-значения валидны по схемам компонентов (enum/literal/union совпадают).


### Семейство `atoms-stands-1` (6 находок)

#### `yp-atoms-arrow-button-states` — 3 экрана state-matrix (default/hover/pressed) для YpArrowButton, пропы валидны, компонент дефенсивен; único замечание — no-op press-хендлер в /lastPress (info).

- **ℹ️ info** · *prototype-doc* — **press-хендлер setState '/lastPress' ничего не отображает и не навигирует**
  - Evidence: Все 3 экрана: `on.press = {action:'setState', params:{statePath:'/lastPress', value:<state>}}`, при state:{} на корне. Значение /lastPress нигде не читается (нет stateOverrides/navigate/условного рендера), экраны не связаны переходами. Для evidence-стенда атома интеракция бессмысленна — просто пишет в state.
  - Fix: Либо убрать on.press (чистый визуальный state-matrix стенд), либо связать экраны navigate по press, чтобы демонстрировать интерактив. Не блокер — рендер корректен.

#### `yp-atoms-badge-caption-states` — 4 варианта YpBadge валидны, но каждый экран содержит default-props-noise (8+ дефолтных пропов); тримминг блокирован недефенсивностью самого yp-badge.

- **🟨 minor** · *prototype-doc* — **default-props-noise: каждый экран дублирует 8+ пропов на дефолтном значении**
  - Evidence: Во всех 4 экранах передаются pointValue:'2', discountRate:0.1, discountAmount:'', currency:'RUB', isMarketing:false, hideMinusSign:false, shadowRadius:'off', verticalOffset:0, color:'' — совпадают с .default() схемы YpBadge и не используются вариантами noCommission/nothingDueToday/commission (они читают только captionText). Плюс text:'Пэй' игнорируется этими вариантами.
  - Fix: Сократить пропы каждого экрана до значимых (variant, captionText, size). ВНИМАНИЕ: тримминг безопасен только ПОСЛЕ дефенсивного фикса yp-badge — сейчас компонент не применяет дефолты, и удаление пропов вызовет NaN-рендер в discount-ветке. Сначала фикс компонента, потом чистка дока.

#### `yp-atoms-button-states` — 6 состояний YpButton inverted-gray L рендерятся корректно (state передан явно), но label/before/after/isProgress/disabled — default-props-noise.

- **🟨 minor** · *prototype-doc* — **default-props-noise: label/before/after/isProgress/disabled на дефолтах во всех 6 экранах**
  - Evidence: Каждый экран передаёт label:'', before:'', after:'', isProgress:false, disabled:false — совпадают с .default() схемы YpButton. Компонент читает их дефенсивно (`props.label ? ...`, `{props.before}`), поэтому их удаление из дока безопасно. Значимые пропы size:'l', variant:'inverted-gray', state:<per-screen> оставить обязательно (недефенсивный lookup, см. находку по yp-button).
  - Fix: Убрать из каждого экрана label/before/after/isProgress/disabled, оставив text/size/variant/state.

#### `yp-badge` — Много не-defensive доступов (size→NaN, discountRate→NaN%, variant→не та ветка, verticalOffset/currency), бедные examples, несогласованные имена токенов — самый проблемный в батче.

- **🟧 MAJOR** · *defensive-props* — **YpBadge: дефолт variant='accent' не соблюдается в рантайме, недефенсивная арифметика даёт NaN%**
  - Evidence: Строки 27-44: ветки `if (props.variant === 'accent'|'highlight'|...)`; последняя ветка (discount) — fallthrough. `variant` имеет .default('accent'), но Renderer дефолты не применяет: док `{}` → props.variant undefined → ни один if не сработал → падает в discount-ветку. Там `props.discountRate * 10000` (строка 42) с undefined = NaN → percent NaN → рендерит '−NaN%'; `fontSizes[legacySize]` при props.size undefined = undefined; `Number(legacySize)` = NaN → minHeight NaN; `currencySigns[props.currency]` при undefined. Итог — сломанный рендер вместо ожидаемого accent-бейджа. Доки батча передают все пропы, поэтому не падают.
  - Fix: Не меняя схему, зафиксировать дефолты в теле: `const variant = props.variant ?? 'accent';` и ветвиться по нему; `props.discountRate ?? 0.1`, `props.currency ?? 'RUB'`, `props.size ?? '14'`, `props.text ?? 'Пэй'`, `props.verticalOffset ?? 0`, `props.shadowRadius ?? 'off'`.
- **ℹ️ info** · *code-quality* — **Несогласованные цвета и имена токенов между компонентами батча**
  - Evidence: Два разных «фирменных фиолетовых»: chart-informer'ы используют `var(--color-split, #5c33d6)` (строки 40-46 default), а YpBadge accent — `var(--fill-color-4-400, #6b47ff)` (строка 38). Первичный текст записан по-разному: #111214 в arrow-button/context-banner против #111 в badge (строка 44 `--text-color-primary-static, #111`). Несогласованные имена токенов для одинакового по смыслу цвета: `--fill-color4-400` (#56c776, badge строка 33) vs `--fill-color-4-400` (#6b47ff, строка 38) vs `--fill-color-default-200` (chart) — конвенция fill-colorN и fill-color-N смешана. Жёлтый #ffdc60 идёт под `--text-product-split` (badge) и под `--button-color-primary` (button).
  - Fix: Сырьё для design.md: свести split-фиолетовый к одному значению/токену, унифицировать запись первичного текста (#111214) и конвенцию имён fill-color-*. Non-breaking, требует согласования дизайн-токенов, не правки схем.

#### `yp-button` — Два blocker'а: деструктуризация sizes[props.size] и palette!/invertedGray падают при undefined size/variant/state; плюс минорные — description L/M/S без xs, вес 600 вне шкалы темы.

- **🟥 BLOCKER** · *defensive-props* — **YpButton: недефенсивные lookup sizes[props.size] и invertedGrayColors[state] крашат рендер**
  - Evidence: Строка 45: `const [height, radius, fontSize, pad, gap, iconSize] = sizes[props.size];` и строка 50: `const invertedGray = invertedGrayColors[state];`. Схема даёт `size` и `state` .default(), значит на входе они опциональны, а Renderer НЕ применяет zod-дефолты. Валидный по схеме док `{text:'X', variant:'inverted-gray'}` (без size/state) → sizes[undefined] = undefined → деструктуризация undefined = TypeError; либо invertedGrayColors[undefined] = undefined → `invertedGray[0]` (строка 52) = TypeError. Прототипы этого батча передают size/state явно и не падают, но любой другой док с inverted-gray без state крашится.
  - Fix: Добавить fallback без изменения схемы: `sizes[props.size ?? 'l']`, вычислять `const rawState = props.isProgress ? 'processing' : props.disabled ? 'disabled' : (props.state ?? 'default')`, и `const invertedGray = invertedGrayColors[state] ?? invertedGrayColors.default;`. Как в эталоне yp-box (?? на каждом пропе).


### Семейство `atoms-stands-2` (10 находок)

#### `yp-atoms-notification` — Валиден, ссылки/пропы корректны; canvas 375×96 против заявленной/рендеримой высоты 64 (minor), нет screen.note.

- **🟨 minor** · *prototype-doc* — **canvas 375×96 не совпадает с заявленной/рендеримой высотой 64**
  - Evidence: canvas.height=96, при этом description говорит «375×64 notification», а YpNotification рендерит фиксированные `height: 64` и `minHeight: 64`. На холсте остаётся 32px пустого места снизу; заявленный размер не соответствует canvas.
  - Fix: Non-breaking: привести canvas.height к фактическим 64 (правка только прототипа).

#### `yp-atoms-plus-badge-states` — 3 экрана валидны, YpPlusBadge оборонительный; default-props-noise (6/7 пропов = дефолты), нет screen.note.

- **🟨 minor** · *prototype-doc* — **default-props-noise: большинство пропов повторяют дефолты**
  - Evidence: Screen `default`: `variant:"icon-first"`(default), `text:""`(default), `upTo:false`(default), `withGradientBg:false`(default), `testId:""`(default), `exactAssetUrl` = DEFAULT_PLUS_ASSET(default) — 6 из 7 пропов равны дефолтам схемы. Аналогично в elevated/trailing часть пропов = дефолты.
  - Fix: Non-breaking: убрать из доков пропы, равные дефолтам — YpPlusBadge оборонительный (`props.x ?? default`, `props.exactAssetUrl || DEFAULT`), рендер не изменится. Оставить только значащие для состояния пропы.

#### `yp-atoms-snippet-discount-plus` — Валиден, но subscription:true/false рендерятся идентично (компонент меняет только data-атрибут), два «варианта» неотличимы.

- **🟨 minor** · *prototype-doc* — **subscription true/false визуально идентичны**
  - Evidence: Два инстанса YpSnippetDiscountPlus (`subscription:false` и `subscription:true`) рендерятся одинаково: в компоненте `subscription` управляет только `data-subscription={subscription ? "yes":"no"}` и передаётся в accessibleLabel; ни один визуальный узел от него не зависит. Экран показывает две неотличимые строки, помеченные как разные варианты подписки.
  - Fix: Non-breaking: добавить в YpSnippetDiscountPlus additive-индикатор подписки (бейдж/иконка), либо screen.note о семантической природе различия. Пропы/схему не менять.

#### `yp-atoms-snippet-discount-states` — 1 экран на оси state(5)×discountFor(3); в компоненте оси — только data-атрибуты, визуальной разницы нет, покрытие тонкое.

- **🟨 minor** · *prototype-doc* — **Тонкое покрытие: 1 экран на оси state×discountFor, состояния — только data-атрибуты**
  - Evidence: Прототип содержит единственный экран `common/pay` для компонента с осями state(5)×discountFor(3). В YpSnippetDiscount оба пропа попадают только в data-атрибуты (`data-state`, `data-discount-for`), рендер текста от них не зависит — все 15 комбинаций визуально идентичны. Прототип не демонстрирует ни одной оси, а показывает единственное состояние.
  - Fix: Non-breaking: description уже ссылается на definition.examples; добавить screen.note о семантической природе осей. Реальная дифференциация — additive-оформление в компоненте (non-breaking).

#### `yp-atoms-snippet-plus-states` — 8 YpSnippetPlus, все пропы валидны, но 7 из 8 состояний визуально идентичны (различается только promo) — «eight states» вводит в заблуждение (major).

- **🟨 minor** · *prototype-doc* — **8 «состояний» рендерятся визуально одинаково (кроме promo)** (понижена verify)
  - Evidence: Прототип показывает 8 состояний (default/elevated/promo/after-final-payment/why/limit/subscription/recurring), но в YpSnippetPlus состояние влияет на рендер только для promo: `const promo = state === "promo"` → height 36, align flex-start, whitespace normal. Остальные 7 состояний задают лишь `data-state={state}`, текст всегда серый `#6b6d74` 13/18/400. Визуально 7 из 8 «состояний» неотличимы, а description заявляет «eight source-proven snippet/plus states» — эвиденс вводит в заблуждение.
  - Fix: Non-breaking: добавить screen.note, что состояния различаются только семантически (data-state/aria) и визуальная дифференциация pending; либо additive-фикс в YpSnippetPlus — per-state визуальное оформление (цвет/иконка) по Figma-источнику. Схему и пропы не трогать.

#### `yp-atoms-text-field-filled-stroke` — 7 экранов = 7 examples определения, YpTextField полностью оборонительный, крашей нет; default-props-noise (size/type/inputMode/mask/isClearable = дефолты).

- **🟨 minor** · *prototype-doc* — **default-props-noise во всех 7 экранах**
  - Evidence: Во всех 7 экранах повторяются пропы, равные дефолтам схемы: `size:"xl"`(literal default), `type:"text"`, `inputMode:"text"`, `mask:""`, `isClearable:false`, `variant:"filled"`. Оси, реально меняющие рендер (interactionState/filled/state/hint), тонут среди шумовых пропов; компонент оборонительный (`props.x ?? ...`).
  - Fix: Non-breaking: оставить в доках только оси State×Error×Filled + sourceVariant, удалить пропы = дефолты. Рендер идентичен за счёт fallback в компоненте.

#### `yp-notification` — Пропсы required (defensive ок), рендер безопасен; minor: процессное Figma-описание, одиночный example.

- **🟨 minor** · *code-quality* — **Несогласованный fallback text-color-primary между атомами**
  - Evidence: Fallback одного семантического токена text-color-primary написан по-разному в соседних атомах батча: YpNotification `var(--text-color-primary, #111214)`, YpPlusText `var(--text-color-primary,#111)`, YpTextField `var(--text-color-primary, #1f2023)`. Три разных hex для одного смысла — даст дубли/шум при генерации design.md.
  - Fix: Non-breaking: унифицировать литерал fallback (например `#1f2023`) во всех трёх компонентах; правка только строк-фолбэков, токен/пропы не трогать.

#### `yp-plus-badge` — Оборонительный (?? на amount/variant/withGradientBg/exactAssetUrl), registry-ассет Плюса, есть examples-мапа; замечание только по расхождению фолбэка plus-glyph-gradient с соседями.

- **ℹ️ info** · *code-quality* — **Белый фон именуется двумя разными токенами**
  - Evidence: Белая поверхность записана разными токенами: YpPlusBadge `var(--background-color-primary, #fff)`, YpTextField (filled_light) `var(--fill-color-default-0, #fff)`. Один цвет — два семантических имени токена; при сборке design.md породит дубли.
  - Fix: Non-breaking: выбрать единый токен «белая поверхность» и использовать его первым в var() во всех атомах; правка только имён CSS-переменных.

#### `yp-promo-tooltip` — Пропсы required (defensive ок), рендер безопасен; info: Figma-описание, дублирование tooltip-поверхности с yp-tooltip.

- **ℹ️ info** · *code-quality* — **Инвертированный текст: разные токены и разные значения**
  - Evidence: Белый текст на тёмном записан по-разному: YpPromoTooltip `var(--text-color-primary-inverted, #fffffffa)`, YpPlusBadge `var(--text-color-primary-inverted-static, #fff)`. Разные имена токена и разные hex (#fffffffa vs #fff).
  - Fix: Non-breaking: согласовать имя токена и значение инвертированного текста между компонентами.

#### `yp-text-field` — Образцово оборонительный (?? на каждом пропе, 7 slug-examples), минорно: глобальная <style> ::placeholder, мёртвый size-литерал, три написания text-secondary.

- **🟨 minor** · *code-quality* — **Несогласованный fallback text-color-secondary (в т.ч. внутри одного компонента)**
  - Evidence: Fallback text-color-secondary расходится: снипеты (YpSnippetDiscount/Plus/DiscountPlus) `#6b6d74`; в YpTextField placeholder `var(--text-color-secondary,#767779)`, а hint `var(--text-color-secondary, #777)` — два разных значения вторичного текста внутри одного компонента, плюс третье в снипетах.
  - Fix: Non-breaking: свести все fallback text-color-secondary к единому литералу (`#6b6d74`).


## Дополнительные находки механических свипов (вне батчей)

- **🟧 MAJOR** · *definition-quality* — **yp-tooltip: слоты trigger/title/subtitle/link объявлены, но не рендерятся** (свип по всем 100 компонентам; тело не обращается к slots).
- **🟧 MAJOR** · *definition-quality* — **yp-animated-collapse: слот content объявлен, но не рендерится** (аналогично).
- **🟨 minor** · *abi-hygiene* — **fontWeight вне шкалы темы (400/500/700) в 13 компонентах**: yp-badge(600), yp-cashback-badge(800), yp-loyalty-badge(600,800), yp-screen(600), yp-cpqr-sheet-frame(600), yp-cpqr-status-bar(600), yp-best-profit-base-card-mini(600), yp-ctyp-payment-page(600), yp-app-home-loans/savers/vitrina/more-important(900) — браузер синтезирует faux-bold.
- **ℹ️ info** · *code-quality* — **глиф Плюса рендерится кириллической «Я»** в yp-cashback-badge и родственных (наблюдение критика).
- **ℹ️ info** · *prototype-doc* — **экспозиция опасных пропов в живых доках**: только `yp-app-home-shell` без `payButtonTop` (pay-app-home-v1) и `yp-payment-method-card` без `surface` (ctyp-paybox-scenario); полные данные — `exposure.json`.
- **ℹ️ info** · *prototype-doc* — **шов прототип↔компонент чист**: сверка slot-имён и `on`-ключей с definitions по всем 33 докам — 0 несоответствий; props валидированы сервером при импорте.