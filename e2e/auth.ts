import { request as playwrightRequest, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";

export const E2E_ADMIN_NAME = "E2E Admin";
export const E2E_ADMIN_PASSWORD = "e2e-admin-password";
export const E2E_MEMBER_NAME = "E2E Member";
export const E2E_MEMBER_PASSWORD = "e2e-member-password";

export function legacyAuthorization(credentials?: string): string | undefined {
  return credentials ? `Basic ${Buffer.from(credentials).toString("base64")}` : undefined;
}

export async function authenticatedRequest(baseURL: string, options: {
  username?: string;
  password?: string;
  legacyBasicAuth?: string;
  storageStatePath?: string;
} = {}): Promise<APIRequestContext> {
  const authorization = legacyAuthorization(options.legacyBasicAuth);
  const origin = new URL(baseURL).origin;
  const context = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { origin, ...(authorization ? { authorization } : {}) },
  });
  const response = await context.post("/api/auth/login", {
    data: { name: options.username ?? E2E_ADMIN_NAME, password: options.password ?? E2E_ADMIN_PASSWORD },
  });
  if (!response.ok()) throw new Error(`e2e login failed at ${baseURL}: HTTP ${response.status()} ${await response.text()}`);
  if (options.storageStatePath) await context.storageState({ path: options.storageStatePath });
  return context;
}

export async function authenticatedBrowserContext(browser: Browser, baseURL: string, options: {
  username?: string;
  password?: string;
  legacyBasicAuth?: string;
} = {}): Promise<BrowserContext> {
  const request = await authenticatedRequest(baseURL, options);
  const storageState = await request.storageState();
  await request.dispose();
  const authorization = legacyAuthorization(options.legacyBasicAuth);
  return browser.newContext({ baseURL, storageState, extraHTTPHeaders: authorization ? { authorization } : undefined });
}
