import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation, useParams } from "react-router";
import { describe, expect, it } from "vitest";
import { PrototypeChrome } from "../app/PrototypeChrome";
import { prototypeDocSchema, type PrototypeDoc } from "../prototype/schema";
import { EasyUiActionRuntime } from "./actionRuntime";
import { documentLifetimeNonce, PlayerNavigationProvider, type PlayerLocationState, usePlayerNavigation } from "./navigation";
import { ScenarioBar } from "./ScenarioBar";
import { stripScenarioSearch } from "./ScreenView";

const spec = (text: string) => ({
  root: "copy",
  elements: { copy: { type: "Text", props: { text } } },
});

function scenarioDoc(flows: PrototypeDoc["flows"] | null = [{
  id: "main",
  name: "Основной",
  steps: [{ screenId: "one" }, { screenId: "two" }],
}]): PrototypeDoc {
  return prototypeDocSchema.parse({
    version: 1,
    id: "demo",
    name: "Demo",
    designSystem: "shadcn",
    device: "desktop",
    startScreen: "one",
    state: { choice: "initial" },
    screens: [
      { id: "one", name: "One", spec: spec("one") },
      { id: "two", name: "Two", stateOverrides: { choice: "override" }, spec: spec("two") },
      { id: "three", name: "Three", spec: spec("three") },
    ],
    ...(flows === null ? {} : { flows }),
  });
}

const sessionState = (): PlayerLocationState => ({
  sessionNonce: "session-a",
  flowDepth: 0,
  entryReason: "flow",
  documentNonce: documentLifetimeNonce,
});

function Probe({ doc, runtimeKey = "runtime-a" }: { doc: PrototypeDoc; runtimeKey?: string }) {
  const { screenId = "" } = useParams();
  const location = useLocation();
  const navigation = usePlayerNavigation();
  return <>
    <ScenarioBar doc={doc} currentScreen={screenId} runtimeKey={runtimeKey} />
    <output data-testid="pathname">{location.pathname}</output>
    <output data-testid="search">{location.search}</output>
    <output data-testid="session">{navigation.sessionNonce}</output>
  </>;
}

function renderScenario(doc: PrototypeDoc, path: string, state: PlayerLocationState = sessionState()) {
  const router = createMemoryRouter([{
    path: "/p/:protoId/s/:screenId",
    element: <PlayerNavigationProvider startScreen={doc.startScreen} routeBase="/p/demo"><Probe doc={doc} /></PlayerNavigationProvider>,
  }], { initialEntries: [{ pathname: path.split("?")[0]!, search: path.includes("?") ? `?${path.split("?")[1]!}` : "", state }] });
  return { router, ...render(<RouterProvider router={router} />) };
}

describe("ScenarioBar guided browse", () => {
  it("uses pendingTarget to confirm a repeated-screen occurrence after browse navigation", async () => {
    const doc = scenarioDoc([
      { id: "main", name: "Основной", steps: [{ screenId: "one" }, { screenId: "three" }] },
      { id: "repeat", name: "Повтор", steps: [{ screenId: "one" }, { screenId: "two" }, { screenId: "one" }] },
    ]);
    const { router } = renderScenario(doc, "/p/demo/s/one?flow=repeat&step=0");

    fireEvent.click(screen.getByRole("button", { name: "Следующий шаг" }));
    await waitFor(() => {
      expect(router.state.location.search).toBe("?flow=repeat&step=1");
      expect(screen.getByText("Шаг 2 из 3")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Следующий шаг" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/p/demo/s/one");
      expect(router.state.location.search).toBe("?flow=repeat&step=2");
      expect(screen.getByText("Шаг 3 из 3")).toBeTruthy();
    });
  });

  it("removes a non-canonical step and does not invent an occurrence for a repeated screen", async () => {
    const doc = scenarioDoc([
      { id: "main", name: "Основной", steps: [{ screenId: "one" }, { screenId: "three" }] },
      { id: "repeat", name: "Повтор", steps: [{ screenId: "one" }, { screenId: "two" }, { screenId: "one" }] },
    ]);
    const { router } = renderScenario(doc, "/p/demo/s/one?flow=repeat&step=1&debug=1");

    await waitFor(() => expect(router.state.location.search).toBe("?flow=repeat&debug=1"));
    expect(screen.getByText("Шаг не определён")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Выберите вхождение экрана" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Шаг 3" }));
    await waitFor(() => expect(router.state.location.search).toBe("?flow=repeat&debug=1&step=2"));
  });

  it("switches flows query-only and resolves the current screen in the selected flow", async () => {
    const doc = scenarioDoc([
      { id: "main", name: "Основной", steps: [{ screenId: "one" }, { screenId: "two" }] },
      { id: "other", name: "Другой", steps: [{ screenId: "one" }, { screenId: "three" }] },
    ]);
    const { router } = renderScenario(doc, "/p/demo/s/one?flow=main&step=0");

    fireEvent.change(screen.getByRole("combobox", { name: "Сценарий" }), { target: { value: "other" } });

    await waitFor(() => expect(router.state.location.search).toBe("?flow=other&step=0"));
    expect(screen.getByRole("combobox", { name: "Сценарий" })).toHaveProperty("value", "other");
  });

  it("preserves PlayerNavigationProvider session state during the post-navigation query replace", async () => {
    const { router } = renderScenario(scenarioDoc(), "/p/demo/s/one?flow=main&step=0");

    fireEvent.click(screen.getByRole("button", { name: "Следующий шаг" }));

    await waitFor(() => expect(router.state.location.search).toBe("?flow=main&step=1"));
    expect(router.state.location.pathname).toBe("/p/demo/s/two");
    expect(router.state.location.state).toMatchObject({
      sessionNonce: "session-a",
      flowDepth: 0,
      entryReason: "browse",
      documentNonce: documentLifetimeNonce,
    });
    expect(screen.getByTestId("session").textContent).toBe("session-a");
  });

  it("opens the next screen in current session state and does not apply stateOverrides", async () => {
    const doc = scenarioDoc();
    const runtime = new EasyUiActionRuntime({
      initialState: doc.state,
      screenIds: new Set(doc.screens.map((item) => item.id)),
      deps: { navigate() {}, back() {}, restart() {}, openUrl() {} },
    });
    function StatefulProbe() {
      const { screenId = "" } = useParams();
      return <>
        <ScenarioBar doc={doc} currentScreen={screenId} runtimeKey="stateful" />
        <output data-testid="choice">{String(runtime.store.get("/choice"))}</output>
      </>;
    }
    const router = createMemoryRouter([{
      path: "/p/:protoId/s/:screenId",
      element: <PlayerNavigationProvider startScreen="one" routeBase="/p/demo"><StatefulProbe /></PlayerNavigationProvider>,
    }], { initialEntries: [{ pathname: "/p/demo/s/one", search: "?flow=main&step=0", state: sessionState() }] });
    render(<RouterProvider router={router} />);

    await act(async () => {
      await runtime.dispatch({ action: "setState", params: { statePath: "/choice", value: "chosen" } }, { event: "press", payload: null, elementId: "set" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Следующий шаг" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/p/demo/s/two"));
    expect(screen.getByTestId("choice").textContent).toBe("chosen");
    expect(runtime.store.get("/choice")).toBe("chosen");
  });

  it("shows the outside state without losing the last confirmed step and offers step 1", async () => {
    const { router } = renderScenario(scenarioDoc(), "/p/demo/s/three?flow=main&step=0");
    await waitFor(() => expect(router.state.location.search).toBe("?flow=main"));
    expect(screen.getByText("Текущий экран вне сценария")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "К шагу 1" }));
    await waitFor(() => expect(router.state.location.search).toBe("?flow=main&step=0"));
    expect(router.state.location.pathname).toBe("/p/demo/s/one");
  });

  it("renders nothing when the document has no flows", () => {
    const { container } = renderScenario(scenarioDoc(null), "/p/demo/s/one");
    expect(screen.queryByTestId("scenario-bar")).toBeNull();
    expect(container.querySelector("section")).toBeNull();
    expect(screen.getByTestId("pathname").textContent).toBe("/p/demo/s/one");
  });
});

describe("scenario query boundaries", () => {
  it("strips flow and step from Present while preserving the rest of the query", () => {
    expect(stripScenarioSearch("?flow=main&debug=1&step=2&theme=dark")).toBe("?debug=1&theme=dark");
    expect(stripScenarioSearch("?flow=main&step=0")).toBe("");
  });

  it("carries flow and step between Player and CJM and accepts an explicit CJM player screen", () => {
    const router = createMemoryRouter([{
      path: "*",
      element: <PrototypeChrome
        prototypeId="demo"
        prototypeName="Demo"
        view="cjm"
        playerPath="/p/demo/s/two"
      />,
    }], { initialEntries: ["/p/demo/cjm?flow=main&step=1&debug=1"] });
    render(<RouterProvider router={router} />);

    expect(screen.getByRole("link", { name: "Плеер" }).getAttribute("href")).toBe("/p/demo/s/two?flow=main&step=1");
    expect(screen.getByRole("link", { name: "CJM" }).getAttribute("href")).toBe("/p/demo/cjm?flow=main&step=1");
  });
});
