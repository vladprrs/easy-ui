import { Link, Route, Routes } from "react-router";
import { CapturePrototype } from "../capture/CapturePrototype";
import { CaptureComponent } from "../capture/CaptureComponent";
import { GalleryPage } from "../gallery/GalleryPage";
import { LibraryPage } from "../library/LibraryPage";
import { VisualPage } from "../visual/VisualPage";
import { SmokeSpec } from "../smoke/SmokeSpec";
import { PlayerShell } from "../player/PlayerShell";
import { ScreenView } from "../player/ScreenView";
import { Layout } from "./Layout";
import { CjmShell } from "../cjm/CjmShell";
import { EditorShell } from "../editor/EditorShell";
import { headingPage, kicker, pillPrimary } from "./chrome";

function NotFound() {
  return (
    <main className="mx-auto flex max-w-screen-md flex-col items-start gap-4 px-6 py-16">
      <p className={kicker}>Ошибка 404</p>
      <h1 className={headingPage}>Страница не найдена</h1>
      <p className="text-sm text-eui-slate-500">
        Такой страницы нет — возможно, прототип был удалён или ссылка устарела.
      </p>
      <Link className={`${pillPrimary} mt-2`} to="/">В галерею</Link>
    </main>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="capture/:protoId/s/:screenId" element={<CapturePrototype />} />
      <Route path="capture/component/:id/:version" element={<CaptureComponent />} />
      <Route element={<Layout />}>
        <Route index element={<GalleryPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="visual" element={<VisualPage />} />
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
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
