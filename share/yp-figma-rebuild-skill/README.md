# yp-figma-rebuild-skill

Скилл для ИИ-агента с доступом к **Figma MCP** (библиотека Yandex Pay) и к **easy-ui HTTP API**: пересборка дизайн-системы Yandex Pay с нуля, атом за атомом, pixel-perfect против Figma. Самодостаточный — репозиторий easy-ui не нужен (Node ≥ 18).

## Состав

- `SKILL.md` — инструкция для агента (точка входа): правила, фазы, цикл атома, приёмка.
- `driver.mjs` + `easyui-auth.mjs` — CLI-харнес easy-ui (каталог, компоненты, прототипы, снапы, публикация).
- `api.mjs` — хелпер поверх того же auth: PATCH темы, Figma-provenance, загрузка ассетов, произвольные вызовы.
- `compare.mjs` — пиксельный дифф Figma-эталон ↔ snap (нужен одноразовый `npm i pixelmatch pngjs` в этом каталоге).
- `templates/atom.tsx`, `templates/probe.json` — шаблоны атома и probe-стикершита.
- `reference/easy-ui-authoring.md` — полный справочник механики easy-ui (грамматика документов, директивы, версии, troubleshooting); `reference/host-catalog.json` — host-типы; `reference/canonical-roles.md` — согласованные слаги `canonicalFor`.
- `examples/` — рабочие образцы механики (TSX-контракт, документы прототипов). Визуально они относятся к **старой** системе — использовать только как справку по механике.

## Установка и креды

1. Передать каталог целиком (архив: `tar czf yp-figma-rebuild-skill.tgz -C share yp-figma-rebuild-skill`).
2. Claude Code — положить в `.claude/skills/yp-figma-rebuild/`; другие агенты — указать путь к `SKILL.md`.
3. Окружение: `EASYUI_USERNAME` / `EASYUI_PASSWORD` (named-аккаунт с правом создать дизайн-систему); инстанс по умолчанию — `https://easy-ui.pay-offline.ru`, переопределяется `EASYUI_API`. У агента должен быть настроен Figma MCP с доступом к файлу библиотеки Yandex Pay (чтение нод + экспорт PNG).

Smoke: `node driver.mjs get prototypes` и `node api.mjs get /capabilities`.

## Ключевые правила (кратко)

- Старую систему `yandex-pay` не трогать; новая площадка — `yandex-pay-v2`, имена `pay-*` / `Pay*` (глобальная уникальность имён — `Yp*` заняты).
- Figma — единственный источник значений; каждый компонент несёт Figma-provenance + reference-скриншоты.
- Порядок строгий: тема (tokens/fonts) → `pay-box` → атомы → молекулы/организмы → эталонные экраны; компонент закрыт только после численной (`geometry` ±1px) и пиксельной (`compare.mjs` ≤2%, остаток — только антиалиасинг текста) приёмки.
- Renderer не применяет Zod-дефолты — каждый `.default()` дублируется `??` в рендере.
- `409 component_reuse_required|canonical_role_conflict|catalog_changed` — терминальный STOP.
