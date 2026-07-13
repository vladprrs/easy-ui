# [P0] Screenshot worker: разрешить pinned assets темы design system

## Контекст

Server-side screenshot worker использует capture session с точным сетевым allowlist. В него сейчас попадают route, API endpoints, component bundles и assets документа/компонента, но не assets metadata выбранной design system.

Тема подгружается во время render:

- `@font-face` читает `fonts[].src`;
- icon registry читает `icons[].assetId`;
- тематические варианты читают `icons[].themes.light` / `icons[].themes.dark`.

Из-за отсутствия этих URL в allowlist браузер получает `ERR_FAILED`, точный шрифт/иконка не загружается и screenshot снимается с fallback. Это блокирует достоверный visual regression: меняются метрики текста, переносы и геометрия всего экрана.

## Наблюдаемое поведение

1. Design system содержит валидный font asset.
2. Prototype сохраняется и пинит `designSystemMetaVersion`.
3. Обычный player может прочитать тему.
4. Server-side screenshot enqueue формирует capture allowlist без `/api/assets/<theme-asset-id>`.
5. Screenshot browser блокирует font/icon request.
6. Capture формально может завершиться, но visual evidence недостоверно из-за fallback.

## Ожидаемое поведение

При создании screenshot job разрешить только точные asset URL темы:

- для prototype — из **закреплённой** `designSystemMetaVersion` revision;
- для component screenshot — из latest theme content, соответствующего текущей component screenshot semantics;
- `fonts[].src`;
- `icons[].assetId`;
- `icons[].themes.light`;
- `icons[].themes.dark`.

Не разрешать wildcard `/api/assets/` и не обходить capture-session authorization.

## Предлагаемая реализация

Готовый commit приложен как `patches/0001-fix-allow-theme-assets-in-screenshot-capture.patch`.

Изменения:

1. Добавить чистую функцию `themeAssetIds(content)`:
   - собрать font/icon asset IDs;
   - включить light/dark variants;
   - дедуплицировать через `Set`.
2. Передать pinned `designSystemMetaVersion` в prototype allowlist builder.
3. Для prototype получить exact pinned theme version через `getDesignSystemVersion`.
4. Для component screenshot получить latest theme content через существующий `getLatestDesignSystemContent`.
5. Добавить только `/api/assets/<exact-id>` в job allowlist.

## Security constraints

- Никакого широкого `/api/assets/` prefix.
- Никакой передачи Basic Auth в screenshot page.
- Capture-session token и loopback-only ограничения не меняются.
- Prototype обязан использовать pinned theme version, чтобы более новая theme revision не расширяла allowlist старого screenshot target.
- Дубликаты asset IDs не должны расширять поверхность.
- Поведение prototype/component без custom theme не меняется.

## Acceptance criteria

- [ ] `themeAssetIds` возвращает font, base icon, light и dark IDs без дублей.
- [ ] Prototype screenshot job содержит `/api/assets/<font-id>` из pinned design-system version.
- [ ] Prototype revision не начинает использовать assets более новой theme version.
- [ ] Component screenshot job содержит exact assets текущей темы.
- [ ] Screenshot с custom WOFF2 не получает `ERR_FAILED` для font asset.
- [ ] `document/bundles/route` и screenshot readiness остаются healthy.
- [ ] Нет wildcard-разрешения всех assets.
- [ ] `npm run server:typecheck` проходит.
- [ ] `bun test server/screenshot.test.ts` проходит.
- [ ] `npm run server:test` проходит полностью.
- [ ] Полный CI `npm run verify` проходит перед merge.

## Проверенные результаты change-set

На commit `c261a3d`:

- `npm run server:typecheck` — pass;
- `bun test server/screenshot.test.ts` — 12 pass, 0 fail;
- `npm run server:test` — 136 pass, 0 fail, 902 assertions.

## Changed files

- `server/screenshot/service.ts`
- `server/screenshot.test.ts`

## Out of scope

- Регистрация конкретных production fonts/icons в metadata design system.
- Изменение auth policy asset endpoint.
- Ослабление browser egress isolation.
- Изменение visual threshold.
- Figma MCP или prototype component composition.

## Rollout

1. Применить patch к актуальному `main`.
2. Запустить acceptance commands.
3. Merge после CI.
4. Задеплоить обычным production pipeline.
5. Создать/обновить design-system theme version с тестовым WOFF2.
6. Сохранить prototype, чтобы он закрепил новую theme version.
7. Выполнить server-side screenshot с `waitForFonts=true`.
8. Проверить отсутствие browser errors и фактический font load.

## Rollback

Revert commit и обычный redeploy. Изменения схемы БД и миграции отсутствуют.
