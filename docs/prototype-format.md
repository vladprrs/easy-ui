# Prototype format v1

Prototype files live in `prototypes/*.json`. A file is a self-contained flow; its `id` must equal the filename without `.json`.

## Document and screens

The root is a strict object with `version: 1`, slug `id`, human-readable `name`, optional `description`, `device` (`mobile`, `tablet`, or `desktop`, default `desktop`), slug `startScreen`, `state`, and a non-empty `screens` array. Screen IDs are unique slugs and `startScreen` must exist.

Each screen has `id`, `name`, optional positive `{width,height}` `canvas`, and `spec`. A spec contains only `root` and `elements`. An element contains only `type`, `props`, optional `children`, optional `visible`, and optional `on`. Its type and props must match the normalized catalog definition. Unknown props, including keys in nested objects, are errors. Elements form one tree rooted at `root` (maximum 500 elements and depth 50).

`state` is the only initial-state source. JSON Pointer state paths are absolute RFC 6901 paths. `/currentScreen`, `/navStack`, and `/_viewer` are reserved. A `$state` path absent from initial state produces a warning.

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
- Directives, conditions, actions, and params use only the closed v1 grammar.
- State paths are valid, non-reserved JSON Pointers; bound initial values are in `state` where appropriate.
- Terminal actions are unique and last; navigating links prevent their default browser action.
- Hotspots fit their canvas and all URLs satisfy the static URL policy.
- Run `npm run validate:prototypes` before submitting.
