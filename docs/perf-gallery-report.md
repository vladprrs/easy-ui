# W5-3 gallery preview performance gate

Generated: 2026-07-14T15:41:19.112Z

Command: `npx tsx scripts/perf-gallery.mjs --url http://127.0.0.1:4180/ --runs 5`

Dataset: 30 API-created prototypes (3 custom DS); cleanup runs in `finally`. Seed sources are untouched.

Viewport: 1440×900. Network: 40 ms RTT, 5 Mbit/s down, 1 Mbit/s up. TTI is navigation start → gallery controls accept a search and the filtered card is painted for two animation frames.

| Run mode | Baseline median, ms | Preview median, ms | Degradation | Gate |
|---|---:|---:|---:|---|
| Cold (5 runs) | 2192.3 | 2205.6 | 0.61% | PASS |
| Warm (5 runs) | 2065.5 | 2098.2 | 1.58% | PASS |

Overall: **PASS** (both medians must degrade by <20%).

<details><summary>Raw samples (ms)</summary>

```json
{
  "coldBaseline": [
    2241.300000190735,
    2151.7999999523163,
    2194.600000143051,
    2192.2999999523163,
    2189.2999999523163
  ],
  "coldPreview": [
    2211.0999999046326,
    2186.5999999046326,
    2205.5999999046326,
    2221.199999809265,
    2188.5999999046326
  ],
  "warmBaseline": [
    2065.5,
    2063.7999999523163,
    2082.4000000953674,
    2065.5,
    2081.300000190735
  ],
  "warmPreview": [
    2097.600000143051,
    2098.2000000476837,
    2098.600000143051,
    2083,
    2114.2999999523163
  ]
}
```
</details>
