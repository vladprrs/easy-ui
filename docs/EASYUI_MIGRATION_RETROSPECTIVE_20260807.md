# easy-ui: итоги миграции Yandex Pay v2 и следующий пакет улучшений

Дата: **2026-08-07**  
Контекст: перенос Yandex Pay в `yandex-pay-v2`, с приоритетом актуального Pay App и CPQR.

## Executive summary

easy-ui уже стал полноценным серверным верстаком, а не только каталогом публикаций. Unpublished drafts, candidate-linked acceptance, strict case sets, comparison matte, geometry v2, named/nested slots, Composition v3, viewport capture, head-tracking galleries и renderer receipts позволили довести систему до **55 активных компонентов** и чистого системного аудита.

Следующий прирост скорости даст не расширение общего DSL, а устранение четырёх повторяющихся классов потерь:

1. geometry contract не различает fixed root, layout union, paint bounds и raw export surface;
2. readiness не всегда гарантирует, что registry image/font/live text реально попали в первый детерминированный кадр;
3. unpublished dependency tree нельзя полноценно собирать и проверять в prototype/composition до первой публикации каждого узла;
4. promote → gallery → regression → audit → receipts остаётся длинной ручной транзакцией.

Рекомендуемый пакет: **Geometry Contract v3**, **deterministic resource barrier**, **candidate dependency overlay**, **migration commit transaction**, затем agent-oriented receipts и impact-driven gallery regression.

## 1. Текущий измеренный baseline

Это snapshot, а не вручную поддерживаемая оценка:

- active catalog: **55 компонентов**;
- последний design-system audit: exit `0`, `deprecatedInUse=[]`, `unused=[]`;
- galleries: atoms `rev78 / 33 screens`, molecules `rev105 / 43 screens`, organisms `rev17 / 7 screens`;
- последний полный molecules regression: **43/43 capture-clean и readiness-met**;
- implementation packages: **103 проверяемых пакета**, из них 98 sealed и 5 ожидаемо incomplete/unsealed; `sealBroken=0`;
- полный исторический `BUILD_ORDER`: **111 строк**, из них 77 terminal и 34 незавершённых (`12 partial`, `22 blocked`);
- в активном workflow записано 72 уникальных blocker token: 36 source-missing, 13 acceptance, 12 product-decision, 5 platform, 4 dependency, 1 server-state и 1 source-access.

Последнее распределение blockers не означает 72 независимых компонента: один lane часто имеет несколько точных причин. Оно показывает, где теряется время.

Evidence:

- `artifacts/easy-ui/audits/post-cpqr-connect-card-v1-design-system-audit.json`;
- `artifacts/workflows/wf-20260804-01/orchestrator-checkpoint.json`;
- `artifacts/easy-ui/prototypes/ypv2-probe-molecules/rev-105/snap-receipt.json`;
- `WORKFLOW_STATE.md` и `BUILD_ORDER.md`.

## 2. Что уже хорошо работает и не требует повторного RFC

Capability wave 2026-08-06 закрыл значительную часть прежнего feedback:

- multi-source Figma provenance;
- geometry v2 и per-case geometry tolerances;
- comparison matte;
- именованный `live-text-v1` AA preset;
- viewport capture;
- nested slot bindings;
- overlay scroll ownership;
- candidate-linked strict acceptance и multi-run promote;
- compact acceptance summary и reuse receipts;
- Composition v3 analyzer/preview-tree;
- service galleries с `track:head`.

Эти возможности реально использованы в опубликованных компонентах. Их не следует заново описывать как отсутствующие. Ниже — только оставшиеся gaps, доказанные после их внедрения.

## 3. P0 — Geometry Contract v3: четыре независимые поверхности

### Проблема

Figma и браузер дают минимум четыре разные геометрии:

1. `rootBounds` — declared fixed/hug root;
2. `layoutUnion` — union in-flow descendants;
3. `paintBounds` — фактически окрашенные пиксели/effects;
4. `referenceExportBounds` — raw Figma export surface.

Сейчас `expectedGeometry`, `sizeDeltaPx` и overflow budget не могут честно описать случай, где root `343×88`, raw export `367×88`, а layout unions равны `480×88` и `558×88`. Поэтому `pay-payment-schedule` проходит visual 6/6, но geometry только 4/6, хотя источник воспроизведён корректно.

### Предложение

Добавить case contract:

```json
{
  "expectedSurfaces": {
    "root": {"width": 343, "height": 88},
    "layoutUnion": {"width": 480, "height": 88},
    "paint": {"width": 367, "height": 88},
    "referenceExport": {"width": 367, "height": 88}
  },
  "comparisonSurface": "referenceExport",
  "clipExpectation": "root-does-not-clip-layout"
}
```

Каждая поверхность должна иметь собственный verdict и observed bounds. Visual canvas не должен неявно определяться через layout union.

### Acceptance criteria

- два overflow-кейса Payment Schedule проходят geometry без изменения source и без waiver;
- verdict называет расхождение конкретной поверхности;
- legacy case sets продолжают работать через однозначную нормализацию;
- изменение только expected surface приводит к geometry recompute/rediff, но не к recapture.

## 4. P0 — Deterministic resource barrier перед capture

### Проблема

Readiness иногда зелёный на уровне запросов, но первый capture теряет direct registry image или получает поздний ресурс. Это воспроизводилось на Card Input после forced recapture. В других lanes residual смешивает live text, vector raster и late assets, заставляя делать несколько source-итераций, которые не меняют причину.

### Предложение

Перед кадром ввести renderer-owned barrier:

1. собрать все font/image/icon dependencies из expanded tree и computed styles;
2. preload registry assets;
3. дождаться `document.fonts.ready`, decode всех images и двух стабильных layout frames;
4. сравнить resource manifest до/после barrier;
5. только затем открыть capture window.

Receipt должен содержать:

```json
{
  "resourceBarrier": {
    "expected": 12,
    "decoded": 12,
    "fontsReady": true,
    "stableFrames": 2,
    "lateAfterBarrier": [],
    "durationMs": 84
  }
}
```

### Acceptance criteria

- forced recapture Card Input не теряет registry leaves;
- `readinessMet=true` гарантирует отсутствие `missing-late-asset` в том же кадре;
- timeout сообщает точный resource id и phase;
- identical resource fingerprint переиспользует barrier result.

## 5. P0 — Candidate dependency overlay для первого publish

### Проблема

Составной target часто имеет unpublished shell и public Composition/Prototype поверх него. До первой публикации shell нельзя полноценно проверить реальное expanded dependency tree в prototype. Это создаёт искусственную последовательность: сначала принять leaf отдельно, затем publish, затем впервые увидеть интеграционный кадр.

Lead Block и Product Widget Copy/Savers показывают две стороны проблемы: unpublished nested content нельзя использовать как честную pre-publication acceptance surface.

### Предложение

Поддержать overlay manifest на preview, composition preview-tree, prototype status/snap и case set:

```json
{
  "candidateOverlay": {
    "pay-example-shell": "cand_...",
    "pay-example-copy": "cand_..."
  }
}
```

Overlay должен быть immutable, входить в frame fingerprint и запрещаться в опубликованной prototype revision.

### Acceptance criteria

- unpublished parent и unpublished dependencies снимаются одним acceptance run;
- receipt перечисляет точные candidate/source/bundle hashes каждого узла;
- active catalog остаётся неизменным;
- promote проверяет, что принят именно тот dependency graph, который публикуется.

## 6. P0 — Migration commit transaction

### Проблема

После terminal acceptance агент вручную выполняет fresh CAS, promote, save gallery, status/geometry, full regression, audit, обновление receipts и контрольных документов. Операции recoverable, но длинные; любой обрыв требует выяснять, на каком commit point остановились.

### Предложение

Добавить server-side или CLI workflow:

```bash
easyui migration commit pay-example \
  --candidate cand_... \
  --acceptance-run acc_... \
  --gallery ypv2-probe-molecules \
  --screen-fragment screen.json \
  --audit-design-system yandex-pay-v2 \
  --receipt commit.json
```

Это не должна быть непрозрачная атомарная мутация. Нужна resumable saga с idempotency key и фазами:

`preflight → promote → gallery-save → impacted-regression → audit → complete`.

### Acceptance criteria

- повтор команды продолжает незавершённую saga, не создавая новую версию;
- receipt содержит before/after catalog revision, gallery rev, acceptance link и audit result;
- ошибка gallery не откатывает успешный promote, но оставляет явный `needs-gallery-commit`;
- dry-run показывает impact и операции до mutation.

## 7. P1 — Impact-driven gallery regression

### Проблема

Добавление одного molecule screen требует полного последовательного snap 43 экранов. Renderer concurrency 1 делает это надёжным, но дорогим. `track:head` знает dependency pins, однако impact graph не используется для выбора минимального regression scope.

### Предложение

- строить reverse dependency index `component/version → gallery screens`;
- при новом component screen снимать новый экран плюс экраны изменённых dependencies;
- периодически или перед milestone выполнять full regression;
- сохранять signed reuse receipt для не затронутых экранов.

### Acceptance criteria

- addition-only Connect Card снимает 1 новый экран, а остальные 42 получают доказанный reuse;
- изменение PayButton снимает только экраны, где resolved tree содержит PayButton;
- full regression остаётся отдельным явным режимом.

## 8. P1 — Стабильные agent-oriented receipts и schemas

### Проблема

Разные команды называют одинаковые факты по-разному. Например, snap receipt хранит `receipts[].receipt.verdict.captureClean`, но не имеет общего top-level summary; `.json` promote receipt исторически может быть plain text. Агент тратит вызовы на обнаружение `keys` и нормализацию схемы.

### Предложение

Для всех driver-команд вернуть общий envelope:

```json
{
  "schemaVersion": 1,
  "command": "snap",
  "ok": true,
  "summary": {},
  "items": [],
  "artifacts": [],
  "warnings": [],
  "nextActions": []
}
```

CLI должен иметь `--summary-json` с компактным стабильным contract. JSON output всегда должен быть JSON; текстовые receipts — `.txt`.

### Acceptance criteria

- status, geometry, snap, accept, promote и audit имеют один envelope;
- summary позволяет проверить run без дополнительных `keys` probes;
- schema version документирована и backward-compatible;
- exit code и `ok` согласованы.

## 9. P1 — Typed visual cause и policy suggestion

### Проблема

После точной геометрии остаются renderer-only различия: live text, vector edges, Medium shadow raster, transforms. Сегодня агент вручную доказывает причину, задаёт per-case budget и запускает policy-only recompute. Это корректно, но дорого и подвержено ошибочной классификации.

### Предложение

Acceptance должен выдавать не только `causes[]`, но и машинное предложение:

```json
{
  "suggestedPolicy": {
    "textAaBudget": "live-text-v1",
    "maxRawDiffPct": 2.7,
    "basis": "observed+0.041 safety margin",
    "scope": "case-id",
    "requiresHumanJudgement": true
  }
}
```

Suggestion не применяется автоматически. Оно должно включать доказательства: edge containment, best offset, unchanged geometry, affected element keys и сравнение с renderer baseline.

### Acceptance criteria

- одинаковая renderer-only причина группируется между cases;
- structural residual никогда не предлагается как waiver;
- принятое исключение получает expiry trigger по renderer/source fingerprint.

## 10. P1 — Figma Source Package как first-class input

### Проблема

Половина активных blocker mentions относится к source access/missing: exact master identity, instance override paint, runtime leaves, raw references. easy-ui получает уже собранный вручную manifest, поэтому не может проверить полноту provenance или подсказать, какого source artifact не хватает.

### Предложение

Поддержать content-addressed source package:

- Figma file key, node ids, component keys и source revision;
- raw exports с dimensions/SHA;
- instance property mapping;
- text runs, effects, assets и usage contexts;
- explicit `missing[]` и anomaly records.

Case-set builder может генерировать skeleton из source package, а reuse search — учитывать component key и semantic role.

### Acceptance criteria

- package upload валидирует размеры/SHA/provenance;
- duplicate exports дедуплицируются;
- missing exact reference появляется как typed preflight failure до component save;
- source revision change инвалидирует только зависимые cases.

## 11. P2 — Runtime defaults должны соответствовать schema defaults

### Проблема

Renderer не применяет Zod `.default()`, поэтому каждый default приходится дублировать через `??`. Это постоянный источник расхождений между contract validation, examples и runtime.

### Предложение

Нормализовать props через schema parse до вызова render либо генерировать runtime default adapter при compilation. На время миграции добавить audit warning, когда `.default(X)` не имеет доказанного runtime fallback.

### Acceptance criteria

- `{}` рендерится теми же значениями, которые возвращает contract parse;
- default semantics входят в candidate fingerprint;
- existing components можно перевести постепенно через capability/version flag.

## 12. P2 — Service capture hygiene

### Проблема

Gallery capture регулярно пишет ожидаемый `127.0.0.1:8787/api/auth/me` `ERR_FAILED` как ignored infra noise. Verdict остаётся clean, но лог разрастается и скрывает настоящие ошибки.

### Предложение

В service capture либо не выполнять host-auth probe, либо классифицировать его до console collection. Receipt может хранить отдельный счётчик suppressed known-noise без повторения строки для каждого screen.

### Acceptance criteria

- full gallery snap не печатает одинаковую auth/me ошибку 43 раза;
- неожиданные console/page errors по-прежнему блокируют или явно предупреждают;
- suppressed signatures видимы одним компактным summary.

## 13. Рекомендуемый порядок внедрения

| Priority | Improvement | Почему сначала |
|---|---|---|
| P0.1 | Geometry Contract v3 | прямо разблокирует source-faithful Payment Schedule и похожие overflow families |
| P0.2 | Deterministic resource barrier | устраняет недостоверные кадры и бесполезные source-итерации |
| P0.3 | Candidate dependency overlay | позволяет принимать molecule/organism целиком до первого publish |
| P0.4 | Migration commit transaction | сокращает самый частый ручной publication tail и делает его resumable |
| P1.1 | Impact-driven gallery regression | уменьшает renderer jobs после каждого promote |
| P1.2 | Stable summary receipts | сокращает диагностические tool calls и ошибки парсинга |
| P1.3 | Typed policy suggestions | уменьшает число acceptance итераций без ослабления gate |
| P1.4 | Figma Source Package | снижает долю source-missing и ручной evidence-сборки |
| P2.1 | Runtime schema defaults | убирает системный authoring footgun |
| P2.2 | Service capture hygiene | делает длинные regression logs пригодными для человека и агента |

## 14. KPI для следующей волны

- median server revisions до terminal acceptance: `≤2` для простого atom, `≤4` для molecule;
- доля acceptance failures с actionable typed cause: `≥95%`;
- late-resource failures после `readinessMet=true`: `0`;
- gallery screens recaptured после addition-only publish: `≤ new + impacted`, не full gallery;
- ручных операций от terminal acceptance до закрытого commit point: `1 resumable workflow`;
- дополнительных schema-discovery calls (`keys`, ad-hoc jq): `0` для штатного пути;
- geometry blockers, где root/layout/paint/export невозможно выразить: `0`;
- unpublished composed targets, требующих преждевременной публикации dependency: `0`.

## 15. Что это даст текущей цели

Для текущего Pay App/CPQR milestone P0.1–P0.3 снимают наиболее дорогие platform/acceptance тупики. P0.4 и P1.1 ускоряют каждый следующий принятый компонент. P1.4 не заменит доступ к Figma или продуктовые решения, но сделает source gaps ранними, точными и проверяемыми. В совокупности это переводит работу из цикла «собрать evidence → обнаружить ограничение поверхности → классифицировать вручную» в короткий цикл «source package → draft → actionable acceptance → resumable commit».

