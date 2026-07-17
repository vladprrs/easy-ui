import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cjm } from "../app/strings/cjm";
import type { CjmEdge, CjmLayout, CjmNode } from "./lanesLayout";

export interface LogicalPoint {
  x: number;
  y: number;
}

export interface LogicalEdgeRoute {
  edge: CjmEdge;
  points: LogicalPoint[];
  startPort: "left" | "right" | "top" | "bottom";
  endPort: "left" | "right" | "top" | "bottom";
}

export interface LogicalRouting {
  routes: LogicalEdgeRoute[];
  maxRowChannels: number;
  maxColumnChannels: number;
  rowGap: number;
  columnGap: number;
}

interface ChannelRequest {
  key: string;
  gutter: number;
  start: number;
  end: number;
  channel?: number;
  channelCount?: number;
}

interface RouteDraft {
  edge: CjmEdge;
  from: CjmNode;
  to: CjmNode;
  kind: "direct-horizontal" | "direct-vertical" | "same-row-gutter" | "cross-row";
  row: ChannelRequest[];
  column: ChannelRequest[];
  verticalGutter?: number;
}

const TILE_HALF = 0.32;
const CHANNEL_STEP = 0.005;
const BASE_ROW_GAP = 32;
const BASE_COLUMN_GAP = 40;

function colorIntervals(requests: ChannelRequest[]): number {
  const groups = new Map<number, ChannelRequest[]>();
  for (const request of requests) {
    const group = groups.get(request.gutter) ?? [];
    group.push(request);
    groups.set(request.gutter, group);
  }
  let maximum = 0;
  for (const group of groups.values()) {
    const channelEnds: number[] = [];
    group.sort((left, right) => left.key.localeCompare(right.key));
    for (const request of group) {
      let channel = channelEnds.findIndex((end) => end < request.start);
      if (channel === -1) channel = channelEnds.length;
      channelEnds[channel] = request.end;
      request.channel = channel;
    }
    for (const request of group) request.channelCount = channelEnds.length;
    maximum = Math.max(maximum, channelEnds.length);
  }
  return maximum;
}

const channelOffset = (request: ChannelRequest) =>
  ((request.channel ?? 0) - ((request.channelCount ?? 1) - 1) / 2) * CHANNEL_STEP;

function hasLineOfSight(from: CjmNode, to: CjmNode, nodes: readonly CjmNode[]): boolean {
  if (from.lane === to.lane) {
    const low = Math.min(from.column, to.column);
    const high = Math.max(from.column, to.column);
    return !nodes.some((node) => node.lane === from.lane && node.column > low && node.column < high);
  }
  if (from.column === to.column) {
    const low = Math.min(from.lane, to.lane);
    const high = Math.max(from.lane, to.lane);
    return !nodes.some((node) => node.column === from.column && node.lane > low && node.lane < high);
  }
  return false;
}

/** Fixes all route topologies and channel assignments using logical grid coordinates only. */
export function computeLogicalEdgeRoutes(layout: CjmLayout): LogicalRouting {
  const nodes = layout.lanes.flatMap((lane) => lane.nodes);
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const drafts: RouteDraft[] = [];
  for (const edge of [...layout.edges].sort((left, right) => left.key.localeCompare(right.key))) {
    const from = byKey.get(edge.from);
    const to = byKey.get(edge.to);
    if (!from || !to) throw new Error(`CJM edge ${edge.key} has a missing endpoint`);
    if (from.lane === to.lane && hasLineOfSight(from, to, nodes)) {
      drafts.push({ edge, from, to, kind: "direct-horizontal", row: [], column: [] });
      continue;
    }
    if (from.column === to.column && hasLineOfSight(from, to, nodes)) {
      drafts.push({ edge, from, to, kind: "direct-vertical", row: [], column: [] });
      continue;
    }
    if (from.lane === to.lane) {
      drafts.push({
        edge,
        from,
        to,
        kind: "same-row-gutter",
        row: [{
          key: `${edge.key}:row:0`,
          gutter: from.lane,
          start: Math.min(from.column, to.column),
          end: Math.max(from.column, to.column),
        }],
        column: [],
      });
      continue;
    }
    const direction = to.column >= from.column ? 1 : -1;
    const verticalGutter = from.column + (direction > 0 ? 0 : -1);
    const verticalX = verticalGutter + 0.5;
    const sourceGutter = from.lane;
    const targetGutter = to.lane - 1;
    drafts.push({
      edge,
      from,
      to,
      kind: "cross-row",
      verticalGutter,
      row: [
        { key: `${edge.key}:row:0`, gutter: sourceGutter, start: Math.min(from.column, verticalX), end: Math.max(from.column, verticalX) },
        { key: `${edge.key}:row:1`, gutter: targetGutter, start: Math.min(to.column, verticalX), end: Math.max(to.column, verticalX) },
      ],
      column: [{
        key: `${edge.key}:column:0`,
        gutter: verticalGutter,
        start: Math.min(sourceGutter + 0.5, targetGutter + 0.5),
        end: Math.max(sourceGutter + 0.5, targetGutter + 0.5),
      }],
    });
  }
  const maxRowChannels = colorIntervals(drafts.flatMap((draft) => draft.row));
  const maxColumnChannels = colorIntervals(drafts.flatMap((draft) => draft.column));
  const routes = drafts.map<LogicalEdgeRoute>((draft) => {
    const { from, to } = draft;
    if (draft.kind === "direct-horizontal") {
      const forward = to.column > from.column;
      const gutterX = from.column + (forward ? 0.5 : -0.5);
      return {
        edge: draft.edge,
        startPort: forward ? "right" : "left",
        endPort: forward ? "left" : "right",
        points: [
          { x: from.column + (forward ? TILE_HALF : -TILE_HALF), y: from.lane },
          { x: gutterX, y: from.lane },
          { x: gutterX, y: to.lane },
          { x: to.column + (forward ? -TILE_HALF : TILE_HALF), y: to.lane },
        ],
      };
    }
    if (draft.kind === "direct-vertical") {
      const forward = to.lane > from.lane;
      return {
        edge: draft.edge,
        startPort: forward ? "bottom" : "top",
        endPort: forward ? "top" : "bottom",
        points: [
          { x: from.column, y: from.lane + (forward ? TILE_HALF : -TILE_HALF) },
          { x: to.column, y: to.lane + (forward ? -TILE_HALF : TILE_HALF) },
        ],
      };
    }
    if (draft.kind === "same-row-gutter") {
      const y = from.lane + 0.5 + channelOffset(draft.row[0]!);
      return {
        edge: draft.edge,
        startPort: "bottom",
        endPort: "bottom",
        points: [
          { x: from.column, y: from.lane + TILE_HALF },
          { x: from.column, y },
          { x: to.column, y },
          { x: to.column, y: to.lane + TILE_HALF },
        ],
      };
    }
    const sourceY = from.lane + 0.5 + channelOffset(draft.row[0]!);
    const targetY = to.lane - 0.5 + channelOffset(draft.row[1]!);
    const verticalX = draft.verticalGutter! + 0.5 + channelOffset(draft.column[0]!);
    return {
      edge: draft.edge,
      startPort: "bottom",
      endPort: "top",
      points: [
        { x: from.column, y: from.lane + TILE_HALF },
        { x: from.column, y: sourceY },
        { x: verticalX, y: sourceY },
        { x: verticalX, y: targetY },
        { x: to.column, y: targetY },
        { x: to.column, y: to.lane - TILE_HALF },
      ],
    };
  });
  return {
    routes,
    maxRowChannels,
    maxColumnChannels,
    rowGap: BASE_ROW_GAP + 8 * maxRowChannels,
    columnGap: BASE_COLUMN_GAP + 8 * maxColumnChannels,
  };
}

interface PixelRoute {
  key: string;
  points: string;
  middle: { x: number; y: number };
}

const portPoint = (rect: DOMRect, root: DOMRect, port: LogicalEdgeRoute["startPort"]) => {
  if (port === "left") return { x: rect.left - root.left, y: rect.top - root.top + rect.height / 2 };
  if (port === "right") return { x: rect.right - root.left, y: rect.top - root.top + rect.height / 2 };
  if (port === "top") return { x: rect.left - root.left + rect.width / 2, y: rect.top - root.top };
  return { x: rect.left - root.left + rect.width / 2, y: rect.bottom - root.top };
};

export function CjmEdgesOverlay({ layout, routing }: { layout: CjmLayout; routing: LogicalRouting }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [pixelRoutes, setPixelRoutes] = useState<PixelRoute[]>(() => routing.routes.map((route) => ({
    key: route.edge.key,
    points: route.points.map((point) => `${point.x},${point.y}`).join(" "),
    middle: route.points[Math.floor(route.points.length / 2)]!,
  })));
  const nodes = useMemo(() => new Map(layout.lanes.flatMap((lane) => lane.nodes).map((node) => [node.key, node])), [layout]);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    const root = svg?.closest<HTMLElement>(".cjm-grid");
    if (!svg || !root || typeof ResizeObserver === "undefined") return;
    const elements = [...root.querySelectorAll<HTMLElement>("[data-cjm-node]")];
    const labels = [...root.querySelectorAll<HTMLElement>("[data-cjm-lane]")];
    const measure = () => {
      const rootRect = root.getBoundingClientRect();
      const byKey = new Map(elements.map((element) => [element.dataset.cjmNode!, element]));
      const samples = elements.map((element) => {
        const node = nodes.get(element.dataset.cjmNode!);
        const rect = element.getBoundingClientRect();
        return node ? { node, rect } : null;
      }).filter((sample): sample is { node: CjmNode; rect: DOMRect } => sample !== null);
      if (!samples.length) return;
      const columnGap = Number.parseFloat(getComputedStyle(root).columnGap) || routing.columnGap;
      const width = samples[0]!.rect.width;
      const pitch = width + columnGap;
      const originX = samples[0]!.rect.left - rootRect.left + width / 2 - samples[0]!.node.column * pitch;
      const laneRects = new Map(labels.map((label) => [Number(label.dataset.cjmLane), label.getBoundingClientRect()]));
      const logicalPoint = (point: LogicalPoint) => {
        const nearestColumn = Math.round(point.x);
        const x = Math.abs(point.x - nearestColumn) < 0.34
          ? originX + point.x * pitch
          : originX + (Math.floor(point.x) + 0.5) * pitch + ((point.x - (Math.floor(point.x) + 0.5)) / CHANNEL_STEP) * 8;
        const nearestLane = Math.round(point.y);
        if (Math.abs(point.y - nearestLane) < 0.34) {
          const row = laneRects.get(nearestLane);
          return { x, y: row ? row.top - rootRect.top + row.height / 2 : 0 };
        }
        const gutter = Math.floor(point.y);
        const before = laneRects.get(gutter);
        const after = laneRects.get(gutter + 1);
        const center = before && after
          ? (before.bottom + after.top) / 2 - rootRect.top
          : before
            ? before.bottom - rootRect.top + routing.rowGap / 2
            : after
              ? after.top - rootRect.top - routing.rowGap / 2
              : 0;
        return { x, y: center + ((point.y - (gutter + 0.5)) / CHANNEL_STEP) * 8 };
      };
      setPixelRoutes(routing.routes.flatMap((route) => {
        const from = byKey.get(route.edge.from)?.getBoundingClientRect();
        const to = byKey.get(route.edge.to)?.getBoundingClientRect();
        if (!from || !to) return [];
        const points = route.points.map(logicalPoint);
        points[0] = portPoint(from, rootRect, route.startPort);
        points[points.length - 1] = portPoint(to, rootRect, route.endPort);
        if ((route.startPort === "left" || route.startPort === "right") && (route.endPort === "left" || route.endPort === "right") && points.length === 4) {
          points[1]!.y = points[0]!.y;
          points[2]!.y = points[3]!.y;
        }
        const middle = points[Math.floor(points.length / 2)]!;
        return [{ key: route.edge.key, points: points.map((point) => `${point.x},${point.y}`).join(" "), middle }];
      }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const element of [...elements, ...labels]) observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [layout, nodes, routing]);
  const edgeByKey = useMemo(() => new Map(layout.edges.map((edge) => [edge.key, edge])), [layout.edges]);
  return <>
    <svg ref={svgRef} className="cjm-edges-overlay pointer-events-none absolute inset-0 z-10 overflow-visible" aria-hidden="true">
      <defs>
        <marker id="cjm-edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="none" stroke="context-stroke" strokeWidth="1.5" /></marker>
      </defs>
      {pixelRoutes.map((route) => {
        const edge = edgeByKey.get(route.key)!;
        const from = nodes.get(edge.from)?.screenId ?? edge.from;
        const to = nodes.get(edge.to)?.screenId ?? edge.to;
        return <g key={route.key} data-edge-kind={edge.kind} data-verified={edge.verified} data-from={edge.from} data-to={edge.to}>
          <title>{cjm.edgeTitle(from, to, edge.kind, edge.verified)}</title>
          <polyline className="cjm-flow-edge" points={route.points} fill="none" markerEnd="url(#cjm-edge-arrow)" />
          {edge.verified === "missing" ? <text className="cjm-edge-warning" x={route.middle.x} y={route.middle.y} textAnchor="middle" dominantBaseline="central">!</text> : null}
        </g>;
      })}
    </svg>
    <ul className="sr-only" aria-label={cjm.edgesAria}>
      {layout.edges.map((edge) => <li key={edge.key}>{cjm.edgeDescription(nodes.get(edge.from)?.screenId ?? edge.from, nodes.get(edge.to)?.screenId ?? edge.to, edge.kind, edge.verified)}</li>)}
    </ul>
  </>;
}
