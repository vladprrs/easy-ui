import { afterEach, expect, test } from "bun:test";
import {
  applyRendererProfiles, profileExpiryReason, rendererPolicyProfiles, rendererPolicyProfilesEnabled,
  type ProfileCandidateCluster, type RendererPolicyProfile, type RendererProfileFingerprints,
} from "./rendererProfiles";
import { ACCEPTANCE_POLICIES, PROMOTION_POLICY_PROFILES, isPromotionPolicyProfile, subjectPromotionEligible } from "./policies";

/**
 * Профили политики рендерера (EUI-BR-07, план 2026-08-08 §7) и то, что они меняют в promote.
 *
 * Предмет — ровно те границы, за которые профиль не должен выходить: он не покрывает `unknown` и
 * `structural`, он протухает по каждому из пяти отпечатков, и он **меняет promote-eligibility**,
 * поэтому живёт на своей оси тумблера.
 */

const RENDERER = "rf_calibrated";

afterEach(() => {
  delete process.env.EASYUI_RENDERER_POLICY_PROFILES_DISABLED;
  delete process.env.EASYUI_RENDERER_POLICY_FINGERPRINT;
});

const profile = (over: Partial<RendererPolicyProfile> = {}): RendererPolicyProfile => ({
  profileId: "live-text-aa-v1",
  rendererFingerprint: RENDERER,
  scope: { paintClass: "live-text" },
  maxResidualPct: 0.75,
  expiry: { renderer: RENDERER },
  description: "test",
  ...over,
});

const facts = (over: Partial<RendererProfileFingerprints> = {}): RendererProfileFingerprints => ({
  renderer: RENDERER, fonts: "fs:af", matte: "none", asset: "sha", geometry: "2", ...over,
});

const cluster = (over: Partial<ProfileCandidateCluster> = {}): ProfileCandidateCluster => ({
  paintClass: "live-text", structural: false, rawDiffPct: 0.4,
  boundsDevicePx: { x: 0, y: 0, width: 20, height: 10 }, ownerElementKey: "c//span.title", ...over,
});

test("реестр публикуется до рана и молчит без объявленного отпечатка рендерера", () => {
  expect(rendererPolicyProfilesEnabled()).toBe(true);
  const published = rendererPolicyProfiles();
  expect(published.map((item) => item.profileId)).toEqual(["live-text-aa-v1"]);
  // Без объявленного рендерера профиль существует в реестре, но неприменим: «под любым
  // рендерером» не бывает renderer-only политики.
  expect(published[0]!.rendererFingerprint).toBeNull();
  expect(applyRendererProfiles({
    clusters: [cluster()], unknownPixels: 0, judgedRawDiffPct: 0.4, fingerprints: facts(),
  })).toMatchObject({ applied: false, reason: "renderer_undeclared" });
});

test("объяснённый renderer-only остаток даёт exceptions[] с названным профилем и владельцем", () => {
  const decision = applyRendererProfiles({
    clusters: [cluster()], unknownPixels: 0, judgedRawDiffPct: 0.4,
    fingerprints: facts(), profiles: [profile()],
  });
  expect(decision).toMatchObject({ applied: true, profileId: "live-text-aa-v1", reason: null });
  expect(decision.exceptions).toEqual(["renderer-policy:live-text-aa-v1:c//span.title:live-text:0.4%"]);
  expect(decision.expiryChecked).toEqual({ renderer: RENDERER });
});

test("структурный кластер не смягчается профилем — даже рядом с AA-кластером", () => {
  expect(applyRendererProfiles({
    clusters: [cluster(), cluster({ paintClass: "geometry", structural: true })],
    unknownPixels: 0, judgedRawDiffPct: 0.4, fingerprints: facts(), profiles: [profile()],
  })).toMatchObject({ applied: false, reason: "structural_cluster", exceptions: [] });
});

test("неатрибутированные пиксели профилем не покрываются: у unknown нет класса краски", () => {
  expect(applyRendererProfiles({
    clusters: [cluster()], unknownPixels: 12, judgedRawDiffPct: 0.4, fingerprints: facts(), profiles: [profile()],
  })).toMatchObject({ applied: false, reason: "unknown_pixels" });
});

test("scope и потолок остатка проверяются отдельно от истечения", () => {
  expect(applyRendererProfiles({
    clusters: [cluster({ paintClass: "vector-edge" })], unknownPixels: 0, judgedRawDiffPct: 0.4,
    fingerprints: facts(), profiles: [profile()],
  })).toMatchObject({ applied: false, reason: "scope_mismatch" });
  expect(applyRendererProfiles({
    clusters: [cluster()], unknownPixels: 0, judgedRawDiffPct: 0.9, fingerprints: facts(), profiles: [profile()],
  })).toMatchObject({ applied: false, reason: "residual_over_budget" });
  // Область scope: кластер обязан лежать **внутри** объявленного прямоугольника целиком.
  expect(applyRendererProfiles({
    clusters: [cluster()], unknownPixels: 0, judgedRawDiffPct: 0.4, fingerprints: facts(),
    profiles: [profile({ scope: { paintClass: "live-text", region: { x: 0, y: 0, width: 8, height: 8 } } })],
  })).toMatchObject({ applied: false, reason: "scope_mismatch" });
});

test("истечение по каждому из пяти отпечатков — своя типизированная причина", () => {
  const cases: [keyof RendererProfileFingerprints, string][] = [
    ["renderer", "renderer_expired"],
    ["fonts", "fonts_expired"],
    ["matte", "matte_expired"],
    ["asset", "asset_expired"],
    ["geometry", "geometry_expired"],
  ];
  for (const [key, reason] of cases) {
    const declared = profile({ expiry: { renderer: RENDERER, fonts: "fs:af", matte: "none", asset: "sha", geometry: "2" } });
    expect(profileExpiryReason(declared, facts({ [key]: "moved" }))).toBe(reason as never);
    // «Не измерено» — это не «совпало»: объявленный, но неизвестный отпечаток тоже протухает.
    expect(profileExpiryReason(declared, facts({ [key]: null }))).toBe(reason as never);
  }
  // Не объявленный отпечаток не проверяется вовсе — профиль не утверждал о нём ничего.
  expect(profileExpiryReason(profile({ expiry: {} }), facts({ fonts: null, asset: null }))).toBeNull();
});

test("kill-switch гасит и реестр, и применение", () => {
  process.env.EASYUI_RENDERER_POLICY_PROFILES_DISABLED = "1";
  expect(rendererPolicyProfiles()).toEqual([]);
  expect(applyRendererProfiles({
    clusters: [cluster()], unknownPixels: 0, judgedRawDiffPct: 0.4, fingerprints: facts(), profiles: [profile()],
  })).toMatchObject({ applied: false, reason: "profiles_disabled" });
});

// ------------------------------------------------------- promote-eligibility

test("профиль политики default-v1-exceptions промоутабелен ровно при включённых профилях", () => {
  expect(ACCEPTANCE_POLICIES["default-v1-exceptions"].allowExceptions).toBe(true);
  // Существующие профили не тронуты: их `policyProfileHash` — идентичность уже принятых вердиктов.
  expect(ACCEPTANCE_POLICIES["default-v1"].allowExceptions).toBe(false);
  expect(ACCEPTANCE_POLICIES["pixel-strict-v1"].allowExceptions).toBe(false);
  expect(PROMOTION_POLICY_PROFILES).toContain("default-v1-exceptions");
  expect(isPromotionPolicyProfile("default-v1-exceptions")).toBe(true);
  process.env.EASYUI_RENDERER_POLICY_PROFILES_DISABLED = "1";
  expect(isPromotionPolicyProfile("default-v1-exceptions")).toBe(false);
  // Остальные профили тумблер не трогает вовсе.
  expect(isPromotionPolicyProfile("default-v1")).toBe(true);
  expect(isPromotionPolicyProfile("pixel-strict-v1")).toBe(true);
  expect(isPromotionPolicyProfile("whatever")).toBe(false);
});

// ------------------------------------------------------- BR-08: субъектная промоутабельность

test("subjectPromotionEligible: чистый субъект при грязной интеграции — да; грязный субъект — нет", () => {
  const declared = { ownershipDeclared: true };
  expect(subjectPromotionEligible({ ...declared, cases: [{ verdict: "fail", subjectFailed: false }] })).toBe(true);
  expect(subjectPromotionEligible({ ...declared, cases: [{ verdict: "fail", subjectFailed: true }] })).toBe(false);
  // Провал невизуального гейта субъектный вердикт не прощает никогда.
  expect(subjectPromotionEligible({ ...declared, cases: [{ verdict: "fail", subjectFailed: false, nonVisualFailed: true }] })).toBe(false);
  // Субъектный вердикт не посчитан ⇒ решает обычный вердикт случая («не измерено» ≠ «в допуске»).
  expect(subjectPromotionEligible({ ...declared, cases: [{ verdict: "pass" }] })).toBe(true);
  expect(subjectPromotionEligible({ ...declared, cases: [{ verdict: "fail" }] })).toBe(false);
  // Без объявления владения предикат неприменим вовсе, а пустой набор ничего не доказывает.
  expect(subjectPromotionEligible({ ownershipDeclared: false, cases: [{ verdict: "pass", subjectFailed: false }] })).toBe(false);
  expect(subjectPromotionEligible({ ...declared, cases: [] })).toBe(false);
});
