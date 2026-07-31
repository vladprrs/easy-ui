# easy-ui-authoring-skill

Скилл для ИИ-агентов: создание custom-компонентов и кликабельных прототипов в easy-ui через HTTP API. Самодостаточный — репозиторий easy-ui не нужен, зависимостей нет (Node ≥ 18).

## Состав

- `SKILL.md` — инструкция для агента (точка входа).
- `driver.mjs` — CLI-харнес (все операции: каталог, компоненты, прототипы, скриншоты, публикация).
- `easyui-auth.mjs` — auth-клиент драйвера (должен лежать рядом с `driver.mjs`).
- `examples/` — рабочие образцы: TSX-компоненты (`rating-stars.tsx` — ABI v1, `plan-picker.tsx` — typed events + named slots) и документы прототипов (`rating-demo.json`, `plan-demo.json`, `yp-checkout-demo.json` — Yandex Pay DS).
- `reference/host-catalog.json` — встроенные host-типы (`Image`/`Hotspot`/`Overlay`/`@eui/FlowRoot`).

## Как отдать коллегам

1. Передать каталог целиком (например, архивом: `tar czf easy-ui-authoring-skill.tgz -C share easy-ui-authoring-skill`).
2. Установка зависит от агента:
   - Claude Code — положить в `.claude/skills/easy-ui-authoring/` проекта или `~/.claude/skills/`;
   - Codex CLI / прочие — положить в удобное место и указать агенту путь к `SKILL.md`.
3. Выдать креды окружения: `EASYUI_USERNAME` / `EASYUI_PASSWORD` (named-аккаунт на инстансе), при включённом внешнем барьере — `EASYUI_LEGACY_BASIC_AUTH`. Инстанс по умолчанию — прод `https://easy-ui.pay-offline.ru`, переопределяется `EASYUI_API`.

Smoke-проверка после установки:

```bash
node driver.mjs get prototypes
```

## Ключевые правила (кратко)

- Каталог в режиме **enforce**: перед созданием компонента — `catalog search` по intent; `409 component_reuse_required` — терминальный STOP, не ретраить и не обходить без явного решения человека (`--force-new --reason`, только админ).
- Экран из существующих компонентов — это `composition`, а не новый компонент.
- Props валидируются строго: `catalog get` по каждому используемому типу обязателен.
- Проверка результата: `status` → `geometry` → `snap` (серверные скриншоты), PNG смотреть глазами.
