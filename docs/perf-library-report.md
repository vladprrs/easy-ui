# Library inline-preview performance gate

Generated: 2026-08-04T02:42:38.539Z

Command: `npm run perf:library -- --url http://127.0.0.1:4173/ --data-dir .e2e-data/perf-library --runs 5`

Dataset: 120 компонентов (3 дизайн-системы, 8 прототипов для usage, 40 визуальных эталонов), префикс `perf-library-`, сидинг напрямую в БД, cleanup в `finally`. Бандлы: chip 739 B (ABI 1), badge 935 B (ABI 4), card 1155 B (ABI 1), list 1501 B (ABI 1), panel 1728 B (ABI 1), screen 2794 B (ABI 4).

Viewport: 1440×900. Network: 40 ms RTT, 5 Mbit/s down, 1 Mbit/s up. Каждый прогон — холодный контекст с `Network.setCacheDisabled`. Медианы по 5 прогонам на арм.

Армы: baseline — `?libraryPreviews=off` (только метаданные), full — превью включены.

## Блокирующие гейты

| Метрика | Значение | Гейт | Результат |
|---|---:|---:|---|
| Точных `GET /api/components/:id` при первичной навигации | 0 | = 0 | PASS |
| iframe превью | 0 | = 0 | PASS |
| Пиковая одновременность задач планировщика | 3 | ≤ 4 | PASS |
| Запросов до первого превью (медиана) | 18 | ≤ 30 | PASS |
| Трафик до первого превью (медиана) | 1.59 MiB | ≤ 3.00 MiB | PASS |
| Смонтированных превью после успокоения (пик) | 3 | ≤ 12 | PASS |
| Прирост JS heap после полного скролла (медиана) | 2.56 MiB | ≤ 80.00 MiB | PASS |
| Деградация searchable-ready (full vs baseline) | -0.04% | < 20% | PASS |

Итог: **PASS**.

## Справочно (потолки спеки §8 — не блокируют)

| Метрика | Baseline, ms | Full, ms | Деградация | Потолок спеки |
|---|---:|---:|---:|---:|
| Searchable ready (`[data-library-ready="true"]`) | 2787.2 | 2786.1 | -0.04% | 2500 |
| First preview ready | — | 3014.0 | 8.14% vs baseline searchable | 4000 |

Абсолютные времена машинозависимы (эмулированная сеть + контейнер), поэтому блокирует только
относительная деградация searchable-ready. У first-preview-ready нет аналога в baseline-арме
(в нём превью не монтируются вовсе), поэтому его деградация считается от searchable-ready
baseline и остаётся справочной.

## Состав трафика до первого превью (первый прогон full-арма)

| Категория | Запросов |
|---|---:|
| api | 1 |
| appAsset | 6 |
| bundle | 3 |
| catalog | 1 |
| designSystem | 1 |
| document | 1 |
| preview | 3 |
| shim | 2 |

## Прочее (медианы full-арма)

- карточек с превью-зоной: 65, смонтированных после успокоения: 3, в состоянии error: 0
- long tasks: 1 шт., суммарно 87 ms (baseline: 1 шт. / 86 ms)
- JS heap: 8.43 MiB → 10.99 MiB
- всего за прогон: 137 запросов / 1.78 MiB (baseline: 10 / 1.57 MiB)
- неудавшихся запросов (aborted при размонтировании превью — скролл и финальный поиск снимают задачи на лету): full 3, baseline 0
- точных `GET /api/components/:id` за весь прогон: full 0, baseline 0

<details><summary>Raw samples</summary>

```json
{
  "baseline": [
    {
      "settled": true,
      "libraryReady": 2787.2000002861023,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 86,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 8114472,
      "heapAfter": 8120128,
      "heapGrowth": 5656,
      "requestsThroughFirstPreview": 10,
      "bytesThroughFirstPreview": 1643248,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 6,
        "api": 1,
        "catalog": 1,
        "designSystem": 1
      },
      "totalRequests": 10,
      "totalBytes": 1643248,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2781.699999809265,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 84,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 8113768,
      "heapAfter": 8119380,
      "heapGrowth": 5612,
      "requestsThroughFirstPreview": 10,
      "bytesThroughFirstPreview": 1643248,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 6,
        "api": 1,
        "catalog": 1,
        "designSystem": 1
      },
      "totalRequests": 10,
      "totalBytes": 1643248,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2788.699999809265,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 83,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 8114372,
      "heapAfter": 8119984,
      "heapGrowth": 5612,
      "requestsThroughFirstPreview": 10,
      "bytesThroughFirstPreview": 1643248,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 6,
        "api": 1,
        "catalog": 1,
        "designSystem": 1
      },
      "totalRequests": 10,
      "totalBytes": 1643248,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2782.9000000953674,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 86,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 8115444,
      "heapAfter": 8121112,
      "heapGrowth": 5668,
      "requestsThroughFirstPreview": 10,
      "bytesThroughFirstPreview": 1643248,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 6,
        "api": 1,
        "catalog": 1,
        "designSystem": 1
      },
      "totalRequests": 10,
      "totalBytes": 1643248,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2791.9000000953674,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 92,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 8113356,
      "heapAfter": 8118968,
      "heapGrowth": 5612,
      "requestsThroughFirstPreview": 10,
      "bytesThroughFirstPreview": 1643248,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 6,
        "api": 1,
        "catalog": 1,
        "designSystem": 1
      },
      "totalRequests": 10,
      "totalBytes": 1643248,
      "failedRequests": 0
    }
  ],
  "preview": [
    {
      "settled": true,
      "libraryReady": 2788.5,
      "firstPreviewReady": 3029.8999996185303,
      "peakSchedulerTasks": 3,
      "peakActive": 3,
      "longTasks": 1,
      "longTaskMs": 87,
      "iframes": 0,
      "mounted": 3,
      "active": 3,
      "failedPreviews": 0,
      "cards": 65,
      "heapBefore": 8844212,
      "heapAfter": 11523692,
      "heapGrowth": 2679480,
      "requestsThroughFirstPreview": 18,
      "bytesThroughFirstPreview": 1663054,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 6,
        "api": 1,
        "catalog": 1,
        "preview": 3,
        "designSystem": 1,
        "bundle": 3,
        "shim": 2
      },
      "totalRequests": 136,
      "totalBytes": 1866838,
      "failedRequests": 3
    },
    {
      "settled": true,
      "libraryReady": 2786.1000003814697,
      "firstPreviewReady": 3012.6000003814697,
      "peakSchedulerTasks": 3,
      "peakActive": 3,
      "longTasks": 1,
      "longTaskMs": 87,
      "iframes": 0,
      "mounted": 3,
      "active": 3,
      "failedPreviews": 0,
      "cards": 65,
      "heapBefore": 8845864,
      "heapAfter": 11503616,
      "heapGrowth": 2657752,
      "requestsThroughFirstPreview": 18,
      "bytesThroughFirstPreview": 1663054,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 6,
        "api": 1,
        "catalog": 1,
        "preview": 3,
        "designSystem": 1,
        "bundle": 3,
        "shim": 2
      },
      "totalRequests": 137,
      "totalBytes": 1865521,
      "failedRequests": 2
    },
    {
      "settled": true,
      "libraryReady": 2782.7999997138977,
      "firstPreviewReady": 3007.7999997138977,
      "peakSchedulerTasks": 3,
      "peakActive": 3,
      "longTasks": 1,
      "longTaskMs": 81,
      "iframes": 0,
      "mounted": 3,
      "active": 3,
      "failedPreviews": 0,
      "cards": 65,
      "heapBefore": 8842484,
      "heapAfter": 11613676,
      "heapGrowth": 2771192,
      "requestsThroughFirstPreview": 18,
      "bytesThroughFirstPreview": 1663054,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 6,
        "api": 1,
        "catalog": 1,
        "preview": 3,
        "designSystem": 1,
        "bundle": 3,
        "shim": 2
      },
      "totalRequests": 142,
      "totalBytes": 1873046,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2791.9000000953674,
      "firstPreviewReady": 3028.5,
      "peakSchedulerTasks": 3,
      "peakActive": 3,
      "longTasks": 1,
      "longTaskMs": 89,
      "iframes": 0,
      "mounted": 3,
      "active": 3,
      "failedPreviews": 0,
      "cards": 65,
      "heapBefore": 8844488,
      "heapAfter": 11507736,
      "heapGrowth": 2663248,
      "requestsThroughFirstPreview": 18,
      "bytesThroughFirstPreview": 1663054,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 6,
        "api": 1,
        "catalog": 1,
        "preview": 3,
        "designSystem": 1,
        "bundle": 3,
        "shim": 2
      },
      "totalRequests": 137,
      "totalBytes": 1865038,
      "failedRequests": 2
    },
    {
      "settled": true,
      "libraryReady": 2785.199999809265,
      "firstPreviewReady": 3014,
      "peakSchedulerTasks": 3,
      "peakActive": 3,
      "longTasks": 1,
      "longTaskMs": 81,
      "iframes": 0,
      "mounted": 3,
      "active": 3,
      "failedPreviews": 0,
      "cards": 65,
      "heapBefore": 8845032,
      "heapAfter": 11561624,
      "heapGrowth": 2716592,
      "requestsThroughFirstPreview": 18,
      "bytesThroughFirstPreview": 1663054,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 6,
        "api": 1,
        "catalog": 1,
        "preview": 3,
        "designSystem": 1,
        "bundle": 3,
        "shim": 2
      },
      "totalRequests": 138,
      "totalBytes": 1868447,
      "failedRequests": 2
    }
  ]
}
```
</details>
