# План реализации фикс-волны каталога yandex-pay — 2026-07-20

Реализация решений триажа аудита ([отчёт](../audit/2026-07-20-yp-catalog-audit.md), [реестр 234 находок](../audit/2026-07-20-yp-catalog-findings.md)). Скоуп: фикс-волна A (non-breaking) + A' (examples/гигиена), фиксы прототипов, архивации/deprecate на проде, батч-обновление прода с re-pin, документы (гипотезы, design.md, скилл `yandex-pay`). Бэклог B (breaking/токенизация) — **не в скоупе**, уходит в документ гипотез.

## Исходные данные

- Исходники компонентов: ZIP-бандлы `.backups/prod-components-20260720-130019/` (100 шт., внутри `components/<id>/source.tsx` + `manifest.json`); прототипы: `.backups/prod-prototypes-20260720-130408/` (33 шт.).
- Машиночитаемые находки: `docs/audit/audit-merged.json`; агрегаты дизайна: `design-facts-agg.json`; экспозиция: `exposure.json`.
- Персистентного воркспейса аудита с TSX нет — извлекаем заново.
- Механизмы API (docs/server-api.md): обновление = `PUT /components/:id {source, baseRev}` → `POST /components/:id/publish`; статус версии = `POST /components/:id/versions/:v/status` (deprecated); статус прототипа = `POST /prototypes/:id/status` (archived); **re-pin = checkpoint save** `PUT /prototypes/:id {doc, baseRev}` (пересчитывает пины на последние active); импорт бандлов `POST /bundles/import?mode=apply` (bump-версия при изменённом source). Скриншоты: `POST /components/:id/versions/:v/screenshot`, `POST /prototypes/:id/screens/:screenId/screenshot` → job. Диффы: pixelmatch-воркер `scripts/visual-diff-worker.mjs` / visual-references API.
- Публикация скриптами: харнес `.claude/skills/author/driver.mjs` (session-логин, `component <id> <Name> <file> --design-system yandex-pay` = save+publish).

## Скоуп правок

| Блок | Объём | Содержание |
|---|---|---|
| F1. Defensive-props (класс A) | ~45 компонентов | Все blocker/major A1/A2/A3 + сопутствующие minor defensive в тех же файлах: паттерн `?? <default из схемы>` / `lookup[key ?? "default"]`, эталон — `yp-box`. Схемы не трогаем. |
| F2. Ассеты (B) | 3 | `yp-random-avatar` (22 webp), `yp-maps-review-banner` (1), `yp-ctyp-payment-page` (2): залить байты через `POST /api/assets`, заменить data-URI на `/api/assets/asset_<sha>`. |
| F3. Слоты | 4 | Рендерить объявленные слоты: `yp-navigation` (left/center/right), `yp-platform-modal` (content), `yp-animated-collapse` (content), `yp-tooltip` (trigger/title/subtitle/link) — как дополнение к children, non-breaking. |
| F4. Definition-гигиена (D) | ~16 | Стейл-описания (8: `yp-text` YS-Text-примечание и др.), `atomicLevel` (8: добавить `yp-amount` atom и др. по findings). |
| F5. Согласование литералов (C-точечно) | ~15 | fallback `--shadow-medium` (единая alpha .12, футер сохраняет -8px), градиент Плюса 135deg (стопы 0/52/100), font-стек `'YS Text','Helvetica Neue',Arial,sans-serif`, fallback-цвета внутри семейств по Fix-полям findings. |
| F6. fontWeight вне шкалы | 13 | 600/800/900 → 700 (шкала темы YS Text 400/500/700); список в отчёте аудита, раздел «Дополнительные свипы». |
| F7. Examples (A') | топ-используемые | `examples`-мапы для топ-компонентов по факту использования (`yp-box`, `yp-icon`, `yp-text`, `yp-payment-method-card`, `yp-button`, `yp-badge`, …) + по остаточному принципу в файлах, которые и так правим. |
| P1. Прототипы | 3–4 | `pay-app-home-v1` (canvasHeight populated-экрана под контент), `yp-design-system-gallery` (экран icon-bank: задать `exactAssetUrl`), `cpqr-scenario` (синхронизировать дубль-поддеревья qr-curtain-ready/return; извлечение компонента — в бэклог), `yp-atoms-snippet-plus-states` (честные notes про визуально идентичные состояния). |
| C1. Прод-контент | 13+1 | Архивировать 13 прототипов (список в отчёте, раздел «Мёртвый/служебный контент»); `ui-rating-stars` — deprecated (не фиксим: решение deprecate, публикация всё равно падает на retired DS). |
| D1. Документы | 3 | `docs/product-hypotheses-2026-07-20.md` (бэклог B: theme v5 + ABI v4 `color()`, миграция numeric spacing, консолидация дублей, enum currency, asset-URL контракт); `docs/design/yandex-pay.md` (design.md: токен-канон, роли примитивов, из `design-facts-agg.json`); скилл `.claude/skills/yandex-pay/SKILL.md` (авторинг под ДС: канон-значения, выбор примитивов, оборонительный паттерн). |

Не фиксим (решения триажа): хардкод-цвета как класс, `yp-spacer` numeric scale, near-duplicate savers/loans, всё `[breaking]`.

## Конвенции фиксов (обязательны для всех fix-агентов)

1. Только non-breaking: props-схемы не сужать и не расширять; поведение при **явно заданных** пропах не менять.
2. Дефолт в `??` всегда равен дефолту схемы (не «разумному значению»).
3. Мёртвые пропы не удалять; `yp-animated-amount.from/forceInitialAnimation` — реализовать анимацию from→to (fix из findings), `yp-skeleton.m` — применить margin поверх авто-центра.
4. Канон литералов при согласовании — по Fix-полям findings; спорные случаи решает оркестратор, фиксируется в design.md.
5. Формат исходника не переформатировать целиком (диффы должны остаться читаемыми против бэкапа); минифицированные файлы можно расставить переносами только в правленых местах.

## Этапы

### W0 — Стенд и baseline (оркестратор)

1. Извлечь TSX всех правимых компонентов в `work/yp-fixes/components/<id>/source.tsx` (dir в `.gitignore`), доки прототипов — в `work/yp-fixes/prototypes/`.
2. Поднять чистый локальный сервер (`DATA_DIR=.e2e-data/fixes`, порт 8792, bootstrap-admin), импортировать все 134 бандла `mode=apply` — это baseline (повторяет аудит: 99 published + ui-rating-stars failed).
3. Снять baseline-скриншоты: все правимые компоненты (per-example) + экраны правимых прототипов; сложить в `work/yp-fixes/baseline/`.

### W1 — Фикс-волна компонентов (Workflow, Opus-агенты по семействам)

- ~8 агентов по семействам из findings (layout-primitives, typography-amounts, badges-plus-loyalty, snippets-informers, form-controls, buttons, banners-promo, cpqr/app-home/сценарные — разбивка по фактическим секциям реестра). Владение: агент правит только `work/yp-fixes/components/<id>/source.tsx` своего семейства.
- Вход агенту: его секция findings (+ blocker/major-таблицы отчёта), конвенции выше, кросс-семейный канон (F5), эталон `yp-box`, «читай `.d.ts` в node_modules, не угадывай API», «не коммить».
- Выход: правленые source.tsx + краткий отчёт (какие находки закрыты/пропущены и почему).
- F2 (ассеты) — отдельный агент: заливает байты на локальный стенд, готовит source c asset-URL; при прод-выкатке байты заливаются на прод повторно (дедуп по sha256 — идемпотентно).

### W2 — Верификация на стенде (оркестратор + gate-агент)

1. Каждый фикс: `PUT /components/:id` + `publish` на стенде — полный пайплайн (tsc/линты/SSR-smoke) обязан пройти без новых warning.
2. Повторные скриншоты → pixelmatch-дифф против baseline. Ожидание: примеры с явными пропами — 0 дифф; диффы допустимы только там, где пример опускает проп с дефолтом (фикс как раз чинит рендер) — каждый такой дифф оркестратор триажит явно (ожидаемое улучшение vs регрессия).
3. Прототипы: применить P1-правки, `PUT /prototypes/:id`, скриншоты экранов, точечная проверка `driver.mjs status/geometry` (CTA `pay-app-home-v1` виден, icon-bank не пустой).
4. Смоук `exposure.json`-кейсов: `pay-app-home-v1` без `payButtonTop`, `ctyp-paybox-scenario` без `surface` — рендер корректен.

### W3 — Прод-выкатка (оркестратор, последовательно)

1. Свежий логический бэкап прода (компоненты+прототипы, `GET /bundles/export`).
2. Канарейка: `yp-text` (2 блокера, 23 использования) — PUT+publish на прод, re-pin одного прототипа checkpoint-save'ом, скриншот/статус экрана.
3. Батч: остальные компоненты (PUT+publish по одному, контроль ответа publish), затем re-pin всех живых прототипов checkpoint-save; P1-правки доков прототипов — тем же PUT (объединить с re-pin).
4. C1: архивация 13 прототипов, deprecate `ui-rating-stars` (все версии active→deprecated).
5. Прод-верификация: `driver.mjs status` по ключевым экранам, `/library` открывается, render-status без новых ошибок; финальный свежий бэкап `.backups/prod-*-<date>/`.
- Откат: компоненты — публикация предыдущего source из бэкапа новой версией (+ re-pin); прототипы — restore дока из бэкапа тем же PUT.

### W4 — Документы (Opus-агенты, параллельно с W3 после W2)

- D1: три документа (владение — по файлу на агента); входы: отчёт+findings, `design-facts-agg.json`, решения по канону из W1/F5. design.md фиксирует: токен-фоллбэк-канон, роли примитивов (yp-box/panel/screen/scroll-area), представление знака Плюса, discount-badge паттерн, 20px gutter, шкалу fontWeight.
- Скилл `yandex-pay`: как авторить компоненты/прототипы под эту ДС (канон, оборонительный паттерн, ссылки на design.md).

### W5 — Финализация (оркестратор)

- `npm run verify` (repo-гейт для docs/skill-правок), коммиты поэтапно: план → фиксы-workspace не коммитим (бэкап финальный вместо этого) → документы/скилл → обновление memory.

## Риски

- **Скриншот-диффы из-за самих фиксов**: примеры в definition могут опускать пропы с дефолтами — диффы ожидаемы и триажатся вручную, порог не «0 молча».
- **Re-pin подтянет не только наши версии**: checkpoint-save пересчитывает пины на последние active всех компонентов дока — на проде других авторов нет, риск принят.
- **`yp-random-avatar` Math.random**: скриншот-дифф недетерминирован — сравнивать с фиксированным seed нельзя; для этого компонента гейт = publish + ручной осмотр.
- **Объём W1**: 45 компонентов; агент, не закрывший находку, обязан отчитаться «пропущено + причина» — оркестратор сверяет по `audit-merged.json` (каждый blocker/major id → закрыт/отложен).
- Прод живой: выкатка версионная (bump), старые пины продолжают рендериться при deprecated/superseded — риска даунтайма нет.
