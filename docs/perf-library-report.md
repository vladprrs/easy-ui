# Library inline-preview performance gate

Generated: 2026-07-31T08:34:04.259Z

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
| Запросов до первого превью (медиана) | 19 | ≤ 30 | PASS |
| Трафик до первого превью (медиана) | 1.60 MiB | ≤ 3.00 MiB | PASS |
| Смонтированных превью после успокоения (пик) | 3 | ≤ 12 | PASS |
| Прирост JS heap после полного скролла (медиана) | 2.62 MiB | ≤ 80.00 MiB | PASS |
| Деградация searchable-ready (full vs baseline) | 0.58% | < 20% | PASS |

Итог: **PASS**.

## Справочно (потолки спеки §8 — не блокируют)

| Метрика | Baseline, ms | Full, ms | Деградация | Потолок спеки |
|---|---:|---:|---:|---:|
| Searchable ready (`[data-library-ready="true"]`) | 2787.7 | 2804.0 | 0.58% | 2500 |
| First preview ready | — | 3044.2 | 9.20% vs baseline searchable | 4000 |

Абсолютные времена машинозависимы (эмулированная сеть + контейнер), поэтому блокирует только
относительная деградация searchable-ready. У first-preview-ready нет аналога в baseline-арме
(в нём превью не монтируются вовсе), поэтому его деградация считается от searchable-ready
baseline и остаётся справочной.

## Состав трафика до первого превью (первый прогон full-арма)

| Категория | Запросов |
|---|---:|
| api | 1 |
| appAsset | 7 |
| bundle | 3 |
| catalog | 1 |
| designSystem | 1 |
| document | 1 |
| preview | 3 |
| shim | 2 |

## Прочее (медианы full-арма)

- карточек с превью-зоной: 65, смонтированных после успокоения: 3, в состоянии error: 0
- long tasks: 1 шт., суммарно 84 ms (baseline: 1 шт. / 78 ms)
- JS heap: 7.62 MiB → 10.24 MiB
- всего за прогон: 139 запросов / 1.80 MiB (baseline: 11 / 1.58 MiB)
- неудавшихся запросов (aborted при размонтировании превью — скролл и финальный поиск снимают задачи на лету): full 5, baseline 0
- точных `GET /api/components/:id` за весь прогон: full 0, baseline 0

<details><summary>Raw samples</summary>

```json
{
  "baseline": [
    {
      "settled": true,
      "libraryReady": 2790.6000003814697,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 75,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 7242500,
      "heapAfter": 7248124,
      "heapGrowth": 5624,
      "requestsThroughFirstPreview": 11,
      "bytesThroughFirstPreview": 1660103,
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
      "totalBytes": 1660103,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2787.699999809265,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 82,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 7242460,
      "heapAfter": 7248116,
      "heapGrowth": 5656,
      "requestsThroughFirstPreview": 11,
      "bytesThroughFirstPreview": 1660103,
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
      "totalBytes": 1660103,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2782.800000190735,
      "firstPreviewReady": null,
      "peakSchedulerTasks": 0,
      "peakActive": 0,
      "longTasks": 1,
      "longTaskMs": 78,
      "iframes": 0,
      "mounted": 0,
      "active": 0,
      "failedPreviews": 0,
      "cards": 0,
      "heapBefore": 7244756,
      "heapAfter": 7250356,
      "heapGrowth": 5600,
      "requestsThroughFirstPreview": 11,
      "bytesThroughFirstPreview": 1660103,
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
      "totalBytes": 1660103,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2789.7000002861023,
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
      "heapBefore": 7242848,
      "heapAfter": 7248504,
      "heapGrowth": 5656,
      "requestsThroughFirstPreview": 11,
      "bytesThroughFirstPreview": 1660103,
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
      "totalBytes": 1660103,
      "failedRequests": 0
    },
    {
      "settled": true,
      "libraryReady": 2782.3999996185303,
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
      "heapBefore": 7247512,
      "heapAfter": 7253136,
      "heapGrowth": 5624,
      "requestsThroughFirstPreview": 11,
      "bytesThroughFirstPreview": 1660103,
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
      "totalBytes": 1660103,
      "failedRequests": 0
    }
  ],
  "preview": [
    {
      "settled": true,
      "libraryReady": 2807.0999999046326,
      "firstPreviewReady": 3044.199999809265,
      "peakSchedulerTasks": 3,
      "peakActive": 3,
      "longTasks": 1,
      "longTaskMs": 94,
      "iframes": 0,
      "mounted": 3,
      "active": 3,
      "failedPreviews": 0,
      "cards": 65,
      "heapBefore": 7990224,
      "heapAfter": 10690240,
      "heapGrowth": 2700016,
      "requestsThroughFirstPreview": 19,
      "bytesThroughFirstPreview": 1679909,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "preview": 3,
        "designSystem": 1,
        "bundle": 3,
        "shim": 2
      },
      "totalRequests": 137,
      "totalBytes": 1884410,
      "failedRequests": 4
    },
    {
      "settled": true,
      "libraryReady": 2804,
      "firstPreviewReady": 3058.4000000953674,
      "peakSchedulerTasks": 3,
      "peakActive": 3,
      "longTasks": 1,
      "longTaskMs": 89,
      "iframes": 0,
      "mounted": 3,
      "active": 3,
      "failedPreviews": 0,
      "cards": 65,
      "heapBefore": 7988896,
      "heapAfter": 10784072,
      "heapGrowth": 2795176,
      "requestsThroughFirstPreview": 19,
      "bytesThroughFirstPreview": 1679909,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "preview": 3,
        "designSystem": 1,
        "bundle": 3,
        "shim": 2
      },
      "totalRequests": 139,
      "totalBytes": 1886344,
      "failedRequests": 3
    },
    {
      "settled": true,
      "libraryReady": 2793.2000002861023,
      "firstPreviewReady": 3029.2000002861023,
      "peakSchedulerTasks": 3,
      "peakActive": 3,
      "longTasks": 1,
      "longTaskMs": 82,
      "iframes": 0,
      "mounted": 3,
      "active": 3,
      "failedPreviews": 0,
      "cards": 65,
      "heapBefore": 7927644,
      "heapAfter": 10725420,
      "heapGrowth": 2797776,
      "requestsThroughFirstPreview": 19,
      "bytesThroughFirstPreview": 1679909,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "preview": 3,
        "designSystem": 1,
        "bundle": 3,
        "shim": 2
      },
      "totalRequests": 139,
      "totalBytes": 1888751,
      "failedRequests": 5
    },
    {
      "settled": true,
      "libraryReady": 2793.199999809265,
      "firstPreviewReady": 3027.0999999046326,
      "peakSchedulerTasks": 3,
      "peakActive": 3,
      "longTasks": 1,
      "longTaskMs": 84,
      "iframes": 0,
      "mounted": 3,
      "active": 3,
      "failedPreviews": 0,
      "cards": 65,
      "heapBefore": 7988644,
      "heapAfter": 10739296,
      "heapGrowth": 2750652,
      "requestsThroughFirstPreview": 19,
      "bytesThroughFirstPreview": 1679909,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "preview": 3,
        "designSystem": 1,
        "bundle": 3,
        "shim": 2
      },
      "totalRequests": 139,
      "totalBytes": 1886344,
      "failedRequests": 3
    },
    {
      "settled": true,
      "libraryReady": 2808.4000000953674,
      "firstPreviewReady": 3047.800000190735,
      "peakSchedulerTasks": 3,
      "peakActive": 3,
      "longTasks": 1,
      "longTaskMs": 84,
      "iframes": 0,
      "mounted": 3,
      "active": 3,
      "failedPreviews": 0,
      "cards": 65,
      "heapBefore": 7987812,
      "heapAfter": 10738512,
      "heapGrowth": 2750700,
      "requestsThroughFirstPreview": 19,
      "bytesThroughFirstPreview": 1679909,
      "exactComponentInitial": 0,
      "exactComponentTotal": 0,
      "categories": {
        "document": 1,
        "appAsset": 7,
        "api": 1,
        "catalog": 1,
        "preview": 3,
        "designSystem": 1,
        "bundle": 3,
        "shim": 2
      },
      "totalRequests": 139,
      "totalBytes": 1886344,
      "failedRequests": 3
    }
  ]
}
```
</details>
