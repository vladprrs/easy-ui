# Экспорт/импорт прототипов и custom-компонентов (ZIP-бандлы) — v2 (после адверсариального ревью)

## Context

В easy-ui нет способа выгрузить прототип или custom-компонент наружу (перенос между серверами/аккаунтами, локальный архив, обмен). Все данные уже доступны через API (TSX-исходники, JSON документа, пины ассетов, темы DS), но нет ни одного endpoint'а, отдающего архив, и нет download-хелпера в клиенте. Пользователь утвердил объём: **экспорт прототипа с полным замыканием зависимостей, экспорт отдельного компонента, массовый экспорт, плюс импорт бандла обратно; формат — ZIP** (UI для экспорта и импорта).

## Формат бандла (один манифест на все три вида)

ZIP:
```
manifest.json
prototypes/<prototypeId>.json          # точный doc экспортируемой ревизии
components/<componentId>/source.tsx
assets/<sha256>                        # сырые байты, имя = sha256
```

`manifest.json` (`formatVersion: 1`, zod-валидация): `kind` (`prototype|component|bulk`, информационно — импортёр един), `exportedAt`; **`source { origin, apiVersion, renderContractVersion, builtinCatalogHash }`** — compat-сигнал для диагностики межверсионного импорта; массивы `prototypes[]` (id, name, designSystem, `exported {selector, rev, version}`, docPath, componentPins, assetIds, designSystemMetaVersion), `components[]` (id, name, designSystem, sourcePath, `sourceHash`, exported, assetIds), `designSystems[]` (id, `builtin`, `theme {metaVersion, tokens, fonts, icons} | null`), `assets[]` (id, sha256, mime, size, originalName).

- Пины компонентов и DS meta-version в манифесте **информационные**: на импорте пины пересчитываются `snapshotDefinitions` (резолв по name+designSystem к последней active-версии на цели), тема перепиновывается. Точная version-fidelity не гарантируется — зафиксировать в доках.
- Ассеты хранятся в архиве один раз по sha. Пины ассетов ревизии — единственный источник (walk по `props` в `collectAssetIds` — `$asset` в state/stateOverrides/flows не резолвится рантаймом и не пинуется; это **не** пробел замыкания, ничего не добавлять).
- Схемы: **`src/bundle/schema.ts`** (`bundleManifestSchema`, `importReportSchema` + типы) — импортируем и сервером (прецедент `contracts.ts` → `src/prototype/schema`), и клиентом. **Guardrail: ничто под `src/` не импортирует fflate** (SPA-build не задет).

**Не экспортируем** (осознанно): `compiled_js`/`bundle_hash`/ABI (цель перекомпилирует через publish pipeline), историю ревизий, скриншоты/visual, share-гранты, `figma_json`, owner/audit, статус прототипа (импорт всегда `private`). Прототипный/bulk-бандл включает TSX всех запинованных компонентов независимо от владельца — консистентно с текущим `GET /source` (читается любым аутентифицированным); зафиксировано как продуктовое решение, отражено в доках.

## Сервер: экспорт

Зависимость: `fflate` ^0.8 в корневой `package.json` (ставится **npm**). Zip в памяти (`zipSync`; JSON/TSX — deflate, ассеты — store). Кап 512 MiB **проверяется до материализации**: сумма `assets.size` (из БД) + длины doc/source; превышение → `413 export_too_large`.

Новые файлы: `server/bundle/exporter.ts` (`collectPrototypeClosure`, `collectComponentClosure`, `buildZip`), `server/routes/bundles.ts`.

| Endpoint | Authz | Семантика |
|---|---|---|
| `GET /api/prototypes/{id}/export?version=N` | `requirePrototypeRead`; draft (без `?version`) — только owner; не-owner по умолчанию — последняя published-версия, иначе 404 | прототип + полное замыкание; `easy-ui-prototype-<id>-{draft-r<rev>|v<N>}.zip` |
| `GET /api/components/{id}/export?version=N` | `requireUser` (как `/source`) | по умолчанию последняя active-версия; без публикаций — head draft (`version: null`); `easy-ui-component-<id>-v<N>.zip` |
| `GET /api/bundles/export` | `requireUser` | всё owned; **для каждого прототипа — последняя published-версия, head draft только если публикаций нет** (selector в манифесте различает); компоненты — последняя active (иначе head draft); `easy-ui-export-<yyyymmdd>.zip` |

Пути bulk/импорта — в неймспейсе **`/api/bundles/*`** (консистентно с noun-стилем API). `export`-хвосты per-resource остаются в `routes/prototypes.ts`/`routes/components.ts` (authz на месте); `routeBundles` — `/api/bundles/export` + `/api/bundles/import` (диспатч в `main.ts`).

Замыкание прототипа: `PrototypeRepo.draft/version` → пины → **`ComponentRepo.version(id, pinVersion)`** (даёт source+assets одним вызовом; для draft-компонентов — `source(id)` + `assets`) → asset-пины ревизии → тема DS: **экспортировать `themeAssetIds` из `server/share/repo.ts`** (сейчас файл-локальная) и переиспользовать + `getDesignSystemVersion`. Пин со статусом `rejected/archived` — экспортируем source как есть (импорт перепубликует). Байты — `Bun.file(assetRepo.bytesPath(sha))`. Binary Response по прецеденту `bundle.js` (`application/zip`, `content-disposition: attachment`, noStore).

## Сервер: импорт

`POST /api/bundles/import` — `requireUser`; multipart (`file`) или raw `application/zip`; `?mode=dry-run|apply` (default `apply`).

Безопасность до записи: кап аплоада 256 MiB; **бюджет распаковки НЕ через `unzipSync` вслепую** — сначала читаем central directory (заявленные uncompressed-размеры): суммарно ≤ 512 MiB, entries ≤ 4096, иначе reject; после инфляции сверяем фактические длины с заявленными (расхождение → 400). Пути по allowlist-regexp (`manifest.json | prototypes/<slug>.json | components/<slug>/source.tsx | assets/<64hex>`); манифест через zod; перекрёстная сверка путей манифест↔zip; байты ассетов перехешируются.

Порядок и политика конфликтов:
1. **Ассеты** — `AssetRepo.ingest` (идемпотентно) → `created|reused`.
2. **Дизайн-системы** — builtin: проверить наличие, иначе `design_system_missing`. Custom: id свободен → создать (owner = импортёр); id существует (чей угодно — реестр глобальный, референс по slug разрешён всем) → **reuse by reference**; если тема своя (owner = импортёр) и отличается → `insertDesignSystemVersion(latest+1)` **с предварительным `validateThemeAssets`** (как в PATCH-пути); чужая DS с отличающейся темой → reuse + warning-detail «theme drift» (без записи).
3. **Компоненты** — только через `publishComponent`; `compiled_js` из бандла не используется:
   - свой id, head sourceHash совпадает и есть active publish → **reused**; иначе `save` + publish → **created** (новая версия);
   - id свободен, name занят своим компонентом с тем же sourceHash → reuse (id-remap только в отчёте); чужим → `name_conflict`;
   - **tombstone-ветка**: `create` видит soft-deleted строки как занятые (`SELECT ... WHERE id=? OR name=?` без фильтра `deleted_at`, repos/components.ts:18) — детектим unfiltered-запросом заранее → typed item-error `deleted_conflict` (v1 без revive);
   - name совпадает с builtin-каталогом → typed `builtin_name_reserved`;
   - оба свободны → `create` + publish; провал pipeline → item-error с его сообщением.
4. **Прототипы** — через helper `createPrototypeFromDoc(...)` (извлечь из POST-ветки `routePrototypes`):
   - id свободен → created; свой id: doc идентичен head → skipped, иначе новая head-ревизия; чужой/tombstone id → remap `<id>-imported-<n>` → created + `remappedTo`;
   - зависимость не импортировалась → `dependency_failed`; провал валидации doc при `renderContractVersion`/`builtinCatalogHash` в манифесте новее целевых → typed `format_too_new` вместо generic-ошибки.

**Без глобального rollback** (compile — сабпроцессы): по-item отчёт `{items[{type,id,action,detail,remappedTo?,version?}], summary}` + **dry-run** (без записи и без компиляции; в отчёте и UI dry-run-строки помечены как предварительные — компиляция оценивается только на apply).

## Контракты, capabilities, доки

- `server/contracts.ts`: 3 export-контракта (`contentType: "application/zip"`; 401/403/404/413) + import-контракт (`responseSchema: importReportSchema`; 400 `invalid_bundle`, 413, 415, 422; query `mode`).
- **Правило: задача, регистрирующая контракт, в том же коммите (а) добавляет coverage-case в `orderedCases()` `server/contract.test.ts`, (б) регенерирует `server/openapi.json`** — иначе suite красный (coverage-ассерт + drift-чек). Import-case — только raw-zip (helper `call()` ломает multipart boundary).
- `server/routes/meta.ts`: `features.bundleExport/bundleImport` — правится и closed `z.object` в `capabilitiesResponseSchema` (`contracts.ts:~1015`), и точный `toEqual` в `contract.test.ts:~176`.
- `docs/server-api.md`: раздел «Bundles» (endpoints, манифест, конфликт-политика, исключения, «version-fidelity не гарантируется», «bulk — published-версии»).

## Клиент

`src/api/bundles.ts`:
- `downloadBundle(url, fallbackName)` — fetch → blob → `<a download>` (ошибки инлайн) для per-resource экспорта; **bulk-кнопка — прямой `<a href="/api/bundles/export">`** (cookie same-origin; не буферить сотни MiB через blob);
- `importBundle(file, mode)` — FormData POST (паттерн `uploadAsset`).

UI (идиомы: `pillGhost/pillPrimary`, инлайн `role="alert"`, без тостов, строки в `src/app/strings/*`):
1. **Gallery**: экспорт owner'а — **через существующий `VersionsMenu`** (пункты: draft + каждая published-версия), той же моделью, что ComponentPage; для не-owner — кнопка «Экспорт» (последняя published, видна при `latestVersion !== null`). В шапке — «Экспортировать всё» (anchor) и «Импортировать».
2. **`src/gallery/ImportDialog.tsx`**: file input (паттерн `AssetField`) → авто dry-run → таблица отчёта (пометка «предварительно») → apply → финальный отчёт → reload. Состояния idle/checking/preview/applying/done/error.
3. **ComponentPage**: «Экспорт» выбранной версии рядом с селектором.
4. Строки: `strings/gallery.ts`, `strings/componentPage.ts`.

Без кнопок в editor/player в v1.

## Тесты

- `server/bundle-export.test.ts`: фикстура (custom DS + тема с font-ассетом, компонент с ассетом, прототип) → export → `unzipSync` → манифест валиден, замыкание полное, hash байтов сходится; `?version` vs draft; authz-матрица (не-owner draft → 403, published → 200, anonymous → 401); bulk: чужой приватный отсутствует, **published-версия предпочитается драфту**.
- `server/bundle-import.test.ts`: round-trip (handler A → handler B: компонент active и `bundle.js` отдаётся, прототип renderable **и забинден на импортированный компонент**, тема на месте); повторный импорт → reused/skipped; конфликты (изменённый source → новая версия; чужой name → `name_conflict` + `dependency_failed`; tombstone → `deleted_conflict`; чужой id прототипа → `remappedTo`; чужая custom DS → reuse by reference); dry-run не пишет; malformed (не-zip, traversal, sha mismatch, central-directory-бомба: заявленный размер > бюджета → reject до инфляции).
- `server/contract.test.ts` — правится в T2 и T3 (см. правило выше).
- e2e `e2e/bundles.spec.ts`: экспорт из галереи (`page.waitForEvent("download")`, `acceptDownloads`); **фикстурный zip для импорта генерируется экспортёром в setup-шаге**, не хранится руками.

## Декомпозиция (субагенты Opus)

Файлы `server/routes/prototypes.ts`, `server/routes/components.ts`, `server/contracts.ts`, `server/main.ts`, `server/contract.test.ts`, `server/openapi.json` — **shared-sequential** между T2 и T3 (T3 строго после T2, worktree-параллель по ним запрещена).

| # | Задача | Владеет | Зависит | Done-критерий |
|---|---|---|---|---|
| T1 | fflate (npm install) + `src/bundle/schema.ts` | `package.json`, lock, `src/bundle/schema.ts` | — | typecheck; `import {zipSync} from "fflate"` резолвится под bun |
| T2 | Экспорт: `server/bundle/exporter.ts`, export-хвосты, `routes/bundles.ts` (`GET /api/bundles/export`), диспатч, export-контракты **+ их coverage-cases в `contract.test.ts` + реген `openapi.json`**, capabilities (schema+toEqual), экспорт `themeAssetIds` из `share/repo.ts`, `bundle-export.test.ts` | перечисленные + shared | T1 | **весь** `bun test server` зелёный, включая contract.test |
| T3 | Импорт: `server/bundle/importer.ts`, `createPrototypeFromDoc`, `POST /api/bundles/import`, import-контракт **+ raw-zip coverage-case + реген `openapi.json`**, `bundle-import.test.ts` | перечисленные + shared | T2 | round-trip+конфликты+malformed зелёные; весь `bun test server` зелёный |
| T4 | Клиент: `src/api/bundles.ts`, экспорт в ComponentPage, `strings/componentPage.ts` | перечисленные | T2 (∥ T3) | скачивается валидный zip против dev-сервера; lint/typecheck |
| T5 | Gallery UI: export в VersionsMenu + не-owner кнопка, bulk-anchor, `ImportDialog.tsx`, `strings/gallery.ts` | `GalleryPage.tsx`, `ImportDialog.tsx`, `strings/gallery.ts` | T3, T4 | dry-run → apply работает вручную |
| T6 | `docs/server-api.md`, `e2e/bundles.spec.ts`, финальный прогон | доки + e2e | T3–T5 | `npm run verify` + `npm run e2e` зелёные + runtime-прогон `/verify` |

## Риски (поведение продукта)

1. Импорт не атомарен → dry-run (помечен предварительным) + правдивый отчёт.
2. Version-drift пинов: пересчёт на цели (= поведению свежего POST), задокументировано.
3. Zip в памяти, кап 512 MiB (проверка до материализации); streaming — совместимый follow-up.

## Верификация

`npm run verify` + `npm run e2e` + runtime-прогон `/verify`; ручной round-trip: экспорт прототипа с custom-компонентом → импорт под вторым аккаунтом на dev → рендерится и забинден на импортированный компонент.

## Триаж адверсариального ревью (2 ревьюера Opus, 2026-07-20)

**Принято** (все вошли в v2): B1×2 — владение `contract.test.ts`/`openapi.json` (блокер; правило «контракт = case + реген в той же задаче», shared-sequential список); B2 — бюджет распаковки через central directory + пост-сверку; B3 — tombstone-ветка `deleted_conflict`; M1 — bulk экспортирует published-версии; M2 — экспорт owner'а через `VersionsMenu`; M3 — чужая custom DS = reuse by reference; M4 — compat-поля в `manifest.source` + `format_too_new`; B5 — экспорт `themeAssetIds`; B6 — `validateThemeAssets` при вставке темы; B9 — `ComponentRepo.version()`; B11 — кап до материализации; B12 — round-trip-ассерт биндинга; B4 — import-case raw-zip; m2 — bulk через anchor; m4 — `builtin_name_reserved`; m5 — e2e-фикстура из экспортёра; m6 — неймспейс `/api/bundles/*`; B7 — заметка про state/flows; B10/m3 — dry-run помечен предварительным; m1 — shared-sequential зафиксирован.

**Принято как продуктовое решение без изменений кода**: B8 — бандл агрегирует чужой TSX (консистентно с текущим `GET /source`), отражено в доках.

**Отклонено**: нет.
