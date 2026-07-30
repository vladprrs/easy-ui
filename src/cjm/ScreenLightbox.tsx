import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { pillGhostOnDark } from "../app/chrome";
import { lightbox } from "../app/strings/cjm";
import { buildPlayerPath } from "../player/navigation";
import type { Flow, PrototypeDoc } from "../prototype/schema";
import { getCjmTransitions } from "./CjmScreenTile";

/**
 * Лайтбокс экрана (редизайн 2026-07-30, макет 03).
 *
 * Открывается кликом по тайлу ленты «Сценарии» и живёт целиком в сценарном
 * контексте: шаги листаются ←/→, Esc закрывает. Поверхность — сплошной тёмный
 * пурпур (единственная тёмная поверхность продукта), поэтому текст на ней
 * лавандовый, а выделенное — белое.
 *
 * Подписи целей переходов стоят карточками справа от телефона, а не рамками на
 * самом экране: тайл ленты рендерится инертным (события сняты), измерять на нём
 * зоны нечего. Рамки зон живут в плеере, где экран интерактивен (макет 04).
 */
export interface ScreenLightboxProps {
  doc: PrototypeDoc;
  flow: Flow;
  stepIndex: number;
  routeBase: string;
  zonesVisible: boolean;
  onToggleZones: () => void;
  onStep: (stepIndex: number) => void;
  onClose: () => void;
  /** Кадр экрана 330×640 — поставляет CjmView (живой рендер тайла). */
  renderStage: (screenId: string) => ReactNode;
}

const circle = "grid shrink-0 place-items-center rounded-full bg-pay-lavender/15 text-pay-lavender transition-colors duration-100 hover:bg-pay-lavender/25 disabled:opacity-30 disabled:hover:bg-pay-lavender/15";

export function ScreenLightbox(props: ScreenLightboxProps) {
  const { doc, flow, stepIndex, routeBase, zonesVisible, onToggleZones, onStep, onClose, renderStage } = props;
  const closeRef = useRef<HTMLButtonElement>(null);
  const step = flow.steps[stepIndex];
  const screen = doc.screens.find((item) => item.id === step?.screenId);
  const screenNames = new Map(doc.screens.map((item) => [item.id, item.name]));
  const flowScreens = new Set(flow.steps.map((item) => item.screenId));

  useEffect(() => { closeRef.current?.focus(); }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
      if (event.key === "ArrowLeft" && stepIndex > 0) { event.preventDefault(); onStep(stepIndex - 1); }
      if (event.key === "ArrowRight" && stepIndex < flow.steps.length - 1) { event.preventDefault(); onStep(stepIndex + 1); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flow.steps.length, onClose, onStep, stepIndex]);

  if (screen === undefined || step === undefined) return null;

  // Подписи целей: имя экрана-цели, его шаг в этом сценарии и принадлежность сценарию.
  const transitions = getCjmTransitions(screen, doc.screens).map((transition) => {
    if (transition.kind === "dynamic") return lightbox.targetComputed;
    const targetStep = flow.steps.findIndex((item) => item.screenId === transition.screenId);
    const parts = [lightbox.targetTo(transition.screenName)];
    if (targetStep >= 0) parts.push(lightbox.targetStep(targetStep + 1));
    parts.push(flowScreens.has(transition.screenId) ? lightbox.targetInFlow : lightbox.targetOtherFlow);
    return parts.join(" · ");
  });

  return <div
    role="dialog"
    aria-modal="true"
    aria-label={lightbox.aria(screen.name)}
    data-testid="screen-lightbox"
    className="fixed inset-5 z-50 flex flex-col overflow-hidden rounded-panel bg-pay-deep p-6 text-pay-lavender"
  >
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <nav aria-label={lightbox.breadcrumbAria} className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="truncate">{doc.name}</span>
        <span aria-hidden="true" className="text-pay-lavender/45">/</span>
        <span className="truncate">{flow.name}</span>
        <span aria-hidden="true" className="text-pay-lavender/45">/</span>
        <span className="truncate font-medium text-white">{screen.name}</span>
      </nav>
      <div className="ml-auto flex flex-wrap items-center gap-3 text-[13px]">
        <span>{lightbox.stepOf(stepIndex + 1, flow.steps.length)}</span>
        <button type="button" aria-pressed={zonesVisible} onClick={onToggleZones} className={`${pillGhostOnDark} px-3 py-1.5 text-[13px]`}>
          {lightbox.zonesToggle(zonesVisible)}
        </button>
        <Link className={`${pillGhostOnDark} px-3 py-1.5 text-[13px]`} to={`${buildPlayerPath(routeBase, screen.id)}?${new URLSearchParams({ flow: flow.id, step: String(stepIndex) })}`}>
          {lightbox.openInPlayer}
        </Link>
        <button ref={closeRef} type="button" aria-label={lightbox.close} title={lightbox.close} onClick={onClose} className={`${circle} h-9 w-9 text-lg leading-none`}>
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </header>

    <div className="flex min-h-0 flex-1 items-center justify-center gap-6 overflow-auto py-6">
      <button type="button" aria-label={lightbox.previous} disabled={stepIndex === 0} onClick={() => onStep(stepIndex - 1)} className={`${circle} h-13 w-13 text-xl leading-none max-sm:hidden`}>
        <span aria-hidden="true">←</span>
      </button>
      {renderStage(screen.id)}
      <div className="flex w-64 flex-col gap-2 max-lg:hidden">
        {zonesVisible && transitions.length ? transitions.map((label, index) => <p
          key={`${label}:${index}`}
          data-testid="lightbox-zone-label"
          className="rounded-item bg-white px-3 py-2 text-[13px] text-eui-ink"
        >{label}</p>) : <p className="text-[13px] text-pay-lavender/60">{zonesVisible ? lightbox.noTransitions : lightbox.zonesHidden}</p>}
      </div>
      <button type="button" aria-label={lightbox.next} disabled={stepIndex === flow.steps.length - 1} onClick={() => onStep(stepIndex + 1)} className={`${circle} h-13 w-13 text-xl leading-none max-sm:hidden`}>
        <span aria-hidden="true">→</span>
      </button>
    </div>

    <ol className="flex shrink-0 flex-wrap justify-center gap-2" aria-label={lightbox.thumbnailsAria(flow.name)}>
      {flow.steps.map((item, index) => <li key={`${item.screenId}:${index}`}>
        <button
          type="button"
          aria-current={index === stepIndex ? "step" : undefined}
          onClick={() => onStep(index)}
          className={`flex h-[100px] w-[58px] flex-col justify-end rounded-item bg-white p-1.5 text-left text-[10px] leading-tight text-eui-ink ${index === stepIndex ? "outline-2 outline-offset-2 outline-pay-red" : "opacity-45"}`}
        >
          <span className="line-clamp-3">{screenNames.get(item.screenId) ?? item.screenId}</span>
        </button>
      </li>)}
    </ol>
  </div>;
}
