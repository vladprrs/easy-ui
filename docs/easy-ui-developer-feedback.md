# Feedback по easy-ui после переноса Yandex Pay Design System

**Контекст:** документ собран по итогам переноса 50+ компонентов Yandex Pay WebView Design System, создания gallery и нескольких интерактивных прототипов в easy-ui.

**Главный вывод:** easy-ui уже хорошо работает как хранилище версионируемых custom React-компонентов со строгими Zod-контрактами. Но для сложных продуктовых сценариев пока не хватает полноценной композиции, типизированной интерактивности, asset pipeline и встроенной визуальной верификации. Из-за этого сложный экран проще сделать одним монолитным React-компонентом, чем собрать из элементов дизайн-системы.

---

## Что уже хорошо

- Строгие Zod-контракты custom components.
- JSON-safe prototype documents.
- Component revision history и published versions.
- Version pins компонентов в прототипах.
- Привязка компонентов и прототипов к отдельной `designSystem`.
- Поддержка `atomicLevel` для Atomic Design.
- API read-back опубликованных ресурсов.
- Возможность публиковать React component bundle.
- Базовые events и prototype actions.
- Разделение reusable components и prototype documents — правильная архитектурная основа.

---

# P0 — блокирует нормальную разработку

## 1. Стабильный player route и API render status

### Проблема

Компонент и prototype успешно сохраняются, API возвращает revisions и pins, но canonical screen route может вернуть HTTP 404:

```text
/p/<prototype-id>/s/<screen-id>
```

Из-за этого невозможно надёжно:

- открыть опубликованный результат;
- проверить events/navigation;
- снять browser screenshot;
- провести visual regression;
- отличить ошибку документа от ошибки bundle/player/ingress.

### Предложение

API должен возвращать canonical URL каждого screen и структурированный render status:

```http
GET /api/prototypes/:id/screens/:screenId/render-status
```

Пример ответа:

```json
{
  "status": "ready",
  "url": "/p/example/s/start",
  "revision": 3,
  "publishedVersion": 2,
  "resolvedPins": {
    "yp-button": 2
  },
  "bundleStatus": "ready",
  "errors": []
}
```

### Acceptance criteria

- API различает `prototype_not_found`, `screen_not_found`, `bundle_failed`, `revision_not_deployed`, `route_not_ready`.
- Save/publish возвращает canonical screen URLs.
- Существует машинно-проверяемый признак `renderable: true|false`.
- Player route становится доступным после успешного publish без ручной диагностики ingress.

---

## 2. Типизированные event payloads

### Проблема

Сейчас component events описываются как список строк:

```ts
events: ["press", "itemPress"]
```

Event не передаёт payload. Carousel или список способов оплаты может сообщить только «что-то нажали», но не какой элемент:

```json
{
  "itemId": "pay-card"
}
```

Это блокирует нормальную реализацию:

- radio groups;
- tabs;
- carousel selection;
- payment-method selection;
- Split selection;
- списков офферов;
- форм и таблиц;
- любых повторяемых интерактивных элементов.

В результате приходится создавать отдельное event name для каждого item, прятать state внутри монолитного React-компонента или заводить отдельный prototype screen на каждое состояние.

### Предложение

Типизированные events:

```ts
events: {
  itemPress: z.object({
    itemId: z.string()
  }),
  selectionChange: z.object({
    value: z.string()
  })
}
```

Binding event payload в action:

```json
{
  "itemPress": {
    "action": "setState",
    "params": {
      "path": "/selectedMethod",
      "value": { "$event": "/itemId" }
    }
  }
}
```

Минимальная версия:

- `$event`;
- `$elementId`;
- `$itemIndex`;
- `$itemKey`.

### Acceptance criteria

- Event schema валидируется при публикации компонента.
- Player показывает payload в debug mode.
- Payload доступен в `setState`, `navigate`, `openUrl` и conditional actions.
- Старые payloadless events продолжают работать.

---

## 3. Композиция дизайн-системы: named slots, repeat и templates

### Проблема

Сложный экран сейчас проще реализовать одним custom page-компонентом, чем собрать из опубликованных компонентов:

- `YpScreen`;
- `YpNavigation`;
- `YpAmount`;
- `YpPromoBase`;
- `YpCustomCarousel`;
- `YpBaseCardMini`;
- `YpPseudoRadio`;
- `YpButton`.

Это подталкивает к монолитам и снижает ценность импортированной дизайн-системы.

### Чего не хватает

- named slots;
- несколько независимых slot regions;
- repeat/list directive;
- item templates;
- event bubbling с payload;
- state binding внутри repeated elements;
- локальный state scope;
- reusable composite definitions;
- conditional slot content.

### Желаемый формат

```json
{
  "type": "YpPaymentMethodSelector",
  "props": {
    "selected": { "$state": "/selectedMethod" }
  },
  "slots": {
    "header": ["payment-title"],
    "items": {
      "$each": {
        "items": { "$state": "/methods" },
        "as": "method",
        "key": "id",
        "template": "payment-method-card"
      }
    }
  }
}
```

### Acceptance criteria

- Один component instance поддерживает несколько named slots.
- `$each` умеет работать с prototype state.
- Template получает текущий item и index.
- Events внутри template сохраняют item context.
- Валидация ловит неизвестные slots/templates.
- Ограничения глубины/числа элементов остаются контролируемыми.

---

## 4. Asset registry и multi-file custom components

### Проблема

Для точного Figma asset сейчас приходится:

1. экспортировать файл отдельно;
2. переносить между runtime;
3. искать доступный URL;
4. либо встраивать большой base64 прямо в TSX.

Также неудобно работать с:

- SVG sprite;
- bank icons;
- merchant logos;
- banner artwork;
- локальными fonts;
- несколькими файлами одного компонента.

### Предложение

Asset API:

```http
POST /api/assets
GET /api/assets/:id
```

Использование в document:

```json
{
  "image": {
    "$asset": "asset_123"
  }
}
```

Либо multi-file component package:

```text
component.tsx
styles.css
assets/banner.webp
assets/pay-logo.svg
```

### Acceptance criteria

- Private asset storage внутри easy-ui.
- Deduplication по SHA-256.
- MIME/type/size validation.
- Assets versioned или content-addressed.
- Bundle resolver умеет импортировать локальные assets.
- Нельзя случайно опубликовать `file://` или недоступный runtime path.
- API read-back показывает asset pins/hashes.

---

## 5. Server-side screenshot endpoint

### Проблема

Player/browser не должен быть единственным способом получить проверяемый render. При проблеме route полностью блокируется visual pipeline.

### Предложение

```http
POST /api/prototypes/:id/screens/:screenId/screenshot
```

Параметры:

```json
{
  "revision": 3,
  "viewport": {
    "width": 375,
    "height": 812
  },
  "deviceScaleFactor": 1,
  "theme": "light",
  "waitForFonts": true
}
```

Ответ:

```json
{
  "imageUrl": "/api/screenshots/shot_123",
  "width": 375,
  "height": 812,
  "consoleErrors": [],
  "pageErrors": [],
  "bundleHash": "...",
  "componentPins": {
    "yp-button": 2
  }
}
```

### Acceptance criteria

- Screenshot привязан к точной revision и pins.
- Возвращаются browser console/page errors.
- Можно ждать fonts/images/network idle.
- Можно запросить light/dark и mobile/desktop.
- Screenshot воспроизводим в CI.

---

# P1 — сильно повысит качество

## 6. Встроенный visual regression

### Проблема

Сейчас visual gate приходится строить вручную:

- переносить PNG;
- проверять dimensions и SHA-256;
- самостоятельно запускать ImageMagick;
- следить, что сравниваются одинаковые content/state/theme/viewport;
- отдельно хранить diff artifacts.

Это создаёт риск получить численный diff между несопоставимыми изображениями или неверно применить metric одного компонента к другому.

### Предложение

В easy-ui нужны:

- загрузка reference screenshot;
- привязка к component/prototype/screen/revision;
- viewport, theme, props/state metadata;
- автоматический candidate capture;
- side-by-side;
- overlay;
- absolute error;
- perceptual diff;
- generated diff image;
- история результатов.

Пример отчёта:

```text
Surface: YpScrollX / light-mobile
Reference: path + SHA-256
Candidate: revision + path + SHA-256
Viewport: 343×42
Metric: AE
Different pixels: 960 / 14406
Result: 6.6639%
```

### Обязательный evidence guard

Нельзя показывать процент, если нет:

- физического reference-файла;
- физического candidate-файла;
- dimensions обоих;
- SHA-256 обоих;
- exact metric/command;
- абсолютного числа отличающихся пикселей;
- denominator.

Ephemeral Figma MCP image attachment не считается reference, пока файл не сохранён.

Если reference directory пустая:

```json
{
  "status": "visual_reference_missing",
  "pixelDiffPercent": null
}
```

---

## 7. Design-system tokens, fonts и icon registry

### Проблема

Custom components сейчас самостоятельно задают:

- colors;
- fallback fonts;
- radii;
- shadows;
- spacing;
- Plus gradients;
- icons.

Компонент формально относится к `yandex-pay`, но единая тема почти не применяется.

### Предложение

```json
{
  "id": "yandex-pay",
  "tokens": {
    "color.text.primary": "#000000db",
    "color.fill.default.0": "#ffffff",
    "radius.m": 12,
    "font.body": "YS Text"
  },
  "fonts": [],
  "icons": [],
  "assets": []
}
```

Использование:

```ts
color: token("color.text.primary")
```

### Acceptance criteria

- Tokens versioned на уровне design system.
- Custom component может использовать token helper.
- Player показывает font loading status.
- Icon registry поддерживает SVG/viewBox и themes.
- Prototype может pin design-system version.

---

## 8. OpenAPI, JSON Schema и capabilities discovery

### Проблема

В текущем окружении:

```text
/openapi.json → 404
/api/openapi.json → 404
```

Приходится угадывать:

- поля component definition;
- различия custom/builtin component schema;
- модель revision/version;
- publication lifecycle;
- design-system capabilities;
- поддерживаемые directives/actions;
- почему поле проходит TypeScript, но отклоняется backend schema.

Например, `atomicLevel` поддерживается, а `layoutNeutral` для custom component отклоняется — это обнаружилось только экспериментально.

### Предложение

- OpenAPI endpoint.
- Versioned JSON Schema для prototype document.
- JSON Schema для component definition.
- `/api/capabilities`.
- Полные validation errors с JSON path.
- Документация migration/backward compatibility.

---

## 9. Ясная модель draft → published → deployed/renderable

### Проблема

Сейчас одновременно существуют:

- `headRev`;
- `latestVersion`;
- prototype с `headRev`, но `latestVersion: null`;
- component pins;
- API-readable resource;
- player route, который может быть недоступен.

Неясно, что именно означает «опубликован».

### Предложение

```text
draft revision
→ validated revision
→ published version
→ deployed/renderable version
```

Ответ API:

```json
{
  "draftRevision": 4,
  "validatedRevision": 4,
  "publishedVersion": 3,
  "deployedVersion": 3,
  "renderable": true
}
```

---

## 10. Автоматический gallery/catalog design system

### Проблема

Gallery приходится обновлять вручную после каждой новой волны компонентов. При 50+ компонентах это отдельная система учёта.

### Предложение

Автогенерация gallery из metadata:

- `atomicLevel`;
- description;
- default example;
- variants;
- states;
- published version;
- verification status;
- visual references.

Фильтры:

```text
Atoms / Molecules / Organisms / Templates / Pages
Published / Visual pending / Verified / Blocked / Rejected
```

---

# P2 — улучшит агентский и дизайнерский workflow

## 11. Figma provenance

Полезно хранить на component/prototype:

```json
{
  "figma": {
    "fileKey": "...",
    "nodeIds": ["..."],
    "referenceScreenshots": ["asset_123"],
    "lastSyncedAt": "..."
  }
}
```

Это позволит:

- видеть source node;
- понимать, какой revision с каким node сравнивался;
- хранить reference screenshot;
- не смешивать metadata-only reconstruction и реальную visual verification.

---

## 12. Interaction inspector

В player нужен debug panel:

```text
component: YpPaymentMethodCard
event: press
payload: { id: "pay-card" }
action: setState
path: /selectedMethod
previous: "sbp"
next: "pay-card"
```

Он должен показывать:

- emitted event;
- payload;
- matched action;
- state diff;
- navigation target;
- validation/runtime errors.

---

## 13. Semantic prototype validation

Кроме JSON Schema нужны warnings:

- event объявлен, но не обработан;
- action ведёт на неизвестный screen;
- screen недостижим;
- component pin отсутствует;
- payload не содержит item identity;
- interactive element не имеет accessible label;
- image использует слишком большой base64;
- prototype содержит несколько screens без реальных переходов;
- page состоит из одного монолитного custom component и почти не использует design-system composition;
- local/file asset недоступен player runtime.

---

## 14. Статусы rejected/deprecated/superseded

### Проблема

Неудачные revisions нельзя безопасно удалить, но они остаются `active` и выглядят валидными.

### Предложение

```text
active
rejected
deprecated
superseded
archived
```

С reason:

```json
{
  "status": "rejected",
  "reason": "Visual mismatch with Figma; invalid interaction model",
  "supersededBy": 3
}
```

---

# Рекомендуемый порядок реализации

## Первые пять задач

1. **Typed event payloads и `$event` binding**.
2. **Player render-status и server-side screenshot API**.
3. **Asset registry и multi-file custom components**.
4. **Named slots, repeat и templates**.
5. **Visual references и diff pipeline**.

Именно эти пять изменений дадут максимальный прирост скорости и качества.

---

# Короткая версия для команды

> После переноса 50+ компонентов главные блокеры easy-ui: нестабильный player route, отсутствие event payloads, asset registry, server-side screenshots и встроенного visual diff. Из-за слабой композиции сложные экраны приходится делать монолитными React-компонентами. Нужны typed payload + `$event`, repeat/templates/named slots, design-system tokens/fonts/icons, понятная draft→published→renderable модель, OpenAPI и rejected/deprecated revisions.

---

# Ожидаемый результат

После реализации P0 easy-ui станет пригоден не только для хранения custom components, но и для сборки сложных интерактивных продуктовых сценариев из элементов дизайн-системы. После P1 появится воспроизводимый visual-quality gate, необходимый для production-level UI и Figma parity.
