/* global document, Element, getComputedStyle */

/**
 * Версия **контракта измерения** (план 2026-08-06 §1.3, волна W2).
 *
 * Не версия файла и не версия схемы отпечатка: это номер семантики, по которой считается
 * `layoutBounds`. Кадр, снятый по другой семантике, нельзя переиспользовать — вердикт геометрии
 * сравнивал бы измерения из разных миров, — поэтому константа заводится **входом**
 * `frameFingerprint` (`server/acceptance/ids.ts`), а не диагностическим полем рядом с метриками.
 *
 * - `1` — исходная семантика Geometry Contract 2.0 (union border-box'ов in-flow **элементов**).
 * - `2` — W2: в union входят живые текстовые узлы (`Range.getClientRects`, поэтому обёртка
 *   `display:contents` больше не теряет свою строку) и каждый бокс режется стеком клипающих
 *   предков внутри поддерева маркера (клипнутая карусель меряется по окну, а не по ленте).
 *
 * Значение `1` спредом **не кладётся** — иначе все до-W2 кадры инвалидировались бы задним числом
 * ещё раз; ветка `> 1` в `frameFingerprint` описывает ровно это.
 */
export const GEOMETRY_CONTRACT_VERSION = 2;

/**
 * Версия контракта измерения для случая, объявившего `cases[].geometryOwnership`
 * (EUI-BR-05, план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §5).
 *
 * Отдельная константа, а не подъём `GEOMETRY_CONTRACT_VERSION`: **аддитивные** факты волны
 * (`preTransformBounds`, матрица, `postTransformPaintBounds`, причины участия в поверхностях) в
 * отпечаток не входят вовсе — прецедент W1a, — поэтому кейс **без** декларации обязан остаться на
 * версии 2 и сохранить свои кадры байт-в-байт. Кейс **с** декларацией — другое дело: он требует
 * кадра, снятого под новым контрактом измерения (доволновой кадр не несёт `preTransformBounds`, и
 * decoration-семантику по нему не восстановить), поэтому `3` кладётся в `frameFingerprint`
 * условным спредом по манифестному факту (`server/acceptance/ids.ts#frameFingerprint`).
 */
export const GEOMETRY_OWNERSHIP_CONTRACT_VERSION = 3;

/**
 * **Карта узлов поддерева маркера** (EUI-BR-07 S1, план `docs/plans/2026-08-08-blocker-removal-eui-br.md`
 * §7): потолок записей на один маркер и на весь замер.
 *
 * Карта — новое **измерение**, а не переиспользование `rects[]`: у `rects[]` гранулярность
 * маркерная (union поддерева на `data-eui-key`), и для одиночного компонента она вырождается в
 * один прямоугольник, по которому атрибуция пикселей неотличима от «весь диф принадлежит
 * компоненту». Здесь запись заводится на **узел**, а внутренние узлы адресуются `path`.
 *
 * Оба числа — потолки, а не бюджеты «сколько поместится»: карта обязана быть доказательством, а не
 * второй копией DOM. Усечение всегда видимо (`truncated`), потому что «карта неполна» и «пиксель
 * ничей» — разные факты, и атрибуция обязана уметь их различать.
 *
 * Замер **аддитивен и вне отпечатков** (прецедент W1a/BR-05): `GEOMETRY_CONTRACT_VERSION` он не
 * двигает, во `frameFingerprint` не входит, и дифференциальный тест доказывает это отдельно.
 */
export const ELEMENT_MAP_NODE_LIMIT = 512;
export const ELEMENT_MAP_TOTAL_LIMIT = 2048;

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
export function analyzeGeometry({ frame, content, scroll, roleRects, overflowOwners } = {}) {
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
  // BR-09 (план 2026-08-08 §9): владельцы перелива, объявленные документом. Их вклад в `content`
  // уже ограничен границей scrollport'а на сборе, поэтому здесь остаётся ровно **незаявленный**
  // перелив — и именно он получает своё имя.
  const declaredOwners = overflowOwners ?? [];
  if (frameBox && content) {
    const overflowBottom = roundCssPx(rectBottom(content) - rectBottom(frameBox));
    const overflowRight = roundCssPx(rectRight(content) - rectRight(frameBox));
    if (overflowBottom > GEOMETRY_EPSILON || overflowRight > GEOMETRY_EPSILON) {
      issues.push({
        // Доволновой документ (деклараций нет вовсе) сохраняет прежний код байт-в-байт: смена
        // имени у него означала бы, что все накопленные замеры сменили диагноз без причины.
        code: declaredOwners.length > 0 ? "unowned-overflow" : "content-clipped-by-frame",
        severity: "warn",
        message: declaredOwners.length > 0
          ? `content extends past the frame by ${Math.max(overflowRight, 0)}px horizontally and ${Math.max(overflowBottom, 0)}px vertically outside any declared overflowOwnership`
          : `content extends past the frame by ${Math.max(overflowRight, 0)}px horizontally and ${Math.max(overflowBottom, 0)}px vertically`,
        detail: { overflowRight: Math.max(overflowRight, 0), overflowBottom: Math.max(overflowBottom, 0) },
      });
    }
  }
  // Владелец объявлен по одной оси, а поддерево переливается по **другой**: декларация не покрывает
  // этот спилл, и молча списывать его на владение нельзя — это и была бы дыра «объявил x, спрятал y».
  for (const owner of declaredOwners) {
    if (!owner || !(owner.crossAxisOverflowPx > GEOMETRY_EPSILON)) continue;
    issues.push({
      code: "owned-overflow-exceeds-axis",
      severity: "warn",
      message: `${owner.key} declares overflowOwnership on the ${owner.axis} axis, but its content also extends`
        + ` ${owner.crossAxisOverflowPx}px past its scrollport on the ${owner.axis === "x" ? "y" : "x"} axis`,
      detail: { key: owner.key, axis: owner.axis, crossAxisOverflowPx: owner.crossAxisOverflowPx },
    });
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
export function collectGeometry({
  limit = 2000, roleKeys = {}, detailKeys, overlayAwareRoot = false,
  decorationOwnership = false, geometryOwnership = null, overflowOwnership = null,
} = {}) {
  // Литералы-двойники module-scope экспортов: функция сериализуется для page.evaluate
  // и внутри страницы module-bindings не видит. Синхронизацию с экспортами держит
  // element-map-limits-тест в geometry.test.ts.
  const ELEMENT_MAP_NODE_LIMIT = 512;
  const ELEMENT_MAP_TOTAL_LIMIT = 2048;
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

  // --- Geometry Contract 2.0 (план 2026-08-03 §5 W3): layout-факты и атрибуция ---------------
  // `rects[]` выше остаётся байт-в-байт прежним (union `getClientRects()` всех потомков) —
  // аддитивность обязательна: на нём стоят существующие probe-потребители. Новое измерение
  // живёт отдельно: `layoutBounds` — union border-box'ов **in-flow** потомков (out-of-flow и
  // трансформированные исключаются и уходят в `effectSources`), поэтому декоративная коробка
  // подсветки больше не раздувает честные габариты (дефект «140 → 175» из §19.2 фидбэка).
  const DETAIL_KEY_LIMIT = 20;
  const DETAIL_SOURCE_LIMIT = 64;
  const CLIP_EPSILON = 0.5;
  const wantDetails = Array.isArray(detailKeys);
  const rootMarker = markers.find((marker) => nearestMarker(marker) === null) ?? null;
  const requestedKeys = !wantDetails ? []
    : detailKeys.length > 0 ? detailKeys.slice(0, DETAIL_KEY_LIMIT)
    : rootMarker ? [rootMarker.getAttribute("data-eui-key") ?? ""] : [];
  const nodePath = (element) => {
    const parts = [];
    for (let current = element; current instanceof Element && current !== surface && parts.length < 8; current = current.parentElement) {
      const tag = current.tagName.toLowerCase();
      const className = typeof current.className === "string" ? current.className.trim() : "";
      const suffix = current.id ? `#${current.id}` : className ? `.${className.split(/\s+/)[0]}` : "";
      parts.unshift(`${tag}${suffix}`);
    }
    return parts.join(">");
  };
  const ownerKey = (element) => {
    for (let current = element; current instanceof Element && current !== surface; current = current.parentElement) {
      if (markerSet.has(current)) return current.getAttribute("data-eui-key") ?? "";
    }
    return "";
  };
  const boxOf = (rect) => ({
    x: round(rect.left - surfaceRect.left), y: round(rect.top - surfaceRect.top),
    width: round(rect.right - rect.left), height: round(rect.bottom - rect.top),
  });
  // --- BR-05 (план 2026-08-08 §5): pre-transform геометрия ------------------------------------
  /**
   * Начало отсчёта offset-системы для поверхности съёмки. `getBoundingClientRect` у
   * трансформированного узла возвращает bbox **после** матрицы, и восстановить из него исходную
   * коробку нельзя (bbox повёрнутого ≠ повёрнутый bbox), поэтому pre-transform факт снимается
   * единственной системой, которая матрицу не видит вовсе, — `offsetLeft/offsetTop/offsetWidth`.
   *
   * `null` — offset-системы нет (SVG-узел, отсоединённое поддерево): тогда pre-transform факт не
   * публикуется, и авто-правило decoration по такому узлу не срабатывает. «Факта нет» здесь
   * честнее выдуманной коробки: на этом факте стоит решение «прозрачен для root'а».
   */
  const offsetOriginOf = (element) => {
    let x = 0;
    let y = 0;
    for (let current = element; current; current = current.offsetParent) {
      if (typeof current.offsetLeft !== "number" || typeof current.offsetTop !== "number") return null;
      x += current.offsetLeft;
      y += current.offsetTop;
    }
    return { x, y };
  };
  const surfaceOffsetOrigin = offsetOriginOf(surface);
  /** Коробка узла **до** трансформаций, в тех же координатах поверхности, что и `boxOf`. */
  const offsetBoxOf = (element) => {
    if (surfaceOffsetOrigin === null) return null;
    const origin = offsetOriginOf(element);
    if (origin === null) return null;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    if (typeof width !== "number" || typeof height !== "number") return null;
    if (width <= 0 && height <= 0) return null;
    return {
      x: round(origin.x - surfaceOffsetOrigin.x), y: round(origin.y - surfaceOffsetOrigin.y),
      width: round(width), height: round(height),
    };
  };
  /** Вложенность коробки в коробку с тем же допуском, что у клипа: суб-пиксель не решает роль. */
  const boxContains = (outer, inner) => outer !== null && inner !== null
    && inner.x >= outer.x - CLIP_EPSILON && inner.y >= outer.y - CLIP_EPSILON
    && inner.x + inner.width <= outer.x + outer.width + CLIP_EPSILON
    && inner.y + inner.height <= outer.y + outer.height + CLIP_EPSILON;
  /**
   * Совпадение узла с ключом декларации `cases[].geometryOwnership`.
   *
   * Форма ключа — `"<elementKey>"` либо `"<elementKey>//<суффикс elementPath>"`. Одного
   * `elementKey` мало по построению: внутренние узлы компонента своего маркера не имеют и
   * наследуют ключ ближайшего (`ownerKey`), поэтому у тултипа и пузырь, и хвост — `pay-tooltip`.
   * Суффикс сравнивается с хвостом `elementPath` (`div.bubble>i.tail`), а не целиком: полный путь
   * зависит от обёрток поверхности съёмки и ломался бы от смены сцены.
   */
  const ownershipRoleOf = (fact) => {
    if (!geometryOwnership) return null;
    for (const [selector, value] of Object.entries(geometryOwnership)) {
      const separator = selector.indexOf("//");
      const key = separator === -1 ? selector : selector.slice(0, separator);
      const suffix = separator === -1 ? "" : selector.slice(separator + 2);
      if (key !== fact.elementKey) continue;
      if (suffix !== "" && fact.elementPath !== suffix && !fact.elementPath.endsWith(`>${suffix}`)) continue;
      return value && value.role ? value.role : "decoration";
    }
    return null;
  };
  // Читается и цепочкой клипа (восходящей, ниже), и нисходящим стеком W2: «клип объявлен, но не
  // замечен» — молчаливо неверный вердикт, поэтому шорткат `overflow` разбирается наравне с осевыми.
  const clipDeclarationOf = (style) => {
    const shorthand = style.overflow ?? "";
    const overflowX = style.overflowX || shorthand || "visible";
    const overflowY = style.overflowY || shorthand || "visible";
    const clipping = (value) => value.split(/\s+/).some((part) => part === "hidden" || part === "clip");
    const clipPath = style.clipPath && style.clipPath !== "none" ? style.clipPath : null;
    const clips = clipping(overflowX) || clipping(overflowY);
    return clips || clipPath ? { overflowX, overflowY, clipPath } : null;
  };
  /**
   * Прокручиваемый бокс (`overflow: auto|scroll`) — клип **только для overlay-корня** (W5).
   *
   * Общая семантика W2 этой волной не пересматривается: `auto`/`scroll` по-прежнему не считаются
   * клипом ни для одного существующего измерения, поэтому кадры не сдвигаются и версия контракта
   * не бампается. Но у модалки, которая владеет своей прокруткой (`Overlay scroll:true`), контур —
   * это её бокс, а не двухметровая лента внутри: без этой ветки приёмка мерила бы ленту и
   * «modal scroll ownership» осталось бы неизмеримым.
   */
  const scrollClipOf = (style) => {
    const shorthand = style.overflow ?? "";
    const overflowX = style.overflowX || shorthand || "visible";
    const overflowY = style.overflowY || shorthand || "visible";
    const scrolls = (value) => value.split(/\s+/).some((part) => part === "auto" || part === "scroll");
    return scrolls(overflowX) || scrolls(overflowY) ? { overflowX, overflowY, clipPath: null } : null;
  };
  /** Пересечение бокса со стеком клипающих предков; `null` — клип съел его целиком. */
  const clipBox = (rect, clips) => {
    let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
    for (const clip of clips) {
      if (clip.left > left) left = clip.left;
      if (clip.top > top) top = clip.top;
      if (clip.right < right) right = clip.right;
      if (clip.bottom < bottom) bottom = clip.bottom;
    }
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
  };
  // Range нужен ради текстовых узлов: у них нет border-box, и до W2 строка, лежащая прямо в
  // маркере или в обёртке `display:contents`, не существовала для layout-измерения вовсе.
  const textRange = typeof document.createRange === "function" ? document.createRange() : null;
  /**
   * Первое поколение **боксовых** потомков сквозь цепочки `display:contents` (план 2026-08-07
   * §1.1, W1b). Обёртка без собственного бокса (включая вложенный маркер-`span` рантайма,
   * `src/catalog/runtime.ts`) прозрачна для этого спуска — иначе `rootBounds` замерил бы нулевой
   * бокс маркера и объявил компонент размером 0×0.
   *
   * Больше одного бокса искать незачем: два и есть ответ «корня нет» (Fragment-корень).
   *
   * BR-05: узел, классифицированный как **decoration** (`skip`), для этого спуска прозрачен —
   * ровно как обёртка `display:contents`. Хвост-сиблинг тултипа был вторым боксом первого
   * поколения и делал корень «неизмеримым» (`rootBounds: null` ⇒ поверхность `root` навсегда
   * `not-measured` ⇒ вечный `indeterminate`) — это и есть маршрут 4 диагностики V0-D3.
   */
  const boxedGeneration = (element, out, skip) => {
    for (const child of element.children) {
      if (out.length > 1) return out;
      if (isHidden(child)) continue;
      if (skip && skip.has(child)) continue;
      if (getComputedStyle(child).display === "contents") { boxedGeneration(child, out, skip); continue; }
      out.push(child);
    }
    return out;
  };
  /**
   * Элемент, чья border-box и есть `rootBounds` корня измерения, либо `null`.
   *
   * Две ветки по построению корня, а не по флагу: у viewport-поверхности корнем детали служит сам
   * `[data-eui-overlay-content]` — элемент **со своим боксом**, и спускаться из него некуда (его
   * бокс и есть контур модалки). У маркерного корня (`display:contents`) бокса нет вовсе, поэтому
   * ищется ровно один боксовый потомок первого поколения; ноль или два и более — `null`, то есть
   * `not-measured` у поверхности `root`. Догадка «возьмём union» здесь была бы ровно той подменой
   * одной величины другой, ради устранения которой заводились четыре поверхности.
   */
  const rootBoxOf = (root, skip) => {
    if (isHidden(root)) return null;
    if (getComputedStyle(root).display !== "contents") return root;
    const boxed = boxedGeneration(root, [], skip);
    return boxed.length === 1 ? boxed[0] : null;
  };
  /**
   * Восходящая цепочка клипа от `from` до поверхности включительно. `effective` — не «свойство
   * объявлено», а «оно реально режет» переданную краску; `painted === null` — краски не считали, и
   * тогда каждое звено честно неэффективно (у BR-09 предмет — сам факт клипа, а не его действие).
   */
  const ascendingClipChain = (from, painted) => {
    const chain = [];
    for (let current = from; current instanceof Element; current = current.parentElement) {
      const declaration = clipDeclarationOf(getComputedStyle(current));
      if (declaration) {
        const { overflowX, overflowY, clipPath } = declaration;
        const rect = current.getBoundingClientRect();
        const cuts = painted !== null && (painted.left < rect.left - CLIP_EPSILON || painted.top < rect.top - CLIP_EPSILON
          || painted.right > rect.right + CLIP_EPSILON || painted.bottom > rect.bottom + CLIP_EPSILON);
        chain.push({
          key: ownerKey(current), elementPath: nodePath(current),
          property: clipPath ? "clip-path" : "overflow",
          value: clipPath ?? `${overflowX} ${overflowY}`,
          effective: Boolean(cuts),
          rect: boxOf(rect),
        });
      }
      if (current === surface) break;
    }
    return chain;
  };
  const detailOf = (marker, { scrollAwareRoot = false } = {}) => {
    const boxes = [];
    const sources = [];
    // BR-05: узлы, выпавшие из потока (`position:absolute|fixed`) либо трансформированные. Список
    // ведётся **всегда** — это чистое расширение замера (прецедент W1a), и дифференциальный тест
    // доказывает, что `frameFingerprint` от него не двигается. Роль (`decoration`) на нём считается
    // ниже и только при включённой семантике владения.
    const flowExcluded = [];
    /** Декларации, наложенные на in-flow контейнер с layout-детьми (см. `visit`). */
    const ownershipViolations = [];
    // BR-07 S1: карта узлов поддерева. Ведётся **всегда** — это чистое расширение замера, и
    // потребитель (атрибуция диффа) обязан получать её по любому уже снятому кадру, а не только по
    // снятому «с флагом»: опцию сбора пришлось бы протаскивать сквозь капчур-помпу, то есть менять
    // кадр ради факта, который на пиксели не влияет.
    const elementMapNodes = [];
    let elementMapTotal = 0;
    const push = (element, cause, rect) => {
      if (sources.length >= DETAIL_SOURCE_LIMIT) return;
      sources.push({ elementKey: ownerKey(element), elementPath: nodePath(element), cause, rect: boxOf(rect) });
    };
    const keep = (rect, clips) => {
      const box = clipBox(rect, clips);
      if (box) boxes.push(box);
    };
    /** Живые строки элемента: только непосредственные текстовые дети, только непустые (trimmed). */
    const visitText = (element, clips) => {
      if (!textRange) return;
      for (const node of element.childNodes) {
        // 3 — Node.TEXT_NODE: числовой литерал, потому что функция сериализуется в страницу и
        // не должна зависеть от того, какие глобалы там объявлены.
        if (node.nodeType !== 3) continue;
        // Whitespace между тегами — не габарит: иначе перенос строки в JSX двигал бы контур.
        if ((node.data ?? "").trim() === "") continue;
        textRange.selectNodeContents(node);
        for (const rect of textRange.getClientRects()) {
          if (rect.right - rect.left <= 0 && rect.bottom - rect.top <= 0) continue;
          keep({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, clips);
        }
      }
    };
    /** Собственные непустые текстовые дети узла: «здесь живёт живой текст», а не «текст внутри». */
    const hasOwnText = (element) => {
      for (const node of element.childNodes) {
        // 3 — Node.TEXT_NODE (литерал: функция сериализуется в страницу).
        if (node.nodeType === 3 && (node.data ?? "").trim() !== "") return true;
      }
      return false;
    };
    const visit = (element, inFlow, clips, isRoot = false, depth = 0) => {
      if (isHidden(element)) return;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      // BR-07 S1: запись карты. Вырожденный (0×0) узел не заводится вовсе — он не может владеть ни
      // одним пикселем, и держать его значило бы тратить потолок на заведомо пустое владение.
      if (rect.right - rect.left > 0 || rect.bottom - rect.top > 0) {
        elementMapTotal += 1;
        if (elementMapNodes.length < ELEMENT_MAP_NODE_LIMIT) {
          elementMapNodes.push({
            path: nodePath(element),
            bbox: boxOf(rect),
            hasText: hasOwnText(element),
            markerKey: ownerKey(element),
            depth,
          });
        }
      }
      const position = style.position ?? "static";
      const outOfFlow = position === "absolute" || position === "fixed";
      const transform = style.transform ?? "";
      const transformed = transform !== "" && transform !== "none";
      // Атрибуция: всё, что красит за пределами своей border-box либо выпало из потока.
      if (outOfFlow) push(element, `position:${position}`, rect);
      if (transformed) push(element, `transform:${transform}`, rect);
      // BR-05: тот же узел, но одной записью на **узел**, а не на причину, и с pre-transform
      // коробкой. Корень измерения исключён по построению: он не «выпал из потока», он и есть поток.
      if (!isRoot && (outOfFlow || transformed) && flowExcluded.length < DETAIL_SOURCE_LIMIT) {
        const causes = [];
        if (outOfFlow) causes.push(`position:${position}`);
        if (transformed) causes.push(`transform:${transform}`);
        flowExcluded.push({
          element,
          fact: {
            elementKey: ownerKey(element),
            elementPath: nodePath(element),
            causes,
            // Не трансформированный узел свою pre-transform коробку и показывает: матрицы нет,
            // и второй способ её посчитать был бы вторым способом соврать.
            preTransformBounds: transformed ? offsetBoxOf(element) : boxOf(rect),
            transform: transformed ? transform : null,
            postTransformPaintBounds: boxOf(rect),
          },
        });
      }
      if (style.filter && style.filter !== "none") push(element, `filter:${style.filter}`, rect);
      if (style.boxShadow && style.boxShadow !== "none") push(element, `box-shadow:${style.boxShadow}`, rect);
      if (style.outlineStyle && style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth || "0") > 0) {
        push(element, `outline:${style.outlineWidth} ${style.outlineStyle}`, rect);
      }
      // Фильтр «в потоке» действует на **потомках**: сам корень измерения дисквалифицировать
      // нельзя. Для маркера (display:contents, static) обе формулы совпадают дословно, а для
      // overlay-корня (`position:absolute`, у `center` ещё и `transform`) старая форма отбрасывала
      // весь бокс и мерила пустоту (§W5 T5c.3).
      const keeps = isRoot || (inFlow && !outOfFlow && !transformed);
      // BR-05: злоупотребление декларацией. Объявить декорацией **in-flow контейнер с layout-
      // детьми** — это не «объяснить краску», а спрятать раскладку: такой узел держит габариты, и
      // выкинуть его из union значило бы объявить компонент меньше, чем он есть. Факт снимается
      // здесь (в браузере знают и поток, и детей), а отказ `geometry_ownership_invalid` выносит
      // сервер — `server/acceptance/gates/audit.ts#geometryOwnershipViolations`.
      if (geometryOwnership && keeps && !isRoot) {
        const candidate = { elementKey: ownerKey(element), elementPath: nodePath(element) };
        if (ownershipRoleOf(candidate) !== null) {
          let layoutChildren = 0;
          for (const child of element.children) {
            if (isHidden(child)) continue;
            const childStyle = getComputedStyle(child);
            const childPosition = childStyle.position ?? "static";
            if (childPosition === "absolute" || childPosition === "fixed") continue;
            const childTransform = childStyle.transform ?? "";
            if (childTransform !== "" && childTransform !== "none") continue;
            if (childStyle.display === "contents") continue;
            layoutChildren += 1;
          }
          if (layoutChildren > 0) ownershipViolations.push({ ...candidate, reason: "in-flow-container", layoutChildren });
        }
      }
      if (keeps && style.display !== "contents" && (rect.right - rect.left > 0 || rect.bottom - rect.top > 0)) {
        keep({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, clips);
      }
      if (keeps) visitText(element, clips);
      // Собственный клип элемента режет **потомков**, а не его самого: стек несётся вниз от
      // маркера. Восходящая `clipChain` этого не заменяет — она не видит клипающий контейнер
      // внутри поддерева, а её флаг `effective` считается из уже собранной краски.
      // `display:contents` не порождает бокса и потому не клипает ничего: его нулевой
      // `getBoundingClientRect` съел бы всё поддерево.
      const declaration = keeps && style.display !== "contents"
        ? clipDeclarationOf(style) ?? (isRoot && scrollAwareRoot ? scrollClipOf(style) : null)
        : null;
      const childClips = declaration
        ? [...clips, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }]
        : clips;
      for (const child of element.children) visit(child, keeps, childClips, false, depth + 1);
    };
    visit(marker, true, [], true, 0);
    const union = rectUnion(boxes);
    const sourceBoxes = sources.map((item) => ({
      left: item.rect.x + surfaceRect.left, top: item.rect.y + surfaceRect.top,
      right: item.rect.x + item.rect.width + surfaceRect.left, bottom: item.rect.y + item.rect.height + surfaceRect.top,
    }));
    const painted = rectUnion([...boxes, ...sourceBoxes]);
    // Цепочка клипа: предки с overflow hidden|clip либо clip-path. `effective` — не «свойство
    // объявлено», а «оно реально режет»: иначе `blur внутри overflow:hidden` и `blur наружу`
    // выглядели бы для политики одинаково.
    const clipChain = ascendingClipChain(marker.parentElement, painted);
    // --- W1b (план 2026-08-07 §1.1): безусловный замер корневого бокса ------------------------
    // Замер аддитивен: `layoutBounds` не трогается, PNG не меняется, ни один вход
    // `frameFingerprint` не добавляется — поэтому `GEOMETRY_CONTRACT_VERSION` остаётся 2.
    // --- BR-05 (план 2026-08-08 §5): классификация decoration ---------------------------------
    // Правило: узел вне потока, чья **pre-transform** коробка вложена в union остального
    // поддерева, — декорация. Именно «остального»: `union` считается по in-flow боксам, из
    // которых такой узел исключён по построению, поэтому теста «вложен сам в себя» не бывает.
    // Декларация случая (`geometryOwnership`) сильнее авто-правила и работает даже там, где
    // коробка не вложена (маршруты 3/5: неоднозначный DOM и объявленные по макету поверхности).
    const layoutBox = union ? boxOf(union) : null;
    const decorationElements = new Set();
    const outOfFlowNodes = flowExcluded.map(({ element, fact }) => {
      const declaredRole = ownershipRoleOf(fact);
      const auto = declaredRole === null && decorationOwnership && boxContains(layoutBox, fact.preTransformBounds);
      const decoration = declaredRole === "decoration" || auto;
      if (decoration) decorationElements.add(element);
      return {
        ...fact,
        ...(decoration ? { role: "decoration", roleSource: declaredRole === null ? "auto" : "declared" } : {}),
        // Причина участия/неучастия в каждой поверхности — читаемая по сохранённому кадру, без
        // похода в код: ровно ради этого волна и заводит факты, а не один булев флаг.
        participation: {
          layoutUnion: decoration ? "excluded:decoration" : "excluded:out-of-flow",
          root: decoration ? "excluded:decoration" : "counted",
          paint: "included",
        },
      };
    });
    const rootBox = rootBoxOf(marker, decorationElements.size > 0 ? decorationElements : null);
    const rootRect = rootBox ? rootBox.getBoundingClientRect() : null;
    // Вырожденный бокс не публикуется как измерение: «0×0» — это отсутствие факта, а не факт.
    const rootBounds = rootRect && rootRect.right - rootRect.left > 0 && rootRect.bottom - rootRect.top > 0
      ? boxOf(rootRect)
      : null;
    // Клип **самого корня** — факт для `clipExpectation: "root-does-not-clip-layout"`: утверждение
    // автора «union может выходить за корень, потому что корень не режет» проверяется объявлением
    // на корневом боксе, а не восходящей `clipChain` (её звенья — предки поверхности съёмки, а не
    // корень компонента). Прокручиваемый корень считается клипом там же, где им считает W5, — у
    // overlay-корня со своей прокруткой.
    const rootStyle = rootBounds && rootBox ? getComputedStyle(rootBox) : null;
    const rootDeclaration = rootStyle
      ? clipDeclarationOf(rootStyle) ?? (scrollAwareRoot && rootBox === marker ? scrollClipOf(rootStyle) : null)
      : null;
    return {
      key: marker.getAttribute("data-eui-key") ?? "",
      instance: instanceByMarker.get(marker) ?? 0,
      layoutBounds: union ? boxOf(union) : null,
      rootBounds,
      rootClip: rootDeclaration
        ? {
          property: rootDeclaration.clipPath ? "clip-path" : "overflow",
          value: rootDeclaration.clipPath ?? `${rootDeclaration.overflowX} ${rootDeclaration.overflowY}`,
        }
        : null,
      effectSources: sources,
      clipChain,
      // BR-05: аддитивный факт замера — вне отпечатка (`GEOMETRY_CONTRACT_VERSION` остаётся 2).
      outOfFlowNodes,
      // BR-07 S1: карта узлов — тоже аддитивный факт вне отпечатка. `total` — сколько узлов у
      // поддерева вообще есть: без него `truncated` не отвечает «насколько неполна карта».
      elementMap: { nodes: elementMapNodes, truncated: elementMapNodes.length < elementMapTotal, total: elementMapTotal },
      // Условный ключ: у случая без декларации его нет вовсе, и `geometry.json` корпуса не растёт.
      ...(geometryOwnership ? { ownershipViolations } : {}),
    };
  };
  /**
   * Overlay-aware layout root (план 2026-08-06 §W5 T5c.3). Опция включается **только** съёмкой
   * viewport-поверхности: без неё каждая ветка ниже мертва, и результат остаётся байт-в-байт
   * доволновым (поэтому `GEOMETRY_CONTRACT_VERSION` эта волна не двигает — семантика существующих
   * измерений не меняется, добавляется новая опция сбора).
   *
   * Корнем становится контентная обёртка оверлея, и только когда она в поверхности **ровно одна**:
   * два оверлея — это две модалки, и молча выбирать из них первую значило бы мерить наугад.
   * Явно запрошенные `detailKeys` сильнее: автор назвал маркеры сам.
   */
  const overlayContents = overlayAwareRoot && wantDetails && detailKeys.length === 0
    ? [...surface.querySelectorAll("[data-eui-overlay-content]")]
    : [];
  const overlayRoot = overlayContents.length === 1 ? overlayContents[0] : null;
  const details = overlayRoot
    ? [{ ...detailOf(overlayRoot, { scrollAwareRoot: true }), rootSource: "overlay" }]
    : requestedKeys.map((key) => {
      const marker = markers.find((candidate) => (candidate.getAttribute("data-eui-key") ?? "") === key);
      return marker
        ? detailOf(marker)
        : {
          key, instance: 0, layoutBounds: null, rootBounds: null, rootClip: null,
          effectSources: [], clipChain: [], outOfFlowNodes: [],
          elementMap: { nodes: [], truncated: false, total: 0 },
        };
    });
  // BR-07 S1: потолок карты на **весь** замер. Считается здесь, а не в `detailOf`: тот вызывается
  // и служебно (union корневых маркеров), и общий бюджет, потраченный отброшенным вызовом, сделал
  // бы карту зависящей от порядка обхода. Усечение видимо у той детали, которую оно затронуло.
  let elementMapBudget = ELEMENT_MAP_TOTAL_LIMIT;
  for (const item of details) {
    const map = item.elementMap;
    if (!map) continue;
    if (map.nodes.length > elementMapBudget) {
      map.nodes = map.nodes.slice(0, Math.max(0, elementMapBudget));
      map.truncated = true;
    }
    elementMapBudget -= map.nodes.length;
  }

  // --- BR-09 (план 2026-08-08 §9): владение переливом ------------------------------------------
  // Вклад поддерева объявленного владельца в габарит экрана ограничивается **границей его
  // scrollport'а по объявленной оси**. Сам перелив никуда не девается: он записывается фактами
  // (`scrollportBounds`/`scrollContentBounds`/`ownedOverflow`) и остаётся читаемым — меняется
  // ровно одно, кому он принадлежит. `rects[]` при этом не трогается: на нём стоят существующие
  // потребители probe'а, и переписывать их числа под новой семантикой значило бы сменить контракт.
  const overflowOwners = [];
  const scrollportOf = (marker, declaration) => {
    const ownerKeyName = typeof declaration.viewportOwner === "string" ? declaration.viewportOwner : null;
    const element = ownerKeyName === null
      ? rootBoxOf(marker, null)
      : markers.find((candidate) => candidate.getAttribute("data-eui-key") === ownerKeyName) ?? null;
    if (!element) return null;
    const port = getComputedStyle(element).display === "contents" ? rootBoxOf(element, null) : element;
    if (!port || isHidden(port)) return null;
    const rect = port.getBoundingClientRect();
    return rect.right - rect.left > 0 || rect.bottom - rect.top > 0 ? relative(rect) : null;
  };
  const contentBoxes = rows
    .filter((row) => !row.hidden && row.width > 0 && row.height > 0)
    .map((row) => {
      const box = { left: row.x, top: row.y, right: row.x + row.width, bottom: row.y + row.height };
      const declaration = overflowOwnership ? overflowOwnership[row.key] ?? null : null;
      if (!declaration) return box;
      const marker = markers.find((candidate) => (candidate.getAttribute("data-eui-key") ?? "") === row.key
        && (instanceByMarker.get(candidate) ?? 0) === row.instance);
      const port = marker ? scrollportOf(marker, declaration) : null;
      if (!port) return box;
      const portBox = { left: port.x, top: port.y, right: port.x + port.width, bottom: port.y + port.height };
      const axis = declaration.axis === "y" ? "y" : "x";
      const owned = axis === "x"
        ? round(Math.max(0, box.right - portBox.right) + Math.max(0, portBox.left - box.left))
        : round(Math.max(0, box.bottom - portBox.bottom) + Math.max(0, portBox.top - box.top));
      const crossAxisOverflowPx = axis === "x"
        ? round(Math.max(0, box.bottom - portBox.bottom) + Math.max(0, portBox.top - box.top))
        : round(Math.max(0, box.right - portBox.right) + Math.max(0, portBox.left - box.left));
      overflowOwners.push({
        key: row.key, instance: row.instance, axis, mode: "scroll",
        scrollportBounds: { ...port },
        scrollContentBounds: { x: row.x, y: row.y, width: row.width, height: row.height },
        ownedOverflowPx: owned,
        crossAxisOverflowPx,
        clipChain: marker ? ascendingClipChain(marker, null) : [],
        ...(declaration.expectedContentOverflow === undefined
          ? {}
          : { expectedContentOverflow: declaration.expectedContentOverflow, contentOverflowObserved: owned > 0 }),
      });
      // Клип по объявленной оси; другая ось остаётся как есть — владения по ней не объявляли.
      return axis === "x"
        ? { ...box, left: Math.max(box.left, portBox.left), right: Math.min(box.right, portBox.right) }
        : { ...box, top: Math.max(box.top, portBox.top), bottom: Math.min(box.bottom, portBox.bottom) };
    });
  const contentUnion = rectUnion(contentBoxes);
  const content = contentUnion
    ? { x: round(contentUnion.left), y: round(contentUnion.top), width: round(contentUnion.width), height: round(contentUnion.height) }
    : { x: 0, y: 0, width: 0, height: 0 };

  // --- BR-05 маршрут 1 (план 2026-08-08 §5, механизм 3): probe различает габариты --------------
  // `content` — union `getClientRects()` **всех** потомков, то есть paint-габарит: он включает
  // декоративный хвост, тень и всё, что вылезло из потока. Ровно это число автор кейса читал у
  // `preview --probe geometry` и писал в `expectedGeometry`, получая безусловный `layout-overflow`
  // (маршрут 1b диагностики). Рядом теперь едет **layout-габарит** — union тех же in-flow боксов,
  // по которым считается вердикт. Аддитивно: `content` не переименован и не пересчитан.
  //
  // Считается по корневым маркерам: поддерево корневого маркера уже содержит вложенные, поэтому
  // union по ним равен union'у по всем — а обход стоит одного прохода на корень, а не на маркер.
  const layoutBoxes = [];
  for (const marker of markers) {
    if (nearestMarker(marker) !== null || isHidden(marker)) continue;
    const bounds = detailOf(marker).layoutBounds;
    if (bounds && (bounds.width > 0 || bounds.height > 0)) {
      layoutBoxes.push({ left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height });
    }
  }
  const layoutUnion = rectUnion(layoutBoxes);
  const layout = layoutUnion
    ? { x: round(layoutUnion.left), y: round(layoutUnion.top), width: round(layoutUnion.width), height: round(layoutUnion.height) }
    : { x: 0, y: 0, width: 0, height: 0 };

  const bounded = Math.max(0, Math.floor(limit));
  return {
    rects: rows.slice(0, bounded), truncated: rows.length > bounded, total: rows.length,
    safeArea, roleRects, frame, content, layout, scroll,
    // BR-09: факты владения переливом. Условный ключ — документ без деклараций отдаёт ровно
    // доволновой замер, и `analyzeGeometry` читает отсутствие как «владельцев нет».
    ...(overflowOwners.length === 0 ? {} : { overflowOwners }),
    // Отсутствует у обычного `probe:"geometry"` — контракт существующих ручек не меняется.
    ...(wantDetails ? { details, detailKeys: requestedKeys } : {}),
  };
}
