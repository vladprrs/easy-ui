import type { APIRequestContext, APIResponse } from "@playwright/test";

type ReuseRejection = {
  error?: {
    code?: string;
    overrideTemplate?: { catalogRevision: string; candidateKeys: string[] };
  };
};
type OverrideTemplate = NonNullable<NonNullable<ReuseRejection["error"]>["overrideTemplate"]>;

export interface FixtureReuseOptions {
  reason: string;
  /** Complete identity allowlist for intentional duplicates in this fixture's design system. */
  allowedCandidateKeys: readonly string[];
}

function validateOverrideTemplate(
  artifactId: string,
  code: "component_reuse_required" | "catalog_changed",
  override: OverrideTemplate | undefined,
  allowedCandidateKeys: ReadonlySet<string>,
): OverrideTemplate {
  if (!override) throw new Error(`Fixture ${artifactId}: ${code} did not include an overrideTemplate`);
  const unexpected = [...new Set(override.candidateKeys)].filter((key) => !allowedCandidateKeys.has(key)).sort();
  if (unexpected.length > 0) {
    throw new Error(`Fixture ${artifactId}: refusing reuse override for unexpected candidate keys: ${unexpected.join(", ")}`);
  }
  return override;
}

/**
 * A few E2E fixtures deliberately keep structurally similar components separate because they
 * exercise different contracts. Always obtain the complete, current override from the real
 * create rejection; a concurrent fixture may move the catalog once before the retry lands.
 */
export async function createFixtureComponent(
  request: APIRequestContext,
  api: string,
  data: Record<string, unknown>,
  options: FixtureReuseOptions,
): Promise<APIResponse> {
  const artifactId = String(data.id ?? "<unknown>");
  const allowedCandidateKeys = new Set(options.allowedCandidateKeys);
  let response = await request.post(`${api}/components`, { data });
  for (let attempt = 0; attempt < 3 && response.status() === 409; attempt += 1) {
    const rejection = await response.json() as ReuseRejection;
    const code = rejection.error?.code;
    if (code !== "component_reuse_required" && code !== "catalog_changed") return response;
    const override = validateOverrideTemplate(artifactId, code, rejection.error?.overrideTemplate, allowedCandidateKeys);
    response = await request.post(`${api}/components`, {
      data: { ...data, reuseOverride: { ...override, reason: options.reason } },
    });
  }
  return response;
}
