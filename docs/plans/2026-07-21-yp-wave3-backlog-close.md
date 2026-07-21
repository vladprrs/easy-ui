# Волна 3 каталога yandex-pay — закрытие бэклога B (H2/H8/H4/H7/H5, зонтик H10)

Ревизия v2 после адверсариального ревью (3 Opus-ревьюера: механика / скоуп / миграции-прод). Триаж находок — в конце документа.

## Context

Бэклог `docs/product-hypotheses-2026-07-20.md` закрыт частично: фикс-волна A (2026-07-20) и волна 2 (2026-07-21: theme v5 с 8 пилотными `color.*`, ABI v4 `color(key, fallback)`, H6 currency-enum, H9 seed, H3-B шкала 400/500/700) выполнены и на проде, 0 регрессий. Остались H2 (кросс-семейный канон семантических цветов — 152 defer-записи реестра), H8 (градиенты — 21 запись реестра; тени — не в реестре, каталогизированы в design.md §1.1), H4 (numeric spacing → `space()`), H7 (asset-url контракт), H5 (near-duplicates), H10 (runtime-адопция — зонтик, закрывается попутно).

**Решения пользователя (зафиксированы):** всё оставшееся — одной большой волной с под-волнами; канон `text.primary` = **`rgba(0,0,0,.86)`**. Каноны остальных семей — предложены ниже (§W-A), утверждаются на гейте A1.

**Ключевое отличие от волны 2:** волна 2 была no-op (fallback == литерал, diff обязан = 0). Волна 3 для канонизируемых семей меняет пиксели **осознанно**: fallback и тем-токен = канон ≠ прежний литерал → diff ≠ 0 с триажем (§Триаж). Для остальных записей реестра (тинты, product-цвета, декоративные градиенты) — **literal-preserving токенизация по механике волны 2** (value == литерал, diff = 0): полное покрытие реестра без выдумывания канонов там, где дизайн-решения нет.

Инструментарий переиспользуется: `work/yp-wave2/gen-registry.mjs`, `h6-inventory.mjs` (шаблон инвентаря доков), `h1-dom-gate.mjs` (DOM-гейт, расширяется до первичного гейта триажа), `work/yp-fixes/scripts/{capture,diff,publish,prod-baseline,prod-diff}.mjs`, регламент §W3 из `docs/plans/2026-07-20-yp-catalog-fixes.md`.

## Процесс

1. ~~Сохранить план, закоммитить~~ — сделано (a79deb5), ревизия v2 — этот документ.
2. Адверсариальное ревью — выполнено, триаж внизу; контрольное ревью ревизии — до старта исполнения.
3. Исполнение: Fable 5 оркестрирует, Opus-субагенты исполняют по ownership; оркестратор независимо верифицирует done-критерии и коммитит.

**Обязательные стоп-точки (гейты):**
- **G1** — утверждение полной канон-таблицы и диспозиции всех 152+21 записей реестра v6 (итог A1/A2) **до** запуска W-C/W-D.
- **G2** — после W-B: прод-тема v6 на месте, значения 8 v5-ключей побайтово не изменились, diff прода = 0.
- **G3** — после канарейки W-C: sign-off триажа первого diff≠0 компонента **до** батча по носителям.
- Застрявший канон в W-C/W-D не блокирует W-E/W-F/W-G (независимы от темы v6).

## Архитектура волны

```
W-A каноны + реестр v6 (полная диспозиция) + инвентари (2 субагента ∥)
W-B тема v6 + валидация shadow/radial (server) → образ → PATCH прода   [гейт G2]
   ├→ W-C H2 канонизация + literal-preserving (батчи по НОСИТЕЛЯМ)     — требует v6, гейты G1,G3
   ├→ W-D H8 тени/градиенты/Плюс-ассет                                 — требует v6, гейт G1
   ├→ W-E H4 spacing (yp-text, yp-skeleton)                            — независим от v6
   ├→ W-F H7 asset-url (скоуп = инвентарь A3, не фикс-список)          — независим от v6
   └→ W-G H5 banner-merge + shared-helpers + design.md-роли            — независим от v6
W-H верификация + прод-выкатки §W3 (по под-волнам) + доки/память
```

Рекомендуемый порядок выкаток (риск по нарастающей): W-B → W-E (diff=0) → W-F (diff=0) → W-G (helpers diff=0, затем merge) → W-C (diff≠0 триаж) → W-D (крупнейший diff, Плюс).

## W-A — Каноны, реестр v6, инвентари (workspace `work/yp-wave3/`, READ-ONLY скрипты)

### A1 — Канон-таблица (гейт G1; принцип — rgba-alpha-форма; «≈» = субпиксельная дельта <0.5/255, diff будет ≠0, триажится автоматом)

| Семья | Канон | Обоснование |
|---|---|---|
| text.primary | `rgba(0,0,0,.86)` | зафиксирован пользователем; folds #000000d8, #1f2023, #111 |
| text.secondary | `rgba(0,0,0,.5)` | топ-частота; #00000080 ≈ (α.5019); folds #6b6d74 и близкие |
| text.tertiary | `rgba(0,0,0,.3)` | ≈ #0000004d; folds #777a85/#93979e per-case (opaque на цвете) |
| text.quaternary | `rgba(0,0,0,.2)` | == #0003 (точно); folds #d6d7da per-case |
| text.inverted | `#fff` | топ-12; rgba(255,255,255,.98) остаётся surface-overlay |
| text.positive | `#56c776` | топ-частота (×3); folds #2c9e56/#56c676/#56c772 — предварительно, утвердить в A1 по контексту носителей |
| text.negative | `#f33` | ×2; var-fallback #ff4d52 — per-case, утвердить в A1 |
| accent.blue | `#188fc7` | ×2; folds #0a6cff/#1551e5 per-case (возможно, разные роли link/info — решить в A1) |
| separator | `rgba(0,0,0,.08)` | ≈ #00000014 |
| border-hairline | `#e1e3e8` | opaque-бордеры карточек; folds #dedfe3 и близкие per-case |
| fill-muted | `#f5f7f9` | эталон yp-skeleton; носители трёх v5 fill-muted-* переключаются на него в W-C; сами v5-ключи остаются в теме нетронутыми (инвариант W-B) |
| split | `#5c33d6` | бренд Bank Split |
| plus | `#6b47ff` | стоп градиента Плюса; folds #8f42ff/#7b42f6 per-case |
| shadow.medium | `0 8px 24px rgba(0,0,0,.12)` | design.md §1.1; свод .10↔.12; футер — shadow.medium-up (`0 -8px …`) |
| shadow.low | `0 2px 8px rgba(0,0,0,.08)` | yp-block; ручка yp-switch (`0 1px 3px #0003`) — отдельный shadow.low-handle, НЕ сводится |
| shadow.high | `0 16px 40px rgba(0,0,0,.16)` | design.md §1.1 |
| gradient.plus | `linear-gradient(135deg,#ff2e93 0%,#8b3dff 52%,#3277ff 100%)` | design.md §1.1; свод 90deg/2-стоп |
| gradient.shimmer | текущий шиммер yp-skeleton | literal-preserving (канонизации нет) |

**Правило полного покрытия реестра (закрывает блокеры ревью B1/B2).** Каждая из 152 defer-H2 и 21 defer-H8 записей получает в реестре v6 явную диспозицию:
- `canon-now` — семьи из таблицы выше (пиксель → канон, триаж);
- `literal-preserve` — surface-тинты (~11: #fae9f6/#e1fae7/#fff0d9/#e6f0ff/#e4d5fa и т.п.), product-цвета (savers/loans/pay-black), декоративные градиенты (~19 из 21: promo-семья #ff5c4d/#eb469f/#8341ef, radial-глоу, rainbow, карточные) → токены `color.tint-*`/`color.product-*`/`color.gradient-*` со значением == литерал, diff = 0 (механика волны 2);
- `skip` — одноразовые уникальные литералы без семантической роли: остаются литералами, счётчик фиксируется в реестре (не «unbounded per-case»).
Aggregate-записи (41 шт., `color.agg-*`) и var()-записи (36 шт.) — не мигрируются как строки: A4 разворачивает их в пер-вхождения конкретных литералов в носителях, и **done-критерий покрытия для них — пер-вхожденческий** (сумма occurrences из carriers.mjs, не ярлык на meta-записи). Правило переписывания `var(--x, <literal>)` → `color("<key>", "<canon|literal>")` (var заменяется целиком; legacy-vars consume-only — никем не эмитятся, подтверждено ревью); вложенные цепочки `var(--x, var(--y, <literal>))` — тоже заменяются целиком по конечному литералу. Свод `fill-muted` (#f2f3f5/#f3f5f7 → #f5f7f9) — осознанный canon-now diff на носителях; новый ключ `color.fill-muted` семантически отделён от трёх v5-орфанов.

### A2 — Реестр v6
`work/yp-wave3/token-registry-v6.json` (перегенерация `gen-registry.mjs`): поля literal / key / disposition (canon-now|literal-preserve|skip) / canon-value / prev-value / family / frequency. Тени добавить вручную из design.md §1.1 (в реестре их 0 — подтверждено). Done-критерий: **каждая из 173 + N-теневых записей имеет диспозицию**; для agg/var-записей — диспозиция по каждому развёрнутому вхождению (A4), счётчики сходятся.

### A3 — Инвентари H4/H7
`h4-inventory.mjs`, `h7-inventory.mjs` по шаблону `h6-inventory.mjs`: **read-only** обход всех доков×ревизий×версий (вкл. архивные) через GET. H4 — numeric-значения spacing-пропов узлов yp-text/yp-skeleton; H7 — **все** url-пропы всех yp-компонентов (классификация: asset-ref / внешний / data-URI / легитимно-свободный вроде `yp-icon mode:"url"`). Restore **не валидирует с 422** (валидация пишется в ledger, не блокирует) — гейт корректности инвентаря это сам read-only скрипт + checkpoint-save (PUT) живых доков.

### A4 — Носители
`carriers.mjs` (grep по `work/yp-fixes/components/*/source.tsx` + актуальным версиям): литерал → компоненты-носители с пер-вхождениями (разворачивает aggregate/var-записи). Из него формируются **батчи W-C по компонентам**.

## W-B — Тема v6 + валидация shadow/radial

Владение: `server/designSystemsMeta.ts`, `server/design-systems-theme.test.ts`.

- **B1 валидация — namespace-branch в `colorTokenIssues`:** `color.shadow-*` → SHADOW_RE (`[inset] Xpx Ypx [blur] [spread] color`, отрицательные смещения, comma-list); `color.gradient-*` → GRADIENT_RE (добавить `radial-gradient`); прочие `color.*` → текущий `isColorValue`. Заметка: `linear-gradient` уже проходит текущий allowlist — новые кейсы фактически только shadow-строки и radial. Тени/градиенты остаются под `color.*` → читаются существующим `color()` ABI v4, без нового ABI. `tokenKeySchema` допускает нужные ключи (проверено), `tokenValueSchema` (бан `;{}<>`, ≤256) пропускает каноны — но длину каждого literal-preserve градиента проверить (≤256, иначе skip).
  Тест-кейсы: регресс `#fff`/`rgba(255,255,255,.98)` + `0 8px 24px rgba(0,0,0,.12)`, `0 -8px 24px …`, `radial-gradient(…)`, gradient.plus.
- **B2 сбор темы** (`w-b-theme.mjs`): PATCH-семантика **заменяет коллекцию tokens целиком** → **инвариант: v6 = GET v5 → все `space.*` и все 8 v5 `color.*` с побайтово теми же значениями + append новых ключей**. Никакой «консолидации» v5-ключей в теме — fill-muted сводится только переключением носителей в W-C, старые ключи остаются орфанами. `fonts`/`icons` в PATCH опустить.
- **B3 PATCH:** стенд (эмиссия `--eui-color-*` в `:root`, `c2-emission-check.mjs`) → прод: снапшот v5 → `work/yp-wave3/rollback-theme.json` → PATCH `baseVersion:5 → v6` → **проверка G2: 8 v5-ключей побайтово равны v5, прод-diff = 0**.
- **Гейт деплоя:** server-изменения едут образом (Actions → GHCR → Dokploy) **до** прод-PATCH. Гейт естественный: старый валидатор отвергнет shadow/radial значения с 422 (fail-safe, порчи нет). Прод может жить с расширенным валидатором без v6-токенов сколько угодно (валидация только на PATCH-пути) — под-волны можно растягивать.

## W-C — H2: канонизация + literal-preserving (батчи по носителям)

Механика пер-вхождению: литерал в носителе → `color("<key>", "<canon|literal>")`. Для canon-now fallback = канон (пиксель меняется и с темой, и без); для literal-preserve fallback = литерал (no-op). `var(--x, <literal>)` переписывается целиком в `color()`.

**Разбивка — по компонентам-носителям из A4, не по цветовым семьям** (один компонент несёт литералы нескольких семей — yp-badge: text.* + plus; yp-payment-method-card: text.* + тинты + карточные градиенты). Каждый компонент правится ровно одним субагентом, в один заход, по всем его записям реестра (включая его W-D-тени/градиенты, если компонент попал и туда — тогда владелец один на C+D для этого файла). Батчи по 8–12 компонентов, приоритет по частоте/заметности.

Done (на батч): publish `hostAbiVersion===4`; первичный гейт — **программная computed-style дельта** (§Триаж); per-example capture+diff; per-case литералы (opaque на цветном фоне) — ручная визуальная приёмка. Канарейка первого батча — гейт G3.

## W-D — H8: тени, градиенты, знак Плюса

**Ownership:** файлы, несущие и цветовые, и shadow/gradient-записи, целиком уходят в свой W-C-батч (тот субагент делает и H8-правки этого файла); владелец W-D правит **только** файлы, не затронутые W-C. Противоречия «1 владелец W-D vs общий файл» нет: правило одно — один файл = один субагент.

- D1: Плюс-ассет `asset_2a907dc8…` (design.md §4.3) — проверить наличие на проде, при отсутствии залить **до** publish.
- D2: `--shadow-*` fallback-и → `color("shadow-medium|low|high|medium-up|low-handle", "<канон>")`.
- D3: градиенты Плюса → `color("gradient-plus", "<канон 135deg>")`; шиммер и все декоративные градиенты → literal-preserve `gradient.*` (diff=0).
- D4: глифы «Я» (yp-cashback-badge, yp-loyalty-badge) и «✦» (yp-plus-return) → `<img>` с Плюс-ассетом (эталон yp-plus-badge). Diff крупный — обязательная визуальная приёмка, критерий «паритет с реальным Yandex Pay».

## W-E — H4: numeric spacing → space() (1 субагент; yp-spacer НЕ трогать)

- Проп-тип: **существующий числовой union сохраняется буквально** (не пере-выводить из инвентаря — потеря литерала даст 422 на re-pin) + отдельная ветка `z.enum(["none","xs","sm","md","lg","xl","2xl","3xl","4xl"])` — **реальные ключи шкалы** (`src/designSystems/types.ts`, `spacingScale.ts`; `space()` кидает TypeError на неизвестный ключ). Render: строка → `space(key)`, число → px legacy.
- `yp-text` и `yp-skeleton` бампаются ABI v1 → v4 (импорт `space` + `color()` для их записей реестра — H10-зонтик). У yp-skeleton не сломать `margin:auto`.
- Тем-значения шкалы идентичны canonical fallback (none 0/xs 4/sm 8/md 12/lg 16/xl 24/2xl 32/3xl 48/4xl 64, проверено по прод-снапшоту) → exact-match миграция no-op.
- `h4-migrate.mjs`: **только exact-match** число → токен (9 значений, diff=0); off-token остаются числами; near-match — не автоконверт (`--near` для ручного триажа).
- Проверить рендер editor-controls для `anyOf[number-union, string-enum]` в инспекторе и `/library/c/yp-text`.

## W-F — H7: asset-url контракт (1 субагент)

- **Скоуп = инвентарь A3, а не фикс-список.** Известные носители сверх исходного списка: `yp-banner-list`, `yp-banner-mini`, `yp-paybox-nav-bar`, `yp-payment-method-card`, `yp-sticky-native-footer`, `yp-app-home-payment-button`, `yp-cpqr-home-card`, `yp-badge` (`exactAssetUrl`), плюс `yp-app-home-vitrina`, `yp-cpqr-*`, `yp-custom-*`, баннеры (координация с W-G — schema-правки баннеров едут в W-G-версии). Легитимно-свободные URL (напр. `yp-icon mode:"url"`) классифицируются явно и не сужаются.
- Regex `/^\/api\/assets\/asset_[a-f0-9]{64}$/` (совпадает с серверным `ASSET_ID`).
- Порядок: инвентарь → предзаливка внешних/inline в `POST /api/assets` (дедуп sha256, маппинг old→ref) → publish → миграция доков + re-pin. Гейт корректности — checkpoint-save (PUT) живых доков; архивные проверяются read-only скриптом (restore не блокирует, пишет ledger `ok=0` — свериться с `validation_records` после любых restore).
- Старые пины рендерятся (immutable versions, подтверждено server-api) — 422-риск только на re-pin, закрыт предзаливкой.

## W-G — H5: banner-merge + shared-helpers + роли (1 субагент)

- **Канон = `yp-promo-banner`**, но merge обязан параметризовать **геометрию image-колонки**: promo — адаптив `min(148, max(120, w-160))`/`objectFit:cover`; banner-mid — фикс `148×120`, `align-self:flex-end`, `objectPosition:center bottom`. Вводится проп `imageLayout: "adaptive" | "fixed-bottom"` (или эквивалент), иначе мигрированные mid-доки сдвинут артворк. CTA-геометрия (76×36 vs 134×40) — тоже параметр/вариант.
- Tone-маппинг: `purple` (`#efedf7`) — новый фон канона; `green`/`pink` — **алиасы** существующих variant-фонов (`#e1fae7`≈split, `#fae9f6`≈cashback), не отдельные дубли. `width: number | enum "327"|"336"|"343"`; `height?`.
- `yp-banner-mid` → deprecated (CAS по statusRev; старые пины рендерятся). Миграция доков: маппинг ручной + визуальный триаж; re-pin.
- Shared-helpers (non-breaking, diff обязан = 0): section/BadgeHeading/rail для savers/loans; статус-бар/часы (yp-cpqr-sheet-frame / yp-cpqr-status-bar / yp-app-home-chrome); tooltip-поверхность.
- design.md: роли banner-канона, статус-бара, tooltip **+ discount-badge (§4.2) + разграничение `yp-panel`↔`yp-screen`** (обязательства бэклога H5, не выпадают).

## Триаж diff≠0 (W-C/W-D)

**Первичный гейт — программный, не глаза** (152 записи вручную — риск штамповки): построить `dom-gate-v2.mjs` на базе `h1-dom-gate.mjs` и прогонять по **всем** мигрируемым носителям. Требования (done-критерий W-A, до старта W-C): набор свойств расширен с `background/backgroundColor/boxShadow/color` до `border*`, `outline*`, `fill`/`stroke` (SVG), `backgroundImage`, `textDecorationColor`; снимается геометрия (`getBoundingClientRect` по поддереву) для assert «layout не изменился»; авторские литералы нормализуются к browser-computed форме перед сравнением (напр. `#000000d8` → `rgba(0, 0, 0, 0.847)`). Assert: изменились **ровно целевые свойства** и ровно `prev-value → canon-value` из реестра v6 (для literal-preserve — равны), геометрия не изменилась. Поверх — per-example capture+diff (`dimsMatch:true`, дельта локализована).
Глаза — только: per-case литералы (opaque на цветном фоне), Плюс-глиф (D4), banner-merge миграция (W-G). Каждый ненулевой diff — запись в `work/yp-wave3/triage-<subwave>.md`. Аватар seeded, шиммеры — DOM-гейт.

## W-H — Верификация, выкатка, доки

- Локально (гейт каждой под-волны): `npm run verify`, `npm run e2e`, runtime-прогон `/verify`; publish `hostAbiVersion===4`.
- Прод: §W3-цикл на под-волну — admin-сессия+Origin → бэкап+инвентарь → предзаливка ассетов → baseline → канарейка (W-C: первый батч-компонент; W-D: yp-plus-return; W-E: yp-skeleton; W-F: yp-app-home-vitrina; W-G: yp-promo-banner) → батч publish по одному, барьер 100% active → re-pin checkpoint-save → триаж → финальный бэкап `.backups/prod-wave3-<date>/`.
- **Первичный прод-гейт — per-example capture (как в волне 2).** `GALLERY_SCREENS` — фильтр экранов одного прототипа галереи, «просто расширить» нельзя; при желании покрыть тени/Плюс прод-экранами — отдельный шаг: добавить экраны в док галереи (мутация) до baseline.
- **Откаты:** W-C/W-D канонизация и W-G merge откатываются **только republish предыдущего source** (+ `restore {rev}` для доков). Тема-PATCH снапшотом пиксели канонизации НЕ вернёт (fallback=канон в коде) — использовать только против ошибочного значения токена, читаемого без канон-fallback (в этой волне таких нет). Прототип — `restore {rev}`.
- Доки: `docs/design/yandex-pay.md` (полная канон-таблица + диспозиция реестра, Плюс=ассет обязателен, роли banner/status-bar/tooltip/discount-badge/panel-screen, долги закрыты), `.claude/skills/yandex-pay/SKILL.md` (canon-токены, union-spacing, asset-url regex, banner-canon), проверка `/library/c/:id` для компонентов с изменёнными схемами; examples обновляются вместе с publish; `docs/prototype-format.md` не затрагивается (allowlist узлов не меняется). Итог в план, память.

## Коммиты

1. План + ревизия v2 (этот документ).
2. W-B server (`designSystemsMeta.ts` + тесты) — один коммит, едет образом.
3. `work/yp-wave3/` — workspace, не коммитим; прод-мутации через API + логический бэкап.
4. W-H доки — один коммит.

## Объём

W-A/W-B ≈ день; W-C — L (173 записи с полной диспозицией, батчи по носителям); W-D — M; W-E — M; W-F — S–M; W-G — M–L (merge с параметризацией геометрии). Итого **≈2 недели как нижняя граница** (оценка-floor с учётом полного покрытия реестра).

---

## Триаж адверсариального ревью (v1 → v2)

Ревьюер 1 — механика: **M1 принято** (ключи шкалы исправлены на реальные `none|xs|…|4xl`); **M2 принято** (imageLayout/CTA-параметризация, green/pink — алиасы); m1 принято (равенства помечены «≈», триаж допускает субпиксельные дельты); m2 принято (акцент B1 смещён на shadow/radial).
Ревьюер 2 — скоуп: **B1/B2 принято** — введено правило полного покрытия: canon-now / literal-preserve / skip со счётчиками, добавлены семьи positive/negative/accent-blue, тинты и product-цвета — literal-preserve; **B3 принято** — W-C разбит по компонентам-носителям, один владелец на файл (вкл. пересечения с W-D); M1 принято (скоуп W-F = инвентарь A3 + расширенный список); M2 принято (discount-badge, panel/screen — в W-G design.md); M3 принято (гейты G1/G2/G3); m1 принято (правила aggregate/var-переписывания); m2 принято (shadow.low-handle отдельно); m3 принято (per-case ограничен и перечисляется в A1); m4 принято (/library, examples, prototype-format — явно в W-H); m5 принято (оценка = floor).
Ревьюер 3 — миграции: **M1 принято** (restore не 422-ит — гейт заменён на PUT/ledger/read-only инвентарь); **M2 принято** (откат канонизации = republish source, тема-откат помечен как no-op); **M3 принято** (первичный гейт — программная computed-style дельта на все носители); **M4 принято** (инвариант побайтовой сохранности v5-ключей + проверка в G2); m1–m4 приняты (естественный 422-гейт, растягиваемость под-волн, numeric-union буквально + editor anyOf, GALLERY_SCREENS-иллюзия убрана).
Отклонённых находок нет.

**Контрольное ревью v2 (раунд 2):** блокирующих возражений нет; счётчики реестра сверены точно (8/152/21, agg 41, var 36, градиенты 21=defer-H8, теней в реестре 0). Внесено в v2.1: DOM-гейт v2 с расширенным набором свойств/геометрией/нормализацией литералов как done-критерий W-A; ownership C/D сведён к правилу «один файл = один субагент» (общие файлы уходят в W-C-батч); пер-вхожденческий done-критерий для agg/var; вложенные var-цепочки; счётчик 173+N теней; fill-muted-свод помечен осознанным.
