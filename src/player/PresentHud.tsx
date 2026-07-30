import { useCallback, useEffect, useRef } from "react";
import { Link } from "react-router";
import { player, present, presentHud } from "../app/strings/player";
import type { PlayerNavigation } from "./navigation";

const autoCloseMs = 4_000;
const safeAreaPosition = {
  bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))",
  right: "calc(0.75rem + env(safe-area-inset-right, 0px))",
} as const;

/** Пункт HUD: фокус — общий брендовый (красный outline из `styles/index.css`). */
const control = "whitespace-nowrap rounded-full px-3 py-2 font-medium transition-colors duration-100 hover:bg-white/10";

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

/**
 * Мини-HUD мобильной презентации. Под общий `Modal` (W0) не подводится осознанно
 * (решение m5): это оснастка поверх прототипа, а не модальное окно — она не
 * блокирует показ, не требует фокус-ловушки и закрывается сама.
 */
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
      aria-describedby="present-hud-hint"
      className="pointer-events-auto absolute z-40 flex flex-col rounded-inset bg-pay-deep/95 p-2 text-sm text-white"
      style={safeAreaPosition}
      onPointerDownCapture={scheduleAutoClose}
      onKeyDownCapture={scheduleAutoClose}
      onFocusCapture={scheduleAutoClose}
    >
      <div className="flex items-center gap-2">
        <button type="button" onClick={navigation.restart} className={control}>
          {player.restart}
        </button>
        <span className="whitespace-nowrap px-1 tabular-nums text-pay-lavender/70">{present.counter(current, total)}</span>
        {!share && <Link to={exitPath} className={control}>
          {directEntry ? present.openInApp : presentHud.returnToPlayer}
        </Link>}
        <button
          type="button"
          aria-label={presentHud.close}
          title={presentHud.close}
          onClick={() => onOpenChange(false)}
          className="grid size-9 shrink-0 place-items-center rounded-full leading-none text-pay-lavender/70 transition-colors duration-100 hover:bg-white/10 hover:text-white"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {/* Панель уезжает сама через 4 секунды простоя; без подписи это читалось
          как сбой, а способ вернуть её приходилось угадывать (W4-14). */}
      <p id="present-hud-hint" className="px-2 pb-0.5 pt-1 text-[11px] text-pay-lavender/70">{presentHud.autoHideHint}</p>
    </section> : <button
      type="button"
      aria-label={presentHud.fabAria}
      title={presentHud.fabAria}
      onClick={() => onOpenChange(true)}
      className="pointer-events-auto absolute z-40 grid size-9 place-items-center rounded-full bg-pay-deep/90 text-lg leading-none text-white transition-colors duration-100 hover:bg-pay-deep"
      style={safeAreaPosition}
    >
      <span aria-hidden="true">···</span>
    </button>}
  </div>;
}
