import type { PrototypeDoc } from "../prototype/schema";
import { usePlayerNavigation } from "./navigation";

export function ScreensSidebar({ doc, currentScreen }: { doc: PrototypeDoc; currentScreen: string }) {
  const navigation = usePlayerNavigation();
  return (
    <aside className="w-52 shrink-0" aria-label="Screens">
      <h2 className="mb-2 font-semibold">{doc.name}</h2>
      <nav><ul className="space-y-1">
        {doc.screens.map((screen) => <li key={screen.id}>
          <button type="button" aria-current={screen.id === currentScreen ? "page" : undefined} onClick={() => navigation.goToScreen(screen.id)} className="w-full rounded px-3 py-2 text-left aria-[current=page]:bg-muted aria-[current=page]:font-semibold">
            {screen.name}
          </button>
        </li>)}
      </ul></nav>
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={navigation.back} disabled={navigation.flowDepth === 0} className="rounded border px-3 py-2">Back</button>
        <button type="button" onClick={navigation.restart} className="rounded border px-3 py-2">Restart</button>
      </div>
    </aside>
  );
}
