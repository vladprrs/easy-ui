import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildScreenArchitectureTree,
  flattenArchitectureNodes,
  type ArchitectureNode,
  type BuildScreenTreeOptions,
  type ScreenSpec,
} from "../architecture/screenTree";
import { editor } from "../app/strings/editor";

/**
 * Дерево компонентов экрана в инспекторе редактора (волна 1, план 2026-07-27 §«Волна 1»).
 *
 * Наследует поведение прежнего `ElementTree` (aria-current, чевроны сворачивания,
 * бейдж региона, `<details>` для сирот, автоскролл к выбранному) и добавляет
 * архитектурные бейджи, маркер issue и раскрываемую детализацию выбранного узла.
 */

export interface ComponentTreeInspectorProps extends BuildScreenTreeOptions {
  spec: ScreenSpec;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

const badge = "shrink-0 rounded-full px-1.5 py-0.5 font-eui-ui text-[10px] font-medium";
const badgeNeutral = `${badge} bg-eui-lav text-eui-slate-500`;
const badgeAccent = `${badge} bg-eui-lilac-100 text-eui-purple`;
const badgeWarn = `${badge} bg-amber-100 text-amber-800`;

const WARNING_STATUSES = new Set(["deprecated", "superseded", "archived", "rejected"]);

const fmt = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined) return "—";
  const json = JSON.stringify(value);
  return json ?? String(value);
};
const clamp = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}…` : text);

function NodeBadges({ node }: { node: ArchitectureNode }) {
  const level = node.scope ?? node.atomicLevel;
  return <>
    {node.region ? <span className={badgeAccent} title={editor.regionBadge(node.region)}>{node.region}</span> : null}
    {level ? <span className={badgeAccent} title={node.scope ? editor.scopeTitle(node.scope) : editor.atomicTitle(level)}>{level}</span> : null}
    {node.version !== undefined ? <span className={badgeNeutral} title={editor.versionTitle(node.version)}>{editor.versionBadge(node.version)}</span> : null}
    {node.status && WARNING_STATUSES.has(node.status)
      ? <span className={badgeWarn} title={editor.statusTitle(node.status)}>{node.status}</span> : null}
    <span
      className={badgeNeutral}
      title={node.source === "host" ? editor.sourceHostTitle : editor.sourceCustomTitle}
    >{node.source === "host" ? editor.sourceHost : editor.sourceCustom}</span>
    {node.unresolved ? <span className={badgeWarn} title={editor.unresolvedTitle}>{editor.unresolvedBadge}</span> : null}
    {node.issues.length ? <span className={badgeWarn} title={editor.issueMarkerTitle(node.issues.length)} data-testid={`tree-issue-${node.key}`}>{editor.issueMarker}</span> : null}
  </>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div className="flex gap-2"><dt className="shrink-0 text-eui-slate-500">{label}</dt><dd className="min-w-0 break-words text-eui-ink">{value}</dd></div>;
}

function NodeDetails({ node }: { node: ArchitectureNode }) {
  return <details className="mt-3 rounded-xl bg-eui-lav p-3">
    <summary className="cursor-pointer font-eui-ui text-xs font-medium text-eui-slate-500">{editor.nodeDetailsSummary}</summary>
    <div className="mt-2 space-y-3 font-eui-ui text-xs">
      <section>
        <h4 className="mb-1 font-medium text-eui-ink">{editor.provenanceTitle}</h4>
        <dl className="space-y-0.5">
          <DetailRow label={editor.provenanceSource} value={node.source === "host" ? editor.sourceHost : editor.sourceCustom} />
          {node.scope ? <DetailRow label={editor.provenanceScope} value={node.scope} /> : null}
          {node.atomicLevel ? <DetailRow label={editor.provenanceAtomic} value={node.atomicLevel} /> : null}
          {node.version !== undefined ? <DetailRow label={editor.provenanceVersion} value={editor.versionBadge(node.version)} /> : null}
          {node.status ? <DetailRow label={editor.provenanceStatus} value={node.status} /> : null}
          {node.region ? <DetailRow label={editor.provenanceRegion} value={node.region} /> : null}
          {node.slot ? <DetailRow label={editor.provenanceSlot} value={node.slot} /> : null}
          {node.canonicalFor?.length ? <DetailRow label={editor.provenanceCanonicalFor} value={node.canonicalFor.join(", ")} /> : null}
          {node.sourceBounded ? <DetailRow label={editor.provenanceSourceBounded} value={editor.provenanceYes} /> : null}
          {node.replacement ? <DetailRow label={editor.provenanceReplacement} value={node.replacement} /> : null}
        </dl>
        {node.componentId ? <a
          className="mt-2 inline-block font-medium text-eui-brand underline-offset-2 hover:underline"
          href={`/library/c/${encodeURIComponent(node.componentId)}${node.version === undefined ? "" : `?v=${node.version}`}`}
          target="_blank"
          rel="noreferrer"
        >{editor.libraryLink}</a> : null}
      </section>
      {node.issues.length ? <section>
        <h4 className="mb-1 font-medium text-eui-ink">{editor.nodeIssuesTitle}</h4>
        <ul className="list-disc space-y-0.5 pl-4">
          {node.issues.map((issue, index) => <li key={`${issue.path ?? ""}:${index}`} className={issue.severity === "error" ? "text-eui-magenta" : "text-amber-800"}>{issue.message}</li>)}
        </ul>
      </section> : null}
      <section>
        <h4 className="mb-1 font-medium text-eui-ink">{editor.propsDiffTitle}</h4>
        <p className="mb-1 text-eui-slate-400">{editor.propsDiffHint}</p>
        {node.propsDiff.length === 0
          ? <p className="text-eui-slate-500">{editor.propsDiffEmpty}</p>
          : <ul className="space-y-1">{node.propsDiff.map((entry) => <li key={entry.name} className="break-words">
            <span className="font-mono text-eui-ink">{entry.name}</span>{" = "}
            <span className="font-mono text-eui-ink">{clamp(fmt(entry.value))}</span>
            <span className="ml-1 text-eui-slate-500">
              {entry.unknownProp ? `(${editor.propUnknown})`
                : entry.hasDeclaredDefault ? `(${editor.propDefaultValue(clamp(fmt(entry.defaultValue)))})`
                  : `(${editor.propNoDefault})`}
            </span>
          </li>)}</ul>}
      </section>
    </div>
  </details>;
}

export function ComponentTreeInspector({ spec, selectedKey, onSelect, definitions, pins, issues }: ComponentTreeInspectorProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const orphanDetailsRef = useRef<HTMLDetailsElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useMemo(
    () => buildScreenArchitectureTree(spec, { definitions, pins, issues }),
    [spec, definitions, pins, issues],
  );
  const rows = useMemo(() => flattenArchitectureNodes(tree.roots), [tree]);
  const orphanRows = useMemo(() => flattenArchitectureNodes(tree.orphans), [tree]);
  const selectedNode = selectedKey === null ? undefined : tree.byKey.get(selectedKey);
  const selectedAncestors = selectedNode?.ancestors ?? [];
  const isCollapsed = (key: string) => collapsed.has(key) && !selectedAncestors.includes(key);

  useEffect(() => {
    if (!selectedKey) return;
    if (orphanRows.some(({ key }) => key === selectedKey) && orphanDetailsRef.current) orphanDetailsRef.current.open = true;
  }, [orphanRows, selectedKey]);

  useEffect(() => { selectedRef.current?.scrollIntoView?.({ block: "nearest" }); }, [collapsed, selectedKey]);

  if (Object.keys(spec.elements).length === 0) return <p className="font-eui-ui text-sm text-eui-slate-500">{editor.emptyScreen}</p>;

  const visible = (node: ArchitectureNode) => !node.ancestors.some(isCollapsed);
  const row = (node: ArchitectureNode) => {
    const hasChildren = node.children.length > 0;
    const expanded = !isCollapsed(node.key);
    return <li key={node.key} style={{ paddingLeft: `${node.depth * 16}px` }}>
      <div className="flex min-w-0 items-center gap-0.5">
        {hasChildren ? <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? editor.collapseElement(node.type) : editor.expandElement(node.type)}
          onClick={() => {
            if (expanded && selectedKey && selectedAncestors.includes(node.key)) onSelect(node.key);
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
        >{node.type} · {node.key}</button>
        <NodeBadges node={node} />
      </div>
      {selectedKey === node.key ? <NodeDetails node={node} /> : null}
    </li>;
  };

  return <div aria-label={editor.treeAria}>
    <ul className="space-y-0.5">{rows.filter(visible).map(row)}</ul>
    {orphanRows.length ? <details ref={orphanDetailsRef} className="mt-2">
      <summary className="cursor-pointer font-eui-ui text-sm font-medium text-eui-slate-500">{editor.orphans(orphanRows.length)}</summary>
      <ul className="mt-1 space-y-0.5">{orphanRows.filter(visible).map(row)}</ul>
    </details> : null}
  </div>;
}
