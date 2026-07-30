import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { FlowTreeNode } from "../prototype/flowGraph";

/**
 * Дерево сценариев (план `docs/plans/2026-07-29-scrn-gallery-ux.md` §7 T2b).
 *
 * Один компонент на двух поверхностях: слева в режиме «Сценарии» (`/p/:id/cjm`) и
 * поповером в `ScenarioBar` плеера — поэтому он ничего не знает ни про URL, ни про
 * скролл: наружу торчат только `activeFlowId` и `onActivate`.
 *
 * A11y — паттерн WAI-ARIA «tree»: `role="tree"` на корневом списке, `role="treeitem"`
 * на самих `li`, вложенные списки `role="group"`, `aria-level`/`aria-expanded`/
 * `aria-current`, roving tabindex и навигация стрелками (↑↓ по видимым узлам,
 * → раскрыть/войти, ← свернуть/к родителю, Home/End, Enter/Space — активация).
 */

export interface FlowTreeProps {
  roots: readonly FlowTreeNode[];
  /** Сценарий, на котором стоит `aria-current`; `null` — ни один. */
  activeFlowId: string | null;
  onActivate: (flowId: string) => void;
  label: string;
  className?: string;
}

/** Видимые узлы в порядке DFS: дети свёрнутого узла в обход не попадают. */
function visibleNodes(roots: readonly FlowTreeNode[], collapsed: ReadonlySet<string>): FlowTreeNode[] {
  const result: FlowTreeNode[] = [];
  const visit = (node: FlowTreeNode) => {
    result.push(node);
    if (!collapsed.has(node.flow.id)) node.children.forEach(visit);
  };
  roots.forEach(visit);
  return result;
}

export function FlowTree({ roots, activeFlowId, onActivate, label, className }: FlowTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(() => visibleNodes(roots, collapsed), [collapsed, roots]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const visibleIds = new Set(items.map((node) => node.flow.id));
  // Roving tabindex: в таб-порядок попадает ровно один элемент дерева.
  const tabbableId = (focusId !== null && visibleIds.has(focusId) ? focusId : null)
    ?? (activeFlowId !== null && visibleIds.has(activeFlowId) ? activeFlowId : null)
    ?? items[0]?.flow.id
    ?? null;

  const focusNode = useCallback((flowId: string | undefined) => {
    if (flowId === undefined) return;
    setFocusId(flowId);
    itemRefs.current.get(flowId)?.focus();
  }, []);

  const setCollapsedFor = useCallback((flowId: string, next: boolean) => {
    setCollapsed((current) => {
      const draft = new Set(current);
      if (next) draft.add(flowId); else draft.delete(flowId);
      return draft;
    });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, node: FlowTreeNode) => {
    const index = items.findIndex((item) => item.flow.id === node.flow.id);
    const isCollapsed = collapsed.has(node.flow.id);
    switch (event.key) {
      case "ArrowDown": focusNode(items[index + 1]?.flow.id); break;
      case "ArrowUp": focusNode(items[index - 1]?.flow.id); break;
      case "ArrowRight":
        if (node.children.length === 0) return;
        if (isCollapsed) setCollapsedFor(node.flow.id, false);
        else focusNode(node.children[0]!.flow.id);
        break;
      case "ArrowLeft":
        if (node.children.length > 0 && !isCollapsed) setCollapsedFor(node.flow.id, true);
        else focusNode(node.path.length > 1 ? node.path[node.path.length - 2] : undefined);
        break;
      case "Home": focusNode(items[0]?.flow.id); break;
      case "End": focusNode(items[items.length - 1]?.flow.id); break;
      case "Enter": case " ": onActivate(node.flow.id); break;
      default: return;
    }
    // Событие всплывает по вложенным `li`: без остановки предок обработал бы его повторно.
    event.preventDefault();
    event.stopPropagation();
  };

  const onClick = (event: MouseEvent<HTMLLIElement>, node: FlowTreeNode) => {
    event.stopPropagation();
    setFocusId(node.flow.id);
    onActivate(node.flow.id);
  };

  const renderNodes = (nodes: readonly FlowTreeNode[], group: boolean) => <ul
    role={group ? "group" : "tree"}
    aria-label={group ? undefined : label}
    className={group ? undefined : `cjm-flow-tree ${className ?? ""}`}
  >
    {nodes.map((node) => {
      const isCollapsed = collapsed.has(node.flow.id);
      const active = node.flow.id === activeFlowId;
      return <li
        key={node.flow.id}
        role="treeitem"
        ref={(element) => {
          if (element) itemRefs.current.set(node.flow.id, element);
          else itemRefs.current.delete(node.flow.id);
        }}
        data-flow-id={node.flow.id}
        data-flow-depth={node.depth}
        aria-level={node.depth}
        aria-expanded={node.children.length === 0 ? undefined : !isCollapsed}
        aria-current={active ? "true" : undefined}
        tabIndex={node.flow.id === tabbableId ? 0 : -1}
        onKeyDown={(event) => onKeyDown(event, node)}
        onFocus={(event) => { event.stopPropagation(); setFocusId(node.flow.id); }}
        onClick={(event) => onClick(event, node)}
        className="cjm-flow-tree-item rounded-field"
      >
        <span
          // Глубина читается отступом 18px на уровень (макет 02), сам пункт —
          // пилюля радиуса 14 с паддингом 9/12.
          style={{ paddingInlineStart: 12 + (node.depth - 1) * 18 }}
          className={`flex cursor-pointer items-center gap-1.5 rounded-field py-[9px] pr-3 text-sm transition-colors duration-100 ${active ? "bg-pay-lavender font-medium text-eui-ink" : "text-eui-ink hover:bg-pay-lavender-tint"}`}
        >
          {/* Каретка: hit-area 24×24 вместо голого глифа 10px — попасть в неё пальцем
              было нельзя. Признак раскрытия — смена глифа `▸`→`▾` (S5), вращения нет:
              бренд не даёт моушена. Состояние дублируется в `aria-expanded` на `li`,
              поэтому сама каретка для скринридера скрыта. Листья получают распорку
              того же размера, иначе их подписи разъезжаются с подписями веток. */}
          {node.children.length === 0
            ? <span aria-hidden="true" className="h-6 w-6 shrink-0" />
            : <span
              aria-hidden="true"
              className="grid h-6 w-6 shrink-0 place-items-center text-eui-slate-400"
              onClick={(event) => { event.stopPropagation(); setCollapsedFor(node.flow.id, !isCollapsed); }}
            >{isCollapsed ? "▸" : "▾"}</span>}
          <span className="min-w-0 flex-1 truncate" title={node.flow.name}>{node.flow.name}</span>
          <span aria-hidden="true" className={`shrink-0 text-xs tabular-nums ${active ? "text-pay-red" : "text-eui-slate-400"}`}>{node.flow.steps.length}</span>
        </span>
        {node.children.length === 0 || isCollapsed ? null : renderNodes(node.children, true)}
      </li>;
    })}
  </ul>;

  return renderNodes(roots, false);
}
