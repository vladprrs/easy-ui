# Тема: детальные правила tokens / fonts / icons

Справка к §3.2–3.3 SKILL.md — читать перед первым PATCH темы и при любом непонятном 422/откате шкалы.

Тема — версионируемые коллекции `{tokens, fonts, icons}`; токены доезжают в runtime как CSS-переменные `--eui-<key с '.'→'-'>`, шрифты — как `@font-face`.

- Грамматика ключа: `^[a-z][a-z0-9]*(\.[a-z0-9-]+)*$`, значение — строка ≤256 без `;{}<>` (число допустимо только вне `space.*`).
- **`space.*` — жёсткие правила**: ровно девятка `space.none|xs|sm|md|lg|xl|2xl|3xl|4xl` (из неё сервер строит `resolvedSpaceScale`), значения — **строки в абсолютных px** (`"4px"`, не `4`), `space.none` — ровно `"0px"`, шкала неубывающая, других `space.*`-ключей быть не может. Нарушение любой из этих норм молча откатывает `resolvedSpaceScale` на каноническую `0/4/8/12/16/24/32/48/64` — именно поэтому §3.3 обязателен.
- **`color.*` — синтаксический allowlist значений**: hex, `rgb(a)/hsl(a)/var()`, named color, `linear-gradient()/radial-gradient()`. `color.shadow-*` — только форма box-shadow `[inset] <x> <y> [blur] [spread] <color>` (список через запятую можно); `color.gradient-*` — только gradient-функция. `drop-shadow(...)`, `blur(...)` и прочие эффекты Figma в токен не лезут (422) — такие эффекты живут в CSS конкретного компонента.
- Пространства ключей: `color.<semantic>` — **все** цвета из Figma variables (семантические имена Figma в kebab: `color.text-primary`, `color.bg-main`, `color.button-primary-bg`, …), тени `color.shadow-*`, градиенты `color.gradient-*`; `radius.*`, `font.*` — по потребности (читаются через `token("radius.m")`).
- Шкала spacing не обязана совпадать с канонической — бери фактическую сетку Figma. Значение Figma вне шкалы (например gutter 20px) — не подгонять под токен, а писать литералом в компоненте.
- Шрифты (YS Text и что ещё использует библиотека): нужны woff2/ttf-файлы. Сначала проверь реестр — `node api.mjs get /design-systems/yandex-pay` → `fonts[]` содержит asset-id уже загруженных начертаний; ассеты глобальны, переиспользуй эти id (это бинарники, не визуальные решения старой DS — можно). Недостающие начертания запроси у владельца и загрузи: `node api.mjs upload YS-Text-Medium.woff2`.
- **Иконки** — тоже коллекция темы: `icons: [{name, assetId, viewBox?, themes?{light,dark}}]`, `name` — kebab-slug, `assetId` — существующий `image/*`-ассет (сначала upload, потом PATCH — ссылка на несуществующий ассет = 422). В компоненте иконка читается `Icon({name})` из `easy-ui/runtime/v4`.

```bash
cat > theme.json <<'EOF'
{ "tokens": { "color.text-primary": "…из Figma…",
              "space.none": "0px", "space.xs": "4px", "space.sm": "8px", "…": "…px" },
  "fonts":  [ { "family": "YS Text", "src": "asset_<sha256>", "weight": 400 },
              { "family": "YS Text", "src": "asset_<sha256>", "weight": 500 } ],
  "icons":  [ { "name": "plus-glyph", "assetId": "asset_<sha256>" } ] }
EOF
node api.mjs theme yandex-pay-v2 theme.json    # версия 1 (baseVersion подставится сам)
```

PATCH-семантика: переданная коллекция **заменяет** предыдущую целиком, опущенная наследуется. Но полный словарь ради двух токенов больше не нужен — правь тему **sparse-операциями с dry-run** (W4):

```bash
# 1. dry-run: валидация + дифф + итоговая resolvedSpaceScale, версия НЕ создаётся
echo '{"addTokens":{"color.button-primary-bg":"#FFDD2D"},"dryRun":true}' > patch.json
node api.mjs theme yandex-pay-v2 patch.json     # baseVersion подставит сам
# 2. тот же файл без "dryRun" — запись
```

- `addTokens`/`addFonts`/`addIcons` — **append-only** поверх `baseVersion`: передаёшь только добавляемое. Существующая запись с другим значением → `409 theme_append_conflict` (тихой перезаписи нет), удаление невозможно — для него остаётся полный PATCH. Sparse-операция и её полный аналог (`tokens`/`fonts`/`icons`) в одном теле взаимоисключающи.
- **No-op не создаёт версию**: патч, результат которого равен `baseVersion`, отвечает `{noop:true, nextVersion:null}` — 13 версий темы за миграцию больше не набегает.
- Ответ несёт `diff` (added/changed/removed), `resolvedSpaceScale`, `spacingResolver` и **`stalePins`** — список прототипов, чья голова пинует старую версию темы. Это точный список того, что надо пересохранить, а не догадка.
- `spacingResolver: 2` у новых версий: spacing-оверрайды мерджатся на базовую шкалу самой DS, а полный token-патч, из которого `space.*` выпали целиком, наследует шкалу базовой версии (наследованные ключи перечислены в `inheritedSpaceTokens`), а не молча уезжает на каноническую.

Пока на токен никто не сослался, значения можно свободно править новой версией; после — каждая правка глобально меняет уже принятые компоненты, фиксируй такие правки в `BUILD_ORDER.md`. **Ревизия прототипа пинует версию темы**: после любого PATCH темы пересохрани каждый probe/ref-прототип из `stalePins` (`driver.mjs prototype <doc>.json`) до пере-снапа, иначе snap покажет старые токены и «фикс не сработал» — `track: head` (§4.6) резолвит только компонентные пины и от этого не спасает. `preview` атома тему не пинует — берёт всегда последнюю, пересохранений не требует (§4.6).

### 3.3 Верификация темы

`node driver.mjs catalog list yandex-pay-v2 --json` → `designSystem.resolvedSpaceScale` совпадает с задуманной девяткой (если вернулась каноническая `0/4/8/…`, которую ты не задавал — тема нарушила правила `space.*` и молча откатилась, чинить). После появления `pay-box` и `pay-text` собери probe-экран-«свотч» (сетка цветов и текстовых стилей) и проверь фактические цвета пикселей snap-PNG против hex из Figma (точное равенство; пипетка — прочитать RGB нужного пикселя из PNG любым способом, хоть `compare.mjs` на однотонном эталоне).
