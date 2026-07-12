import type { RunReport, RunStatus, VisualReference } from "./api";

/** Human label + tone class fragment for a run status. */
export function statusLabel(status: RunStatus): string {
  switch (status) {
    case "pass": return "Pass";
    case "fail": return "Fail";
    case "error": return "Error";
    case "reference_missing": return "Reference missing";
    case "running": return "Running…";
  }
}

export function statusTone(status: RunStatus): string {
  switch (status) {
    case "pass": return "bg-eui-lilac-200 text-eui-ink";
    case "fail": return "bg-eui-magenta/15 text-eui-magenta";
    case "error": return "bg-white text-eui-magenta";
    case "reference_missing": return "bg-white text-eui-slate-500";
    case "running": return "bg-eui-lav text-eui-slate-500";
  }
}

/** Honest percentage rendering: never fabricate a value, show the guard note instead. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(4)}%`;
}

export function describeFingerprint(fingerprint: Record<string, unknown> | undefined): string {
  if (!fingerprint) return "";
  const viewport = fingerprint.viewport as { width?: number; height?: number } | undefined;
  const size = viewport ? `${viewport.width}×${viewport.height}` : "";
  const theme = typeof fingerprint.theme === "string" ? fingerprint.theme : "";
  if (fingerprint.scope === "prototype-screen") {
    return [`${fingerprint.prototypeId} / ${fingerprint.screenId}`, `rev ${fingerprint.refRevision}`, size, theme].filter(Boolean).join(" · ");
  }
  if (fingerprint.scope === "component") {
    return [`${fingerprint.componentId}`, `v${fingerprint.refVersion}`, size, theme].filter(Boolean).join(" · ");
  }
  return size;
}

export function referenceScope(reference: VisualReference): string {
  const scope = reference.fingerprint.scope;
  return scope === "prototype-screen" ? "Prototype screen" : scope === "component" ? "Component" : "Unknown";
}

/** Denominator for the evidence footer of a report. */
export function evidenceDenominator(report: RunReport): number | null {
  return report.totalPixels ?? report.metrics?.["exact-rgba"]?.totalPixels ?? report.metrics?.["pixelmatch-v1"]?.totalPixels ?? null;
}
