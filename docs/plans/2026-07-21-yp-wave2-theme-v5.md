# План: волна 2 каталога yandex-pay — theme v5 + ABI v4 `color()` (H1) + H6 + H9 + H3-B

Дата: 2026-07-21. По мотивам `docs/product-hypotheses-2026-07-20.md`. Скоуп утверждён пользователем: **H1** (theme v5 + ABI v4 `color()` — фундамент), **H6** (`currency` → enum), **H9** (seed-проп `yp-random-avatar`), **H3 вариант B** (файлов начертаний 600/900 нет — шкала 400/500/700 закрепляется документированием). Остальные гипотезы (H2 канонизация, H4, H5, H7, H8, H10) — вне волны.

## Контекст

Аудит каталога зафиксировал 181 уникальную строку цвета при **нулевой** токенизации палитры: прод-тема yandex-pay (`latestMetaVersion=3`) несёт только `space.*`-токены и 3 шрифта YS Text. Фикс-волна A (завершена 2026-07-20) закрыла non-breaking долг; breaking-гипотезы вынесены в бэклог B. Эта волна кладёт фундамент токенизации (theme v5 + ABI v4) и забирает два дешёвых изолированных выигрыша схем (H6, H9).

Ключевые факты кода (проверены):
- `serializeThemeCss` (`src/designSystems/theme.tsx:54-57`) **уже эмитит** `--eui-<key>` для любых не-`space.*` токенов (`color.text-primary` → `--eui-color-text-primary` через `tokenCssVar`); грамматика `tokenKeySchema` (`server/designSystemsMeta.ts:19`) принимает `color.*`-ключи. Т.е. тема готова к цветам — не заполнена.
- ABI вычисляется при publish: `hostAbiVersion = usesRuntimeV3 ? 3 : (…) ? 2 : 1` (`server/components/compile.ts:99`); шимы — повторяемый паттерн `server/shims/abi-v{1,2,3}.ts` + `.d.ts` + `routes/shims.ts` + стабы `pipeline.ts`.
- PATCH темы (`server/routes/designSystems.ts:42-57`) — CAS по `baseVersion`, **переданная коллекция `tokens` заменяет предыдущую целиком**, опущенные `fonts`/`icons` наследуются; версии append-only.
- Исходники всех целевых компонентов извлечены локально: `work/yp-fixes/components/<id>/source.tsx`.
- Регламент прод-выкатки §W3 и скрипты (`work/yp-fixes/scripts/{capture,diff,publish,prod-baseline,prod-diff}.mjs`) отработаны фикс-волной и переиспользуются.

## Несущий инвариант H1 (правило волны)

`color.*`-токены попадают в CSS, поэтому `color("key", fallback)` резолвится в **значение темы**, а не в fallback. Единственный способ сохранить H1 строго пиксель-no-op:

> Для каждого мигрируемого литерала: **значение тем-токена == fallback в `color()` == текущий литерал компонента** (побайтово). Тогда пиксель не меняется независимо от пути резолва; pixelmatch обязан дать 0.

Следствия:
- Реестр волны — 1:1 «литерал → токен со значением == литерал», **не** семантическая канонизация (это H2).
- Дивергентные семьи (`--text-color-primary` `#1f2023`/`#000000d8`/`rgba(0,0,0,.86)`; тени `--shadow-medium` alpha .10/.12; градиенты Плюса 90°/135°) — **в пилот не входят**, помечаются defer-H2/H8.

## Волны

Порядок: A (хост-инфра, локально) ∥ B (реестр) → **деплой образа** → C (PATCH темы: стенд → прод) → D (пилот H1 ∥ H6 ∥ H9, локально) → E (прод-выкатка §W3) → F (доки/скилл). Критично: **сборка на проде запрещена** — серверные изменения волны A едут образом через GitHub Actions **до** PATCH темы прода и publish ABI v4-компонентов.

### Волна A — ABI v4 + валидация color-токенов (1 Opus-субагент, локально)

| Задача | Файлы (ownership) | Суть |
|---|---|---|
| A1 шим | `server/shims/abi-v4.ts` (новый), `server/shims/easy-ui-runtime-v4.d.ts` (новый) | `emitEasyUiRuntimeV4Shim`: `token`/`Icon`/`space` из v3 + `color(key, fallback?)` → `` `var(--eui-color-${key.replace(/\./g,"-")}, ${fallback})` `` (согласовано с `tokenCssVar`). Ключ — открытая строка (решение D1) |
| A2 раздача | `server/routes/shims.ts` | ветка `v4`, immutable-кэш как у v1–v3 |
| A3 компиляция | `server/components/compile.ts` | `EASY_UI_RUNTIME_V4_SPECIFIER="easy-ui/runtime/v4"`, `IMPORT_ABI_V4`, `finalImportsV4`, `ALLOWED_SPECIFIERS`, `valueRuntimeSpecifiers`, формула `hostAbiVersion` → 4, typecheck `paths` → v4 `.d.ts`, запрет смешивать **любые** пары runtime-специфаеров (R6) |
| A4 серверный стаб | `server/components/pipeline.ts` | `build.module("easy-ui/runtime/v4", …)` c `color` для eval/extract |
| A5 compat | `server/shims/fixtures/compiled-abi-v4.mjs` (новый), `server/shims/compat.test.ts` | прекомпилированный fixture + `executeFixture(…, 4)` |
| A6 валидация темы | `server/designSystemsMeta.ts`, `server/design-systems-theme.test.ts` | `colorTokenIssues()` по образцу `spaceTokenIssues`: синтаксическая проверка значений `color.*` (regex-allowlist: hex/rgb(a)/hsl/`var(`/`linear-gradient(`/named); подключить в `superRefine`. Закрытого списка ключей **нет** |

**Done A:** `npm run verify` + `npm run e2e` + runtime-прогон `/verify` зелёные; локально опубликован тестовый ABI v4-компонент (`hostAbiVersion===4`, бандл ссылается только на `/api/shims/v4/*`), `color()` резолвится и в fallback (без темы), и в тем-значение (с темой).

**Гейт деплоя:** merge → образ GitHub Actions → Dokploy авто-деплой (`/deploy`) → проверить `GET /api/shims/v4/easy-ui-runtime.js` на проде.

### Волна B — Реестр токенов (1 Opus-субагент, параллельно A)

- **B1.** Из `docs/audit/design-facts-agg.json` (colors: 181 пара `[значение, частота]`) + `docs/design/yandex-pay.md §1` сгенерировать реестр `work/yp-wave2/token-registry.json`: `литерал → color.<семантический-ключ> → значение(==литерал)` + статус `ship-now | defer-H2 | defer-H8`. Значения не нормализовать (no-op). Дивергентным семьям — разные literal-preserving ключи с пометкой defer-H2.
- **B2.** Пилот: топ-частотные литералы surface/fill **без дивергенции** — `#fff`(12), `rgba(255,255,255,.98)`(8), `#edeff2`(6), `#2e2f33`(6), `#f3f5f7`/`#f2f3f5`/`#f5f7f9`, `#ffdc60` — ~8–10 токенов. Отобрать 6–10 пилотных компонентов, использующих только их; включить H6-компоненты (`yp-split-discount-info`, `yp-discount-info-with-cashback`) — одна републикация закроет и H6, и H1-пилот. Тени/градиенты/`text-primary` — исключены.
- **B3.** Черновики разделов design.md (финализация в F).

**Done B:** реестр со статусами, список пилотных компонентов, черновики.

### Волна C — PATCH темы (оркестратор; после деплоя A и готовности B)

1. **C1.** Собрать полный `tokens`: `GET /api/design-systems/yandex-pay` → текущие `space.*` + пилотные ship-now `color.*`. `fonts`/`icons` в PATCH **опустить** (наследуются — не потерять 3 шрифта YS Text). Образец вызова — `scripts/w6-yandex-pay.mjs`.
2. **C2.** Стенд: PATCH → проверить эмиссию `--eui-color-*`, идентичность пикселя пилотных компонентов с темой и без.
3. **C3.** Прод: admin-сессия + `Origin`; сохранить снапшот текущей `version=3` → `work/yp-wave2/rollback-theme.json`; PATCH `baseVersion:3` → `version=4`. **Откат темы** (append-only): новый PATCH со снапшотом v3.

**Done C:** прод-тема v4 несёт пилотные `color.*`; чистый аддитив (никто их ещё не читает); rollback-снапшот готов.

### Волна D — Пилот H1 ∥ H6 ∥ H9 (3 параллельных Opus-субагента, локально; непересекающиеся файлы)

- **D-H1** (`work/yp-wave2/components/<пилот>/source.tsx`): `import { color } from "easy-ui/runtime/v4"`; литералы → `color("<key>", "<исходный-литерал>")` строго по реестру. Done: локальный publish `hostAbiVersion===4`; pixelmatch с задеплоенной темой = 0.
- **D-H6** (`…/yp-split-discount-info/source.tsx`, `…/yp-discount-info-with-cashback/source.tsx`): сначала **инвентарь** фактических `currency` по 33 живым докам прода (известно из examples: RUB, UZS); затем `z.string().min(1)` → `z.enum([...])` — в cashback-компоненте и top-level `currency`, **и вложенный `limits.currency`**; форматтер `symbol()`/`money()` покрывает весь enum (для не-RUB без утверждённого символа — печатать код, текущее безопасное поведение; R3). Done: все живые доки валидны против enum.
- **D-H9** (`…/yp-random-avatar/source.tsx`, база — уже пофикшенный F2-исходник с ассетами): `+ seed: z.union([z.string(), z.number()]).optional()`; mulberry32 от 32-bit хеша seed; `undefined` → `Math.random` как сейчас; `useMemo` deps → `[props.seed]`. Снапшот-тулинг (`capture.mjs`/`prod-baseline.mjs`) подаёт фиксированный seed → компонент возвращается в pixelmatch-гейт; **доки принудительно не мигрируются**. Done: детерминизм под seed, прежнее поведение без него.

**Done D:** verify + e2e + runtime-прогон зелёные; критерии каждого субагента проверены оркестратором независимо.

### Волна E — Прод-выкатка по §W3 (оркестратор, строго последовательно)

Переиспользовать `work/yp-fixes/scripts/*`. Фазы: admin-сессия+Origin → бэкап+инвентарь (rev/version/statusRev компонентов, rev живых доков) → прод-baseline экранов затрагиваемых доков (`prod-baseline.mjs`; yp-random-avatar — с фиксированным seed) → канарейка `yp-split-discount-info` (H6+H1 в одном, малый) → батч publish по одному (1 CPU, контроль `active`) → **барьер 100% active** → re-pin checkpoint-save живых доков → `prod-diff.mjs`: ожидание H1=0, H6=0 для RUB-доков, H9=0 под seed; каждый ненулевой дифф объяснить → финальный бэкап `.backups/prod-wave2-<date>/`.

Грабли фикс-волны (учитывать): импорт прототип-бандлов бампает зависимости на старый source → чинить републикацией head; ключи `examples` — только slug, `default` зарезервирован; screenshot-воркер не отдаёт PNG канвасов ~1880px+.

Откат: компонент — deprecated + republish предыдущего source; прототип — `POST /prototypes/:id/restore {rev}`; тема — PATCH снапшотом v3.

### Волна F — Доки и скилл (1 Opus-субагент)

- `docs/design/yandex-pay.md`: theme v5 несёт пилотные `color.*`; полный реестр «литерал → токен» со статусами ship-now/defer-H2/defer-H8; §2.3 — **H3-B: шкала 400/500/700 официально закрыта** (600/800/900→700, вариант A отклонён — файлов начертаний нет); дивергенции остаются в H2/H8.
- `.claude/skills/yandex-pay/SKILL.md`: новые компоненты используют `color("<key>","<fallback>")` из `easy-ui/runtime/v4`, fallback обязателен и равен канон-литералу; `currency` — enum; seed для детерминизма аватара.
- Итоговая запись о выполнении в план-документ (по образцу 459cbb0).

## Решения и риски

- **D1 — сигнатура `color()`: открытый ключ, без закрытого списка.** В отличие от `space()` (шкала фиксирована хостом), набор цветовых токенов задаёт тема и он растёт по волнам; закрытый список заставлял бы бампать ABI на каждый токен. Ошибка ключа безопасна — резолв в fallback. Валидация значений — на стороне темы (A6), соответствие реестру — через design.md/скилл.
- **D2 — откат темы:** append-only ⇒ откат = новый PATCH со старым содержимым; rollback-снапшот готовится в C3 до мутации.
- **R1 — «тихий» сдвиг оттенка:** снимается инвариантом no-op + pixelmatch=0; дивергентные семьи вне пилота.
- **R2 — порядок деплоя:** ABI v4 на проде обязан появиться (образ волны A) до C3/E; проверка `/api/shims/v4/*` — гейт.
- **R3 — символы валют:** для не-RUB печатать код до утверждения символов дизайном (не хуже текущего).
- **R4 — enum ломает доки вне набора:** инвентарь обязателен до сужения.
- **R6 — специфаеры:** ровно один runtime-специфаер на компонент (расширить запрет в compile.ts).

## Верификация (end-to-end)

1. Локально: `npm run verify`, `npm run e2e`, runtime-прогон `/verify` — гейты волн A и D.
2. Стенд: PATCH темы + рендер пилотных компонентов с темой/без — пиксель идентичен (C2).
3. Прод: `GET /api/shims/v4/easy-ui-runtime.js` (после деплоя A); §W3-цикл baseline → diff (E): H1-пилот дифф=0, H6 дифф=0 на RUB-доках, H9 дифф=0 под seed; `driver.mjs status`, `/library` открывается.

## Процесс (по CLAUDE.md)

После одобрения: план сохраняется в `docs/plans/2026-07-21-yp-wave2-theme-v5.md`, коммитится → **Stage 2: адверсариальное ревью плана** (Opus-субагенты, линзы: no-op-инвариант, порядок деплоя, миграция доков) → триаж находок в плане → исполнение по волнам (Stage 3).
