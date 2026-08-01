# План: DX-подготовка харнеса к пересборке дизайн-системы из Figma

Дата: 2026-08-01 · Статус: draft (адверсариальное ревью — Stage 2)
Мотивация: скилл `share/yp-figma-rebuild-skill` (b8699f6) описывает цикл «атом за атомом» —
сотни вызовов харнеса и десятки публикаций. Три источника трения устраняются до старта:
429-петля логина, provenance через лишнюю ревизию, невозможность @2x/шрифтовой сверки снапом.

Скоуп — **только клиентский харнес** (driver/auth) + синк share-пакетов. Серверные правки — вне скоупа.

## Целевые файлы и владение

| Зона | Файлы |
|---|---|
| Канон | `.claude/skills/author/driver.mjs`, `scripts/easyui-auth.mjs`, `scripts/easyui-auth.d.mts` |
| Тесты | `server/driver-cli.test.ts` (реальный тест-сервер + драйвер сабпроцессом) |
| Синк | `share/easy-ui-authoring-skill/{driver,easyui-auth}.mjs`, `share/yp-figma-rebuild-skill/{driver,easyui-auth}.mjs`, оба `.tgz` |
| Доки | `.claude/skills/author/SKILL.md`, `share/*/SKILL.md` (+`reference/easy-ui-authoring.md`), `share/yp-figma-rebuild-skill/README.md`, `server/driver-mjs.d.ts` (аудит) |

Share-копии драйвера идентичны канону, кроме строки импорта auth (`./easyui-auth.mjs` вместо
`../../../scripts/…`) — синк механический: копия + правка импорта.

## T1 — кэш сессии в `easyui-auth.mjs`

Проблема: cookie живёт в памяти процесса; каждый вызов CLI = логин; лимит 5 логинов/мин
на аккаунт (`server/routes/auth.ts`) → `429 rate_limited` в любом плотном цикле.

Решение — файловый кэш cookie в `createEasyUiClient`:

- Путь: `$EASYUI_SESSION_FILE`, иначе `<os.tmpdir()>/easyui-session-<sha256(apiBase|username).slice(0,16)>.json`.
  Ключ включает apiBase и username — разные инстансы/аккаунты не пересекаются. Запись с `mode: 0o600`.
- Формат: `{cookie, apiBase, username, savedAt}`; чтение в try/catch — битый файл = отсутствие кэша.
- Порядок: (1) есть кэш → использовать без логина; (2) ответ **401** на запросе с кэшированной
  cookie → однократный re-login + повтор запроса, новая cookie пишется в кэш; (3) кэша нет →
  логин как сейчас (+ запись кэша). Повторный 401 после re-login отдаётся вызывающему как сейчас.
- Отключение: `EASYUI_SESSION_CACHE=0` — прежнее поведение (для отладки).
- `login()` остаётся публичным и по-прежнему форсирует логин; `request()` — единственная точка
  401-retry. Retry только **идемпотентно-безопасный**: тело запроса повторно отправляется как есть,
  поэтому повтор допустим лишь когда 401 пришёл ДО обработки (auth-мидлварь отвечает до бизнес-логики —
  это гарантия сервера: `requireUser` стоит первым). Зафиксировать это предположение комментарием.
- `easyui-auth.d.mts` — дополнить типы.

Тесты (driver-cli.test.ts, новые кейсы): два последовательных вызова драйвера → один POST
/auth/login на сервере (счётчик в тест-handler); протухшая cookie в кэше → ровно один re-login
и успешный результат; `EASYUI_SESSION_CACHE=0` → логин на каждый вызов. Существующие тесты
не должны потребовать правок: у каждого setup свой порт → свой ключ кэша; на всякий случай
тест-окружение может выставлять `EASYUI_SESSION_FILE` в tmpdir теста.

## T2 — `--figma <file.json>` у `component`

Проблема: API принимает `figma` в `POST /components` и `PUT /components/:id`, драйвер — нет;
обходной путь (`api.mjs figma` = PUT + re-publish) создаёт лишнюю ревизию и версию на каждый компонент.

Решение:

- Флаг `--figma <path>` в таблице флагов `component`; файл читается и парсится (не-JSON → invalid).
- Содержимое кладётся полем `figma` в тело create (`POST`) и update (`PUT`) — вместе с source,
  одной ревизией. Валидацию схемы (fileKey/nodeIds/referenceScreenshots) оставляем серверу —
  драйвер не дублирует правила.
- `usageLine` дополняется; `--json`-отчёт включает `figma: true` при переданном флаге.

Тесты: create с `--figma` → owner read-back (`GET /components/:id`, драйвер `get components <id>`)
содержит объект figma на head; update только source без `--figma` → figma новой ревизии `null`
(семантика ревизии, не наследуется — зафиксировать в тесте осознанно); невалидный JSON-файл → exit 2.
`api.mjs figma` в скилл-пакете остаётся для случая «прикрепить к уже опубликованному без правки source».

## T3 — `snap`: `--viewport WxH`, `--dsf 1|2|3`, `--theme light|dark` + `waitForFonts`

Проблема: `snapScreen` шлёт `{viewport: {480,800}}` без dsf/theme/waitForFonts — @2x-сверка с
Figma-экспортом невозможна, PNG может сняться до загрузки YS Text (ложные диффы ширин).

Решение:

- В таблицу флагов `snap` добавить `--viewport`/`--dsf`/`--theme` (парсеры уже существуют у
  `baseline` — переиспользовать `viewportFlag`/enum).
- Тело запроса: `viewport` = явный флаг, иначе прежний дефолт 480×800 (поведение без флагов
  не меняется — PNG размер всё равно определяется capture-surface); `deviceScaleFactor` — из
  `--dsf` (по умолчанию не слать); `theme` — из `--theme` (по умолчанию не слать);
  **`waitForFonts: true` — всегда** (осознанное изменение поведения: убирает класс ложных диффов;
  geometry уже так делает).
- Перед enqueue — `assertViewportPixelBudget(viewport, dsf)` (бюджет 20 Mpx уже экспортирован).
- `--json`-отчёт включает применённые viewport/dsf/theme.

Тесты: runJob-стаб фиксирует тело запроса → `--dsf 2 --theme dark` доезжают до job payload и
`waitForFonts === true`; без флагов тело эквивалентно текущему + `waitForFonts`; бюджет:
`--viewport 2000x4000 --dsf 3` → exit 2 без enqueue.

## T4 — синк и доки

1. Скопировать канон в оба share-пакета (правка импорта auth), пересобрать оба `.tgz`.
2. `.claude/skills/author/SKILL.md` и `share/*/SKILL.md`/`reference/easy-ui-authoring.md`:
   usage-строки verb'ов, раздел Setup (упомянуть кэш сессии и что 429-совет остаётся fallback'ом),
   `yp-figma-rebuild-skill/SKILL.md`: §4.5 — provenance через `--figma` при создании (api.mjs figma —
   только для ретроактивного прикрепления), §4.1/§4.7 — @2x-сверка через `snap --dsf 2` вместо
   локального даунскейла (остаётся как вариант).
3. Аудит `server/driver-mjs.d.ts` (новые экспорты, если появятся).
4. Память проекта — файл скилла обновить ссылкой на новые возможности.

## Порядок и верификация

T1 → T2/T3 (независимы) → T4. Исполнение — Opus-субагент(ы) по зонам файлов; оркестратор
верифицирует: `~/.bun/bin/bun test server/driver-cli.test.ts` + `npm run verify`; runtime-смоук
на проде: два подряд `node driver.mjs get prototypes` (один логин), `snap` тест-прототипа с
`--dsf 2` (PNG вдвое больше по обеим осям).

## Риски

- **401-retry с телом**: повтор POST после 401 безопасен только потому, что auth отвергает
  запрос до бизнес-логики; если сервер когда-нибудь начнёт стримить side-effect до auth —
  контракт нарушится. Фиксируем комментарием в auth-клиенте.
- **Кэш в CI/e2e**: ключ по apiBase (порт) изолирует; переменная-выключатель — аварийный люк.
- **`waitForFonts: true`** удлиняет снап на медленных шрифтах; таймаут job (60 с poll) не меняем —
  при таймаутах на проде откатить одним флагом в теле.
- Share-дрифт: три копии драйвера — синк входит в done-критерии T4, расхождение ловится `diff`.
