# Экспорт/импорт прототипов и custom-компонентов (ZIP-бандлы)

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

`manifest.json` (`formatVersion: 1`, zod-валидация): `kind` (`prototype|component|bulk`, информационно — импортёр един), `exportedAt`, `source.origin`; массивы `prototypes[]` (id, name, designSystem, `exported {selector, rev, version}`, docPath, componentPins, assetIds, designSystemMetaVersion), `components[]` (id, name, designSystem, sourcePath, `sourceHash`, exported, assetIds), `designSystems[]` (id, `builtin`, `theme {metaVersion, tokens, fonts, icons} | null`), `assets[]` (id, sha256, mime, size, originalName).

- Пины компонентов и DS meta-version в манифесте **информационные**: на импорте пины пересчитываются `snapshotDefinitions`, тема перепиновывается на версию целевого сервера.
- Ассеты хранятся в архиве один раз по sha (дедуп как на сервере).
- Схемы: **`src/bundle/schema.ts`** (`bundleManifestSchema`, `importReportSchema` + типы) — `src/` импортируем и сервером (прецедент: `contracts.ts` импортирует `src/prototype/schema`), и клиентом.

**Не экспортируем** (осознанно): `compiled_js`/`bundle_hash`/ABI (цель обязана перекомпилировать через publish pipeline), историю ревизий (только выбранная ревизия), скриншоты/visual-артефакты, share-гранты (секреты), `figma_json`, owner/audit, статус прототипа (импорт всегда `private`).

## Сервер: экспорт

Зависимость: `fflate` ^0.8 в корневой `package.json` (ставится **npm**; сервер резолвит из корневого node_modules). Zip в памяти (`zipSync`; JSON/TSX — deflate, ассеты — store), жёсткий кап суммарного сырья 512 MiB → `413 export_too_large`.

Новые файлы: `server/bundle/exporter.ts` (сборка замыкания + zip: `collectPrototypeClosure`, `collectComponentClosure`, `buildZip`), `server/routes/bundles.ts` (`/api/export`, `/api/import`).

| Endpoint | Authz | Семантика |
|---|---|---|
| `GET /api/prototypes/{id}/export?version=N` | `requirePrototypeRead`; draft (без `?version`) — только owner; не-owner по умолчанию — последняя published-версия, иначе 404 | прототип + полное замыкание; `easy-ui-prototype-<id>-{draft-r<rev>|v<N>}.zip` |
| `GET /api/components/{id}/export?version=N` | `requireUser` (как `/source`) | по умолчанию последняя active-версия; без публикаций — head draft (`version: null`); `easy-ui-component-<id>-v<N>.zip` |
| `GET /api/export` | `requireUser` | всё owned: прототипы (head drafts) + компоненты + объединённое замыкание; `easy-ui-export-<yyyymmdd>.zip` |

`export`-хвосты добавляются внутри существующих `routes/prototypes.ts` / `routes/components.ts` (по одному `if`, делегируют в exporter) — authz остаётся на месте; `routeBundles` только для `/api/export` и `/api/import` (диспатч в `main.ts`).

Замыкание прототипа: `PrototypeRepo.draft/version` → пины компонентов → `ComponentRepo.source(id, pinRev)` (rev из `component_publishes`) + их asset-пины → asset-пины ревизии → тема DS (`getDesignSystemVersion` + `themeAssetIds` — модель перечисления из `ShareRepo.dependencySnapshot`, `server/share/repo.ts:97-141`). Байты — `Bun.file(assetRepo.bytesPath(sha))`. Binary Response — по прецеденту `bundle.js` (`content-type: application/zip`, `content-disposition: attachment`, noStore).

## Сервер: импорт

`POST /api/import` — `requireUser`; multipart (`file`, как `/api/assets`) или raw zip; `?mode=dry-run|apply` (default `apply`).

Безопасность до записи: кап аплоада 256 MiB; `unzipSync` с бюджетом распаковки (512 MiB суммарно + на entry), entries ≤ 4096, каждый путь по allowlist-regexp (`manifest.json | prototypes/<slug>.json | components/<slug>/source.tsx | assets/<64hex>`); манифест через zod; перекрёстная сверка «все пути из манифеста есть в zip и наоборот»; байты ассетов перехешируются.

Порядок (зависимости первыми), политика конфликтов:
1. **Ассеты** — `AssetRepo.ingest` (content-addressed, идемпотентно) → `created|reused`.
2. **Дизайн-системы** — builtin: проверить наличие, иначе `design_system_missing`. Custom: id свободен → создать (owner = импортёр); id занят импортёром → reuse; чужой → `design_system_conflict`. Тема: отличается от последней на цели (deep-equal tokens/fonts/icons; asset-id стабильны) → `insertDesignSystemVersion(latest+1)`, иначе reuse.
3. **Компоненты** — только через `publishComponent` (`server/routes/components.ts:38`), `compiled_js` из бандла не используется никогда:
   - свой id, head sourceHash совпадает и есть active publish → **reused**; иначе `save` новой ревизии + publish → **created** (новая версия);
   - id свободен, но `name` (UNIQUE) занят: своим компонентом с тем же sourceHash → reuse с id-remap (только в отчёте — доки ссылаются по name, пины пересчитываются); чужим → item-error `name_conflict` (v1 без rename);
   - оба свободны → `create` + publish; провал pipeline → item-error с его сообщением.
4. **Прототипы** — через общий helper `createPrototypeFromDoc(...)`, извлечённый из POST-ветки `routePrototypes` (валидация/пины/audit идентичны):
   - id свободен → created; свой id: doc идентичен head → skipped, иначе новая head-ревизия; чужой id → remap `<id>-imported-<n>` → created + `remappedTo`;
   - компонент-зависимость не импортировалась → item-error `dependency_failed`.

**Без глобального rollback** (compile — сабпроцессы, в одну SQLite-транзакцию не завернуть): честный по-item отчёт `{items[{type,id,action:created|reused|skipped|error,detail,remappedTo?,version?}], summary}` (`importReportSchema`) + **dry-run** (анализ конфликтов без записи и без компиляции) для превью в UI.

## Контракты, capabilities, доки

- `server/contracts.ts`: 3 export-контракта (`contentType: "application/zip"`; ошибки 401/403/404/413) + import-контракт (`responseSchema: importReportSchema`; 400 `invalid_bundle`, 413, 415, 422).
- `server/routes/meta.ts`: `features.bundleExport/bundleImport` в capabilities (+ схема ответа).
- Реген `server/openapi.json` (drift verify-гейтится).
- `docs/server-api.md`: раздел «Bundles» (endpoints, схема манифеста, политика конфликтов, исключения).

## Клиент

Новый `src/api/bundles.ts` (`client.ts` не трогаем — параллелизм):
- `downloadBundle(url, fallbackName)` — fetch → `!ok` → `ApiError` (ошибки инлайн, не навигация), иначе blob + временный `<a download>` (`URL.createObjectURL`), имя из `content-disposition`;
- `importBundle(file, mode)` — FormData POST (паттерн `uploadAsset`).

UI (идиомы репо: `pillGhost/pillPrimary` из `src/app/chrome.ts`, инлайн `role="alert"`, без тостов, строки в `src/app/strings/*`):
1. **Gallery** (`src/gallery/GalleryPage.tsx:233` action row): per-card «Экспорт» (owner → draft; не-owner — только при `latestVersion !== null`); в шапке «Экспортировать всё» и «Импортировать».
2. **`src/gallery/ImportDialog.tsx`** (идиома модалок create-dialog/ShareDialog; скрытый file input по паттерну `AssetField`): выбор файла → авто dry-run → таблица отчёта → «Импортировать» (apply) → финальный отчёт → reload списка. Состояния idle/checking/preview/applying/done/error.
3. **ComponentPage** (`src/library/componentPage/ComponentPage.tsx:122-135`, рядом с селектором версии): «Экспорт» выбранной версии.
4. Строки: `strings/gallery.ts`, `strings/componentPage.ts`.

В v1 без кнопок в editor/player (галерея + страница компонента покрывают сценарии).

## Тесты

- `server/bundle-export.test.ts`: фикстура (custom DS + тема с font-ассетом, компонент с ассетом через publish, прототип с обоими) → export → `unzipSync` → манифест валиден, замыкание полное, байты сходятся по hash; `?version` vs draft; authz-матрица (не-owner draft → 403, published → 200, anonymous → 401 — по `ownership.test.ts`); bulk не содержит чужого приватного.
- `server/bundle-import.test.ts`: **round-trip** (export из handler A → import в свежий handler B: компонент перекомпилирован и active, `bundle.js` отдаётся, прототип renderable, тема на месте, отчёт весь `created`); повторный импорт → `reused/skipped`; конфликты (свой изменённый source → новая версия; чужой name → `name_conflict` + `dependency_failed` у прототипа; чужой id прототипа → `remappedTo`); dry-run ничего не пишет; malformed (не-zip, traversal-путь, sha mismatch, entry-бомба).
- `server/contract.test.ts` покрывает новые контракты автоматически (требует exercised + валидирует responseSchema).
- e2e `e2e/bundles.spec.ts`: экспорт из галереи (`page.waitForEvent("download")`), импорт-диалог dry-run на фикстурном zip.

## Декомпозиция (субагенты Opus; непересекающееся владение файлами)

| # | Задача | Владеет | Зависит | Done-критерий |
|---|---|---|---|---|
| T1 | fflate (npm install) + `src/bundle/schema.ts` | `package.json`, lock, `src/bundle/schema.ts` | — | typecheck; `import {zipSync} from "fflate"` резолвится под bun |
| T2 | Экспорт: `server/bundle/exporter.ts`, export-хвосты в `routes/prototypes.ts`+`routes/components.ts`, `routes/bundles.ts` (`/api/export`), диспатч `main.ts`, export-контракты, capabilities, `bundle-export.test.ts` | перечисленные | T1 | export-тесты зелёные, включая authz |
| T3 | Импорт: `server/bundle/importer.ts`, helper `createPrototypeFromDoc`, `/api/import`, import-контракт, реген `openapi.json`, `bundle-import.test.ts` | перечисленные | T2 (последовательно — общие `contracts.ts`/`routes/*`) | round-trip+конфликты+malformed зелёные; openapi drift чист; contract.test зелёный |
| T4 | Клиент: `src/api/bundles.ts`, кнопка экспорта в ComponentPage, `strings/componentPage.ts` | перечисленные | T2 (∥ T3) | скачивается валидный zip против dev-сервера; lint/typecheck |
| T5 | Gallery UI: per-card export, bulk, `ImportDialog.tsx`, `strings/gallery.ts` | `GalleryPage.tsx`, `ImportDialog.tsx`, `strings/gallery.ts` | T3, T4 | dry-run → apply работает вручную |
| T6 | `docs/server-api.md`, `e2e/bundles.spec.ts`, финальный прогон | доки + e2e | T3–T5 | `npm run verify` + `npm run e2e` зелёные + runtime-прогон `/verify` |

Параллелизм: T3 ∥ T4; остальное цепочкой.

## Риски (зафиксированы как поведение продукта)

1. Импорт не атомарен (compile-сабпроцессы) → dry-run + правдивый по-item отчёт, задокументировано.
2. Дрейф номеров версий: пины/тема пересчитываются на цели (то же поведение, что у свежего `POST /api/prototypes`).
3. Zip в памяти с капом 512 MiB; streaming `fflate.Zip` — совместимый follow-up без смены формата.

## Верификация

`npm run verify` + `npm run e2e` + runtime-прогон по `.claude/skills/verify/SKILL.md`; ручная проверка round-trip: экспорт прототипа с custom-компонентом → импорт под вторым аккаунтом на dev → прототип рендерится.

## Процесс после одобрения (workflow CLAUDE.md)

1. Сохранить план в `docs/plans/2026-07-20-bundle-export-import.md`, закоммитить.
2. Stage 2: адверсариальное ревью плана субагентами (Opus), триаж находок в плане, итерация до отсутствия блокеров.
3. Stage 3: исполнение T1–T6 субагентами (Opus) по таблице владения; оркестратор независимо верифицирует done-критерии и коммитит по зонам.
