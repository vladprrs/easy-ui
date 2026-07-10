import { Link, NavLink, Outlet } from "react-router";

export function Layout() {
  return <>
    <header className="border-b bg-background">
      <div className="mx-auto flex min-h-16 max-w-screen-2xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <Link className="font-bold" to="/">easy-ui</Link>
        <nav className="flex gap-4 text-sm" aria-label="Main navigation">
          <NavLink className={({ isActive }) => isActive ? "font-semibold underline" : "hover:underline"} to="/" end>Gallery</NavLink>
          <NavLink className={({ isActive }) => isActive ? "font-semibold underline" : "hover:underline"} to="/library">Library</NavLink>
          <NavLink className={({ isActive }) => isActive ? "font-semibold underline" : "hover:underline"} to="/debug">Debug</NavLink>
        </nav>
      </div>
    </header>
    <Outlet />
  </>;
}
