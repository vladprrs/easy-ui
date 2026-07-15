# Spacing/Layout Contract v1 + Agent-DX (2026-07-15) — v7 (финал; 6 раундов Codex-ревью, раунд 6 — без blocking-возражений)

## Context

Анализ реальных прод-прототипов показал: на yandex-pay (единственная «живая» агентская DS, 78 компонентов) **33% всех элементов документа — это `YpSpacer`** (54 из 165 в cpqr-scenario), потому что `YpBox` — флекс-контейнер без `gap`/`padding`/`margin`. Enum размеров спейсера (4–24) не покрывает нужные значения → агенты штабелируют спейсеры (24+24+16 = 64px тремя элементами), 2×2 сетки строятся вложенными боксами с gutter-спейсерами, magic numbers (`8`×21, `24`×31) без токенов, все 9 пропов YpBox сериализуются даже в дефолтах (причина — manifest экспортирует output-схему Zod; см. D9a). У формата нет общего spacing-контракта; единственный «лаз» — недокументированный `className` на shadcn Stack/Grid/Card. У агента нет численного фидбэка по layout — только пиксельный дифф.

Решения пользователя: (1) общий spacing-контракт на уровне формата, YpBox/YpBlock — первое применение, `layoutNeutral` разрешить custom-компонентам; (2) позиционирование = поток (flex/grid) + узкий overlay-примитив, без свободных координат; (3) agent-DX: spacing-линты + геометрический фидбэк + layout-гайд в SKILL.md (codemod не делаем).

## Триаж ревью

**Раунд 1** (4 blocker, 13 major, 3 minor): все приняты → v2 (Overlay как host-примитив; сериализация `layout` до агента; geometry-probe без asset ingest; `{io:"input"}`; wireframe px не трогаем; W0/W7; `code` у issues; единый Zod-introspect; eligibility `layoutNeutral`; advisory className; save/publish-стадии).

**Раунд 2** (3 blocker, 12 major, 3 minor): все приняты → v3 (`flow`-метаданные; единый резолв шкалы; HostStageSurface для всех поверхностей; host-секция discovery отдельно от bundle-manifest; px-only `space.*` (все 9 ключей, монотонность, merged-тема); SSR≠browser conformance; ужесточение eligibility; шкала до `4xl=64`; hash-детектор (не pin) + `renderContractVersion`; discriminated geometry contract; per-component lint-allowlist; W7-rollback через новую версию темы/deprecated/CAS-restore; baseline-tuple; W2-gate).

**Раунд 3** (2 blocker, 9 major, 3 minor): все приняты → v4:
- **B1″ (синтез токенов несовместим с ABI v2: global snapshot обновляется после рендера, last-writer-wins при параллельных превью)** → **ABI v3**: `token("space.md")` возвращает CSS-ссылку `var(--eui-space-md)`; 9 resolved-переменных ставятся на root каждой render surface; ABI v2 не меняется (legacy-компоненты сохраняют старое поведение, включая `""` за отсутствующий токен); резолвер чистый: `resolveSpacingScale(systemId, themeTokens)`, загрузка pinned-темы — в server/browser-адаптерах (D2).
- **B2″ (противоречивая модель stage-якоря: max(viewport, content) + не-скроллящийся overlay несовместимы)** → нормативная модель **StageViewport vs ContentBox**: Overlay — viewport-sticky (якорится к StageViewport, не скроллится с контентом); `stageHostRef` предоставляется caller'ом, overlay-portal монтируется в него; canvas переиспользует `CanvasLayers` третьим упорядоченным слоем; тест сохранения containing block у legacy absolute-элементов (D5).
- **M3″–M11″**: `flow.kind:"flex"` + инварианты валидации + `n/a` при dynamic/unmapped (D3); алгоритм поиска layout owner для `display:contents`-маркеров + `rowGap`/`columnGap` + `parentInstance` (D7); W2b публикует только пустой hostPrimitives-реестр, дескриптор Overlay/hash bump/reference — в W4 + W4-gate (Waves); action runtime получает полный spec, порядок сплитов hostPrimitives→canvas, merge host-компонентов в `src/catalog/runtime.ts` (D5); Gallery-приёмка сужена до Overlay с host/builtin-детьми (custom-загрузка в Gallery — отдельный follow-up) (W4); источник пропсов для sentinel-conformance (`safeParse({})` → example → `conformanceProps`), sentinel в `slots.default` И `children`, отсутствие = error (D4); W0-аудит прод-DB на legacy `space.*` во всех источниках/темах + fail-soft политика (W0/D2); все 9 значений шкалы зафиксированы per-DS явно (D2); ownership дополнен (Waves).
- **m12″–m14″**: «7 ключей» исправлено на 9; magic-number-линт честно назван legacy numeric-spacing с явным списком; placement-семантика ширины: top/bottom — stretch на ширину stage минус insets, углы/center — shrink-to-fit (D5).

**Раунд 4** (2 blocker, 6 major, 2 minor): все приняты → v5:
- **B1‴ (нет negotiation-механизма ABI v3: компилятор различает только module specifier)** → отдельный specifier **`easy-ui/runtime/v3`** — его импорт однозначно выставляет `hostAbiVersion=3`; `easy-ui/runtime` навсегда означает v2 (случайный downgrade/upgrade невозможен). Ownership W1 дополнен: `server/components/compile.ts` (IMPORT_ABI_V3), `server/routes/shims.ts` + `server/main.ts` (маршрут `/api/shims/v3/*`), `.d.ts` для v3, extraction-адаптер per-specifier, `server/share/repo.ts` (share/capture-ресурсы); smoke-тест смешанного документа ABI2+ABI3; W2-gate расширен до «компонент импортирует `space()`, публикуется с `host_abi_version=3`, грузит v3-шим и получает вычисленный spacing в браузере» (D2).
- **B2‴ (desktop StageViewport без нормативной высоты: canonical desktop viewport = auto-height)** → **v1-scope: Overlay на desktop-экранах без canvas запрещён** (validate error с внятным сообщением) — mobile flow/canvas и desktop canvas покрывают все прод-кейсы; format-level desktop viewport height — follow-up вне v1. Truth table задаёт для каждой поверхности конкретный DOM-узел StageViewport, width/height, scroll owner, overflow, capture-поведение и позицию Overlay после scroll (D5).
- **M3‴ (var() ломает generic token())** → в ABI v3 `token()` остаётся value-returning (семантика v2); CSS-ссылку возвращает только новый `space("md")` → `var(--eui-space-md, 12px)` (canonical fallback запечён) (D2).
- **M4‴ (CSS-переменные не переживают порталы)** → внешние порталы — нормативно вне v1; fail-soft — запечённый fallback в `space()`; surface-local portal root — follow-up; conformance-тесты: ABI3-ребёнок внутри Drawer/Dialog, две поверхности с разными темами (D2/D5).
- **M5‴ (масштабированные превью)** → API различает `ClipViewport` / `StageViewport` (native-координаты, внутри transform chain) / `ContentScroller` / portal root; Overlay — в той же transform chain, что контент; тесты scale≠1, player zoom, canvas pan/zoom (D5).
- **M6‴ (W4 перегружена)** → разрез на **W4a–W4d** (core скрытой возможностью → primary stages → preview adapters → exposure+gate); Overlay не рекламируется агенту до W4d; W1 вводит `SurfaceSpacingScope`, фактическое подключение поверхностей — W4b/W4c; ownership: publish-path резервации имени, `src/capture/CapturePrototype.tsx`, caller-файлы (Waves).
- **M7‴ (flow-инвариант сравнивал значения разных пропов)** → disjoint только между `vertical`/`horizontal`/`none`; `direction.prop !== wrap.prop`; `enabled` проверяется отдельно (непустота/уникальность/принятие схемой) (D3).
- **M8‴ (PATCH-семантика legacy-тем противоречива)** → grandfathering: PATCH без `tokens` переносит malformed-группу как есть (резолвер продолжает её игнорировать); PATCH с `tokens`, содержащий любой `space.*`, требует полной валидной группы; тесты fonts-only/icons-only/unrelated/partial/full-repair (D2).
- **m9‴ (`conformanceProps`)** → bounded JSON-safe object (лимит 16 KiB), server-only (не в manifest/hash); каждый кандидат прогоняется через `safeParse`, рендерится parsed-результат (D4).
- **m10‴ (shadcn-строка шкалы)** → зафиксирована в плане по фактическому npm-коду (`gap-0/2/3/4/6`): 0/8/12/16/24 px для none/sm/md/lg/xl; W1-снапшот подтверждает таблицу, а не определяет её (D2).

**Раунд 5** (2 blocker, 4 major, 2 minor): все приняты → v6:
- **B1⁗ (host-примитив не проходит серверный save/publish-цикл: `snapshotDefinitions`, `PrototypeRepo.publish` и `validatePrototype` считают всё вне DS-definitions custom-компонентом)** → общий модуль `hostPrimitiveDefinitions`/`hostPrimitiveNames`, используемый клиентом **и** сервером: `server/validation.ts` исключает host-типы из custom lookup/pins и добавляет их definitions для валидации; `PrototypeRepo.publish` считает host-тип известным без pin; `validatePrototype` различает host/custom для semantic/atomic/slot-правил. W4a API-тест полного цикла create/save/publish с Overlay + проверка отсутствия Overlay в pins и manifest hash (D5/W4a).
- **B2⁗ (desktop-запрет обходится device-switcher'ом плеера; truth table отложена на W4d)** → runtime-правило: desktop preview **отключается** (disabled с подсказкой) для текущего non-canvas экрана с Overlay; уже выбранный desktop автоматически сбрасывается при навигации на такой экран/смене версии; тесты mobile/tablet→desktop, canvas→non-canvas, смена экранов/версий; tablet добавлен в приёмку. **Truth table — обязательный первый деливерабл W4b** (reviewed entry-gate: оркестратор принимает документ до любых изменений DOM), покрывает player preview override/present/capture/editor main+strip/CJM/Gallery/Storybook, tablet flow/canvas (D5/W4b).
- **M3⁗ (W2-gate раньше подключения scope)** → в W1 `SurfaceSpacingScope` подключается к **capture root** (там уже есть ThemeStyle); W2-gate проверяет через capture с **неканоническим** значением (custom-тема `md=20px`) + наличие `--eui-space-md` на нормативном stage root; проверка остальных поверхностей — после W4b/W4c (Waves).
- **M4⁗ (W4c без pinned-темы)** → загрузка exact theme version на уровне prototype-surface, передача `ThemeContent`/resolved scale вниз; ownership += `EditorView.tsx`, `CjmShell.tsx`/`CjmView.tsx` (+`PrototypeLoader.tsx` при необходимости); Gallery использует `draft.designSystemMetaVersion`, не latest; тест старой опубликованной ревизии после выхода новой версии темы (W4c).
- **M5⁗ (`:root`-публикация `space.*` из ThemeStyle ломает portal-fallback)** → `space.*` **исключается из `serializeThemeCss`/`:root`**; `SurfaceSpacingScope` — единственный CSS-владелец namespace `--eui-space-*` (безопасно: до этого плана `space.*`-токенов не существует; W0-аудит подтверждает отсутствие legacy `var(--eui-space-*)`); семантика внешнего портала: значение = запечённый canonical fallback (переменная отсутствует в body-scope); portal-conformance — две разные неканонические шкалы с явными ожидаемыми значениями (D2).
- **M6⁗ (hash-callsite ревизий)** → `server/repos/prototypes.ts` в ownership W2b: `builtinCatalogHashFor` получает scale pinned `design_system_meta_version`; restore использует скопированную версию темы; тесты hash для двух версий темы + restore старой ревизии; W4d ownership += `server/routes/designSystems.ts` (D2/W2b/W4d).
- **m7⁗ (смешанные value-imports v2+v3)** → 422 на compile; type-only v2 + value v3 разрешён; compiler-тесты mixed/type-only/capabilities+v3 (D2).
- **m8⁗** → пример в D9 унифицирован: `space("md")` → `var(--eui-space-md, 12px)`.

**Раунд 6**: blocking-возражений нет (0 blocker, 0 major); 5 minor приняты и внесены: W0 — fail-closed (найденный legacy `var(--eui-space-*)` или конфликт имени `Overlay` останавливает W1/W4a до отдельного решения); фикстурная тема W2-gate — полная валидная шкала `0/4/8/20/24/32/40/56/72px`; путь исправлен на `src/player/PrototypeLoader.tsx`; scope-target W1/W2-gate — существующий `#eui-capture-surface`; приёмка stages включает tablet, версия документа выправлена.

## Архитектурные решения

### D1. Форма контракта: конвенция «имя + канонический enum» + метаданный блок `layout`

Компонент-контейнер объявляет пропы из стандартного словаря (`gap`, `padding`, `paddingX`, `paddingY`), типизированные каноническим token-enum'ом (или подмножеством), и декларирует это блоком `layout` в definition-метаданных (additive-паттерн `atomicLevel`/`interactive`, `src/catalog/normalize.ts:17-41`). Грамматика документа не меняется, старые документы валидны.

Стадии валидации: **save (checkSource)** — shape-валидация декларации (422); **publish** — SSR-conformance (рендерится, принимает пропы, сохраняет sentinel default child; см. D4). SSR-смоук не заявляется как проверка computed-геометрии; browser-conformance — conformance-фикстуры W6 + geometry probe.

Отвергнуто (раунд 0): `layout`-блок в грамматике документа; серверный mixin в схемы.

### D2. Token scale, ABI v3 и единый резолв

```
spaceToken = none | xs | sm | md | lg | xl | 2xl | 3xl | 4xl
```

**Явные таблицы всех 9 значений (вход resolveSpacingScale, builtin hash и snapshot-тестов):**

| Токен | none | xs | sm | md | lg | xl | 2xl | 3xl | 4xl |
|---|---|---|---|---|---|---|---|---|---|
| canonical/custom fallback | 0 | 4 | 8 | 12 | 16 | 24 | 32 | 48 | 64 |
| wireframe (существующие sm/md/lg не меняются) | 0 | 4 | 8 | 16 | 24 | 32 | 48 | 64 | 80 |
| yandex-pay (тема) | 0 | 4 | 8 | 12 | 16 | 24 | 32 | 48 | 64 |
| shadcn (по факту npm: gap-0/2/3/4/6; xs и 2xl+ — из canonical fallback) | 0 | 4 | 8 | 12 | 16 | 24 | 32 | 48 | 64 |

- Подмножество канонического enum — валидно (shadcn Stack `none..xl`, Grid `sm..xl` as-is; npm-схемы не трогаем). W1-снапшот **подтверждает** таблицу shadcn по фактическим Tailwind-классам, а не определяет её.
- **Резолвер чистый**: `resolveSpacingScale(systemId, themeTokens): Record<SpaceToken, string>` — merged-токены темы, недостающие/отсутствующие ключи — из canonical fallback; загрузка pinned-темы по версии — отдельные server/browser-адаптеры (браузер не знает содержимого темы по номеру версии).
- **Доставка в custom-компоненты — ABI v3 с явным negotiation**: новый module specifier **`easy-ui/runtime/v3`**; его импорт однозначно выставляет `hostAbiVersion=3` в компиляторе (`server/components/compile.ts`, `IMPORT_ABI_V3`); `easy-ui/runtime` навсегда означает v2 — случайный downgrade/upgrade невозможен. Инфраструктура v3: маршрут `/api/shims/v3/*` (`server/routes/shims.ts`, `server/main.ts`), собственный `.d.ts`, extraction-адаптер per-specifier (`server/components/pipeline.ts`), share/capture-ресурсы (`server/share/repo.ts`), smoke-тест смешанного документа ABI2+ABI3.
- **API v3**: `token()` остаётся value-returning (семантика v2 — фактическое значение темы); CSS-ссылку возвращает только новый typed-хелпер **`space("md")` → `var(--eui-space-md, 12px)`** (canonical fallback конкретного токена запечён в ссылку — fail-soft для порталов и незасетапленных поверхностей). Девять переменных `--eui-space-*` ставятся на stage root каждой render surface компонентом `SurfaceSpacingScope` (вводится в W1 с подключением к capture root; остальные поверхности — W4b/W4c) из resolved-шкалы — решает первый рендер после async-темы и параллельные превью с разными темами. **`space.*` исключается из `serializeThemeCss`/`:root`** — `SurfaceSpacingScope` единственный CSS-владелец namespace `--eui-space-*` (безопасно: таких токенов ещё не существует; W0-аудит подтверждает отсутствие legacy `var(--eui-space-*)`). **Внешние порталы (custom `createPortal` в body) — нормативно вне v1**: переменная в body-scope отсутствует, значение = запечённый canonical fallback. Conformance-тесты: ABI3-ребёнок внутри Drawer/Dialog и две одновременные поверхности — с **двумя разными неканоническими** шкалами и явными ожидаемыми значениями. **Смешанные value-imports** `easy-ui/runtime` + `easy-ui/runtime/v3` в одном исходнике — 422 на compile (type-only v2 + value v3 разрешён; compiler-тесты mixed/type-only/capabilities+v3). **ABI v2 не меняется** (включая `""` за отсутствующий токен). Обновлённые YpBox/YpBlock публикуются на ABI v3.
- **Формат токенов темы**: `space.*` — неотрицательные абсолютные px-строки (`"12px"`); все 9 ключей при объявлении хотя бы одного; `none="0px"`; монотонность; валидация на merged-теме; **только новые версии тем**. Legacy/grandfathering: PATCH **без** `tokens` переносит malformed-группу как есть (резолвер продолжает игнорировать её целиком, canonical fallback); PATCH **с** `tokens`, содержащий любой ключ `space.*`, требует полной валидной группы. Тесты: fonts-only, icons-only, unrelated-token, partial-space, full-repair PATCH.
- Каталог/манифест/capabilities отдают resolved scale per DS. Тесты: первый рендер после async-темы, две одновременные темы, capture, SSR-extraction, cleanup/unmount.

### D3. Спецификация метаданных и семантика v1

```ts
// ComponentDefinition
layout?: {
  version: 1;                          // обязателен
  spacing?: ("gap" | "padding" | "paddingX" | "paddingY")[];
  spacer?: true;                       // несовместим с непустыми slots и spacing
  flow?: {                             // применимость gap; нормативно = flex-flow
    kind: "flex";
    direction:
      | "vertical" | "horizontal"
      | { prop: string; vertical: JsonScalar[]; horizontal: JsonScalar[]; none?: JsonScalar[] };
    wrap?: { prop: string; enabled: JsonScalar[] };
    slot?: string;                     // default: "default"
  };
}
```

- Инварианты (shape-валидация): `layout` без `spacing` и `spacer` — 422; дубликаты в `spacing` — 422; `flow` только вместе с `spacing ⊇ ["gap"]`; `direction.prop`/`wrap.prop` существуют в схеме и `direction.prop !== wrap.prop`; массивы `vertical`/`horizontal`/`none` непусты, JSON-safe scalars, **попарно не пересекаются между собой** (домен `direction.prop`), каждое значение принимается схемой своего пропа; `enabled` проверяется отдельно в домене `wrap.prop` (непустота, уникальность, принятие схемой); полное покрытие enum не требуется (unmapped → `n/a`); `flow.slot` — `"default"` или объявлен в `slots`.
- Семантика чтения: отсутствующий проп без Zod-default, directive-значение или unmapped-значение ⇒ направление **неизвестно** (`n/a` для линтов/geometry), не угадывается.
- Валидация — общим Zod-introspection модулем (D8a; один модуль: import в subprocess или corpus-тест): пропы из `spacing` существуют и являются enum-подмножеством канонического scale (обёртки разворачиваются).
- **Нормативная семантика v1** (prototype-format.md + conformance-фикстуры): `padding` — четыре стороны; `paddingX`=inline, `paddingY`=block, перекрывают `padding` по своей оси; `none`=0; отсутствие пропа = дефолт компонента; `gap` — промежутки между детьми `flow.slot` в направлении `flow.direction`; оси logical.
- **Честное ограничение**: применимость gap (линты) и расчёт зазоров (geometry) — только для контейнеров с задекларированным `flow` (builtin-декларации в W1: shadcn Stack — `direction:{prop:"direction", vertical:["vertical"], horizontal:["horizontal"]}`; Grid — без flow; wireframe Stack — `direction:"vertical"`). Остальным — только rect'ы.
- Capabilities: `layoutContractVersion: 1`, `features.layoutContract`.

### D4. layoutNeutral для custom-компонентов

Схемы `server/components/extract-subprocess.ts` + passthrough `definitionMeta` → manifest → `src/customComponents/loader.ts`. **Eligibility — ошибки**:
- save (shape): требуются объявленный default slot, непустой `layout.spacing`, отсутствие declared events/eventPayloads, `interactive !== true`, atomic level ∈ {atom, molecule} либо не задан;
- publish (SSR-conformance): **источник пропсов** — `props.safeParse({})` если проходит; иначе первый валидный `example`; иначе для `layoutNeutral` обязателен `example` или новое поле `conformanceProps` (без них — 422 с объяснением). `conformanceProps` — bounded JSON-safe object, **server-only** (не попадает в manifest/hash); каждый кандидат прогоняется через `safeParse`, в компонент передаётся именно **parsed-результат** (defaults/transforms/stripping применены). Уникальный sentinel передаётся **одновременно** как `slots.default` и `children` (adapter-контракт `easyUiRuntime.tsx:143`); отсутствие sentinel в SSR-выводе — **publish error**. Тест-кейс: required props без example.

### D5. Overlay — host-примитив, StageViewport-модель

```
Overlay { placement: top|bottom|center|top-left|top-right|bottom-left|bottom-right,
          inset: spaceToken = "md", scrim: boolean = false }
slots: [default], atomicLevel: atom, layoutNeutral: true
```

- **Host-примитив**: реестр `hostPrimitives` — отдельная секция catalog summary/discovery (не в bundle-manifest). Общий модуль **`hostPrimitiveDefinitions`/`hostPrimitiveNames`** используется клиентом и сервером: client-merge — в `src/catalog/runtime.ts` (не в provider definitions); **серверный lifecycle** — `server/validation.ts` (`snapshotDefinitions` исключает host-типы из custom lookup/pins, добавляя их definitions для валидации), `server/repos/prototypes.ts` (`publish` считает host-тип известным без component pin), `src/prototype/validate.ts` (host ≠ custom для semantic/atomic/slot-правил). Overlay не попадает в component pins и manifest hash — API-тест полного цикла create/save/publish. Имя `Overlay` резервируется на create/update/publish custom-компонентов (409, включая существующие записи — по W0-аудиту); дескриптор входит в builtin compatibility hash (с W4d).
- **Модель координат**: API различает четыре бокса — `ClipViewport` (внешняя обрезка/скролл превью), **`StageViewport`** (native-координаты, **внутри той же transform chain, что контент** — inset не расходится с масштабом в editor/preview при scale≠1), `ContentScroller` (скроллящийся контент) и portal root. **Overlay — viewport-sticky**: якорится к StageViewport и не двигается при скролле контента (кейсы badge/FAB/sticky-футер). Anchored-to-content — вне v1. **Desktop v1-scope**: Overlay на desktop-экранах **без canvas запрещён** (validate error) — canonical desktop viewport имеет auto-height, нормативного якоря для `bottom` нет; mobile/tablet flow+canvas и desktop canvas покрывают прод-кейсы; format-level desktop viewport height — follow-up. **Runtime-правило против обхода через device-switcher плеера**: desktop preview отключается (disabled с подсказкой) для текущего non-canvas экрана с Overlay; уже выбранный desktop сбрасывается при навигации на такой экран или смене версии (тесты: mobile/tablet→desktop, canvas→non-canvas, смена экранов/версий). Truth table задаёт per-surface конкретный DOM-узел StageViewport, width/height, scroll owner, overflow, capture-поведение и позицию Overlay после scroll — покрывая player (включая preview override), present, capture, editor main/strip, CJM, Gallery, Storybook и tablet flow/canvas; **таблица — обязательный первый деливерабл W4b** (reviewed entry-gate до изменений DOM).
- **Монтирование**: caller (player/present/capture/editor/CJM/gallery/story) предоставляет `stageHostRef` (узел StageViewport в native transform chain); overlay-portal монтируется в него — **никакой обёртки legacy flow** (не меняются margin collapsing и containing block существующих absolute-элементов; проверяется отдельным DOM-тестом, не только пикселями). На canvas-экранах — третий явно упорядоченный слой в существующем `CanvasLayers`. Тесты: editor scale≠1, player zoom, canvas pan/zoom, внешний desktop-скролл.
- **Сплит и runtime**: общий `splitHostPrimitives` (обобщение Hotspot-сплиттера `runtimeSpec.ts:160`, рекурсивный, с сохранением descendant-маркеров); порядок: сначала `splitHostPrimitives`, затем `splitCanvas`. **Action runtime всегда получает полный исходный `tree.spec`** (split-результаты — только presentation trees) — repeat-бюджет и стейт учитывают содержимое Overlay. `repeat` внутри Overlay разрешён и тестируется; Overlay внутри repeat/Hotspot/Overlay запрещён; `Hotspot` внутри Overlay запрещён; Overlay — только прямой ребёнок root экрана.
- **Placement-семантика ширины**: `top`/`bottom` — stretch на ширину StageViewport минус горизонтальные insets; углы и `center` — shrink-to-fit. `inset` — из resolved scale DS.
- Stacking: content < Overlay-layer < Drawer/Dialog порталы; несколько Overlay — в порядке документа; `scrim:true` — подложка на весь StageViewport, клики сквозь неё отключены, `aria-hidden`; обычный Overlay — pointer-events только на контенте; hit-testing Hotspot не пересекается с Overlay.
- Кейсы: badge, FAB, sticky-футер, scrim; модалки — Drawer/Dialog.

### D6. className: advisory-политика

Не убираем. Документируем как best-effort escape hatch без гарантий (Tailwind-классы не гарантированно в скомпилированном CSS): не для позиционирования/спейсинга между сиблингами. Warning-линт `layout/classname-positioning` — токенизированный парсер (позиционные утилиты, `relative`, `inset-*`, variant-префиксы, arbitrary `z-[999]`, margin-утилиты), только статические строки (директивы → not-applicable), тесты вариантов.

### D7. Geometry probe (v1)

- Worker (`scripts/screenshot-worker.mjs`): после `__EUI_CAPTURE_READY__` — `page.evaluate`: обход `[data-eui-key]` (включая Overlay-layer), union-rect поддерева маркера (порталы вне поддерева не входят; fixed вне surface отфильтровываются), CSS-px относительно border box capture-surface, округление 0.01.
- **Layout owner** (маркеры — `display:contents`): нормативный алгоритм — ближайший non-`contents` DOM-предок/LCA, содержащий все непосредственные маркеры детей слота; при неоднозначности (fragment, несколько roots, wrapper-цепочки) — `layoutContext: null` и `gaps: n/a`. Из owner'а снимаются computed `display`, `flex-direction`, `flex-wrap`, **`row-gap`, `column-gap`** (наблюдаемая дистанция между rect'ами может включать margins — driver печатает и CSS-gap, и observed clearance). Тесты: wrapper/fragment/margins/transforms/несколько roots.
- **Контракт результата — discriminated union** `kind: "image" | "geometry"`. Geometry: `{kind:"geometry", resolvedRev, prototypeInstanceId, componentPins, designSystemMetaVersion, resolvedSpaceScale, viewport, dpr, rects: [{key, instance, parentKey?, parentInstance?, domIndex, x, y, width, height, hidden?, layoutContext?}], truncated, total}`. Различаются: отсутствующий маркер / `hidden` / zero-size. Лимит учитывает repeat-бюджет; `truncated`+`total`.
- **Probe-режим**: `probe: "geometry"` в POST `.../screenshot` → PNG не создаётся, asset ingest не выполняется.
- Driver `geometry <protoId> <screenId>`: rect'ы + зазоры **только** при известном flow (D3) И подтверждающем layoutContext (non-wrapped flex нужного направления, без repeat/named slots в группе); иначе `gaps: n/a (<причина>)`.
- SKILL.md-рецепт: «собрал экран → geometry → зазоры равны resolved-токенам DS».

### D8. Линты (non-blocking warnings, `src/prototype/layoutLints.ts`)

#### D8a. Инфраструктура
- Zod-introspection: один shared-модуль `src/catalog/zodIntrospect.ts` (вынос из `src/editor/propsForm/introspect.ts`), импорт в normalize/validate/lints/propsForm и extraction-subprocess (или corpus-тест). Покрытие: Optional/Nullable/Default/Prefault/Readonly/Catch/Pipe, не-object root.
- `ValidationIssue` + optional `code`; прокидка: contracts, client DTO, `server/validationRecords.ts` (если версионируется), editor `docDiff`, driver; `VALIDATOR_VERSION` bump. Issue включает component key и JSON path.
- Спейсер: `layout.spacer === true`; fallback — legacy-allowlist `["YpSpacer"]` (TODO-дата удаления).
- Дефолты per-field; дети группируются по slot.

#### D8b. Правила

| Код | Эвристика | Порог |
|---|---|---|
| `layout/spacer-chain` | ≥2 спейсеров подряд в одной slot-группе | 2 |
| `layout/spacer-heavy` | доля спейсеров среди элементов экрана | >25% и ≥8 |
| `layout/spacer-vs-gap` | родитель декларирует gap **и flow**, статическое направление — flex, gap отсутствует/`"none"`, ось спейсера совместима, в детях спейсер | 1 |
| `layout/default-props-noise` | ≥N статических пропов равны per-field default'ам | N=5 |
| `layout/legacy-numeric-spacing` | повтор одного числового значения в **явно перечисленных** legacy numeric-spacing пропах (`(YpSpacer, size)`; список расширяем) — generic-вывод из layout-метаданных невозможен: контрактные пропы уже token-enum | ≥5, ∉{0,1} |
| `layout/classname-positioning` | парсер из D6, статические строки | — |

Рекомендация замены — только при точном px-эквиваленте в resolved scale DS; иначе общая подсказка. Negative-тесты; counts на прод-снапшоте cpqr; shipped-фикстуры warning-free.

### D9. Фикс YpBox/YpBlock/YpSpacer

- **D9a (сервер)**: manifest/version — input-схема `z.toJSONSchema(props, {io:"input"})` в `pipeline.ts`. Регресс-тесты: `{}`-input валиден; пиксельная эквивалентность `{}` vs явных дефолтов на фикстуре с видимым child; propsForm и screenshot-валидация не регрессируют.
- **YpBox** (ABI v3): + `gap?/padding?/paddingX?/paddingY?: spaceToken`; CSS через `space("md")` → `var(--eui-space-md, 12px)`; `layout={version:1, spacing:[...], flow:{kind:"flex", direction:{prop:"mode", vertical:["col"], horizontal:["row"], none:["box"]}, wrap:{prop:"wrap", enabled:[true]}}}`; `layoutNeutral: true`.
- **YpBlock** (ABI v3): + `padding?: spaceToken`; `layout={version:1, spacing:["padding"]}`.
- **YpSpacer**: `layout={version:1, spacer:true}`, описание «prefer gap on the parent».
- Input-example YpBox — минимальный (без сериализации дефолтов). Демонстрация — composed-фикстуры «до/после». Эталоны — `.claude/skills/author/examples/`.

## Waves

Порядок: **W0 → W1 → (W2a ∥ W2b) → W2-gate → W3 → W4a → W4b → W4c → W4d (gate) → W5 → W6 → W7**. W4*/W5 сериализованы. Правила: волна, трогающая `validate.ts`, выносит логику в свой модуль; `server/contracts.ts`, `prototype-format.md`, `server-api.md` — не в параллельных задачах одной волны.

### W0 — Baselines и аудиты (оркестратор)
- Baseline-generations для shadcn/wireframe-фикстур + локальных копий прод-YP (cpqr, ctyp) на dev-сервере с опубликованным YP-каталогом. **Baseline tuple**: instance, rev, generation, pins, theme version, viewport, DPR, browser/build; «до/после» — на одной persistent DB/assets.
- **Аудит имён**: прод/dev-DB на существующие `Overlay` (и другие host-имена).
- **Аудит legacy `space.*`**: все active component sources и все версии тем прод-DB на использование/наличие `space.*` (вход fail-soft политики D2).
**Done**: baseline-sets + tuple-манифест; `driver check` зелёный на нетронутом коде; аудиты зафиксированы. **Fail-closed**: найденный legacy `var(--eui-space-*)` или существующий компонент `Overlay` останавливает W1/W4a до отдельного решения.

### W1 — Ядро контракта + ABI v3 + шкала
**Файлы**: `src/designSystems/types.ts`, `src/catalog/normalize.ts`, новый `src/catalog/zodIntrospect.ts` (+переключение `src/editor/propsForm/introspect.ts`), новый `src/designSystems/spacingScale.ts` (`resolveSpacingScale` — чистый; таблицы D2), новый компонент `SurfaceSpacingScope` (установка `--eui-space-*`; в W1 подключается к **capture root `#eui-capture-surface`** (там уже есть ThemeStyle), остальные поверхности — W4b/W4c), `src/designSystems/theme.tsx` (исключение `space.*` из `serializeThemeCss`), `server/shims/abi-v2.ts` (не меняется) + новый `server/shims/abi-v3.ts` (`token()` value-returning, `space()`→`var(...)` c fallback), **ABI v3 транспорт**: `server/components/compile.ts` (`IMPORT_ABI_V3`, specifier `easy-ui/runtime/v3`), `server/routes/shims.ts` + `server/main.ts` (`/api/shims/v3/*`), `.d.ts` для v3, `server/components/pipeline.ts` (extraction-адаптер per-specifier), `server/share/repo.ts` (share/capture-ресурсы), `server/designSystemsMeta.ts` (валидация `space.*` + grandfathering D2), `src/designSystems/shadcn/index.ts` (+`layout.ts`: spacing+flow; снапшот-подтверждение таблицы px), `src/designSystems/wireframe/definitions.ts` + `components.tsx` (расширение enum по таблице D2, существующие px неизменны), `src/designSystems/fixtures.ts`, `src/catalog/definitions.test.ts`, `docs/prototype-format.md` («Spacing & layout contract v1»).
**Done**: тесты декларации (все инварианты D3, включая flow-домены); «старые wireframe px неизменны»; `resolveSpacingScale` (тема/синтез/fail-soft/grandfathering-PATCH-матрица); ABI v3 negotiation (импорт `easy-ui/runtime/v3` → `hostAbiVersion=3`; `easy-ui/runtime` → 2; смешанный документ ABI2+ABI3); `space()` в CSS-контексте + fallback вне scope; ABI v2 без изменений (регресс-тест `""`, `token()`-как-текст фикстура); test+typecheck; `validate:prototypes`; `driver check` против W0 — zero drift.

### W2a — Custom-компоненты plumbing
**Файлы**: `server/components/extract-subprocess.ts`, `server/components/pipeline.ts`, `server/components/types.ts`, `server/routes/components.ts` (передача DS/темы в checkSource/extraction для resolved-контекста), `src/customComponents/loader.ts`, `server/components.test.ts`.
**Работа**: metadata/result-схемы + `layoutNeutral` + `layout`+`flow` (shape на save); eligibility D4 + sentinel-conformance (источник пропсов, `conformanceProps`, error); **D9a `{io:"input"}`** + регресс-тесты.
**Done**: publish фикстуры с полной декларацией проходит; 422 по каждому правилу D3/D4 (включая required-props-без-example); `layoutNeutral` гасит atomic-nesting warning; sentinel-негативы; input-схема без ложных required.

### W2b — Contracts/сериализация/каталог
**Файлы**: `server/contracts.ts`, `server/routes/designSystems.ts`, `server/routes/meta.ts` (capabilities + `/api/schemas/component-definition.json`), `server/builtinHash.ts` + `server/builtinHash.test.ts`, `server/repos/prototypes.ts` (`builtinCatalogHashFor` со scale pinned `design_system_meta_version`; restore — скопированная версия темы; тесты: hash двух версий темы, restore старой ревизии), `src/api/client.ts`, `scripts/generate-builtin-catalog.ts`, `.claude/skills/author/driver.mjs` (`compactCatalog`), `reference/builtin-catalog.json` (regen), `server/openapi.json` (regen), `docs/server-api.md`.
**Работа**: `layoutContractVersion:1` + `features.layoutContract` + resolved scale per DS; `layout`/`layoutNeutral`/input `propsJsonSchema` во всех DTO; **hostPrimitives — только generic-схема секции с пустым реестром** (дескриптор Overlay — в W4); builtin hash: props-схемы + layout-метаданные + resolved scale + обязательный `renderContractVersion` (хэш — детектор несовместимости, не pin); `code` в issue-схемах.
**Done**: capabilities/summary/manifest/driver/reference с новыми полями; пустая host-секция валидна; snapshot-тесты; drift OpenAPI; hash-тесты.

### W2-gate (оркестратор, исполняемый)
Скрипт: сквозной publish-цикл фикстурного компонента с полной декларацией против собранного сервера + snapshot-сверка сериализации W2a↔W2b; **плюс ABI v3 end-to-end через capture** (единственная поверхность со scope на этот момент): фикстурный компонент импортирует `space()` из `easy-ui/runtime/v3`, публикуется с `host_abi_version=3`, браузер загружает v3-шим; тема — **неканоническая полная валидная шкала** (`0/4/8/20/24/32/40/56/72px`), проверяется computed spacing = 20px И наличие `--eui-space-md` на stage root (canonical-fallback-зелёный тест невозможен). Артефакт сохраняется рядом с бейзлайнами.

### W3 — Линты
**Файлы**: новый `src/prototype/layoutLints.ts` (+тест), `src/prototype/validate.ts` (одна строка), `src/prototype/types.ts` (+`code`), `server/validationRecords.ts` (при версионировании), `src/editor/docDiff.ts`, фикстуры.
**Done**: тесты каждого линта (позитив/негатив/порог/slot/ось/точный-эквивалент); cpqr-фикстура даёт ожидаемые warnings с кодами; прод-cpqr: errors 0, counts snapshot; shipped-фикстуры warning-free.

### W4a — Overlay core (скрытая возможность)
**Файлы**: новый общий модуль `hostPrimitiveDefinitions`/`hostPrimitiveNames` + `src/catalog/hostPrimitives/` (definition + реализация + `HostStageSurface`), `src/catalog/runtime.ts` (client merge), **серверный lifecycle**: `server/validation.ts` (host-типы вне custom lookup/pins), `server/repos/prototypes.ts` (publish: host-тип известен без pin), `src/prototype/validate.ts` (host ≠ custom), `src/prototype/runtimeSpec.ts` (`splitHostPrimitives`; порядок hostPrimitives→canvas), `src/player/actionRuntime.ts` (полный spec), новый `src/prototype/overlayRules.ts` (+строка в validate.ts — включая запрет desktop-без-canvas), `server/routes/components.ts` + publish-path (резервация имени, 409 включая существующие записи), unit- и API-тесты.
**Done**: **API-тест полного цикла create/save/publish документа с Overlay** (Overlay отсутствует в pins и manifest hash); split/registry/validate-тесты (root/repeat/вложенность/Hotspot/desktop-без-canvas); repeat внутри Overlay в бюджете; 409-тесты; **Overlay ещё не рекламируется и не рендерится в поверхностях**.

### W4b — Primary stages
**Entry-gate**: заполненная truth table (per-surface DOM-узел StageViewport, width/height, scroll owner, overflow, capture-поведение, позиция после scroll; player включая preview override, present, capture, editor main/strip, CJM, Gallery, Storybook, tablet flow/canvas) — ревьюится оркестратором **до** изменений DOM.
**Файлы**: `src/player/ScreenSurface.tsx`, `src/player/CanvasLayers.tsx` (третий слой), `src/player/DeviceFrame.tsx` + `src/player/ScreenView.tsx` и caller-файлы player/present (StageViewport/stageHostRef + **runtime-правило device-switcher**: disable/сброс desktop preview для non-canvas экрана с Overlay), `src/capture/CapturePrototype.tsx`, подключение `SurfaceSpacingScope`, DOM/scroll-тесты.
**Done**: player/present/capture рендерят Overlay (mobile/tablet flow+canvas, desktop canvas); viewport-sticky при скролле; device-switcher тесты (mobile/tablet→desktop, canvas→non-canvas, смена экранов/версий); DOM-тест containing block legacy absolute; `driver check` против W0 — zero drift без Overlay.

### W4c — Preview adapters
**Файлы**: `src/editor/EditorView.tsx` + `src/editor/EditorCanvas.tsx` + `src/editor/EditorScreenStrip.tsx`, `src/cjm/CjmShell.tsx`/`CjmView.tsx` + `src/cjm/CjmScreenTile.tsx`, `src/gallery/GalleryPreview.tsx`, `src/player/PrototypeLoader.tsx` (при необходимости), `src/catalog/stories/story-utils.tsx` — **загрузка exact pinned theme version на уровне prototype-surface** и передача `ThemeContent`/resolved scale вниз (Gallery — `draft.designSystemMetaVersion`, не latest), подключение `SurfaceSpacingScope`, тесты scale≠1 / zoom / pan.
**Done**: превью-поверхности рендерят Overlay в native transform chain (inset масштабируется с контентом) с **pinned** темой; тест старой опубликованной ревизии после выхода новой версии темы; Gallery-приёмка — Overlay с host/builtin-детьми.

### W4d — Exposure + gate
**Файлы**: `server/designSystems.ts` + `server/routes/designSystems.ts` (host-дескриптор в discovery/summary), `server/builtinHash.ts` + тест (hash bump, `renderContractVersion`), `reference/builtin-catalog.json` (regen), `/api/schemas/*` при затрагивании, stories, `docs/prototype-format.md` (Overlay + финальная truth table из W4b entry-gate).
**Done + gate (оркестратор, исполняемый)**: discovery → валидация → runtime registry → рендер Overlay-фикстуры на dev-сервере (Playwright); до W4d Overlay отсутствует в каталоге для агента; артефакт сохраняется.

### W5 — Geometry probe
**Файлы**: `scripts/screenshot-worker.mjs`, `server/screenshot/worker-mjs.d.ts`, `server/screenshot/service.ts` (+sessions), `server/routes/screenshots.ts`, `server/routes/meta.ts` (лимит в capabilities), `server/contracts.ts` (union; regen openapi), `src/visual/api.ts`, новый shared-модуль layout-owner-алгоритма (D7; используется worker'ом и тестами), `.claude/skills/author/driver.mjs` (`geometry`), `docs/server-api.md`, contract-тесты worker/service.
**Done**: `driver geometry` — rect'ы, layoutContext (включая rowGap/columnGap), зазоры/`n/a` с причинами; перекрёстный union-rect тест; e2e Stack gap:"md"; матрица: repeat (parentInstance)/slots/Grid/wrap/hidden/портал/fixed/scroll/clipping/Overlay-layer/wrapper/fragment/margins/transforms/truncated; drift зелёный.

### W6 — Применение: yandex-pay fix (dev), SKILL.md, дока
**Файлы**: `.claude/skills/author/SKILL.md` (Layout guide), `.claude/skills/author/examples/*`, composed «до/после»-фикстуры + custom-aware fixture harness (интеграционный прогон против dev-сервера с опубликованным каталогом), conformance-фикстуры D3, `docs/prototype-format.md` (className advisory).
**Работа**: dev-publish YpBox/YpBlock/YpSpacer (ABI v3) + тема со `space.*`; демо cpqr «до/после»; Playwright-прогон editor/CJM/gallery.
**Done**: SKILL.md с гайдом/рецептом/шкалами; dev-publish проходит; «до» — ожидаемые warnings, «после» — без layout-warnings; пиксельная эквивалентность дефолтов (видимый child); `npm run verify` + `npm run e2e` зелёные.

### W7 — Прод-миграция yandex-pay (оркестратор, после приёмки)
Бэкап → CAS PATCH темы (`space.*`, новая meta-версия) → publish новых версий YpBox/YpBlock/YpSpacer (ABI v3) → пересохранение выбранных прототипов (новые pins) → проверка старых immutable-ревизий и новых → **rollback**: тема — новая версия с прежним контентом (latest = max-версия); компоненты — deprecated/superseded (не rejected при живых pins); ревизии — CAS-restore (`server/repos/prototypes.ts:142`); отдельно published и draft. Чек-лист версий — до выполнения.

## Риски

1. **Порталы/fixed/неоднозначный layout owner в geometry** — нормативный алгоритм + `layoutContext:null` fail-soft; матрица W5.
2. **Subset-scale** — дока: «доступные значения — в propsJsonSchema», resolved scale в каталоге.
3. **Введение ABI v3** — новый контракт шимов и negotiation по specifier; v2 заморожен (регресс-тесты `""` и `token()`-как-текст), v3 покрыт W2-gate end-to-end и тестами порталов/параллельных тем.
4. **StageViewport/stageHostRef** — портальная модель без обёртки flow; desktop-без-canvas исключён из v1; DOM-тест containing block + W0-бейзлайны как ворота W4b.
5. **Рассинхрон rect-логики** — общий тестовый вектор.
6. **`{io:"input"}`** — регресс-тесты propsForm/screenshot-валидации.
7. **W7** — пины + бэкап + rollback новой версией.
8. **9 токенов** — SKILL.md: рекомендуемые «обычные» (sm/md/lg/xl) и когда крупные.
9. **Fail-soft legacy-тем** — аудит W0 определяет фактический масштаб; политика зафиксирована до W1.

## Верификация (сводная матрица)

- **Сериализация**: snapshots manifest/version/summary/driver/reference + host-секция; drift OpenAPI; `/api/schemas/*`.
- **Совместимость**: старые ревизии без drift (W0-tuple, одна DB); wireframe px; ABI v2 поведение; `{}`-input; `validate:prototypes`.
- **Overlay**: все поверхности (render-тест + Playwright editor/CJM/gallery), custom-only DS (host/builtin-children), canvas, violations, несколько Overlay, scrim/pointer-events, stacking, ширина placement'ов, containing block DOM-тест, 409.
- **Geometry**: discriminated contract, layout-owner алгоритм, rowGap/columnGap, полная матрица кейсов, Stack gap:"md" численно, truncated/total.
- **Линты**: precision/negative, коды, counts на прод-снапшоте, точный-эквивалент.
- **Сквозное**: `npm run verify`, `npm run e2e`, W2-gate (включая ABI v3 end-to-end) и W4d-gate (исполняемые, с артефактами), dev-прогон D9, `driver geometry`.

## Процесс

План прошёл 6 раундов адверсариального Codex-ревью (раунд 6 — без blocking-возражений, готовность к исполнению подтверждена). Исполнение волнами (`--fresh --write --effort medium`) с независимой верификацией done-критериев. W0, W2-gate, W4d-gate, W7 — оркестратор. Прод (W7) — после приёмки W1–W6.
