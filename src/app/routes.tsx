import { Link, Route, Routes } from "react-router";
import { SmokeSpec } from "../smoke/SmokeSpec";
import { PlayerShell } from "../player/PlayerShell";
import { ScreenView } from "../player/ScreenView";

function Home() {
  return <main className="mx-auto max-w-3xl p-8"><h1 className="text-3xl font-bold">easy-ui</h1><p className="mt-2">Prototype gallery is coming soon.</p><Link className="mt-4 inline-block underline" to="/p/hello-world">Open Hello World</Link></main>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/debug" element={<SmokeSpec />} />
      <Route path="/p/:protoId" element={<PlayerShell />}>
        <Route index element={null} />
        <Route path="s/:screenId" element={<ScreenView />} />
      </Route>
      <Route path="*" element={<main className="p-8"><h1 className="text-2xl font-bold">Page not found</h1><Link className="underline" to="/">Back to gallery</Link></main>} />
    </Routes>
  );
}
