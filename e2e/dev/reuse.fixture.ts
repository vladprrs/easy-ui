import type { APIRequestContext, APIResponse } from "@playwright/test";

type ReuseRejection = {
  error?: {
    code?: string;
    overrideTemplate?: { catalogRevision: string; candidateKeys: string[] };
  };
};

/**
 * A few E2E fixtures deliberately keep structurally similar components separate because they
 * exercise different contracts. Always obtain the complete, current override from the real
 * create rejection; a concurrent fixture may move the catalog once before the retry lands.
 */
export async function createFixtureComponent(
  request: APIRequestContext,
  api: string,
  data: Record<string, unknown>,
  reason = "Отдельная E2E-фикстура нужна для проверки совместимости разных контрактов",
): Promise<APIResponse> {
  let response = await request.post(`${api}/components`, { data });
  for (let attempt = 0; attempt < 3 && response.status() === 409; attempt += 1) {
    const rejection = await response.json() as ReuseRejection;
    const code = rejection.error?.code;
    const override = code === "component_reuse_required" || code === "catalog_changed"
      ? rejection.error?.overrideTemplate
      : undefined;
    if (!override) return response;
    response = await request.post(`${api}/components`, {
      data: { ...data, reuseOverride: { ...override, reason } },
    });
  }
  return response;
}
