# План: Renderer Contract 2.0 — детерминированный capture, receipt, cross-renderer guard, пул и кэш

Дата: 2026-08-03. Версия: **v3** (Stage 2 пройден: раунд 1 — 3 адверсариальных ревьюера [корректность/код, скоуп/декомпозиция, риски/эксплуатация], раунд 2 — верификационный; триажи — §11; поправка пользователя по ресурсам прода — §2.2 N9/R0).
Источник требований: `docs/EASYUI_RENDERING_IMPROVEMENTS.md` (P0.1–P0.5, P1.1–P1.5, P2.1–P2.3, «Метрики успеха»).
База: план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md` **полностью закрыт** (W0–W9), RFC `2026-08-02-candidate-acceptance-pipeline-rfc.md` v5 (R1 в проде, R2 исполнен волнами family-плана).

> Этот план — **дельта** поверх посаженного состояния. Он не переоткрывает решения family-плана (D4 paint-режим, D5 readiness-политика, A4 CAS-evidence, D1 `case_fingerprint`), а достраивает то, что там было объявлено не-целью: полный renderer fingerprint, строгость ресурсов, типизированные коды, receipt, cross-renderer guard, разделение метрик, пул и кэш.

> Очередь исполнения: **R0** → **R1** → **R2a** → **R2b** → **R2c** → **R3** → **R4** → **R5** → **R6** → **R7a/R7b**; **R8a** параллелится с R5–R7, **R8b** — строго после R5; **R9a/R9b** (P2) — после R7. Единственная миграция пакета — в R6 (следующий свободный номер; v27 занят волной R3a RFC candidate-acceptance — component_provenance/candidate_decisions, 2026-08-03). Прод-включение флагов — только в порядке §7 (guard раньше пикселей, инвентаризация эталонов раньше guard'а).

---

## 1. Задача и цели

Сегодня два одинаковых по DOM/CSS компонента дают `exact-rgba 0,6974%` / `perceptual 0,2870%` разницы, кластеры — вокруг текста и badge, геометрия совпадает. Причина не в компоненте: **capture не является функцией объявленных входов**. Конкретно, по коду:

1. `scripts/screenshot-worker.mjs#buildLaunchArgs` не передаёт флагов растеризации. Уточнение по факту (Stage 2, C-M2): `--force-color-profile=srgb` и `--hide-scrollbars` playwright 1.61.1 **уже передаёт сам** (`chromiumSwitches()` в playwright-core) — открытыми остаются хинтинг, субпиксельное позиционирование, LCD-текст, partial-raster и Skia runtime-opts; именно они, а не цветовой профиль, дают cross-host расхождение растра;
2. `rendererBuild` — это **имя entry-файла SPA** (`server/screenshot/allowedUrls.ts#rendererBuildFrom` читает `dist/.vite/manifest.json`), то есть идентичность бандла, а не рендерера; про chromium/шрифты/ОС он не говорит ничего;
3. серверный `captureEnvFingerprintOf(readinessPolicyHash)` (`server/acceptance/ids.ts`) — это `sha256({algoVersion:1, process.platform, process.arch, readinessPolicyHash})`. **Апгрейд chromium его не меняет** → reuse `acceptance_case_results` по `case_fingerprint` переживает смену рендерера. Это дыра приёмки, а не косметика;
4. `src/capture/readiness.ts#settleFonts` осознанно не валит capture на `FontFace.status === "error"` и не проверяет ни одного конкретного `weight/style`; `settleImages` валит только при полном отсутствии растра; `settleFrames` ждёт N rAF, но **не перемеряет** — доказательства покоя layout нет;
5. причины неуспеха — ad-hoc строки, склеенные запятой (`"fonts_timeout,images_failed"`); типизированного словаря нет, `JobOutcome` не выходит наружу по HTTP;
6. `CaptureReadinessOutcome` едет **только** на байтовых доставках (`deliver:"bytes"`, `probe:"paint"`). Asset-путь — интерактивный `snap`, кандидатный кадр `VisualService` — не получает ни readiness, ни env, ни таймингов: визуальные раны прода судят кадры, о происхождении которых не знают ничего;
7. `server/visual/fingerprint.ts` не содержит ни одного renderer-поля: baseline и кандидат, снятые разными рендерерами, сравниваются как обычная визуальная регрессия;
8. `.claude/skills/author/driver.mjs` verb `shoot` (строка ~2186, продублирован в двух share-зеркалах) поднимает **собственный локальный chromium** без handshake и readiness — второй рендерер в продукте;
9. **факт растрового пути (Stage 2, C-B1)**: `chromium.launch({headless:true})` исполняет `chrome-headless-shell`, а `chromium.executablePath()` возвращает бинарь `chrome-linux64/chrome`, который **не рендерит** — любая идентичность рендерера обязана строиться от фактически запускаемого бинаря.

**Цель пакета.** Сделать capture воспроизводимой функцией `PNG = render(document snapshot, renderer fingerprint, resource manifest, capture options)`: объявленный и проверяемый рендерер, строгие ресурсы, доказанная стабильность layout, один машиночитаемый receipt на оба канала доставки, и явный отказ сравнивать кадры разных рендереров.

### KPI (метрики успеха документа) и как меряем

| № | Метрика документа | Baseline (факт) | Цель | Инструмент измерения | Волна |
|---|---|---:|---:|---|---|
| K1 | Повторные capture одного входа дают `exact-rgba = 0` | не измерялось | **0 расхождений на 240** (12×20) в CI + 0 на ночном прогоне ≥3000; честная оговорка: 240 капчуров статистически подтверждают ~1% при 95% CI, «99,9%» доказывает только ночной объём | `scripts/renderer-corpus.mjs` | R2b/R2c (гейт), R9a (перепроверка с пулом) |
| K2 | Локальный и server capture в одном image совпадают полностью | недостижимо: `shoot` = отдельный локальный chromium | **две части (V-N11)**: cross-host детерминизм — `exact-rgba = 0`, фолбэк-порог **≤50 ppm суммарно** (вердикт — done R2c; edge-квалификация остатка — после R7a, когда маска существует); local-vs-server в одном image — done R8b | корпус: `docker run <image> … corpus:verify` локально и в CI, артефакт CI (`upload-artifact`), сверка `expected.json` | R2c (cross-host) + R8b (local-vs-server) |
| K3 | Ни один strict capture не проходит с fallback-шрифтом/битой картинкой | проходит | 0 — для captures с темой, объявляющей шрифты; для ДС без темы (`fonts: []`) строгость вырождается в v1-семантику — **честно записано** | unit на `collectReadiness` + e2e-фикстуры → `font_face_missing`/`image_load_failed` | R4 |
| K4 | Причина неуспеха определяется без ручного просмотра PNG | только `capture_failed` + строка | 9 типизированных кодов на всех путях | контракт `captureFailureCode`, тест «каждый код достижим фикстурой» | R3 + R4 + R6 |
| K5 | Медианное число итераций component → verified screenshot | **замер «до» — в R0** (журнал `driver.mjs` на текущей семье; «10+» документа — риторика, не факт) | дельта «до/после» на ≥3 семьях при включённых флагах | журнал capture-запросов до зелёного вердикта | R0 (baseline), R7b (после) |
| K6 | Повторный запрос с тем же cache key не запускает chromium | нет кэша вне acceptance | 100% попаданий на неизменённом входе | `cache:{status,key,reason}` + счётчик спавнов воркера в `ScreenshotService` (тестовый seam `deps.runJob`) | R9b |
| K7 | p95 verify capture измеряется отдельно для cold и warm | нет разделения | опубликованные числа в §4 | `scripts/measure-capture.mjs` (канон `measure-acceptance.mjs`), 49-кейсовая семья | R9a/R9b |
| K8 | (инженерный инвариант, добавка плана) Reuse приёмки не переживает апгрейд chromium | переживает (дыра §1.3) | 0 переживших | unit: подмена версии/sha **фактически запускаемого** бинаря → `case_fingerprint` изменился | R1 |

---

## 2. Поправки и решения (триаж гипотез постановки)

### 2.1. Принято с уточнениями

**P1. Флаги запуска** (сверено: `buildLaunchArgs` дословно тестируется `server/screenshot-worker.test.ts:7` — детерминизм-флаги выносятся отдельной функцией). Факты Stage 2: `--force-color-profile=srgb` и `--hide-scrollbars` уже передаёт playwright (no-op как изменение, но **дублируются явно** в `buildDeterminismArgs()` — они входят в хеш и перестают зависеть от версии playwright); `--font-render-hinting=none` и `--deterministic-mode` существуют **только в headless-shell** (в полном chrome этих switch'ей нет) — сегодня работает, потому что playwright выбирает shell; done R2a включает тест «фактически запускаемый бинарь принимает все детерминизм-флаги» (защита от будущей смены channel/headless).

| Флаг | Вердикт | Обоснование |
|---|---|---|
| `--force-color-profile=srgb` | **дублировать явно** | уже передаёт playwright; в `buildDeterminismArgs()` — чтобы входил в хеш и не зависел от playwright |
| `--hide-scrollbars` | **дублировать явно** | то же |
| `--disable-skia-runtime-opts` | **включить** | бьёт по реальной причине cross-host расхождения: Skia выбирает SIMD-пути по CPUID. Без него K2 недостижим. Плата — раствор медленнее; замер в R2c |
| `--font-render-hinting=none` | **включить** | снимает зависимость от fontconfig/FreeType; headless-shell-only — покрыто тестом R2a |
| `--disable-font-subpixel-positioning` | **включить** | позиция глифа перестаёт зависеть от субпиксельного origin (фикстура «текст на дробных координатах») |
| `--disable-lcd-text` | **включить** | явное лучше неявного |
| `--disable-partial-raster` | **включить** | растр перестаёт зависеть от истории инвалидации тайлов |
| `--js-flags=--random-seed=…` | **отклонить** | не влияет на растр; замаскировал бы недетерминированный компонент, который обязан ловить гейт `determinism` |
| `--deterministic-mode` / `--run-all-compositor-stages-before-draw` | **отложить (опция R2c)** | меняет модель кадра; только если корпус без них не даёт K1 |

**P4. Строгие шрифты.** Обязательные faces выводимы из темы: `themeFontSchema = {family, src, weight?, style?}` (`server/contracts.ts:516`) — **`assetId` и `sha256` в схеме отсутствуют**: `assetId` парсится из `src` (`/api/assets/<id>`), sha — из формата id `asset_<sha256>` (канон `server/assets.test.ts:82`); это явный пункт объёма R4. Правило required (T-M10): **required = faces темы, чьё family наблюдено в used-faces** (пересечение с W4-evidence) — тема может объявлять шрифты, которые компонент не использует, требовать их загрузки нельзя. ДС без темы (`getLatestDesignSystemContent` → `emptyTheme()`, `fonts: []`) → строгость вырождается в v1-семантику; face, объявленный хромом, а не темой («YS Text» в `fontRegistry.ts`), ловится `check()`-критерием.

**P5. Стабилизация layout** — после frames-settle, ≤3 попыток, код `layout_unstable`.

**P6. Типизированные коды** сквозь воркер → сервис → гейты → HTTP + openapi; `JobOutcome` выставляется наружу.

**P7. Receipt на оба канала** — принят; хранение: acceptance — существующий CAS (`putArtifact`); не-acceptance — **новый маленький CAS-стор** `<dataDir>/.receipts/` с TTL 7 суток, потолком 64 МБ и **пин-провайдером** (см. R6: receipt'ы, на которые ссылается `visual_references.receipt_sha256`, не вытесняются — канон `candidatePins`/`gcCandidates`). Ассет-стор для receipt'ов **запрещён** (нет GC — та же причина, что породила A4). Отдельный стор, а не неймспейс acceptance-CAS: семантики GC разные (TTL/LRU против runId-refcount), связывать контуры — новый класс инцидентов (триаж S-m7 отклонён).

**P9. Guard аддитивной колонкой**, legacy-NULL → advisory до включения флагов. Пересмотр по T-B2: baseline-эталон **рождён серверным капчуром** — `driver.mjs runBaseline` ставит `POST …/screenshot`, поллит джобу и кладёт в `PUT /api/visual-baselines/prototypes/:id` (фактический роут) `state.result.assetId`. Сервер обязан резолвить renderer по `assetId → receipt` (индекс R5); NULL остаётся только для PNG, реально залитых клиентом со стороны. Без этого `matched` недостижим и весь guard — мёртвый код.

**P11. Diagnostic bundle** для визуальных ранов — аналог acceptance-zip: `fflate/zipSync` + `zipResponse` + `sanitizeEvidenceName`.

### 2.2. Отклонено / переформулировано

**N1 (blocker гипотезы). `dockerImageDigest` не может быть входом renderer fingerprint.**
Технически: digest известен только **после** push'а, внутрь образа не попадает. Смыслово: digest меняется на **каждом коммите** — правка `docs/*.md` обнуляла бы весь reuse и помечала каждый эталон как cross-renderer.
**Замена: build-time renderer manifest.** В `Dockerfile` после `playwright install` и `npm run build` генерируется `/app/renderer-manifest.json` (`scripts/renderer-manifest.mjs`):

```jsonc
{
  "manifestVersion": 1,
  "rendererVersion": "r2",                 // константа репозитория, растёт руками
  "os": "linux", "arch": "x64",
  "nodeVersion": "24.x.y",                 // воркер живёт под node, не под bun
  "playwrightVersion": "1.61.1",           // require("playwright/package.json").version
  "browserName": "chromium",
  "browserVersion": "…",                   // ПРОБОЙ: chromium.launch() → browser.version() в build-слое (C-B1)
  "browserRevision": "…",                  // browsers.json через require.resolve("playwright-core/package.json") — subpath не экспортируется (C-M3)
  "launchedExecutable": "chrome-headless-shell",
  "browserExecutableSha256": "…",          // sha256 ФАКТИЧЕСКИ ЗАПУСКАЕМОГО бинаря (headless-shell); полный chrome — справочно вторым полем
  "fontStackSha256": "…",                  // sha256 обхода /usr/share/fonts + fonts.conf; fc-list в node:24-slim НЕТ (C-M4) — собственный обход, без нового пакета в образе
  "systemLibsHash": "…",                   // dpkg-query по fontconfig/freetype; отсутствие dpkg → null
  "appFontsSha256": "…",                   // sha256 содержимого dist/fonts
  "contextOptionsHash": "…",               // sha256 экспортируемой константы контекста воркера (locale/timezone/reducedMotion) — E1
  "provenance": { "buildSha": "…", "imageRef": "ghcr.io/…:<sha>", "builtAt": "…", "bunVersion": "1.3.14" }
}
```
`provenance` — **вне** хеша. Базовый образ пинуется по digest: `FROM node:24-slim@sha256:…` с ручным bump'ом (канон `rendererPin.json`) — иначе дрейф плавающего тега молча меняет `fontStackSha256`/`systemLibsHash` и красит hard-гейт корпуса на постороннем PR (T-M5). В dev манифест отсутствует → считается на лету **асинхронно на старте процесса** (sha256 бинаря ~1 с — синхронный вызов из `caseFingerprint`-пути запрещён, C-m14), кэшируется; dev-фолбэк не бросает — недоступные поля → `null`, R1-e2e обязана зеленеть и в dev-проекте без `SERVE_DIST`.

**N2 (major). Апгрейд chromium ловится drift-чеком, не отдельным образом.** `playwright` пиннут точно (`"playwright": "1.61.1"`), **`@playwright/test` — с кареткой `^1.58.0` (риск второго playwright-core) — пиннуется точно в R1**; `verify:renderer` сверяет `browsers.json` с `server/capture/rendererPin.json`, проверяет единственность `playwright-core` в lockfile и **падает** при расхождении без ручного bump'а `RENDERER_VERSION`. Апгрейд chromium = PR с явной правкой двух файлов. Дрейф базового образа закрыт пином digest (N1).

**N3 (major). Отдельный `easy-ui-renderer` image — отклонить.**
- один compose-сервис; второй chromium-сервис — новый класс рассинхрона версий при `pull_policy: always`;
- «два рендерера» — проблема **клиента**: серверный capture уже исполняется внутри app image. Убирается локальный chromium в `shoot` — проблема исчезает;
- слой `playwright install --with-deps` ≈ 500 МБ; дублировать его в GHCR ради идентичности, уже обеспеченной манифестом, — плата без выгоды.

**Вместо этого (R8a/R8b):** (а) `shoot` → алиас серверного `snap --all-screens`; (б) рецепт офлайн-съёмки `docker run` на **том же** образе — с автоматической проверкой в done R8b (корпус + `expected.json`), не только докой; (в) `renderer-manifest` отдаётся в `GET /api/capabilities` (секция `renderer`).

**N4 (major). `fontManifestHash` — поле resource manifest, не renderer fingerprint.** Набор шрифтов темы меняется на каждую версию темы; рендерер — нет. Разделение: `fontManifestHash` (тема) — в receipt и guard'е отдельным полем; `appFontsSha256`/`fontStackSha256` (образ) — в renderer fingerprint. `themeVersion` уже входит в `buildFingerprint` → новый вход в `case_fingerprint` не нужен. Область определения `fontManifestHash`: **component-scope и prototype-screen с резолвом ДС экрана на enqueue** (сегодня `enqueuePrototypeFrozen` резолвит `themeContent` только при `opts.probe` — R4 расширяет резолв на все frozen-постановки; мульти-ДС документ → hash по ДС конкретного экрана).

**N5 (major). Bump `CASE_FINGERPRINT_ALGO_VERSION` — ровно один, в R1 (4→5).** R1 меняет **схему** входа ⇒ bump. R2a (флаги) и R4 (строгая политика) меняют **значения** внутри уже входящих хешей ⇒ reuse инвалидируется автоматически без смены схемы. Тест-инвариант: «bump'ов в пакете больше нет». Полный список точек инвалидации и их цена — §4.

> **Отметка (2026-08-04, постфактум).** Инвариант N5 пересмотрен **вне** этого пакета: план
> `docs/plans/2026-08-04-acceptance-pipeline-feedback.md` (решение D-B, волна W1) поднял
> `CASE_FINGERPRINT_ALGO_VERSION` **5→6** — это санкционированный второй bump, и он не отменяет N5.
> Основание: отпечаток случая расслоён на `frameFingerprint` / `comparisonFingerprint` /
> `verdictPolicyHash`, а examples-путь перестал хэшировать заглушку `CASE_POLICY_HASH_V0` вместо
> реального профиля рана, то есть изменилась **схема** входа, а не значения внутри прежней схемы —
> ровно тот критерий, по которому N5 и разрешал bump. Инвариант «в пакете renderer-contract-2
> bump ровно один (4→5, в R1)» остаётся верным: тест-пины версии переехали с литерала `5` на `6`
> (`server/capture/renderer.test.ts`, `server/acceptance/ids.test.ts`), история номера записана в
> комментарии `server/acceptance/ids.ts`. Цена — холодный прод-кэш на первом ране после деплоя
> (≈6 с/case), признана планом 2026-08-04 (§Верификация, C9).

**N6 (major). Renderer fingerprint не входит в `fingerprint_json` таблицы `visual_references`.** `vref_sha256(...)` — PK/UNIQUE, записан в `visual_baseline_sets.members_json`, и `fingerprintSchema` — `z.strictObject` (новое поле = 422). Identity эталона остаётся поверхностной; renderer — **аддитивные атрибуты + guard перед диффом**. `server/visual/fingerprint.ts` пакетом **не трогается** — это осознанно (§8).

**N7 (medium). Новый статус в `visual_runs.status` не вводится.** `CHECK(status IN ('pass','fail','error','reference_missing'))` (`server/migrations.ts:133,260`) — расширение требует rebuild таблицы. Решение: `status='error'` + аддитивные `outcome_code TEXT` (`renderer_mismatch` | `stale_renderer`) и `renderer_guard TEXT`.

**N8 (medium). Geometry-сигнал P1.3 для scope `prototype-screen` — не отдельный прогон.** `probe:"paint"` — component-only; второй capture-прогон ради геометрии на визуальном пути — удвоение стоимости. Четыре сигнала = `dimensions`, `exact`, `perceptual`, `edgeResidual`.

**N9 (пересмотрено по поправке пользователя). Ресурсные лимиты прода — перестраховка; ревизия в R0.** Текущие `mem_limit: 1g` и посылка «1 CPU» унаследованы от family-плана как консервативная закладка — **фактически прод-хост значительно мощнее** (сообщение пользователя, Stage 2). Решение: R0 снимает факт ресурсов хоста (`nproc`, `free -m`, занятость соседями по Dokploy — канон `/deploy`) и **поднимает `mem_limit` (и при подтверждении — `cpus`) в compose** отдельно откатываемой правкой; все ресурсные решения пакета формулируются от нового лимита, а не от 1g:
- пул (R9a): критерий включения — «устойчивый RSS ≤ 75% фактического лимита»; при подтверждённом запасе прод-дефолт пула может стать ON по результату замера, а не «OFF навсегда»;
- правило family-плана «один тяжёлый подпроцесс» пересматривается в R9a от фактических ресурсов (при ≥2 CPU diff/ink-подпроцессы могут идти параллельно capture — измеряемая опция);
- поднятие конкуренции capture (сегодня жёстко 1 в `ScreenshotService`) — измеряемая опция R9a при ≥2 CPU.
Пока факт не снят, план консервативно оперирует текущими лимитами.

**N10 (minor). Строгость включается политикой, а не env-флагом.** `pixel-strict-v1` получает `STRICT_READINESS_POLICY` (v2) в R4; `default-v1` переключается отдельным откатываемым шагом. Интерактивные пути остаются на `DEFAULT_READINESS_POLICY` v1.

**N11 (новое, T-B1; доопределено V-N5). Переходная семантика guard'а при включении флагов.** Порядок «guard (R6) раньше флагов» сам по себе не защищает **существующие** эталоны: они `unknown` (advisory) — включение флагов дало бы не «mismatch с ремедиацией», а массовый ложный fail по проценту (и падение `driver.mjs runCheck` во всех скиллах). Решение: понятие **эпохи рендерера**. Полная семантика:
- эпоха по умолчанию = `manifest.rendererVersion` (env `EASYUI_RENDERER_EPOCH` — только **override** для нештатных случаев; забытый bump env не может уронить прод — V-N5d); self-check на старте + поле в `/api/health`;
- при `EASYUI_RENDERER_FLAGS=1`: ран с эталоном `unknown` или другой эпохи ⇒ `status='error'`, `outcome_code='stale_renderer'` (без процента, ремедиация «переснять»); при выключенных флагах `unknown` остаётся advisory;
- `EASYUI_RENDERER_EPOCH` без `EASYUI_RENDERER_FLAGS` — **игнорируется** (эпоха осмыслена только при новых пикселях), self-check пишет warning;
- приоритет кодов: расходятся и fingerprint, и эпоха ⇒ `renderer_mismatch` (более специфичный);
- in-flight раны: guard читает **снапшот флагов, взятый на `beginCheck`** — ран, стартовавший до флипа, доигрывается по старой семантике;
- dev/CI: включение эпохи на R6 делает stale все dev/e2e-эталоны, созданные до неё — их пересъёмка входит в done R6 (по аналогии с инвентаризацией R2a).
Предпосылка прод-включения — инвентаризация и массовое переснятие эталонов инструментом `scripts/rebaseline-all.mjs` (R6) в maintenance-окно, **разнесённое** с холодной пересъёмкой приёмки после R1 (§4).

**N12 (новое, T-B3). Ручки receipt «по sha» нет.** `server/routes/acceptance.ts:26` фиксирует инвариант: «артефакты CAS отдаются только внутри runId-scoped zip'а; ручка по sha — cross-owner-канал» (у content-addressed артефакта нет владельца: дедуп даёт один sha двум владельцам). Receipt отдаётся **job-scoped**: `GET /api/screenshot-jobs/:id/receipt` (авторизация выводится из владения джобой, как у `captureUrl`), run-scoped — внутри `bundle.zip` (R7b), acceptance — внутри evidence-zip.

**N13 (новое, T-B4). CI-гейт обязан предшествовать деплою.** Сегодня сборка, push `latest` и Dokploy `compose.deploy` — шаги одного job'а; любой «после-job» декоративен. R2c перестраивает workflow: `build` (push только SHA-тега) → `renderer-corpus` (`docker run` SHA-тега) → `deploy` (`buildx imagetools create` тега `latest` + вызов Dokploy). Красный корпус = нет деплоя.

---

## 3. Ключевые проектные решения

- **E1. Renderer fingerprint 2.0 — объявленный, серверный, до-capture'ный.**
  ```ts
  // server/capture/renderer.ts
  rendererFingerprint = sha256(canonicalJson({
    rendererSchema: 2,
    rendererVersion,                        // RENDERER_VERSION, ручной bump
    os, arch, nodeVersion, playwrightVersion,
    browserName, browserVersion,            // browserVersion — пробой запуска в build-слое
    browserRevision, launchedExecutable, browserExecutableSha256,   // sha ФАКТИЧЕСКИ запускаемого бинаря
    fontStackSha256, appFontsSha256, systemLibsHash,
    launchDeterminismArgsHash,              // sha256 buildDeterminismArgs()
    contextOptionsHash,                     // sha256 экспортируемой константы контекста воркера (C-m18)
    colorProfile: "srgb",
    readinessPolicyHash,
  }))
  ```
  Считается **до** съёмки — поэтому годится ключом reuse. Инициализация — асинхронно на старте (`main.ts`), не в синхронном `caseFingerprint`-пути. Константы контекста (`locale`, `timezoneId`, `reducedMotion`, …) выносятся в экспортируемый объект `scripts/screenshot-worker.mjs` (по образцу `buildLaunchArgs`) и хешируются как один вход — расхождение объявленного и передаваемого исключено конструкцией. Детерминизм-args передаются воркеру **в payload джобы** (воркер env не читает — иначе рассинхрон хеша и фактических флагов, T-m17).

- **E2. Наблюдённое остаётся наблюдением.** In-page проба `src/capture/env.ts` переименовывается в `observedCaptureEnvFingerprint` (иначе рядом жили бы два разных «captureEnvFingerprint», C-обзор) и продолжает ехать в evidence. Сверка:
  - `browser.version()` ≠ `manifest.browserVersion` **по major.minor.build** ⇒ hard-fail `renderer_mismatch` (образ не соответствует манифесту); аварийный kill-switch `EASYUI_RENDERER_STRICT_MANIFEST=0` деградирует до warning (T-M7);
  - self-check манифеста на старте процесса + поле `renderer` в `/api/health` — расхождение видно деплою, а не первому капчуру;
  - UA страницы — только по major ⇒ warning `renderer_env_drift`; наблюдённый gamut ≠ `srgb`, `dpr` ≠ `job.deviceScaleFactor` ⇒ warning `renderer_env_drift`.

- **E3. Типизированный словарь исходов — один на продукт.**
  ```ts
  // src/capture/failureCodes.ts
  export type CaptureFailureCode =
    | "font_load_failed" | "font_face_missing" | "image_load_failed"
    | "layout_unstable"  | "surface_missing"   | "surface_overflow"
    | "renderer_mismatch"| "navigation_failed" | "runtime_error";
  export interface CaptureCode { code: CaptureFailureCode; severity: "error"|"warning"; detail: string; ref?: string }
  ```
  Эмитенты: поверхность — `font_*`, `image_load_failed`, `layout_unstable`, `surface_missing`; воркер/сервис — `navigation_failed`, `runtime_error`; `geometryPolicy.ts` — `surface_overflow`; guard — `renderer_mismatch`. Маппинг legacy-строк: `fonts_timeout|fonts_pending` → `font_load_failed` (warning до R4), `images_timeout|images_failed` → `image_load_failed`, `frames_timeout` → `layout_unstable`, `network_timeout` → `runtime_error` (warning). **`readinessReason` сохраняется как отдельное поле** (не производное — маппинг не биективен: две legacy-строки схлопываются в один код, C-M5), рядом появляется `readinessCodes: CaptureCode[]`.

- **E4. Receipt — один артефакт для обоих каналов.** Собирается в `ScreenshotService.execute` после `await runJob(...)` и до ветвления по kind (порядок в коде это допускает — подтверждено ревью) — asset-путь получает его наравне с байтовым. `receiptSha256` — в `JobStatus.result` всех kind'ов; для `probe:"geometry"` блок `output` — `null` (PNG в этой ветке не существует, C-M8).

- **E5. Guard сравнивает три уровня** — `rendererFingerprint`, `fontManifestHash`, `readinessPolicyHash` — и живёт в `VisualService.drive()` между получением кадра кандидата и `runDiff` (`beginCheck` синхронный и кадром не располагает — C-B2); терминализация `mismatch`/`stale_renderer` — через существующий `finalizeCaptured(..., "error", …)`. Ответ несёт **список различающихся полей**.

- **E6. Вердикт визуального рана — из четырёх сигналов.**
  ```
  dims:       equal | normalized | irreconcilable
  exact:      diffPixels/totalPixels            (уже есть)
  perceptual: pixelmatch includeAA:false        (уже есть)
  edge:       residual внутри/вне edge-маски    (новое в diff-воркере)
  ```
  `irreconcilable` → `indeterminate`; `exact=0` → `pass, class:"identical"`; `exact>0 ∧ perceptual ≤ порога ∧ доля остатка внутри edge-маски ≥ T` → `pass, class:"renderer_residual"`; иначе `fail` с причиной. Порог T (стартовое значение 95%) **калибруется в R7a на реальных парах** — не догма. Edge-маска — **вход** существующего классификатора `server/visual/causes.ts` (`text-raster-residual` получает её вместо собственной эвристики) — два детектора одного явления не сосуществуют (T-M9).

- **E7. Кэш и пул — только там, где нет собственного механизма.** У acceptance есть reuse по `case_fingerprint`; кэш R9b обслуживает только не-acceptance пути.

- **E8. Режимы capture — пресеты над существующими ручками, внутренняя функция.** `resolveCaptureMode(mode)` появляется в R4 (`server/capture/modes.ts`) и используется сервером; **публичный API-параметр `mode` отложен** (§8): функциональная суть режимов достигается политиками (R4), receipt'ом (R5), guard'ом (R6) и bundle'ом (R7b), а публичный параметр не закрывает ни одной метрики успеха и конфликтует с замком драйвера (триаж S-S1).

---

## 4. Бюджет и точки инвалидации (обязательный раздел, S-B1)

**Ресурсы прода.** Текущие лимиты (`mem_limit: 1g`, посылка «1 CPU») — консервативная закладка. **Факт хоста (снят в R0, 2026-08-03, от пользователя):** ВМ `ya-prishchepov-dokploy` — **8 vCPU AMD Zen 4 (доля 100%), 8 ГБ RAM, 100 ГБ диск** (ru-central1-d). Хост общий с Dokploy/traefik → новые лимиты сервиса: **`mem_limit: 4g`, `cpus: "4"`** (половина хоста; 4-кратный запас против старого лимита). Все ресурсные пороги пакета (пул R9a: RSS ≤ 75% лимита; параллель подпроцессов; конкуренция capture) считаются от этих значений.

**Стоимость capture.** Пакет заведомо замедляет каждый capture: `--disable-skia-runtime-opts` (раствор без SIMD), строгая readiness v2 (загрузка required-faces + ≤3 цикла стабилизации ≈ +2–6 кадров), сборка и запись receipt (~2–8 КБ, +1 fsync). Замеры — done-критерии R2c (флаги, ms/case до/после на корпусе) и R4 (readiness v2 на `pixel-strict-v1`-профиле); порог: суммарный прирост стоимости verify-capture **>50%** от замера family-плана (1,96 с/case) ⇒ решение о снятии `--disable-skia-runtime-opts` (и переформулировке K2 в ppm-допуск) принимается до R6, фиксируется фактами в этой секции.

**Факт R2c (2026-08-04, dev-хост, корпус 12×3 × 3 прохода = 108 капчуров на конфигурацию, `scripts/renderer-corpus.mjs --verify --truncated --repeat 3`):**

| Конфигурация | ms/case | msTotal (108) | fingerprint | K1 (дрейф между всеми парами проходов) |
|---|---|---|---|---|
| `EASYUI_RENDERER_FLAGS=0` (дефолт образа) | **1355** | 146 300 | `b2d3d696…` | 0 |
| `EASYUI_RENDERER_FLAGS=1` (прод-цель пакета) | **1395** | 150 611 | `eeb0a69d…` | 0 |

**Вывод: стоимость детерминизм-флагов в пределах шума измерения, ≤3%** (одиночные прогоны на загруженном dev-хосте: +40 мс/case = +2,95% у исполнителя, +0,5% у верификатора на том же хосте; дисперсия не снималась — точным бейзлайном эти числа не считать) — на порядок ниже порога 50%, поэтому
`--disable-skia-runtime-opts` **остаётся включённым**, K2 в ppm-допуск не переформулируется по
причине стоимости (условная точка инвалидации №5 не наступает). Заодно замер подтверждает
инвалидацию №2 фактом: смена `EASYUI_RENDERER_FLAGS` меняет отпечаток (`b2d3d696…` ↔ `eeb0a69d…`),
то есть эталоны, снятые с выключенными флагами, к включённым неприменимы. Оговорка: обе цифры
сняты на dev-хосте; на GH-раннере абсолютные значения будут другими, значима только дельта.

**Факт R4 (2026-08-04, тот же dev-хост, `scripts/measure-acceptance.mjs --cases 20` — холодный ран приёмки, профиль `default-v1`, различается **только** политика readiness; замер сделан подменой `default-v1.readiness` на время замера, в коде профиль остался на v1):**

| Политика readiness | coldMs (20 случаев) | ms/case | Δ |
|---|---|---|---|
| v1 `DEFAULT_READINESS_POLICY` | 51 901 / 51 890 | **2 595** | — |
| v2 `STRICT_READINESS_POLICY` | 54 948 / 54 915 | **2 747** | **+153 мс/case, +5,9 %** |

Каждая конфигурация снята дважды, разброс между повторами ≤ 33 мс на ран (≈0,06 %), поэтому дельта
значима. **Вывод: строгая readiness стоит +5,9 % холодного рана** — против порога §4 (>50 % суммарного
прироста verify-capture) это на порядок меньше; вместе с +2,95 % детерминизм-флагов R2c суммарный
прирост пакета на сегодня ≈ **+9 %**. Оговорки: (а) тёплый ран (полный reuse) не меняется вовсе —
`warmMs` 506/507 мс в обеих конфигурациях, потому что кадры не переснимаются; (б) абсолютные числа —
dev-хост, значима только дельта; (в) в проде строгость получает **только** `pixel-strict-v1`
(N10), то есть на стоимость `default-v1`-ранов волна сегодня не влияет вовсе.

**Факт R7a — калибровка порога T (edge-residual), 2026-08-04.** Пары сняты **реальным** chromium
(playwright-core 1.61.1, headless, DPR 1 и 2): настоящий текст, настоящие шрифты, настоящий
антиалиасинг; метрика — `compareWithSignals` из `scripts/visual-diff-worker.mjs` (Sobel по эталону,
порог 24, дилатация 1 px), остаток — exact-rgba.

| Пара (реальный рендер) | `insidePct`, DPR 1 | `insidePct`, DPR 2 | перцептивная метрика, % | класс |
|---|---|---|---|---|
| текст сдвинут на 1 px | **100** | **98,72** | 2,68 / 2,57 | растровый остаток |
| текст сдвинут на 0,5 px (субпиксель) | **100** | **100** | 2,38 / 1,54 | растровый остаток |
| текст сдвинут на 1 px (холст только с текстом) | **100** | **99,11** | 1,35 / 1,28 | растровый остаток |
| `letter-spacing: 0.1px` | 99,37 | 94,81 | 1,50 / 1,17 | пограничный |
| плашка сдвинута на 4 px | 79,41 | 50,74 | 0,19 / 0,23 | регрессия |
| плашка сдвинута на 4 px (единственный объект холста) | 79,41 | 50,63 | 0,18 / 0,23 | регрессия |
| перекраска плашки | 26,32 | 13,88 | **0** | регрессия |
| заливка `#f2f1f0 → #e8f0ff` (52 % холста) | 1,92 | 0,96 | **0** | регрессия |

**Вывод: T = 95 % (стартовое значение подтверждено, не догма — а измеренная середина зазора).**
Зазор между классами — **(79,4; 98,7)**; 95 лежит внутри него ближе к верхней границе намеренно:
цена ошибки несимметрична — ложный `renderer_residual` прячет регрессию (риск §9), ложная
регрессия стоит одного взгляда человека. Три факта, добытых калибровкой сверх самого порога:

1. **AA-эвристика доволнового `text-raster-residual` на этих парах не работает вовсе**: сдвиг
   глифа на 1 px даёт `aaDiffPct/rawDiffPct ≈ 0,6` при пороге эвристики 0,25, то есть настоящий
   растровый остаток она молчала. Edge-маска его называет — это и есть содержание T-M9.
2. **Порог pixelmatch слеп к заливкам**: смена фона половины холста даёт `rawDiffPct` **0 %** по
   pixelmatch и **52 %** по exact-rgba. Поэтому в режиме `signals` маска причин — exact-rgba, а
   `perceptual` остаётся отдельным сигналом, а не единственным.
3. **Сдвиг на 1 px даёт 100 % внутри маски и для плашки** (не только для текста) — то есть один
   edge-сигнал недостаточен, и оба условия E6 (бюджет ∧ T) обязательны. Именно перцептивный
   бюджет отсекает «плашка съехала на пиксель».

**Факт R9a — тёплый пул: cold/warm p95 и RSS (2026-08-04, dev-хост 8 vCPU, `scripts/measure-capture.mjs
--cases 30`, `EASYUI_RENDERER_FLAGS=1`, по два прогона на конфигурацию; «устойчивый RSS» — медиана
семплов дерева процессов сервера, а не пик запуска):**

| Конфигурация | cold, мс | warm p50 | **warm p95** | warm max | устойчивый RSS | пик RSS |
|---|---:|---:|---:|---:|---:|---:|
| `EASYUI_RENDERER_POOL=0` (процесс на джобу, доволновой дефолт) | 1270 / 1204 | 1191 / 1235 | **1245 / 1352** | 1247 / 1354 | 572 / 505 МБ | 791 / 792 МБ |
| `EASYUI_RENDERER_POOL=1` (тёплый пул) | 1273 / 1200 | 647 / 649 | **705 / 709** | 803 / 808 | 812 / 823 МБ | 857 / 853 МБ |

*(Оговорка методологии, приёмка R9a: «p95» на выборке ~29 warm-семплов — фактически второй максимум, cold — единичный семпл на прогон; вердикт устойчив — дельта пул/per-job почти двукратная и воспроизведена верификатором независимо, — но цитировать эти числа как строгие квантили не следует.)*

**Вывод: критерий прод-включения выполнен обеими ногами.** warm p95 = **705–709 мс ≤ 1,0 с/case**
(−44% к процессу-на-джобу: снят `chromium.launch()` с каждого кадра, cold при этом не изменился —
первый кадр платит запуск в обеих конфигурациях). Устойчивый RSS = **812–823 МБ ≤ 3072 МБ**
(75% от фактического `mem_limit: 4g`), то есть **20% лимита**; плата за тёплый браузер — +240…320 МБ
постоянно занятой памяти против per-job режима, и она втрое меньше порога ресайкла по RSS
(1500 МБ). Разброс между повторами ≤ 8 мс по p95 — дельта значима. Оговорка: числа сняты на
dev-хосте (8 vCPU против 4 у прод-сервиса), поэтому абсолютные значения в проде будут выше;
значима дельта и запас до порогов, а вердикт `verdict: "prod-on"` печатает сам скрипт по тем же
правилам на любом хосте.

**Корпус под пулом (K1, перепроверка R9a).** `EASYUI_RENDERER_POOL=1 npm run corpus:verify` —
**240 капчуров, 0 расхождений sha256, 0 внутрипрогонного дрейфа, 0 отказов**, 813 мс/капчур
(против 1355–1395 мс/case замера R2c на том же хосте). То есть пул не меняет ни одного байта
кадра: ожидания `expected.json`, записанные процессом-на-джобу, зеленеют под пулом без правок.

**Конкуренция (N9, ревизия правила «один тяжёлый подпроцесс»).** Ручка конкуренции capture волной
**не вводится**: выигрыш получен на строго последовательном потоке, а поднятие конкуренции меняет
профиль RSS (каждый параллельный контекст — ещё один рендерер chromium) и обязано мериться
отдельно; `ScreenshotService` остаётся на конкуренции 1.

**Кросс-хост (K2), статус R2c.** Вердикт **не принят в этой волне**: в среде исполнения волны нет
рабочего docker-демона (nested-контейнер: `bridge`-сеть и bind-mount'ы запрещены), поэтому матрицу
образа локально снять не удалось. Вместо жёсткого гейта заведён **bootstrap-режим**: если для
отпечатка образа (`source: "manifest"`) ожиданий в `expected.json` нет, CI-job снимает матрицу,
кладёт её артефактом и не краснеет; ожидания хранятся **per-fingerprint** (`hosts["<source>:<fp>"]`),
гейт становится жёстким после `--adopt` артефакта. Порог решения (≤50 ppm суммарно) и процедура
сверки — `docs/server-api.md#deployment`; вердикт K2 принимается по первому CI-артефакту.

**Точки инвалидации reuse приёмки** (каждая = одна холодная пересъёмка семьи, ~1,6 мин/49 cases по замеру W1b на dev):
1. R1 — bump `algoVersion` 4→5 (смена схемы);
2. R2a — включение флагов в dev/CI (`launchDeterminismArgsHash` меняется);
3. R4 — переключение профиля на `STRICT_READINESS_POLICY` (`readinessPolicyHash`);
4. прод-включение `EASYUI_RENDERER_FLAGS` (§7);
5. (условная) снятие `--disable-skia-runtime-opts` по порогу «>50%» — снова меняет `launchDeterminismArgsHash` (V-N9);
6. (факт R2a, принят при приёмке волны) `contextOptionsHash` перестал быть `null` — константа воркера входит в декларацию независимо от `EASYUI_RENDERER_FLAGS`, т.е. fingerprint прода меняется первым же деплоем пакета даже при выключенных флагах. Стоимость нулевая сверх точки 1: R1 и R2a едут одним деплоем, холодная пересъёмка общая. Поле `contextOptionsHash: null` в манифесте R0 (`scripts/renderer-manifest.mjs`) стало мёртвым — авторитетный источник теперь константа `server/capture/renderer.ts`; поле из манифеста не читается (заметка для читателя манифеста, правка файла — за R0-владельцем при следующем касании).

Итого **до пяти** холодных пересъёмок за пакет — признанная плата за поэтапность (аналог `algoVersion`-миграций family-плана). Смягчение: точки 2–4 совмещаются с плановыми волнами, между ними reuse работает; прод-точка 4 разносится по времени с массовым переснятием эталонов (R6) — обе операции идут через один `ScreenshotService` (конкуренция capture сегодня 1; поднятие — измеряемая опция R9a при подтверждённых ресурсах, N9).

**Диск (общий периметр volume `easy-ui-data`).** Существующие: `assets/` — **GC нет вообще** (orphan-PNG копятся; массовое переснятие эталонов добавит сотни PNG — риск §9), `.acceptance/cas` — 256 МБ (`evidenceMaxBytes`), `.candidates` — 32 МБ. Новые: `.receipts/` — 64 МБ + TTL 7 суток + пины, `.capture-cache/` — **256 МБ** + LRU. Приёмка §7.8 меряет `du` по всем пяти каталогам + SQLite/WAL, включая `assets/`.

**CI.** Полный корпус 12×20=240 капчуров ≈ 8–15 мин на GH-раннере — **только в main-workflow** (гейт деплоя, N13) и nightly; в PR-CI — усечённая матрица 12×3. Процедура карантина фикстуры (флаки → фикстура помечается `quarantined` в `expected.json`, main не красится, заводится факт в план) описывается в R2c. **Факт R2c:** карантин и вся CI-механика (три job'а `build` → `renderer-corpus` → `deploy`, bootstrap-режим, per-fingerprint ожидания, `workflow_dispatch corpus-sanity=break` для проверки самого гейта) описаны в `docs/server-api.md#deployment`; PR-CI гоняет ту же цепочку с `--truncated`.

---

## 5. Волны

### R0 — Микро-релиз: env, ревизия ресурсов, пин базового образа, renderer manifest, замер K5-baseline

**Объём.** До кода, читающего флаги (канон W0 family-плана).
- **Ревизия ресурсов прода (N9)**: снять факт хоста (`nproc`, `free -m`, соседние сервисы Dokploy — канон `/deploy`); поднять `mem_limit` (и при подтверждении — ключ `cpus`; сегодня в compose его нет вовсе, V-N15) в `docker-compose.yml` отдельно откатываемой правкой; факты — в §4.
- `docker-compose.yml`: проброс `EASYUI_RENDERER_FLAGS`, `EASYUI_RENDERER_EPOCH`, `EASYUI_RENDERER_GUARD_DISABLED`, `EASYUI_RENDERER_STRICT_MANIFEST`, `EASYUI_CAPTURE_RECEIPTS_DISABLED`, `EASYUI_VISUAL_SIGNALS_V2`, `EASYUI_RENDERER_POOL`, `EASYUI_CAPTURE_CACHE` (все `${…:-}`). `EASYUI_IMAGE_REF`/прокидка digest в Dokploy — **исключена** (advisory-поле, требует нового write-доступа CI к Dokploy env и способно триггерить redeploy-петлю; `provenance.imageRef` собирается из build-args — триаж S-m3/T-m15).
- `Dockerfile`: пин `FROM node:24-slim@sha256:…` (T-M5); `ARG EASYUI_BUILD_SHA` объявляется **непосредственно перед** `RUN node scripts/renderer-manifest.mjs > /app/renderer-manifest.json` (не раньше — иначе инвалидация npm/playwright-слоёв кэша на каждый коммит, C-M9); `ENV EASYUI_RENDERER_MANIFEST=/app/renderer-manifest.json`.
- `scripts/renderer-manifest.mjs` (новый, node): поля §2.2 N1 — `browsers.json` через `require.resolve("playwright-core/package.json")`; локация shell-бинаря — `registry.findExecutable("chromium-headless-shell")` (обе директории `chromium-<rev>` и `chromium_headless_shell-<rev>` существуют в кэше playwright); `browserVersion` — пробой `chromium.launch()` в build-слое **с явными args для root-окружения BuildKit** (`--no-sandbox --disable-dev-shm-usage`) и фолбэком `chrome-headless-shell --version` при отказе launch (V-N6); sha256 headless-shell бинаря; обход `/usr/share/fonts` собственным кодом (fc-list в slim нет); `dpkg-query` мягко → null; `dist/fonts`.
- **Замер K5-baseline**: число capture-итераций до зелёного вердикта на текущей семье (журнал `driver.mjs`) — до любых изменений; факт в §1.

**Файлы.** Новые: `scripts/renderer-manifest.mjs`. Изменяемые: `Dockerfile`, `docker-compose.yml`, `.github/workflows/build-image.yml` (только build-args), `docs/server-api.md`.
**Done.** Деплой; факты ресурсов хоста и новые лимиты — в §4; `docker run <image> cat /app/renderer-manifest.json` — полный документ, `browserVersion` совпадает с реальной пробой, `browserExecutableSha256` = sha именно headless-shell; K5-baseline записан; `npm run verify`.

### R1 — Renderer fingerprint 2.0 (единственный bump `algoVersion`)

**Объём.**
- `server/capture/renderer.ts`: асинхронная инициализация на старте (чтение манифеста / dev-фолбэк с null-деградацией), `RENDERER_VERSION`, `rendererPin.json`, `rendererFingerprint(readinessPolicyHash)`, `rendererDeclaration()`, `buildDeterminismArgs()` (пока: явные дубли srgb/hide-scrollbars).
- `server/acceptance/ids.ts`: `captureEnvFingerprintOf` удаляется (потребители — только `ids.ts` и `caseSets.test.ts`, сверено), вход `case_fingerprint` → `rendererFingerprint`; `CASE_FINGERPRINT_ALGO_VERSION = 5` (**последний bump пакета**; о санкционированном 5→6 вне пакета — отметка к N5 выше).
- Переименование наблюдённой in-page пробы → `observedCaptureEnvFingerprint` (`src/capture/env.ts`, метрики гейтов, `service.ts`).
- `server/screenshot/service.ts`: `rendererDeclaration` на джобе; сверка версии по major.minor.build → hard-fail `job.error.code="renderer_mismatch"`; kill-switch `EASYUI_RENDERER_STRICT_MANIFEST=0` → warning.
- Self-check манифеста на старте + секция `renderer` в `/api/health` и `GET /api/capabilities`.
- `package.json`: `@playwright/test` пиннуется точно; `scripts/check-renderer-pin.ts` (`verify:renderer` в `npm run verify`): сверка browsers.json↔pin, единственность `playwright-core` в lockfile, точность обоих пинов.

**Файлы.** Новые: `server/capture/renderer.ts` (+тест), `server/capture/rendererPin.json`, `scripts/check-renderer-pin.ts`. Изменяемые: `server/acceptance/ids.ts`, `server/acceptance/caseSets.test.ts`, `server/screenshot/service.ts`, `src/capture/env.ts`, `server/acceptance/gates/{readiness,capture}.ts` (переименование поля метрик), `server/routes/meta.ts`, `server/main.ts`, `server/contracts.ts`+openapi+`generate:sdk`, `package.json`, `docs/server-api.md`.

**Done.** `verify` (+`verify:renderer`); unit K8: подмена версии/sha headless-shell-бинаря меняет `rendererFingerprint` и `case_fingerprint`, правка `provenance.*` — не меняет; unit «bump ровно один: `=== 5`»; тест «version-mismatch ⇒ `renderer_mismatch`, а с `EASYUI_RENDERER_STRICT_MANIFEST=0` ⇒ warning»; e2e `e2e/preview/renderer-fingerprint.spec.ts` — два капчура дают равный fingerprint, `capabilities.renderer` совпадает; **та же спека зеленеет в dev-фолбэке** (null-поля допустимы, fingerprint стабилен внутри процесса).
**Флаг.** Не нужен: пиксели не меняются; инвалидация reuse — точка 1 §4.

### R2a — Детерминизм-флаги запуска

**Объём.** `scripts/screenshot-worker.mjs`: `buildDeterminismArgs()` (экспорт, дословно тестируемый), детерминизм-args приходят **в payload джобы** от сервиса (воркер env не читает); экспортируемая константа контекст-опций (`contextOptionsHash`). Флаг `EASYUI_RENDERER_FLAGS=1`: dev/CI ON (`playwright.config.ts` webServer — прецедент `surfacesEnv`), прод OFF. Значение флага входит в `launchDeterminismArgsHash`. **Инвентаризация растр-зависимых артефактов dev/CI** (спеки, локальные `visual_references` в e2e-фикстурах) и их пересъёмка (T-M5-scope); список — в done.
**Файлы.** `scripts/screenshot-worker.mjs`, `server/screenshot/service.ts` (payload), `server/capture/renderer.ts` (флаги в хеш), `playwright.config.ts`, `server/screenshot-worker.test.ts`, `docs/server-api.md`.
**Done.** unit: `buildDeterminismArgs` дословно; тест «фактически запускаемый бинарь принимает все детерминизм-флаги» (headless-shell-only флаги — защита от смены channel, C-m11); инвентаризация пересняткой закрыта, `npm run e2e` зелёный при флагах ON; `verify`.

### R2b — Корпус рендерера (harness + фикстуры)

**Объём.** `e2e/fixtures/renderer-corpus/` — 12 фикстур в **двух подмножествах** (T-M2): `pixel/` (байт-идентичность: YS Text 400/500 кириллица+цифры+валюта; текст на целых и дробных координатах; badge с radius; SVG-иконка; raster-картинка; opacity+shadow+gradient; flex/grid; DPR 1/2/3; light/dark) и `outcome/` (typed-коды: отсутствующий font asset; битое изображение; поздняя мутация layout — ожидания меняются в R4 без bump'а `RENDERER_VERSION`). `scripts/renderer-corpus.mjs` (канон `measure-acceptance.mjs`: поднимает Bun preview на изолированном `DATA_DIR`, публикует фикстурную ДС/компоненты); `expected.json` — sha256 для `pixel/`, коды для `outcome/`; PNG в git не кладём.
**Файлы.** Новые: `scripts/renderer-corpus.mjs`, `e2e/fixtures/renderer-corpus/**`, `e2e/preview/renderer-determinism.spec.ts`. Изменяемые: `package.json` (`corpus:verify`).
**Done.** hard-гейт локально: 0 расхождений из 240 (K1); `outcome/`-фикстуры падают старым untyped-путём — ожидаемо до R4, зафиксировано в спеке; `verify`.

### R2c — CI: build→corpus→deploy + soft cross-host гейт + замеры

**Объём.** Перестройка `.github/workflows/build-image.yml` (N13): job `build` пушит **только SHA-тег** → job `renderer-corpus` (`docker run` SHA-тега **с `EASYUI_RENDERER_FLAGS=1` явно** — прод-дефолт образа OFF, без этого гейт мерил бы не ту конфигурацию, V-N2; полная матрица 12×20) → job `deploy` (`buildx imagetools create` тега `latest` + Dokploy). PR-CI — усечённая матрица 12×3. Soft cross-host гейт: результат — CI-артефакт (`upload-artifact`), сравнение с локальным `docker run`; **порог решения K2 (cross-host) — ≤50 ppm суммарно** (edge-квалификация остатка — после R7a: маски в R2c ещё не существует, V-N1); процедура карантина фикстур (§4). Замер стоимости флагов (ms/case до/после) — факты в §4.
**Файлы.** `.github/workflows/build-image.yml`, `scripts/renderer-corpus.mjs` (режимы `--verify`/`--truncated`/`--report`), `docs/server-api.md`.
**Done.** красный корпус блокирует деплой (проверка на намеренно сломанном ожидании); soft-гейт: факт замера опубликован в §4, вердикт по K2 принят (0 ppm ⇒ гейт; >0 ⇒ ppm-допуск ≤50 внутри edge-маски, зафиксировано); замер флагов вписан в §4 с решением по порогу 50%; `verify`.

### R3 — Типизированные коды сквозь конвейер + `jobOutcome` в HTTP

**Объём.** До строгости R4, чтобы новые причины приезжали типизированными.
- `src/capture/failureCodes.ts` (E3); `src/capture/readiness.ts`: `codes: CaptureCode[]` рядом с сохраняемым полем `reason` (маппинг не биективен — C-M5); полный маппинг включая `images_timeout`.
- `src/capture/protocol.ts`: `CaptureReadinessReport.codes?`.
- `scripts/screenshot-worker.mjs`: `page.goto` → `navigation_failed`; ошибка/mismatch handshake → `runtime_error`; `page.$("#eui-capture-surface")` null → `surface_missing` (сейчас молча деградирует в `page.screenshot`).
- `server/screenshot/service.ts`: `job.error.code`; `CaptureReadinessOutcome.readinessCodes`.
- `GET /api/screenshot-jobs/:id`: аддитивные `outcome: JobOutcome` и `failure: {code, message}`.
- Гейты: `gates/readiness.ts` и `gates/render.ts` кладут `codes` в метрики; `gates/geometry2.ts` маппит `policyVerdict` → `surface_overflow`.

**Файлы.** Новые: `src/capture/failureCodes.ts` (+тест). Изменяемые: `src/capture/{readiness.ts,protocol.ts}`, `scripts/screenshot-worker.mjs`, `server/screenshot/service.ts`, `server/acceptance/gates/{readiness,render,geometry2}.ts`, `server/routes/screenshots.ts`, contracts+openapi+sdk, `docs/server-api.md`.
**Done.** unit «каждый код достижим фикстурой или явно помечен "эмитится в R4/R6"»; unit «`reason` сохраняет доволновый формат»; e2e: несуществующий URL → `failure.code === "navigation_failed"`; `verify`.
**Флаг.** Не нужен — только аддитивные поля.

### R4 — Строгая readiness 2.0: шрифты, изображения, стабилизация layout

**Объём.**
- `src/capture/readinessPolicy.ts`: `version: 1 | 2`; v2 — `fonts: "required-faces"`, `images: "decoded-strict"`, `layout: {stabilize: true, attempts: 3}`. `DEFAULT_READINESS_POLICY` не меняется; добавляется `STRICT_READINESS_POLICY`.
- Font-манифест: сервер парсит `themeContent.fonts[].src` → `assetId`, sha — из `asset_<sha256>`-формата id (явный объём — в схеме этих полей нет, C-m13); `fontManifestHash`; `bootstrap.fonts = {declared, manifestHash}`. Постановки: `enqueueComponentFrozen`, `enqueueComponentDraft`, `enqueueComponentCandidate` (фактические имена; «`enqueueComponentDraftBytes`» v1-плана не существует — C-M6) + `enqueuePrototypeFrozen` с расширением резолва `themeContent` на все frozen-постановки (сегодня — только при `opts.probe`), hash по ДС экрана.
- `settleFonts` в `required-faces` (правило T-M10): **required = declared ∩ observed-used-families**; для каждого — `document.fonts.load('${weight} ${style} 16px "${family}"')` → `check()` (авторитет) → `FontFace.status` (подтверждение). `check() === false` ⇒ `font_face_missing`; `status === "error"`/reject ⇒ `font_load_failed`. ДС без темы (`fonts: []`) ⇒ v1-семантика (K3-оговорка).
- `settleImages` в `decoded-strict`: `complete ∧ naturalWidth>0 ∧ naturalHeight>0 ∧ decode() resolved`; evidence — URL/assetId/intrinsic/contentHash; отказ ⇒ `image_load_failed`.
- `src/capture/stability.ts`: `rectSignature` (поверхность + geometry-узлы, округление 1/64 px), «rAF → мера → rAF → мера → сравнение», ≤3 попытки ⇒ `layout_unstable` с `elementKey`. После `settleFrames`, до `themeResources`.
- `server/capture/modes.ts` — внутренний `resolveCaptureMode` (E8).
- `server/acceptance/policies.ts`: `pixel-strict-v1.readiness = STRICT_READINESS_POLICY`; `default-v1` — отдельным откатываемым шагом после приёмки.
- Обновление `outcome/`-ожиданий корпуса (владение переходит R4 — правило §6). **Факт приёмки R4 (2026-08-04, осознанное сужение):** интерактивный путь корпуса (`POST …/screenshot` без политики) живёт на v1-политике, и записываемая форма исхода (`{status, failureCode, imageProduced, consoleErrors, pageErrors}`) readiness-кодов не несёт — typed-коды на outcome-фикстурах корпусом недостижимы без правки харнесса R2b (передача политики/запись кодов из job.result) либо отдельного strict-прогона. Ожидания outcome/ остались «done/failureCode:null» (фиксация нерегресса дефолтного пути), K3-покрытие строгих кодов живёт в `e2e/preview/capture-strictness.spec.ts` + unit. **Follow-up (кандидат в объём R9b или отдельный микрорелиз): strict-режим corpus-harness** — до него метрика K4 на интерактивном канале корпусом не покрыта.

**Файлы.** Новые: `src/capture/stability.ts` (+тест), `server/capture/modes.ts`. Изменяемые: `src/capture/{readinessPolicy.ts,readiness.ts,protocol.ts,CaptureComponent.tsx,CaptureSurface.tsx}`, `server/screenshot/service.ts`, `server/acceptance/{policies.ts,gates/readiness.ts}`, `e2e/fixtures/renderer-corpus/outcome/**`, contracts/openapi/sdk, `docs/server-api.md`.
**Done.** K3: e2e `e2e/preview/capture-strictness.spec.ts` — «нет font asset» ⇒ `font_face_missing`, «битый `<img>`» ⇒ `image_load_failed`, «поздняя мутация» ⇒ `layout_unstable` за ≤3 попытки; unit «политика v1 даёт тот же `policyHash`, что до волны»; unit variable-шрифт `weight:"400 700"` — ложного `font_face_missing` нет; unit «face, объявленный темой, но не использованный компонентом, не требуется»; замер стоимости readiness v2 — факты в §4; `verify`.
**Флаг.** Env не нужен (строгость — политикой профиля, N10).

### R5 — Capture receipt на обоих каналах доставки

**Объём.**
- `src/capture/receipt.ts`: `CaptureReceipt` (`receiptVersion: 1`):
  ```
  renderer      { …rendererDeclaration, provenance, observedBrowserVersion, drift: CaptureCode[] }
  target        { kind, componentId|prototypeId, version|rev, sourceHash?, bundleHash, dsMetaVersion, propsHash }
  resources     { fontManifestHash, fontFaces[{family,weight,style,assetId,sha256,status,checked}],
                  images[{url,assetId,naturalWidth,naturalHeight,decoded}], themeResources }
  console       { errors[], warnings[], pageErrors[] }
  output        { viewport, dpr, colorScheme, pngWidth, pngHeight, pngSha256, surfaceRect, paintMargin? } | null  // null для probe:"geometry" (C-M8)
  timings       { navigateMs, fontsMs, imagesMs, networkMs, framesMs, stabilizeMs, screenshotMs, totalMs }
  verdict       { captureClean, codes: CaptureCode[], readinessMet, readinessPolicyHash }
  ```
- `server/capture/receiptStore.ts`: `.receipts/<sha[0:2]>/<sha>`, `putReceipt`/`readReceipt`, **два индекса**: `assetId → receiptSha256` (asset-доставки; нужен R6 для резолва renderer'а эталона — T-B2; **пишется после `assetRepo.ingest`** — assetId раньше не существует, V-N7) и `jobId → {receiptSha256, ownerKey}` с TTL стора (7 суток) — receipt переживает `RESULT_TTL_MS` 10 мин и `reapExpired()`, авторизация по сохранённому `ownerKey` не зависит от живой джобы (V-N4). Свипер: TTL 7 суток, потолок 64 МБ, LRU, GC on start/on write, **пин-провайдер** — подключается в R6.
- Сборка в `ScreenshotService.execute` после `runJob`, до ветвления по kind; `receiptSha256` во всех результатах.
- Доступ (N12): **`GET /api/screenshot-jobs/:id/receipt`** — job-scoped; после смерти джобы резолвится через `jobId`-индекс стора (тот же роут, тот же ownerKey-чек); ручки «по sha» **нет** (инвариант W1a `acceptance.ts:26`); acceptance-гейты кладут `receipt.json` в CAS и в per-run манифест.

**Файлы.** Новые: `src/capture/receipt.ts`, `server/capture/receiptStore.ts` (+тесты). Изменяемые: `scripts/screenshot-worker.mjs` (тайминги, `surfaceRect`, `pngSha256`), `server/screenshot/service.ts`, `server/routes/screenshots.ts`, `server/acceptance/gates/{render,capture}.ts`, `server/acceptance/evidence.ts`, contracts/openapi/sdk, `docs/server-api.md`.
**Done.** unit: receipt детерминирован кроме `timings`/`provenance.builtAt`; свипер не удаляет receipt, на который ссылается живой job-результат/CAS-манифест; тест «share/capture-принципал получает 403 на чужой job-receipt»; e2e: интерактивный `snap` (asset-путь) возвращает `receiptSha256`, `GET /api/screenshot-jobs/:id/receipt` отдаёт документ с `renderer` и `fontFaces` — закрытие дыры §1.6; замер прироста диска на 200 капчурах; `verify`.
**Флаг.** Kill-switch `EASYUI_CAPTURE_RECEIPTS_DISABLED=1` (дефолт — включено).

### R6 — Cross-renderer guard на визуальных эталонах (миграция: следующий свободный номер, v28+ — v27 занят R3a RFC)

**Объём.**
- **Миграция (следующий свободный номер, v28+)** (единственная в пакете, только `ADD COLUMN`, без FK): `visual_references` += `renderer_fingerprint TEXT NULL`, `renderer_json TEXT NULL`, `font_manifest_hash TEXT NULL`, `receipt_sha256 TEXT NULL`, `renderer_recorded_at TEXT NULL`; `visual_runs` += `renderer_guard TEXT NULL`, `outcome_code TEXT NULL`, `candidate_receipt_sha256 TEXT NULL`, `reference_receipt_sha256 TEXT NULL`.
- Запись рендерера на эталон: `upsertReferencePrivileged` (общая точка обоих путей — `baselines.ts:73` и generic `PUT /api/visual-references`, V-N3) резолвит renderer-блок **по `assetId → receiptSha` индексу R5** (T-B2); NULL — только для PNG, залитых извне, или при истёкшем индексе (best-effort честно). Авторитетный носитель renderer-блока — инлайновый `renderer_json` (переживает TTL receipt-стора); `receipt_sha256` — evidence-ссылка, поддержанная **пином**: receipt'ы, на которые ссылается `visual_references`, не вытесняются свипером (канон `candidatePins`, T-M12). Расширение сигнатур `finalizeCaptured`/`terminalRow`/`runReport` под `outcome_code`/`renderer_guard` — явный объём (V-N13).
- Guard в `VisualService.drive()` (E5, C-B2) между кадром кандидата и `runDiff`: `matched | mismatch | unknown`; `mismatch` ⇒ `status='error'`, `outcome_code='renderer_mismatch'`, `differing[]`, без процента; `unknown` ⇒ advisory `warnings:["renderer_unknown"]` — **до** включения флагов; при `EASYUI_RENDERER_FLAGS=1` + `EASYUI_RENDERER_EPOCH` (N11) `unknown`/чужая эпоха ⇒ `error/stale_renderer` без процента.
- **`scripts/rebaseline-all.mjs`** (T-M10-риски): инвентаризация эталонов прода **обоих scope** (число — в план до включения флагов); переснятие prototype-scope через существующий `runBaseline`-путь и **component-scope через generic `PUT /api/visual-references`** (V-N3 — иначе после эпохи они stale без инструмента); rate-limit (уважение `BACKGROUND_QUEUE_RESERVE`), идемпотентность по поколениям `visual_baseline_sets`. **V-N8 (ревизия при приёмке R6, 2026-08-04):** буквальный инлайн renderer-блока от клиента отвергнут — клиент не авторитет provenance эталона (spoofing); `receiptSha` передаётся из `JobStatus.result`, факты резолвит сервер в момент PUT. Устойчивость к вытеснению receipt'ов до commit'а: пин живых джоб + троттлинг GC стора (60с/50 записей) + ёмкость 64МБ ≫ любой rebaseline; страховка от остаточного окна — **пост-PUT верификация в `rebaseline-all.mjs`**: NULL `renderer_json` ⇒ одна свежая пересъёмка (component-scope), ненулевой exit + WARNING при остатке — молчаливого будущего `stale_renderer` нет.
- Приёмка: при reuse `acceptance_case_results` сверяется `receipt.renderer.rendererFingerprint` артефакта; расхождение **или отсутствие артефакта** (вытеснен `gcEvidence`) ⇒ пересъёмка, не ошибка рана (T-m20).
- Rollback-политика (T-M8): точка невозврата — первая запись эталона с `renderer_fingerprint` при включённых флагах; откат образа/флага после неё — только с восстановлением бэкапа (канон surfaces); бэкап prod-volume — pre-flight этой волны; абзац в `docs/server-api.md#deployment`.

**Файлы.** Изменяемые: `server/migrations.ts` (миграция R6 + комментарий-инвариант), `server/visual/{repo.ts,service.ts,baselines.ts}`, `server/routes/{visual,visualBaselines}.ts` (generic-PUT — точка T-B2, V-N10), `server/capture/receiptStore.ts` (пин-провайдер), `server/acceptance/runner.ts`, `server/main.ts`. Новые: `scripts/rebaseline-all.mjs`. Contracts/openapi/sdk, `docs/server-api.md`.
**Done.** unit: legacy-эталон (NULL) при выключенных флагах → `unknown`-advisory, вердикт по метрикам как раньше (нулевой регресс); при `EASYUI_RENDERER_FLAGS=1` → `error/stale_renderer` без процента; эталон ≠ кандидат → `error/renderer_mismatch` с `differing[]`; baseline через `runBaseline`-путь **и через generic-PUT** получает непустой `renderer_json` (T-B2 закрыт для обоих scope); dev/e2e-эталоны, созданные до эпохи, переснимаются в этой волне (V-N5); миграция R6 (v28+) на копии прод-БД; **корректный** чек-лист совместимости: потребители `SELECT *` по `visual_references`/`visual_runs` существуют (4 места в `repo.ts`), но ни один не сериализует row наружу — тест-инвариант + «старый образ на БД с миграцией R6 стартует и отдаёт эталоны» (T-M9-риски: формулировка v1 была фактически ложной); e2e `e2e/preview/renderer-guard.spec.ts`; `verify`.
**Флаг.** `EASYUI_RENDERER_GUARD_DISABLED=1` (аварийный). Прод-включение `EASYUI_RENDERER_FLAGS` — только после этой волны и по чек-листу §7.

### R7a — Разделение метрик (сигналы + edge-маска)

**Объём.** `scripts/visual-diff-worker.mjs`: edge-маска (Sobel по эталону, дилатация 1px), разбиение остатка inside/outside, `edgeResidual.pct`; нормализация размеров W5a переиспользуется. `server/visual/service.ts`: вердикт E6; `RunReport` += `signals` и `class`; **edge-маска передаётся входом в `server/visual/causes.ts`** — `text-raster-residual` переводится на неё (один механизм, T-M9); порог T=95% калибруется на реальных парах (`pay-*` семьи), факт калибровки — в план. `dimensionMismatch` → нормализация с метриками, несводимость → `indeterminate`.
**Файлы.** `scripts/visual-diff-worker.mjs`, `server/visual/{diff-runner.ts,service.ts,repo.ts,causes.ts}`, contracts/openapi/sdk, `docs/server-api.md`.
**Done.** unit: «сдвиг 1px текста» ⇒ `renderer_residual`, «badge на 4px» ⇒ `regression/geometry-shift`, «изменён fill» ⇒ `regression/surface-tint`; инвариант «остаток вне edge-маски не даёт `renderer_residual`»; калибровка T опубликована; `verify`.
**Флаг.** `EASYUI_VISUAL_SIGNALS_V2=1` (opt-in). **Прекондиции прод-включения (приёмка R7a, 2026-08-04, оба факта измерены реальным chromium):** (1) класс «перекраска глифов» (смена цвета/оттенка текста) даёт insidePct=100 и проходит T=95 — при ненулевом perceptual-бюджете регрессия прячется в `pass/renderer_residual`; до включения — либо второе условие вердикта (уже считаемый `channelStats` — равномерная канальная дельта ⇒ не residual), либо докалибровка; (2) в signals-режиме `rawDiffPct` — exact-rgba, а пороги `causes.ts` калиброваны на pixelmatch-семантике normalize (та же пара даёт 4,49% против 2,07%) — до включения пересчитать пороги под exact-шкалу или конвертировать метрику. Также: флаг не входит ни в `case_fingerprint`, ни в один отпечаток — флип меняет evidence-артефакты приёмки без инвалидации reuse (безвредно: вердикты не зависят, но diff sha артефактов ожидаем).

**Статус (2026-08-04): выполнено.** Воркер получил третий режим `signals` (`compareWithSignals`) —
четыре сигнала E6 плюс метрики классификатора; edge-маска (`edgeMaskOf`, Sobel + дилатация 1 px)
считается по эталону, остаток — exact-rgba (`exactDiffMaskOf`), разбиение — `edgeResidualOf`.
В `normalize`-режиме edge-сигнал строго opt-in (env-флаг либо явная опция `edge`), поэтому evidence
приёмки при выключенном флаге доволновой байт-в-байт. `VisualService` под флагом судит ран
`evaluateSignalsVerdict` (чистая функция), `RunReport` получил `class` и `signals` **без миграции**
(хранятся в `candidate_meta_json` рядом с `exactRgba`, наружу — собственными полями),
`outcomeCode` — новое значение `dimensions_irreconcilable`. `classifyTextRasterResidual` переведён
на edge-маску (AA-эвристика осталась фолбэком на отсутствие сигнала). **Калибровка T = 95 %
опубликована в §4** (реальный chromium, 8 пар × 2 DPR; зазор классов (79,4; 98,7)).

Два наблюдения волны, которых не было в постановке:

- **режим `signals` судит по exact-rgba, а не по порогу pixelmatch** — калибровка показала, что
  бюджет pixelmatch не видит смену заливки половины холста вовсе (0 % против 52 %). Следствие:
  ран, у которого перцептивная метрика в бюджете, а остаток лежит вне контуров, теперь `fail`.
  Это ужесточение — содержание волны, и оно живёт под opt-in флагом;
- **acceptance-путь ещё не передаёт edge-маску в `causes.ts`**: `causeInputOf`
  (`server/acceptance/runner.ts`) копирует поля метрик поимённо и не знает про `edgeResidual`
  (как, впрочем, и `gates/visual.ts` не кладёт в метрики `channelStats` — доволновой пробел
  W5b). Обе правки — по одной строке в файлах **чужой** зоны владения (§6: `server/acceptance/**`),
  поэтому вынесены наружу этой волны: контракт со стороны `causes.ts` готов и покрыт unit-тестом.

### R7b — Diagnostic bundle визуального рана

**Объём.** `GET /api/visual-runs/:runId/bundle.zip` (P1.5): `reference.png`, `candidate.png`, `diff-perceptual.png`, `diff-exact.png`, `edge-mask.png`, `reference-receipt.json`, `candidate-receipt.json`, `report.json`, `SHA256SUMS`; `zipResponse` + `sanitizeEvidenceName`, потолок `evidenceMaxBytes`, фиксированный mtime. Receipt эталона старше TTL — из пина (R6), отсутствующий — честный `reference-receipt: null` в `report.json`.
**Файлы.** `server/routes/visual.ts`, `server/visual/service.ts`, contracts/openapi/sdk, `docs/server-api.md`.
**Done.** e2e: bundle одного рана содержит все артефакты, sha сходятся; `verify`. **Замер K5 «после»** (дельта к R0-baseline, ≥3 семьи, флаги ON в тест-стенде) — триажом приёмки R7b (2026-08-04) перенесён в runtime-приёмку §7: он требует прод-подобных данных и включённых флагов, у волны их нет по построению. Также приёмкой зафиксировано: пиксельная работа bundle — синхронно в API-процессе с конкуренцией 1 (очередь), потолок 413 на практике недостижим (ассеты ≤5MiB), девятифайловый архив в e2e покрыт частично (diff-ассет в preview-стенде не рождается — unit добивает).

### R8a — Один рендерер: убрать локальный браузер из `shoot`

**Объём.** (Замок драйвера; параллелится с R5–R7 — контрактов не трогает.)
- `driver.mjs`: `shoot` больше не делает `chromium.launch()`; алиас `snap --all-screens`. Escape-hatch `--local-browser` не сохраняется.
- Предполётная сверка `capabilities.renderer` с предупреждением.
- Доки: `.claude/skills/author/SKILL.md` (строки про «локальный playwright», troubleshooting `Cannot find package 'playwright'`), `.claude/skills/yp-prototype/SKILL.md:130` (форс-login `shoot`), **`share/yp-figma-rebuild-skill/reference/easy-ui-authoring.md`** (ручной справочник — вне sync-скрипта; T-m18), рецепт офлайн-съёмки `docker run` в `docs/server-api.md`.
- `scripts/sync-share-skills.mjs` — синк обоих зеркал.

**Файлы.** `.claude/skills/author/driver.mjs` + зеркала (sync), `.claude/skills/{author,yp-prototype}/SKILL.md`, `share/yp-figma-rebuild-skill/reference/easy-ui-authoring.md`, `test/driver-*.test.ts`, `docs/server-api.md`.
**Done.** grep: `chromium.launch` отсутствует в драйвере и обоих зеркалах; drift-чек `sync-share-skills --check`; `verify`.

### R8b — Receipt в CLI + офлайн-рецепт с проверкой (после R5)

**Объём.** `--receipt <file.json>` у `snap`/`preview`; `--json` печатает `receiptSha256`, `renderer.rendererFingerprint`, `codes[]` (контракт R5/R3 — поэтому строго после R5, T-M3). Автоматическая проверка офлайн-рецепта: корпус, снятый `driver.mjs snap` против сервера в контейнере, и корпус `docker run` того же образа сверяются по `expected.json` (K2).
**Файлы.** `driver.mjs` + зеркала, `.claude/skills/*/SKILL.md`, `test/driver-*.test.ts`, `docs/server-api.md`.
**Done.** K2-проверка: `exact-rgba = 0` (или зафиксированный §1-порог); `verify`.

### R9 — P2: пул и кэш (подволны последовательны, после R7)

**R9a — тёплый пул воркеров.**
**Объём.** `scripts/screenshot-pool-worker.mjs` — долгоживущий процесс, NDJSON-протокол (`screenshot-worker.mjs` остаётся каноном strict-режима, не трогается). Один `browser`, новый `BrowserContext` на джобу, `context.close()` обязателен; deny-proxy долгоживущий (launch-аргументы фиксируют порты) — смена `captureOrigin` ⇒ ресайкл. Ресайкл: 20 джоб / TTL / порог RSS / всегда после не-`ok` `jobOutcome`. `server/screenshot/worker-runner.ts` — второй `RunJob`-имплемент, выбор `EASYUI_RENDERER_POOL`. Правило «один тяжёлый подпроцесс» family-плана §4.6 **пересматривается от фактических ресурсов R0** (N9): при подтверждённых ≥2 CPU — параллель diff/ink с capture и поднятие конкуренции capture (сегодня 1) как измеряемые опции. `scripts/measure-capture.mjs` — cold/warm p95, RSS.
**Файлы.** Новые: `scripts/screenshot-pool-worker.mjs`, `scripts/measure-capture.mjs` (+тесты). Изменяемые: `server/screenshot/worker-runner.ts`, `server/screenshot/service.ts`, `package.json`, `docs/server-api.md`.
**Done (численно).** тест «контекст не течёт» (cookie/localStorage/`__EUI_CAPTURE_BOOTSTRAP__`); тест «egress-граница в пуле» (дословные args + route-allowlist); корпус под пулом даёт те же sha256; замер: **прод ON, если warm p95 ≤ 1,0 с/case и устойчивый RSS контейнера ≤ 75% фактического `mem_limit` (после ревизии R0) под нагрузкой корпуса; иначе пул остаётся dev/CI-only — валидный результат волны**; `verify`.
**Флаг.** `EASYUI_RENDERER_POOL=1`, прод — по замеру.

**Статус (2026-08-04): выполнено, вердикт замера — `prod-on`.** `scripts/screenshot-pool-worker.mjs`
импортирует из strict-воркера всё, что влияет на растр и на границу egress (собственного списка
launch-аргументов у пула нет вовсе — тест), контекст закрывается в `finally`, ресайкл — по пяти
причинам (`origin_changed`/`job_failed`/`job_budget`/`ttl`/`rss`, чистая функция `recycleReason`).
Выбор имплемента живёт **внутри** `spawnWorker` (`worker-runner.ts`), поэтому `server/main.ts` и
`service.ts` волной не тронуты вовсе. Факты: корпус под пулом — **0/240** расхождений sha256
(813 мс/капчур), warm p95 **705–709 мс**, устойчивый RSS **812–823 МБ** (20% `mem_limit: 4g`) —
§4. Осознанные сужения: (а) ручка конкуренции capture не вводится (§4, обоснование замером);
(б) статистика пула (`PoolJobStats`) наружу по HTTP не выставляется — она нужна замеру и тестам,
а не клиенту; (в) в `docker-compose.yml` `EASYUI_POOL_*`-тюнинг не проброшен (дефолты зашиты;
`docker-compose.yml` — зона R0, и прод-включение самого флага идёт по чек-листу §7).

**R9b — content-addressed кэш не-acceptance путей.**
**Объём.** `server/capture/captureCache.ts`: ключ `sha256({rendererFingerprint, expected (handshake-снимок), propsHash, surface, readinessPolicyHash, probe, deliver, paintMargin, fontManifestHash})`. Хранилище `<dataDir>/.capture-cache/`, потолок **256 МБ**, LRU, GC on start/on write. Asset-путь кэширует `assetId` (повторный `ingest` дедуплицируется). Ответ несёт `cache:{status,key,reason}`. Acceptance не использует (E7). `--refresh` ⇒ `bypass`. Контент ассетов в ключ не входит **обоснованно**: ассеты content-addressed (`asset_<sha256>`), смена содержимого ⇒ новый id ⇒ новый `propsHash`/`dsMetaVersion` (§8).
**Файлы.** Новые: `server/capture/captureCache.ts` (+тест). Изменяемые: `server/screenshot/service.ts`, `server/routes/screenshots.ts`, `driver.mjs` + зеркала (`--refresh`; замок драйвера — после R8b), contracts/openapi/sdk, `docs/server-api.md`.
**Done.** K6: повторный `snap` → `hit`, ноль спавнов воркера (счётчик через seam `deps.runJob`); «смена темы/DPR/props/рендерера — всегда miss»; «кэш не отдаёт кадр без receipt'а»; `verify`.
**Флаг.** `EASYUI_CAPTURE_CACHE=1` (opt-in).

---

## 6. Владение файлами и параллелизм

| Файл | Волны | Правило |
|---|---|---|
| `server/migrations.ts` | R6 (v28+) | строго серийный; единственная миграция пакета |
| `server/capture/renderer.ts`, `rendererPin.json` | R1, R2a (флаги в хеш) | серийно |
| `scripts/screenshot-worker.mjs` | R2a, R3, R5 | серийно; `buildLaunchArgs` — дословно тестируемая, сигнатуру не трогать |
| `scripts/screenshot-pool-worker.mjs` | R9a | эксклюзив; strict-воркер не трогается |
| `server/screenshot/service.ts` | R1, R2a, R3, R4, R5, R9a/b | серийно; владелец — текущая волна |
| `server/screenshot/worker-runner.ts` | R9a | эксклюзив (R1 его не правит — манифест читает `renderer.ts`) |
| `src/capture/{readiness.ts,readinessPolicy.ts,protocol.ts}` | R3, R4 | серийно; R3 перед R4 |
| `src/capture/env.ts` | R1 (переименование) | эксклюзив |
| `src/capture/{failureCodes.ts,stability.ts,receipt.ts}` | R3 / R4 / R5 | новые файлы, эксклюзив волны-создателя |
| `src/capture/{CaptureComponent.tsx,CaptureSurface.tsx}` | R4 | эксклюзив |
| `server/acceptance/ids.ts` | R1 | эксклюзив; единственный bump |
| `server/acceptance/{policies.ts,gates/**,runner.ts}` | R1, R3, R4, R5, R6 | серийно; новые гейты не вводятся |
| `server/visual/**`, `scripts/visual-diff-worker.mjs` | R6, R7a/b | серийно; `server/visual/fingerprint.ts` **не трогается никем** (N6) |
| `server/routes/screenshots.ts` | R3, R5, R9b | серийно |
| `server/routes/{visual,visualBaselines}.ts` | R6, R7b | серийно |
| `server/capture/{modes.ts,receiptStore.ts,captureCache.ts}` | R4 / R5(+R6 пины) / R9b | эксклюзив волны-создателя |
| `server/contracts.ts`, `server/openapi.json`, SDK | почти все | **инвариант: в любой момент правит ровно одна волна** (R8a контрактов не трогает — только поэтому параллелится); в конце волны `generate:openapi` + `generate:sdk` + drift-чеки; сгенерированное не правится руками |
| `server/main.ts`, `server/routes/meta.ts` | R1, R5, R6, R7b | append-only; конфликт решает волна с бóльшим номером |
| `package.json` | R1, R2b, R9a | серийно |
| `docs/server-api.md` | R0–R9 | append-only по секциям волны |
| `.claude/skills/**` + зеркала + `sync-share-skills.mjs` + `share/yp-figma-rebuild-skill/reference/*` | R8a, R8b, R9b | «замок драйвера»: одновременно правит одна волна |
| `Dockerfile`, `docker-compose.yml` | R0 | эксклюзив |
| `.github/workflows/build-image.yml` | R0 (build-args), R2c (перестройка) | серийно |
| `playwright.config.ts` | R2a | эксклюзив |
| `e2e/fixtures/renderer-corpus/pixel/**` | R2b | `expected.json` (sha-часть) меняется только с bump'ом `RENDERER_VERSION` |
| `e2e/fixtures/renderer-corpus/outcome/**` | R2b (создание), R4 (ожидания) | typed-коды; владение переходит R4 (T-M2) |
| `scripts/renderer-manifest.mjs` | R0 | эксклюзив |
| `scripts/check-renderer-pin.ts` | R1 | эксклюзив |
| `scripts/{renderer-corpus,measure-capture,rebaseline-all}.mjs` | R2b/R2c, R9a, R6 | эксклюзив волны-создателя |

**Параллельные пары:** (R8a ‖ R5), (R8a ‖ R6), (R8a ‖ R7a/b). R8b — строго после R5. R2a/R2b/R2c/R3/R4 не параллелятся между собой. Всё остальное — последовательно.

---

## 7. Верификация

**Инженерный гейт каждой волны:** `npm run verify` (включая openapi+sdk drift и `verify:renderer`) + целевые e2e-спеки; capture-зависимые спеки — в `e2e/preview/`. `npm run e2e` целиком — перед закрытием пакета.

**Runtime-приёмка (по `.claude/skills/verify`) и чек-лист прод-включения:**
1. `GET /api/capabilities` и `/api/health` на проде отдают секцию `renderer`, совпадающую с `docker run <image> cat /app/renderer-manifest.json`; `browserExecutableSha256` — от headless-shell.
2. Интерактивный `driver.mjs snap` возвращает `receiptSha256`; `GET /api/screenshot-jobs/:id/receipt` — документ с `renderer`, `fontFaces` (`checked:true`), `timings`, `surfaceRect` (закрытие §1.6).
3. Фикстуры: «нет font asset» ⇒ `font_face_missing` без вердикта; «битое изображение» ⇒ `image_load_failed`; «поздняя мутация» ⇒ `layout_unstable` (K3/K4).
4. Корпус: CI-гейт блокирует деплой (намеренно сломанное ожидание — job `deploy` не стартует); `docker run <prod-image> … --verify` — 0/240; soft cross-host факт вписан в §4.
5. Legacy-эталон прода при выключенных флагах → вердикт как до пакета + `renderer_unknown`; ни один существующий ран не сломался.
6. **Прод-включение флагов (строгий порядок):** (а) инвентаризация эталонов (`rebaseline-all.mjs --dry-run`, число в план); (б) бэкап prod-volume; (в) maintenance-окно: `EASYUI_RENDERER_FLAGS=1` + `EASYUI_RENDERER_EPOCH`; (г) `rebaseline-all.mjs` — массовое переснятие; (д) проверка: старый непереснятый эталон ⇒ `error/stale_renderer` без ложного процента, переснятый ⇒ `matched`; (е) точка невозврата зафиксирована — откат далее только с restore бэкапа (абзац в `docs/server-api.md#deployment`).
7. `POST /api/acceptance-runs` на кандидате прошлого пакета: reuse не сработал (bump 4→5), холодный ран в бюджете §4; повторный — `reused: N/N`; **окно (6) и холодная пересъёмка приёмки разнесены по времени**.
8. Диск: `du` по **всем** каталогам — `assets/`, `.acceptance/cas`, `.candidates`, `.receipts`, `.capture-cache`, SQLite+WAL — после 500 капчуров и после rebaseline; потолки соблюдены; рост `assets/` от переснятия зафиксирован числом.
9. Миграция R6 (v28+) на копии прод-БД; чек-лист отката: старый образ на БД с миграцией R6 стартует (цикл `migrate()` пуст — проверено), эталоны читаются (SELECT * совместим — тест-инвариант R6), `.receipts`/`.capture-cache` при откате не растут **и не освобождаются** (кода нет — сказано явно), точка невозврата — п.6е.

---

## 8. Явные не-цели

- **Отдельный `ghcr.io/vladprrs/easy-ui-renderer` image** (N3).
- **Renderer в ключе `visual_references.fingerprint_json`** (N6); `server/visual/fingerprint.ts` не правится.
- **Новый статус в `visual_runs.status`** (N7).
- **Публичный API-параметр `mode` (P2.3)** — отложен осознанно (S-S1): суть режимов покрыта политиками R4 + receipt R5 + guard R6 + bundle R7b; `resolveCaptureMode` — внутренний. Возврат — отдельным решением при появлении потребителя.
- **`assetManifestHash`** — не вводится: контент ассетов content-addressed (`asset_<sha256>`), смена контента меняет id и, следовательно, `propsHash`/тему; хеш поверх был бы тавтологией (T-M11 закрыт обоснованием).
- **`EASYUI_IMAGE_REF`/прокидка digest в Dokploy** — исключено (S-m3/T-m15).
- Точный ICC-профиль — best-effort (наследие family-плана §8).
- Автопереснятие эталонов по расписанию, lifecycle exceptions, promotion baseline'ов, VDC 2.0 целиком; гейты `regression`/`interactions`.
- Golden-PNG в git; фиксация js-seed; `--deterministic-mode` без нужды по K1.
- GC ассет-стора (`assets/`) — признанный долг, **вне пакета** (рост от rebaseline фиксируется числом в приёмке).
- `.claude/skills/yp-prototype/interact.mjs` — третий `chromium.launch()` в репозитории, **осознанно вне R8a**: это interaction-прогон живого плеера, не capture; его кадры не участвуют ни в эталонах, ни в приёмке (V-N12).
- Кэширование acceptance-путей; geometry-сигнал для prototype-screen (N8).

---

## 9. Риски

| Риск | Sev | Митигация |
|---|---|---|
| Включение флагов обесценивает прод-эталоны; guard молчит на legacy (`unknown` = advisory) | high | N11: эпоха + `stale_renderer` (терминальный, без ложного процента); включение только с инвентаризацией и `rebaseline-all.mjs` в maintenance-окно (§7.6) |
| Fingerprint хеширует не тот бинарь (headless-shell vs chrome) | high | закрыто конструкцией E1/N1 (sha фактически запускаемого + `launchedExecutable` + тест R2a на приём флагов) |
| Cross-host байт-идентичность (K2) недостижима | high | двухуровневый гейт; порог-фолбэк ≤50 ppm edge-only зафиксирован §1 **до** старта; вердикт — done R2c |
| Дрейф базового образа `node:24-slim` меняет fingerprint/красит корпус | high | пин `@sha256` + bump-канон `rendererPin.json` (T-M5) |
| Массовое переснятие: операционная стоимость и конкуренция за очередь | high | `rebaseline-all.mjs` с rate-limit; окно разнесено с холодной приёмкой (§7.7); инвентаризация до включения; при подтверждённых ресурсах R0 — поднятие конкуренции capture (R9a) |
| OOM от пула при недостаточном лимите | med (после ревизии R0) | численный критерий включения (R9a done) от фактического лимита; ресайкл по N/TTL/RSS |
| Диск: `.receipts` + `.capture-cache` + **orphan-рост `assets/` от rebaseline** | high | потолки 64/256 МБ + TTL + пины; `du` по всем каталогам в приёмке; рост `assets/` фиксируется числом (GC ассетов — долг вне пакета, §8) |
| `receipt_sha256` эталона ссылается в TTL-стор | med | авторитет — инлайновый `renderer_json`; пин-провайдер (R6); bundle честно отдаёт null |
| Hard-fail сверки версии валит все капчуры прода | med | сравнение major.minor.build; `EASYUI_RENDERER_STRICT_MANIFEST=0`; self-check на старте + `/api/health` |
| CI-корпус флаки красит main | med | гейт только в main/nightly (PR — 12×3); карантин фикстуры; K1 = 0/240 с оговоркой о стат-мощности |
| `check()` ложно на variable-шрифтах; required-faces требуют неиспользуемое | med | `check()`-авторитет + нормализация диапазона весов; правило declared ∩ used (T-M10); unit-фикстуры |
| `layout_unstable` ложно на субпиксельном джиттере | med | округление 1/64 px; ≤3 попытки; фикстура «стабильный × 100 → 0 срабатываний» |
| Реклассификация R7a скрывает регрессию | med | opt-in; инвариант «остаток вне маски ≠ `renderer_residual`»; калибровка T на реальных парах |
| Пул течёт состоянием / ломает egress | med | `context.close()`, ресайкл, тест-инварианты (cookie/bootstrap/args) |
| Кэш отдаёт устаревший кадр | med | ключ = полный handshake + fontManifestHash + renderer + policy; content-addressed ассеты (§8); receipt всегда |
| Второй `playwright-core` через каретку `@playwright/test` | med | точный пин в R1 + проверка единственности в `verify:renderer` |
| Расхождение хеша флагов и фактических args воркера | med | args в payload джобы, воркер env не читает (T-m17); контекст-опции — экспортируемая хешируемая константа |
| Удаление локального `shoot` ломает сценарий | low | алиас `snap --all-screens`; доки/зеркала/справочник в объёме R8a |

---

## 10. Сводка по флагам

| Флаг | Волна | Дефолт dev/CI | Дефолт прод | Снятие |
|---|---|---|---|---|
| `EASYUI_RENDERER_FLAGS` | R2a | ON | OFF → ON по чек-листу §7.6 | после переснятия эталонов |
| `EASYUI_RENDERER_EPOCH` | R6 | не задан (эпоха = `manifest.rendererVersion`) | не задан; env — только override (N11/V-N5) | — |
| `EASYUI_RENDERER_STRICT_MANIFEST` | R1 | не задан (strict) | не задан (strict) | аварийный (=0 → warning) |
| `EASYUI_CAPTURE_RECEIPTS_DISABLED` | R5 | не задан | не задан (включено) | kill-switch |
| `EASYUI_RENDERER_GUARD_DISABLED` | R6 | не задан | не задан (включён) | kill-switch |
| `EASYUI_VISUAL_SIGNALS_V2` | R7a | ON | OFF → ON после приёмки | после приёмки |
| `EASYUI_RENDERER_POOL` | R9a | ON | по замеру R9a (критерий от лимита R0) | по численному критерию |
| `EASYUI_CAPTURE_CACHE` | R9b | ON | OFF | после приёмки K6 |

Все переменные пробрасываются в `docker-compose.yml` **в R0** (канон W0 family-плана).

---

## 11. Триаж Stage 2 (раунд 1)

Ревьюеры: C — корректность/код, S — скоуп/декомпозиция, T — риски/эксплуатация. **Принято** = внесено в v2; **отклонено** = с обоснованием. Дополнительно v2 включает поправку пользователя: лимиты `mem_limit: 1g`/«1 CPU» — перестраховка, прод-хост мощнее → N9 переписан, R0 получил ревизию ресурсов, ресурсные критерии (пул, конкуренция, бюджет) пересчитываются от фактического лимита.

**Принятые blocker'ы.**
- C-B1 = T-M6: рендерит `chrome-headless-shell`, а `executablePath()` возвращает полный chrome → E1/N1 переписаны (sha фактически запускаемого бинаря, `launchedExecutable`, пробой `browser.version()` в build-слое, тест приёма флагов в R2a).
- C-B2: `beginCheck` синхронный, receipt кандидата появляется в `drive()` → guard перенесён в `drive()` перед `runDiff` (E5), терминализация через `finalizeCaptured`.
- T-B1: guard не защищает legacy-эталоны при включении флагов (unknown=advisory ⇒ массовый ложный процентный fail; `runCheck` драйвера падает) → N11: `EASYUI_RENDERER_EPOCH` + `stale_renderer`, включение только с rebaseline-окном.
- T-B2: baseline-`assetId` рождён серверным капчуром — «NULL навсегда» делал guard мёртвым → индекс `assetId→receiptSha` (R5), резолв renderer'а на commit (R6), NULL только для чужих PNG.
- T-B3: ручка receipt «по sha» нарушала инвариант W1a (cross-owner канал) → N12: job-scoped `GET /api/screenshot-jobs/:id/receipt`, «по sha» нет.
- T-B4: CI-job не мог гейтить деплой (один job build+push+deploy) → N13: build(SHA) → corpus → deploy(latest) в R2c.
- S-B1: нет бюджета, битые ссылки на §4/§5, четыре точки инвалидации reuse не названы → новый §4 (стоимость, точки, пороги решений).
- S-B2: K2-фолбэк без числа и владельца → порог ≤50 ppm edge-only в §1, решение — done R2c; автоматическая проверка офлайн-рецепта — R8b.

**Принятые major (сводно).** C-M2 (srgb/hide-scrollbars уже передаёт playwright → §1.1/§2.1 переписаны, «дублировать явно»), C-M3 (`browsers.json` через require.resolve), C-M4 (fc-list нет в slim → собственный обход шрифтов), C-M5 (маппинг не биективен, `images_timeout` пропущен → `reason` отдельное поле, полный маппинг), C-M6 (prototype-путь/ДС без темы/несуществующий `enqueueComponentDraftBytes` → R4 и N4 переписаны: фактические методы, расширение резолва themeContent, K3-оговорка для `fonts:[]`), C-M7 = T-M9 (SELECT * существуют в 4 местах → done R6 переформулирован в проверяемый инвариант), C-M8 (geometry-probe без PNG → `output|null`), C-M9 (ARG перед манифест-RUN), T-M5 (пин node:24-slim по digest), T-M7 (major.minor.build + `EASYUI_RENDERER_STRICT_MANIFEST` + единственность playwright-core + пин `@playwright/test` + health), T-M8 (rollback-политика: точка невозврата, бэкап, абзац в deployment-доке), T-M10 (инвентаризация + `rebaseline-all.mjs` + окна разнесены), T-M11 (дисковый периметр всех каталогов + orphan-рост assets/ назван риском), T-M12 (пин receipt'ов эталонов; авторитет — инлайновый `renderer_json`), T-M13 (гейт 0/240 в main/nightly, PR 12×3, карантин), T-M14 (soft-гейт → CI-артефакт + факты в §4), S-M1 (R2 → R2a/R2b/R2c), S-M2 (корпус pixel/outcome, владение outcome → R4), S-M3 = C-m17 (R8 → R8a/R8b, R8b после R5), S-M4 (таблица §6 дополнена + инвариант одного владельца contracts), S-M5 (инвентаризация растр-зависимых CI-артефактов в R2a), S-M6 (K1: 0/240 + nightly, оговорка о стат-мощности), S-M7 (K5: baseline-замер в R0, дельта на ≥3 семьях), S-M8 (R9a: блок «Файлы» + численные критерии), S-M9 (edge-маска — вход `causes.ts`, калибровка T, bundle → R7b), S-M10 (правило declared ∩ used + парсинг assetId/sha — явный объём), S-M11 (`assetManifestHash` → обоснованная не-цель §8).

**Принятые minor.** C-m10 (фактический роут `PUT /api/visual-baselines/prototypes/:id`), C-m11 (headless-shell-only флаги + тест), C-m12 (receipt.json кладут фактические гейты — формулировки исправлены), C-m13 (парсинг assetId/sha из src/id), C-m14 (async-инициализация fingerprint), C-m16 (`modes.ts` — в файлы R4), C-m18 (контекст-опции — экспортируемая хешируемая константа), C-обзор (переименование в `observedCaptureEnvFingerprint`), T-m16 (dev-фолбэк не бросает, null-деградация, e2e в dev), T-m17 (args в payload, не env), T-m18 (yp-prototype SKILL + ручной справочник — в объём R8a), T-m19 (правило тяжёлого подпроцесса — пересмотр в R9a от ресурсов R0), T-m20 (отсутствие артефакта при reuse ⇒ пересъёмка), S-m1 (бэкап → pre-flight R6), S-m2 (done soft-гейта получил критерий), S-m4 (`bunVersion` → provenance), S-m6 (носитель счётчика K6 — seam `deps.runJob`).

**Отклонено / принято частично.**
- S-S1 «выкинуть R9c»: **принято** — публичный `mode` отложен (§8), `resolveCaptureMode` остаётся внутренним (R4); снимает и конфликт замка драйвера.
- S-S2 «пул в отдельный пакет»: **отклонено** — P2.1 явное требование документа; вместо выноса — численный критерий включения и признание «dev/CI-only» валидным исходом. С учётом ревизии ресурсов (N9) шансы прод-включения выросли — ещё один довод оставить волну в пакете.
- S-m7 «receipts как неймспейс acceptance-CAS»: **отклонено** — семантики GC разные (TTL/LRU против runId-refcount); связывание контуров — новый класс инцидентов. Компенсация: пин-провайдер и общий канон кода GC.
- S-m8 «K8 не KPI»: **принято к сведению** — K8 помечен инженерным инвариантом в §1.
- T-m15/S-m3 `EASYUI_IMAGE_REF`: **принято, исключён** (R0).
- S-m5 «точка отсчёта preview»: снят вместе с откладыванием публичного `mode` (S-S1).

### Раунд 2 (верификационный)

Все 8 blocker'ов раунда 1 подтверждены закрытыми (C-B2, T-B4, S-B1 — чисто; остальные — с оговорками, закрытыми ниже). Внесено в v3:
- **V-N1 (major, принято)**: порог K2 «≤50 ppm внутри edge-маски» был неисполним в R2c (маска появляется в R7a) → K2 разведён: R2c = cross-host ≤50 ppm **суммарно**, edge-квалификация — после R7a, local-vs-server — R8b (заодно V-N11).
- **V-N2 (major, принято)**: corpus-job гонял бы образ с выключенными флагами (прод-дефолт OFF) → `EASYUI_RENDERER_FLAGS=1` явно в job.
- **V-N3 (major, принято)**: `rebaseline-all.mjs` не покрывал component-scope эталоны (generic `PUT /api/visual-references`) → покрывает оба scope.
- **V-N4 (major, принято)**: receipt умирал вместе с джобой (`RESULT_TTL` 10 мин + `reapExpired`) → индекс `jobId → {receiptSha, ownerKey}` с TTL стора; тот же job-scoped роут, авторизация по сохранённому ownerKey; инвариант «нет ручки по sha» не тронут.
- **V-N5 (medium, принято)**: эпоха доопределена (N11): дефолт из `manifest.rendererVersion`, env — override; EPOCH без FLAGS игнорируется; снапшот флагов на `beginCheck` для in-flight; `renderer_mismatch` приоритетнее `stale_renderer`; пересъёмка dev/e2e-эталонов — done R6.
- **V-N6 (medium, принято)**: пробой `chromium.launch()` в root-окружении BuildKit → явные args (`--no-sandbox --disable-dev-shm-usage`) + фолбэк `--version`; локация shell — `registry.findExecutable`.
- **V-N7/V-N8 (medium, принято)**: порядок записи `assetId`-индекса — после `ingest`; rebaseline пишет `renderer_json` инлайном из результата джобы, не через LRU-стор.
- **V-N9–N16 (minor, принято)**: пятая точка инвалидации (§4); «пяти каталогам + SQLite/WAL»; `server/routes/visual.ts` в файлы R6; `interact.mjs` — обоснованная не-цель §8; сигнатуры `finalizeCaptured`/`terminalRow`/`runReport` — явный объём R6; строки §6 для новых скриптов; ключ `cpus` в compose (R0).
