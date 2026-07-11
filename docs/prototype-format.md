# Prototype format v1

Prototype files live in `prototypes/*.json`. A file is a self-contained flow; its `id` must equal the filename without `.json`.

## Document and screens

The root is a strict object with `version: 1`, slug `id`, human-readable `name`, optional `description`, slug `designSystem` (default `"shadcn"`), `device` (`mobile`, `tablet`, or `desktop`, default `desktop`), slug `startScreen`, `state`, and a non-empty `screens` array. Screen IDs are unique slugs and `startScreen` must exist. Registered systems are defined by `src/designSystems/index.ts`; currently they are `shadcn` and `wireframe`. An unknown system is an error. Version 1 evolves additively: new fields are optional, so existing v1 documents remain valid.

Each screen has `id`, `name`, optional positive `{width,height}` `canvas`, optional non-blank `note` (at most 500 characters), optional `stateOverrides`, and `spec`. `note` is the author's caption below the screen in the CJM view. Screens appear in CJM in their `screens` array order. A spec contains only `root` and `elements`. An element contains only `type`, `props`, optional `children`, optional `visible`, and optional `on`. Its type and props must match the normalized definition in the document's selected design system. Unknown props, including keys in nested objects, are errors. Elements form one tree rooted at `root` (maximum 500 elements and depth 50).

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

A condition is boolean, a truthiness check `{ "$state": "/path" }`, or a state condition with at most one of `eq`, `neq`, `gt`, `gte`, `lt`, `lte` and optional `not: true`. Operands of `eq` and `neq` are static literals; operands of `gt`, `gte`, `lt`, and `lte` must be static numbers. Recursive composition uses `{ "$and": [conditions...] }` or `{ "$or": [conditions...] }`. No other directive or operator is accepted.

`repeat`, `watch`, `$computed`, `$item`, `$index`, `$bindItem`, `confirm`, `onSuccess`, and `onError` are reserved and invalid in v1. Events carry no payload; editable values must be read through `$bindState`. Only bound values persist while navigating within a player session. Reload or deep-link entry creates fresh state from the document.

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

## Canvas and URLs

`Hotspot` requires a canvas. Its `x`, `y`, `width`, and `height` are static numbers and its rectangle must fit within canvas bounds.

`openUrl.url` and `Link.href` are static `http:` or `https:` URLs. `Image.src` additionally permits an absolute relative path beginning with `/`. Dynamic URLs and `javascript:` or `data:` URLs are errors.

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
