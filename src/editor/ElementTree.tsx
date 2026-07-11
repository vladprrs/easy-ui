import { useEffect, useMemo, useRef } from "react";
import type { PrototypeDoc } from "../prototype/schema";

type Spec = PrototypeDoc["screens"][number]["spec"];

export function ElementTree({ spec, selectedKey, onSelect }: { spec: Spec; selectedKey: string | null; onSelect: (key: string) => void }) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const { tree, orphans } = useMemo(() => {
    const visited = new Set<string>();
    const ordered: string[] = [];
    const visit = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      if (!spec.elements[key]) return;
      ordered.push(key);
      for (const child of spec.elements[key]?.children ?? []) visit(child);
    };
    visit(spec.root);
    return { tree: ordered, orphans: Object.keys(spec.elements).filter((key) => !visited.has(key)) };
  }, [spec]);
  useEffect(() => { selectedRef.current?.scrollIntoView?.({ block: "nearest" }); }, [selectedKey]);
  if (Object.keys(spec.elements).length === 0) return <p className="font-eui-ui text-sm text-eui-slate-500">На экране пока нет элементов.</p>;
  const row = (key: string) => <li key={key}><button ref={selectedKey === key ? selectedRef : undefined} type="button" aria-current={selectedKey === key ? "true" : undefined} onClick={() => onSelect(key)} className="w-full rounded-lg px-2 py-1.5 text-left font-eui-ui text-sm text-eui-slate-500 hover:bg-eui-lilac-100 aria-[current=true]:bg-eui-lilac-100 aria-[current=true]:font-bold aria-[current=true]:text-eui-ink">{spec.elements[key]!.type} · {key}</button></li>;
  return <div><ul className="space-y-0.5">{tree.map(row)}</ul>{orphans.length ? <details className="mt-2"><summary className="cursor-pointer font-eui-ui text-sm font-medium text-eui-slate-500">Вне дерева ({orphans.length})</summary><ul className="mt-1 space-y-0.5">{orphans.map(row)}</ul></details> : null}</div>;
}
