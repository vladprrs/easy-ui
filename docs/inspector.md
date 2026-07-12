# Interaction inspector

Debug panel for the prototype player (feedback §12, plan H.1).

## How to enable

Open any player route with the `debug=1` query parameter:

```
/p/<prototypeId>/s/<screenId>?debug=1
/p/<prototypeId>/v/<version>/s/<screenId>?debug=1
```

The flag is latched for the whole player session: in-player navigation rewrites the
URL and drops the query string, but the panel stays active until you leave the
player. The panel floats on the right edge and can be collapsed to a small toggle.

## What it shows

A ledger of the latest 50 runtime records, newest first, with a kind filter and a
Clear button:

- **event** — an emitted custom-component event: component, event name, delivered
  payload, element id, and whether the payload passed its Zod schema. Each event
  gets a correlation id (`#e1`, `#e2`, …) linking it to the actions it triggered.
- **action** — a dispatched action with resolved params and its outcome:
  - state actions (`setState`/`pushState`/`removeState`) show `path` /
    `previous` / `next` (a store-level diff at the target `statePath`);
  - `navigate`/`back`/`restart` show the navigation target;
  - `openUrl` shows the URL;
  - an action whose `$if` evaluated to false is shown as *skipped*;
  - invalid actions (unknown `navigate` target, `removeState` index out of range,
    unknown action) are shown as errors.
  Builtin-component state mutations (executed by the json-render library, not the
  custom-event runtime) are also captured as `setState` entries with an empty
  correlation id.
- **runtime-error** — payload validation failures, rejected store mutations
  (unsafe pointer, repeat render-cost budget), unknown navigate targets, etc.
- **font-status** — `document.fonts` status transitions per font family; the
  bottom section of the panel always shows the live status of every registered
  font (design-system `@font-face` injection).

## Where it lives

- `src/player/inspector/log.ts` — ring-buffer log model (`InspectorLog`) and the
  `InspectorLogger` contract.
- `src/player/inspector/InspectorPanel.tsx` — the panel UI.
- `src/player/actionRuntime.ts` / `src/player/easyUiRuntime.tsx` — optional
  logger decoration (no logger → behavior unchanged).
- Wiring: `src/player/PlayerShell.tsx` (`?debug=1`).
