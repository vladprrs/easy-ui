/**
 * Capture console/page messages carry two very different signals: defects of the
 * prototype under capture (product errors) and noise of the browser/agent
 * environment (infrastructure). Mixing them is the reason a valid PNG used to be
 * reported as a failure, so classification lives in one explicit allowlist here.
 */
export interface ClassifiedCaptureErrors {
  /** Errors attributable to the captured document: the only failure signal. */
  productErrors: string[];
  /** Environment noise: never a reason to fail a capture that produced an image. */
  infraNoise: string[];
}

/** Substring/regex allowlist of known-infrastructural console noise. */
export const INFRA_NOISE_PATTERNS: readonly RegExp[] = Object.freeze([
  /favicon\.ico/i,
  /\b(?:chrome|moz|safari-web|ms-browser)-extension:\/\//i,
  /\bERR_NETWORK_CHANGED\b/,
  /ResizeObserver loop completed with undelivered notifications/i,
  /ResizeObserver loop limit exceeded/i,
]);

const URL_PATTERN = /\bhttps?:\/\/[^\s)"']+/gi;

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch { return null; }
}

/**
 * A message is infrastructure noise when it matches the explicit allowlist, or
 * when every absolute URL it references belongs to an origin other than the
 * capture origin (the prototype under capture is served from that origin only).
 */
export function isInfraNoise(message: string, captureOrigin: string): boolean {
  if (INFRA_NOISE_PATTERNS.some((pattern) => pattern.test(message))) return true;
  const origins = [...message.matchAll(URL_PATTERN)].map((match) => originOf(match[0])).filter((value): value is string => value !== null);
  if (!origins.length) return false;
  const expected = originOf(captureOrigin) ?? captureOrigin;
  return origins.every((origin) => origin !== expected);
}

/** Split raw console/page errors into product errors and infrastructure noise. */
export function classifyCaptureErrors(messages: readonly string[], options: { captureOrigin: string }): ClassifiedCaptureErrors {
  const productErrors: string[] = [];
  const infraNoise: string[] = [];
  for (const message of messages) {
    if (isInfraNoise(message, options.captureOrigin)) infraNoise.push(message);
    else productErrors.push(message);
  }
  return { productErrors, infraNoise };
}
