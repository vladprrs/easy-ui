import type { PrototypeDoc } from "../prototype/schema";
import { usePlayerNavigation } from "./navigation";
import { kickerOnDark } from "../app/chrome";
import { player } from "../app/strings/player";

const toggleButton = "rounded-lg p-1.5 text-eui-ondark-2 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80";

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
      <aside className="flex shrink-0 flex-col items-center border-r border-white/15 px-1.5 py-3 font-eui-ui" aria-label={player.screensAria}>
        <button type="button" aria-expanded={false} aria-label={player.screensExpand} title={player.screensExpand} onClick={onToggle} className={toggleButton}>
          <span aria-hidden="true">»</span>
        </button>
      </aside>
    );
  }
  return (
    <aside className="flex min-h-0 w-52 shrink-0 flex-col border-r border-white/15 font-eui-ui" aria-label={player.screensAria}>
      <div className="flex items-center justify-between gap-2 p-4 pb-2">
        <h2 className={`${kickerOnDark} min-w-0 truncate px-2`}>{doc.name}</h2>
        <button type="button" aria-expanded={true} aria-label={player.screensCollapse} title={player.screensCollapse} onClick={onToggle} className={`${toggleButton} shrink-0`}>
          <span aria-hidden="true">«</span>
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"><ul className="space-y-1">
        {doc.screens.map((screen) => <li key={screen.id}>
          <button type="button" aria-current={screen.id === currentScreen ? "page" : undefined} onClick={() => navigation.goToScreen(screen.id)} className="w-full rounded-xl px-3 py-2 text-left text-eui-ondark-2 hover:bg-white/10 aria-[current=page]:bg-eui-brand/35 aria-[current=page]:font-semibold aria-[current=page]:text-white">
            {screen.name}
          </button>
        </li>)}
      </ul></nav>
    </aside>
  );
}
