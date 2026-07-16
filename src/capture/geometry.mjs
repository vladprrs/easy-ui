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

/**
 * Browser-side geometry collector. Keep every helper nested: Playwright
 * serializes this function for page.evaluate, so it must not close over module
 * bindings. The same function is imported by DOM unit tests.
 */
export function collectGeometry({ limit = 2000 } = {}) {
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
  const bounded = Math.max(0, Math.floor(limit));
  return { rects: rows.slice(0, bounded), truncated: rows.length > bounded, total: rows.length };
}
