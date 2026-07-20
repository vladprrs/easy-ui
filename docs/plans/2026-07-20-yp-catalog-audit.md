# Аудит каталога yandex-pay: компоненты, прототипы, prod-обновление, DS-скилл, design.md

## Context

Прод easy-ui.pay-offline.ru несёт дизайн-систему `yandex-pay`: **101 published кастомный компонент** и **33 прототипа-драфта**. Сегодня сняты логические бэкапы в виде per-item ZIP-бандлов: `.backups/prod-components-20260720-130019/` и `.backups/prod-prototypes-20260720-130408/`. Исходники компонентов живут только на сервере (в репо их нет — решение пользователя: **не вендорить**, сервер = source of truth).

Выборочная разведка уже показала системные классы проблем:
- **Не-defensive доступ к props** — Renderer не применяет zod-дефолты; `yp-text` делает `metrics[props.size]` без fallback → краш при отсутствии пропа.
- **Legacy numeric spacing** (пиксельные литералы) вместо токенов ABI v3 `space()` — цель линта `layout/legacy-numeric-spacing`; образцовый паттерн — `yp-box` (ABI v3, layoutNeutral, layout v1).
- **Base64 data-URI в исходниках** вместо `/api/assets/` (`yp-ctyp-payment-page`, 16KB исходник).
- **Стейл-описания** («Visual parity remains blocked if YS Text font files are not provided» — шрифты давно в теме v4).
- **Hardcoded-палитра**: в теме v4 нет цветовых/типографических токенов (только `space.*` + шрифты) — цвета зашиты в каждом компоненте.
- **Мусор на проде**: shadcn-демо прототипы, evidence-драфты visual-regression циклов, демо-компонент `ui-rating-stars`.

Цель: аудит → non-breaking фиксы → обновление прода → продуктовые гипотезы → скилл использования DS для ИИ-агентов → `design.md` (формат [google-labs-code/design.md](https://github.com/google-labs-code/design.md): YAML front matter с токенами + markdown-разделы Overview/Colors/Typography/Layout/Elevation/Shapes/Components/Do's and Don'ts).

## Зафиксированные решения

1. **Без вендоринга** — рабочая копия аудита во временной директории; результат фиксируется новым экспорт-бэкапом в `.backups/` (решение пользователя).
2. **Prod-cleanup** (решение пользователя): архивировать shadcn-демо (`hello-world`, `checkout`, `settings`, `wireframe-demo`, `scale-demo`, `composition-demo`), архивировать evidence-драфты (`cpqr-*-evidence-*` ×5, `ctyp-sticky-footer-evidence`, `atoms-selector-slice-candidate`), депрекейтнуть `ui-rating-stars`.
3. **Только non-breaking фиксы**: props-схемы не сужаем, пропы не переименовываем/не удаляем — существующие доки прототипов обязаны оставаться валидными. Breaking-миграции (напр. numeric spacing → токены в `yp-text`) → в гипотезы/бэклог.
4. `design.md` — в корне репо; скилл — `.claude/skills/yandex-pay/` (конвенция: frontmatter `name`/`description`, опц. `reference/`).
5. Prod-обновление — через API `PUT /components/:id` + `POST /components/:id/publish` (CAS на baseRev), прототипы — `PUT /prototypes/:id` (re-pin). Кред: `.env` `EASYUI_USERNAME/PASSWORD`, драйвер `.claude/skills/author/driver.mjs` (дефолтный API — прод).

## Этапы исполнения

### Stage 0 — Локальный стенд и baseline
- Распаковать все бандлы в workspace (scratchpad): `components/<id>.tsx` + мета (version, rev, sourceHash из manifest), `prototypes/<id>.json`.
- Поднять локальный API: `~/.bun/bin/bun` (PATH: `~/.bun/bin` первым), `DATA_DIR` внутри корня проекта (напр. `.e2e-data/audit`, очистить), порт 8791 (не конфликтует с dev 8787).
- Импортировать все 134 ZIP через `POST /api/bundles/import?mode=apply` — каждый компонент пройдёт полный publish-пайплайн (tsc + Bun.build + линты) → **baseline-отчёт**: publish-ошибки/warnings по каждому.
- Baseline-скриншоты ключевых прототипов (author driver) для сравнения после фиксов.

### Stage 1 — Аудит (Workflow: Opus fan-out + адверсариальный verify)
Линзы для компонентов (чеклист каждому):
1. Defensive props (все обращения с fallback; lookup-таблицы безопасны).
2. ABI-гигиена: v1/v2/v3, spacing хардкодом vs `space()`, запрет одновременного value-import `easy-ui/runtime` и `/v3`.
3. Definition-качество: description актуален, `examples` покрывают состояния (≤8), `atomicLevel` корректен, layout-метаданные у layout-примитивов.
4. Ассеты: data-URI → `/api/assets/`, тяжёлые/неиспользуемые ассеты.
5. Props-схема: strictObject, enum вместо свободных строк, дефолты для editor-controls, мёртвые пропы.
6. Код: дубли между компонентами, a11y-базис, мёртвый код; **фиксировать фактическую палитру/радиусы/типографику** (сырьё для design.md, не менять).
Прототипы: layout-линты и atomic-nesting warnings, качество flows (notes, лейны), regions, stateOverrides, устаревшие паттерны.

Механика: pipeline-батчи ~7 компонентов на Opus-агента (по семействам: atoms/text, app-home, cpqr, payment/paybox, misc), structured-schema находок `{id, lens, severity: blocker|major|minor|info, evidence, proposed_fix, breaking}`;每 major+ находка — адверсариальный verify вторым агентом (refute). Прототипы — аналогично. Дальше dedup + триаж (Fable).
Выход: `docs/audit/2026-07-20-yp-catalog-audit.md` (находки, триаж принято/отклонено, статистика по классам).

### Stage 2 — Фиксы компонентов (Workflow, ownership по файлам)
- Только принятые non-breaking находки. Каждый fix-агент владеет своим списком `<id>.tsx`.
- Гейт на каждый фикс: `PUT` + `publish` на **локальном** сервере (typecheck/compile/линты) → для visual-чувствительных правок скриншот-дифф с baseline (внутренние фиксы обязаны быть пиксель-в-пиксель).
- Fable независимо верифицирует: все локальные publish зелёные, диффы объяснимы.

### Stage 3 — Обновление прототипов
- Фиксы доков по находкам (lints/notes/flows) в workspace → `PUT` на локальный сервер (валидация).
- Обновление витринных прототипов при необходимости (`yp-design-system-gallery`, atoms-стенды).

### Stage 4 — Документы-деливераблы
1. `docs/audit/2026-07-20-yp-catalog-audit.md` — итоговый отчёт (+что исправлено).
2. `docs/product-hypotheses-2026-07-20.md` — гипотезы по easy-ui из опыта аудита. Уже видные кандидаты: цветовые/типографические токены в теме (theme v5) + `color()` в ABI v4; применение zod-дефолтов Renderer'ом или publish-гейт на defensive access; линт/лимит на data-URI в исходнике; дедуп шрифтовых ассетов в bundle-экспорте (одни и те же 130KB шрифтов в каждом из 101 бандла); server-side lint API каталога; канал breaking-изменений (deprecate props + миграции доков). Список пополняется из аудита.
3. `design.md` (корень): front matter — colors (фактическая палитра из аудита), typography (шкала YS Text из `yp-text`), spacing (`space.*` темы v4), rounded; body — канонические разделы + карта каталога по atomic-уровням + Do's/Don'ts.
4. Скилл `.claude/skills/yandex-pay/SKILL.md` + `reference/catalog.json` (компактная карта: id, name, atomicLevel, версия, краткое описание, ключевые пропы): как агенту строить YP-прототипы — выбор компонентов по задаче, композиция (yp-screen → секции → карточки → атомы), spacing-правила (yp-box + токены), типографика (yp-text), типовые рецепты (экран оплаты, home-виджет, cpqr-шторка), do/don'ts, связь с author-скиллом и design.md.

### Stage 5 — Обновление прода
1. **Канарейка**: один изменённый компонент — `GET` meta → `PUT` (baseRev=headRev) → `publish` → проверка player. Заодно подтверждает права владельца.
2. Остальные изменённые компоненты (по sourceHash-диффу) последовательно; при publish-fail — стоп батча и разбор.
3. Прототипы: `PUT` изменённых доков; re-pin (`PUT` без изменений) остальных живых.
4. Статусы: `POST /prototypes/:id/status` → archived для демо и evidence; `POST /components/ui-rating-stars/versions/1/status` → deprecated.
5. Свежий экспорт-бэкап → `.backups/prod-components-<ts>/`, `prod-prototypes-<ts>/`.
6. Prod-смоук: `node .claude/skills/deploy/driver.mjs verify` + открытие ключевых player-URL + screenshot smoke.
Риск-контроль: версии иммутабельны, старые пины продолжают работать до re-save; статусы обратимы; бэкап «до» уже снят сегодня.

### Stage 6 — Финализация
- Коммиты по зонам: план → отчёт аудита → гипотезы → design.md → скилл. Исходники компонентов не коммитятся.
- `npm run validate:templates` (дёшево) — репо-код не меняем, полный verify не требуется; прогнать при любых сомнениях.
- Обновить память (файл о проходе аудита).

## Процесс (CLAUDE.md)
- После approve: план → `docs/plans/2026-07-20-yp-catalog-audit.md`, коммит.
- Адверсариальное ревью плана: Workflow, 3 Opus-ревьюера (линзы: correctness/полнота аудиторских линз; prod-риски и порядок обновления; скоуп и декомпозиция) + verify-стадия; триаж фиксируется в плане; существенные правки → повторное ревью.
- Исполнение Stage 0–6; Fable — оркестратор, независимо верифицирует done-критерии до коммитов и следующих волн.

## Верификация (сквозная)
- Локально: каждый изменённый компонент публикуется зелёным на локальном сервере; скриншот-диффы объяснимы; изменённые прототипы валидны.
- Прод: канарейка → батч → player-смоук ключевых сценариев (`cpqr-scenario`, `ctyp-paybox-scenario`, `pay-app-home-v1`, `yp-design-system-gallery`) → новый бэкап.
- Репо: `validate:templates`; коммиты документов; память обновлена.
