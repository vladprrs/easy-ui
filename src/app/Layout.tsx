import { Link, NavLink, Outlet, useLocation } from "react-router";
import { prototypesById } from "../prototype/loader";

export function Layout() {
  const location = useLocation();
  const prototypeId = location.pathname.match(/^\/p\/([^/]+)/)?.[1];
  const prototype = prototypeId ? prototypesById.get(decodeURIComponent(prototypeId)) : undefined;
  return <>
    <header className="border-b bg-background">
      <div className="mx-auto flex min-h-16 max-w-screen-2xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <Link className="font-bold" to="/">easy-ui</Link>
        <nav className="flex gap-4 text-sm" aria-label="Main navigation">
          <NavLink className={({ isActive }) => isActive ? "font-semibold underline" : "hover:underline"} to="/" end>Gallery</NavLink>
          <NavLink className={({ isActive }) => isActive ? "font-semibold underline" : "hover:underline"} to="/library">Library</NavLink>
          <NavLink className={({ isActive }) => isActive ? "font-semibold underline" : "hover:underline"} to="/debug">Debug</NavLink>
        </nav>
        {prototype ? <div className="ml-auto text-sm text-muted-foreground" aria-label="Breadcrumb"><Link className="hover:underline" to="/">Gallery</Link><span aria-hidden="true"> / </span><span>{prototype.name}</span></div> : null}
      </div>
    </header>
    <Outlet />
  </>;
}
