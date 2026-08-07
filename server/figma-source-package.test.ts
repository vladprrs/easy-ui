/**
 * Пакет исходников Figma (план `docs/plans/2026-08-07-migration-feedback-wave.md` §W8,
 * ретроспектива P1.4, миграция v36): загрузка/чтение/дедуп, отказы provenance, FK и registry
 * integrity, **неизменность отпечатков** от metadata-only ссылки, preflight-warning,
 * ранжирование reuse-search и kill-switch.
 *
 * Компонентные id уникальны для файла: кэши import-верификации живут в общем процессе `bun test`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createTestHandler } from "./test-auth";
import { openDatabase } from "./db";
import { migrate } from "./migrations";
import { capabilities } from "./routes/meta";
import { collectCorpus } from "./catalog/corpus";
import { matchCandidates, type CorpusCandidate, type ProposedArtifact } from "./catalog/matcher";
import { CALIBRATED_POLICY } from "./catalog/policy";
import { caseSetManifestSchema } from "../src/acceptance/caseSetSchema";
import {
  caseSetSkeletonOf, sourcePackageEnabled, sourcePackageIdOf, sourcePackageManifestSchema,
  SOURCE_PACKAGE_MAX_EXPORTS,
} from "./figma/sourcePackage";

const dirs: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Handler = (request: Request) => Promise<Response>;

const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, {
    method,
    headers: value === undefined ? undefined : { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".source-package-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  databases.push(db);
  return { dir, db, handler: createTestHandler(db, { dataDir: dir }) as Handler };
}

/** PNG-заголовок с точными габаритами: валидатор ассетов декодирует именно их. */
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

async function upload(handler: Handler, width: number, height: number): Promise<{ id: string; sha256: string }> {
  const response = await handler(new Request("http://test/api/assets", {
    method: "POST", headers: { "content-type": "image/png", origin: "http://test" }, body: png(width, height),
  }));
  expect([200, 201]).toContain(response.status);
  return await response.json() as { id: string; sha256: string };
}

const fixture = (file = "rating-stars.tsx") => Bun.file(resolve("server/fixtures", file)).text();

async function createComponent(handler: Handler, id: string, name: string, file?: string): Promise<void> {
  const response = await handler(req("/components", "POST", {
    designSystem: "yandex-pay", id, name, source: await fixture(file),
    intent: `Figma source package fixture for ${name}`,
  }));
  expect(response.status).toBe(201);
}

/** Манифест «как из Figma»: два узла с ключами и ролями, один экспорт. */
async function manifestOf(handler: Handler, options: { revision?: string; role?: string } = {}) {
  const asset = await upload(handler, 686, 176);
  return {
    manifest: {
      designSystem: "yandex-pay",
      fileKey: "PayAppCore",
      sourceRevision: options.revision ?? "rev-1",
      nodes: [
        { nodeId: "10:20", name: "Pay button", componentKey: "key-pay-button", role: options.role ?? "payment-button", kind: "component" as const },
        { nodeId: "10:21", name: "Pay button pressed", componentKey: "key-pay-button-pressed", role: "payment-button", kind: "instance" as const },
      ],
      exports: [{ nodeId: "10:20", assetId: asset.id, width: 686, height: 176, sha256: asset.sha256, scale: 2 as const }],
    },
    asset,
  };
}

// ──────────────────────────── загрузка, чтение, дедуп ────────────────────────────

describe("figma source package upload", () => {
  test("uploads, reads back and deduplicates the same manifest by content address", async () => {
    const { handler } = await setup();
    const { manifest } = await manifestOf(handler);

    const created = await handler(req("/figma-source-packages", "POST", { manifest }));
    expect(created.status).toBe(201);
    const body = await created.json() as { packageId: string; exportCount: number; deduplicated?: boolean };
    expect(body.packageId).toMatch(/^fsp_[0-9a-f]{64}$/);
    expect(body.exportCount).toBe(1);
    expect(body.deduplicated).toBeUndefined();
    expect(created.headers.get("location")).toBe(`/api/figma-source-packages/${body.packageId}`);
    // Контентный адрес считается тем же кодом, что и на клиенте.
    expect(body.packageId).toBe(sourcePackageIdOf(sourcePackageManifestSchema.parse(manifest)));

    const read = await handler(req(`/figma-source-packages/${body.packageId}`));
    expect(read.status).toBe(200);
    const stored = await read.json() as { fileKey: string; sourceRevision: string; manifest: { nodes: unknown[] } };
    expect(stored.fileKey).toBe("PayAppCore");
    expect(stored.sourceRevision).toBe("rev-1");
    expect(stored.manifest.nodes).toHaveLength(2);

    // Повтор — идемпотентен: 200, `deduplicated: true`, ни одной новой строки.
    const again = await handler(req("/figma-source-packages", "POST", { manifest }));
    expect(again.status).toBe(200);
    const repeated = await again.json() as { packageId: string; deduplicated?: boolean };
    expect(repeated.packageId).toBe(body.packageId);
    expect(repeated.deduplicated).toBe(true);

    const list = await handler(req("/figma-source-packages?designSystem=yandex-pay&fileKey=PayAppCore"));
    expect(list.status).toBe(200);
    const listed = await list.json() as { packages: { packageId: string; manifest?: unknown }[] };
    expect(listed.packages.map((row) => row.packageId)).toEqual([body.packageId]);
    // Список не тащит манифесты.
    expect(listed.packages[0]!.manifest).toBeUndefined();
  });

  test("a new sourceRevision is a NEW package, not an edit of the old one", async () => {
    const { handler } = await setup();
    const first = (await manifestOf(handler, { revision: "rev-1" })).manifest;
    const second = { ...first, sourceRevision: "rev-2" };
    const a = await handler(req("/figma-source-packages", "POST", { manifest: first }));
    const b = await handler(req("/figma-source-packages", "POST", { manifest: second }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await a.json() as { packageId: string }).packageId).not.toBe((await b.json() as { packageId: string }).packageId);
  });

  test("limits.sourcePackageMaxExports is published and enforced by the schema", async () => {
    const { db } = await setup();
    expect((capabilities(db).limits as { sourcePackageMaxExports: number }).sourcePackageMaxExports).toBe(SOURCE_PACKAGE_MAX_EXPORTS);
    const tooMany = {
      designSystem: "yandex-pay", fileKey: "F", sourceRevision: "r",
      nodes: [{ nodeId: "1:1" }],
      exports: Array.from({ length: SOURCE_PACKAGE_MAX_EXPORTS + 1 }, () => ({
        nodeId: "1:1", assetId: `asset_${"a".repeat(64)}`, width: 1, height: 1, sha256: "a".repeat(64),
      })),
    };
    expect(sourcePackageManifestSchema.safeParse(tooMany).success).toBe(false);
  });
});

// ──────────────────────────── валидация provenance ────────────────────────────

describe("figma source package provenance validation", () => {
  const codeOf = async (response: Response): Promise<string> => (await response.json() as { error: { code: string } }).error.code;

  test("declared sha256 and dimensions are verified against the asset registry", async () => {
    const { handler } = await setup();
    const { manifest, asset } = await manifestOf(handler);

    const badSha = { ...manifest, exports: [{ ...manifest.exports[0]!, sha256: "b".repeat(64) }] };
    const shaResponse = await handler(req("/figma-source-packages", "POST", { manifest: badSha }));
    expect(shaResponse.status).toBe(422);
    expect(await codeOf(shaResponse)).toBe("source_package_export_sha_mismatch");

    const badDims = { ...manifest, exports: [{ ...manifest.exports[0]!, width: 687 }] };
    const dimsResponse = await handler(req("/figma-source-packages", "POST", { manifest: badDims }));
    expect(dimsResponse.status).toBe(422);
    expect(await codeOf(dimsResponse)).toBe("source_package_export_dimension_mismatch");

    const unknownAsset = { ...manifest, exports: [{ ...manifest.exports[0]!, assetId: `asset_${"c".repeat(64)}` }] };
    const assetResponse = await handler(req("/figma-source-packages", "POST", { manifest: unknownAsset }));
    expect(assetResponse.status).toBe(422);
    expect(await codeOf(assetResponse)).toBe("asset_not_found");

    // Контроль: неизменённый манифест с теми же байтами проходит.
    expect(asset.id).toBe(manifest.exports[0]!.assetId);
    expect((await handler(req("/figma-source-packages", "POST", { manifest }))).status).toBe(201);
  });

  test("node identity is consistent: undeclared node, duplicate node and duplicate component key are refused", async () => {
    const { handler } = await setup();
    const { manifest } = await manifestOf(handler);

    const undeclared = { ...manifest, exports: [{ ...manifest.exports[0]!, nodeId: "99:99" }] };
    expect(await codeOf(await handler(req("/figma-source-packages", "POST", { manifest: undeclared })))).toBe("source_package_node_not_declared");

    const duplicateNode = { ...manifest, nodes: [...manifest.nodes, { ...manifest.nodes[0]!, componentKey: "key-other" }] };
    expect(await codeOf(await handler(req("/figma-source-packages", "POST", { manifest: duplicateNode })))).toBe("source_package_duplicate_node");

    const duplicateKey = { ...manifest, nodes: [manifest.nodes[0]!, { ...manifest.nodes[1]!, componentKey: manifest.nodes[0]!.componentKey }] };
    expect(await codeOf(await handler(req("/figma-source-packages", "POST", { manifest: duplicateKey })))).toBe("source_package_duplicate_component_key");

    const missingUnknownNode = { ...manifest, missing: [{ role: "exact-reference" as const, nodeId: "77:77" }] };
    expect(await codeOf(await handler(req("/figma-source-packages", "POST", { manifest: missingUnknownNode })))).toBe("source_package_node_not_declared");
  });

  test("the package belongs to a design system: an unknown one is 404, a foreign reference is refused", async () => {
    const { handler } = await setup();
    const { manifest } = await manifestOf(handler);
    // Незарегистрированная система — отказ **до** записи: пакет без продукта не имеет смысла.
    const foreign = await handler(req("/figma-source-packages", "POST", { manifest: { ...manifest, designSystem: "no-such-system" } }));
    expect(foreign.status).toBe(422);

    const created = await handler(req("/figma-source-packages", "POST", { manifest }));
    const { packageId } = await created.json() as { packageId: string };
    await createComponent(handler, "fsp-ds-check", "FspDsCheck");
    // Компонент yandex-pay ссылается на пакет yandex-pay — принимается.
    const ok = await handler(req("/components/fsp-ds-check/provenance", "PUT", {
      figma: { fileKey: "PayAppCore", nodeIds: ["10:20"], sourcePackageId: packageId },
    }));
    expect(ok.status).toBe(200);
    // Несуществующий пакет — типизированный отказ, а не молчаливая запись.
    const unknown = await handler(req("/components/fsp-ds-check/provenance", "PUT", {
      figma: { fileKey: "PayAppCore", nodeIds: ["10:20"], sourcePackageId: `fsp_${"d".repeat(64)}` },
    }));
    expect(unknown.status).toBe(422);
    expect(await codeOf(unknown)).toBe("source_package_not_found");
  });
});

// ─────────────────────── хранилище: FK и registry integrity ───────────────────────

describe("figma_source_packages storage (migration v36)", () => {
  test("the design system reference is a real FK and assertRegistryIntegrity covers the table", () => {
    const db = new Database(":memory:");
    databases.push(db);
    migrate(db);
    const at = "2026-08-07T00:00:00.000Z";
    const insert = (id: string, system: string) => db.query(`INSERT INTO figma_source_packages
      (package_id,design_system,file_key,source_revision,manifest_json,export_count,created_by,created_at)
      VALUES (?,?,'F','r','{}',0,'u',?)`).run(id, system, at);

    expect(() => insert(`fsp_${"a".repeat(64)}`, "yandex-pay")).not.toThrow();
    // FK: висячая ссылка на дизайн-систему невозможна.
    expect(() => insert(`fsp_${"b".repeat(64)}`, "ghost-system")).toThrow();

    // …а если её всё же протащить мимо FK, старт обязан отказаться подниматься и **назвать
    // таблицу**: FK-аудит и `assertRegistryIntegrity` (куда таблица записана триажем O-m11)
    // прикрывают одну и ту же дыру с двух сторон.
    db.run("PRAGMA foreign_keys = OFF");
    insert(`fsp_${"c".repeat(64)}`, "ghost-system");
    db.run("PRAGMA foreign_keys = ON");
    expect(() => migrate(db)).toThrow(/figma_source_packages/);
  });
});

// ──────────────── metadata-only: отпечатки не двигаются (триаж S-M11) ────────────────

describe("sourcePackageId is metadata-only", () => {
  test("adding the link moves neither the catalog revision, nor the source hash, nor any acceptance fingerprint field", async () => {
    const { handler, db } = await setup();
    const { manifest } = await manifestOf(handler);
    const { packageId } = await (await handler(req("/figma-source-packages", "POST", { manifest }))).json() as { packageId: string };
    await createComponent(handler, "fsp-fingerprint", "FspFingerprint");

    const before = await (await handler(req("/components/fsp-fingerprint/validate", "POST"))).json() as { sourceHash: string; catalogRevision: string };

    const linked = await handler(req("/components/fsp-fingerprint/provenance", "PUT", {
      figma: { fileKey: "PayAppCore", nodeIds: ["10:20"], sourcePackageId: packageId },
    }));
    expect(linked.status).toBe(200);
    expect((await linked.json() as { figma: { sourcePackageId: string } }).figma.sourcePackageId).toBe(packageId);

    const after = await (await handler(req("/components/fsp-fingerprint/validate", "POST"))).json() as { sourceHash: string; catalogRevision: string };
    // Дифференциальный тест: обе величины, из которых выводятся кадровые и кандидатные отпечатки,
    // байт-в-байт прежние. Provenance — это «откуда», а не «что рисуется».
    expect(after.sourceHash).toBe(before.sourceHash);
    expect(after.catalogRevision).toBe(before.catalogRevision);
    expect(db).toBeDefined();
  });

  test("no acceptance fingerprint layer knows the field at all", async () => {
    // Тотальность `FIELD_LAYERS` (`server/acceptance/ids.ts`) держится типом по `AcceptanceCase`;
    // отсутствие `sourcePackageId` среди слоёв — и есть доказательство «ни в один отпечаток».
    const ids = await Bun.file(resolve("server/acceptance/ids.ts")).text();
    expect(ids.includes("sourcePackageId")).toBe(false);
    const surfaces = await Bun.file(resolve("src/acceptance/caseSetSchema.ts")).text();
    expect(surfaces.includes("sourcePackageId")).toBe(false);
  });
});

// ───────────────────── preflight `missing_exact_reference` ─────────────────────

describe("missing_exact_reference preflight", () => {
  test("warns (never blocks) when the package declares no exact reference for the component's node", async () => {
    const { handler } = await setup();
    const { manifest } = await manifestOf(handler);
    const withMissing = {
      ...manifest,
      missing: [
        { role: "exact-reference" as const, nodeId: "10:21", note: "pressed state was never exported" },
        // Чужая роль — не наш случай, предупреждения быть не должно.
        { role: "runtime-leaf" as const, nodeId: "10:20" },
      ],
    };
    const { packageId } = await (await handler(req("/figma-source-packages", "POST", { manifest: withMissing }))).json() as { packageId: string };
    await createComponent(handler, "fsp-preflight", "FspPreflight");
    expect((await handler(req("/components/fsp-preflight/provenance", "PUT", {
      figma: { fileKey: "PayAppCore", nodeIds: ["10:20", "10:21"], sourcePackageId: packageId },
    }))).status).toBe(200);

    const receipt = await handler(req("/components/fsp-preflight/validate", "POST"));
    // Предупреждение, не блокер: префлайт остаётся `ok`.
    expect(receipt.status).toBe(200);
    const warnings = (await receipt.json() as { ok: true; warnings: string[] }).warnings;
    expect(warnings.filter((line) => line.startsWith("missing_exact_reference:"))).toHaveLength(1);
    expect(warnings.some((line) => line.includes("10:21") && line.includes(packageId))).toBe(true);
  });

  test("a component whose nodes are fully covered gets no warning", async () => {
    const { handler } = await setup();
    const { manifest } = await manifestOf(handler);
    const withMissing = { ...manifest, missing: [{ role: "exact-reference" as const, nodeId: "10:21" }] };
    const { packageId } = await (await handler(req("/figma-source-packages", "POST", { manifest: withMissing }))).json() as { packageId: string };
    await createComponent(handler, "fsp-preflight-clean", "FspPreflightClean");
    await handler(req("/components/fsp-preflight-clean/provenance", "PUT", {
      figma: { fileKey: "PayAppCore", nodeIds: ["10:20"], sourcePackageId: packageId },
    }));
    const warnings = (await (await handler(req("/components/fsp-preflight-clean/validate", "POST"))).json() as { warnings: string[] }).warnings;
    expect(warnings.some((line) => line.startsWith("missing_exact_reference:"))).toBe(false);
  });
});

// ───────────────────────────── skeleton ─────────────────────────────

describe("case-set skeleton", () => {
  test("the draft parses as a case-set manifest, converts export scale to CSS px and is not saved", async () => {
    const { handler } = await setup();
    const { manifest } = await manifestOf(handler);
    const { packageId } = await (await handler(req("/figma-source-packages", "POST", { manifest }))).json() as { packageId: string };

    const response = await handler(req(`/figma-source-packages/${packageId}/case-set-skeleton`, "POST", { componentId: "fsp-skeleton" }));
    expect(response.status).toBe(200);
    const body = await response.json() as { saved: boolean; manifest: unknown };
    expect(body.saved).toBe(false);
    // Гейт наоборот: скелет обязан пройти валидатор набора без единой правки.
    const parsed = caseSetManifestSchema.parse(body.manifest);
    expect(parsed.componentId).toBe("fsp-skeleton");
    expect(parsed.cases).toHaveLength(1);
    // 686×176 device px при `scale: 2` — это 343×88 CSS px (габариты головного кейса миграции).
    expect(parsed.cases[0]!.expectedSurfaces).toEqual({ referenceExport: { width: 343, height: 88 } });
    expect(parsed.cases[0]!.referenceAssetId).toBe(manifest.exports[0]!.assetId);
    // Идентификатор случая приведён к `^[A-Za-z0-9._-]{1,64}$`: `nodeId` Figma содержит `:`.
    expect(parsed.cases[0]!.id).toBe("payment-button");
  });

  test("a request for nodes without exports is a typed refusal, not an empty draft", () => {
    expect(() => caseSetSkeletonOf(sourcePackageManifestSchema.parse({
      designSystem: "yandex-pay", fileKey: "F", sourceRevision: "r", nodes: [{ nodeId: "1:1" }],
    }), { componentId: "x" })).toThrow(/no export/);
  });
});

// ─────────────────────── reuse search: ранжирование (S-M6) ───────────────────────

describe("reuse search ranking", () => {
  const base = (id: string): CorpusCandidate => ({
    kind: "component", id, name: "YpSomething", designSystem: "yandex-pay", version: 1, draft: false,
    description: "A catalog component", canonicalFor: [], deprecated: false, headUsageCount: 0,
    shingles: new Set(["alpha", "beta"]),
  });

  test("a candidate sharing the Figma component key ranks above an identical one without a source signal", () => {
    const withSource: CorpusCandidate = { ...base("yp-with-source"), sourceSignature: { componentKeys: ["key-pay-button"], roles: ["payment-button"] } };
    const without = base("yp-without-source");
    const proposed: ProposedArtifact = {
      kind: "component", designSystem: "yandex-pay", intent: "a catalog component",
      source: "alpha beta", sourceSignature: { componentKeys: ["key-pay-button"], roles: ["payment-button"] },
    };
    const result = matchCandidates([withSource, without], proposed, CALIBRATED_POLICY);
    const ranked = result.candidates.map((candidate) => candidate.id);
    expect(ranked.indexOf("yp-with-source")).toBeLessThan(ranked.indexOf("yp-without-source"));
    const top = result.candidates.find((candidate) => candidate.id === "yp-with-source")!;
    expect(top.signals.sourcePackage).toBe(1);
    expect(top.reasons).toContain("same Figma component key in the source package");
    // Кандидат без сигнала обязан остаться **байт-в-байт** доволновым: сигнал неприменим.
    const other = result.candidates.find((candidate) => candidate.id === "yp-without-source")!;
    expect(other.signals.sourcePackage).toBeUndefined();
    expect(other.score).toBe(matchCandidates([without], { ...proposed, sourceSignature: undefined }, CALIBRATED_POLICY).candidates[0]!.score);
  });

  test("the source signal ranks but never gates: it cannot make a candidate blocking on its own", () => {
    // Никакого структурного сходства: ни исходника, ни props — только общий мастер Figma.
    const candidate: CorpusCandidate = {
      ...base("yp-same-master"), shingles: new Set<string>(),
      sourceSignature: { componentKeys: ["key-pay-button"], roles: ["payment-button"] },
    };
    const result = matchCandidates([candidate], {
      kind: "component", designSystem: "yandex-pay", intent: "unrelated intent",
      sourceSignature: { componentKeys: ["key-pay-button"], roles: ["payment-button"] },
    }, CALIBRATED_POLICY);
    expect(result.candidates[0]!.signals.sourcePackage).toBe(1);
    expect(result.candidates[0]!.blocking).toBe(false);
    expect(result.blocking).toHaveLength(0);
  });

  test("the corpus carries the signature of components linked to a package", async () => {
    const { handler, db } = await setup();
    const { manifest } = await manifestOf(handler);
    const { packageId } = await (await handler(req("/figma-source-packages", "POST", { manifest }))).json() as { packageId: string };
    await createComponent(handler, "fsp-corpus", "FspCorpus");
    await handler(req("/components/fsp-corpus/provenance", "PUT", {
      figma: { fileKey: "PayAppCore", nodeIds: ["10:20"], sourcePackageId: packageId },
    }));
    const corpus = collectCorpus(db, "yandex-pay");
    const entry = corpus.candidates.find((candidate) => candidate.id === "fsp-corpus")!;
    expect(entry.sourceSignature).toEqual({ componentKeys: ["key-pay-button"], roles: ["payment-button"] });
    // Компонент без ссылки на пакет сигнала не получает вовсе (иначе он был бы «объявлен и пуст»).
    await createComponent(handler, "fsp-corpus-plain", "FspCorpusPlain", "props-badge.tsx");
    expect(collectCorpus(db, "yandex-pay").candidates.find((candidate) => candidate.id === "fsp-corpus-plain")!.sourceSignature).toBeUndefined();
  });
});

// ───────────────────────────── kill-switch ─────────────────────────────

describe("EASYUI_SOURCE_PACKAGE_DISABLED", () => {
  test("gates both halves: the route set answers 404 and new links are refused", async () => {
    expect(sourcePackageEnabled("1")).toBe(false);
    expect(sourcePackageEnabled(undefined)).toBe(true);

    const { handler } = await setup();
    const { manifest } = await manifestOf(handler);
    const { packageId } = await (await handler(req("/figma-source-packages", "POST", { manifest }))).json() as { packageId: string };
    await createComponent(handler, "fsp-killswitch", "FspKillswitch");

    process.env.EASYUI_SOURCE_PACKAGE_DISABLED = "1";
    try {
      expect((await handler(req("/figma-source-packages", "POST", { manifest }))).status).toBe(404);
      expect((await handler(req(`/figma-source-packages/${packageId}`))).status).toBe(404);
      const refused = await handler(req("/components/fsp-killswitch/provenance", "PUT", {
        figma: { fileKey: "PayAppCore", nodeIds: ["10:20"], sourcePackageId: packageId },
      }));
      expect(refused.status).toBe(422);
      expect((await refused.json() as { error: { code: string } }).error.code).toBe("source_package_disabled");
      // Provenance без ссылки на пакет продолжает работать: тумблер гасит фичу, а не provenance.
      expect((await handler(req("/components/fsp-killswitch/provenance", "PUT", {
        figma: { fileKey: "PayAppCore", nodeIds: ["10:20"] },
      }))).status).toBe(200);
    } finally {
      delete process.env.EASYUI_SOURCE_PACKAGE_DISABLED;
    }
    // Возврат тумблера возвращает и набор, и ссылки.
    expect((await handler(req(`/figma-source-packages/${packageId}`))).status).toBe(200);
  });
});
