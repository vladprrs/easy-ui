import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth";
import { panel, pillGhost, segmentIdle } from "./chrome";
import { PayLogo } from "./PayLogo";
import { appShell } from "./strings/common";
import { assetsStrings } from "./strings/assets";

const navLink = ({ isActive }: { isActive: boolean }) => isActive
  ? "inline-flex shrink-0 items-center rounded-full bg-pay-lavender px-3.5 py-1.5 text-sm font-medium text-eui-ink"
  : `${segmentIdle} px-3.5`;

function LayoutContent() {
  // На /p/* единственный хедер — PrototypeChrome (WF-4): глобальный app-header
  // схлопывается, чтобы не плодить второй ряд хрома над плеером/CJM/редактором.
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, loading, logout } = useAuth();
  const prototypeRoute = pathname === "/p" || pathname.startsWith("/p/");
  if (prototypeRoute) return <div className="grid min-h-dvh grid-rows-1"><div className="min-h-0 min-w-0"><Outlet /></div></div>;
  // Канва бренда: лаванда, внешний gutter 20 и gap 20 между белыми панелями.
  return <div className="grid min-h-dvh grid-rows-[auto_1fr] gap-5 bg-pay-lavender p-5 font-pay-text text-eui-ink">
    <header className={`${panel} flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3.5`}>
      <Link className="flex shrink-0 items-center gap-2.5 text-base font-medium" to="/">
        <PayLogo />
        <span aria-hidden="true" className="text-eui-slate-400">·</span>
        <span>{appShell.brandSuffix}</span>
      </Link>
      <nav className="flex min-w-0 flex-wrap items-center gap-1" aria-label={appShell.mainNavAria}>
        <NavLink className={navLink} to="/" end>{appShell.navGallery}</NavLink>
        <NavLink className={navLink} to="/library">{appShell.navLibrary}</NavLink>
        <NavLink className={navLink} to="/visual">{appShell.navVisual}</NavLink>
        <NavLink className={navLink} to="/assets">{assetsStrings.navLabel}</NavLink>
        <a className={`${segmentIdle} px-3.5`} href="/api/openapi.json">{appShell.navApiDocs}</a>
        {import.meta.env.DEV ? <NavLink className={navLink} to="/debug">{appShell.navDebug}</NavLink> : null}
        {user?.isAdmin ? <NavLink className={navLink} to="/users">{appShell.navUsers}</NavLink> : null}
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-3 text-sm">
        {loading ? <span className="text-eui-slate-500">{appShell.loading}</span> : user ? <span className="flex items-center gap-2">
          <span aria-hidden="true" className="grid h-[26px] w-[26px] place-items-center rounded-full bg-pay-lavender-light text-xs font-medium text-eui-ink">{user.name.slice(0, 1).toUpperCase()}</span>
          <span className="font-medium">{user.name}</span>
        </span> : null}
        {user ? <button className={pillGhost} type="button" onClick={() => void logout().then(() => navigate("/login", { replace: true }))}>{appShell.logout}</button> : null}
      </div>
    </header>
    <div className="min-h-0 min-w-0">
      <Outlet />
    </div>
  </div>;
}

export function Layout() {
  return <LayoutContent />;
}
