import { verifyEdge, type EdgeVerification, type NavigationGraph } from "../prototype/navigationGraph";
import type { Flow, PrototypeDoc } from "../prototype/schema";

export interface CjmNode {
  key: string;
  screenId: string;
  note?: string;
  column: number;
  lane: number;
  anchor: boolean;
}

export interface CjmEdge {
  key: string;
  from: string;
  to: string;
  kind: "main" | "fork" | "branch" | "return";
  verified: EdgeVerification;
}

export interface CjmLane {
  key: string;
  name: string | null;
  description?: string;
  nodes: CjmNode[];
}

export interface CjmLayout {
  lanes: CjmLane[];
  edges: CjmEdge[];
  columns: number;
  linear: boolean;
  unassigned: string[];
  tileCount: number;
}

interface Segment {
  start: number;
  end: number;
  length: number;
  gap: number;
  leading: boolean;
  anchorless: boolean;
  columns: number[];
}

const laneKey = (flow: Flow) => `flow:${flow.id}`;
const nodeKey = (lane: string, stepIndex: number) => `${lane}:${stepIndex}`;
const mainEdgeKey = (stepIndex: number) => `main:${stepIndex}`;

function collectSegments(flow: Flow, mainIndexes: ReadonlyMap<string, number>): Segment[] {
  const segments: Segment[] = [];
  let start: number | null = null;
  for (let index = 0; index <= flow.steps.length; index += 1) {
    const anchor = index < flow.steps.length && mainIndexes.has(flow.steps[index]!.screenId);
    if (!anchor && index < flow.steps.length) {
      start ??= index;
      continue;
    }
    if (start === null) continue;
    const end = index - 1;
    const forkIndex = start > 0 ? mainIndexes.get(flow.steps[start - 1]!.screenId) : undefined;
    const returnIndex = index < flow.steps.length ? mainIndexes.get(flow.steps[index]!.screenId) : undefined;
    const anchorless = forkIndex === undefined && returnIndex === undefined;
    segments.push({
      start,
      end,
      length: end - start + 1,
      gap: forkIndex ?? ((returnIndex ?? 0) - 1),
      leading: forkIndex === undefined && returnIndex !== undefined,
      anchorless,
      columns: [],
    });
    start = null;
  }
  return segments;
}

function gapStart(gap: number, gapWidths: ReadonlyMap<number, number>): number {
  let precedingWidth = 0;
  for (const [candidate, width] of gapWidths) {
    if (candidate < gap) precedingWidth += width;
  }
  return gap + 1 + precedingWidth;
}

/** Computes scenario-lane geometry. The input must already be a parsed PrototypeDoc. */
export function computeCjmLanes(doc: PrototypeDoc, graph: NavigationGraph): CjmLayout {
  if (!doc.flows) {
    const lane = "synthetic:main";
    const nodes = doc.screens.map<CjmNode>((screen, index) => ({
      key: nodeKey(lane, index),
      screenId: screen.id,
      note: screen.note,
      column: index,
      lane: 0,
      anchor: true,
    }));
    return {
      lanes: [{ key: lane, name: null, nodes }],
      edges: nodes.slice(0, -1).map((node, index) => ({
        key: mainEdgeKey(index),
        from: node.key,
        to: nodes[index + 1]!.key,
        kind: "main",
        verified: verifyEdge(graph, node.screenId, nodes[index + 1]!.screenId),
      })),
      columns: nodes.length,
      linear: true,
      unassigned: [],
      tileCount: nodes.length,
    };
  }

  const [main, ...branches] = doc.flows;
  const mainIndexes = new Map(main!.steps.map((step, index) => [step.screenId, index]));
  const branchSegments = branches.map((flow) => collectSegments(flow, mainIndexes));
  const gapWidths = new Map<number, number>();

  branchSegments.forEach((segments) => {
    const footprint = new Map<number, number>();
    for (const segment of segments) {
      footprint.set(segment.gap, (footprint.get(segment.gap) ?? 0) + segment.length);
    }
    for (const [gap, width] of footprint) {
      gapWidths.set(gap, Math.max(gapWidths.get(gap) ?? 0, width));
    }
  });

  branchSegments.forEach((segments) => {
    const byGap = new Map<number, Segment[]>();
    for (const segment of segments) {
      const current = byGap.get(segment.gap) ?? [];
      current.push(segment);
      byGap.set(segment.gap, current);
    }
    for (const [gap, inGap] of byGap) {
      const start = gapStart(gap, gapWidths);
      const width = gapWidths.get(gap)!;
      let left = start;
      let right = start + width;
      for (const segment of inGap.filter((item) => !item.leading).sort((a, b) => a.start - b.start)) {
        segment.columns = Array.from({ length: segment.length }, (_, offset) => left + offset);
        left += segment.length;
      }
      for (const segment of inGap.filter((item) => item.leading).sort((a, b) => b.start - a.start)) {
        right -= segment.length;
        segment.columns = Array.from({ length: segment.length }, (_, offset) => right + offset);
      }
    }
  });

  const mainColumn = (index: number) => {
    let inserted = 0;
    for (const [gap, width] of gapWidths) {
      if (gap < index) inserted += width;
    }
    return index + inserted;
  };
  const mainLaneKey = laneKey(main!);
  const mainNodes = main!.steps.map<CjmNode>((step, index) => ({
    key: nodeKey(mainLaneKey, index),
    screenId: step.screenId,
    column: mainColumn(index),
    lane: 0,
    anchor: true,
  }));
  const lanes: CjmLane[] = [{
    key: mainLaneKey,
    name: main!.name,
    description: main!.description,
    nodes: mainNodes,
  }];

  branches.forEach((flow, branchIndex) => {
    const key = laneKey(flow);
    const segmentByStep = new Map<number, { segment: Segment; offset: number }>();
    for (const segment of branchSegments[branchIndex]!) {
      for (let step = segment.start; step <= segment.end; step += 1) {
        segmentByStep.set(step, { segment, offset: step - segment.start });
      }
    }
    const nodes: CjmNode[] = [];
    flow.steps.forEach((step, stepIndex) => {
      const allocation = segmentByStep.get(stepIndex);
      if (!allocation) return;
      nodes.push({
        key: nodeKey(key, stepIndex),
        screenId: step.screenId,
        note: step.note,
        column: allocation.segment.columns[allocation.offset]!,
        lane: branchIndex + 1,
        anchor: false,
      });
    });
    lanes.push({ key, name: flow.name, description: flow.description, nodes });
  });

  const edges: CjmEdge[] = mainNodes.slice(0, -1).map((node, index) => ({
    key: mainEdgeKey(index),
    from: node.key,
    to: mainNodes[index + 1]!.key,
    kind: "main",
    verified: verifyEdge(graph, node.screenId, mainNodes[index + 1]!.screenId),
  }));
  branches.forEach((flow) => {
    const key = laneKey(flow);
    for (let stepIndex = 0; stepIndex < flow.steps.length - 1; stepIndex += 1) {
      const fromStep = flow.steps[stepIndex]!;
      const toStep = flow.steps[stepIndex + 1]!;
      const fromAnchor = mainIndexes.get(fromStep.screenId);
      const toAnchor = mainIndexes.get(toStep.screenId);
      if (fromAnchor !== undefined && toAnchor !== undefined) continue;
      edges.push({
        key: `${key}:${stepIndex}`,
        from: fromAnchor === undefined ? nodeKey(key, stepIndex) : mainNodes[fromAnchor]!.key,
        to: toAnchor === undefined ? nodeKey(key, stepIndex + 1) : mainNodes[toAnchor]!.key,
        kind: fromAnchor !== undefined ? "fork" : toAnchor !== undefined ? "return" : "branch",
        verified: verifyEdge(graph, fromStep.screenId, toStep.screenId),
      });
    }
  });

  const assigned = new Set(doc.flows.flatMap((flow) => flow.steps.map((step) => step.screenId)));
  const unassigned = doc.screens.filter((screen) => !assigned.has(screen.id)).map((screen) => screen.id);
  const insertedColumns = [...gapWidths.values()].reduce((sum, width) => sum + width, 0);
  return {
    lanes,
    edges,
    columns: main!.steps.length + insertedColumns,
    linear: false,
    unassigned,
    tileCount: lanes.reduce((sum, lane) => sum + lane.nodes.length, 0),
  };
}
