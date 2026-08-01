# План: DX-подготовка харнеса к пересборке дизайн-системы из Figma

Дата: 2026-08-01 · Статус: v2 approved (ревью Stage 2 пройдено, триаж в конце)
Мотивация: скилл `share/yp-figma-rebuild-skill` (b8699f6) описывает цикл «атом за атомом» —
сотни вызовов харнеса и десятки публикаций. Источники трения устраняются до старта:
429-петля логина, provenance через лишнюю ревизию, невозможность честной @2x-сверки снапом.

Скоуп — **только клиентский харнес** (driver/auth) + синк share-пакетов. Серверные правки — вне скоупа.

## Целевые файлы и владение (по задачам)

| Задача | Файлы |
|---|---|
| T1 | `scripts/easyui-auth.mjs`, `scripts/easyui-auth.d.mts`, `server/driver-cli.test.ts` (кейсы кэша), `server/test-auth.ts` (если нужен счётчик — предпочтительно прямой `createHandler` в кейсах) |
| T2+T3 | `.claude/skills/author/driver.mjs` (общие `flagSpecs`/`usageLine` — поэтому **одна волна, один исполнитель**), `server/driver-cli.test.ts` (кейсы figma/snap), `server/driver-mjs.d.ts` (`DriverParsedArgs.flags`: добавить `viewport`/`theme`/`dsf`/`figma`) |
| T4 | share-копии, `.tgz`, доки (полный список в T4) |

Share-копии драйвера идентичны канону, кроме строки импорта auth (`./easyui-auth.mjs` вместо
`../../../scripts/…`) — синк механический: копия + правка импорта.

## T1 — кэш сессии в `easyui-auth.mjs`

Проблема: cookie живёт в памяти процесса; каждый вызов CLI = логин; лимит 5 логинов/мин
на аккаунт (`server/routes/auth.ts:9`) → `429 rate_limited` в любом плотном цикле.

Решение — файловый кэш cookie в `createEasyUiClient`:

- **Расположение**: каталог `$XDG_STATE_HOME/easyui` (fallback `~/.cache/easyui`), создаётся с
  `mode 0o700`; файл `session-<sha256(apiBase|username).slice(0,16)>.json`. Общий `os.tmpdir()`
  не используется (предсказуемое имя + симлинк-атака). Запись **атомарная**: `tmp` в том же
  каталоге + `rename`; открытие на запись с `flag: "wx"` у tmp. Переопределение пути —
  `$EASYUI_SESSION_FILE` (обязательно в тестах, см. ниже).
- **Формат**: `{cookie, apiBase, username, savedAt}`; чтение в try/catch — битый файл = нет кэша.
  **TTL**: кэш старше 24 ч игнорируется и удаляется (сессии серверные, это только гигиена диска).
- **Порядок**: (1) валидный кэш → использовать без логина; (2) `401` на запросе с cookie **из
  кэша**, и только с JSON-телом `error.code === "unauthorized"` (`server/auth.ts:50`) →
  однократный re-login + повтор запроса, новая cookie в кэш. Не-JSON 401 (внешний
  legacy-Basic барьер отвечает до резолва принципала, `server/main.ts:127`) не ретраится —
  сохраняется текущая диагностика про `EASYUI_LEGACY_BASIC_AUTH`; (3) кэша нет → логин как
  сейчас (+ запись кэша). Повторный 401 после re-login отдаётся вызывающему.
- **Инвалидация и single-flight** (ревью B2): мемоизация — и `cookie`, и `loginPromise`
  (`easyui-auth.mjs:28,32`); re-login обязан сбрасывать **обе** (+ удалять файл кэша), иначе
  вернётся старая cookie и 401 зациклится. Параллельные 401 (в драйвере есть `Promise.all`-пачки:
  `runGeometry`, `loadCatalog`, `runAudit`) дедуплицируются одним shared re-login-промисом —
  иначе пачка сама выест лимит 5/мин.
- **Идемпотентность повтора**: повтор тела после 401 безопасен, потому что глобальный auth-гейт
  (`server/main.ts:140-142`) отвечает 401 анонимному принципалу **до роутинга и до `readJson`**,
  т.е. до любого side-effect (включая `/api/assets` binary). Комментарий в auth-клиенте якорить
  именно на этот гейт (не на `requireUser` — тот бросает 403).
- **Публичный контракт**: `login()` по-прежнему форсирует логин (кэш при этом обновляется);
  `cookieHeader` заполняется и при использовании кэша (потребители `client.login()` +
  `client.cookieHeader` — `driver.mjs shoot`, `.claude/skills/yp-prototype/interact.mjs`,
  `scripts/perf-*.mjs` — не должны получить undefined). Эти login()-пути кэш не обходит:
  форс-логин остаётся форс-логином (429-совет в доках сохраняется как fallback).
- **Выключатель**: `EASYUI_SESSION_CACHE=0` — прежнее поведение, существующий файл кэша удаляется.
- Прочие потребители `scripts/easyui-auth.mjs` (`interact.mjs`, `scripts/perf-gallery.mjs`,
  `scripts/perf-library.mjs`, `scripts/generate-sdk.ts`, `scripts/calibrate-matcher.ts`,
  `scripts/w6-yandex-pay.mjs`) получают кэш автоматически — это цель, а не побочка; риск
  зафиксирован: смена поведения у них тоже покрыта выключателем.
- `easyui-auth.d.mts` — дополнить типы.

Тесты (`server/driver-cli.test.ts`): кейсы кэша поднимают **прямой `createHandler`** (без
`createTestHandler` — тот подмешивает admin-cookie в каждый запрос, `server/test-auth.ts:20`,
и доказательная сила нулевая) + счётчик `POST /auth/login` в обёртке. Сценарии: два
последовательных вызова драйвера → один логин; протухшая/чужая cookie в кэше → ровно один
re-login и успех; параллельная пачка запросов с протухшей cookie → один re-login;
`EASYUI_SESSION_CACHE=0` → логин на каждый вызов; не-JSON 401 → без ретрая. Все кейсы
**обязаны** задавать `EASYUI_SESSION_FILE` в tmpdir теста (сабпроцесс наследует env разработчика,
`driver-cli.test.ts` спавнит с `{...process.env}`; иначе прогоны сорят токенами в общий каталог
и флейкают между parallel-воркерами). Токен-фикстуры — формата `[A-Za-z0-9_-]{43}`.

## T2 — `--figma <file.json>` у `component`

Проблема: API принимает `figma` в `POST /components` и `PUT /components/:id`, драйвер — нет;
обходной путь (`api.mjs figma` = PUT + re-publish) создаёт лишнюю ревизию и версию на каждый компонент.

Решение:

- Флаг `--figma <path>` в `flagSpecs.component`; файл читается и парсится заранее: отсутствие
  файла или не-JSON → `invalid()` с понятным сообщением (не сырой ENOENT из `readFile`).
- Содержимое кладётся полем `figma` в тело и create (`POST`), и update (`PUT`) — одной ревизией
  с source. Валидация схемы (fileKey/nodeIds/referenceScreenshots) — серверу.
- **Семантика ревизии — операционное правило** (ревью M8): `figma_json` не наследуется — update
  без `--figma` и `component-move` обнуляют provenance на head. Значит рабочее правило скилла:
  `figma.json` хранится рядом с TSX компонента и `--figma` передаётся **при каждом** вызове
  `component`; фиксируется в T4-доках (§4.5/§4.8 скилла). Серверное наследование — вне скоупа.
- `usageLine` дополняется; `--json`-отчёт включает `figma: true`.

Тесты: create с `--figma` → read-back head-меты содержит объект figma; update с `--figma` →
provenance сохранён; update **без** `--figma` → `figma: null` (осознанная фиксация текущей
серверной семантики, со ссылкой на операционное правило); отсутствующий/невалидный файл →
`invalid()`, **exit 1** (контракт CLI: exit 2 — только product-level, `driver.mjs:20`).

## T3 — `snap`: `--viewport WxH`, `--dsf 1|2|3`, `--theme light|dark`

Проблема: `snapScreen` шлёт фиксированный `{viewport: {480,800}}` — media queries считаются на
480 даже для canvas-стикершита 1200×900 (PNG при этом = capture-surface, т.е. canvas), а
@2x-сверка с Figma-экспортом невозможна.

Решение:

- Флаги `--viewport`/`--dsf`/`--theme` в `flagSpecs.snap` (парсеры уже есть у `baseline`).
- **Дефолт вьюпорта меняется осознанно** (ревью M4): вместо 480×800 — canvas-aware
  `resolveViewport(screen, flags.viewport, doc.device)` — тот же путь, что у `geometry` и
  `baseline`. Прежний hardcode — источник ложных диффов media-queries; паритет geometry/snap
  важнее «неизменности по умолчанию».
- `deviceScaleFactor` из `--dsf`, `theme` из `--theme` — в тело запроса только при заданных флагах.
- **Бюджет до enqueue** (ревью M3): PNG = capture-surface × dsf, а не viewport; лимиты ингеста —
  16 Mpx / 5 MiB (`server/assets/validate.ts`). Проверка перед постановкой: для canvas-экрана —
  `canvas.width × canvas.height × dsf² ≤ 16 Mpx`, для flow — канонический вьюпорт устройства × dsf²;
  плюс существующий `assertViewportPixelBudget(viewport, dsf)` (20 Mpx вьюпорта). Нарушение →
  понятная ошибка **до** enqueue, **exit 1**.
- `waitForFonts` **не трогаем** (ревью B1): сервер уже ставит `true` по умолчанию
  (`server/routes/screenshots.ts:43`), а capture безусловно ждёт `document.fonts.ready`
  (`src/capture/readiness.ts:14`) — под-задача изъята как ложная посылка. Если шрифтовые
  ложные диффы реально всплывут — это отдельный баг readiness, диагностировать отдельно.
- `--json`-отчёт включает применённые viewport/dsf/theme.

Тесты: runJob-стаб фиксирует `WorkerJob` → `--dsf 2 --theme dark` доезжают до payload; canvas-экран
без флагов → viewport = canvas (новый дефолт, осознанно переписать существующие ожидания, если
есть); canvas 2000×4000 + `--dsf 2` → отказ до enqueue (runJob не вызван), exit 1.

## T4 — синк и доки

1. Скопировать канон в оба share-пакета (правка импорта auth), пересобрать оба `.tgz`.
2. Доки — полный список правок «логин один раз на процесс / паузы 30–60 с / контракт snap»
   (ревью M9): `docs/server-api.md` (§driver: логин, snap-флаги), `.claude/skills/author/SKILL.md`,
   `.claude/skills/yp-prototype/SKILL.md` (совет про паузы), `AGENTS.md`,
   `share/easy-ui-authoring-skill/SKILL.md`, `share/yp-figma-rebuild-skill/SKILL.md`
   (+`reference/easy-ui-authoring.md`, `README.md`). Формулировка: кэш сессии включён по
   умолчанию, 429-совет остаётся fallback'ом (форс-`login()`-пути кэш не используют).
3. `yp-figma-rebuild-skill/SKILL.md`: §4.5 — provenance через `--figma` **при каждом** вызове
   `component` (`figma.json` живёт рядом с TSX; `api.mjs figma` — только ретроактивно);
   §4.1/§4.7 — @2x-сверка через `snap --dsf 2` (локальный даунскейл — запасной вариант);
   предупреждение про 16 Mpx-бюджет больших стикершитов при dsf 2.
4. `server/driver-mjs.d.ts`: `DriverParsedArgs.flags` — добавить `viewport`/`theme`/`dsf`/`figma`.
5. Память проекта — обновить файл скилла.

## Порядок и верификация

T1 → T2+T3 (одна волна, один исполнитель — общие `flagSpecs`/`usageLine`) → T4.
Исполнение — Opus-субагенты; оркестратор верифицирует: `~/.bun/bin/bun test server/driver-cli.test.ts`
+ `npm run verify`; runtime-смоук на проде: `EASYUI_SESSION_FILE` во временный путь → первый вызов
создаёт файл, второй не меняет `savedAt` и проходит без `/auth/login` (проверка наблюдаемая, по файлу);
`snap` тест-прототипа с `--dsf 2` → PNG вдвое больше по обеим осям.

## Риски

- 401-retry с телом безопасен, пока анонимный гейт отвечает до роутинга (`server/main.ts:140`) —
  зафиксировано комментарием в auth-клиенте.
- Смена дефолтного вьюпорта `snap` может изменить существующие снапы с canvas > 480 — это
  целевое поведение (паритет с geometry/baseline); старые PNG пере-снять.
- Кэш меняет поведение всех потребителей `easyui-auth.mjs` — выключатель `EASYUI_SESSION_CACHE=0`.
- Share-дрифт: три копии драйвера — синк в done-критериях T4, расхождение ловится `diff`.

## Триаж ревью (Stage 2, 2026-08-01, Opus)

Все находки **приняты**, отклонённых нет; план обновлён до v2:

- **B1** (waitForFonts — ложная посылка: сервер default true, воркер поле не читает, capture
  безусловно ждёт fonts.ready) → под-задача изъята из T3 вместе с фиктивным риском.
- **B2** (re-login нереализуем без сброса `cookie`+`loginPromise`; нет single-flight при
  `Promise.all`-пачках) → T1: явная инвалидация обеих мемоизаций + файла, shared re-login-промис,
  тест на параллельные 401.
- **M2** (exit 2 недостижим для валидации аргументов — контракт CLI даёт 1) → критерии T2/T3
  исправлены на exit 1.
- **M3** (бюджет по вьюпорту не ловит asset-лимит 16 Mpx/5 MiB: PNG = surface × dsf) → T3:
  pre-enqueue проверка по фактической поверхности (canvas/канонический вьюпорт × dsf²).
- **M4** (hardcode 480×800 ломает media queries стикершитов — цель T3) → дефолт snap переведён
  на canvas-aware `resolveViewport`; осознанное изменение поведения задокументировано.
- **M5** (401 от legacy-Basic барьера — не-JSON, до принципала) → ретрай только JSON-401
  `code:"unauthorized"` и только для cookie из кэша.
- **M6** (предсказуемый путь в tmpdir, симлинк-атака, нет TTL) → каталог 0700 под
  XDG_STATE_HOME/~/.cache, атомарная запись tmp+rename+wx, TTL 24 ч, удаление при выключателе.
- **M7** (createTestHandler подмешивает admin-cookie — тесты ничего не докажут; счётчика логинов
  нет) → кейсы кэша на прямом `createHandler` + счётчик; `server/test-auth.ts` добавлен в зону T1.
- **M8** (update/move без figma обнуляют provenance на head) → операционное правило «--figma при
  каждом вызове component», фиксация в скилле; серверное наследование — вне скоупа.
- **M9** (неполный список доков и потребителей auth) → T4 п.2 расширен; потребители перечислены в T1.
- **M10** (T2/T3 делят flagSpecs/usageLine — не параллелить) → одна волна, один исполнитель;
  таблица владения переразбита по задачам.
- **m11** (инвариант «requireUser первым» неверен — 403; реальный гарант — глобальный гейт
  main.ts:140) → формулировка и якорь комментария исправлены.
- **m12** (`EASYUI_SESSION_FILE` в тестах обязателен — наследование env, мусор токенов) → «обязано».
- **m13** (прод-смоук «один логин» ненаблюдаем) → критерий через файл кэша/savedAt.
- **m14** (`login()`-потребители: cookieHeader из кэша, 429 у форс-логина остаётся) → контракт
  дополнен; доки сохраняют 429-fallback.
- **m15** (driver-mjs.d.ts: флаги через index signature) → явное добавление полей в T4.
- **m16** (ENOENT наружу) → `invalid()` при отсутствии/невалидности файла.

Ревизии — дословное применение рекомендаций; повторный раунд ревью не требуется.
