/* global document, Element, getComputedStyle */
/** Round browser geometry without leaking device-pixel noise into the API. */
export const roundCssPx = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Pure union primitive shared by browser collection and deterministic tests. */
export function unionRects(rects) {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Roles reported next to the union bounds; every one of them is optional. */
export const GEOMETRY_ROLES = ["panel", "frame", "region:header", "region:footer", "region:statusBar"];

/** A footer taller than this share of the frame owns the page rather than terminating it. */
export const FOOTER_OWNERSHIP_RATIO = 0.5;
/** Sub-pixel slack: browser rounding must not manufacture clipping/overlap issues. */
const GEOMETRY_EPSILON = 1;

const rectArea = (rect) => Math.max(0, rect.width) * Math.max(0, rect.height);
const rectRight = (rect) => rect.x + rect.width;
const rectBottom = (rect) => rect.y + rect.height;

/** Intersection of two `{x,y,width,height}` boxes, or null when they do not overlap. */
export function rectIntersection(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(rectRight(a), rectRight(b));
  const bottom = Math.min(rectBottom(a), rectBottom(b));
  if (right <= x || bottom <= y) return null;
  return { x: roundCssPx(x), y: roundCssPx(y), width: roundCssPx(right - x), height: roundCssPx(bottom - y) };
}

/** Area of the union of axis-aligned boxes (grid decomposition; the input set is tiny). */
export function unionArea(rects) {
  const boxes = rects.filter((rect) => rect && rectArea(rect) > 0);
  if (!boxes.length) return 0;
  const xs = [...new Set(boxes.flatMap((rect) => [rect.x, rectRight(rect)]))].sort((a, b) => a - b);
  const ys = [...new Set(boxes.flatMap((rect) => [rect.y, rectBottom(rect)]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const cell = { x: xs[i], y: ys[j], width: xs[i + 1] - xs[i], height: ys[j + 1] - ys[j] };
      if (boxes.some((rect) => rectIntersection(rect, cell))) total += cell.width * cell.height;
    }
  }
  return roundCssPx(total);
}

/**
 * Structural analysis over the raw browser measurements. Pure on purpose: the
 * worker runs it outside the page so it stays unit-testable without a DOM.
 */
export function analyzeGeometry({ frame, content, scroll, roleRects } = {}) {
  const roles = roleRects ?? {};
  const frameBox = frame ?? null;
  const frameArea = frameBox ? rectArea(frameBox) : 0;
  const share = (value) => (frameArea > 0 ? roundCssPx((value / frameArea) * 100) : 0);
  const owned = [];
  const owners = [];
  for (const role of GEOMETRY_ROLES) {
    const rect = roles[role];
    if (!rect || role === "frame") continue;
    const clipped = frameBox ? rectIntersection(rect, frameBox) : rect;
    if (!clipped) continue;
    owned.push(clipped);
    owners.push({
      role,
      areaPct: share(rectArea(clipped)),
      heightPct: frameBox && frameBox.height > 0 ? roundCssPx((clipped.height / frameBox.height) * 100) : 0,
    });
  }
  const viewportOwnership = {
    frame: frameBox ? { width: frameBox.width, height: frameBox.height } : null,
    content: content ? { width: content.width, height: content.height } : null,
    scroll: scroll ?? null,
    scrollable: Boolean(frameBox && scroll && scroll.height > frameBox.height + GEOMETRY_EPSILON),
    owners,
    unownedPct: frameArea > 0 ? roundCssPx(Math.max(0, 100 - share(unionArea(owned)))) : 0,
  };

  const issues = [];
  if (frameBox && content) {
    const overflowBottom = roundCssPx(rectBottom(content) - rectBottom(frameBox));
    const overflowRight = roundCssPx(rectRight(content) - rectRight(frameBox));
    if (overflowBottom > GEOMETRY_EPSILON || overflowRight > GEOMETRY_EPSILON) {
      issues.push({
        code: "content-clipped-by-frame",
        severity: "warn",
        message: `content extends past the frame by ${Math.max(overflowRight, 0)}px horizontally and ${Math.max(overflowBottom, 0)}px vertically`,
        detail: { overflowRight: Math.max(overflowRight, 0), overflowBottom: Math.max(overflowBottom, 0) },
      });
    }
  }
  const present = GEOMETRY_ROLES.filter((role) => role !== "frame" && roles[role]);
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const overlap = rectIntersection(roles[present[i]], roles[present[j]]);
      if (!overlap || rectArea(overlap) <= GEOMETRY_EPSILON) continue;
      issues.push({
        code: "overlapping-regions",
        severity: "warn",
        message: `${present[i]} overlaps ${present[j]} over ${rectArea(overlap)}px²`,
        detail: { roles: [present[i], present[j]], overlap },
      });
    }
  }
  const footer = roles["region:footer"];
  if (footer && frameBox && frameBox.height > 0) {
    const ratio = roundCssPx(footer.height / frameBox.height);
    if (ratio >= FOOTER_OWNERSHIP_RATIO) {
      issues.push({
        code: "footer-owns-page",
        severity: "warn",
        message: `footer occupies ${roundCssPx(ratio * 100)}% of the frame height`,
        detail: { footerHeight: footer.height, frameHeight: frameBox.height, ratio },
      });
    }
  }
  return { viewportOwnership, issues };
}

/**
 * Browser-side geometry collector. Keep every helper nested: Playwright
 * serializes this function for page.evaluate, so it must not close over module
 * bindings. The same function is imported by DOM unit tests.
 */
export function collectGeometry({ limit = 2000, roleKeys = {} } = {}) {
  const markerSelector = "[data-eui-key]";
  const surface = document.querySelector("#eui-capture-surface");
  if (!(surface instanceof Element)) throw new Error("#eui-capture-surface not found");
  const surfaceRect = surface.getBoundingClientRect();
  // Portalled marker subtrees (Dialog/Drawer and host overlay layers) may live
  // outside the capture surface in DOM while still belonging to this capture.
  const markers = [...document.querySelectorAll(markerSelector)];
  const markerSet = new Set(markers);
  const instances = new Map();
  const instanceByMarker = new Map();
  const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
  const rectUnion = (rects) => {
    if (!rects.length) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const intersectsSurface = (rect) => rect.right > surfaceRect.left && rect.left < surfaceRect.right
    && rect.bottom > surfaceRect.top && rect.top < surfaceRect.bottom;
  const isHidden = (element) => {
    for (let current = element; current instanceof Element; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || current.hasAttribute("hidden")) return true;
      if (current === surface) break;
    }
    return false;
  };
  const nearestMarker = (element) => {
    for (let current = element.parentElement; current && current !== surface; current = current.parentElement) {
      if (markerSet.has(current)) return current;
    }
    return null;
  };
  const immediateChildren = (marker) => markers.filter((candidate) => nearestMarker(candidate) === marker);
  const layoutOwner = (marker) => {
    const children = immediateChildren(marker);
    if (children.length < 2) return null;
    let candidate = children[0].parentElement;
    while (candidate && candidate !== marker && !children.every((child) => candidate.contains(child))) candidate = candidate.parentElement;
    if (!candidate || candidate === marker || !marker.contains(candidate)) return null;
    while (candidate !== marker && getComputedStyle(candidate).display === "contents") candidate = candidate.parentElement;
    if (!candidate || candidate === marker || !marker.contains(candidate)) return null;
    // A child marker may not be split across several direct roots below owner.
    // Such fragments make the box responsible for flow ambiguous.
    const branch = (child) => {
      let current = child;
      while (current.parentElement && current.parentElement !== candidate) current = current.parentElement;
      return current.parentElement === candidate ? current : null;
    };
    if (children.some((child) => branch(child) === null)) return null;
    const style = getComputedStyle(candidate);
    return {
      display: style.display,
      flexDirection: style.flexDirection,
      flexWrap: style.flexWrap,
      rowGap: style.rowGap,
      columnGap: style.columnGap,
    };
  };

  markers.forEach((marker) => {
    const key = marker.getAttribute("data-eui-key") ?? "";
    const instance = instances.get(key) ?? 0;
    instances.set(key, instance + 1);
    instanceByMarker.set(marker, instance);
  });

  const rows = markers.map((marker, domIndex) => {
    const key = marker.getAttribute("data-eui-key") ?? "";
    const parent = nearestMarker(marker);
    const boxes = [];
    for (const element of marker.querySelectorAll("*")) {
      if (element.matches(markerSelector) || isHidden(element)) continue;
      const style = getComputedStyle(element);
      for (const rect of element.getClientRects()) {
        if (style.position === "fixed" && !intersectsSurface(rect)) continue;
        boxes.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
      }
    }
    // A non-contents marker is supported defensively even though runtime
    // markers are currently display:contents.
    if (getComputedStyle(marker).display !== "contents" && !isHidden(marker)) {
      for (const rect of marker.getClientRects()) boxes.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
    const union = rectUnion(boxes);
    const row = {
      key,
      instance: instanceByMarker.get(marker) ?? 0,
      ...(parent ? { parentKey: parent.getAttribute("data-eui-key") ?? "", parentInstance: instanceByMarker.get(parent) ?? 0 } : {}),
      domIndex,
      x: round((union?.left ?? surfaceRect.left) - surfaceRect.left),
      y: round((union?.top ?? surfaceRect.top) - surfaceRect.top),
      width: round(union?.width ?? 0),
      height: round(union?.height ?? 0),
      layoutContext: layoutOwner(marker),
    };
    if (!union && (isHidden(marker) || [...marker.querySelectorAll("*")].some(isHidden))) row.hidden = true;
    return row;
  });
  // --- Additive structural measurements (roles, safe area, frame/content boxes) ---
  const roles = ["panel", "frame", "region:header", "region:footer", "region:statusBar"];
  const roleSelectors = {
    panel: ["[data-eui-role='panel']", "[data-eui-content-scroller]"],
    frame: ["[data-eui-stage-viewport]", "[data-eui-role='frame']"],
    "region:header": ["[data-eui-region='header']"],
    "region:footer": ["[data-eui-region='footer']"],
    "region:statusBar": ["[data-eui-region='statusBar']"],
  };
  const relative = (rect) => ({
    x: round(rect.left - surfaceRect.left),
    y: round(rect.top - surfaceRect.top),
    width: round(rect.width ?? rect.right - rect.left),
    height: round(rect.height ?? rect.bottom - rect.top),
  });
  const markerRect = (key) => {
    const marker = markers.find((candidate) => candidate.getAttribute("data-eui-key") === key);
    if (!marker || isHidden(marker)) return null;
    const boxes = [];
    for (const element of marker.querySelectorAll("*")) {
      if (isHidden(element)) continue;
      for (const rect of element.getClientRects()) boxes.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
    for (const rect of marker.getClientRects()) boxes.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    const union = rectUnion(boxes);
    return union ? relative(union) : null;
  };
  const roleRects = {};
  for (const role of roles) {
    const key = roleKeys[role];
    const fromKey = typeof key === "string" ? markerRect(key) : null;
    if (fromKey) { roleRects[role] = { ...fromKey, source: "key", key }; continue; }
    for (const selector of roleSelectors[role] ?? []) {
      const element = document.querySelector(selector);
      if (!(element instanceof Element) || isHidden(element)) continue;
      roleRects[role] = { ...relative(element.getBoundingClientRect()), source: "selector" };
      break;
    }
  }
  const frame = roleRects.frame ?? { x: 0, y: 0, width: round(surfaceRect.width), height: round(surfaceRect.height), source: "surface" };
  const contentBoxes = rows
    .filter((row) => !row.hidden && row.width > 0 && row.height > 0)
    .map((row) => ({ left: row.x, top: row.y, right: row.x + row.width, bottom: row.y + row.height }));
  const contentUnion = rectUnion(contentBoxes);
  const content = contentUnion
    ? { x: round(contentUnion.left), y: round(contentUnion.top), width: round(contentUnion.width), height: round(contentUnion.height) }
    : { x: 0, y: 0, width: 0, height: 0 };
  const scroll = { width: round(surface.scrollWidth ?? 0), height: round(surface.scrollHeight ?? 0) };
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px)";
  surface.appendChild(probe);
  const probeStyle = getComputedStyle(probe);
  const inset = (value) => { const parsed = Number.parseFloat(value); return Number.isFinite(parsed) ? round(parsed) : 0; };
  const safeArea = {
    top: inset(probeStyle.paddingTop), right: inset(probeStyle.paddingRight),
    bottom: inset(probeStyle.paddingBottom), left: inset(probeStyle.paddingLeft),
  };
  probe.remove();

  const bounded = Math.max(0, Math.floor(limit));
  return {
    rects: rows.slice(0, bounded), truncated: rows.length > bounded, total: rows.length,
    safeArea, roleRects, frame, content, scroll,
  };
}
