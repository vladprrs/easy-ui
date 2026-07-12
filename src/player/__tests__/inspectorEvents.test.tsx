import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ComponentType } from "react";
import type { ComponentDefinition } from "../../catalog/definitions";
import { EasyUiRuntimeProvider, wrapCustomComponent, type EasyUIComponentProps } from "../easyUiRuntime";
import { EasyUiActionRuntime } from "../actionRuntime";
import { EUI_KEY_PROP } from "../../prototype/runtimeSpec";
import { InspectorLog } from "../inspector/log";

afterEach(cleanup);

const Card = (p: EasyUIComponentProps) =>
  <button type="button" onClick={() => p.emit("press", { id: "pay-card" })}>Pay</button>;

const definition: ComponentDefinition = {
  description: "Card",
  props: z.strictObject({}),
  eventPayloadSchemas: { press: z.strictObject({ id: z.string() }) },
};

function renderCard({ payloadSchemas = true, onBinding }: { payloadSchemas?: boolean; onBinding?: unknown } = {}) {
  const log = new InspectorLog();
  const onError = vi.fn();
  const runtime = new EasyUiActionRuntime({
    initialState: { selectedMethod: "sbp" },
    screenIds: new Set(["home"]),
    deps: { navigate: vi.fn(), back: vi.fn(), openUrl: vi.fn(), restart: vi.fn() },
    onError,
    logger: log,
  });
  const def: ComponentDefinition = payloadSchemas ? definition : { description: "Card", props: z.strictObject({}) };
  const Wrapped = wrapCustomComponent("YpPaymentMethodCard", Card) as ComponentType<Record<string, unknown>>;
  const on = onBinding ?? { press: { action: "setState", params: { statePath: "/selectedMethod", value: { $event: "/id" } } } };
  render(
    <EasyUiRuntimeProvider value={{ metadata: { el: { type: "YpPaymentMethodCard", on: on as never } }, runtime, definitions: { YpPaymentMethodCard: def }, onError }}>
      <Wrapped element={{ type: "YpPaymentMethodCard", props: {} }} props={{ [EUI_KEY_PROP]: "el" }} />
    </EasyUiRuntimeProvider>,
  );
  return { log, runtime, onError };
}

describe("event adapter inspector logging", () => {
  it("logs the event with payload before dispatch and correlates the action entries", async () => {
    const { log, runtime } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Pay" }));
    await vi.waitFor(() => expect(runtime.store.get("/selectedMethod")).toBe("pay-card"));
    const entries = log.getSnapshot();
    expect(entries.map((entry) => entry.kind)).toEqual(["event", "action"]);
    const [event, action] = entries;
    expect(event).toMatchObject({
      kind: "event",
      component: "YpPaymentMethodCard",
      elementId: "el",
      event: "press",
      payload: { id: "pay-card" },
      payloadValid: true,
    });
    expect(action).toMatchObject({
      kind: "action",
      action: "setState",
      params: { statePath: "/selectedMethod", value: "pay-card" },
      result: { type: "state", statePath: "/selectedMethod", previous: "sbp", next: "pay-card" },
    });
    expect((event as { correlationId: string }).correlationId).toBe((action as { correlationId: string }).correlationId);
    expect((event as { correlationId: string }).correlationId).not.toBe("");
  });

  it("logs an invalid payload as payloadValid: false plus a runtime-error, and dispatches nothing", () => {
    const InvalidCard = (p: EasyUIComponentProps) =>
      <button type="button" onClick={() => p.emit("press", { id: 42 })}>Pay</button>;
    const log = new InspectorLog();
    const onError = vi.fn();
    const runtime = new EasyUiActionRuntime({
      initialState: { selectedMethod: "sbp" },
      screenIds: new Set(["home"]),
      deps: { navigate: vi.fn(), back: vi.fn(), openUrl: vi.fn(), restart: vi.fn() },
      onError,
      logger: log,
    });
    const Wrapped = wrapCustomComponent("YpPaymentMethodCard", InvalidCard) as ComponentType<Record<string, unknown>>;
    render(
      <EasyUiRuntimeProvider value={{ metadata: { el: { type: "YpPaymentMethodCard", on: { press: { action: "setState", params: { statePath: "/selectedMethod", value: "x" } } } as never } }, runtime, definitions: { YpPaymentMethodCard: definition }, onError }}>
        <Wrapped element={{ type: "YpPaymentMethodCard", props: {} }} props={{ [EUI_KEY_PROP]: "el" }} />
      </EasyUiRuntimeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pay" }));
    const kinds = log.getSnapshot().map((entry) => entry.kind);
    expect(kinds).toEqual(["event", "runtime-error"]);
    expect(log.getSnapshot()[0]).toMatchObject({ payloadValid: false });
    expect(runtime.store.get("/selectedMethod")).toBe("sbp");
    expect(onError).toHaveBeenCalledWith('event "press" payload failed validation', expect.objectContaining({ event: "press" }));
  });
});
