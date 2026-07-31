# План: разбор прод-инцидента reuse-gate (enforce без shadow-фазы)

Дата: 2026-07-31 · Статус: **I1–I4 complete; I5 decision recorded / enforce not eligible**
Родительский план: `docs/plans/2026-07-31-component-reuse-enforcement.md` (проект 2, волны 0–2 выполнены)
Спека: `docs/superpowers/specs/2026-07-30-component-reuse-enforcement-design.md`

## 0. Что произошло

2026-07-31 в прод (`easy-ui.pay-offline.ru`) уехали 17 коммитов `ae85fbb..d3b475e` — проект 1
(library perf) и волны 0–2 проекта 2 одним релизом. Волны 3–4 проекта 2 не сделаны.

Проверено зондом на проде (безопасный запрос с заведомо битым `source`, до создания дело не
доходит ни в одном режиме гейта):

```
POST /api/components → 400
{"error":{"code":"invalid_request",
 "message":"intent is required: describe the product job this component does (8..500 characters)"}}
```

Значит прод работает в режиме `enforce`. Это **не то состояние, которое предписывал план**.

## 1. Основной дефект: пропущена вся shadow-фаза

`docs/plans/2026-07-31-component-reuse-enforcement.md` §5 задаёт порядок:

| Шаг плана | Предписано | Фактически |
|---|---|---|
| §5.1 | Проект 1 (library perf) — **отдельный релиз**, своя точка отката | Уехал вместе с проектом 2 одним релизом |
| §5.2 | Волны 0–4, затем зелёные `verify` + `e2e` + runtime `/verify` | Задеплоены волны 0–2, `verify` и `e2e` красные |
| §5.3 | Деплой с `REUSE_GATE=shadow` | Переменная в проде не задана → действует дефолт `enforce` (`server/catalog/gate.ts:53`) |
| §5.4 | Включение `enforce` только по конъюнкции критериев: отчёт T0 принят, `policyVersion ≥ 1`, **≥ 2 недель shadow**, ≥ 20 решений от ≥ 2 акторов, каждое `would_block` разобрано, `intent_missing` = 0 | Ни один критерий не проверялся — фаза пропущена целиком |
| §5.5 | `enforce` — **отдельным деплоем** | Приехал вместе со всем остальным |

Корень: дефолт гейта в коде — `enforce` (`server/catalog/gate.ts:53`,
`DEFAULT_REUSE_GATE_MODE = "enforce"`), а `REUSE_GATE` в `docker-compose.yml` не объявлена.
То есть безопасное состояние требовало **явного действия в окружении**, которого план не
описал как обязательный шаг деплоя, — и по умолчанию система пришла в самое строгое
состояние. Риск §6 «ломающий контракт create» считался закрытым фазовым `intent`, но фаза
задаётся снаружи и по умолчанию выключена.

## 2. Прод-последствие: авторинг новых компонентов сломан

`POST /api/components` требует `intent` (8..500 символов, плюс стоп-набор из
`server/contracts.ts:1367` — одного слова «компонент» недостаточно). При этом:

- **`.claude/skills/author/driver.mjs:807`** шлёт `{ id, name, source, designSystem, message }`
  без `intent` → любой агент, идущий задокументированным путём, получает 400. Это волна 3, T7,
  которая не выполнена.
- `docs/server-api.md` и `.claude/skills/author/SKILL.md` про `intent` не упоминают вовсе.
- `PUT /api/components/:id` (правка существующего) и `POST /api/bundles/import` не затронуты —
  импорт бандла проходит собственным путём и зелёный.

Итого: создание новых компонентов агентом в проде недоступно, обходного пути в документации нет.

## 3. Разрыв контрактного слоя

`npm run verify:openapi` сообщает дрейф: `server/openapi.json` отстал от `server/contracts.ts`.
Регенерация добавляет в схему ошибки поля волны 2, которых в опубликованном контракте нет:

- `catalogRevision`, `candidateKeys`, `decisionId`;
- `reuseCode` с enum `component_reuse_required | catalog_changed | canonical_role_conflict`.

Это ровно тот материал, по которому агент должен строить двухфазный override, — сейчас он не
описан в `GET /api/openapi.json`, то есть в проде опубликован контракт, не соответствующий
поведению сервера.

## 4. Состояние сюит

`npm run verify` падает на пятом шаге (`server:test`), поэтому хвост цепочки в CI ни разу не
отрабатывал. Прогнал хвост вручную — он зелёный:

| Шаг | Результат |
|---|---|
| `typecheck`, `server:typecheck`, `lint`, `test` (vitest) | PASS |
| `server:test` | **97 fail / 379 pass** |
| `validate:templates` | PASS |
| `verify:openapi` | **FAIL — дрейф (§3)** |
| `verify:sdk` | PASS (13 тестов) |
| `build` | PASS |
| `check:css` | PASS (979 записей, sha256 `e8cc297d…`) |

Разложение 97 падений по файлам — все на одном и том же 400 от `intent`:

| Файл | fail |
|---|---|
| `server/components-layout.test.ts` | 36 |
| `server/components.test.ts` | 14 |
| `server/component-status.test.ts` | 9 |
| `server/bundle-export.test.ts` | 7 |
| `server/component-architecture.test.ts` | 5 |
| `server/compositions.test.ts` | 5 |
| `server/named-slots.test.ts` | 5 |
| `server/typed-events.test.ts` | 4 |
| `server/assets.test.ts` | 3 |
| `server/renderStatus.test.ts` | 3 |
| `server/contract.test.ts` | 2 |
| `server/figma.test.ts` | 2 |
| `server/host-primitives.test.ts` | 1 |
| `server/server.test.ts` | 1 |

`npm run e2e`: **8 fail / 100 pass / 1 skipped / 10 did not run**, та же причина —

- `[dev] e2e/dev/api.spec.ts:7`
- `[dev] e2e/dev/composition.spec.ts:79`
- `[dev] e2e/dev/custom-component.spec.ts:7`
- `[dev] e2e/dev/library-preview.spec.ts:65`
- `[dev] e2e/dev/present.spec.ts:47`
- `[dev] e2e/library-component-integration.shared.ts:62`
- `[preview] e2e/library-component-integration.shared.ts:62`
- `[preview] e2e/preview/screenshot.spec.ts:85`

Родительский план (§4, T6a/T6b) эту красноту предсказывал («108 падений в 15 файлах,
запланировано, чинится волной 3»). Расхождение цифр (108 → 97) объясняется коммитом
`3367163`: реализация вординга уже проставила `intent` в четырёх e2e-фикстурах.

**Новое относительно родительского плана — не покрыто T6a/T6b:** красный `verify` перестал
быть внутренним состоянием ветки и стал состоянием прода.

## 5. Что не является дефектом

- Деплой вординга `3367163` (спека `2026-07-31-agent-authored-product-copy-design.md`) — фронтовый,
  к инциденту отношения не имеет; выкачен 2026-07-31 13:14:59, verify 5×PASS, строки в бандле
  `/assets/index-C_ESnIsz.js` подтверждены.
- Сам гейт и его логика: волны 0–2 приняты по своим критериям, тесты волны
  (`server/reuse-gate.test.ts`, `server/catalog-candidates.test.ts`, `server/bundle-import.test.ts`)
  зелёные. Дефект — в фазе раскатки, а не в матчере.

## 6. Варианты выхода

| # | Вариант | Плюсы | Минусы |
|---|---|---|---|
| A | `REUSE_GATE=shadow` в Dokploy env + редеплой; затем волны 3–4; enforce отдельным релизом по §5.4 | Чинит прод за минуты; возвращает исполнение в русло плана; shadow-окно начинает копиться уже сейчас | Требует ручного действия в Dokploy; окно ≥ 2 недель отодвигает enforce |
| B | Доделать волну 3 (T6a/T6b/T7) и выкатить с зелёным verify, оставив `enforce` | Один релиз | Прод остаётся сломанным на всё время волны; критерии §5.4 всё равно не выполнены — enforce остаётся нелегитимным |
| C | Откатить прод на образ до `ae85fbb` | Полный возврат | Уносит и проект 1 (library perf), и вординг; миграция v20 forward-only — откат схемы невозможен |

**Рекомендация — A.** Он единственный одновременно чинит прод и восстанавливает предписанный
планом порядок, и не требует откатывать миграцию v20.

## 7. Задачи

**I1 — Вернуть прод в shadow — COMPLETE** (владеет: оркестратор; вне кода)
Задать `REUSE_GATE=shadow` в Dokploy env сервиса easy-ui, редеплой
(`node .claude/skills/deploy/driver.mjs deploy "reuse gate → shadow"`).
Критерий: зонд `POST /api/components` без `intent` возвращает не 400 `intent is required`;
`driver.mjs` создаёт компонент; в аудите появляется строка `intent_missing`.

**I2 — Явная переменная в compose — COMPLETE** (владеет: `docker-compose.yml`, `docs/server-api.md#deployment`)
Объявить `REUSE_GATE` в compose со значением `shadow` — фаза гейта не должна зависеть от того,
помнит ли кто-то про необъявленную переменную окружения. Критерий: переменная видна в файле,
описана в §deployment, смена фазы — правка одной строки + редеплой.

**I3 — Волна 3 родительского плана — COMPLETE** (T6a → T6b ∥ T7)
Механическая простановка `intent` в фикстурах, триаж коллизий гейта, CLI (`--intent`,
`--force-new`, `catalog list|search|get`). Критерий: `npm run verify` и `npm run e2e` зелёные.
Включает правку `.claude/skills/author/driver.mjs:807`.

**I4 — Контрактный слой — COMPLETE** (владеет: `server/openapi.json`, `docs/server-api.md`, `author/SKILL.md`)
`npm run generate:openapi`; описать `intent`, `reuseOverride` и 409-конверт с `reuseCode` в
`docs/server-api.md`; добавить в скилл авторинга обязательность `intent` и стоп-набор.
Критерий: `npm run verify:openapi` зелёный; `GET /api/openapi.json` на проде описывает
фактическое поведение.

**I5 — Критерий включения enforce — DECISION RECORDED / NOT ELIGIBLE** (владеет: оркестратор)
Не включать `enforce` до выполнения конъюнкции §5.4 родительского плана. Критерий фиксируется
отдельной [записью приёмки](../audit/2026-07-31-reuse-gate-enforce-readiness.md), эскалация
человеку — если окно не набрано. Текущая запись требует **KEEP SHADOW** и не разрешает
автоматическое переключение.

Порядок: **I1 → I2 ∥ I4 → I3 → I5**. I1 срочный, остальное — обычной волной.

## 8. Организационный вывод

Деплой прошёл без прогона `npm run verify`: цепочка была красной по построению, и это знали, но
между «красный verify ожидаем внутри ветки» и «ветку можно пушить в main» нет барьера — любой
push в `main` уходит в прод (`.claude/skills/deploy/SKILL.md`, «Deploy happens on every push to
main»). Стоит рассмотреть гейт в `.github/workflows/build-image.yml`: не собирать образ, если
`npm run verify` красный, — либо явный маркер в коммите для осознанного обхода. Отдельного
решения по этому пункту пока нет.
