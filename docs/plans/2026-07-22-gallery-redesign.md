# Перевёрстка главного экрана (галерея прототипов) с нуля

## Context

Главный экран `/` (список прототипов) свёрстан одним файлом `src/gallery/GalleryPage.tsx` (330 строк): три раздельных ряда фильтров, карточки `bg-eui-lav` с превью в середине и 7+ действиями вперемешку в одном ряду. Пользователь хочет пересобрать вёрстку с нуля: **бренд eui сохраняем** (фиолетовый #844EDC, lav/lilac-фоны, Coil/YS Text), скоуп — **только страница галереи** (Layout/header не трогаем), **UX можно пересмотреть** (редкие действия — в меню «⋯»). Функциональность сохраняется целиком: табы Мои/Общие/Архив, чипы дизайн-систем, поиск, сортировка, живые превью, Презентация/CJM/Редактор/QR/версии/экспорт/статусы, создание, импорт/экспорт.

## Дизайн нового экрана

Каркас `<main class="mx-auto max-w-6xl p-6 sm:p-8" data-gallery-ready>` сохраняем, внутри всё новое.

**Hero-зона**: kicker («Галерея», роль `kicker`) над `h1` + счётчик прототипов рядом с заголовком; справа — `Новый прототип` (pillPrimary), а «Импортировать»/«Экспортировать всё» уходят в компактное `<details>`-меню рядом. На мобиле primary — `w-full sm:w-auto`.

**Единый toolbar** вместо трёх рядов — `<section class="mt-6 rounded-3xl bg-eui-lav p-4 sm:p-5">`:
- ряд 1: сегмент-контрол табов (обёртка `rounded-full bg-white p-1`, кнопки `aria-pressed`, активная — chipActive) + поиск справа (`<label>«Поиск по названию»`, `type="search"`, иконка-лупа, `sm:w-72`);
- ряд 2: чипы ДС («Все» + системы, `aria-pressed`; `overflow-x-auto flex-nowrap` на мобиле — скролл только внутри ряда) + `<select>` сортировки с `<label>«Сортировка»` справа.

**Карточка** (`PrototypeCard`): `<li class="group relative flex min-w-0 flex-col overflow-hidden rounded-3xl bg-white ring-1 ring-eui-ink/5 transition hover:-translate-y-0.5 hover:shadow-xl focus-within:shadow-xl motion-reduce:transform-none">` — карточка белая, превью в лавандовой «сцене» **сверху**:
1. Сцена `relative bg-eui-lav p-4`: `GalleryPreview` (для архивных — блок `data-prototype-archived="true"` без превью); бейджи статуса/владельца — оверлеем `absolute left-4 top-4 z-10 flex gap-2`.
2. Тело `p-5 flex-1 flex flex-col`: `h2` (`font-eui-display text-lg`) с растянутой ссылкой (`after:absolute after:inset-0`, focus-кольцо как сейчас, дословно) на `/p/:id`; описание `line-clamp-2 min-h-10 text-sm text-eui-slate-500`; мета — `<dl>` семантически, визуально ряд пилюль (`flex flex-wrap gap-1.5`, `rounded-full bg-eui-lav px-2.5 py-1 text-xs`): устройство, экраны, система (lilac-200), `<time>` дата.
3. Ряд действий `mt-auto pt-4` → `<div class="relative z-10 flex flex-wrap items-center gap-2">`:
   - inline-ссылки строго в порядке **Презентация** (акцентная), **CJM**, **Редактор** (owner) — контракт unit-теста;
   - **QR на телефон** (button) и **Версии…** (`<details>`) — остаются видимыми (контракты);
   - **«⋯»-меню** (`CardActionsMenu`, `<details>`, summary-кнопка `aria-label="Действия"`): статусы Опубликовать/Снять/В архив/Вернуть (owner) + Экспорт (latest) для чужих. Внутри — бывшие OwnerControls/PrototypeExportButton.

**Состояния**: loading — скелетон-сетка из 6 `<li class="rounded-3xl bg-eui-lav animate-pulse motion-reduce:animate-none h-72">` в том же grid + текст «Загружаем прототипы…» в `aria-live` (unit-контракт; `data-gallery-ready` остаётся "false"); failed / emptySearch / emptyFiltered / «Создайте первый прототип» / noUsableSystems — те же тексты и роли, обновлённая подача (плашки `plate`).

**Grid**: `mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3` — сохраняем (e2e меряет 1024px без горизонтального скролла).

**Механика «⋯» и details-меню**: нативный `<details>/<summary>` (консистентно с VersionsMenu, без зависимостей) + новый хук `useDismissableDetails` — закрытие по клику-вне (`pointerdown` на document при open) и Escape (фокус назад на summary). Применить к CardActionsMenu, hero-меню и VersionsMenu.

## Декомпозиция файлов

`filterAndSortPrototypes` + типы `GalleryTab/GallerySort/GalleryFilters` **остаются экспортами `GalleryPage.tsx`** (unit-тест импортирует оттуда).

| Файл | Содержимое |
|---|---|
| `src/gallery/GalleryPage.tsx` | контейнер: useApi×3, состояние, деривации, оркестрация состояний, диалоги; монтирует новые компоненты |
| `src/gallery/components/GalleryHero.tsx` | kicker/h1/счётчик + Новый/Импорт/Экспорт-всё |
| `src/gallery/components/GalleryToolbar.tsx` | табы + чипы ДС + поиск + сортировка (чистые пропсы) |
| `src/gallery/components/PrototypeCard.tsx` | карточка целиком + `PrototypeStatusBadge` |
| `src/gallery/components/CardActionsMenu.tsx` | «⋯»: статусы + экспорт latest (бывшие OwnerControls/PrototypeExportButton) |
| `src/gallery/components/VersionsMenu.tsx` | перенос VersionsMenu из page без изменения логики |
| `src/gallery/components/GalleryStates.tsx` | скелетоны + empty/failed/noUsableSystems |
| `src/gallery/useDismissableDetails.ts` | хук клик-вне/Escape для `<details>` |
| `src/gallery/galleryFormat.ts` | `formatGalleryUpdatedAt` (реэкспорт из GalleryPage для совместимости, если нужно) |
| `src/app/strings/gallery.ts` | новые строки: `overflowActionsAria` («Действия»), kicker, счётчик и пр. |
| `src/gallery/GalleryPreview.tsx` | ЕДИНСТВЕННАЯ правка: внешний `mt-5` → проп `wrapperClassName` (дефолт прежний); логику не трогать |

Не трогаем: `GalleryShareDialog`, `ImportDialog`, `prototypeTemplates`, Layout, chrome.ts, index.css.

## Контракты тестов

**Сохраняем дословно** (тесты не правим): `<li>`/listitem; `h2` с именем; растянутая ссылка `after:absolute after:inset-0` + её focus-классы; ряд действий `relative z-10`; порядок ссылок Презентация/CJM/Редактор; «Версии…» `.closest("details")` с `relative`; кнопка «QR на телефон»; `getByLabelText("Поиск по названию")`/«Сортировка» (label-обёртки); табы/чипы `button`+`aria-pressed`+`aria-label`; `data-gallery-ready`, `data-gallery-preview*`, `data-prototype-archived`, `gallery-preview-<id>`, `[inert]`; все тексты состояний/дат/диалога создания.

**Обновляем** (перенос статусов в «⋯» — осознанное UX-решение):
- `src/gallery/GalleryPage.test.tsx`: тесты owner-controls (~стр. 270–296) — перед кликом статус-кнопок открывать «⋯» («Действия»); проверка отсутствия у чужой карточки — по отсутствию статус-кнопок внутри «⋯»/отсутствию пунктов.
- `e2e/dev/multiuser.spec.ts` (4 точки, ~стр. 40–48): открыть «⋯» карточки перед кликом статуса (Playwright не кликает по скрытому в закрытом details).
- `legacy-archive.spec.ts`, `onboarding.spec.ts`, `gallery.spec.ts` — правок не требуют.

## Процесс (по workflow CLAUDE.md)

1. Сохранить этот план в `docs/plans/2026-07-22-gallery-redesign.md`, закоммитить.
2. **Stage 2**: адверсариальное ревью плана Opus-субагентом (линзы: контракты тестов, превью-очередь, a11y); триаж находок в план; при существенных правках — повторное ревью.
3. **Stage 3** — исполнение Opus-субагентами (не коммитят, оркестратор верифицирует и коммитит поволново):
   - **T0** (блокирующая): строки в `strings/gallery.ts`, `useDismissableDetails.ts`, `galleryFormat.ts`, `wrapperClassName` в `GalleryPreview.tsx`, зафиксировать пропс-контракты компонентов. Owner: эти 4 файла.
   - **Волна 1 (параллельно, непересекающиеся файлы)**: T1 `GalleryToolbar.tsx` · T2 `PrototypeCard.tsx` · T3 `CardActionsMenu.tsx`+`VersionsMenu.tsx` · T4 `GalleryHero.tsx`+`GalleryStates.tsx`.
   - **T5**: сборка `GalleryPage.tsx` (контейнер, удаление перенесённого, сохранение экспортов).
   - **T6** (отдельный коммит): правка `GalleryPage.test.tsx` + `e2e/dev/multiuser.spec.ts`.

## Верификация

1. `npx vitest run src/gallery/` — фокусные unit во время работы.
2. `npm run verify` (typecheck, lint, vitest, server:test, build, check:css).
3. `npm run e2e` — минимум `gallery.spec.ts`, `multiuser.spec.ts`, `legacy-archive.spec.ts`, `onboarding.spec.ts` (gallery.spec меряет отсутствие горизонтального скролла на 1024 и превью).
4. Runtime-прогон по `.claude/skills/verify/SKILL.md`: скриншоты — сетка, архивная карточка, открытое «⋯», пустое состояние, мобильный вьюпорт, focus-visible.

## Риски

- **Превью**: не добавлять обёртки, меняющие момент IntersectionObserver-пересечения; `data-gallery-preview*`-div и очередь на 4 — не трогать; `mt-5` решается только пропом `wrapperClassName`.
- **Растянутая ссылка**: все интерактивы карточки — в `relative z-10`-слоях, никаких вложенных `<a>`; бейджи-оверлей поверх сцены — не ссылки.
- **Порядок inline-ссылок** — не добавлять видимых `<a>` в ряд действий (сломает `toEqual([...])`).
- **Горизонтальный скролл**: `overflow-x-auto` только на ряду чипов, не на документе.
- **Скелетоны** не должны выставлять `data-gallery-ready="true"`; текст загрузки остаётся в DOM.
