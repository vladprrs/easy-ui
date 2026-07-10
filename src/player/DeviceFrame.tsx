import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PrototypeDoc } from "../prototype/schema";

type Device = PrototypeDoc["device"];
const sizes: Record<Exclude<Device, "desktop">, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
};

export function DeviceFrame({ defaultDevice, canvas, children }: {
  defaultDevice: Device;
  canvas?: { width: number; height: number };
  children: ReactNode;
}) {
  const [device, setDevice] = useState(defaultDevice);
  const hostRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const frame = device === "desktop" ? null : sizes[device];
  const contentWidth = canvas?.width ?? frame?.width;
  const scale = contentWidth ? Math.min(1, availableWidth / contentWidth) : 1;
  const contentHeight = canvas?.height ?? frame?.height;

  return (
    <section className="min-w-0 flex-1" aria-label="Prototype device preview">
      <div className="mb-3 flex gap-2" role="group" aria-label="Device">
        {(["mobile", "tablet", "desktop"] as const).map((item) => (
          <button key={item} type="button" aria-pressed={device === item} onClick={() => setDevice(item)} className="rounded border px-3 py-1 capitalize">
            {item}
          </button>
        ))}
      </div>
      <div ref={hostRef} className="overflow-hidden rounded-xl border bg-background shadow-sm" style={{ width: frame?.width ?? "100%", maxWidth: "100%", minHeight: frame?.height }}>
        <div style={{ width: contentWidth ?? "100%", height: contentHeight, transform: `scale(${scale})`, transformOrigin: "top left" }}>
          {children}
        </div>
      </div>
    </section>
  );
}
