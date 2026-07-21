# Волна 3 каталога yandex-pay — закрытие бэклога B (H2/H8/H4/H7/H5, зонтик H10)

## Context

Бэклог `docs/product-hypotheses-2026-07-20.md` закрыт частично: фикс-волна A (2026-07-20) и волна 2 (2026-07-21: theme v5 с 8 пилотными `color.*`, ABI v4 `color(key, fallback)`, H6 currency-enum, H9 seed, H3-B шкала 400/500/700) выполнены и на проде, 0 регрессий. Остались H2 (кросс-семейный канон семантических цветов — 152 defer-записи реестра), H8 (тени/градиенты/знак Плюса — 21 запись), H4 (numeric spacing → `space()`), H7 (asset-url контракт), H5 (near-duplicates), H10 (runtime-адопция — зонтик, закрывается попутно).

**Решения пользователя (зафиксированы):** всё оставшееся — одной большой волной с под-волнами; канон `text.primary` = **`rgba(0,0,0,.86)`**. Каноны остальных семей — предложены ниже (§W-A таблица), утверждаются на ревью плана.

**Ключевое отличие от волны 2:** волна 2 была no-op (fallback == литерал, diff обязан = 0). Волна 3 меняет пиксели **осознанно** (канонизация): fallback и тем-токен = канон ≠ прежний литерал → per-example diff ≠ 0 с ручным триажем (§Триаж).

Инструментарий переиспользуется: `work/yp-wave2/gen-registry.mjs` (реестр), `h6-inventory.mjs` (шаблон инвентаря доков), `h1-dom-gate.mjs` (DOM-гейт шиммеров), `work/yp-fixes/scripts/{capture,diff,publish,prod-baseline,prod-diff}.mjs`, регламент прод-выкатки §W3 из `docs/plans/2026-07-20-yp-catalog-fixes.md`.

## Процесс (по CLAUDE.md)

1. Сохранить этот план в `docs/plans/2026-07-21-yp-wave3-backlog-close.md`, закоммитить.
2. Адверсариальное ревью плана Opus-субагентами (линзы: correctness/scope/риски миграций), триаж находок в плане, итерации до снятия блокеров.
3. Исполнение: Fable 5 оркестрирует, Opus-субагенты исполняют по зонам ownership ниже; оркестратор независимо верифицирует done-критерии и коммитит.

## Архитектура волны

```
W-A каноны + реестр v6 + инвентари (2 субагента ∥)
W-B тема v6 + валидация shadow/gradient (server) → образ → PATCH прода
   ├→ W-C H2 цвет-каноны (3 субагента ∥ по семьям)   — требует v6
   ├→ W-D H8 тени/градиенты/Плюс-ассет               — требует v6
   ├→ W-E H4 spacing (yp-text, yp-skeleton)          — независим от v6
   ├→ W-F H7 asset-url regex                          — независим от v6
   └→ W-G H5 banner-merge + shared-helpers            — независим от v6
W-H верификация + прод-выкатки §W3 (по под-волнам) + доки/память
```

После W-B под-волны C–G взаимно независимы, каждая катится своим §W3-циклом. Рекомендуемый порядок выкаток (риск по нарастающей): W-B → W-E (diff=0) → W-F (diff=0) → W-G (helpers diff=0, затем merge) → W-C (diff≠0 триаж) → W-D (крупнейший diff, Плюс).

## W-A — Каноны, реестр v6, инвентари (workspace `work/yp-wave3/`, READ-ONLY скрипты)

- **A1 канон-таблица** (утвердить на ревью; принцип — rgba-alpha-форма, консистентная с каноном text.primary; «per-case» = opaque на цветном фоне мигрируется с визуальным триажем, не автоматом):

| Семья | Канон | Обоснование |
|---|---|---|
| text.primary | `rgba(0,0,0,.86)` | зафиксирован пользователем; folds #000000d8, #1f2023, #111 |
| text.secondary | `rgba(0,0,0,.5)` | топ-частота, #00000080 идентичен; folds #6b6d74 и близкие |
| text.tertiary | `rgba(0,0,0,.3)` | = #0000004d; folds #777a85/#93979e per-case |
| text.quaternary | `rgba(0,0,0,.2)` | = #0003; folds #d6d7da per-case |
| text.inverted | `#fff` | топ-12; rgba(255,255,255,.98) остаётся surface-overlay |
| separator | `rgba(0,0,0,.08)` | = #00000014 |
| border-hairline | `#e1e3e8` | opaque-бордеры карточек; folds #dedfe3 и близкие per-case |
| fill-muted | `#f5f7f9` | эталон yp-skeleton; сводит три ship-now v5 fill-muted-* в один |
| split | `#5c33d6` | бренд Bank Split |
| plus | `#6b47ff` | стоп градиента Плюса; folds #8f42ff/#7b42f6 per-case |
| shadow.medium | `0 8px 24px rgba(0,0,0,.12)` | design.md §1.1; свод .10↔.12; футер — отдельный shadow.medium-up (`0 -8px …`) |
| shadow.low / high | `0 2px 8px rgba(0,0,0,.08)` / `0 16px 40px rgba(0,0,0,.16)` | design.md §1.1 |
| gradient.plus | `linear-gradient(135deg,#ff2e93 0%,#8b3dff 52%,#3277ff 100%)` | design.md §1.1; свод 90deg/2-стоп |

- **A2 реестр v6** (`work/yp-wave3/token-registry-v6.json`, перегенерация `gen-registry.mjs`): defer-H2 → canon-now с полями literal/canon-key/canon-value/prev-value/family/status; H8-градиенты → `gradient.*`; тени добавить вручную из design.md §1.1 (в colors-агрегате их нет).
- **A3 инвентари H4/H7** (`h4-inventory.mjs`, `h7-inventory.mjs` по шаблону `h6-inventory.mjs`): обход всех доков×ревизий×версий, вкл. архивные. H4 — numeric-значения spacing-пропов узлов yp-text/yp-skeleton; H7 — все url-пропы (классификация: asset-ref / внешний / data-URI).
- **A4 носители** (`carriers.mjs`, grep по `work/yp-fixes/components/*/source.tsx`): литерал → компоненты-носители (в реестре этой привязки нет), батчи по семьям.

Done: канон-таблица утверждена; реестр v6 с маппингом; JSON-инвентари H4/H7; списки носителей.

## W-B — Тема v6 + валидация shadow/gradient

Владение: `server/designSystemsMeta.ts`, `server/design-systems-theme.test.ts`.

- **B1 валидация — namespace-branch в `colorTokenIssues` (без нового ABI):**
  - `color.shadow-*` → SHADOW_RE (`[inset] Xpx Ypx [blur] [spread] color`, отрицательные смещения, comma-list);
  - `color.gradient-*` → GRADIENT_RE (добавить `radial-gradient` к текущему allowlist);
  - прочие `color.*` → текущий `isColorValue`.
  Тени/градиенты остаются под `color.*` → читаются существующим `color()` из ABI v4 (`--eui-color-shadow-medium` и т.п.), zero ABI churn. Альтернатива (ABI v5 c `shadow()`/`gradient()`) отклонена — полная шим-обвязка ради 5 токенов. Базовый `tokenValueSchema` (бан `;{}<>`, ≤256 симв.) остаётся первым барьером — проверить длину каждого канон-градиента ≤256.
  Тест-кейсы: регресс `#fff`/`rgba(255,255,255,.98)` + `0 8px 24px rgba(0,0,0,.12)`, `0 -8px 24px …`, `radial-gradient(…)`, канон gradient.plus.
- **B2 сбор темы** (`w-b-theme.mjs`): GET текущей темы → append канон-токенов H2+H8 к существующим `space.*` + 8 `color.*` v5; `fonts`/`icons` в PATCH опустить (наследуются).
- **B3 PATCH:** стенд (проверка эмиссии `--eui-color-*` в `:root`, `c2-emission-check.mjs`) → прод: снапшот v5 в `work/yp-wave3/rollback-theme.json` → PATCH `baseVersion:5 → v6`.
- **Гейт деплоя:** server-изменения едут образом (GitHub Actions → GHCR → Dokploy, серверная сборка запрещена) **до** прод-PATCH — иначе 422 на shadow/radial-значениях.

Done: verify+e2e зелёные; расширенная валидация пропускает канон-значения и режет мусор; прод-тема v6; rollback-снапшот. Шаг чисто аддитивный, diff прода = 0.

## W-C — H2: канонизация цвета (3 субагента ∥ по семьям)

Механика пер-литеральная: в носителе литерал → `color("<canon-key>", "<canon-value>")` — fallback = канон (не прежний литерал) → пиксель меняется на канон и с темой, и без. Прочие литералы компонента не трогаются.

- C-1: text.primary/secondary/tertiary/quaternary/inverted (checkbox/switch, typography, badges, feedback-motion, chips).
- C-2: separator / border-hairline / fill-muted (карточки, скелетоны).
- C-3: split / plus плоские цвета (cashback/loyalty-badge, plus-*, split-*); градиент/глиф Плюса — только в W-D (для plus-компонентов строгий порядок C→D либо один владелец).

Done (на семью): publish `hostAbiVersion===4`; per-example capture+diff против baseline; DOM-гейт для шиммеров (сравнение equal-to-canon, не byte-identical); каждый diff≠0 затриажен (§Триаж). Приоритет — самые заметные (primary-текст на светлом), «per-case»-литералы — с ручной визуальной приёмкой.

## W-D — H8: тени, градиенты, знак Плюса (1 субагент)

- D1: Плюс-ассет — канон `asset_2a907dc8…` (design.md §4.3); проверить наличие на проде, при отсутствии залить `POST /api/assets` **до** publish.
- D2: `--shadow-*` fallback-и носителей → `color("shadow-medium", "<канон>")`; футер yp-screen → `shadow-medium-up`.
- D3: градиенты Плюса (90°/135°/2-стоп) → `color("gradient-plus", "<канон 135deg>")`; шиммер yp-skeleton → `gradient-shimmer`.
- D4: глифы «Я» (yp-cashback-badge, yp-loyalty-badge) и «✦» (yp-plus-return) → `<img>` c Плюс-ассетом (эталон yp-plus-badge). Diff ожидаемо крупный — обязательная визуальная приёмка глазами, критерий «паритет с реальным Yandex Pay».

## W-E — H4: numeric spacing → space() (1 субагент; yp-spacer НЕ трогать)

- Проп-тип: union текущих numeric-литералов + `z.enum(<реальные ключи space-шкалы темы: none/xs4/…/4xl64>)`. Render: строка → `space(key)` (ABI v4, throw на unknown key — в enum только реальные ключи), число → px legacy.
- `yp-text` и `yp-skeleton` бампаются ABI v1 → v4 (импорт `space`, попутно `color()` для их канон-литералов — H10-зонтик). У yp-skeleton не сломать `margin:auto`-центровку.
- Миграция доков `h4-migrate.mjs`: **только exact-match** число → токен (9 значений шкалы, no-op, diff=0); off-token значения (1,2,3,6,10,14,20,28,…) остаются числами; near-match — не автоконверт, только под флагом `--near` с ручным триажем.

Done: publish; diff=0 для существующих доков; инвентарь подтверждает, что off-token остались числами; мигрированные доки re-pin.

## W-F — H7: asset-url контракт (1 субагент)

- Regex `/^\/api\/assets\/asset_[a-f0-9]{64}$/` (эталон yp-app-home-chrome) для url-пропов `yp-app-home-vitrina`, `yp-promo-banner`, `yp-banner-mid` (до/вместе с W-G), `yp-cpqr-*`, `yp-custom-*`.
- Порядок: инвентарь (A3) → предзаливка внешних/inline изображений в `POST /api/assets` (дедуп sha256, маппинг old→ref) → publish новых версий → миграция доков + re-pin. Архивные доки обязаны проходить restore-ре-валидацию (422 = промах инвентаря).

## W-G — H5: banner-merge + shared-helpers (1 субагент)

- **Канон = `yp-promo-banner`** (имеет theme light/dark и непрерывный width 280–440 — надмножество; tone banner-mid мержится в enum-superset variant `{cashback,discount,split,purple,green,pink}`; `width: number | enum "327"|"336"|"343"`; добавить `height?`).
- `yp-banner-mid` → deprecated (CAS по statusRev; старые пины рендерятся). Доки на banner-mid мигрируются на канон (маппинг tone→variant ручной, визуальный триаж) + re-pin.
- Shared-helpers (non-breaking, публичные пропы не меняются, diff обязан = 0): section-обёртка/BadgeHeading/rail для savers/loans; статус-бар/часы (yp-cpqr-sheet-frame / yp-cpqr-status-bar / yp-app-home-chrome); tooltip-поверхность. design.md фиксирует роли.

## Триаж diff≠0 (W-C/W-D)

Baseline до под-волны; каждая пара capture→diff ранжируется по diffPercent. Три корзины:
1. **Ожидаемая канонизация** — принять: изменение локализовано в области канонизируемого литерала, дельта = prev-value→canon-value из реестра v6, layout не сместился.
2. **Регрессия** — блок/откат: сдвиг layout, задет непокрытый литерал, `dimsMatch:false`, пропавший элемент.
3. **Недетерминизм** — исключён (аватар seeded с волны 2; шиммеры — через DOM-гейт).
Каждый ненулевой diff — запись в `work/yp-wave3/triage-<subwave>.md`. DOM-гейт для шиммеров: computed-стили equal-to-canon.

## W-H — Верификация, выкатка, доки

- Локально (гейт каждой под-волны): `npm run verify`, `npm run e2e`, runtime-прогон `/verify`; publish `hostAbiVersion===4`.
- Прод: §W3-цикл на каждую под-волну — admin-сессия+Origin → бэкап+инвентарь → предзаливка ассетов → per-example + прод-baseline (расширить `GALLERY_SCREENS` в prod-baseline.mjs экранами с целевыми компонентами — дефолтные 12 их не покрывают, урок волны 2) → канарейка (W-C: yp-skeleton-семья; W-D: yp-plus-return; W-E: yp-skeleton; W-F: yp-app-home-vitrina; W-G: yp-promo-banner) → батч publish по одному, барьер 100% active → re-pin checkpoint-save → триаж диффов → финальный бэкап `.backups/prod-wave3-<date>/`. Откат: компонент — deprecated+republish, прототип — `restore {rev}`, тема — PATCH снапшотом.
- Доки: `docs/design/yandex-pay.md` (каноны, реестр v6, Плюс=ассет обязателен, роли banner/status-bar/tooltip, долги закрыты), `.claude/skills/yandex-pay/SKILL.md` (canon-токены, union-spacing, asset-url regex, banner-canon), итог в план, память.

## Коммиты

1. План в `docs/plans/2026-07-21-yp-wave3-backlog-close.md` (+ правки после адверсариального ревью).
2. W-B server (`designSystemsMeta.ts` + тесты) — один коммит, едет образом.
3. `work/yp-wave3/` — workspace, не коммитим (как в волне 2); прод-мутации через API + логический бэкап.
4. W-H доки (design.md + SKILL.md + итог плана) — один коммит.

## Объём

W-A/W-B ≈ день; W-C — M–L (152 записи семьями); W-D — M; W-E — M; W-F — S–M; W-G — M–L. Итого ≈ 1.5–2 недели с ревью, канарейками и поэтапными выкатками.
