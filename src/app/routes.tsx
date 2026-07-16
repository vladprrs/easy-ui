import { Link, type RouteObject } from "react-router";
import { CapturePrototype } from "../capture/CapturePrototype";
import { CaptureComponent } from "../capture/CaptureComponent";
import { GalleryPage } from "../gallery/GalleryPage";
import { LibraryPage } from "../library/LibraryPage";
import { ComponentPage } from "../library/componentPage";
import { VisualPage } from "../visual/VisualPage";
import { SmokeSpec } from "../smoke/SmokeSpec";
import { PlayerShell } from "../player/PlayerShell";
import { PresentShell } from "../player/PresentShell";
import { ScreenView } from "../player/ScreenView";
import { Layout } from "./Layout";
import { CjmShell } from "../cjm/CjmShell";
import { EditorShell } from "../editor/EditorShell";
import { headingPage, kicker, pillPrimary } from "./chrome";
import { appShell } from "./strings/common";
import { useDocumentTitle } from "./useDocumentTitle";

function NotFound() {
  useDocumentTitle(appShell.notFoundTitle);
  return (
    <main className="mx-auto flex max-w-screen-md flex-col items-start gap-4 px-6 py-16">
      <p className={kicker}>{appShell.notFoundKicker}</p>
      <h1 className={headingPage}>{appShell.notFoundTitle}</h1>
      <p className="text-sm text-eui-slate-500">
        {appShell.notFoundBody}
      </p>
      <Link className={`${pillPrimary} mt-2`} to="/">{appShell.notFoundCta}</Link>
    </main>
  );
}

/** Дети present-маршрута: index (redirect на startScreen делает навигация) и экран. */
const presentChildren = (): RouteObject[] => [
  { index: true, element: null },
  { path: "s/:screenId", element: null },
];

export const routeObjects: RouteObject[] = [
  { path: "capture/:protoId/s/:screenId", element: <CapturePrototype /> },
  { path: "capture/component/:id/:version", element: <CaptureComponent /> },
  // Презентация (W1-2): вне Layout и вне PrototypeChrome — как capture.
  { path: "p/:protoId/present", element: <PresentShell />, children: presentChildren() },
  { path: "p/:protoId/v/:version/present", element: <PresentShell />, children: presentChildren() },
  // Scoped share (W3-3): tokenless presentation route outside Layout/PrototypeChrome.
  { path: "share/p/:protoId/v/:version/present", element: <PresentShell share />, children: presentChildren() },
  {
    element: <Layout />,
    children: [
      { index: true, element: <GalleryPage /> },
      { path: "library", element: <LibraryPage /> },
      { path: "library/c/:componentId", element: <ComponentPage /> },
      { path: "visual", element: <VisualPage /> },
      { path: "debug", element: <SmokeSpec /> },
      {
        path: "p/:protoId",
        element: <PlayerShell />,
        children: [
          { index: true, element: null },
          { path: "s/:screenId", element: <ScreenView /> },
        ],
      },
      {
        path: "p/:protoId/v/:version",
        element: <PlayerShell />,
        children: [
          { index: true, element: null },
          { path: "s/:screenId", element: <ScreenView /> },
        ],
      },
      { path: "p/:protoId/cjm", element: <CjmShell /> },
      { path: "p/:protoId/edit", element: <EditorShell /> },
      { path: "p/:protoId/v/:version/cjm", element: <CjmShell /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];
