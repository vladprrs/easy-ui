import { Link, NavLink, Outlet } from "react-router";

export function Layout() {
  return <div className="grid min-h-dvh grid-rows-[auto_1fr]">
    <header className="border-b border-eui-ink/10 bg-white">
      <div className="mx-auto flex min-h-16 max-w-screen-2xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <Link className="font-eui-display text-lg font-bold" to="/">easy-ui</Link>
        <nav className="flex gap-4 font-eui-ui text-sm" aria-label="Main navigation">
          <NavLink className={({ isActive }) => isActive ? "border-b-2 border-eui-brand pb-0.5 font-bold text-eui-brand" : "hover:text-eui-brand"} to="/" end>Gallery</NavLink>
          <NavLink className={({ isActive }) => isActive ? "border-b-2 border-eui-brand pb-0.5 font-bold text-eui-brand" : "hover:text-eui-brand"} to="/library">Library</NavLink>
          <NavLink className={({ isActive }) => isActive ? "border-b-2 border-eui-brand pb-0.5 font-bold text-eui-brand" : "hover:text-eui-brand"} to="/debug">Debug</NavLink>
        </nav>
      </div>
    </header>
    <div className="min-h-0">
      <Outlet />
    </div>
  </div>;
}
