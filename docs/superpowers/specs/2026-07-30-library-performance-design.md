# Library Performance and Prioritized Preview Design

Date: 2026-07-30  
Parent: [`2026-07-30-library-reuse-architecture-design.md`](./2026-07-30-library-reuse-architecture-design.md)  
Status: approved in conversation

## 1. Objective

Replace Library's N+1 status loading and per-card iframe applications with one
compact catalog read and a bounded inline preview scheduler. Preserve live,
theme-correct component rendering while making the useful catalog searchable
before previews finish.

## 2. Server read model

Add:

```http
GET /api/catalog/library?designSystem=<optional slug>
```

The response is a purpose-built read model, not a replacement for
`GET /api/catalog/manifest`:

```ts
interface LibraryCatalogResponse {
  catalogRevision: string;
  components: LibraryCatalogEntry[];
  systems: Array<{ id: string; name: string; count: number }>;
}

interface LibraryCatalogEntry {
  kind: "component";
  id: string;
  name: string;
  designSystem: string;
  version: number;
  bundleUrl: string;
  bundleHash: string;
  hostAbiVersion: number;
  description: string;
  atomicLevel?: "atom" | "molecule" | "organism" | "template" | "page";
  layoutNeutral: boolean;
  scope?: "primitive" | "section" | "shell" | "screen";
  canonicalFor: string[];
  replacement?: string;
  deprecated: boolean;
  headUsageCount: number;
  status: {
    published: boolean;
    verified: boolean;
    visualPending: boolean;
    blocked: boolean;
    rejected: boolean;
  };
  figma: null | {
    fileKey: string;
    nodeCount: number;
  };
  preview: null | {
    selector: "legacy" | "named";
    name?: string;
  };
}
```

The endpoint deliberately excludes source, full version history,
`propsJsonSchema`, and preview props. It resolves active-version status, latest
version status, latest matching visual run, Figma summary, and head usage in
bounded set-based queries. Identity and joins use `(componentId,
designSystem)`, avoiding the current map collision when one component has
active versions in multiple systems.

Add a lightweight preview-data endpoint:

```http
GET /api/components/:id/versions/:version/preview
    ?selector=legacy
GET /api/components/:id/versions/:version/preview
    ?selector=named&name=<slug>
```

Response:

```ts
interface ComponentPreviewData {
  componentId: string;
  name: string;
  version: number;
  designSystem: string;
  bundleUrl: string;
  bundleHash: string;
  hostAbiVersion: number;
  props: Record<string, unknown>;
}
```

The server performs the same strict example lookup as Capture Component. It
never returns source or props schemas. Existing example size limits continue to
bound this response.

Both endpoints are session-protected and `private, no-store`. Component bundles
remain immutable by version; the SPA's in-memory module cache, not shared HTTP
caching, provides repeat-load reuse.

## 3. Client data flow

```text
LibraryPage
   │
   ├── GET /api/catalog/library ──► cards/search/status immediately usable
   │
   └── PreviewScheduler (max active loads = 4)
          │
          ├── GET .../preview
          ├── loadCustomComponents(bundle)
          ├── get/cached design-system theme
          └── InlineComponentPreview
```

`LibraryPage` has one required request. A failed preview cannot change the page
or filter status. Each preview has an independent error boundary and retry.

The implementation reuses:

- `loadCustomComponents()` for immutable component modules;
- the component-page `CaptureSurface` rendering path;
- `SurfaceSpacingScope`;
- the component-page preview error-boundary behavior;
- the proven bounded-queue pattern from `GalleryPreview`.

Shared code is extracted into focused Library preview modules rather than
copying Component Page.

## 4. Theme isolation

Removing iframes also removes their document-level theme isolation. Library
must support cards from multiple design systems on one page.

Introduce `ScopedThemeSurface`:

- CSS custom-property tokens are applied to the card preview wrapper, so they
  inherit only into that component subtree.
- `@font-face` declarations and font assets are registered once per
  `{designSystem, metaVersion}` through the existing trusted theme manager.
- spacing tokens are resolved through `SurfaceSpacingScope`.
- mounting a card never changes `<html>` classes or root token values.
- a theme failure falls back to an unthemed preview and does not block card
  content.

Global font-family name collisions remain part of the existing trusted-theme
model. The migration audit reports collisions, but this project does not rename
published component CSS.

## 5. Preview scheduler

The scheduler has a stable maximum of four active network/module loads. Every
queued item has a key, priority, and abort signal:

```ts
type PreviewPriority =
  | 0 // explicitly selected search result or atom preview
  | 1 // visible page/organism
  | 2 // visible molecule
  | 3; // near-viewport prefetch
```

Rules:

- Lower numeric priority runs first; FIFO breaks ties.
- Reprioritizing an existing key does not enqueue a duplicate.
- Leaving the near-viewport region aborts a pending request.
- A loaded preview more than 800 CSS pixels outside the viewport is unmounted.
- Loaded bundles remain in `loadCustomComponents`' module cache.
- Search selection preempts pending background work but does not cancel a
  module import that has already entered browser evaluation.
- Navigation away aborts every pending preview request.
- Development StrictMode may mount effects twice without starting duplicate
  loads.

Atoms and layout-neutral primitives never enqueue automatically. Their compact
row contains an accessible “Показать превью” control. Pointer click or keyboard
activation expands one preview and assigns priority 0; hover alone is not a
required interaction.

## 6. Ranking and display tiers

Recommended entries exclude deprecated, rejected, and blocked entries. Their
stable sort key is:

1. non-empty `canonicalFor`;
2. descending `headUsageCount`;
3. verified before visual-pending;
4. higher assembly level (`page`, `template`, `organism`, `molecule`, `atom`);
5. localized name.

The section is capped at twelve entries and deduplicated against the later
level sections.

Default presentation:

| Tier | Presentation | Automatic preview |
|---|---|---|
| Recommended | Prominent card grid | Yes, scheduled by viewport and level |
| Pages/templates/organisms | Large card grid | Yes |
| Molecules | Regular card grid | Yes, only while visible/near |
| Atoms/layout | Collapsed compact index | No |
| Deprecated/replaced | Compact separate section | No |

Search spans every tier and both active artifact kinds once Composition v2 is
delivered. During the first project it searches components only. Search order
is exact canonical role, canonical prefix, exact name, partial name, scope and
atomic classifiers, description, usage, then localized name.

## 7. Loading and error states

- The current six-card skeleton is shown only for the single Library index
  request.
- Preview loading uses a local preview-area skeleton; card text and navigation
  stay available.
- Index failure keeps the existing full-page retry state.
- Preview metadata, bundle, render, and theme failures are distinguished in
  diagnostics but use one concise card fallback and retry control.
- A retry receives a new request generation and follows the existing
  `loadCustomComponents` full-document-reload escalation for repeated poisoned
  module imports.
- An invalid or missing example results in the existing “preview unavailable”
  presentation and is not retried automatically.

## 8. Performance budgets

Extend the existing Playwright performance harness with a deterministic
120-component dataset:

- 45 atoms;
- 35 molecules;
- 35 organisms;
- 5 pages/templates;
- at least three design systems;
- mixed status, Figma, visual verification, and usage metadata;
- representative examples and bundle sizes.

Environment: production build, Chromium, 1440×900, cold browser context,
40 ms latency, 5 Mbit/s download, 1 Mbit/s upload.

Required medians across at least five runs:

| Metric | Gate |
|---|---:|
| Searchable Library and painted card metadata | ≤2,500 ms |
| First live preview ready | ≤4,000 ms |
| Exact `GET /api/components/:id` on initial navigation | 0 |
| Simultaneous preview loads | ≤4 |
| Initial request count through first preview | ≤30 |
| Initial transfer through first preview | ≤3.0 MiB |
| Heap growth after a complete catalog scroll | ≤80 MiB |
| Mounted live previews after settling at any scroll position | ≤12 |

The gate also records raw samples, request categories, transferred bytes,
iframe count, mounted preview count, long tasks, and JS heap. There must be zero
component-preview iframes.

## 9. Test strategy

### Unit

- Library response mapping and composite identity.
- Ranking and tier partitioning.
- Queue concurrency, FIFO behavior, reprioritization, abort, and StrictMode.
- Observer mount/unmount thresholds.
- Scoped theme token isolation across two simultaneous systems.
- Preview error and retry states.

### Server

- Set-based response matches legacy status semantics.
- Multiple active design-system versions for one component do not collide.
- Preview selector grammar matches Capture Component.
- Source and props schema never appear in Library/preview responses.
- Query-count regression test is bounded independently of component count.
- Contracts and OpenAPI contain both endpoints and all error responses.

### Integration/e2e

- Metadata is searchable before any preview settles.
- Organism preview loads before an atom preview.
- Search promotes an offscreen result.
- Atom preview is explicit and keyboard accessible.
- Scrolling away unmounts a preview; returning reuses its module.
- Mixed themes do not mutate application chrome or each other.
- One broken component does not affect other cards.
- Performance harness passes the budgets above.

## 10. Rollout

The new endpoint and client deploy together. Existing manifest and capture
routes remain unchanged because players, screenshots, SDK generation, and old
clients consume them.

Runtime telemetry records endpoint duration, returned entry count, scheduler
queue depth, preview success/failure, and time to first preview without logging
props or source. The old iframe component is removed only after the new e2e and
performance gates pass; there is no dual runtime feature flag in steady state.

