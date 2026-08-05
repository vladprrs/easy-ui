# Приёмка и сверка: preview, probe-доки, expect, compare

Справка к §4.6–4.7 SKILL.md — полная механика драфт-съёмки, probe-lifecycle, формат expected.json и отчёт compare.mjs.

## Preview и драфт-цикл (§4.6)

Одиночный атом принимается **без probe-дока** — verb `preview` снимает компонент напрямую, в двух режимах: сохранённая head-ревизия без публикации (`--rev head-draft`, W2) и опубликованная head-версия (по умолчанию):

```bash
node driver.mjs preview pay-button --rev head-draft --example primary --dsf 2 --out shots/pay-button.png
# preview pay-button draft rev 4 bundleHash=… designSystemMetaVersion=3 viewport=1280x800 dsf=2 theme=light
node driver.mjs preview pay-button --example primary --dsf 2 --out shots/pay-button.png
# preview pay-button v1 bundleHash=… designSystemMetaVersion=3 viewport=1280x800 dsf=2 theme=light
```

PNG — content-hug (воркер снимает сам элемент, не вьюпорт): размеры эталона и снапа сравниваются напрямую, без canvas-арифметики. `--probe geometry` вместо PNG отдаёт замер той же поверхности (вход для `expect`, §4.7). **Итоговый цикл атома: правка → save ревизии без публикации → `preview --rev head-draft` → `expect` (+`compare` с эталоном Figma) → validate-префлайт → `accept` по семье вариантов (§4.8, если вариантов больше одного) → `promote` ровно один раз (приёмка головы: validate+publish+auto-supersede одной командой, `features.acceptancePromote`; флаги `--candidate cand_… --acceptance-run acc_…` кладут ран приёмки в provenance версии, а без флагов единственный `promotionEligible`-ран кандидата головы выбирается автоматически). Ран под `pixel-strict-v1` публикуется **напрямую**: оба встроенных профиля допущены к promote, и «второй формальный ран под `default-v1` ради публикации» — устаревший обходной путь, делать его не нужно.** Промежуточных публикаций быть не должно: всё, что раньше требовало версии, делается на сохранённой голове. Verb `component` делает save+publish за вызов — он остаётся входом создания (reuse-гейт/discovery) и финальным publish'ем, а промежуточные сохранения идут через `api.mjs` (PUT гейт создания не проходит):

```bash
# промежуточная итерация (без публикации):
node api.mjs get /components/pay-button                     # headRev → baseRev для CAS
jq -n --arg src "$(cat pay-button.tsx)" --argjson figma "$(cat pay-button.figma.json)" \
  '{source:$src, figma:$figma, baseRev:<headRev>, message:"iterate"}' > save.json
node api.mjs send PUT /components/pay-button save.json      # → {"rev": N+1}
node driver.mjs preview pay-button --rev head-draft --example primary --dsf 2 --out shots/pay-button.png
node driver.mjs preview pay-button --rev head-draft --example primary --probe geometry --out actual.json
node driver.mjs expect expected/pay-button.json actual.json          # числовой вердикт (§4.7)
node compare.mjs figma-refs/pay-button@2x.png shots/pay-button.png diff/pay-button.png
# приёмка сошлась → префлайт → единственная публикация:
node api.mjs send POST /components/pay-button/validate
# финал: PUT отвечает no-op unchanged (source+figma без изменений), драйвер публикует голову:
node driver.mjs component pay-button PayButton pay-button.tsx \
  --design-system yandex-pay-v2 --intent "Primary action button for payment flows" --figma pay-button.figma.json
```

Драфт-съёмка идёт через candidate-bundle префлайта validate: провал (тип-ошибки tsc, битые asset-refs) приезжает тем же 422, что отдаёт publish, — итерация ловит те же дефекты, не плодя версий; при холодном кэше постановка собирает кандидата (заметное время) под троттлингом префлайта (429 `validate_in_flight` — повтор после завершения чужого прогона; `queue_full` драйвер ретраит сам). Asset-refs драфта обязаны существовать в реестре (422 `asset_not_found` до сборки), kill-switch `EASYUI_VALIDATE_DISABLED=1` гасит драфт-превью (published-режим работает). Пересохранений ради пинов нет: ревизия драфта — head, тема — всегда последняя (фактическая — в `designSystemMetaVersion` вывода, фиксируй её в REPORT). Честные ограничения: `--theme` — только light/dark, версия темы **не пинуется**; viewport 64..2000 × 64..4000 и `width × height × dsf² ≤ 20 000 000` — при `--dsf 3` потолок вьюпорта ~2,2 Mpx, для @2x-сверки бери `--dsf 2`; очередь скриншотов сервера — concurrency 1, cap 5 → возможен `429 queue_full`, драйвер ретраит сам (счётчик `queueRetries` в `--json`).

Probe-прототип остаётся **со стадии молекул** и для контекстных экранов (`ypv2-probe-molecules`, `ypv2-probe-organisms`, `ypv2-ref-*`), **по экрану на компонент**. Экран — стикершит вариантов, повторяющий раскладку Figma-эталона: `canvas` = размер экспортированного фрейма (допустимый диапазон 64–2000 × 64–4000), фон = фон фрейма, варианты разложены `pay-box`-ами с теми же координатами/gap. Шаблон — `templates/probe.json` (props в нём иллюстративные — сверяй со своей фактической схемой, незнакомый ключ = 422). Контракты host-типов (`Image`/`Hotspot`/`Overlay`/`@eui/FlowRoot`) — `reference/host-catalog.json`.

```bash
node driver.mjs prototype ypv2-probe-molecules.json
node driver.mjs status ypv2-probe-molecules --all-screens
node driver.mjs geometry ypv2-probe-molecules pay-payment-method-card
node driver.mjs snap ypv2-probe-molecules ./shots --all-screens
```

**Probe-док объявляй служебным и трекающим головы — тогда пересохранения после каждой публикации компонента не нужны** (W3). `kind` и `track` — lifecycle-атрибуты прототипа (колонки, не поля документа), ставятся одним роутом сразу после создания дока:

```bash
echo '{"kind":"component-gallery","track":"head"}' > lifecycle.json
node api.mjs send POST /prototypes/ypv2-probe-molecules/lifecycle lifecycle.json
```

- `track: "head"` разрешён только для служебных `kind` (`component-gallery`, `evidence`, `visual-reference`, `composition-fixture`) и только пока прототип не опубликован: иначе `422 track_requires_service_kind` / `track_requires_unpublished`. Для трекающего дока запрещены publish, share-грант, visual-baseline и bundle-export (`422 prototype_head_tracking`) — это цена за подвижные пины; probe-доки всё равно живут драфтами.
- Скоуп резолва — **только компонентные пины**: DTO ревизии отдаёт последние active-публикации и `resolvedAt`, постановка снапа возвращает разрешённые пины в `components[]` (сверяй их с ожидаемыми версиями). **Версия темы остаётся пином ревизии** — после PATCH темы probe пересохранять всё равно нужно (§3.2, `stalePins`).
- Галерея — это `kind: "component-gallery"`, выставленный тем же lifecycle-роутом, а не поле документа: формат документа не менялся.
- **Warnings служебной галереи — не блокер.** У служебных `kind` readiness-отчёт идёт с `profile: "service"`: предупреждения (недостижимый экран, интерактивный компонент без handler) не поднимают статус и не блокируют. Не изобретай технические `Hotspot`'ы и `on`-биндинги ради нулевого warning-счётчика.

Без `track: head` (обычный `pinned`-док, любой `kind`) правило прежнее: **ревизия пинует конкретные версии компонентов и версию темы, publish новой версии пины не двигает**, цикл итерации молекулы — publish компонента → `driver.mjs prototype ypv2-probe-<level>.json` (пере-пин) → `status` → `geometry` → `snap`. Пропустишь пересохранение — будешь гоняться за «диффом», которого уже нет в исходнике.

## Сверка: expect и compare (§4.7)

Порядок жёсткий: **числовая приёмка до пиксельной**. Пиксельный дифф говорит «0,4% не совпало», числовая — «gap expected 8, got 6», то есть сразу называет правку.

1. **Численно — `expect`**: замер geometry против выписки §4.1, допуск ±1px.

```bash
# actual: замер компонентной поверхности прямо на draft-ревизии (PNG не создаётся)
node driver.mjs preview pay-button --rev head-draft --example primary --probe geometry --out actual.json
# actual для молекулы/экрана: прототипный geometry-probe
node driver.mjs geometry ypv2-probe-molecules pay-payment-method-card --json > actual.json
node driver.mjs expect expected/pay-button.json actual.json
# expect expected/pay-button.json vs actual.json: 5 checks, 1 mismatch (tolerance ±1px)
# ok   stack#0: width expected 328, got 328
# FAIL stack#0: gap expected 8, got 6
```

`expected.json` пишешь ты из выписки Figma. Формат минимальный:

```json
{
  "tolerance": 1,
  "elements": [
    { "key": "c",     "size": { "width": 328, "height": 56 } },
    { "key": "stack", "instance": 0, "axis": "row", "gap": 8,
      "padding": { "left": 16, "right": 16, "top": 12, "bottom": 12 }, "tolerance": 2 }
  ]
}
```

- `key`/`instance` — ключ маркера в замере (`instance` по умолчанию 0). У компонентной поверхности маркер ровно один — корневой элемент дерева съёмки с ключом `c`, поэтому для атома проверяется `size` (PNG и так content-hug); `gap`/`padding` меряются там, где маркеров несколько, — на probe-экране.
- `size` — `{width?, height?}`, любое из полей опционально.
- `gap` — число (все зазоры между соседними видимыми детьми равны ему) либо массив ожиданий по порядку. Ось берётся из `axis`, иначе из computed `flexDirection` layout owner'а, иначе выводится из самих rect'ов. Меряется **наблюдаемый зазор** между box'ами детей — он может отличаться от CSS gap на величину margin'ов.
- `padding` — число (все четыре стороны) либо объект сторон; это наблюдаемый отступ между box'ом элемента и bounding box'ом его прямых детей.
- `tolerance` — файловый дефолт (1 px), перекрывается per-element; `--tolerance N` перекрывает файловый дефолт, но не per-element.
- Выход: 0 — всё сошлось, 2 — есть расхождения (каждое строкой `FAIL`), 1 — битый файл/формат. Верб оффлайновый, сети не касается.

2. **Пиксельно**: `node compare.mjs figma-refs/pay-button@2x.png shots/pay-button.png diff/pay-button.png` — pixelmatch, порог чувствительности 0.1. Отчёт кроме процента печатает:
   - **кластеры расхождений** — bounding-box'ы связных областей (`cluster 12x3 px @ (208,41) — 36 px differ`): координата и форма кластера говорят, что именно уехало (полоса по краю блока = геометрия, россыпь по буквам = шрифт);
   - **AA-diagnostic** — второй прогон с порогом 0,25 в том же отчёте: сколько расхождения остаётся, если списать антиалиасинг. Если основной процент большой, а AA-диагностический ≈ 0 — это шрифтовой рендер, а не дефект;
   - **отчёт о размерах** при их несовпадении (`size mismatch: candidate 328x56 vs ref 328x58 (dw 0, dh -2)`) — дифф всё равно считается по пересечению (exit 3), а не прерывается без диагностики;
   - `--region x,y,w,h[:maxDiff%]` (повторяемый) — процент по зоне и необязательный бюджет: превышение → exit 1. Так фиксируются локальные исключения (например зона текста) без ослабления общего порога.
   - `--json` отдаёт то же машинно; `--clusters N` меняет число печатаемых кластеров (по умолчанию 10). Raw-эталон никогда не мутируется — записывается только `diff.png`. Снап атома под @2x-эталон — `node driver.mjs preview pay-button --example <вариант> --dsf 2` (content-hug: размер PNG = элемент × dsf); снап probe-экрана — `node driver.mjs snap … --dsf 2` (поверхность = `canvas` экрана). Размеры PNG обязаны совпадать. Для probe-стикершитов бюджет: `surface × dsf² ≤ 16 Mpx` (проверяется до постановки) — очень длинный стикершит при `--dsf 2` дели на несколько экранов. Целевой mismatch ≤ 2% площади, и **весь** остаток объясним антиалиасингом текста (chromium ≠ Figma по субпиксельному рендеру — это единственная легальная разница). Любое расхождение геометрии, цвета заливки, радиуса, тени, межстрочника — дефект: чини компонент/тему и повторяй.
3. **Глазами**: открой diff.png и пару эталон/снап рядом. Кластеры диффа по краям блоков = геометрия, по буквам = шрифт (проверь, что снялся YS Text, а не fallback: ширины строк в geometry совпадают с Figma; если нет — шрифт не доехал, пере-snap или проверь fonts темы).
