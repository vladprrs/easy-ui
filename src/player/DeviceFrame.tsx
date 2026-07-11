import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PrototypeDoc } from "../prototype/schema";
import { pillGhostOnDark } from "../app/chrome";

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
    <section className="min-w-0 flex-1 overflow-auto p-6" aria-label="Prototype device preview" style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(132,78,220,0.18), transparent 70%)" }}>
      <div className="mb-3 flex gap-2 font-eui-ui" role="group" aria-label="Device">
        {(["mobile", "tablet", "desktop"] as const).map((item) => (
          <button key={item} type="button" aria-pressed={device === item} onClick={() => setDevice(item)} className={`${pillGhostOnDark} px-3 py-1 capitalize aria-pressed:bg-white/15`}>
            {item}
          </button>
        ))}
      </div>
      <div ref={hostRef} className="overflow-hidden rounded-[28px] bg-background shadow-[0_20px_60px_rgba(2,2,5,0.35)]" style={{ width: frame?.width ?? "100%", maxWidth: "100%", minHeight: frame?.height }}>
        <div style={{ width: contentWidth ?? "100%", height: contentHeight, transform: `scale(${scale})`, transformOrigin: "top left" }}>
          {children}
        </div>
      </div>
    </section>
  );
}
