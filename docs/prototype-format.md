# Prototype format v1

Prototype files live in `prototypes/*.json`. A file is a self-contained flow; its `id` must equal the filename without `.json`.

## Document and screens

The root is a strict object with `version: 1`, slug `id`, human-readable `name`, optional `description`, slug `designSystem` (default `"shadcn"`), `device` (`mobile`, `tablet`, or `desktop`, default `desktop`), slug `startScreen`, `state`, and a non-empty `screens` array. Screen IDs are unique slugs and `startScreen` must exist. The SQLite `design_systems` registry is the single source of registered systems; an unknown system is an error. `shadcn` and `wireframe` registry entries have code-backed builtin providers. A registry entry without a provider starts with no builtin definitions and can use published custom components assigned to it. The default remains `shadcn`, so existing documents without `designSystem` retain their meaning. Version 1 evolves additively: new fields are optional, so existing v1 documents remain valid.

Each screen has `id`, `name`, optional positive `{width,height}` `canvas`, optional non-blank `note` (at most 500 characters), optional `stateOverrides`, and `spec`. `note` is the author's caption below the screen in the CJM view. Screens appear in CJM in their `screens` array order. A spec contains only `root` and `elements`. An element contains only `type`, `props`, optional `children`, optional `visible`, optional `on`, optional `repeat`, and optional `slot`. Its type and props must match the normalized definition in the document's selected design system. Unknown props, including keys in nested objects, are errors. Elements form one tree rooted at `root` (maximum 500 elements and depth 50).

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

## Named slots

A child element may carry `slot: "<slug>"` to route it into a named region of its parent. Named slots exist **only for custom components** that opt in via `capabilities.namedSlots` and declare the region names in `definition.slots` (see `docs/server-api.md`). The parent component receives its children partitioned into `slots: Record<name, ReactNode>`; children without a `slot` field land in `slots.default`, and for a named-slot component `children === slots.default`. Slot routing is resolved before render from each child's position in the parent's `children` array — there are no DOM markers.

**Rules** (enforced by `validatePrototype`):

- `slot` is allowed only on a child whose parent is a custom component with `capabilities.namedSlots`; a `slot` under a builtin parent, or under a custom parent without that capability, is a validation error.
- The `slot` value must be one of the parent's declared `definition.slots`; an unknown name is a validation error.
- `repeat` on a custom component with named slots is a validation error: a repeated element hands the library a single repeated-children node, so positional slot routing does not apply. `repeat` is allowed on a child *inside* a slot.
- Legacy custom components (without `capabilities.namedSlots`) receive their children unchanged, exactly as before.

## Spacing & layout contract v1

Layout-aware component definitions use the standard spacing props `gap`, `padding`, `paddingX`, and `paddingY`. Each declared prop is an enum over all or part of the canonical token scale:

`none | xs | sm | md | lg | xl | 2xl | 3xl | 4xl`

The concrete pixel value is resolved by the selected design system and pinned theme. `none` always means zero. Omitting a spacing prop preserves that component's own default; omission is not equivalent to `none`.

The normative prop semantics are:

- `padding` applies to all four sides.
- `paddingX` applies to the logical inline axis and overrides `padding` on that axis.
- `paddingY` applies to the logical block axis and overrides `padding` on that axis.
- `gap` is the space between children in `flow.slot`, along the direction selected by `flow.direction`.

All axes are logical axes, so inline/block behavior follows writing direction. Components advertise support through additive definition metadata:

```ts
layout?: {
  version: 1;
  spacing?: ("gap" | "padding" | "paddingX" | "paddingY")[];
  spacer?: true;
  flow?: {
    kind: "flex";
    direction:
      | "vertical"
      | "horizontal"
      | {
          prop: string;
          vertical: (string | number | boolean | null)[];
          horizontal: (string | number | boolean | null)[];
          none?: (string | number | boolean | null)[];
        };
    wrap?: { prop: string; enabled: (string | number | boolean | null)[] };
    slot?: string; // defaults to "default"
  };
};
```

`spacing` names the supported standard props. `spacer: true` identifies a dedicated spacer element and cannot be combined with spacing props or slots. `flow` describes a flex flow whose `gap` applies to its selected slot; a static direction can be declared directly, while a prop-driven direction maps accepted prop values to vertical, horizontal, or no-flow domains. Unmapped or dynamic values have unknown direction rather than an inferred one.

## `className` advisory policy

`className` remains a best-effort escape hatch, not a layout contract. A Tailwind utility named in a prototype is not guaranteed to exist in the compiled CSS. Do not use `className` to position elements or to create spacing between siblings; use component `gap`/padding props or the `Overlay` host primitive instead.

Static class strings are inspected by the non-blocking `layout/classname-positioning` lint. Position utilities, `relative`, inset utilities (including variant-prefixed forms), arbitrary z-index values, and margin utilities produce a warning. Directive-valued or otherwise dynamic class names are not statically inspected. The warning is advisory and never blocks save or playback.

## Overlay host primitive

`Overlay` is a host primitive available to every registered design system through the separate `hostPrimitives` discovery section. It is not a builtin or custom component, is never included in `components`, component pins, or the component manifest, and reserves the component name `Overlay`.

Its grammar is:

```json
{
  "type": "Overlay",
  "props": {
    "placement": "top | bottom | center | top-left | top-right | bottom-left | bottom-right",
    "inset": "none | xs | sm | md | lg | xl | 2xl | 3xl | 4xl",
    "scrim": false
  },
  "children": ["overlay-content"]
}
```

`placement` is required. `inset` defaults to `md` and is resolved through the selected design system's pinned spacing scale. `scrim` defaults to `false`. `top` and `bottom` stretch across the StageViewport minus the horizontal inset; `center` and the four corner placements shrink to fit, up to the available width. The default slot is the only slot. The primitive has atomic level `atom` and is layout-neutral.

An Overlay is viewport-sticky: it is anchored to the native-coordinate `StageViewport`, inside the same transform chain as screen content, and does not move relative to that viewport when a `ContentScroller` scrolls. Its inset is applied before preview transforms, so it scales with the content. It may contain normal builtin, host-independent custom, or repeated content. Anchoring to an element or to scrolling content is not supported in v1.

The placement rules are structural and enforced during validation:

- Overlay must be a direct child of the screen root. It is not allowed below `repeat`, `Hotspot`, or another Overlay; `Hotspot` is not allowed inside Overlay.
- More than one root Overlay is allowed; document order is stacking order.
- On a canvas screen Overlay is the third ordered canvas layer: content, then hotspots, then overlays.
- On a desktop screen without `canvas`, Overlay is invalid because the desktop flow viewport has automatic height and no normative bottom anchor. Mobile/tablet flow and canvas screens on every device are supported. The player also disables and resets a desktop preview override that would bypass this rule.
- `scrim: true` adds a full-StageViewport, `aria-hidden` backdrop below the Overlay content and blocks pointer events through it. Without a scrim, only Overlay content receives pointer events. Drawer and Dialog remain the primitives for modal interaction.

### Overlay surface truth table

The four relevant boxes are distinct: `ClipViewport` provides outer clipping or preview scrolling; `StageViewport` is the native-coordinate Overlay anchor; `ContentScroller` owns content scrolling; and the Overlay portal root is mounted into the StageViewport supplied by each surface. No wrapper is inserted around legacy flow content.

| # | Surface | StageViewport (DOM node) | Width / height | ContentScroller | Overflow | Capture behavior | Overlay after scrolling |
|---|---|---|---|---|---|---|---|
| 1 | Player, mobile/tablet flow | Transformed native div in `DeviceFrame` | 390×844 / 834×1112 | Outer `DeviceFrame` page scroller; no in-stage content scroller | Frame card clips | Not a capture surface | Fixed to stage edges; moves with the whole stage during page scroll |
| 2 | Player, canvas (any device) | Same transformed native div; `CanvasLayers` uses the same box | `canvas.width` × `canvas.height` | Outer `DeviceFrame` scroller | Frame card clips | — | Third `CanvasLayers` layer above hotspots; moves with canvas |
| 3 | Player, desktop flow without canvas | **Forbidden by validation**; desktop preview control is disabled and an existing override is reset | — | — | — | — | — |
| 4 | Present | The same `DeviceFrame` nodes as rows 1–2; uses `doc.device` with no preview override | As rows 1–2 | `DeviceFrame` scroller | As row 1 | — | As rows 1–2 |
| 5 | Capture, mobile/tablet flow | Native `#eui-capture-surface`, without transform | Canonical device viewport | No in-surface scroller | No surface overflow rule | Worker captures this element; Overlay remains inside its bounds | Fixed to capture-surface edges; excess content does not move it |
| 6 | Capture, canvas | `#eui-capture-surface` is the canvas box | `canvas.width` × `canvas.height` | None | None | As row 5 | Third `CanvasLayers` layer |
| 7 | Capture, desktop flow | **Forbidden by validation**; the auto-height surface has no normative bottom anchor | — | — | — | Such a document cannot be saved for capture | — |
| 8 | Editor, main canvas | Transformed `div[data-eui-stage-viewport="editor"]` | Native width; canvas or measured auto height | Outer editor section | Stage viewport clips | — | Portal child in the transformed stage; inset scales; the inert stage and Overlay move together |
| 9 | Editor screen strip | Transformed `div[data-eui-stage-viewport="editor-strip"]` | Native width; preview height capped at 180 | Horizontal strip list | Tile clips | — | Same transform/inert behavior as row 8; bottom Overlay may be clipped in the fidelity thumbnail |
| 10 | CJM tile | Transformed `div[data-eui-stage-viewport="cjm"]` | Native width; device-specific capped height | CJM stage/list scrollers | Frame clips | — | Portal remains inside the transformed inert stage |
| 11 | Gallery preview | Inner transformed `div[data-eui-stage-viewport="gallery"]` inside the gallery scale transform | Native width; effective scale is device scale × gallery scale; height capped at 200 | None | Outer preview clips | — | Static inert preview; Overlay shares both transforms with content |
| 12 | Storybook | For specs with Overlay only, relative `div[data-eui-stage-viewport="story"]`; other stories keep the bare Renderer path | 390×844 | Storybook canvas | Host box does not add clipping or scrolling | — | Anchored inside the fixed story host box |
| 13 | Tablet canvas | Uses the corresponding canvas nodes from rows 2, 6, and 8–11; tablet does not create a separate branch | Canvas dimensions | As corresponding surface | As corresponding surface | As corresponding surface | As corresponding canvas surface |

Across all supported surfaces, `stageHostRef` points to the StageViewport or a direct relative container with identical geometry. Overlay stays in the stage's native coordinate system and inert subtree where applicable. The split order is host primitives before canvas; presentation trees use the split results, while action runtime evaluates the original complete spec. The story host is created only for specs containing Overlay.

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

## Semantic warnings

Beyond the structural errors above, `validatePrototype` emits **warnings** — advisory diagnostics that never block validation, saving, or playback (like the atomic-nesting warnings). They point at likely authoring mistakes that the JSON grammar alone cannot catch. Existing hard errors are unchanged; these are strictly additive.

Warnings draw on optional **definition metadata**. Custom components declare it on their definition (`interactive?: boolean`, `accessibleLabelProps?: string[]`, `urlProps?: string[]`; serialized additively into the component's `DefinitionMeta`). Builtin components get the same metadata from a static table (`src/catalog/builtinSemantics.ts`), derived from their real prop schemas: interactive controls are `Button`, `Link`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`, `Toggle`, `ToggleGroup`, `Tabs`, `DropdownMenu`, `ButtonGroup`, `Pagination`, and `Hotspot`; `accessibleLabelProps` is `["label"]` (or `["ariaLabel"]` for `Hotspot`) where the schema has one; `urlProps` is `["src"]` for `Image`/`Avatar` and `["href"]` for `Link`.

The warnings are:

- **Interactive element with no handler and no binding** — an interactive element with neither an `on` handler nor any `$bindState`/`$bindItem` prop does nothing in the flow. **Self-driven** controls (`Tabs`, `DropdownMenu`, `ToggleGroup`, `ButtonGroup`, `Pagination`, `Link`) manage their own internal UI state (or navigate via `href`) and are exempt.
- **Interactive element without an accessible label** — an interactive element whose `accessibleLabelProps` are all blank/unset and which has no text-bearing child (`text`/`label`/`title`). A dynamic value (`$state`/`$template`/`$bindState`) counts as a provided label.
- **Repeated element reads `$event` from a payload without item identity** — inside a `repeat` subtree, an event that binds `$event` while its declared payload schema has none of the identity fields `itemId`, `id`, `key`, `value` cannot tell which item was acted on.
- **Large inline base64** — any string prop longer than 100 KB that is a `data:` URL or bare base64 should be uploaded as an asset (`$asset`) instead. (A `data:` URL in `Image.src`/`Link.href` remains a hard error; this warning covers every other string prop.)
- **Multiple screens with no inter-screen navigation** — two or more screens but no `navigate` action targeting a *different* screen (`back`/`restart`/`openUrl` do not count) suggests disconnected screens.
- **Monolithic screen** — a screen whose sole element is a single custom `organism`/`page` component with no children likely reconstructs a page in one component instead of composing it from design-system elements.
- **URL prop with a non-public local path** — a `urlProps` value that begins with `/` but not with a runtime-served public prefix (`/api/assets/`, `/design/`, `/fonts/`, `/images/`) may be unavailable to the player runtime.

## Author checklist

- Filename and document `id` match; every ID is a slug.
- `startScreen` and every `navigate` target exist; all intended screens are reachable.
- Every element belongs to exactly one rooted tree and stays within size/depth limits.
- Component props and events match the catalog; required props are present.
- `designSystem` is registered and every component belongs to its per-system allowlist.
- Atomic nesting warnings have been reviewed, even though they do not block validation.
- Semantic warnings (interactive handlers/labels, item identity, inline base64, screen connectivity, monolithic screens, local URL paths) have been reviewed.
- Directives, conditions, actions, and params use only the closed v1 grammar.
- State paths are valid, non-reserved JSON Pointers; bound initial values are in `state` where appropriate.
- Terminal actions are unique and last; navigating links prevent their default browser action.
- Hotspots fit their canvas and all URLs satisfy the static URL policy.
- Run `npm run validate:prototypes` before submitting.
