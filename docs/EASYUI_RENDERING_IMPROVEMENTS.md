# Улучшение screenshot renderer в easy-ui

Дата анализа: 2026-08-03  
Репозиторий: `vladprrs/easy-ui`, commit `f5eaa65860552ec7e05d45bbd9691482a9afaf6d`

## Зачем это нужно

Screenshot pipeline easy-ui уже обеспечивает изолированный запуск Chromium, фиксирует viewport/DPR/theme, блокирует внешнюю сеть, останавливает анимации и сохраняет `browserVersion`. Но сейчас два визуально и геометрически одинаковых компонента могут давать заметный pixel diff из-за различий окружения, шрифтов и момента съёмки.

На реальном `pay-card` получен остаток относительно server Chromium:

- exact/raw diff: `0,6974%`;
- perceptual diff с исключением anti-aliasing: `0,2870%`;
- основные кластеры различий находятся вокруг текста и badge;
- размер и геометрия поверхности совпадают.

Это делает итерационный цикл дорогим: разработчик начинает исправлять CSS там, где различие создано самим renderer.

## Текущее поведение

По состоянию на указанный commit:

- production image основан на `node:24-slim`;
- Chromium устанавливается командой Playwright во время Docker build;
- сервер использует Playwright `1.61.1`;
- browser context фиксирует viewport, DPR, color scheme, locale, timezone и reduced motion;
- readiness ожидает `document.fonts.ready` и вызывает `decode()` для изображений;
- исключения загрузки шрифтов и изображений подавляются;
- screenshot создаётся сразу после публикации readiness;
- сохраняются `browserVersion` и `rendererBuild`, но не полный fingerprint окружения;
- visual comparison отдаёт exact RGBA и pixelmatch-метрики.

## Основные проблемы

### 1. Нет единого renderer contract

Локальный capture и сервер могут использовать разные:

- ОС и font rasterizer: CoreText на macOS против FreeType/Skia на Linux;
- версии Playwright и Chromium;
- бинарные файлы шрифтов;
- цветовые профили;
- системные библиотеки и параметры font hinting.

При таких различиях exact pixel equality для текста недостижимо даже при одинаковом DOM и CSS.

### 2. Readiness не гарантирует корректную загрузку ресурсов

`document.fonts.ready` показывает, что текущий цикл загрузки завершён, но не доказывает, что обязательное семейство и вес действительно доступны. Исключение также считается допустимым.

Аналогично, ошибка `img.decode()` подавляется. Capture может завершиться успешно с fallback-шрифтом или битой картинкой.

### 3. Не проверяется стабильность layout

После readiness отсутствуют:

- два последовательных `requestAnimationFrame`;
- повторное измерение поверхности;
- проверка, что размеры и позиции перестали изменяться;
- диагностика поздних DOM/layout mutations.

### 4. Недостаточно данных для воспроизведения результата

`browserVersion` полезен, но его недостаточно. По screenshot receipt нельзя однозначно восстановить окружение, шрифты и параметры запуска.

### 5. Один процент смешивает разные причины

Пользователю трудно понять, чем вызван diff:

- изменением геометрии;
- другим цветом;
- anti-aliasing текста;
- отсутствующим asset;
- шумом renderer;
- реальной регрессией компонента.

## Целевой renderer contract

Каждый capture должен быть воспроизводимой функцией:

```text
PNG = render(document snapshot, renderer fingerprint, resource manifest, capture options)
```

Если любой вход неизвестен или обязательный ресурс не загрузился, результат не должен считаться чистым эталонным capture.

### Renderer fingerprint

В metadata каждого screenshot следует сохранять:

```json
{
  "rendererSchema": 2,
  "rendererBuild": "...",
  "dockerImageDigest": "sha256:...",
  "os": "linux",
  "arch": "arm64|x64",
  "nodeVersion": "...",
  "playwrightVersion": "...",
  "browserName": "chromium",
  "browserVersion": "...",
  "browserRevision": "...",
  "deviceScaleFactor": 1,
  "colorProfile": "srgb",
  "locale": "ru-RU",
  "timezone": "Europe/Moscow",
  "fontManifestHash": "sha256:...",
  "assetManifestHash": "sha256:..."
}
```

Fingerprint должен участвовать в ключе visual baseline. Сравнение результатов разных fingerprint необходимо явно помечать как cross-renderer comparison.

## Предлагаемые изменения

### P0 — достоверность результата

#### P0.1. Один renderer для сервера и локального инструмента

Опубликовать versioned renderer image, например:

```text
ghcr.io/vladprrs/easy-ui-renderer:<renderer-version>@sha256:<digest>
```

И сервер, и локальный CLI должны запускать capture в этом image. Обновление Chromium становится осознанной миграцией renderer version, а не побочным эффектом rebuild.

Критерий приёмки: один и тот же fixture, снятый локально и в production image, даёт `exact-rgba = 0`.

#### P0.2. Строгая проверка шрифтов

Capture request должен содержать или вычислять список обязательных font faces:

```json
[
  { "family": "YS Text", "weight": 400, "style": "normal", "assetId": "...", "sha256": "..." },
  { "family": "YS Text", "weight": 500, "style": "normal", "assetId": "...", "sha256": "..." }
]
```

До screenshot необходимо:

1. дождаться `document.fonts.ready`;
2. вызвать `document.fonts.load()` для каждого обязательного face;
3. проверить `document.fonts.check()`;
4. убедиться, что `FontFace.status === "loaded"`;
5. вернуть `font_load_failed`, если проверка не прошла.

Не следует считать fallback допустимым для reference/verification capture. Для интерактивного preview можно сохранить best-effort режим отдельно.

#### P0.3. Строгая проверка изображений

Для каждого изображения внутри capture surface проверять:

```text
complete === true
naturalWidth > 0
naturalHeight > 0
decode() завершился успешно
```

В receipt сохранять URL/asset ID, intrinsic dimensions и content hash. Ошибку обязательного изображения возвращать как `image_load_failed`.

#### P0.4. Стабилизация перед screenshot

После готовности fonts/images:

1. дождаться двух `requestAnimationFrame`;
2. измерить capture surface и отмеченные geometry nodes;
3. дождаться ещё одного кадра;
4. повторить измерение;
5. продолжить только при совпадении измерений.

Добавить небольшой ограниченный retry, например три измерения, но не фиксированную задержку в сотни миллисекунд.

#### P0.5. Явный sRGB

Запускать Chromium с `--force-color-profile=srgb` и записывать значение в fingerprint.

### P1 — диагностика и сокращение итераций

#### P1.1. Capture receipt

Возвращать рядом с PNG машиночитаемый receipt:

- renderer fingerprint;
- resolved component/theme revisions;
- загруженные font faces и hashes;
- список изображений и их состояние;
- console errors/warnings и page errors;
- viewport, DPR и фактический размер PNG;
- bounding rect capture surface;
- длительности navigation/fonts/images/settle/screenshot;
- `captureClean` и typed failure/warning codes.

Receipt следует сохранять как immutable artifact и включать его hash в visual run.

#### P1.2. Typed readiness failures

Вместо общего `capture_failed` использовать коды:

- `font_load_failed`;
- `font_face_missing`;
- `image_load_failed`;
- `layout_unstable`;
- `surface_missing`;
- `surface_overflow`;
- `renderer_mismatch`;
- `navigation_failed`;
- `runtime_error`.

Это позволит агенту исправлять причину с первой итерации, а не изучать PNG вручную.

#### P1.3. Разделение метрик

В visual report показывать минимум четыре независимых сигнала:

1. geometry diff — rect/size/position;
2. exact RGBA — строгая воспроизводимость;
3. perceptual diff без anti-aliasing;
4. text/edge residual — диагностическая маска вокруг глифов и контуров.

Статус не должен выводиться только из одного процента. Например, совпадающая геометрия и небольшой edge-only diff должны классифицироваться как `renderer_residual`, а не как неизвестная регрессия.

#### P1.4. Cross-renderer guard

Перед сравнением baseline и candidate проверять fingerprint. Если они различаются:

- не выдавать обычный pass/fail;
- возвращать `renderer_mismatch`;
- перечислять отличающиеся поля;
- предлагать переснять baseline или запустить совместимый renderer.

#### P1.5. Diagnostic bundle

Одним API-запросом отдавать архив или manifest ссылок:

- reference PNG;
- candidate PNG;
- exact diff;
- perceptual diff;
- geometry JSON;
- capture receipt;
- resolved HTML/CSS/resource manifest при допустимом уровне доступа.

Это существенно уменьшит число запросов к API и ручных повторов.

### P2 — производительность и удобство

#### P2.1. Тёплый browser pool

Сейчас отдельный Node process запускает отдельный Chromium на каждый job. Это даёт хорошую изоляцию, но дорого по времени.

Можно держать versioned worker pool с новым BrowserContext на каждый capture. Перед переиспользованием обязательно очищать контекст и сохранять текущую сетевую allowlist-изоляцию. Для недоверенного кода process-per-job можно оставить как strict mode.

#### P2.2. Content-addressed cache

Ключ кеша:

```text
hash(target snapshot + props + viewport + DPR + theme + renderer fingerprint + resource manifests)
```

Если ключ совпадает, возвращать существующие PNG, geometry и receipt без нового запуска Chromium.

#### P2.3. Capture modes

Разделить режимы:

- `preview`: быстрый best-effort;
- `verify`: строгие ресурсы и стабильность;
- `baseline`: strict verify плюс immutable fingerprint;
- `diagnostic`: дополнительные DOM/geometry/font artifacts.

Так интерактивная работа не замедлится из-за требований эталонного pipeline.

## Предлагаемый readiness алгоритм

```text
navigate(domcontentloaded)
  → verify readiness handshake and frozen target
  → wait/load/check required font faces
  → decode and validate all required images
  → disable animations, transitions and caret
  → requestAnimationFrame × 2
  → measure surface and marked nodes
  → requestAnimationFrame
  → measure again
  → require stable measurements
  → collect receipt
  → screenshot
  → validate PNG dimensions
  → persist PNG + receipt atomically
```

## Тестовый набор renderer

Нужен небольшой стабильный corpus:

- YS Text 400/500 с кириллицей, цифрами и знаками валют;
- текст на целых и дробных координатах;
- badge с текстом и border radius;
- SVG icon и raster image;
- opacity, shadow и gradient;
- auto-layout/flex/grid fixtures;
- DPR 1/2/3;
- light/dark theme;
- намеренно отсутствующий font asset;
- намеренно битое изображение;
- поздняя layout mutation.

Для corpus хранить ожидаемые geometry и PNG, созданные тем же renderer image. В CI проверять:

- повторный capture идентичен байт-в-байт;
- локальный container и CI дают одинаковый PNG;
- ошибки ресурсов завершаются правильными typed codes;
- смена renderer fingerprint требует явного обновления baseline.

## Метрики успеха

- не менее `99,9%` повторных capture одного входа имеют `exact-rgba = 0`;
- локальный и server capture в одном image совпадают полностью;
- ни один strict capture не проходит с fallback font или broken image;
- причина неуспеха определяется без ручного просмотра PNG;
- медианное число итераций component → verified screenshot снижается до `1–3`;
- повторный запрос с тем же cache key не запускает Chromium;
- p95 времени verify capture измеряется отдельно для cold и warm path.

## Рекомендуемый порядок внедрения

1. Добавить полный renderer fingerprint и capture receipt.
2. Сделать font/image readiness строгим в режиме `verify`.
3. Добавить frame/layout stabilization и sRGB.
4. Выпустить общий versioned renderer image и локальный CLI поверх него.
5. Включить cross-renderer guard в visual comparison.
6. Разделить geometry, exact, perceptual и renderer-residual сигналы.
7. После стабилизации correctness добавить content-addressed cache и browser pool.

## Что не стоит делать

- Не лечить renderer noise увеличением общего допустимого процента: это скроет небольшие реальные регрессии.
- Не использовать произвольный `sleep(500)` вместо проверки стабильности.
- Не считать `document.fonts.ready` достаточной проверкой конкретных face/weight.
- Не обновлять Chromium неявно через rebuild образа.
- Не сравнивать baseline и candidate с разными fingerprint как обычный visual regression run.

## Ожидаемый эффект для миграции дизайн-системы

После этих изменений агент сможет отличать ошибку CSS от шума среды автоматически. Вместо десятков циклов «сохранить → снять → посмотреть diff → попробовать ещё один offset» первый capture будет возвращать достаточные данные: совпала ли геометрия, какие именно шрифты использованы, загрузились ли assets и является ли остаток особенностью renderer. Это напрямую улучшит скорость переноса, качество компонентов и доверие к visual gates.
