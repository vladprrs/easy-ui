import { useEffect, useMemo, useRef, useState } from "react";
import { EUI_KEY_ATTRIBUTE } from "../../catalog/runtime";
import type { ComponentDefinition } from "../../catalog/definitions";
import {
  buildScreenArchitectureTree,
  flattenArchitectureNodes,
  type ArchitectureNode,
  type ComponentPinInfo,
  type ScreenSpec,
} from "../../architecture/screenTree";
import { inspector } from "../../app/strings/player";
import { HighlightLayer, measureMarkerRects, type HighlightRect } from "../ScreenSurface";

/**
 * Вкладка «Дерево» debug-инспектора плеера (волна 1, план 2026-07-27 §«Волна 1»).
 *
 * Показывает архитектурное дерево authored-спеки экрана, подсвечивает DOM-узлы по
 * `data-eui-key` (общая механика с misclick-хинтами — `measureMarkerRects` /
 * `HighlightLayer` из `ScreenSurface`) и выбирает узел по клику в прототипе.
 * Слушатель клика живёт ровно столько, сколько открыта вкладка, и никогда не
 * гасит событие — интерактивность прототипа не меняется.
 */

const markerSelector = `[${EUI_KEY_ATTRIBUTE}]`;

const badge = "shrink-0 rounded px-1 text-[10px] leading-4";
const badgeMuted = `${badge} bg-white/10 text-white/60`;
const badgeAccent = `${badge} bg-eui-brand/30 text-white`;

function useMarkerRects(key: string | null): HighlightRect[] {
  const [rects, setRects] = useState<HighlightRect[]>([]);
  useEffect(() => {
    // Замер — чтение layout: делаем его в кадре после коммита, чтобы не гонять
    // каскадные рендеры и не читать DOM до отрисовки выбранного экрана.
    const measure = () => setRects(key === null ? [] : measureMarkerRects(document, new Set([key])));
    let frame = requestAnimationFrame(measure);
    const remeasure = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [key]);
  return rects;
}

function NodeDetail({ node, rects }: { node: ArchitectureNode; rects: readonly HighlightRect[] }) {
  const first = rects[0];
  return <section className="border-t border-white/15 px-3 py-2" data-testid="inspector-tree-detail">
    <div className="mb-1 font-semibold break-all">{node.type} · {node.key}</div>
    <div className="text-white/60">
      {first
        ? <>{inspector.treeRectLabel}: <span className="text-white">{inspector.treeRect(Math.round(first.width), Math.round(first.height))}</span>{rects.length > 1 ? ` · ${inspector.treeRectInstances(rects.length)}` : ""}</>
        : inspector.treeNotRendered}
    </div>
    <dl className="mt-1 space-y-0.5 text-white/60">
      {node.region ? <div><dt className="inline">{inspector.treeRegion}: </dt><dd className="inline text-white">{node.region}</dd></div> : null}
      {node.slot ? <div><dt className="inline">{inspector.treeSlot}: </dt><dd className="inline text-white">{node.slot}</dd></div> : null}
      {node.scope ? <div><dt className="inline">{inspector.treeScope}: </dt><dd className="inline text-white">{node.scope}</dd></div> : null}
      {node.atomicLevel ? <div><dt className="inline">{inspector.treeAtomic}: </dt><dd className="inline text-white">{node.atomicLevel}</dd></div> : null}
      {node.version !== undefined ? <div><dt className="inline">{inspector.treeVersion}: </dt><dd className="inline text-white">v{node.version}</dd></div> : null}
      {node.status ? <div><dt className="inline">{inspector.treeStatus}: </dt><dd className="inline text-white">{node.status}</dd></div> : null}
      <div><dt className="inline">{inspector.treePropsDiff}: </dt><dd className="inline break-all text-white">
        {node.propsDiff.length === 0 ? inspector.treePropsDiffEmpty : node.propsDiff.map((entry) => entry.name).join(", ")}
      </dd></div>
    </dl>
  </section>;
}

export function TreeTab({ spec, definitions, pins }: {
  spec?: ScreenSpec;
  definitions?: Record<string, ComponentDefinition>;
  pins?: readonly ComponentPinInfo[];
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const tree = useMemo(
    () => (spec ? buildScreenArchitectureTree(spec, { definitions, pins }) : null),
    [spec, definitions, pins],
  );
  const rows = useMemo(() => (tree ? flattenArchitectureNodes([...tree.roots, ...tree.orphans]) : []), [tree]);
  const activeKey = hoveredKey ?? selectedKey;
  const rects = useMarkerRects(activeKey);
  const selectedRects = useMarkerRects(selectedKey);

  // Выбор узла кликом по прототипу: capture-фаза, без preventDefault/stopPropagation —
  // обычное взаимодействие прототипа не меняется, а слушатель существует только
  // пока открыта вкладка «Дерево».
  useEffect(() => {
    if (!tree) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || listRef.current?.contains(target)) return;
      const key = target.closest(markerSelector)?.getAttribute(EUI_KEY_ATTRIBUTE);
      if (key !== null && key !== undefined && tree.byKey.has(key)) setSelectedKey(key);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [tree]);

  const selectedNode = selectedKey === null ? undefined : tree?.byKey.get(selectedKey);

  if (!tree) return <p className="px-3 py-2 text-white/50">{inspector.treeUnavailable}</p>;
  if (rows.length === 0) return <p className="px-3 py-2 text-white/50">{inspector.treeEmpty}</p>;

  return <>
    <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <p className="px-3 pt-2 text-white/40">{inspector.treeHint}</p>
      <ul aria-label={inspector.treeAria} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {rows.map((node) => <li key={node.key} style={{ paddingLeft: `${node.depth * 10}px` }}>
          <button
            type="button"
            aria-current={selectedKey === node.key ? "true" : undefined}
            onClick={() => setSelectedKey(node.key)}
            onMouseEnter={() => setHoveredKey(node.key)}
            onMouseLeave={() => setHoveredKey((current) => (current === node.key ? null : current))}
            onFocus={() => setHoveredKey(node.key)}
            onBlur={() => setHoveredKey((current) => (current === node.key ? null : current))}
            data-eui-tree-key={node.key}
            className="flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-white/10 aria-[current=true]:bg-white/20"
          >
            <span className="min-w-0 flex-1 truncate">{node.type} · {node.key}</span>
            {/* Бейджи дублируют детализацию узла — из доступного имени строки исключены. */}
            {node.region ? <span aria-hidden="true" className={badgeAccent}>{node.region}</span> : null}
            {node.scope ?? node.atomicLevel ? <span aria-hidden="true" className={badgeMuted}>{node.scope ?? node.atomicLevel}</span> : null}
            {node.version !== undefined ? <span aria-hidden="true" className={badgeMuted}>v{node.version}</span> : null}
            <span aria-hidden="true" className={badgeMuted}>{node.source === "host" ? inspector.treeHost : inspector.treeCustom}</span>
          </button>
        </li>)}
      </ul>
      {selectedNode ? <NodeDetail node={selectedNode} rects={selectedRects} /> : null}
    </div>
    <HighlightLayer
      rects={rects}
      testId="inspector-tree-highlights"
      className="rounded border-2 border-eui-brand bg-eui-brand/20 shadow-[0_0_0_1px_rgba(255,255,255,0.65)]"
    />
  </>;
}
