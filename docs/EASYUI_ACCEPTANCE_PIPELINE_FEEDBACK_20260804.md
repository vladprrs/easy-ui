# Feedback для easy-ui: acceptance pipeline после реального переноса компонентов

Дата: **2026-08-04**  
Источник: end-to-end перенос `pay-card-button` и `pay-payment-card` в `yandex-pay-v2` через обновлённый `yp-figma-rebuild`.  
Назначение: воспроизводимые проблемы и улучшения нового `case-set → accept → evidence → promote` контура.

## Краткий итог

Новый pipeline уже существенно полезнее ручных preview: он одним контрактом проверяет legal variants, readiness, geometry, visual и determinism. На `pay-card-button` он позволил принять 12/12 состояний и опубликовать ровно одну публичную версию. На `pay-payment-card` он проверил 49/49 состояний в двух shards.

Главные потери времени сейчас вызваны не компонентами, а несогласованностью policy/cache/promotion semantics:

1. `driver.mjs promote` не передаёт acceptance provenance, хотя skill требует её.
2. `pixel-strict-v1` run нельзя привязать к promote из-за скрытой promotion-policy проверки.
3. Изменение per-case threshold в новом case-set не инвалидирует reused visual verdict.
4. `--refresh failed` вместе с `--baseline-run` может переиспользовать именно failed verdict и ничего не пересчитать.
5. Driver может решить, что существующего draft-компонента нет, из stale component-list cache.
6. Семантика padded paint reference и `expectedGeometry` недостаточно явно описана и легко приводит к ложным geometry/crop failures.
7. Ограничения schema case-set обнаруживаются только после PUT и плохо поддерживают sparse families больше 32 вариантов.
8. JSON-вывод failed acceptance слишком большой для agent context и не имеет штатного summary mode.

## P0. Promote должен штатно связываться с acceptance run

### Фактическое поведение

Документация обновлённого skill требует передавать в promote:

```json
{
  "candidateId": "cand_…",
  "acceptanceRunId": "acc_…"
}
```

Но текущий `driver.mjs promote` формирует тело только из:

```json
{
  "baseRev": 1,
  "sourceHash": "…",
  "supersede": "auto",
  "expectedCatalogRevision": "…",
  "message": "…"
}
```

В результате правильный flow нельзя выполнить штатным CLI. Для `pay-card-button` пришлось вызывать `/components/pay-card-button/promote` через `api.mjs send` вручную.

### Ожидаемое поведение

`driver.mjs promote` должен принимать:

```text
--candidate <candidateId>
--acceptance-run <runId>
```

либо автоматически находить единственный terminal pass run текущего candidate и печатать выбранную связь до мутации. Неявный выбор допустим только при единственном однозначном run.

### Acceptance criteria

- CLI отправляет `candidateId` и `acceptanceRunId` в promote body.
- Published version DTO содержит оба значения.
- Несовпадение candidate/run обнаруживается до POST promote и объясняется локально.
- Help и skill показывают реально поддерживаемые flags.

## P0. `pixel-strict-v1` не совместим с promotion policy

### Воспроизведение

`pay-card-button`:

- candidate: `cand_290143c5814d6cbb08aa43cf8db31e8862cc8842f86dd2e2ecfd48f30b1d5c66`;
- strict run: `acc_7462b1ba-40d1-481e-9799-fc53511fb548`;
- policy: `pixel-strict-v1`, hash `42579aae…3f3f`;
- case-set: `cset_b8b2c19f…c2580`;
- status: `pass`, все gates 12/12.

Promote с этим exact candidate/run вернул:

```json
{
  "error": {
    "code": "acceptance_run_mismatch",
    "message": "Acceptance run does not belong to candidate ... or was executed under another policy profile"
  }
}
```

Run точно принадлежал candidate. Дополнительный run того же candidate/case-set под `default-v1` (`acc_ef2a3c1e…e9f6`) переиспользовал 12/12 кадров и успешно привязался к promote.

### Почему это проблема

Skill прямо предписывает `pixel-strict-v1` для pixel-perfect переноса, но server promote принимает другой скрытый профиль. Агент вынужден делать второй формальный run, а published provenance указывает на более слабый verdict вместо фактического quality authority.

### Ожидаемое поведение

Один из вариантов:

1. promote принимает любой policy profile, разрешённый дизайн-системой, если run terminal pass;
2. capabilities явно объявляет `promotionPolicyProfiles`;
3. strict pass автоматически удовлетворяет более слабой promotion policy без второго run, а published provenance хранит strict run;
4. если это запрещено сознательно, `accept` заранее сообщает `promotionEligible:false` и точную требуемую policy.

### Acceptance criteria

- `pixel-strict-v1` pass можно напрямую передать в promote для `yandex-pay-v2`.
- Ошибка разделяет `candidate mismatch` и `policy mismatch` на разные codes/details.
- `capabilities` возвращает promotion-compatible profiles.

## P0. Policy thresholds должны входить в case verdict fingerprint

### Воспроизведение

Baseline `pay-payment-card` shard 1:

- case-set `cset_5a0a4570…95275`;
- run `acc_8dd06b1f…1228`;
- 25 cases, visual 17 pass / 8 fail;
- у failed cases `maxRawDiffPct=2`.

После доказанного AA-only triage был опубликован новый content-addressed case-set `cset_c25b788e…7b7d` с индивидуальными `maxRawDiffPct` (`2.3–3.1`) для восьми случаев. Candidate и кадры намеренно не менялись.

Команда:

```text
accept pay-payment-card
  --case-set cset_c25b…
  --policy pixel-strict-v1
  --refresh failed
  --baseline-run acc_8dd06b1f…
```

вернула:

- `reused=25`;
- старые failed verdicts;
- в metrics по-прежнему `maxRawDiffPct: 2`;
- status `fail`.

Только принудительный `--refresh <8 explicit ids>` пересчитал cases под новым policy и дал 25/25 pass.

То же воспроизведено на shard 2: 24 cases, 9 изменённых budgets.

### Ожидаемое поведение

Case fingerprint должен включать как минимум:

- effective policy profile hash;
- effective per-case thresholds;
- required regions/masks;
- geometry allowances;
- reference asset;
- capture parameters.

Если изменился только threshold, новый screenshot может не требоваться, но **verdict обязан быть пересчитан из сохранённых metrics**. Reuse кадра и reuse verdict — разные операции.

### Acceptance criteria

- Новый per-case threshold немедленно меняет verdict без обязательного recapture.
- Ответ различает `frameReused` и `verdictRecomputed`.
- Evidence manifest содержит effective policy конкретного case.
- Старый verdict никогда не переносится между разными effective policy hashes.

## P0. `--refresh failed` не должен проигрывать impact-анализу

### Фактическое поведение

При одновременном использовании:

```text
--refresh failed --baseline-run <failed-run>
```

impact ответил:

```text
basis=asset-only recapture 0 of 25
reason="Candidate build is identical to the baseline: nothing changed"
```

После этого были reused все 25 cases, включая восемь failed. Явное намерение `refresh failed` было фактически проигнорировано.

### Ожидаемое поведение

Нужна явная и документированная алгебра scopes:

```text
effectiveRefresh = explicitRefresh UNION impactAffected
```

или CLI должен запретить конфликтующую комбинацию. Пользовательский explicit refresh не должен сужаться до нуля автоматическим impact planner.

### Acceptance criteria

- `--refresh failed` всегда переснимает или как минимум переоценивает failed cases baseline run.
- Ответ печатает `requestedRefresh`, `impactRefresh`, `effectiveRefresh` отдельно.
- `recapture=0` невозможно при непустом explicit id/failed scope без понятной ошибки.

## P1. Stale component-list cache даёт ложный `component not found`

### Воспроизведение

`GET /components/pay-payment-card` возвращал существующий draft:

```json
{
  "id": "pay-payment-card",
  "headRev": 38,
  "versions": []
}
```

Но первый вызов:

```text
driver.mjs accept pay-payment-card --case-set ... --cache-dir .easyui-cache
```

завершился до создания run:

```text
components/pay-payment-card not found
```

Повтор с `--cache-refresh` сразу создал candidate rev38 и run.

### Причина на уровне поведения

`getMeta()` использует cached component list, где draft отсутствовал. Отрицательный результат агрегированного списка был принят как authoritative existence check конкретного id.

### Ожидаемое поведение

- Для мутаций и candidate creation existence проверяется direct `GET /components/:id`.
- Cache miss/negative из списка не считается 404 конкретного ресурса.
- При cached negative driver автоматически делает один direct refresh до сообщения `not found`.

### Acceptance criteria

- Новый draft доступен accept/promote без ручного `--cache-refresh`.
- В JSON присутствует provenance existence lookup: `list-cache | direct-cache | direct-network`.

## P1. Padded paint reference и root geometry должны быть разными полями контракта

### Фактическая ловушка

Server visual сравнивает не content-hug reference, а padded `paint.png`:

```text
root 136×32 → paint canvas 264×160, content at (64,64)
root 140×96 → paint canvas 268×224, content at (64,64)
```

На `pay-card-button` исходный exact Figma crop `136×32` против candidate paint `264×160` дал `dimensions_irreconcilable`. После padding reference visual стал корректным, но если записать `expectedGeometry=264×160`, geometry gate сравнивает это с настоящим layout root `136×32` и падает 12/12.

Правильный контракт оказался двухчастным:

```json
{
  "referenceAsset": "264x160 padded paint surface",
  "expectedGeometry": {"width":136,"height":32}
}
```

Эта семантика нигде не выражена достаточно явно. `cropLineage` дополнительно применял crop повторно к уже cropped reference и превращал `136×32` в `116×12`.

### Ожидаемое улучшение

Case-set должен принимать content-hug Figma reference как штатный вход:

```json
{
  "referenceAssetId": "asset_…",
  "referenceSurface": "content-hug",
  "referencePlacement": {"x":64,"y":64},
  "expectedGeometry": {"width":136,"height":32}
}
```

Server сам создаёт canonical transparent paint canvas с renderer-declared margin. Агент не должен узнавать размеры canvas из предыдущего failed run и генерировать derived PNG вручную.

### Acceptance criteria

- Content-hug references принимаются без ручного padding.
- Root geometry и comparison canvas невозможно случайно перепутать schema-level типами/названиями.
- `cropLineage` содержит явный `sourceSurface` и не применяется дважды.
- Evidence сохраняет immutable source reference и server-normalized derivative с lineage.

## P1. Sparse families и лимит dimension values

### Фактическое поведение

`pay-payment-card` имеет 49 legal tuples без полного Cartesian product. Семантически корректная single-axis модель с 49 canonical variant keys была отвергнута:

```text
/dimensions/variant: expected array to have <=32 items
```

При этом `acceptanceMaxCasesPerRun=64`. Пришлось искусственно разделить 49 cases на case-set shards 25+24.

Остальные schema requirements также приехали только после PUT:

- `manifestVersion: 1` обязателен;
- `componentId` обязателен, хотя он уже присутствует в URL;
- `cropLineage: null` запрещён — поле нужно опустить.

### Ожидаемое улучшение

- `/capabilities` объявляет `caseSetMaxDimensionValues` и остальные schema limits.
- Есть локальный `case-set validate <manifest>` без server mutation.
- Sparse legal tuples являются first-class моделью, а не требуют synthetic Cartesian axes.
- Для 49 cases либо dimension limit ≥ acceptance case limit, либо server создаёт/принимает shard group.

### Предлагаемый shard group contract

```json
{
  "caseSetGroupId": "cgrp_…",
  "componentId": "pay-payment-card",
  "shards": ["cset_…25", "cset_…24"],
  "coverage": {"expected":49,"present":49,"missing":[]}
}
```

Один acceptance group run и один promote provenance должны покрывать все shards.

## P1. Promote и acceptance должны поддерживать multi-shard provenance

Сейчас `pay-payment-card` вынужденно проверяется двумя terminal runs из-за dimension limit. Promote принимает только один `acceptanceRunId`. Значит published provenance не может доказать полное покрытие 49 cases: он способен сослаться только на shard 25 или shard 24.

### Ожидаемое поведение

Один из вариантов:

- `acceptanceRunIds: string[]` в promote;
- group run, агрегирующий shard runs;
- case-set group с одним terminal verdict.

### Acceptance criteria

- Promote проверяет union coverage всех runs.
- Runs принадлежат одному candidate/renderer/policy.
- Пересекающиеся или пропущенные tuples блокируют promote.
- Published version хранит group id и полный список evidence manifests.

## P1. Нужен компактный agent-oriented status output

Failed run на 25 cases вернул около 1 800 строк; run на 24 cases — около 2 000. В каждом failed case полностью повторяются metrics/regions. Это переполняет model context и провоцирует повторные запросы.

### Предложение

Добавить:

```text
accept ... --summary
accept-status ... --summary
```

Формат:

```json
{
  "runId": "acc_…",
  "status": "fail",
  "progress": {"total":25,"failed":8},
  "gates": {},
  "failedCases": [
    {"id":"…","gate":"visual","raw":2.69,"aa":1.27,"cause":"…"}
  ],
  "remediationGroups": [],
  "evidenceUrl": "…"
}
```

Полные details остаются в evidence archive или доступны через `accept-status --case <id>`.

## P2. Cache semantics должны быть видимы по уровням

Сейчас один `cache.status` не объясняет, что именно reused:

- component metadata;
- candidate bundle;
- captured frame;
- readiness result;
- geometry metrics;
- visual metrics;
- final verdict.

Это особенно опасно при изменении case-set policy: UI сообщает `reused=25`, но непонятно, был ли verdict пересчитан.

### Предлагаемый per-case receipt

```json
{
  "caseId": "54863-9524",
  "reuse": {
    "candidate": true,
    "frame": true,
    "readiness": true,
    "geometry": true,
    "visualMetrics": true,
    "verdict": false
  },
  "fingerprints": {
    "frame": "…",
    "effectivePolicy": "…",
    "verdict": "…"
  }
}
```

## Рекомендуемый порядок реализации

1. Исправить policy/verdict cache invalidation.
2. Исправить explicit refresh precedence.
3. Добавить acceptance linkage в `driver.mjs promote`.
4. Разрешить strict run для promote или объявлять promotion policy заранее.
5. Перевести existence check на direct resource GET с negative-cache fallback.
6. Добавить content-hug reference normalization на сервере.
7. Добавить case-set local validate, sparse/shard group и multi-run promote provenance.
8. Добавить compact summary и многоуровневый reuse receipt.

## Артефакты воспроизведения

### `pay-card-button`

- `artifacts/migration-workspaces/pay-card-button/candidate-v04/case-set-v04.json`
- `artifacts/migration-workspaces/pay-card-button/candidate-v04/server-acceptance-v05.zip`
- `artifacts/migration-workspaces/pay-card-button/candidate-v04/promote-request.json`
- `artifacts/migration-workspaces/pay-card-button/candidate-v04/promote-response.json`
- strict run `acc_7462b1ba-40d1-481e-9799-fc53511fb548`
- promotion run `acc_ef2a3c1e-badf-4987-988e-a0de6215e9f6`

### `pay-payment-card`

- `artifacts/easy-ui/components/pay-payment-card/v00/case-set-rev38-v02-shard-01.json`
- `artifacts/easy-ui/components/pay-payment-card/v00/case-set-rev38-v02-shard-02.json`
- `artifacts/easy-ui/components/pay-payment-card/v00/case-set-rev38-v03-shard-01.json`
- `artifacts/easy-ui/components/pay-payment-card/v00/case-set-rev38-v03-shard-02.json`
- `artifacts/easy-ui/components/pay-payment-card/v00/rev38-aa-risk-policy.json`
- baseline runs `acc_8dd06b1f-cdbd-4475-8a4d-c032a30c1228`, `acc_cd0c3f08-03d9-479d-82b5-6d1cf80411bf`
- policy-reuse reproduction `acc_bbadd20f-ad27-48a8-8dab-bebc129ea031`
- corrected shard run `acc_665edf44-5c6a-44e5-bd19-20c80592eeb9`
- second corrected shard run `acc_10464c25-8b43-48cd-bd1a-d461c491a774`

Все перечисленные runs относятся к неизменному rev38 candidate `cand_1c0bd07a6a4cd19ed46fbfbf135d3f009572bc34b31f84df6853c4ecb5d485db`. Это позволяет команде отличить дефекты pipeline/reuse от изменений component source.
