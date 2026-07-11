import { Link, Route, Routes } from "react-router";
import { GalleryPage } from "../gallery/GalleryPage";
import { LibraryPage } from "../library/LibraryPage";
import { SmokeSpec } from "../smoke/SmokeSpec";
import { PlayerShell } from "../player/PlayerShell";
import { ScreenView } from "../player/ScreenView";
import { Layout } from "./Layout";
import { CjmShell } from "../cjm/CjmShell";
import { EditorShell } from "../editor/EditorShell";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<GalleryPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="debug" element={<SmokeSpec />} />
        <Route path="p/:protoId" element={<PlayerShell />}>
          <Route index element={null} />
          <Route path="s/:screenId" element={<ScreenView />} />
        </Route>
        <Route path="p/:protoId/v/:version" element={<PlayerShell />}>
          <Route index element={null} />
          <Route path="s/:screenId" element={<ScreenView />} />
        </Route>
        <Route path="p/:protoId/cjm" element={<CjmShell />} />
        <Route path="p/:protoId/edit" element={<EditorShell />} />
        <Route path="p/:protoId/v/:version/cjm" element={<CjmShell />} />
        <Route path="*" element={<main className="p-8"><h1 className="text-2xl font-bold">Page not found</h1><Link className="underline" to="/">Back to gallery</Link></main>} />
      </Route>
    </Routes>
  );
}
