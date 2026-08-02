# Prototype format v1

Prototype files live in `prototypes/*.json`. A file is a self-contained flow; its `id` must equal the filename without `.json`.

## Document and screens

The root is a strict object with `version: 1`, slug `id`, human-readable `name`, optional `description`, slug `designSystem` (default `"shadcn"`), `device` (`mobile`, `tablet`, or `desktop`, default `desktop`), slug `startScreen`, `state`, a non-empty `screens` array, and the optional additive fields `flows`, `computed` (see [Computed values](#computed-values)), and `architecture` (see [Architecture warnings](#architecture-warnings)). Screen IDs are unique slugs and `startScreen` must exist. The SQLite `design_systems` registry is the single source of registered systems; an unknown system is an error. `shadcn` and `wireframe` registry entries have code-backed builtin providers. A registry entry without a provider starts with no builtin definitions and can use published custom components assigned to it. The default remains `shadcn`, so existing documents without `designSystem` retain their meaning. Version 1 evolves additively: new fields are optional, so existing v1 documents remain valid.

Each screen has `id`, `name`, optional positive `{width,height}` `canvas`, optional non-blank `note` (at most 500 characters), optional `stateOverrides`, and `spec`. `note` is the author's caption below the screen in the CJM view. Screens appear in CJM in their `screens` array order. A spec contains only `root` and `elements`. An element contains only `type`, `props`, optional `children`, optional `visible`, optional `on`, optional `repeat`, optional `slot`, and optional `region`. Its type and props must match the normalized definition in the document's selected design system. Unknown props, including keys in nested objects, are errors. Elements form one tree rooted at `root` (maximum 500 elements and depth 50).

**Element keys in an authored document must not contain `$`.** The character is reserved as the separator of expanded composition keys (`<hostKey>$<innerKey>`) and is rejected by `inputPrototypeDocSchema` — see [Versioned compositions](#versioned-compositions). The tolerant parser used for already stored rows (`storedPrototypeDocSchema`) does not apply that restriction, so existing revisions and expanded documents keep reading.

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

Derived numbers are not stored in `state`: the optional top-level `computed` field declares them, and they read like ordinary state through `{ "$state": "/key" }` or `${/key}` (see [Computed values](#computed-values)). A computed key may not collide with a top-level `state` key or be re-declared by a screen's `stateOverrides`, and no action or binding may write to it.

Each CJM tile gets an isolated json-render state store. This does not isolate custom components' own local state or browser side effects such as portals, global listeners, or storage access.

## Flows (scenario lanes)

The optional `flows` field annotates full end-to-end scenarios over the prototype's `navigate` graph. It is additive to format v1 and does not change runtime behavior: only actions define navigation, while flows provide authored scenario lanes for CJM and guided browsing in the player. During guided browsing, a selected screen opens in the current player session state. Intermediate actions are not executed, and guided browsing does not apply the destination screen's `stateOverrides`.

Each flow has a slug `id`, a non-empty `name` of at most 120 characters, an optional `description` of at most 500 characters, an optional slug `parentId` (see [Scenario tree](#scenario-tree-flowparentid)), and one or more `steps`. A step contains a screen `screenId` and may contain a trimmed, non-blank `note` of at most 500 characters. `flows[0]` is the canonical main scenario and must be a root flow. Its first step must be `startScreen`, and its screen IDs must be unique.

A step whose screen occurs in the main flow is an anchor. Two adjacent anchors **in a root flow** are valid only when they are adjacent in the main flow in the same forward direction; shortcuts and direct backward anchor-to-anchor pairs are errors. Authors must insert an intermediate non-anchor screen or change the main flow. Child flows are exempt from this rule (see [Scenario tree](#scenario-tree-flowparentid)). Equal adjacent steps are forbidden in every flow. Other repeated screens, including repeated non-anchor screens used for retry loops and backward returns through their own tiles, are allowed. Branch-from-branch and convergence between branches are not represented specially in v1: a screen belonging to another branch remains that flow's own tile.

Limits are 24 flows, 50 steps per flow, 320 steps across all flows, and a nesting depth of 4. An explicitly empty `flows` array is invalid; omit the field when scenarios are not authored. Every flow ID is unique and every step references an existing screen.

Flow diagnostics are warnings, not errors, when a **root** flow has only one step, or when no static or dynamic `navigate` action can connect a step of a **root** flow to its predecessor. Static navigation is recognized even under an action `$if`. A dynamic `screenId` makes the edge unverifiable and suppresses the missing-edge warning for that source; it does not create a graph edge. `back`, `restart`, and dynamic targets are not part of the statically inferred navigate graph.

### Scenario tree (`flow.parentId`)

A flow may declare `parentId` — the `id` of another flow — which makes it a **child flow**. Child flows form the scenario tree: a short main line with detail uncovered by nested scenarios, instead of one flat list.

The two kinds of flow are deliberately asymmetric:

- a **root flow** (no `parentId`) is a lane: a connected walk over the `navigate` graph. Root flows are what CJM lane geometry is built from;
- a **child flow** is an ordered **selection** of screens, not a connected chain. It gets no lane of its own. Screens are reused between flows; a flow never copies a screen, and a screen assigned to a child flow still counts as covered.

Rules (enforced on authored input only — stored revisions are parsed without them, so rolling the image back keeps reading documents that already use the tree):

- `parentId` must reference an existing flow;
- **the parent must be declared before the child in the `flows` array.** This is the only normative ordering rule. Acyclicity follows from it by construction (a parent always has a smaller index), and depth can be computed in one pass — so there are no separate cycle or self-reference checks, and a self-reference is simply an ordering violation;
- nesting depth is at most 4, where **a root flow is level 1**. The value is published as `limits.flowDepth` by `GET /api/capabilities`;
- `flows[0]` must be a root flow.

**What a child flow is exempt from.** Because it is a selection rather than a lane, three diagnostics do not apply to it:

| rule | severity | why it is lifted |
|---|---|---|
| adjacent main-flow anchors must be consecutive | error | the rule exists to keep lane geometry expressible, and a child flow has no lane |
| flow step is not connected to the previous step by a navigate action | warning | a selection is not required to be a connected chain of edges |
| flow has a single step | warning | a one-screen leaf is the canonical bottom of the tree |

A fourth rule — *flow step note on a main-flow anchor is not displayed* — was removed entirely (it is no longer emitted for any flow): the «Сценарии» view renders anchor steps with their own tiles, so anchor notes are displayed. In the lanes view (`?view=lanes`) such a note still has no tile to sit on; that is an accepted imprecision.

**Accepted trade-off.** `parentId` therefore doubles as the way to legalize a slice such as `[main-A, main-D]`: it bypasses the anchor-adjacency error *and* removes the flow from lanes in one move. This is a deliberate compromise — a child flow genuinely is a slice — but it means `parentId` must not be used merely to silence a diagnostic on a flow that is meant to be a lane. A scenario that should read as a walk stays a root flow.

**Authoring recipe.** The zeroth array element is untouchable: it is the main scenario, and lane geometry is built around it. Never move it away from index 0 and never give it a `parentId`. Add children by **inserting them right after their parent**, so the array stays a valid pre-order:

```json
"flows": [
  { "id": "main-line", "name": "Главная линия",            "steps": [{ "screenId": "home" }, { "screenId": "transfers" }] },
  { "id": "payments",  "name": "Переводы и платежи",       "parentId": "main-line", "steps": [{ "screenId": "transfers" }, { "screenId": "by-phone" }] },
  { "id": "by-phone",  "name": "Перевод по телефону",      "parentId": "payments",  "steps": [{ "screenId": "by-phone" }, { "screenId": "amount" }] },
  { "id": "receipt",   "name": "Квитанция о переводе",     "parentId": "by-phone",  "steps": [{ "screenId": "receipt" }] }
]
```

Depths here are 1 → 2 → 3 → 4; a fifth level is an error. A worked three-level document, including a one-step leaf and a child flow with a connectivity gap, is `test/fixtures/flows-tree.json`.

## Dynamic values and conditions

Props may be literals or exactly one of these strict directives. A directive may be the value of an individual prop (including a nested value), but may not replace the entire `props` object.

- `{ "$state": "/path" }` reads state.
- `{ "$bindState": "/path" }` creates a two-way component binding.
- `{ "$template": "Hello ${/name}" }` interpolates paths into text.
- `{ "$cond": { "if": condition, "then": literal, "else": literal } }` selects a value.
- `{ "$asset": "asset_<sha256>" }` references a registered asset by content-address (see [Assets](#assets)); it resolves to `/api/assets/asset_<sha256>` and is valid as a URL prop value.

A condition is boolean, a truthiness check `{ "$state": "/path" }`, an item-field check `{ "$item": "field" }`, an index check `{ "$index": true }`, or one of those combined with at most one of `eq`, `neq`, `gt`, `gte`, `lt`, `lte` and optional `not: true`. Exactly one of `$state`, `$item`, `$index` is required. Operands of `eq` and `neq` are static literals; operands of `gt`, `gte`, `lt`, and `lte` must be static numbers. Recursive composition uses `{ "$and": [conditions...] }` or `{ "$or": [conditions...] }`. No other directive or operator is accepted.

`watch`, `$computed`, `confirm`, `onSuccess`, and `onError` are reserved and invalid in v1. The reservation of `$computed` is about the **prop directive**: derived values are declared in the top-level `computed` field and read through `$state`/`$template`, so no `$computed` directive exists in a prop position (see [Computed values](#computed-values)). Only bound values persist while navigating within a player session. Reload or deep-link entry creates fresh state from the document.

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

## Computed values

The optional top-level `computed` field declares **read-only derived numbers** over the document state: a counter, a sum of a field, a sum of products, and a total assembled from earlier terms. It is additive to format v1; a document without the field keeps its exact meaning.

```json
"state": { "cart": [], "shippingFee": 300 },
"computed": {
  "cartCount":    { "op": "count",      "from": "/cart" },
  "cartUnits":    { "op": "sum",        "from": "/cart", "field": "qty" },
  "cartSubtotal": { "op": "sumProduct", "from": "/cart", "fields": ["price", "qty"] },
  "cartTotal":    { "op": "add",        "terms": ["/cartSubtotal", "/shippingFee", -500] }
}
```

**Keys are bare**, exactly like `state` keys: `cartTotal`, not `/cartTotal`. A key matches `^[A-Za-z][A-Za-z0-9_-]*$` — the leading letter rules out `__proto__`, `_viewer`, and pointer-escape games by construction. Values are read like any other state: `{ "$state": "/cartTotal" }`, `{ "$template": "Итого: ${/cartTotal} ₽" }`, or a condition such as `{ "$state": "/cartCount", "gt": 0 }`. A recomputation happens inside the store's write funnel, so every listener sees state and computed values in the same atomic snapshot. A worked document is `test/fixtures/cart-computed.json`.

### Operations (closed set in v1)

| `op` | fields | meaning |
|---|---|---|
| `count` | `from` | length of the array at `from` |
| `sum` | `from`, optional `field` | sum of `field` over the items; without `field` the item itself is the addend (the mirror of `{"$item": ""}`) |
| `sumProduct` | `from`, `fields` (2–4) | sum over items of the product of the named fields |
| `add` | `terms` (2–8) | sum of terms; a term is an absolute JSON Pointer (into plain state **or** to an earlier computed key) or a numeric literal — a negative literal expresses a discount |

`from` is an absolute RFC 6901 pointer; `field` / `fields[i]` are safe relative field paths (the same segment rules as a pointer, without the leading `/`; `__proto__`, `prototype`, and `constructor` are rejected).

### Numeric semantics

Deterministic and deliberately quiet — nothing throws and nothing is coerced:

- a non-array value at `from` yields `0`;
- an item field is read with the relative-path reader and counts only when it is a finite number; otherwise that item contributes `0`;
- in `sumProduct` **any** missing or non-numeric field zeroes the whole item (it is not treated as `×1`);
- a non-finite `add` term contributes `0`;
- the final accumulator is `Number.isFinite(total) ? total : 0`;
- there is **no rounding and no string coercion**.

**Money must be authored in whole units** — integer minor units (kopecks) or integer roubles — because values are IEEE-754 doubles: `1999.99 × 3` is `5999.969999999999`, and that is exactly what a screenshot would show. Formatting (separators, currency signs) belongs in the surrounding text, e.g. `{ "$template": "Итого: ${/cartTotal} ₽" }`.

### Order and references

Entries are evaluated **in key order**. Each entry sees plain state plus the values computed before it, so an `add` term may point only at a computed key **declared earlier**; a forward reference or a self-reference is a validation error. Acyclicity therefore holds by construction — the same canon as `flow.parentId` — and there is no cycle detection. `from` may never point at or into a computed value.

### Collisions and read-only rules

- a computed key that equals a top-level `state` key is an error, as is a key equal to `currentScreen`, `navStack`, or `_viewer`;
- a screen's `stateOverrides` may not use a computed key;
- **computed values are read-only.** `setState`, `pushState`, and `removeState` (`statePath` as well as `clearStatePath`) and `$bindState` targeting a computed path are validation errors; at runtime the store rejects such a write and the player reports it once in the inspector instead of mutating state;
- `repeat.statePath` pointing at a computed value is an error (a computed value is a number and never becomes an array); the usual "may be populated dynamically" warning is suppressed for it.

A warning — not an error — is emitted when `from` does not resolve to an array in the document's initial `state`: the array may legitimately be filled at runtime.

### Limits and non-goals

At most **20** entries per document, **4** fields in `sumProduct`, **8** terms in `add`. The limits and the operation list are published by `GET /api/capabilities` (`limits.computedEntries|computedFields|computedTerms`, `features.computed`, `computedOps`).

Authoring limits are enforced by the input schema; already stored revisions are parsed tolerantly, so a document written by a newer build keeps reading. **Importing a bundle re-parses the document with the authoring schema**, so a bundle whose document exceeds the authoring limits is rejected on import (the same class of behaviour as `flows`).

**Non-goal in v1: per-row arithmetic.** `computed` produces document-level numbers only; a line such as "price × qty" inside a repeated row is not expressible — that would need arithmetic over `$item`, a different mechanism. Author per-row display strings as item fields instead.

## Named slots

A child element may carry `slot: "<slug>"` to route it into a named region of its parent. Named slots exist **only for custom components** that opt in via `capabilities.namedSlots` and declare the region names in `definition.slots` (see `docs/server-api.md`). The parent component receives its children partitioned into `slots: Record<name, ReactNode>`; children without a `slot` field land in `slots.default`, and for a named-slot component `children === slots.default`. Slot routing is resolved before render from each child's position in the parent's `children` array — there are no DOM markers.

**Rules** (enforced by `validatePrototype`):

- `slot` is allowed only on a child whose parent is a custom component with `capabilities.namedSlots`; a `slot` under a builtin parent, or under a custom parent without that capability, is a validation error.
- The `slot` value must be one of the parent's declared `definition.slots`; an unknown name is a validation error.
- `repeat` on a custom component with named slots is a validation error: a repeated element hands the library a single repeated-children node, so positional slot routing does not apply. `repeat` is allowed on a child *inside* a slot.
- Legacy custom components (without `capabilities.namedSlots`) receive their children unchanged, exactly as before.

## Versioned compositions

A **composition** is a versioned declarative fragment of a screen with parameters and named slots. It is a separate server resource with its own revisions and immutable published versions (see [server API](server-api.md#endpoints-композиций)); a prototype references it through two host-owned primitives.

`@eui/Composition` — a reference to a composition inside a screen:

```json
{
  "type": "@eui/Composition",
  "props": {
    "composition": "ctyp-payment-success",
    "params": { "accrual-amount": "12 ₽" }
  },
  "children": ["nav", "merchant", "offer"]
}
```

`composition` is the slug id of a published composition; `params` carries values for its declared parameters. The element's children are routed into the composition's slots: `@eui/Composition` is a valid named-slot parent, but its slot names come from the referenced **composition document**, not from `definition.slots`. A child without `slot` lands in the `default` slot. `repeat` on a composition reference is an error.

`@eui/Slot` — the insertion point for slotted children. It is valid **only inside a composition document**; an `@eui/Slot` element in a screen is a validation error.

Both names are host-owned: they are reserved from component publication, are served through the `hostPrimitives` discovery section of every design system, and never appear in `components`, component pins, or the component manifest.

### Composition document v1

```json
{
  "version": 1,
  "name": "CtypPaymentSuccessComposition",
  "description": "…",
  "params": {
    "accrual-amount": { "type": "string", "required": true, "description": "…" }
  },
  "slots": ["nav", "merchant", "accrual", "offer", "payment-method", "footer"],
  "spec": {
    "root": "shell",
    "elements": {
      "shell": { "type": "CtypSuccessShell", "props": { "tone": "success" }, "children": ["nav", "merchant", "badge", "footer"] },
      "nav": { "type": "@eui/Slot", "props": { "name": "nav" } },
      "merchant": { "type": "@eui/Slot", "props": { "name": "merchant" } },
      "badge": { "type": "CtypAccrualBadge", "props": { "amount": { "$param": "accrual-amount" } } },
      "footer": { "type": "@eui/Slot", "props": { "name": "footer" } }
    }
  },
  "provenance": { "source": "…", "figmaNodeId": "…" }
}
```

The root object is strict: `version: 1`, `name` (1–120 characters), optional `description` (≤500), `params` (default `{}`), `slots` (default `[]`), `spec`, and optional `provenance` with optional `source`/`figmaNodeId` (≤500/≤200). Slot names are unique slugs. A parameter declares `type` ∈ `string | number | boolean | json | asset` plus optional `required`, `default` (a JSON value) and `description` (≤300). Limits are 50 params, 20 slots and 300 elements. Elements use exactly the same grammar as screen elements, and their keys carry the same no-`$` restriction.

**Parameters substitute props only.** A prop value (at any nesting depth) may be the strict directive `{ "$param": "name" }`; it is replaced at expansion by the value supplied by the referencing element, or by the parameter's `default`. An optional parameter with neither value nor default removes that props key entirely. Parameters never produce state pointers: `on` handlers and `$state`/`$bindState` inside a composition address the **host prototype's** `doc.state` exactly as they would on a normal screen.

The reference itself is checked at expansion: an unknown parameter name in `props.params`, a missing `required` parameter, a value whose type does not match the declaration (`asset` expects `{"$asset":"asset_<sha256>"}`, `json` accepts anything), a `$param` naming an undeclared parameter, or a child routed into a slot the composition does not declare are all errors.

### Composition document v2

`compositionDocSchema` is a discriminated union over `version`: `1` (frozen, non-nesting) and `2`. A v2 document keeps every v1 field and adds Atomic Design metadata plus the right to nest:

```json
{
  "version": 2,
  "name": "PaymentMethodPicker",
  "atomicLevel": "organism",
  "scope": "section",
  "canonicalFor": ["payment-method-picker"],
  "ownership": { "reason": "…", "provenance": "…" },
  "replacement": "yp-payment-picker",
  "params": { "title": { "type": "string" } },
  "slots": ["footer"],
  "spec": {
    "root": "list",
    "elements": {
      "list": { "type": "YpBox", "props": {}, "children": ["row"] },
      "row": { "type": "@eui/Composition", "props": { "composition": "payment-method-row", "params": { "label": { "$param": "title" } } } }
    }
  }
}
```

- `atomicLevel` ∈ `molecule | organism | template | page` — **required** in v2; `scope` ∈ `section | shell | screen` is optional. Both mirror the component `definition` fields, so audit and Library treat a composition and a component as the same kind of catalog artifact.
- `canonicalFor` follows the same role uniqueness policy as components (see [canonical roles](canonical-roles.md)); `ownership.reason` (≤500) explains irreducibility; `replacement` names the artifact that supersedes this one.
- Everything else — `params`, `slots`, `spec`, `provenance`, the 50/20/300 limits, the no-`region`, no-`@eui/FlowRoot`, slot-matching and single-parent rules — is identical to v1.

**Nesting.** A v2 spec may contain `@eui/Composition`. Each nested reference must resolve to a published composition of the **same active design system**; the published dependency graph must be acyclic; the nesting depth is at most **5**, counting the outer composition (`COMPOSITION_DEPTH_LIMIT`, reported as `limits.compositionDepth` in `GET /api/capabilities`). A cycle is reported with its full path, e.g. `checkout-page@2 → payment-picker@4 → payment-row@3 → checkout-page@2`. The fully expanded tree still has to satisfy the per-screen budgets: 500 elements (`EXPANDED_ELEMENTS_LIMIT`) and tree depth 50 (`EXPANDED_TREE_DEPTH_LIMIT`).

`@eui/Slot` and `$param` keep their semantics at every level: a nested composition receives its parameters from the `props.params` of the referencing element (which may itself be a `$param` of the outer composition), and children routed into an outer slot travel through the nested slot they were addressed to. A v1 document referenced from a v2 parent keeps v1 behaviour — its own document is still rejected if it nests.

**Origins are reversible through every layer.** Expanded keys stay `<hostKey>$<innerKey>` at each level (`checkout$picker$row$label`), and `expandedFrom[key]` carries the flat v1 fields (`compositionId`, `hostKey`, `innerKey`) plus `chain: Array<{compositionId, version, hostKey, innerKey}>` describing every layer from the screen down.

### v1 restrictions

`compositionDocSchema` enforces all of the following for a **v1** document (v2 lifts only the nesting rule):

- **No `region` markers.** A composition never carries `statusBar`/`header`/`footer` markers. Regions stay authored on the screen: `analyzeScreenRegions` works on the **authored** screen spec, and a `region` on the `@eui/Composition` element itself is carried onto the root of the expanded composition — so a composition can still fill a region, but only as marked by the screen that references it.
- **No `@eui/FlowRoot`** — it is the screen root only.
- **No nesting**: an `@eui/Composition` element inside a composition document is rejected in v1.
- `@eui/Slot` cannot be the composition root and cannot declare `children`.
- Every declared slot needs exactly one matching `@eui/Slot` element (a `@eui/Slot` whose `name` is not declared, a duplicate slot element, or a declared slot without an element are errors); `name` must be a static string.
- The `root` must reference an existing element, must not itself be a child, and every element has at most one parent; unknown children are errors.

### Expansion and element keys

Before rendering, every `@eui/Composition` element is replaced by the composition's elements:

- inner keys are prefixed: an inner element `badge` inside host element `screen` becomes **`screen$badge`**;
- `{ "$param": … }` directives are substituted as described above;
- the host element's children are routed to the `@eui/Slot` matching their `slot`; the `@eui/Slot` elements themselves disappear, the routed children are reparented to the slot's parent, and each routed child's own `slot` field is replaced by the placement of the `@eui/Slot` element (or dropped when it had none);
- the host element disappears and is replaced in its parent (or as `spec.root`) by the root of the expanded composition; the host element's `region`, `visible` and `slot` move onto that root, so region markers and named-slot placement keep working.

The key contract is **load-bearing**: expanded keys are `<hostKey>$<innerKey>`, and `$` is therefore rejected in authored element keys by `inputPrototypeDocSchema`, which makes collisions impossible by construction. Keys flow into `__euiKey` → `data-eui-key`, and geometry capture, misclick highlighting and the component tree read them. The stored-document parser stays permissive so existing rows and expanded documents still read.

### Where expansion happens

Expansion runs in the **save path** on the server (`expandPrototypeForSave`), **before** `snapshotDefinitions` and `collectAndValidateAssetRefs` — so a component or asset that occurs only inside a composition still lands in `prototype_revision_components` / `prototype_revision_assets` and cannot be deleted out from under a published revision. With v2 the save path expands the whole nested closure (up to the depth limit) and pins **every** composition in it, not only the top-level hosts: `prototype_revision_compositions` receives the transitive set, and component pins are taken from the dependency manifest of each pinned publication, so a later republication of a nested composition cannot change an existing prototype revision. The database stores the **authored** document (with `@eui/Composition`); component, asset and composition pins are derived from the **expanded** one, and publishing additionally requires every referenced composition to be pinned. The client (`src/prototype/loader.ts`) performs the same expansion using the composition documents returned alongside the draft/revision/version, so player, CJM, capture and gallery all render the expanded tree while the editor keeps the authored one.

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

## Screen regions

Flow screens may mark direct children of their root with `region: "statusBar" | "header" | "footer"`. A screen that uses any region must have the host-owned `@eui/FlowRoot` as its root. `@eui/FlowRoot` is a neutral block container available in every design system: it has only a default slot and adds no padding, gap, positioning, inherited color/font, or stacking context. It is valid only as the screen root and cannot have `repeat`, `visible`, or `on`.

Region subtrees must be self-contained: all styling and layout needed by a bar belongs inside that marked subtree, because mobile fluid present renders the three regions independently. The usual structure is:

```json
{
  "root": "root",
  "elements": {
    "root": { "type": "@eui/FlowRoot", "props": {}, "children": ["status", "header", "content", "footer"] },
    "status": { "type": "StatusBar", "props": {}, "region": "statusBar" },
    "header": { "type": "AppHeader", "props": {}, "region": "header" },
    "content": { "type": "Content", "props": {} },
    "footer": { "type": "TabBar", "props": {}, "region": "footer" }
  }
}
```

In mobile fluid present, `statusBar` is omitted, `header` and `footer` occupy fixed flex rows, and only the content between them scrolls. Navigation, back, and restart reset that content scroller to the top. Framed player and desktop present extract the same three regions into pinned slots of the phone frame: `header` and `footer` are always pinned, and `statusBar` is extracted into a top slot above the header or dropped, driven by the status-bar toggle; the content scrolls between them inside the frame. Editor canvas/strip, CJM, capture, and Gallery keep the same tree inline in authored order. The desktop player/present status-bar preference can omit `statusBar` only on those viewer surfaces; it does not affect editor, CJM, capture, or Gallery. A screen without regions uses the full StageViewport height. Pathologically tall bars are clipped by the viewport's `overflow: hidden`; mobile browser keyboard resizing follows `h-dvh`.

Validation enforces all of the following:

- A region element has exactly one parent, and that parent is the screen root. Orphan, nested, and multiply referenced markers are invalid.
- At most one element of each region kind is allowed per screen.
- Regions are forbidden on canvas screens and on `Overlay` or `Hotspot`.
- A region element cannot have `repeat` or `slot`; `visible` is allowed.
- `Hotspot` is forbidden anywhere inside a region subtree.
- `@eui/FlowRoot` cannot be nested or used anywhere except as a screen root.

A region marker may sit on an `@eui/Composition` element; it is carried onto the root of the expanded composition. Composition documents themselves carry no region markers — see [Versioned compositions](#versioned-compositions).

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
| 1 | Player, mobile/tablet flow | Flex-column phone viewport host `div[data-eui-stage-viewport="player-stage"]` inside the transformed frame native div | 390×844 / 834×1112 | In-stage `player-stage` scroller (flexing middle row between the region slots), plus the outer `DeviceFrame` page scroller `player` for manual zoom pan | Frame card clips | Not a capture surface | Absolute Overlay layer (`z-20`) pinned to the frame viewport, above content (`z-0`) and region slots (`z-10`); it does not move when the `player-stage` content scrolls, and moves with the whole frame only during manual-zoom page pan |
| 2 | Player, canvas (any device) | Canvas-sized `stageHost` div inside the `player-canvas` scroller; `CanvasLayers` uses the same box | Frame is canonical height × `canvas.width` (devices with a canonical viewport) or the full canvas (desktop); the `stageHost` box is `canvas.width` × `canvas.height` | In-stage vertical `player-canvas` scroller, plus the outer `DeviceFrame` page scroller `player` | Frame card clips | — | Third `CanvasLayers` layer above hotspots; scrolls with the canvas inside the `player-canvas` scroller |
| 3 | Player, desktop flow without canvas | **Forbidden by validation**; desktop preview control is disabled and an existing override is reset | — | — | — | — | — |
| 4 | Present, framed | The same `DeviceFrame` nodes as rows 1–2; uses `doc.device` with no preview override | As rows 1–2 | As rows 1–2 | As rows 1–2 | — | As rows 1–2 |
| 5 | Present, mobile fluid | Flow: flex-column phone viewport host `div[data-eui-stage-viewport="present-fluid"]`; canvas: the transformed author-sized div with the same attribute | Flow: phone viewport (`h-dvh`); canvas: `canvas.width` × `canvas.height`, scaled to host width | Flow: flexing middle row between header/footer region slots; canvas: scale-to-width scroller | Flow content scrolls inside the viewport host; canvas scrolls as a scale-to-width spacer | — | Flow: absolute Overlay layer (`z-20`) above content (`z-0`) and region slots (`z-10`); canvas: shares the canvas transform and scales and scrolls with it |
| 6 | Capture, mobile/tablet flow | Native `#eui-capture-surface`, without transform | Canonical device viewport | No in-surface scroller | No surface overflow rule | Worker captures this element; Overlay remains inside its bounds | Fixed to capture-surface edges; excess content does not move it |
| 7 | Capture, canvas | `#eui-capture-surface` is the canvas box | `canvas.width` × `canvas.height` | None | None | As row 6 | Third `CanvasLayers` layer |
| 8 | Capture, desktop flow | **Forbidden by validation**; the auto-height surface has no normative bottom anchor | — | — | — | Such a document cannot be saved for capture | — |
| 9 | Editor, main canvas | Transformed `div[data-eui-stage-viewport="editor"]` | Native width; canvas or measured auto height | Outer editor section | Stage viewport clips | — | Portal child in the transformed stage; inset scales; the inert stage and Overlay move together |
| 10 | Editor screen strip | Transformed `div[data-eui-stage-viewport="editor-strip"]` | Native width; preview height capped at 180 | Horizontal strip list | Tile clips | — | Same transform/inert behavior as row 9; bottom Overlay may be clipped in the fidelity thumbnail |
| 11 | CJM tile | Transformed `div[data-eui-stage-viewport="cjm"]` | Native width; device-specific capped height | CJM stage/list scrollers | Frame clips | — | Portal remains inside the transformed inert stage |
| 12 | Gallery preview | Inner transformed `div[data-eui-stage-viewport="gallery"]` inside the gallery scale transform | Native width; effective scale is device scale × gallery scale; height capped at 200 | None | Outer preview clips | — | Static inert preview; Overlay shares both transforms with content |
| 13 | Storybook | For specs with Overlay only, relative `div[data-eui-stage-viewport="story"]`; other stories keep the bare Renderer path | 390×844 | Storybook canvas | Host box does not add clipping or scrolling | — | Anchored inside the fixed story host box |
| 14 | Tablet canvas | Uses the corresponding canvas nodes from rows 2, 7, and 9–12; tablet does not create a separate branch | Canvas dimensions | As corresponding surface | As corresponding surface | As corresponding surface | As corresponding canvas surface |

Across all supported surfaces, `stageHostRef` points to the StageViewport or a direct relative container with identical geometry. Overlay stays in the stage's native coordinate system and inert subtree where applicable. In mobile fluid flow, StageViewport is an isolated flex column; content is `z-0`, header/footer slots are `z-10`, and the absolute Overlay portal layer is `z-20`, so authored region `z-index` values cannot cover an Overlay. The split order is host primitives before canvas and then region policy for flow content; presentation trees use the split results, while action runtime evaluates the original complete spec. The story host is created only for specs containing Overlay.

Mobile fluid present is selected once, when `PresentShell` mounts, and is not recomputed during the lifetime of that shell. A single exact `?mobile=1` forces fluid mode and `?mobile=0` forces the framed mode; otherwise the detector requires a coarse pointer and a viewport short side below 768px. A coarse-pointer tablet whose short side is at least 768px therefore remains framed. The query string survives navigation through the prototype flow. During share-token exchange, the server carries a single validated `mobile=0|1` value into the destination of the 303 redirect; duplicate or invalid values are not forwarded.

Mobile present has an explicit stacking contract: the stage is isolated with `isolation: isolate`, so authored `z-index` values cannot escape its stacking context; the order above it is stage < `FlowResetBanner` < HUD (`z-40`) < builtin Dialog/Drawer. Dialog and Drawer are Radix modal layers portalled to `document.body` at `z-50`, outside the stage and its `ContentScroller`. While an authored modal is open, its focus and interaction lock takes priority: the user closes that modal first, then the HUD becomes available.

On a scaled canvas, a descendant with `position: fixed` uses the transformed StageViewport as its containing block and consequently behaves like an absolutely positioned element relative to that container, rather than staying fixed to the browser viewport. This is the existing framed-player behavior and is intentionally preserved by the fluid canvas branch.

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
- **Monolithic screen** (`arch/monolith-root`) — a screen whose sole element is a single custom `organism`/`page` component with no children likely reconstructs a page in one component instead of composing it from design-system elements. See [Architecture warnings](#architecture-warnings) for the `@eui/FlowRoot`-aware branch of the same rule.
- **URL prop with a non-public local path** — a `urlProps` value that begins with `/` but not with a runtime-served public prefix (`/api/assets/`, `/design/`, `/fonts/`, `/images/`) may be unavailable to the player runtime.

## Architecture warnings

Architecture rules (`src/prototype/architectureLints.ts`) answer one question the atomic levels cannot: **which part of the screen does a component own?** They are additive to format v1 and behave like every other warning — they never block validation, saving, or publishing.

They read optional **architecture metadata** on a component definition (all fields optional, serialized into `DefinitionMeta`, the version DTO and the catalog manifest):

| field | meaning |
|---|---|
| `scope: "primitive" \| "section" \| "shell" \| "screen"` | which part of the screen the component owns |
| `allowedAsRoot: boolean` | explicit permission/prohibition to sit in a root position of a screen |
| `canonicalFor: string[]` | slugs of product roles for which this component is the canonical choice |
| `sourceBounded: boolean` | the component must not size itself to the viewport (publish scans the source for screen geometry only when `true`) |
| `ownership: { reason: string; provenance?: string }` | why the component is allowed to own a whole screen/shell |
| `replacement: string` | name of the replacing component in the same design system |

**Every rule fires only on an explicitly declared value.** Nothing is inferred from `atomicLevel`: `inferScopeFromAtomicLevel` (`src/designSystems/scope.ts`) exists for display in the inspector and library only. A component without architecture metadata produces no architecture warnings.

| id | fires on |
|---|---|
| `arch/monolith-root` | the screen is a single component: the root — or the only child of an `@eui/FlowRoot` root — is a custom component with `scope ∈ {section, shell, screen}`, no children and no filled slots. The legacy `organism`/`page` branch (direct root only, no metadata required) is part of the same rule |
| `arch/root-not-allowed` | an element in a root position whose definition declares `allowedAsRoot: false` |
| `arch/screen-scope-nested` | a `scope: "screen"` component used somewhere other than a root position of the screen |
| `arch/region-owns-page` | an element inside a `statusBar`/`header`/`footer` region subtree carries `scope ∈ {shell, screen}` — a region must not own the page |
| `arch/ownership-unexplained` | a custom component with `scope ∈ {shell, screen}` whose definition declares no `ownership.reason` |
| `arch/bounded-as-owner` | a `sourceBounded: true` component used as the screen root or as the owner of a region |

Root positions are `spec.root` itself and, when the root is `@eui/FlowRoot`, its direct children (regions and top-level content live there).

The rules are skipped entirely for service prototypes — `kind ∈ {component-gallery, evidence, visual-reference, composition-fixture}` (the `kind` comes from the prototype lifecycle field and is passed to `validatePrototype` by the server). When `arch/screen-scope-nested` or `arch/region-owns-page` fires on an element, the atomic-nesting warning for that same element is suppressed as a duplicate.

### `architecture.exemptions`

The document root accepts an optional strict `architecture` object with one field, `exemptions` — at most 200 entries:

```json
{
  "architecture": {
    "exemptions": [
      {
        "rule": "arch/monolith-root",
        "screenId": "success",
        "elementKey": "screen",
        "reason": "legacy import from Figma; recomposed in wave 5",
        "provenance": "docs/plans/2026-07-27-product-improvements-v2.md"
      }
    ]
  }
}
```

`rule` is one of the six ids above, `screenId` is a slug, `elementKey` is optional (absent means «every element of that screen»), `reason` is a trimmed string of at least 8 and at most 500 characters, and the optional `provenance` is at most 500 characters. A matching exemption removes the warning and is reported separately as `exempted` (the readiness report surfaces it), so an exemption is a documented decision rather than a silenced diagnostic.

## Author checklist

- Filename and document `id` match; every ID is a slug.
- `startScreen` and every `navigate` target exist; all intended screens are reachable.
- Every element belongs to exactly one rooted tree and stays within size/depth limits.
- Component props and events match the catalog; required props are present.
- `designSystem` is registered and every component belongs to its per-system allowlist.
- Atomic nesting warnings have been reviewed, even though they do not block validation.
- Semantic warnings (interactive handlers/labels, item identity, inline base64, screen connectivity, monolithic screens, local URL paths) have been reviewed.
- Architecture warnings (`arch/*`) have been reviewed; every remaining one is either fixed or covered by a documented `architecture.exemptions` entry.
- Element keys contain no `$`; every referenced composition is published and its required params are supplied.
- If `computed` are authored: keys are bare and collide with nothing in `state`/`stateOverrides`, money is in whole units, every `add` pointer term references an earlier key, and nothing writes to a computed path.
- If `flows` are authored: `flows[0]` is the root main scenario and stays at index 0, every child is declared after its parent, and nesting stays within 4 levels.
- Directives, conditions, actions, and params use only the closed v1 grammar.
- State paths are valid, non-reserved JSON Pointers; bound initial values are in `state` where appropriate.
- Terminal actions are unique and last; navigating links prevent their default browser action.
- Hotspots fit their canvas and all URLs satisfy the static URL policy.
- Run `npm run validate:prototypes` before submitting.
