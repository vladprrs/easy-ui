# Library inline-preview performance gate

Generated: 2026-07-31T08:08:41.045Z

Command: `npm run perf:library -- --url http://127.0.0.1:4173/ --data-dir .e2e-data/perf-library --runs 5`

Dataset: 120 компонентов (3 дизайн-системы, 8 прототипов для usage, 40 визуальных эталонов), префикс `perf-library-`, сидинг напрямую в БД, cleanup в `finally`. Бандлы: chip 739 B (ABI 1), badge 935 B (ABI 4), card 1155 B (ABI 1), list 1501 B (ABI 1), panel 1728 B (ABI 1), screen 2794 B (ABI 4).

Viewport: 1440×900. Network: 40 ms RTT, 5 Mbit/s down, 1 Mbit/s up. Каждый прогон — холодный контекст с `Network.setCacheDisabled`. Медианы по 5 прогонам на арм.

Армы: baseline — `?libraryPreviews=off` (только метаданные), full — превью включены.

## Блокирующие гейты

| Метрика | Значение | Гейт | Результат |
|---|---:|---:|---|
| Точных `GET /api/components/:id` при первичной навигации | 0 | = 0 | PASS |
| iframe превью | 0 | = 0 | PASS |
| Пиковая одновременность задач планировщика | 4 | ≤ 4 | PASS |
| Запросов до первого превью (медиана) | 21 | ≤ 30 | PASS |
| Трафик до первого превью (медиана) | 1.60 MiB | ≤ 3.00 MiB | PASS |
| Смонтированных превью после успокоения (пик) | 6 | ≤ 12 | PASS |
| Прирост JS heap после полного скролла (медиана) | 2.50 MiB | ≤ 80.00 MiB | PASS |
| Деградация searchable-ready (full vs baseline) | 0.33% | < 20% | PASS |

Итог: **PASS**.

## Справочно (потолки спеки §8 — не блокируют)

| Метрика | Baseline, ms | Full, ms | Деградация | Потолок спеки |
|---|---:|---:|---:|---:|
| Searchable ready (`[data-library-ready="true"]`) | 2796.6 | 2805.9 | 0.33% | 2500 |
| First preview ready | — | 3061.2 | 9.46% vs baseline searchable | 4000 |

Абсолютные времена машинозависимы (эмулированная сеть + контейнер), поэтому блокирует только
относительная деградация searchable-ready. У first-preview-ready нет аналога в baseline-арме
(в нём превью не монтируются вовсе), поэтому его деградация считается от searchable-ready
baseline и остаётся справочной.

## Состав трафика до первого превью (первый прогон full-арма)

| Категория | Запросов |
|---|---:|
| api | 1 |
| appAsset | 7 |
| bundle | 4 |
| catalog | 1 |
| designSystem | 1 |
| document | 1 |
| preview | 4 |
| shim | 2 |

## Прочее (медианы full-арма)

- карточек с превью-зоной: 77, смонтированных после успокоения: 6, в состоянии error: 0
- long tasks: 1 шт., суммарно 90 ms (baseline: 1 шт. / 90 ms)
- JS heap: 8.03 MiB → 10.53 MiB
- всего за прогон: 155 запросов / 1.81 MiB (baseline: 11 / 1.58 MiB)
- неудавшихся запросов (aborted при размонтировании превью — скролл и финальный поиск снимают задачи на лету): full 7, baseline 0
- точных `GET /api/components/:id` за весь прогон: full 0, baseline 0

<details><summary>Raw samples</summary>

```json
{
  "baseline": [
    {
      "settled": true,
      "libraryReady": 2818.5,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 89,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 7310564,
      "heapAfter": 7316176,
      "heapGrowth": 5612,
      "requestsThroughFirstPreview": 11,
      "bytesThroughFirstPreview": 1659738,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "designSystem": 1
      },
      "totalRequests": 11,
      "totalBytes": 1659738,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2796.5999999046326,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 90,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 7313904,
      "heapAfter": 7319560,
      "heapGrowth": 5656,
      "requestsThroughFirstPreview": 11,
      "bytesThroughFirstPreview": 1659738,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "designSystem": 1
      },
      "totalRequests": 11,
      "totalBytes": 1659738,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2790.4000000953674,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 2,
      "longTaskMs": 137,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 7310368,
      "heapAfter": 7315968,
      "heapGrowth": 5600,
      "requestsThroughFirstPreview": 11,
      "bytesThroughFirstPreview": 1659738,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "designSystem": 1
      },
      "totalRequests": 11,
      "totalBytes": 1659738,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2782.5,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 77,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 7311612,
      "heapAfter": 7317224,
      "heapGrowth": 5612,
      "requestsThroughFirstPreview": 11,
      "bytesThroughFirstPreview": 1659738,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "designSystem": 1
      },
      "totalRequests": 11,
      "totalBytes": 1659738,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2810.0999999046326,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 2,
      "longTaskMs": 135,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 7309536,
      "heapAfter": 7315148,
      "heapGrowth": 5612,
      "requestsThroughFirstPreview": 11,
      "bytesThroughFirstPreview": 1659738,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "designSystem": 1
      },
      "totalRequests": 11,
      "totalBytes": 1659738,
      "failedRequests": 0
    }
  ],
  "preview": [
    {
      "settled": true,
      "libraryReady": 2788.5,
      "firstPreviewReady": 3040.9000000953674,
      "peakSchedulerTasks": 4,
      "peakActive": 6,
      "longTasks": 1,
      "longTaskMs": 81,
      "iframes": 0,
      "mounted": 6,
      "active": 6,
      "failedPreviews": 0,
      "cards": 77,
      "heapBefore": 8426920,
      "heapAfter": 10960560,
      "heapGrowth": 2533640,
      "requestsThroughFirstPreview": 21,
      "bytesThroughFirstPreview": 1681692,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "preview": 4,
        "designSystem": 1,
        "bundle": 4,
        "shim": 2
      },
      "totalRequests": 152,
      "totalBytes": 1895914,
      "failedRequests": 7
    },
    {
      "settled": true,
      "libraryReady": 2805.9000000953674,
      "firstPreviewReady": 3061.199999809265,
      "peakSchedulerTasks": 4,
      "peakActive": 6,
      "longTasks": 2,
      "longTaskMs": 138,
      "iframes": 0,
      "mounted": 6,
      "active": 6,
      "failedPreviews": 0,
      "cards": 77,
      "heapBefore": 8424092,
      "heapAfter": 11105668,
      "heapGrowth": 2681576,
      "requestsThroughFirstPreview": 21,
      "bytesThroughFirstPreview": 1681692,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "preview": 4,
        "designSystem": 1,
        "bundle": 4,
        "shim": 2
      },
      "totalRequests": 156,
      "totalBytes": 1901347,
      "failedRequests": 5
    },
    {
      "settled": true,
      "libraryReady": 2804.5,
      "firstPreviewReady": 3057.5999999046326,
      "peakSchedulerTasks": 4,
      "peakActive": 6,
      "longTasks": 1,
      "longTaskMs": 85,
      "iframes": 0,
      "mounted": 6,
      "active": 6,
      "failedPreviews": 0,
      "cards": 77,
      "heapBefore": 8425028,
      "heapAfter": 11023280,
      "heapGrowth": 2598252,
      "requestsThroughFirstPreview": 21,
      "bytesThroughFirstPreview": 1681692,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "preview": 4,
        "designSystem": 1,
        "bundle": 4,
        "shim": 2
      },
      "totalRequests": 152,
      "totalBytes": 1898096,
      "failedRequests": 6
    },
    {
      "settled": true,
      "libraryReady": 2807.800000190735,
      "firstPreviewReady": 3068.0999999046326,
      "peakSchedulerTasks": 4,
      "peakActive": 6,
      "longTasks": 1,
      "longTaskMs": 90,
      "iframes": 0,
      "mounted": 6,
      "active": 6,
      "failedPreviews": 0,
      "cards": 77,
      "heapBefore": 8388220,
      "heapAfter": 11064300,
      "heapGrowth": 2676080,
      "requestsThroughFirstPreview": 21,
      "bytesThroughFirstPreview": 1681692,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "preview": 4,
        "designSystem": 1,
        "bundle": 4,
        "shim": 2
      },
      "totalRequests": 156,
      "totalBytes": 1902509,
      "failedRequests": 5
    },
    {
      "settled": true,
      "libraryReady": 2815.2999997138977,
      "firstPreviewReady": 3069.5,
      "peakSchedulerTasks": 4,
      "peakActive": 6,
      "longTasks": 1,
      "longTaskMs": 92,
      "iframes": 0,
      "mounted": 6,
      "active": 6,
      "failedPreviews": 0,
      "cards": 77,
      "heapBefore": 8425260,
      "heapAfter": 11043076,
      "heapGrowth": 2617816,
      "requestsThroughFirstPreview": 21,
      "bytesThroughFirstPreview": 1681692,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "preview": 4,
        "designSystem": 1,
        "bundle": 4,
        "shim": 2
      },
      "totalRequests": 155,
      "totalBytes": 1898522,
      "failedRequests": 3
    }
  ]
}
```
</details>
