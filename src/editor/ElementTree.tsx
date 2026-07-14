import { useEffect, useMemo, useRef, useState } from "react";
import type { PrototypeDoc } from "../prototype/schema";
import { editor } from "../app/strings/editor";

type Spec = PrototypeDoc["screens"][number]["spec"];

type TreeNode = {
  key: string;
  depth: number;
  ancestors: string[];
};

function buildForest(spec: Spec): { tree: TreeNode[]; orphans: TreeNode[] } {
  const visited = new Set<string>();
  const walk = (key: string, depth: number, ancestors: string[], target: TreeNode[]) => {
    if (visited.has(key) || !spec.elements[key]) return;
    visited.add(key);
    target.push({ key, depth, ancestors });
    for (const child of spec.elements[key].children ?? []) walk(child, depth + 1, [...ancestors, key], target);
  };

  const tree: TreeNode[] = [];
  const orphans: TreeNode[] = [];
  walk(spec.root, 0, [], tree);
  for (const key of Object.keys(spec.elements)) {
    if (!visited.has(key)) walk(key, 0, [], orphans);
  }
  return { tree, orphans };
}

/** Element keys from the root (or orphan-tree root) through the selected element. */
export function getElementPath(spec: Spec, selectedKey: string): string[] {
  const { tree, orphans } = buildForest(spec);
  const node = [...tree, ...orphans].find(({ key }) => key === selectedKey);
  return node ? [...node.ancestors, node.key] : [];
}

export function ElementTree({ spec, selectedKey, onSelect }: { spec: Spec; selectedKey: string | null; onSelect: (key: string) => void }) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const orphanDetailsRef = useRef<HTMLDetailsElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const forest = useMemo(() => buildForest(spec), [spec]);
  const nodes = useMemo(() => new Map([...forest.tree, ...forest.orphans].map((node) => [node.key, node])), [forest]);
  const selectedAncestors = selectedKey ? nodes.get(selectedKey)?.ancestors ?? [] : [];
  const isCollapsed = (key: string) => collapsed.has(key) && !selectedAncestors.includes(key);

  useEffect(() => {
    if (!selectedKey) return;
    if (forest.orphans.some(({ key }) => key === selectedKey) && orphanDetailsRef.current) orphanDetailsRef.current.open = true;
  }, [forest.orphans, selectedKey]);

  useEffect(() => { selectedRef.current?.scrollIntoView?.({ block: "nearest" }); }, [collapsed, selectedKey]);

  if (Object.keys(spec.elements).length === 0) return <p className="font-eui-ui text-sm text-eui-slate-500">{editor.emptyScreen}</p>;

  const visible = (node: TreeNode) => !node.ancestors.some(isCollapsed);
  const row = (node: TreeNode) => {
    const element = spec.elements[node.key]!;
    const hasChildren = (element.children?.some((key) => Boolean(spec.elements[key])) ?? false);
    const expanded = !isCollapsed(node.key);
    return <li key={node.key} style={{ paddingLeft: `${node.depth * 16}px` }}>
      <div className="flex min-w-0 items-center gap-0.5">
        {hasChildren ? <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? editor.collapseElement(element.type) : editor.expandElement(element.type)}
          onClick={() => {
            if (expanded && selectedKey && nodes.get(selectedKey)?.ancestors.includes(node.key)) onSelect(node.key);
            setCollapsed((current) => {
              const next = new Set(current);
              if (expanded) next.add(node.key); else next.delete(node.key);
              return next;
            });
          }}
          className="flex size-7 shrink-0 items-center justify-center rounded-md font-eui-ui text-eui-slate-500 hover:bg-eui-lilac-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-eui-purple"
        ><span aria-hidden="true" className={`transition-transform ${expanded ? "rotate-90" : ""}`}>›</span></button> : <span className="size-7 shrink-0" aria-hidden="true" />}
        <button
          ref={selectedKey === node.key ? selectedRef : undefined}
          type="button"
          aria-current={selectedKey === node.key ? "true" : undefined}
          onClick={() => onSelect(node.key)}
          className="min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left font-eui-ui text-sm text-eui-slate-500 hover:bg-eui-lilac-100 aria-[current=true]:bg-eui-lilac-100 aria-[current=true]:font-bold aria-[current=true]:text-eui-ink"
        >{element.type} · {node.key}</button>
      </div>
    </li>;
  };

  return <div>
    <ul className="space-y-0.5">{forest.tree.filter(visible).map(row)}</ul>
    {forest.orphans.length ? <details ref={orphanDetailsRef} className="mt-2">
      <summary className="cursor-pointer font-eui-ui text-sm font-medium text-eui-slate-500">{editor.orphans(forest.orphans.length)}</summary>
      <ul className="mt-1 space-y-0.5">{forest.orphans.filter(visible).map(row)}</ul>
    </details> : null}
  </div>;
}
