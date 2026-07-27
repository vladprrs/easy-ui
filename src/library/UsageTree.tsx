import { Link } from "react-router";
import { kicker } from "../app/chrome";
import { library } from "../app/strings/library";
import type { ComponentHeadUsage } from "../api/client";

/**
 * Дерево путей использования: прототип → экран → ключи элементов (волна 3 §3.3).
 * Ссылки ведут в плеер конкретного экрана и в редактор прототипа — то, что нужно, чтобы
 * от «где это используется» сразу перейти к правке.
 */
export function UsageTree({ usages }: { usages: ComponentHeadUsage[] }) {
  if (!usages.length) return null;
  return <ul className="mt-3 space-y-2 text-sm" aria-label={library.usagesTreeAria}>
    {usages.map((usage) => <li key={usage.prototypeId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">{usage.name}</span>
        <span className={kicker}>rev {usage.rev} · v{usage.componentVersion} · {usage.kind}</span>
        <Link className="underline" to={`/p/${encodeURIComponent(usage.prototypeId)}/edit`}>{library.openInEditor}</Link>
      </div>
      <ul className="mt-1 space-y-1 border-l border-eui-ink/10 pl-3">
        {usage.screens.map((screen) => <li key={screen.screenId}>
          <Link className="underline" to={`/p/${encodeURIComponent(usage.prototypeId)}/s/${encodeURIComponent(screen.screenId)}`}>{screen.screenName || screen.screenId}</Link>
          <ul className="mt-0.5 flex flex-wrap gap-2 pl-3 text-eui-slate-500">
            {screen.elementKeys.map((key) => <li key={key}><code className="rounded bg-white px-1.5 py-0.5">{key}</code></li>)}
          </ul>
        </li>)}
      </ul>
    </li>)}
  </ul>;
}
