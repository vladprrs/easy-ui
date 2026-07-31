# Калибровка матчера дубликатов (T0)

Сгенерировано `scripts/calibrate-matcher.ts`. **Файл машинный — правки вносятся в скрипт.**

- Источник данных: **прод https://easy-ui.pay-offline.ru, снят 2026-07-31T09:53:46.488Z**
- Калибровочный корпус: `prod:yandex-pay` — 115 активных публикаций, 6555 пар
- Ядро: `server/catalog/matcher.ts` + `server/catalog/fingerprint.ts` (импорт, не копия)
- Сетка перебора: 11628 наборов весов (шаг 0.05, каждый вес ≥ 0.05, сумма 1.00)
- Сверено с `CALIBRATED_POLICY` в `server/catalog/policy.ts`: совпадает (иначе скрипт падает)

## Итоговая политика

```
policyVersion 1
props 0.05 · io 0.05 · source 0.75 · name 0.05 · description 0.05 · levelScope 0.05
blocking ≥ 0.7 · review 0.53..0.6999
```

**Набор существует.** Обязательные сценарии (S1 дословная копия, S2 копия со сменой описания, S3 переименованная копипаста) блокируются на всех 115 записях корпуса; ни одна легитимная пара каталога и ни один сценарий S5 порога не достигают. Порог 0.7 стоит выше потолка легитимных пар 0.6662 (запас 0.0338) и ниже худшего обязательного дубликата 0.7023 (запас 0.0023) — причём S1–S3 блокируются ещё и структурным отпечатком, независимо от порога.

Трудный вариант S3h (копипаста + правка props + дописанный код) на выбранном пороге ловится
в **87 случаях из 115** (76%); предел при нулевых ложных срабатываниях —
84%. Это потолок возможностей порога на сегодняшнем каталоге, а не следствие выбора весов:
лучший из 11628 наборов достигает именно его.

| набор весов | props | io | source | name | description | levelScope | потолок легитимных | худший S3h | recall@0FP |
|---|---|---|---|---|---|---|---|---|
| спека §3 | 0.25 | 0.15 | 0.20 | 0.15 | 0.15 | 0.10 | 0.6117 | 0.2616 | 10% |
| лучший при source ≤ 0.40 | 0.05 | 0.25 | 0.40 | 0.05 | 0.05 | 0.20 | 0.7251 | 0.5891 | 79% |
| **выбран T0** | 0.05 | 0.05 | 0.75 | 0.05 | 0.05 | 0.05 | 0.6662 | 0.5184 | 84% |

Сетка держит **минимум 0.05 на каждом сигнале**: сигнал с нулевым весом — мёртвый код,
он ломает и `reasons`, и перенормировку неприменимых сигналов. При запросе кандидатов
по одному `intent` (без исходника и без схемы) сигнал исходника неприменим, и
перенормировка оставляет имя и описание с равными весами — ранжирование поиска от
доминирования `source` не страдает.

Кривая «порог → цена»: сколько трудных дубликатов ловится и сколько пар каталога
при этом блокируется (то есть сколько легитимных созданий было бы отклонено).

| порог | S3h пойман | пар каталога ≥ порога |
|---|---|---|
| 0.7 | 87/115 | 1 |
| 0.72 | 67/115 | 1 |
| 0.74 | 53/115 | 1 |
| 0.76 | 35/115 | 1 |
| 0.78 | 23/115 | 1 |
| 0.8 | 11/115 | 0 |
| 0.82 | 3/115 | 0 |
| 0.84 | 1/115 | 0 |
| 0.86 | 0/115 | 0 |
| 0.88 | 0/115 | 0 |
| 0.9 | 0/115 | 0 |
| 0.92 | 0/115 | 0 |
| 0.94 | 0/115 | 0 |
| 0.96 | 0/115 | 0 |
| 0.98 | 0/115 | 0 |

## Замер 1 — распределение score по парам каталога

Под **итоговыми** весами. Пары, блокирующиеся без порога, включены.

| корпус | записей | пар | среднее | p50 | p90 | p99 | max |
|---|---|---|---|---|---|---|---|
| `prod:yandex-pay` | 115 | 6555 | 0.1475 | 0.139 | 0.2158 | 0.3459 | 0.7845 |
| `data/easy-ui.db:e2e-custom-ds` | 2 | 1 | 0.1997 | 0.1997 | 0.1997 | 0.1997 | 0.1997 |
| `data/easy-ui.db:yandex-pay` | 37 | 666 | 0.1679 | 0.156 | 0.2644 | 0.4241 | 0.7846 |
| `.e2e-data/dev/easy-ui.db:e2e-custom-ds` | 2 | 1 | 0.1997 | 0.1997 | 0.1997 | 0.1997 | 0.1997 |
| `.e2e-data/dev/easy-ui.db:e2e-preview-ds` | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | 19 | 171 | 0.2639 | 0.2181 | 0.4586 | 0.6663 | 0.9737 |
| `server/fixtures` | 12 | 66 | 0.2209 | 0.2058 | 0.3485 | 0.6245 | 0.6655 |

| корпус | ≥ blocking | ≥ review | блокируются без порога |
|---|---|---|---|
| `prod:yandex-pay` | 1 | 8 | 0 |
| `data/easy-ui.db:e2e-custom-ds` | 0 | 0 | 0 |
| `data/easy-ui.db:yandex-pay` | 1 | 3 | 0 |
| `.e2e-data/dev/easy-ui.db:e2e-custom-ds` | 0 | 0 | 0 |
| `.e2e-data/dev/easy-ui.db:e2e-preview-ds` | 0 | 0 | 0 |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | 2 | 14 | 8 |
| `server/fixtures` | 0 | 2 | 1 |

Топ-12 пар калибровочного корпуса:

| пара | score | props | io | source | name | description | levelScope | без порога |
|---|---|---|---|---|---|---|---|---|
| yp-app-home-loans ↔ yp-app-home-savers | 0.7845 | 0.9042 | — | 0.7909 | 0.6 | 0.5374 | 1 | нет |
| yp-app-home-more-important ↔ yp-app-home-vitrina | 0.6662 | 0.7143 | — | 0.683 | 0.5 | 0.1985 | 1 | нет |
| yp-base-card-mini ↔ yp-best-profit-base-card-mini | 0.6431 | 0.5833 | 1 | 0.612 | 0.6667 | 0.4307 | 1 | нет |
| yp-context-banner ↔ yp-notification | 0.6377 | 0.6667 | — | 0.6647 | 0.25 | 0.2283 | 1 | нет |
| yp-chart-informer-default ↔ yp-chart-informer-sheet | 0.5498 | 0.5 | — | 0.5361 | 0.6 | 0.3055 | 1 | нет |
| yp-app-home-more-important ↔ yp-app-home-savers | 0.5394 | 0.5714 | — | 0.5338 | 0.5 | 0.1696 | 1 | нет |
| yp-checkbox ↔ yp-pseudo-radio | 0.5371 | 0.2 | 1 | 0.5487 | 0.25 | 0.0615 | 1 | нет |
| yp-chart-informer-default ↔ yp-chart-informer-recurring | 0.5323 | 0.25 | — | 0.5324 | 0.6 | 0.2774 | 1 | нет |
| yp-app-home-loans ↔ yp-app-home-more-important | 0.5225 | 0.6038 | — | 0.5094 | 0.5 | 0.1822 | 1 | нет |
| yp-app-home-savers ↔ yp-app-home-vitrina | 0.5132 | 0.4444 | — | 0.5 | 0.6 | 0.2056 | 1 | нет |
| yp-chart-informer-sheet ↔ yp-notification | 0.5054 | 0.5 | — | 0.5151 | 0.2 | 0.1774 | 1 | нет |
| yp-chart-informer-recurring ↔ yp-chart-informer-sheet | 0.5006 | 0.3333 | — | 0.4907 | 0.6 | 0.2165 | 1 | нет |

## Замер 2 — синтетические сценарии §10

Каждый сценарий применён ко **всем** 115 записям калибровочного корпуса;
в таблице — худший (минимальный) случай, а не пример.

| # | сценарий | ожидание | пар | worst score | заблокировано | без порога |
|---|---|---|---|---|---|---|
| S1 | дословная копия (сменён только id/name) | block | 115 | 0.9815 | 115/115 | 113 |
| S2 | копия со сменой описания | block | 115 | 0.9259 | 115/115 | 113 |
| S3 | переименованная копипаста (идентификаторы + имя + описание) | block | 115 | 0.7023 | 115/115 | 113 |
| S3h | переименованная копипаста + правка props и +12% кода | block | 115 | 0.5184 | 87/115 | 0 |
| S4 | переписан с нуля с теми же props | block | 115 | 0.2017 | 113/115 | 113 |
| S5 | похожее имя при несовместимых props | allow | 115 | 0.1315 | 0/115 | 0 |
| S6 | одинаковая структура в другой дизайн-системе | no-candidate | 115 | — | 0 утечек | — |
| S7 | deprecated с активной заменой | demote | 1 | — | см. ниже | — |
| S8 | RU/EN описания одного и того же компонента | block | 115 | 0.9259 | 115/115 | 113 |

S7 (deprecated с активной заменой в корпусе): score 0.9825, blocking `false`,
recommendable `false` — демотирование работает и на прод-каталоге, где deprecated-записей нет.

S1, S2, S4 и S8 блокируются **структурным отпечатком**: копия сохраняет props/io/atomicLevel.
S3 блокируется и отпечатком, и по score (худший 0.7023 ≥ порога 0.7).
S4 показывает границу с другой стороны: переписанный с нуля исходник даёт score всего
0.2017, и ловит его только отпечаток — то есть отпечаток не избыточен, а несёт свой класс дубликатов.

## Замер 3 — разделяющий зазор

| величина | значение |
|---|---|
| худший обязательный дубликат S1–S3 (по score) | 0.7023 |
| лучшая легитимная пара каталога | 0.6662 (yp-app-home-more-important ↔ yp-app-home-vitrina) |
| **разделяющий зазор** | **0.0361** |
| выбранный порог | 0.7 |
| худший трудный дубликат S3h | 0.5184 |
| зазор для S3h | -0.1478 (перекрытие) |

Зазор для обязательного набора **положителен**, для трудного варианта — отрицателен:
распределения S3h и легитимных пар перекрываются, и ни один из 11628 наборов весов
их не разводит. Порог выбран в положительном зазоре; цена — 28 из 115 S3h проходят.

Потолок легитимных пар держит пара `yp-app-home-more-important ↔ yp-app-home-vitrina` — соседи одного
семейства `yp-app-home-*`. Если триаж проекта 3 признает их дубликатом, потолок падает до
0.6377 и порог можно опустить с ростом recall — это единственный дешёвый способ
улучшить матчер без смены алгоритма.

## Замер 4 — чувствительность порога

| порог | пар каталога ≥ порога | S1–S3 ниже порога | S3h ниже порога |
|---|---|---|---|
| 0.67 | 1 | 0/345 | 21/115 |
| 0.68 | 1 | 0/345 | 26/115 |
| 0.69 | 1 | 0/345 | 28/115 |
| 0.7 (выбран) | 1 | 0/345 | 28/115 |
| 0.71 | 1 | 1/345 | 37/115 |
| 0.72 | 1 | 3/345 | 48/115 |
| 0.73 | 1 | 4/345 | 54/115 |

Пар в полосе ±0.03 вокруг порога: **0**.

## Замер 5 — коллизии структурного отпечатка

| корпус | записей | различных отпечатков | групп-коллизий | записей в коллизиях |
|---|---|---|---|---|
| `prod:yandex-pay` | 115 | 113 (+2 без схемы) | 0 | 0 |
| `data/easy-ui.db:e2e-custom-ds` | 2 | 2 | 0 | 0 |
| `data/easy-ui.db:yandex-pay` | 37 | 37 | 0 | 0 |
| `.e2e-data/dev/easy-ui.db:e2e-custom-ds` | 2 | 2 | 0 | 0 |
| `.e2e-data/dev/easy-ui.db:e2e-preview-ds` | 1 | 1 | 0 | 0 |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | 19 | 14 | 3 | 8 |
| `server/fixtures` | 12 | 9 (+2 без схемы) | 1 | 2 |

Состав коллизий:

- `.e2e-data/dev/easy-ui.db:e2e-starter`: api-rating-stars ↔ ui-rating-stars — props `["value"]`
- `.e2e-data/dev/easy-ui.db:e2e-starter`: e2e-legacy-slots ↔ e2e-named-slots-panel — props `["title"]`
- `.e2e-data/dev/easy-ui.db:e2e-starter`: e2e-preview-accent ↔ e2e-preview-broken ↔ e2e-preview-fixed ↔ e2e-preview-organism — props `["label"]`
- `server/fixtures`: legacy-slots ↔ named-slots-panel — props `["title"]`

## Замер 6 — сиды серверных тестов и e2e

Вход для задачи T6b: пары фикстур, которые под итоговой политикой получат score ≥ review.
Фикстуры, не проходящие извлечение (до матчера не доходят): `bare-import.tsx`, `css-import.tsx`, `no-definition.tsx`, `nonserializable-event.tsx`, `props-not-zod.tsx`, `syntax-error.tsx`, `timeout.tsx`.

| корпус | пара | score | blocking |
|---|---|---|---|
| `data/easy-ui.db:yandex-pay` | yp-app-home-loans ↔ yp-app-home-savers | 0.7846 | **да** |
| `data/easy-ui.db:yandex-pay` | yp-app-home-more-important ↔ yp-app-home-vitrina | 0.666 | нет |
| `data/easy-ui.db:yandex-pay` | yp-app-home-more-important ↔ yp-app-home-savers | 0.5393 | нет |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | api-rating-stars ↔ ui-rating-stars | 0.9737 | **да** |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | api-rating-stars ↔ e2e-typed-events-stars | 0.6613 | нет |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-legacy-slots ↔ e2e-named-slots-panel | 0.6323 | **да** |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-preview-accent ↔ e2e-preview-organism | 0.7281 | **да** |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-preview-accent ↔ e2e-preview-fixed | 0.6264 | **да** |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-preview-accent ↔ e2e-preview-broken | 0.5664 | **да** |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-preview-accent ↔ e2e-preview-atom | 0.5869 | нет |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-preview-atom ↔ e2e-preview-broken | 0.6663 | нет |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-preview-atom ↔ e2e-preview-organism | 0.6155 | нет |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-preview-atom ↔ e2e-preview-fixed | 0.5643 | нет |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-preview-broken ↔ e2e-preview-organism | 0.5904 | **да** |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-preview-broken ↔ e2e-preview-fixed | 0.5518 | **да** |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-preview-fixed ↔ e2e-preview-organism | 0.6527 | **да** |
| `.e2e-data/dev/easy-ui.db:e2e-starter` | e2e-typed-events-stars ↔ ui-rating-stars | 0.6613 | нет |
| `server/fixtures` | legacy-slots ↔ named-slots-panel | 0.6245 | **да** |
| `server/fixtures` | rating-stars ↔ typed-events-stars | 0.6655 | нет |

## Замер 7 — известные дубликаты аудита 2026-07-20

Пары взяты из `docs/audit/2026-07-20-yp-catalog-audit.md` и `-findings.md` (все пометки
«near-duplicate» и «дублирует»). Колонка «review» — попал ли кандидат в выдачу гейта, даже
если не заблокирован: для семантических дублей это и есть реалистичный максимум.

| пара | статус в каталоге | score | blocking | review |
|---|---|---|---|---|
| yp-promo-banner ↔ yp-banner-mid | одна сторона без активной публикации | 0.4967 | нет | нет |
| yp-app-home-savers ↔ yp-app-home-loans | обе активны | 0.7845 | **да** | да |
| yp-base-card-mini ↔ yp-best-profit-base-card-mini | обе активны | 0.6431 | нет | да |
| yp-collapsible ↔ yp-animated-collapse | обе активны | 0.2689 | нет | нет |
| yp-loyalty-badge ↔ yp-badge | обе активны | 0.152 | нет | нет |
| yp-promo-tooltip ↔ yp-tooltip | обе активны | 0.1138 | нет | нет |
| yp-split-discount-info ↔ yp-discount-info-with-cashback | обе активны | 0.3214 | нет | нет |
| yp-panel ↔ yp-screen | обе активны | 0.2712 | нет | нет |
| yp-radio-button ↔ yp-pseudo-radio | обе активны | 0.301 | нет | нет |

Поймано блокировкой: **1 из 9**; показано агенту (blocking или review): **2 из 9**.

Это **не** дефект калибровки, а граница класса: аудит помечал «near-duplicate» по смыслу
(одна и та же продуктовая роль, разный код и разные props), а матчер без `canonicalFor`
видит только текстовое и структурное родство. Пара `yp-promo-banner ↔ yp-banner-mid`
не ловится ещё и потому, что вторая сторона снята с публикации: у неё нет
`definition_meta`, и применимы только сигналы исходника и имени (§3.1 плана).
Ролевые дубликаты закрывает бэкфилл `canonicalFor` в проекте 3, а не подгонка весов.

## Приложение — как воспроизвести

Прод-дамп в репозиторий не кладётся (это прод-данные). Снимается **только чтением**,
один логин на процесс (прод рейт-лимитит логины), паузы между пачками:

```js
// scratchpad/dump-prod.mjs — EASYUI_USERNAME/EASYUI_PASSWORD из .env
import { createEasyUiClient } from "scripts/easyui-auth.mjs";
const client = createEasyUiClient({ apiBase: "https://easy-ui.pay-offline.ru/api" });
// GET /design-systems → для каждой: GET /catalog/manifest?designSystem=…
// → на каждый компонент: GET /components/:id/versions/:version (там source + definition_meta)
// → для компонентов без активной публикации: GET /components/:id/source
```

```sh
~/.bun/bin/bun scripts/calibrate-matcher.ts --dump <dump.json> \
  --db data/easy-ui.db --db .e2e-data/dev/easy-ui.db --fixtures \
  --out docs/audit/2026-07-31-matcher-calibration.md
```

Скрипт падает, если его собственная взвешенная сумма разойдётся со score настоящего
матчера хотя бы на одной паре: цифры отчёта относятся к тому коду, который поедет в прод.

