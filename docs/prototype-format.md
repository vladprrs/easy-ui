# Prototype format v1

Prototype files live in `prototypes/*.json`. A file is a self-contained flow; its `id` must equal the filename without `.json`.

## Document and screens

The root is a strict object with `version: 1`, slug `id`, human-readable `name`, optional `description`, slug `designSystem` (default `"shadcn"`), `device` (`mobile`, `tablet`, or `desktop`, default `desktop`), slug `startScreen`, `state`, and a non-empty `screens` array. Screen IDs are unique slugs and `startScreen` must exist. The SQLite `design_systems` registry is the single source of registered systems; an unknown system is an error. `shadcn` and `wireframe` registry entries have code-backed builtin providers. A registry entry without a provider starts with no builtin definitions and can use published custom components assigned to it. The default remains `shadcn`, so existing documents without `designSystem` retain their meaning. Version 1 evolves additively: new fields are optional, so existing v1 documents remain valid.

Each screen has `id`, `name`, optional positive `{width,height}` `canvas`, optional non-blank `note` (at most 500 characters), optional `stateOverrides`, and `spec`. `note` is the author's caption below the screen in the CJM view. Screens appear in CJM in their `screens` array order. A spec contains only `root` and `elements`. An element contains only `type`, `props`, optional `children`, optional `visible`, optional `on`, and optional `repeat`. Its type and props must match the normalized definition in the document's selected design system. Unknown props, including keys in nested objects, are errors. Elements form one tree rooted at `root` (maximum 500 elements and depth 50).

### Per-system component allowlist

Component names are resolved only inside the selected system, plus published custom components assigned to that same system. Builtin allowlists are:

- `shadcn`: `Accordion`, `Alert`, `Avatar`, `Badge`, `Button`, `ButtonGroup`, `Card`, `Carousel`, `Checkbox`, `Collapsible`, `Dialog`, `Drawer`, `DropdownMenu`, `Grid`, `Heading`, `Hotspot`, `Image`, `Input`, `Link`, `Pagination`, `Popover`, `Progress`, `Radio`, `Select`, `Separator`, `Skeleton`, `Slider`, `Spinner`, `Stack`, `Switch`, `Table`, `Tabs`, `Text`, `Textarea`, `Toggle`, `ToggleGroup`, `Tooltip`.
- `wireframe`: `Box`, `Stack`, `Grid`, `Heading`, `Text`, `Image`, `Button`, `Input`, `Checkbox`, `Hotspot`, `Select`, `Card`.

The wireframe atomic classification from `src/designSystems/wireframe/definitions.ts` is:

- layout-neutral atoms: `Box`, `Stack`, `Grid`;
- atoms: `Heading`, `Text`, `Image`, `Button`, `Input`, `Checkbox`, `Hotspot`;
- molecule: `Select`;
- organism: `Card`.

### Atomic nesting warnings

Atomic levels rank from smallest to largest as `atom < molecule < organism < template < page`. During a tree walk, a child produces a warning when `rank(child) > rank(ancestor)`, where `ancestor` is the nearest non-layout-neutral ancestor with a level. Thus a larger unit nested inside a smaller unit is suspicious; equal levels are allowed. Layout-neutral components are transparent and do not replace the current ancestor. Components without an atomic level are skipped in the same way. These diagnostics point to the concrete element path and are warnings only: they do not block validation, saving, or playback.

`state` and every `stateOverrides` value are JSON-only: strings, finite JSON numbers, booleans, nulls, arrays, and objects. For a CJM tile, its effective initial state is a safe deep merge of document `state` with that screen's `stateOverrides`. Objects merge recursively; arrays replace the base array in full; scalars, `null`, and values of a different type replace the base value. An empty override object `{}` does not delete existing keys, and v1 has no deletion marker. The merge does not mutate its inputs.

The keys `__proto__`, `prototype`, and `constructor` are forbidden at every override depth. `currentScreen`, `navStack`, and `_viewer` are additionally forbidden as top-level override keys. Object nesting in an override is limited to 32 levels; a deeper object subtree is rejected by validation and is not inserted by the safe merge. JSON Pointer state paths are absolute RFC 6901 paths. `/currentScreen`, `/navStack`, and `/_viewer` are reserved. A `$state` path absent from that screen's effective state produces a warning.

Each CJM tile gets an isolated json-render state store. This does not isolate custom components' own local state or browser side effects such as portals, global listeners, or storage access.

## Dynamic values and conditions

Props may be literals or exactly one of these strict directives. A directive may be the value of an individual prop (including a nested value), but may not replace the entire `props` object.

- `{ "$state": "/path" }` reads state.
- `{ "$bindState": "/path" }` creates a two-way component binding.
- `{ "$template": "Hello ${/name}" }` interpolates paths into text.
- `{ "$cond": { "if": condition, "then": literal, "else": literal } }` selects a value.
- `{ "$asset": "asset_<sha256>" }` references a registered asset by content-address (see [Assets](#assets)); it resolves to `/api/assets/asset_<sha256>` and is valid as a URL prop value.

A condition is boolean, a truthiness check `{ "$state": "/path" }`, an item-field check `{ "$item": "field" }`, an index check `{ "$index": true }`, or one of those combined with at most one of `eq`, `neq`, `gt`, `gte`, `lt`, `lte` and optional `not: true`. Exactly one of `$state`, `$item`, `$index` is required. Operands of `eq` and `neq` are static literals; operands of `gt`, `gte`, `lt`, and `lte` must be static numbers. Recursive composition uses `{ "$and": [conditions...] }` or `{ "$or": [conditions...] }`. No other directive or operator is accepted.

`watch`, `$computed`, `confirm`, `onSuccess`, and `onError` are reserved and invalid in v1. Only bound values persist while navigating within a player session. Reload or deep-link entry creates fresh state from the document.

Builtin components emit payloadless events. **Custom components** may declare typed event payloads (a definition `events: Record<name, ZodSchema>` plus `capabilities.typedEvents`) that are delivered to actions through param sources (see [Events and actions](#events-and-actions)). Editable values on builtin components must still be read through `$bindState`.

## Repeat

An element may carry `repeat: { statePath, key? }` to render its `children` once per item in the state array at `statePath` (an absolute RFC 6901 JSON Pointer). The repeat element itself renders once, using the ambient (non-repeated) state and props; only its `children` subtree is repeated, each copy scoped to one array item. `key` names a field on each item used for shallow, per-item React identity (`String(item[key] ?? index)`); when omitted, the array index is the key. `key` does not affect validation beyond being a non-empty string.

Inside a repeat element's `children` subtree (and only there), props and conditions may additionally use:

- `{ "$item": "field" }` (props) or `{ "$item": "field", ...comparison }` (conditions) — reads a field from the current item; `""` addresses the whole item. The field path is a safe relative path (same segment rules as a JSON Pointer, without the leading `/`); `__proto__`, `prototype`, and `constructor` segments are rejected.
- `{ "$index": true }` (props) or `{ "$index": true, ...comparison }` (conditions) — the current array index.
- `{ "$bindItem": "field" }` (props only) — a two-way binding to a field on the current item.

Using `$item`, `$index`, or `$bindItem` outside a repeat subtree is a validation error. Native `$item` in action `params` (e.g. `setState`) resolves to a state *path*, not a value, and is out of scope for v1's static action-params grammar; it is not validated or documented further here.

**Limits** (all enforced by `npm run validate:prototypes` / `validatePrototype`):

- Nested `repeat` — a `repeat` element inside another `repeat` element's subtree — is a validation error. Only one level of repetition is supported in v1.
- At most 20 `repeat` elements per screen; exceeding this is a validation error.
- `Hotspot` inside a repeat subtree is a validation error (canvas-anchored hotspots cannot be templated per item).
- `repeat.statePath` must resolve to an array in the screen's effective initial state (`state` merged with `stateOverrides`); when it doesn't (missing or a non-array value), validation emits a warning — the array may be populated dynamically at runtime.
- **Render-cost budget**: `cost(el) = 1 + Σ cost(children)`, and for a repeat element, `cost(el) = 1 + len(initialArray) × Σ cost(children)`, computed recursively from the screen's effective initial state. A screen whose root cost exceeds 2000 is a validation error. This bounds the worst-case initial DOM size regardless of nesting depth or repeat count.

## Events and actions

An event name must be declared by its component definition. Its value is one action or a sequential array. Params contain static JSON literals only.

| Action | Params | Kind |
|---|---|---|
| `navigate` | `{screenId: slug}` | terminal, custom |
| `back` | `{}` | terminal, custom |
| `restart` | `{}` | terminal, custom |
| `openUrl` | `{url: http(s) URL}` | terminal, custom |
| `setState` | `{statePath, value}` | non-terminal, built-in |
| `pushState` | `{statePath, value, clearStatePath?}` | non-terminal, built-in |
| `removeState` | `{statePath, index}` | non-terminal, built-in |

There may be at most one terminal action per event, and it must be last. `navigate` targets an existing screen. `validateForm`, `push`, and `pop` are not v1 actions. A `Link` event that navigates must set `preventDefault: true` on its navigation action.

### Param sources and conditional actions (custom components only)

Params normally contain only static JSON literals. Inside an event binding of a **custom component**, the following **param sources** may additionally appear and are resolved to literals by the event adapter at dispatch time. They are dispatched by easy-ui's own adapter, so they are **only** valid on custom-component events — a builtin element that uses a param source or `$if` is a validation error (fail closed).

- `{ "$event": "/pointer" }` — a value read out of the event payload (an RFC 6901 JSON Pointer into the payload; `""` addresses the whole payload). Allowed only on an event whose definition declares a payload schema; a payloadless event with `$event` is an error. Valid inside `setState`/`pushState` `value` (and nested values), `removeState` `index`, and `navigate` `screenId`.
- `{ "$elementId": true }` — the id (element key) of the emitting element.
- `{ "$itemIndex": true }` — the current repeat index; only inside a repeat subtree.
- `{ "$itemKey": true }` — the current item's key field (`item[repeat.key]`); only inside a repeat subtree, and the nearest repeat must declare `repeat.key` (otherwise an error — there is no silent fallback to the index).

Param sources are **not** allowed in `statePath`, `clearStatePath`, or `openUrl.url` (URLs stay static for security). Native `$item` in params remains a state path and is out of scope.

A binding may also carry an optional `$if` **condition** (custom-only): a boolean, an `{ "$and": [...] }`/`{ "$or": [...] }` composition, or a `{ "$event": "/pointer" }` operand combined with at most one of `eq`/`neq` and optional `not: true` (truthiness when no comparison is given). When `$if` evaluates false the action is skipped; terminality rules are unchanged. `$event` in `$if` also requires a declared payload schema.

At runtime the adapter validates each payload against its declared Zod schema, then enforces that the payload is JSON-safe and free of `$`-prefixed keys; a failure drops the event without dispatching. `navigate` to an unknown screen and `removeState` with a non-integer/out-of-range index are no-ops (reported to the inspector).

## Canvas and URLs

`Hotspot` requires a canvas. Its `x`, `y`, `width`, and `height` are static numbers and its rectangle must fit within canvas bounds.

`openUrl.url` and `Link.href` are static `http:` or `https:` URLs. `Image.src` additionally permits an absolute relative path beginning with `/`. Dynamic URLs and `javascript:` or `data:` URLs are errors.

## Assets

A URL prop may reference a registered binary asset (image or font) by content-address: `{ "$asset": "asset_<sha256>" }`, where the id is `asset_` followed by the full 64-hex-character SHA-256. It resolves to `/api/assets/asset_<sha256>` when the runtime spec is built. Upload assets via `POST /api/assets` (see [server API](server-api.md#ассеты)); the id is returned in the upload response.

- `$asset` is a **prop directive only** — it is valid as (or nested inside) a prop value, including URL props (`Image.src`, `Link.href`). It is **not** allowed in action `params`: params accept static JSON literals only, so an `$asset` object there is a validation error.
- The id format is validated: `asset_` + 64 lowercase hex chars. A malformed id is a validation error.
- On save the server verifies every referenced asset exists (`422 asset_not_found` otherwise) and pins it to the revision; restoring an earlier revision copies its asset pins. Pinned asset bytes cannot be deleted while any revision references them.

## Author checklist

- Filename and document `id` match; every ID is a slug.
- `startScreen` and every `navigate` target exist; all intended screens are reachable.
- Every element belongs to exactly one rooted tree and stays within size/depth limits.
- Component props and events match the catalog; required props are present.
- `designSystem` is registered and every component belongs to its per-system allowlist.
- Atomic nesting warnings have been reviewed, even though they do not block validation.
- Directives, conditions, actions, and params use only the closed v1 grammar.
- State paths are valid, non-reserved JSON Pointers; bound initial values are in `state` where appropriate.
- Terminal actions are unique and last; navigating links prevent their default browser action.
- Hotspots fit their canvas and all URLs satisfy the static URL policy.
- Run `npm run validate:prototypes` before submitting.
