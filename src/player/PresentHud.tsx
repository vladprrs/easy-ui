import { useCallback, useEffect, useRef } from "react";
import { Link } from "react-router";
import { player, present, presentHud } from "../app/strings/player";
import type { PlayerNavigation } from "./navigation";

const autoCloseMs = 4_000;
const safeAreaPosition = {
  bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))",
  right: "calc(0.75rem + env(safe-area-inset-right, 0px))",
} as const;

export interface PresentHudProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigation: Pick<PlayerNavigation, "restart">;
  current: number;
  total: number;
  exitPath: string;
  directEntry: boolean;
  share: boolean;
}

export function PresentHud({ open, onOpenChange, navigation, current, total, exitPath, directEntry, share }: PresentHudProps) {
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearAutoClose = useCallback(() => {
    if (autoCloseRef.current !== null) clearTimeout(autoCloseRef.current);
    autoCloseRef.current = null;
  }, []);
  const scheduleAutoClose = useCallback(() => {
    clearAutoClose();
    autoCloseRef.current = setTimeout(() => onOpenChange(false), autoCloseMs);
  }, [clearAutoClose, onOpenChange]);

  useEffect(() => {
    if (open) scheduleAutoClose();
    else clearAutoClose();
    return clearAutoClose;
  }, [clearAutoClose, open, scheduleAutoClose]);

  return <div data-testid="present-hud" className="pointer-events-none fixed inset-0 z-40 font-eui-ui">
    {open ? <section
      role="dialog"
      aria-label={presentHud.panelAria}
      className="pointer-events-auto absolute z-40 flex items-center gap-2 rounded-2xl bg-eui-graphite/95 p-2 text-sm text-white shadow-xl ring-1 ring-white/20"
      style={safeAreaPosition}
      onPointerDownCapture={scheduleAutoClose}
      onKeyDownCapture={scheduleAutoClose}
      onFocusCapture={scheduleAutoClose}
    >
      <button type="button" onClick={navigation.restart} className="rounded-full px-3 py-2 font-semibold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80">
        {player.restart}
      </button>
      <span className="whitespace-nowrap px-1 tabular-nums text-eui-ondark-2">{present.counter(current, total)}</span>
      {!share && <Link to={exitPath} className="whitespace-nowrap rounded-full px-3 py-2 font-semibold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80">
        {directEntry ? present.openInApp : presentHud.returnToPlayer}
      </Link>}
      <button type="button" aria-label={presentHud.close} title={presentHud.close} onClick={() => onOpenChange(false)} className="grid size-9 shrink-0 place-items-center rounded-full text-xl leading-none text-eui-ondark-2 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80">
        <span aria-hidden="true">×</span>
      </button>
    </section> : <button
      type="button"
      aria-label={presentHud.fabAria}
      title={presentHud.fabAria}
      onClick={() => onOpenChange(true)}
      className="pointer-events-auto absolute z-40 grid size-9 place-items-center rounded-full bg-eui-graphite/90 text-lg leading-none text-white shadow-lg ring-1 ring-white/25 hover:bg-eui-graphite focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-eui-brand"
      style={safeAreaPosition}
    >
      <span aria-hidden="true">•••</span>
    </button>}
  </div>;
}
