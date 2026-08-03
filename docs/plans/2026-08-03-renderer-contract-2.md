# План: Renderer Contract 2.0 — детерминированный capture, receipt, cross-renderer guard, пул и кэш

Дата: 2026-08-03. Версия: **v1 (черновик для Stage 2)**.
Источник требований: `docs/EASYUI_RENDERING_IMPROVEMENTS.md` (P0.1–P0.5, P1.1–P1.5, P2.1–P2.3, «Метрики успеха»).
База: план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md` **полностью закрыт** (W0–W9), RFC `2026-08-02-candidate-acceptance-pipeline-rfc.md` v5 (R1 в проде, R2 исполнен волнами family-плана).

> Этот план — **дельта** поверх посаженного состояния. Он не переоткрывает решения family-плана (D4 paint-режим, D5 readiness-политика, A4 CAS-evidence, D1 `case_fingerprint`), а достраивает то, что там было объявлено не-целью: полный renderer fingerprint, строгость ресурсов, типизированные коды, receipt, cross-renderer guard, разделение метрик, пул и кэш.

> Очередь исполнения: **R0** (микро-релиз env+CI) → **R1** → **R2** → **R3** → **R4** → **R5** → **R6** → **R7**; **R8** (замок драйвера) параллелится с R5–R7; **R9a–c** (P2) — после R7. Единственная миграция пакета — **v27** в R6.

> Процесс: после одобрения план сохраняется в `docs/plans/2026-08-03-renderer-contract-2.md`, коммитится и проходит Stage 2 (адверсариальное ревью субагентами) до начала реализации.

---

## 1. Задача и цели

Сегодня два одинаковых по DOM/CSS компонента дают `exact-rgba 0,6974%` / `perceptual 0,2870%` разницы, кластеры — вокруг текста и badge, геометрия совпадает. Причина не в компоненте: **capture не является функцией объявленных входов**. Конкретно, по коду:

1. `scripts/screenshot-worker.mjs#buildLaunchArgs` не передаёт ни `--force-color-profile=srgb`, ни каких-либо флагов растеризации — цветовой профиль и хинтинг наследуются от хоста;
2. `rendererBuild` — это **имя entry-файла SPA** (`server/screenshot/allowedUrls.ts#rendererBuildFrom` читает `dist/.vite/manifest.json`), то есть идентичность бандла, а не рендерера; про chromium/шрифты/ОС он не говорит ничего;
3. серверный `captureEnvFingerprintOf(readinessPolicyHash)` (`server/acceptance/ids.ts`) — это `sha256({algoVersion:1, process.platform, process.arch, readinessPolicyHash})`. **Апгрейд chromium его не меняет** → reuse `acceptance_case_results` по `case_fingerprint` переживает смену рендерера. Это дыра приёмки, а не косметика;
4. `src/capture/readiness.ts#settleFonts` осознанно не валит capture на `FontFace.status === "error"` и не проверяет ни одного конкретного `weight/style`; `settleImages` валит только при полном отсутствии растра; `settleFrames` ждёт N rAF, но **не перемеряет** — доказательства покоя layout нет;
5. причины неуспеха — ad-hoc строки, склеенные запятой (`"fonts_timeout,images_failed"`); типизированного словаря нет, `JobOutcome` не выходит наружу по HTTP;
6. `CaptureReadinessOutcome` едет **только** на байтовых доставках (`deliver:"bytes"`, `probe:"paint"`). Asset-путь — интерактивный `snap`, кандидатный кадр `VisualService` — не получает ни readiness, ни env, ни таймингов: визуальные раны прода судят кадры, о происхождении которых не знают ничего;
7. `server/visual/fingerprint.ts` не содержит ни одного renderer-поля: baseline и кандидат, снятые разными рендерерами, сравниваются как обычная визуальная регрессия;
8. `.claude/skills/author/driver.mjs` verb `shoot` (строка ~2186) поднимает **собственный локальный chromium** (`await import("playwright"); chromium.launch()`) без handshake и readiness — второй рендерер в продукте.

**Цель пакета.** Сделать capture воспроизводимой функцией `PNG = render(document snapshot, renderer fingerprint, resource manifest, capture options)`: объявленный и проверяемый рендерер, строгие ресурсы, доказанная стабильность layout, один машиночитаемый receipt на оба канала доставки, и явный отказ сравнивать кадры разных рендереров.

### KPI (метрики успеха документа) и как меряем

| № | Метрика документа | Baseline (факт) | Цель | Инструмент измерения | Волна |
|---|---|---:|---:|---|---|
| K1 | ≥99,9% повторных capture одного входа дают `exact-rgba = 0` | не измерялось; гейт `determinism` сравнивает 2 кадра на выборке | ≥99,9% на корпусе | `scripts/renderer-corpus.mjs`: 12 фикстур × 20 повторов внутри одного контейнера, сравнение sha256 PNG | R2 (гейт), R9a (перепроверка с пулом) |
| K2 | Локальный и server capture в одном image совпадают полностью | недостижимо: `shoot` = отдельный локальный chromium | `exact-rgba = 0` | тот же корпус: `docker run <image> … corpus:verify` локально и в CI, сверка `expected.json` | R2 + R8 |
| K3 | Ни один strict capture не проходит с fallback-шрифтом/битой картинкой | проходит (`status==="error"` не валит; images — только по untyped-строке) | 0 | unit на `collectReadiness` + e2e-фикстуры «нет font asset» / «битый `<img>`» → `font_face_missing`/`image_load_failed` | R4 |
| K4 | Причина неуспеха определяется без ручного просмотра PNG | только `capture_failed` + строка | 9 типизированных кодов на всех путях | контракт `captureFailureCode`, тест «каждый код достижим фикстурой» | R3 + R4 + R6 |
| K5 | Медианное число итераций component → verified screenshot | 10+ (мотивировка документа) | 1–3 | замер на семье `pay-payment-card` по журналу `driver.mjs`: число capture-запросов до зелёного вердикта | R7 (done) |
| K6 | Повторный запрос с тем же cache key не запускает chromium | нет кэша вне acceptance | 100% попаданий на неизменённом входе | `cache:{status,key,reason}` в ответе + счётчик запусков воркера | R9b |
| K7 | p95 verify capture измеряется отдельно для cold и warm | нет разделения | опубликованные числа в §4 | `scripts/measure-capture.mjs` (канон `measure-acceptance.mjs`), 49-кейсовая семья | R9a/R9b |
| K8 | Reuse приёмки не переживает апгрейд chromium | переживает (дыра §1.3) | 0 переживших | unit: подмена `browserVersion`/`launchArgsHash` в манифесте → `case_fingerprint` изменился | R1 |

---

## 2. Поправки и решения (триаж гипотез постановки)

### 2.1. Принято с уточнениями

**P1. Флаги запуска** (сверено: `buildLaunchArgs` дословно тестируется `server/screenshot-worker.test.ts:7` — детерминизм-флаги выносятся отдельной функцией):

| Флаг | Вердикт | Обоснование |
|---|---|---|
| `--force-color-profile=srgb` | **включить** | прямое требование P0.5; убирает зависимость от профиля хоста |
| `--disable-skia-runtime-opts` | **включить** | единственный флаг, бьющий по **реальной** причине cross-host расхождения: Skia выбирает SIMD-пути по CPUID (AVX2/AVX-512 GH-раннера против 1-CPU прод-VM). Без него K2 недостижим. Плата — раствор медленнее; замер в R2 |
| `--font-render-hinting=none` | **включить** | снимает зависимость от fontconfig/FreeType базового образа; растр — функция только шрифт-файла |
| `--disable-font-subpixel-positioning` | **включить** | без него позиция глифа зависит от субпиксельного origin; текст на дробных координатах (фикстура корпуса) даёт разный растр при идентичном layout |
| `--disable-lcd-text` | **включить** | явное лучше неявного: headless обычно greyscale-AA, но это зависит от сборки |
| `--disable-partial-raster` | **включить** | дёшево; снимает зависимость растра от истории инвалидации тайлов |
| `--hide-scrollbars` | **включить** | element-screenshot не страдает, но `page.screenshot`-фолбэк — страдает |
| `--js-flags=--random-seed=…` | **отклонить** | не влияет на растр; фиксированный seed **замаскировал** бы недетерминированный компонент, который обязан ловить гейт `determinism` |
| `--deterministic-mode` / `--run-all-compositor-stages-before-draw` | **отложить (опция R2)** | меняет модель кадра, может конфликтовать с playwright `screenshot`. Включаем только если корпус R2 без них не даёт K1 |

**P4. Строгие шрифты.** Обязательные faces **выводимы из темы**: `themeFontSchema = {family, src, weight?, style?}` (`server/contracts.ts:516`), `src` — `/api/assets/<assetId>`; `themeContent` уже в руках на постановке джобы (`resolveSpacingScale(ds, themeContent.tokens, …)`). `fontManifestHash` и required-faces считаются server-side до capture.

**P5. Стабилизация layout** — после frames-settle, ≤3 попыток, код `layout_unstable`.

**P6. Типизированные коды** сквозь воркер → сервис → гейты → HTTP + openapi; `JobOutcome` выставляется наружу.

**P7. Receipt на оба канала** — принят; хранение: acceptance — существующий CAS (`putArtifact`); не-acceptance — **новый маленький CAS-стор** `<dataDir>/.receipts/<sha[0:2]>/<sha>` с TTL 7 суток и потолком 64 МБ (канон GC — `.candidates/`/`gcEvidence`). Ассет-стор для receipt'ов **запрещён** (нет GC — та же причина, что породила A4). Receipt ~2–8 КБ ⇒ прод-диск не в риске.

**P9. Guard аддитивной колонкой**, legacy-NULL → advisory. Честный факт: `POST /api/prototypes/:id/visual-baselines` принимает **клиентский `assetId`** (PNG загружает клиент) — рендерер такого эталона сервер знать не может. Guard трёхзначный: `matched | mismatch | unknown`, `unknown` никогда не блокирует.

**P11. Diagnostic bundle** для визуальных ранов — аналог acceptance-zip: `fflate/zipSync` + `zipResponse` + `sanitizeEvidenceName` (канон `server/routes/acceptance.ts`).

### 2.2. Отклонено / переформулировано

**N1 (blocker гипотезы). `dockerImageDigest` не может быть входом renderer fingerprint.**
Технически: digest известен только **после** push'а, внутрь образа не попадает. Смыслово: digest меняется на **каждом коммите** — правка `docs/*.md` обнуляла бы весь reuse и помечала каждый эталон как cross-renderer. Ровно обратная цель.
**Замена: build-time renderer manifest.** В `Dockerfile` после `playwright install` и `npm run build` генерируется `/app/renderer-manifest.json` (`scripts/renderer-manifest.mjs`):

```jsonc
{
  "manifestVersion": 1,
  "rendererVersion": "r2",                 // константа репозитория, растёт руками
  "os": "linux", "arch": "x64",
  "nodeVersion": "24.x.y",                 // воркер живёт под node, не под bun
  "bunVersion": "1.3.14",                  // справочно (на растр не влияет)
  "playwrightVersion": "1.61.1",           // require("playwright/package.json"); пин точный, без ^
  "browserName": "chromium",
  "browserVersion": "…", "browserRevision": "…",   // playwright-core/browsers.json
  "browserExecutableSha256": "…",          // sha256 chromium.executablePath()
  "fontStackSha256": "…",                  // sha256(fc-list … | sort)
  "systemLibs": { "fontconfig": "…", "libfreetype6": "…" },  // dpkg-query, мягко → null
  "appFontsSha256": "…",                   // sha256 содержимого dist/fonts
  "provenance": { "buildSha": "…", "imageRef": "ghcr.io/…:<sha>", "builtAt": "…" }
}
```
`provenance` — **вне** хеша (происхождение, не рендерер). В dev манифест отсутствует → считается на лету (`chromium.executablePath()` уже импортируется в `server/screenshot/worker-runner.ts`), кэшируется в памяти процесса.

**N2 (major). Апгрейд chromium ловится drift-чеком, не отдельным образом.** `playwright` уже пиннут точно (`"playwright": "1.61.1"`); `RENDERER_VERSION` — константа. CI-шаг `verify:renderer` сверяет `browsers.json#chromium.{browserVersion,revision}` с `server/capture/rendererPin.json` и **падает** при расхождении без ручного bump'а `RENDERER_VERSION`. Апгрейд chromium = PR с явной правкой двух файлов — осознанная миграция. Отдельный образ такого свойства сам по себе не даёт.

**N3 (major). Отдельный `easy-ui-renderer` image — отклонить.**
- прод — `mem_limit: 1g`, 1 CPU, один compose-сервис; второй chromium-сервис конкурирует за ту же память;
- Dokploy тянет один образ `pull_policy: always`; двухобразная связка — новый класс рассинхрона версий;
- «два рендерера» — проблема **клиента**, не сервера: серверный capture уже исполняется внутри app image. Убирается локальный chromium в `shoot` — проблема исчезает;
- слой `playwright install --with-deps` ≈ 500 МБ; дублировать его в GHCR ради идентичности, уже обеспеченной манифестом, — плата без выгоды.

**Вместо этого (R8):** (а) `shoot` → алиас серверного `snap --all-screens`; (б) рецепт офлайн-съёмки `docker run` на **том же** образе в доках; (в) `renderer-manifest` отдаётся в `GET /api/capabilities` (секция `renderer`) — клиент сравнивает рендереры до съёмки.

**N4 (major). `fontManifestHash` — поле resource manifest, не renderer fingerprint.** Набор шрифтов темы меняется на каждую версию темы; рендерер — нет. В fingerprint он валил бы cross-renderer guard на каждый апдейт темы. Разделение: `fontManifestHash` (тема) — в receipt и guard'е отдельным полем; `appFontsSha256`/`fontStackSha256` (образ) — в renderer fingerprint. Плюс: `themeVersion` уже входит в `buildFingerprint` → новый вход в `case_fingerprint` не нужен.

**N5 (major). Bump `CASE_FINGERPRINT_ALGO_VERSION` — ровно один, в R1 (4→5).** R1 меняет **схему** входа (`captureEnvFingerprint` → `rendererFingerprint`) ⇒ bump. R2 (флаги) и R4 (строгая политика) меняют **значения** внутри уже входящих хешей ⇒ reuse инвалидируется автоматически без смены схемы. Тест-инвариант: «bump'ов в пакете больше нет».

**N6 (major). Renderer fingerprint не входит в `fingerprint_json` таблицы `visual_references`.** Буквальное исполнение документа ломает прод: `vref_sha256(...)` — PK/UNIQUE и записан в `visual_baseline_sets.members_json`; добавление полей осиротит **каждый** эталон и переведёт baseline-сеты в `reference_missing`. Identity эталона остаётся поверхностной; renderer — **аддитивные атрибуты + guard перед диффом**. Там, где ключ действительно решает — reuse приёмки — renderer уже **внутри** `case_fingerprint` (R1).

**N7 (medium). Новый статус в `visual_runs.status` не вводится.** `CHECK(status IN ('pass','fail','error','reference_missing'))` (`server/migrations.ts:133,260`) — расширение требует rebuild таблицы, а ограничение пакета — только `ADD COLUMN`. Решение: `status='error'` + аддитивные `outcome_code TEXT` (`renderer_mismatch`) и `renderer_guard TEXT`; наружу `RunReport` отдаёт `{status:"error", code:"renderer_mismatch", renderer:{differing:[…]}}`.

**N8 (medium). Geometry-сигнал P1.3 для scope `prototype-screen` — не отдельный прогон.** `probe:"paint"` — component-only; второй capture-прогон ради геометрии на визуальном пути — удвоение стоимости на 1-CPU проде. Четыре сигнала = `dimensions`, `exact`, `perceptual`, `edgeResidual`. Полноценный `geometry`-сигнал — только component-scope, режим `diagnostic` (R9c).

**N9 (medium). Пул по умолчанию на проде — нет.** Изоляция по угрозе не нужна (same-origin), но постоянный chromium держит 120–200 МБ RSS **всё время** при `mem_limit: 1g`. Пул — `EASYUI_RENDERER_POOL=1`: ON в dev/CI, OFF на проде до замера RSS (done R9a). Ресайкл: N джоб (20), TTL, порог RSS, **всегда** после не-`ok` `jobOutcome`, всегда при смене `captureOrigin`.

**N10 (minor). Строгость включается политикой, а не env-флагом.** `readinessPolicy` per-job и хешируется. `pixel-strict-v1` получает `STRICT_READINESS_POLICY` (v2) в R4; `default-v1` переключается отдельным откатываемым шагом после зелёного корпуса. Интерактивные пути остаются на `DEFAULT_READINESS_POLICY` v1 — поведение не меняется.

---

## 3. Ключевые проектные решения

- **E1. Renderer fingerprint 2.0 — объявленный, серверный, до-capture'ный.**
  ```ts
  // server/capture/renderer.ts
  rendererFingerprint = sha256(canonicalJson({
    rendererSchema: 2,
    rendererVersion,                        // RENDERER_VERSION, ручной bump
    os, arch, nodeVersion, playwrightVersion,
    browserName: "chromium", browserVersion, browserRevision, browserExecutableSha256,
    fontStackSha256, appFontsSha256, systemLibsHash,
    launchDeterminismArgsHash,              // sha256 канонического списка ДЕТЕРМИНИЗМ-флагов
    colorProfile: "srgb", locale: "ru-RU", timezone: "Europe/Moscow", reducedMotion: "reduce",
    readinessPolicyHash,
  }))
  ```
  Считается **до** съёмки — поэтому годится ключом reuse (в отличие от in-page пробы). Критично: `buildLaunchArgs(denyPort, capturePort)` содержит эфемерные порты и дословно проверяется тестом — детерминизм-флаги выносятся чистой функцией `buildDeterminismArgs()`, хешируется только она.

- **E2. Наблюдённое остаётся наблюдением.** In-page `collectCaptureEnv` (`src/capture/env.ts`) не выкидывается: ловит реальный DPR, gamut, растр-пробу FNV. Сверка:
  - `browser.version()` ≠ `manifest.browserVersion` ⇒ **hard-fail `renderer_mismatch`**: образ не соответствует своему манифесту;
  - UA страницы (редуцированный) — только по major ⇒ warning `renderer_env_drift`;
  - наблюдённый gamut ≠ `srgb`, `dpr` ≠ `job.deviceScaleFactor` ⇒ warning `renderer_env_drift` в receipt и метрики гейта `readiness`.

- **E3. Типизированный словарь исходов — один на продукт.**
  ```ts
  // src/capture/failureCodes.ts (общий: поверхность, воркер, сервер, гейты, sdk)
  export type CaptureFailureCode =
    | "font_load_failed" | "font_face_missing" | "image_load_failed"
    | "layout_unstable"  | "surface_missing"   | "surface_overflow"
    | "renderer_mismatch"| "navigation_failed" | "runtime_error";
  export interface CaptureCode { code: CaptureFailureCode; severity: "error"|"warning"; detail: string; ref?: string }
  ```
  Эмитенты: поверхность — `font_*`, `image_load_failed`, `layout_unstable`, `surface_missing`; воркер/сервис — `navigation_failed`, `runtime_error`; `geometryPolicy.ts` — `surface_overflow` (маппинг `paint-overflow-not-clipped|layout-overflow`); визуальный guard — `renderer_mismatch`. Совместимость: `readinessReason` **сохраняется** (производное `codes.map(c=>c.code).join(",")`), рядом `readinessCodes: CaptureCode[]`.

- **E4. Receipt — один артефакт для обоих каналов.** Собирается в `ScreenshotService.execute` **до** ветвления `paint|geometry|bytes|asset` — asset-путь (интерактивный `snap`, кандидат `VisualService`) получает его наравне с байтовым. `receiptSha256` — в `JobStatus.result` всех kind'ов; байты — в `.receipts/`-CAS (не-acceptance) или acceptance-CAS.

- **E5. Guard сравнивает три уровня**: `rendererFingerprint` (образ), `fontManifestHash` (тема), `readinessPolicyHash` (условия съёмки). Ответ несёт **список различающихся полей** (P1.4), не только «не совпало».

- **E6. Вердикт визуального рана — из четырёх сигналов.**
  ```
  dims:       equal | normalized | irreconcilable
  exact:      diffPixels/totalPixels            (уже есть в visual-diff-worker.mjs)
  perceptual: pixelmatch includeAA:false        (уже есть)
  edge:       residual внутри/вне edge-маски    (новое в diff-воркере)
  ```
  Правила: `irreconcilable` → `indeterminate` (сегодня — `error` без метрик, это регресс диагностики); `exact=0` → `pass, renderer:"identical"`; `exact>0 ∧ perceptual ≤ порога ∧ ≥95% остатка внутри edge-маски` → `pass, class:"renderer_residual"`; иначе `fail` с причиной из **существующего** `server/visual/causes.ts` (W5b, включая `text-raster-residual`) — классификаторы не дублируются.

- **E7. Кэш и пул — только там, где нет собственного механизма.** У acceptance есть reuse по `case_fingerprint`; кэш R9b обслуживает только не-acceptance пути.

- **E8. Режимы capture — пресеты над существующими ручками.** `resolveCaptureMode(mode)` → `{readinessPolicy, probe, deliver, receipt, cache, signals}`. `preview` = сегодняшнее поведение; `verify` = strict policy + receipt; `baseline` = verify + запрет кэша + запись renderer-полей на эталон; `diagnostic` = verify + geometry-сигнал + расширенные артефакты. Внутренняя функция — R4, публичный параметр — R9c.

---

## 4. Волны

### R0 — Микро-релиз: env, CI-стемпинг, renderer manifest

**Объём.** До кода, читающего флаги (канон W0 family-плана).
- `docker-compose.yml`: `EASYUI_RENDERER_FLAGS`, `EASYUI_RENDERER_GUARD_DISABLED`, `EASYUI_CAPTURE_RECEIPTS_DISABLED`, `EASYUI_VISUAL_SIGNALS_V2`, `EASYUI_RENDERER_POOL`, `EASYUI_CAPTURE_CACHE`, `EASYUI_IMAGE_REF` (все `${…:-}`, читаются строгим `=== "1"`).
- `Dockerfile`: `ARG EASYUI_BUILD_SHA`; после `npm run build` — `RUN node scripts/renderer-manifest.mjs > /app/renderer-manifest.json`; `ENV EASYUI_RENDERER_MANIFEST=/app/renderer-manifest.json`.
- `.github/workflows/build-image.yml`: `build-args: EASYUI_BUILD_SHA=${{ github.sha }}`; после push — прокидка `digest` в Dokploy env `EASYUI_IMAGE_REF` (advisory-провенанс).
- `scripts/renderer-manifest.mjs` (новый, node): playwright/browsers.json, sha256 `chromium.executablePath()`, `fc-list`, `dpkg-query` (мягко → `systemLibs: null`), `dist/fonts`.

**Файлы.** Новые: `scripts/renderer-manifest.mjs`. Изменяемые: `Dockerfile`, `docker-compose.yml`, `.github/workflows/build-image.yml`, `docs/server-api.md`.
**Done.** Деплой; `docker run <image> cat /app/renderer-manifest.json` отдаёт полный документ; бэкап prod-volume перед R6; `npm run verify`.

### R1 — Renderer fingerprint 2.0 (единственный bump `algoVersion`)

**Объём.**
- `server/capture/renderer.ts`: чтение/кеширование манифеста (+dev-фолбэк), `RENDERER_VERSION`, `rendererPin.json`, `rendererFingerprint(readinessPolicyHash)`, `rendererDeclaration()`, `buildDeterminismArgs()` (пока пустой список — флаги в R2, хеш-вход уже существует).
- `server/acceptance/ids.ts`: `captureEnvFingerprintOf` **удаляется**, вход `case_fingerprint` → `rendererFingerprint`; `CASE_FINGERPRINT_ALGO_VERSION = 5` (**последний bump пакета**).
- `server/screenshot/service.ts`: `rendererDeclaration` на джобе; `CaptureReadinessOutcome` += `rendererFingerprint`/`rendererDrift: CaptureCode[]`; сверка `result.browserVersion` vs манифест → hard-fail с `job.error.code = "renderer_mismatch"` (не `jobOutcome:"subprocess_error"` — это продуктовый отказ среды).
- `GET /api/capabilities`: секция `renderer` (объявление + `provenance`).
- `scripts/check-renderer-pin.ts` + npm-скрипт `verify:renderer` в `npm run verify`.

**Файлы.** Новые: `server/capture/renderer.ts` (+тест), `server/capture/rendererPin.json`, `scripts/check-renderer-pin.ts`. Изменяемые: `server/acceptance/ids.ts`, `server/acceptance/caseSets.test.ts` (4→5), `server/screenshot/service.ts`, `server/routes/meta.ts`, `server/contracts.ts`+openapi+`generate:sdk`, `package.json`, `docs/server-api.md`.

**Done.** `verify` (+`verify:renderer`); unit K8: подмена `browserVersion`/`browserExecutableSha256`/`launchDeterminismArgsHash` меняет `rendererFingerprint` и `case_fingerprint`, правка `provenance.buildSha` — **не меняет**; unit «bump ровно один: `=== 5`»; тест «`browser.version()` ≠ манифест ⇒ джоба падает `renderer_mismatch`»; e2e `e2e/preview/renderer-fingerprint.spec.ts` — два капчура дают равный `rendererFingerprint`, `capabilities.renderer` совпадает.
**Флаг.** Не нужен: пиксели не меняются, инвалидируется только reuse приёмки (одна холодная пересъёмка ~1,6 мин на 49 cases по замеру W1b).

### R2 — Детерминированный запуск (sRGB + растровые флаги) + корпус рендерера + CI

**Объём.**
- `scripts/screenshot-worker.mjs`: `buildDeterminismArgs()` (экспорт, дословно тестируемый), конкатенация в `chromium.launch({args})`. Список — §2.1; `--js-flags=--random-seed` **не** включается.
- Флаг `EASYUI_RENDERER_FLAGS=1` (dev/CI ON через `playwright.config.ts` webServer и `npm run serve`; прод OFF до приёмки §6). Значение флага входит в `launchDeterminismArgsHash` ⇒ кадры «с флагами» и «без» никогда не путаются.
- **Корпус рендерера**: `e2e/fixtures/renderer-corpus/` — 12 фикстур: YS Text 400/500 кириллица+цифры+валюта; текст на целых и дробных координатах; badge с radius; SVG-иконка; raster-картинка; opacity+shadow+gradient; flex/grid; DPR 1/2/3; light/dark; отсутствующий font asset; битое изображение; поздняя мутация layout. `scripts/renderer-corpus.mjs` (канон `measure-acceptance.mjs`: поднимает Bun preview на изолированном `DATA_DIR`, публикует фикстурную ДС и компоненты).
- Два уровня гейта:
  - **hard** — повтор внутри одного контейнера байт-идентичен (`sha256(PNG)` × 20 × 12) ⇒ K1;
  - **soft** — cross-host (GH-раннер против локального `docker run` того же образа) даёт `exact-rgba = 0`; при провале — отчёт с ppm, гейт не блокирует мёрдж до отдельного решения. Причина: cross-host байт-идентичность зависит от CPU-путей Skia; `--disable-skia-runtime-opts` должен её дать, но объявлять фактом до замера нечестно.
- CI: job `renderer-corpus` в `.github/workflows/build-image.yml` — после сборки `docker run --rm ghcr.io/vladprrs/easy-ui:${{ github.sha }} node scripts/renderer-corpus.mjs --verify`; ожидания — `e2e/fixtures/renderer-corpus/expected.json` (**только sha256, PNG в git не кладём**).

**Файлы.** Новые: `scripts/renderer-corpus.mjs`, `e2e/fixtures/renderer-corpus/**`, `e2e/preview/renderer-determinism.spec.ts`. Изменяемые: `scripts/screenshot-worker.mjs`, `server/capture/renderer.ts` (флаги в хеш), `playwright.config.ts` (прецедент `surfacesEnv`), `.github/workflows/build-image.yml`, `package.json` (`corpus:verify`), `docs/server-api.md`.

**Done.** hard-гейт ≥99,9% (K1); замер стоимости флагов (прирост ms/case — в §5-факты); soft-гейт замерен и опубликован (K2); фикстуры «нет font asset»/«битое изображение» пока падают **старым** untyped-путём (типизация — R4) — ожидаемо, зафиксировано в спеке.
**Флаг.** `EASYUI_RENDERER_FLAGS` обязателен: включение меняет пиксели и делает все существующие `visual_references` устаревшими. Прод включается только после R6 (сначала guard, потом смена пикселей).

### R3 — Типизированные коды сквозь конвейер + `jobOutcome` в HTTP

**Объём.** Механическая, контракт-широкая; **до** строгости, чтобы новые причины R4 приезжали типизированными.
- `src/capture/failureCodes.ts` (E3).
- `src/capture/readiness.ts`: `reasons: string[]` → `codes: CaptureCode[]`; маппинг существующих строк (`fonts_timeout|fonts_pending` → `font_load_failed` warning пока строгости нет; `images_failed` → `image_load_failed`; `frames_timeout` → `layout_unstable`; `network_timeout` → `runtime_error` warning). `reason` — производное.
- `src/capture/protocol.ts`: `CaptureReadinessReport.codes?`.
- `scripts/screenshot-worker.mjs`: `page.goto` в try/catch → `navigation_failed`; ошибка/mismatch handshake → `runtime_error`; `page.$("#eui-capture-surface")` null → `surface_missing` (сейчас молча деградирует в `page.screenshot`).
- `server/screenshot/service.ts`: `job.error.code: CaptureFailureCode | "capture_failed"`; `CaptureReadinessOutcome.readinessCodes`.
- `GET /api/screenshot-jobs/:id`: аддитивные `outcome: JobOutcome` и `failure: {code, message}`.
- Гейты: `gates/readiness.ts` и `render.ts` кладут `codes` в метрики; `gates/geometry2.ts` маппит `policyVerdict` → `surface_overflow`.

**Файлы.** Новые: `src/capture/failureCodes.ts` (+тест). Изменяемые: `src/capture/{readiness.ts,protocol.ts}`, `scripts/screenshot-worker.mjs`, `server/screenshot/service.ts`, `server/acceptance/gates/{readiness,render,geometry2}.ts`, `server/routes/screenshots.ts`, contracts+openapi+sdk, `docs/server-api.md`.
**Done.** unit «каждый код достижим фикстурой или явно помечен "эмитится в R4/R6"»; unit «старый `readinessReason` побайтово совпадает с производным из `codes`»; e2e: джоба на несуществующем URL → `failure.code === "navigation_failed"` при терминальном `outcome` (тест фиксирует двухосность outcome/failure); `verify`.
**Флаг.** Не нужен — только аддитивные поля.

### R4 — Строгая readiness 2.0: шрифты, изображения, стабилизация layout

**Объём.**
- `src/capture/readinessPolicy.ts`: `version: 1 | 2`; v2 — `fonts: "required-faces"`, `images: "decoded-strict"`, `layout: {stabilize: true, attempts: 3}`. `DEFAULT_READINESS_POLICY` **не меняется**; добавляется `STRICT_READINESS_POLICY`.
- Required-faces: сервер собирает манифест из `themeContent.fonts` (`{family, weight, style, assetId, sha256}` через `AssetRepo.get`), считает `fontManifestHash`, кладёт в `bootstrap.fonts = {required, manifestHash}` (`enqueueComponentDraftBytes`/`enqueueComponentFrozen`).
- `settleFonts` в `required-faces`: `document.fonts.load('${weight} ${style} 16px "${family}"')` → `document.fonts.check(...)` → проверка `FontFace.status`. `check() === false` ⇒ `font_face_missing`; `status === "error"`/reject ⇒ `font_load_failed`. **`check()` — авторитет** (корректно учитывает face, объявленные хромом: `src/designSystems/fontRegistry.ts` намеренно пропускает «YS Text»); `status` — подтверждающий сигнал.
- `settleImages` в `decoded-strict`: `complete ∧ naturalWidth>0 ∧ naturalHeight>0 ∧ decode() resolved`; в evidence — URL/assetId, intrinsic-размеры, `contentHash` (из `asset_<sha256>`); отказ ⇒ `image_load_failed`.
- `src/capture/stability.ts` (новый): `rectSignature(root, detailKeys)` — rect поверхности + geometry-узлов, округление до 1/64 px; цикл «rAF → измерить → rAF → измерить → сравнить», ≤3 попытки, иначе `layout_unstable` с разошедшимся `elementKey`. После `settleFrames`, до `themeResources` (порядок из readiness-алгоритма документа).
- `server/acceptance/policies.ts`: `pixel-strict-v1.readiness = STRICT_READINESS_POLICY`; `default-v1` — **отдельным шагом** после зелёного корпуса и приёмки §6 (одна строка, отдельно откатываемая).
- `CaptureComponent.tsx`/`CaptureSurface.tsx`: проброс `bootstrap.fonts` в `settleSurface`.

**Файлы.** Новые: `src/capture/stability.ts` (+тест). Изменяемые: `src/capture/{readinessPolicy.ts,readiness.ts,protocol.ts,CaptureComponent.tsx,CaptureSurface.tsx}`, `server/screenshot/service.ts`, `server/acceptance/{policies.ts,gates/readiness.ts}`, contracts/openapi/sdk, `docs/server-api.md`.
**Done.** K3: e2e `e2e/preview/capture-strictness.spec.ts` на фикстурах корпуса — «нет font asset» ⇒ `font_face_missing` (не fallback-кадр с вердиктом), «битый `<img>`» ⇒ `image_load_failed`, «поздняя мутация» ⇒ `layout_unstable` за ≤3 попытки; unit «политика v1 даёт тот же `policyHash`, что до волны» (нулевой регресс интерактива); unit на variable-шрифт с `weight: "400 700"` — `check()` истинен, ложного `font_face_missing` нет; `verify`.
**Флаг.** Env не нужен (строгость — политикой профиля, N10).

### R5 — Capture receipt на обоих каналах доставки

**Объём.**
- `src/capture/receipt.ts`: `CaptureReceipt` (`receiptVersion: 1`):
  ```
  renderer      { …rendererDeclaration, provenance, observedBrowserVersion, drift: CaptureCode[] }
  target        { kind, componentId|prototypeId, version|rev, sourceHash?, bundleHash, dsMetaVersion, propsHash }
  resources     { fontManifestHash, fontFaces[{family,weight,style,assetId,sha256,status,checked}],
                  images[{url,assetId,naturalWidth,naturalHeight,decoded}], themeResources }
  console       { errors[], warnings[], pageErrors[] }   // существующие лимиты
  output        { viewport, dpr, colorScheme, pngWidth, pngHeight, pngSha256, surfaceRect, paintMargin? }
  timings       { navigateMs, fontsMs, imagesMs, networkMs, framesMs, stabilizeMs, screenshotMs, totalMs }
  verdict       { captureClean, codes: CaptureCode[], readinessMet, readinessPolicyHash }
  ```
- Тайминги: `collectReadiness` уже меряет `elapsedMs` — разбивается на фазы; `navigateMs`/`screenshotMs` меряет воркер.
- `server/capture/receiptStore.ts`: `.receipts/<sha[0:2]>/<sha>`, `putReceipt`/`readReceipt`, свипер (TTL 7 суток, потолок 64 МБ, LRU по mtime, GC on start + on write — канон `gcCandidates`/`gcEvidence`).
- Сборка в `ScreenshotService.execute` **до** ветвления по kind; `receiptSha256` во **всех** результатах (`image`, `image-bytes`, `paint`, `geometry`); `GET /api/screenshot-jobs/:id` отдаёт `receiptSha256`, `GET /api/capture-receipts/:sha256` — документ (owner/admin; acceptance — только runId-scoped, инвариант W1a не ослабляется).
- Acceptance: `render`/`paint`-гейты кладут `receipt.json` в CAS рядом с `readiness.json` и включают его sha в per-run манифест (P1.1).

**Файлы.** Новые: `src/capture/receipt.ts`, `server/capture/receiptStore.ts` (+тесты), роут в `server/routes/screenshots.ts`. Изменяемые: `scripts/screenshot-worker.mjs` (тайминги, `surfaceRect`, `pngSha256`), `server/screenshot/service.ts`, `server/acceptance/gates/{render,capture}.ts`, `server/acceptance/evidence.ts`, contracts/openapi/sdk, `docs/server-api.md`.
**Done.** unit: receipt детерминирован по входу кроме `timings`/`provenance.builtAt`; свипер не удаляет receipt, на который ссылается живой job-результат или CAS-манифест; e2e: интерактивный `snap` (asset-путь!) возвращает `receiptSha256`, receipt содержит `renderer` и `fontFaces` — закрытие дыры §1.6; замер прироста диска на 200 капчурах; `verify`.
**Флаг.** Kill-switch `EASYUI_CAPTURE_RECEIPTS_DISABLED=1` (дефолт — включено).

### R6 — Cross-renderer guard на визуальных эталонах (миграция v27)

**Объём.**
- **Миграция v27** (единственная, только `ADD COLUMN`, без FK): `visual_references` += `renderer_fingerprint TEXT NULL`, `renderer_json TEXT NULL`, `font_manifest_hash TEXT NULL`, `receipt_sha256 TEXT NULL`, `renderer_recorded_at TEXT NULL`; `visual_runs` += `renderer_guard TEXT NULL`, `outcome_code TEXT NULL`, `candidate_receipt_sha256 TEXT NULL`, `reference_receipt_sha256 TEXT NULL`.
- Запись рендерера на эталон **в момент создания**: `VisualRepo.upsertReferencePrivileged` получает опциональный renderer-блок (источник — receipt капчура-родителя). Для `POST /api/prototypes/:id/visual-baselines` (клиентский `assetId`) рендерер **неизвестен** → NULL, честно.
- `VisualService.beginCheck` до диффа: `compareRenderers(reference, candidateReceipt)` → `matched | mismatch | unknown`:
  - `unknown` (legacy) → advisory: ран идёт как обычно, `warnings: ["renderer_unknown"]` + рекомендация переснять эталон;
  - `mismatch` → терминализация **без процента**: `status='error'`, `outcome_code='renderer_mismatch'`, `renderer.differing: […]`, ремедиация «переснять baseline» / «запустить совместимый рендерер»;
  - `matched` → обычный путь.
- Приёмка: guard уже закрыт R1 (renderer в `case_fingerprint`); добавляется **проверка физической согласованности** — при reuse строки `acceptance_case_results` сверяется `receipt.renderer.rendererFingerprint` артефакта с текущим; расхождение ⇒ пересъёмка.

**Файлы.** Изменяемые: `server/migrations.ts` (v27 + комментарий-инвариант), `server/visual/{repo.ts,service.ts,baselines.ts}`, `server/acceptance/runner.ts`, contracts/openapi/sdk, `docs/server-api.md`.
**Done.** unit: legacy-эталон (NULL) → `unknown` + pass/fail по метрикам как раньше (**нулевой регресс прода**); эталон ≠ кандидат → `error/renderer_mismatch` с непустым `differing[]`; миграция v27 на копии прод-БД, `SELECT *`-потребителей нет; e2e `e2e/preview/renderer-guard.spec.ts`; `verify`.
**Флаг.** `EASYUI_RENDERER_GUARD_DISABLED=1` (аварийный). После R6 разрешается включать `EASYUI_RENDERER_FLAGS` на проде.

### R7 — Разделение метрик + diagnostic bundle

**Объём.**
- `scripts/visual-diff-worker.mjs`: edge-маска (Sobel по эталону, дилатация 1px), разделение остатка на inside/outside, `edgeResidual.pct`; нормализация размеров W5a переиспользуется, новой не пишем.
- `server/visual/service.ts`: вердикт E6; `RunReport` += `signals: {dimensions, exact, perceptual, edgeResidual}` и `class: "identical"|"renderer_residual"|"regression"|"indeterminate"`; причина — из `server/visual/causes.ts` (W5b), классификаторы не дублируются.
- `dimensionMismatch` перестаёт быть `error` без метрик: нормализация → метрики, несводимость → `indeterminate`.
- `GET /api/visual-runs/:runId/bundle.zip` (P1.5): `reference.png`, `candidate.png`, `diff-perceptual.png`, `diff-exact.png`, `edge-mask.png`, `reference-receipt.json`, `candidate-receipt.json`, `geometry.json` (если есть), `report.json`, `SHA256SUMS`. `fflate/zipSync` + `zipResponse` + `sanitizeEvidenceName`, потолок `evidenceMaxBytes`, фиксированный mtime.

**Файлы.** Изменяемые: `scripts/visual-diff-worker.mjs`, `server/visual/{diff-runner.ts,service.ts,repo.ts}`, `server/routes/visual.ts`, contracts/openapi/sdk, `docs/server-api.md`.
**Done.** unit на синтетических парах: «сдвиг 1px текста» ⇒ `renderer_residual`, «badge на 4px» ⇒ `regression/geometry-shift`, «изменён fill» ⇒ `regression/surface-tint`; инвариант «класс `renderer_residual` не может скрыть регрессию вне edge-маски»; **замер K5** на семье `pay-payment-card`; `verify`.
**Флаг.** `EASYUI_VISUAL_SIGNALS_V2=1` (opt-in): переклассификация меняет вердикты существующих прод-ранов.

### R8 — Один рендерер: убрать локальный браузер из `shoot`

**Объём.** (Замок драйвера; параллелится с R5–R7.)
- `driver.mjs`: `shoot` больше **не** делает `chromium.launch()`; становится алиасом `snap --all-screens` (серверный путь с handshake, readiness и receipt). Escape-hatch `--local-browser` **не** сохраняется.
- `--receipt <file.json>` у `snap`/`preview`; `--json` печатает `receiptSha256`, `renderer.rendererFingerprint`, `codes[]`.
- Предполётная сверка: клиент читает `capabilities.renderer`, предупреждает при попытке сравнивать локальный PNG с серверным.
- `docs/server-api.md` + `SKILL.md`: рецепт офлайн-съёмки `docker run --rm ghcr.io/vladprrs/easy-ui:<sha> …` на том же образе.
- `scripts/sync-share-skills.mjs` — синк зеркал в конце волны.

**Файлы.** `.claude/skills/author/driver.mjs` + зеркала (через sync), `.claude/skills/*/SKILL.md`, `test/driver-*.test.ts`, `docs/server-api.md`.
**Done.** grep: `chromium.launch` в драйвере и зеркалах отсутствует; K2: фикстура через `driver.mjs snap` и корпус в контейнере — `exact-rgba = 0`; drift-чек зеркал; `verify`.

### R9 — P2: пул, кэш, режимы (подволны последовательны)

**R9a — тёплый пул воркеров.**
`scripts/screenshot-pool-worker.mjs` — долгоживущий процесс, NDJSON-протокол (существующий `screenshot-worker.mjs` остаётся каноном strict-режима, не трогается). Один `browser`, новый `BrowserContext` на джобу, `context.close()` обязателен. Тонкости из кода: `--proxy-server`/`--proxy-bypass-list` — **launch**-аргументы ⇒ deny-proxy долгоживущий, порты фиксируются на жизнь браузера; смена `captureOrigin` ⇒ ресайкл. Ресайкл: N джоб (20), TTL, порог RSS, всегда после не-`ok` `jobOutcome`. `worker-runner.ts` получает второй `RunJob`-имплемент, выбор — `EASYUI_RENDERER_POOL`.
**Done.** K7: `scripts/measure-capture.mjs` — cold/warm p95 на 49 cases, RSS через `docker stats`, сравнение с 1,96 с/case family-плана; тест «контекст не течёт» (cookie/localStorage/bootstrap предыдущей джобы недоступны); тест «egress-граница сохранена в пуле» (дословные args + route-allowlist); повтор корпуса R2 под пулом даёт те же sha256; `verify`.
**Флаг.** `EASYUI_RENDERER_POOL=1`, прод OFF до замера (N9).

**R9b — content-addressed кэш не-acceptance путей.**
`server/capture/captureCache.ts`: ключ `sha256({rendererFingerprint, expected (handshake-снимок), propsHash, surface{viewport,dsf,theme}, readinessPolicyHash, probe, deliver, paintMargin, fontManifestHash})`. Хранилище `<dataDir>/.capture-cache/<sha[0:2]>/<sha>/{png,receipt.json,geometry.json}`, LRU по mtime, потолок байт, GC on start/on write. Asset-путь кэширует `assetId` (повторный `ingest` дедуплицируется по sha256). Ответ несёт `cache: {status: "hit"|"miss"|"bypass", key, reason}`. Acceptance кэш **не использует** (E7). `--refresh` в драйвере ⇒ `bypass`.
**Done.** K6: повторный `snap` → `hit` и ноль запусков воркера (счётчик); «смена темы/DPR/props/рендерера — всегда miss»; «кэш не отдаёт кадр без receipt'а»; `verify`.
**Флаг.** `EASYUI_CAPTURE_CACHE=1` (opt-in).

**R9c — режимы capture в API.**
`mode: "preview"|"verify"|"baseline"|"diagnostic"` на screenshot-ручках; `server/capture/modes.ts#resolveCaptureMode` становится публичным контрактом; `capabilities.limits.captureModes`. `preview` — дефолт, текущее поведение (нулевой регресс); `verify` — strict policy + receipt; `baseline` — verify + `cache:"bypass"` + запись renderer-полей на эталон; `diagnostic` — verify + geometry-сигнал + расширенные артефакты.
**Done.** e2e на каждый режим; «`preview` побайтово повторяет доволновое поведение»; `driver.mjs snap --mode verify`; `verify`. (Замок драйвера: R9c не параллелится с R8.)

---

## 5. Владение файлами и параллелизм

| Файл | Волны | Правило |
|---|---|---|
| `server/migrations.ts` | R6 (v27) | строго серийный; единственная миграция пакета |
| `server/capture/renderer.ts`, `rendererPin.json` | R1 (создание), R2 (флаги в хеш) | серийно |
| `scripts/screenshot-worker.mjs` | R2, R3, R5 | **серийно**; `buildLaunchArgs` — дословно тестируемая функция, сигнатуру не трогать |
| `scripts/screenshot-pool-worker.mjs` | R9a | эксклюзив; strict-воркер не трогается |
| `server/screenshot/service.ts` | R1, R3, R4, R5, R9a/b | серийно; владелец — текущая волна |
| `src/capture/{readiness.ts,readinessPolicy.ts,protocol.ts}` | R3, R4 | серийно; R3 перед R4 |
| `src/capture/{failureCodes.ts,stability.ts,receipt.ts}` | R3 / R4 / R5 | новые файлы, эксклюзив волны-создателя |
| `src/capture/{CaptureComponent.tsx,CaptureSurface.tsx}` | R4 | эксклюзив |
| `server/acceptance/ids.ts` | R1 | **эксклюзив**; единственный bump `CASE_FINGERPRINT_ALGO_VERSION` |
| `server/acceptance/{policies.ts,gates/**,runner.ts}` | R3, R4, R5, R6 | серийно; новые гейты не вводятся |
| `server/visual/**`, `scripts/visual-diff-worker.mjs` | R6, R7 | эксклюзив; R6 перед R7 |
| `server/capture/{receiptStore.ts,captureCache.ts,modes.ts}` | R5 / R9b / R9c | эксклюзив |
| `server/contracts.ts`, `server/openapi.json`, SDK | почти все | аддитивно; в конце волны `generate:openapi` **и** `generate:sdk` + drift-чеки; сгенерированное не правится руками |
| `server/main.ts`, `server/routes/meta.ts` | R1, R5, R7, R9c | append-only; конфликт решает волна с бóльшим номером |
| `docs/server-api.md` | R0–R9 | append-only по секциям волны |
| `.claude/skills/*/driver.mjs` + зеркала + `sync-share-skills.mjs` | R8, R9c | «замок драйвера»: одновременно правит одна волна |
| `Dockerfile`, `docker-compose.yml`, `.github/workflows/**` | R0, R2 (CI-job) | эксклюзив |
| `playwright.config.ts` | R2 | эксклюзив |
| `e2e/fixtures/renderer-corpus/**`, `scripts/renderer-corpus.mjs` | R2 | эксклюзив; `expected.json` обновляется только вместе с bump'ом `RENDERER_VERSION` |

**Параллельные пары:** (R5 ‖ R8), (R6 ‖ R8), (R7 ‖ R8). Пара (R8 ‖ R9c) **запрещена** (обе правят драйвер). R2/R3/R4 не параллелятся между собой (общий воркер и `readiness.ts`). Всё остальное — последовательно.

---

## 6. Верификация

**Инженерный гейт каждой волны:** `npm run verify` (включая openapi+sdk drift и новый `verify:renderer`) + целевые e2e-спеки; все capture-зависимые спеки — в `e2e/preview/` (dev-проект не поднимает `SERVE_DIST`). `npm run e2e` целиком — перед закрытием пакета.

**Runtime-приёмка (по `.claude/skills/verify`), до включения `EASYUI_RENDERER_FLAGS`/`EASYUI_VISUAL_SIGNALS_V2` на проде:**
1. `GET /api/capabilities` на проде отдаёт секцию `renderer` с `browserVersion`/`browserRevision`/`browserExecutableSha256`, совпадающими с `docker run <image> cat /app/renderer-manifest.json`.
2. Интерактивный `driver.mjs snap` (asset-путь) возвращает `receiptSha256`; `GET /api/capture-receipts/:sha` — документ с `renderer`, `fontFaces` (все `checked:true`), `timings`, `surfaceRect`. Визуальное подтверждение закрытия §1.6.
3. Фикстура «нет font asset» на `verify`-режиме ⇒ `font_face_missing`, кадр без вердикта; «битое изображение» ⇒ `image_load_failed`; «поздняя мутация» ⇒ `layout_unstable` (K3, K4).
4. Корпус: `docker run <prod-image> node scripts/renderer-corpus.mjs --verify` — hard-гейт зелёный (K1); тот же корпус локально — сравнение с CI (K2), факты — в план.
5. Legacy-эталон прода (NULL renderer-колонки) через `POST /api/visual-references/:id/check` — вердикт как до пакета плюс `warnings:["renderer_unknown"]`; **ни один существующий прод-ран не сломался**.
6. Включение `EASYUI_RENDERER_FLAGS=1` → тот же эталон даёт `renderer_unknown` + изменившийся процент; переснятый эталон получает `renderer_fingerprint` и `matched`; сравнение старого с новым ⇒ `error/renderer_mismatch` с `differing[]`.
7. `POST /api/acceptance-runs` на кандидате прошлого пакета: reuse **не** сработал (bump 4→5), холодный ран в бюджете §4 family-плана; повторный — `reused: N/N`.
8. Диск: `.receipts/` и `.capture-cache/` не растут сверх потолков после 500 капчуров; свипер отработал (`du` в отчёте).
9. Миграция v27 — на копии прод-БД; чек-лист отката: старый код не читает новые колонки, `.receipts/`/`.capture-cache/` при откате не растут, `EASYUI_RENDERER_FLAGS` снимается одной правкой env без пересборки.

---

## 7. Явные не-цели

- **Отдельный `ghcr.io/vladprrs/easy-ui-renderer` image** (N3): идентичность — манифест + пин + drift-чек, не второй образ.
- **Renderer в ключе `visual_references.fingerprint_json`** (N6): identity эталона поверхностная; renderer — атрибут + guard.
- **Новый статус в `visual_runs.status`** (N7): типизированный код едет колонкой `outcome_code`.
- Точный ICC-профиль в env-fingerprint — best-effort, деградация до `colorSchemeOnly` (наследие family-плана §8).
- Автопереснятие эталонов, lifecycle exceptions, promotion baseline'ов, VDC 2.0 целиком.
- Гейты `regression`/`interactions` (RFC R4+).
- Golden-PNG в git: только `sha256` в `expected.json`.
- Фиксация `Math.random`/js-seed (маскирует недетерминированный компонент).
- Пул и capture-кэш по умолчанию на проде (opt-in до замеров).
- `--deterministic-mode` — только если корпус R2 без него не даёт K1.
- Кэширование acceptance-путей новым кэшем (у них reuse по `case_fingerprint`, E7).
- Geometry-сигнал для `prototype-screen`-scope визуальных ранов (N8).

---

## 8. Риски

| Риск | Sev | Митигация |
|---|---|---|
| Включение флагов R2 обесценивает все прод-эталоны `visual_references` | high | `EASYUI_RENDERER_FLAGS` opt-in; жёсткий порядок — guard (R6) **раньше** включения флагов; `unknown` не блокирует; прямая ремедиация «переснять baseline» в `RunReport` |
| Cross-host байт-идентичность (K2) не достигается даже с `--disable-skia-runtime-opts` | high | двухуровневый гейт R2 (hard внутри контейнера / soft cross-host); при провале soft — публикуем ppm и переводим K2 в «≤N ppm, только edge-маска», не ослабляя hard |
| OOM `mem_limit: 1g` от постоянного браузера пула | high | пул opt-in, прод OFF до замера RSS; ресайкл по N/TTL/RSS; правило «один тяжёлый подпроцесс» из §4.6 family-плана сохраняется |
| Диск: `.receipts/` + `.capture-cache/` на прод-volume | high | TTL + байтовые потолки + GC on start/on write; замер на 500 капчурах в приёмке; kill-switch на receipt'ы |
| `document.fonts.check()` даёт ложный `font_face_missing` на variable-шрифтах (`weight: "400 700"`) | med | `check()` — авторитет, `status` — подтверждение; нормализация веса к диапазону; unit-фикстура с variable-шрифтом в корпусе |
| Строгие шрифты ломают темы, где face объявлен хромом, а не темой | med | критерий на `check()` (источник-агностичен), не на наличии `FontFace` из темы (`fontRegistry.ts` пропускает «YS Text»); e2e на `yandex-pay` |
| `layout_unstable` ложно срабатывает на субпиксельном джиттере | med | округление rect до 1/64 px; ≤3 попытки; фикстура «стабильный компонент × 100 капчуров, 0 срабатываний» |
| Реклассификация R7 превращает `fail` в `pass/renderer_residual` и скрывает регрессию | med | `EASYUI_VISUAL_SIGNALS_V2` opt-in; инвариант «остаток вне edge-маски не даёт `renderer_residual`»; классификация не меняет метрики, только класс |
| Пул течёт состоянием между джобами | med | `context.close()` обязателен, ресайкл по счётчику; тест-инвариант cookie/localStorage/bootstrap; egress-args дословно |
| Кэш отдаёт устаревший кадр (что-то не вошло в ключ) | med | opt-in; ключ включает полный handshake-снимок + `fontManifestHash` + renderer + policy; `baseline` всегда `bypass`; receipt пишется всегда |
| Апгрейд playwright/chromium пролетает мимо ревью | med | `rendererPin.json` + `verify:renderer` в verify и CI; playwright пиннут точно |
| Сверка объявленного/наблюдённого слишком жёсткая и валит прод | med | hard-fail **только** на `browser.version()` ≠ манифест (внутренняя несогласованность образа); UA/gamut/dpr — warning `renderer_env_drift` |
| Удаление локального браузера в `shoot` ломает отладочный сценарий | low | `shoot` = `snap --all-screens`; отладка живого плеера — в playwright-спеках; задокументировано в SKILL.md |

---

## 9. Сводка по флагам

| Флаг | Волна | Дефолт dev/CI | Дефолт прод | Снятие |
|---|---|---|---|---|
| `EASYUI_RENDERER_FLAGS` | R2 | ON | OFF → ON после приёмки §6.6 | после переснятия эталонов |
| `EASYUI_CAPTURE_RECEIPTS_DISABLED` | R5 | не задан | не задан (включено) | остаётся kill-switch'ем |
| `EASYUI_RENDERER_GUARD_DISABLED` | R6 | не задан | не задан (включён) | остаётся kill-switch'ем |
| `EASYUI_VISUAL_SIGNALS_V2` | R7 | ON | OFF → ON после приёмки | после приёмки |
| `EASYUI_RENDERER_POOL` | R9a | ON | OFF (N9) | после замера RSS |
| `EASYUI_CAPTURE_CACHE` | R9b | ON | OFF | после приёмки K6 |
| `EASYUI_IMAGE_REF` | R0 | не задан | из Dokploy (advisory) | — |

Все переменные пробрасываются в `docker-compose.yml` **в R0** (канон W0 family-плана: флаг, отсутствующий в compose, = отсутствующий аварийный выключатель).
