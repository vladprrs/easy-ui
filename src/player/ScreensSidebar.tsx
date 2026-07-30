import type { PrototypeDoc } from "../prototype/schema";
import { usePlayerNavigation } from "./navigation";
import { kicker } from "../app/chrome";
import { player } from "../app/strings/player";

const toggleButton = "rounded-item p-1.5 text-eui-slate-500 transition-colors duration-100 hover:bg-pay-lavender hover:text-eui-ink";

/**
 * Сайдбар списка экранов (W1-1): сворачиваемый (session-состояние в ScreenView),
 * длинный список (scale-demo, 20+ экранов) скроллится внутри сайдбара.
 */
export function ScreensSidebar({ doc, currentScreen, collapsed, onToggle }: {
  doc: PrototypeDoc;
  currentScreen: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const navigation = usePlayerNavigation();
  if (collapsed) {
    return (
      <aside className="flex shrink-0 flex-col items-center bg-white px-1.5 py-3" aria-label={player.screensAria}>
        <button type="button" aria-expanded={false} aria-label={player.screensExpand} title={player.screensExpand} onClick={onToggle} className={toggleButton}>
          <span aria-hidden="true">»</span>
        </button>
      </aside>
    );
  }
  return (
    <aside className="flex min-h-0 w-52 shrink-0 flex-col bg-white" aria-label={player.screensAria}>
      <div className="flex items-center justify-between gap-2 p-4 pb-2">
        <h2 className={`${kicker} min-w-0 truncate px-2`}>{doc.name}</h2>
        <button type="button" aria-expanded={true} aria-label={player.screensCollapse} title={player.screensCollapse} onClick={onToggle} className={`${toggleButton} shrink-0`}>
          <span aria-hidden="true">«</span>
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"><ul className="space-y-1">
        {doc.screens.map((screen) => <li key={screen.id}>
          <button type="button" aria-current={screen.id === currentScreen ? "page" : undefined} onClick={() => navigation.goToScreen(screen.id)} className="w-full rounded-field px-3 py-2 text-left text-sm text-eui-ink transition-colors duration-100 hover:bg-pay-lavender-tint aria-[current=page]:bg-pay-lavender aria-[current=page]:font-medium">
            {screen.name}
          </button>
        </li>)}
      </ul></nav>
    </aside>
  );
}
