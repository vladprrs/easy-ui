import { expect, test } from "@playwright/test";

// Preview project only (SERVE_DIST + installed chromium). Drives the real async
// job pipeline end to end: enqueue -> poll -> done, with the PNG stored in the
// content-addressed asset registry.

async function pollJob(request: import("@playwright/test").APIRequestContext, jobId: string) {
  for (let i = 0; i < 70; i++) {
    const response = await request.get(`/api/screenshot-jobs/${jobId}`);
    expect(response.status()).toBe(200);
    const job = await response.json() as { status: string; result?: Record<string, unknown>; error?: { message: string } };
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("screenshot job did not settle within 70s");
}

test("captures a prototype screen and stores the PNG as an asset", async ({ request }) => {
  const post = await request.post("/api/prototypes/hello-world/screens/welcome/screenshot", {
    data: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" },
  });
  expect(post.status()).toBe(202);
  const { jobId } = await post.json() as { jobId: string };

  const job = await pollJob(request, jobId);
  expect(job.status, `job error: ${job.error?.message ?? ""}`).toBe("done");
  const result = job.result as { imageUrl: string; assetId: string; width: number; height: number; rendererBuild: string; browserVersion: string; componentPins: unknown[] };
  expect(result.imageUrl).toMatch(/^\/api\/assets\/asset_[0-9a-f]{64}$/);
  expect(result.width).toBeGreaterThan(0);
  expect(result.rendererBuild).toBeTruthy();
  expect(result.browserVersion).toBeTruthy();
  expect(Array.isArray(result.componentPins)).toBe(true);

  const image = await request.get(result.imageUrl);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toContain("image/png");
});

test("rejects out-of-bounds viewports with 422", async ({ request }) => {
  const response = await request.post("/api/prototypes/hello-world/screens/welcome/screenshot", {
    data: { viewport: { width: 5000, height: 844 } },
  });
  expect(response.status()).toBe(422);
});

// Adversarial egress: a malicious bundle attempting external fetch/WS/SW/WebRTC and
// GET/POST to a neighbouring loopback port must be fully blocked. The full network
// scenario is environment-sensitive inside this container; kept as a documented
// placeholder so the intent is recorded and can be enabled where the sandbox allows.
test.fixme("blocks all egress from a malicious component bundle", async () => {
  // Requires publishing a hostile component and a neighbour loopback server; the
  // primary allowlist guarantee is covered by the server-side unit tests.
});
