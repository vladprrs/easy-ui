import { createHash, timingSafeEqual } from "node:crypto";

const unauthorizedHeaders = {
  "www-authenticate": 'Basic realm="easy-ui"',
  "cache-control": "no-store",
  vary: "Authorization",
};

function decodeBasicCredentials(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return undefined;
  const encoded = match[1]!;
  if (encoded.length % 4 !== 0) return undefined;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isAuthorized(request: Request, expectedCredentials: string): boolean {
  const received = decodeBasicCredentials(request.headers.get("authorization"));
  return received !== undefined && timingSafeEqual(digest(received), digest(expectedCredentials));
}

export function unauthorizedResponse(): Response {
  return new Response("Unauthorized", { status: 401, headers: unauthorizedHeaders });
}

export function protectResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  const vary = headers.get("vary");
  if (!vary?.split(",").some(value => value.trim().toLowerCase() === "authorization")) {
    headers.set("vary", vary ? `${vary}, Authorization` : "Authorization");
  }
  const cacheControl = headers.get("cache-control");
  if (cacheControl) headers.set("cache-control", cacheControl.replace(/\bpublic\b/gi, "private"));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
