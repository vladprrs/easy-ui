import type { PrototypeDoc } from "../prototype/schema";
import { docSurfaces, hasSurfaces, screensOfSurface } from "../prototype/surfaces";
import { usePlayerNavigation } from "./navigation";
import { kicker } from "../app/chrome";
import { player } from "../app/strings/player";

const toggleButton = "rounded-item p-1.5 text-eui-slate-500 transition-colors duration-100 hover:bg-pay-lavender hover:text-eui-ink";

function ScreenItem({ name, current, onSelect }: { name: string; current: boolean; onSelect: () => void }) {
  return <li>
    <button type="button" aria-current={current ? "page" : undefined} onClick={onSelect} className="w-full rounded-field px-3 py-2 text-left text-sm text-eui-ink transition-colors duration-100 hover:bg-pay-lavender-tint aria-[current=page]:bg-pay-lavender aria-[current=page]:font-medium">
      {name}
    </button>
  </li>;
}

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
  const names = new Map(doc.screens.map((screen) => [screen.id, screen.name]));
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
      <nav className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {hasSurfaces(doc)
          // Дуо-док (D12): список группируется по поверхностям, у каждой отмечен её
          // текущий экран — сайдбар показывает состояние обеих панелей, а не только
          // сфокусированной. Заголовок группы — имя поверхности из документа.
          ? docSurfaces(doc).map((surface) => <section key={surface.id} className="mb-3 last:mb-0" aria-label={surface.name}>
              <h3 className={`${kicker} px-3 pb-1`}>{surface.name}</h3>
              <ul className="space-y-1">
                {screensOfSurface(doc, surface.id).map((screenId) => <ScreenItem
                  key={screenId}
                  name={names.get(screenId) ?? screenId}
                  current={navigation.screenBySurface[surface.id] === screenId}
                  onSelect={() => navigation.goToScreen(screenId)}
                />)}
              </ul>
            </section>)
          : <ul className="space-y-1">
              {doc.screens.map((screen) => <ScreenItem
                key={screen.id}
                name={screen.name}
                current={screen.id === currentScreen}
                onSelect={() => navigation.goToScreen(screen.id)}
              />)}
            </ul>}
      </nav>
    </aside>
  );
}
