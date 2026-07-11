import type { PrototypeDoc } from "../prototype/schema";
import { usePlayerNavigation } from "./navigation";
import { kickerOnDark } from "../app/chrome";

export function ScreensSidebar({ doc, currentScreen }: { doc: PrototypeDoc; currentScreen: string }) {
  const navigation = usePlayerNavigation();
  return (
    <aside className="w-52 shrink-0 border-r border-white/15 p-4 font-eui-ui" aria-label="Screens">
      <h2 className={`${kickerOnDark} mb-2 px-2`}>{doc.name}</h2>
      <nav><ul className="space-y-1">
        {doc.screens.map((screen) => <li key={screen.id}>
          <button type="button" aria-current={screen.id === currentScreen ? "page" : undefined} onClick={() => navigation.goToScreen(screen.id)} className="w-full rounded-xl px-3 py-2 text-left text-eui-ondark-2 hover:bg-white/10 aria-[current=page]:bg-eui-brand/35 aria-[current=page]:font-semibold aria-[current=page]:text-white">
            {screen.name}
          </button>
        </li>)}
      </ul></nav>
    </aside>
  );
}
