import { Link, NavLink, Outlet, useLocation } from "react-router";
import { appShell } from "./strings/common";

export function Layout() {
  // На /p/* единственный хедер — PrototypeChrome (WF-4): глобальный app-header
  // схлопывается, чтобы не плодить второй ряд хрома над плеером/CJM/редактором.
  const { pathname } = useLocation();
  const prototypeRoute = pathname === "/p" || pathname.startsWith("/p/");
  return <div className="grid min-h-dvh grid-rows-[auto_1fr]">
    {prototypeRoute ? null : <header className="border-b border-eui-ink/10 bg-white">
      <div className="mx-auto flex min-h-16 max-w-screen-2xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <Link className="font-eui-display text-lg font-bold" to="/">easy-ui</Link>
        <nav className="flex gap-4 font-eui-ui text-sm" aria-label={appShell.mainNavAria}>
          <NavLink className={({ isActive }) => isActive ? "border-b-2 border-eui-brand pb-0.5 font-bold text-eui-brand" : "hover:text-eui-brand"} to="/" end>{appShell.navGallery}</NavLink>
          <NavLink className={({ isActive }) => isActive ? "border-b-2 border-eui-brand pb-0.5 font-bold text-eui-brand" : "hover:text-eui-brand"} to="/library">{appShell.navLibrary}</NavLink>
          <NavLink className={({ isActive }) => isActive ? "border-b-2 border-eui-brand pb-0.5 font-bold text-eui-brand" : "hover:text-eui-brand"} to="/visual">{appShell.navVisual}</NavLink>
          <a className="hover:text-eui-brand" href="/api/openapi.json">{appShell.navApiDocs}</a>
          {import.meta.env.DEV ? <NavLink className={({ isActive }) => isActive ? "border-b-2 border-eui-brand pb-0.5 font-bold text-eui-brand" : "hover:text-eui-brand"} to="/debug">{appShell.navDebug}</NavLink> : null}
        </nav>
      </div>
    </header>}
    <div className="min-h-0 min-w-0">
      <Outlet />
    </div>
  </div>;
}
