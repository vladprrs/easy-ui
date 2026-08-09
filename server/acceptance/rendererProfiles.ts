/**
 * **Профили политики рендерера** (EUI-BR-07, план `docs/plans/2026-08-08-blocker-removal-eui-br.md`
 * §7, capability `rendererPolicyProfilesV2`).
 *
 * Что это. Единственный легальный способ сказать «этот остаток производит **растеризатор**, а не
 * компонент» — и сказать это **заранее**, а не по результату конкретного рана. Профиль объявляет
 * четыре вещи: под каким рендерером он действует, к какому классу краски и в какой области
 * применяется, какой остаток при этом допустим и **чем он протухает**.
 *
 * Три границы, за которые профиль не выходит (все три — прямые требования плана и фидбэка §10):
 *
 * 1. **Он не создаётся из рана.** Реестр — константы кода, публикуемые в `/capabilities` до
 *    съёмки (паттерн `TEXT_AA_PRESETS`, `gates/visual.ts`). Профиль, выведенный из наблюдённого
 *    расхождения, был бы не политикой, а самооправданием.
 * 2. **Он не применяет общий процент к случаю.** Применение поштучное: каждый кластер обязан
 *    оказаться renderer-only классом **в scope профиля**; один structural или unknown кластер — и
 *    профиль не применяется вовсе (`structural` не смягчается никогда и ничем).
 * 3. **Он протухает.** Пять отпечатков (`renderer`, `fonts`, `matte`, `asset`, `geometry`):
 *    несовпадение любого — типизированная причина неприменимости, а не молчаливое «сойдёт».
 *    Отпечаток, которого профиль не объявил, не проверяется вовсе — «объявлено» и «совпало» это
 *    разные вопросы, и второй задаётся только по первому.
 *
 * Итог применения — `exceptions[]` визуального гейта, то есть первый в продукте производитель
 * `pass_with_exceptions` (до волны его не писал никто, и статус был недостижим). Роняет ли это ран
 * или нет, решает **политика** (`allowExceptions`), а не профиль рендерера: профиль объясняет
 * пиксели, промоутабельность объявляет `PROMOTION_POLICY_PROFILES` (`policies.ts`).
 */
import type { PaintClass } from "../visual/attribution";

/** Активны ли профили политики рендерера. Своя ось: тумблер меняет **promote-eligibility**. */
export const rendererPolicyProfilesEnabled = (): boolean =>
  process.env.EASYUI_RENDERER_POLICY_PROFILES_DISABLED !== "1";

/** Отпечатки, по которым профиль протухает. Объявленный и не совпавший — отказ с причиной. */
export interface RendererProfileExpiry {
  /** `rendererFingerprint` сборки, снявшей кадр. */
  renderer?: string;
  /** Шрифтовые отпечатки образа (`fontStackSha256`/`appFontsSha256`, склеенные через `:`). */
  fonts?: string;
  /** Объявленный случаем matte сравнения (`comparison.matte`), включая `"none"`. */
  matte?: string;
  /** Отпечаток эталонного ассета (`referenceSha256`). */
  asset?: string;
  /** Версия контракта измерения геометрии кадра. */
  geometry?: string;
}

export interface RendererPolicyProfile {
  profileId: string;
  /** Рендерер, под которым профиль объявлен; `null` — под любым (только для документированных). */
  rendererFingerprint: string | null;
  scope: {
    paintClass: PaintClass;
    /** Область канвы в device px; отсутствует — весь кластерный набор случая. */
    region?: { x: number; y: number; width: number; height: number };
  };
  /** Потолок остатка, который профиль объясняет, % поверхности сравнения. */
  maxResidualPct: number;
  expiry: RendererProfileExpiry;
  /** Зачем профиль существует — читается в `/capabilities`, а не только в коде. */
  description: string;
}

/**
 * Реестр. Пуст по построению до первого **объявленного** профиля: пустой реестр — это «ни один
 * остаток не объясняется политикой», то есть ровно доволновое поведение, и заводить сюда пример
 * «на всякий случай» значило бы раздать промоутабельность неизвестно чему.
 *
 * Профиль `live-text-aa-v1` заведён как первый настоящий: он покрывает ровно тот класс, ради
 * которого существует `edgeResidual`, — остаток сглаживания **живого текста** на контурах эталона,
 * и только под тем рендерером, под которым он откалиброван (объявляется деплоем через
 * `EASYUI_RENDERER_POLICY_FINGERPRINT`; без него профиль неприменим вовсе — `renderer_undeclared`).
 */
export function rendererPolicyProfiles(): RendererPolicyProfile[] {
  if (!rendererPolicyProfilesEnabled()) return [];
  const renderer = process.env.EASYUI_RENDERER_POLICY_FINGERPRINT ?? null;
  return [{
    profileId: "live-text-aa-v1",
    rendererFingerprint: renderer,
    scope: { paintClass: "live-text" },
    maxResidualPct: 0.75,
    expiry: { ...(renderer === null ? {} : { renderer }) },
    description: "Anti-aliasing residual of live text on the reference's own contours, calibrated for the declared renderer",
  }];
}

/** Типизированная причина неприменимости — «не подошло» обязано называть, чем именно. */
export type RendererProfileRejection =
  | "profiles_disabled"
  | "renderer_undeclared"
  | "renderer_expired"
  | "fonts_expired"
  | "matte_expired"
  | "asset_expired"
  | "geometry_expired"
  | "scope_mismatch"
  | "residual_over_budget"
  | "structural_cluster"
  | "unknown_pixels"
  | "no_clusters";

export interface RendererProfileFingerprints {
  renderer: string | null;
  fonts: string | null;
  matte: string | null;
  asset: string | null;
  geometry: string | null;
}

/** Кластер в форме, которая нужна применению профиля (подмножество `AttributionCluster`). */
export interface ProfileCandidateCluster {
  paintClass: PaintClass;
  structural: boolean;
  rawDiffPct: number;
  boundsDevicePx: { x: number; y: number; width: number; height: number };
  ownerElementKey: string | null;
}

export interface RendererProfileDecision {
  applied: boolean;
  profileId: string | null;
  reason: RendererProfileRejection | null;
  /** Строки `exceptions[]` гейта — по одной на объяснённый кластер. */
  exceptions: string[];
  /** Отпечатки, по которым профиль проверялся (receipt: «чем именно он не протух»). */
  expiryChecked: RendererProfileExpiry;
}

const withinRegion = (
  bounds: { x: number; y: number; width: number; height: number },
  region: { x: number; y: number; width: number; height: number } | undefined,
): boolean => region === undefined
  || (bounds.x >= region.x && bounds.y >= region.y
    && bounds.x + bounds.width <= region.x + region.width
    && bounds.y + bounds.height <= region.y + region.height);

/**
 * Протух ли профиль. Проверяются **только объявленные** отпечатки: не объявленный отпечаток — не
 * обещание, и требовать его совпадения значило бы отвергать профиль за то, чего он не утверждал.
 * Объявленный, но не измеренный (`null` в фактах) считается **несовпавшим**: «не измерили» — не
 * «совпало» (тот же принцип, что у `textAaBudgetApplies`).
 */
export function profileExpiryReason(
  profile: RendererPolicyProfile,
  facts: RendererProfileFingerprints,
): RendererProfileRejection | null {
  const pairs: [keyof RendererProfileExpiry, string | null, RendererProfileRejection][] = [
    ["renderer", facts.renderer, "renderer_expired"],
    ["fonts", facts.fonts, "fonts_expired"],
    ["matte", facts.matte, "matte_expired"],
    ["asset", facts.asset, "asset_expired"],
    ["geometry", facts.geometry, "geometry_expired"],
  ];
  for (const [key, observed, rejection] of pairs) {
    const declared = profile.expiry[key];
    if (declared === undefined) continue;
    if (observed === null || observed !== declared) return rejection;
  }
  return null;
}

/**
 * Применение профилей — **вторая инстанция** вердикта (тот же приём, что у `textAaBudget`): она
 * рассматривается только у случая, уже провалившегося по бюджету, и только превращает `fail` в
 * `pass_with_exceptions`, когда **каждый** кластер расхождения объяснён профилем.
 */
export function applyRendererProfiles(input: {
  clusters: readonly ProfileCandidateCluster[];
  unknownPixels: number;
  fingerprints: RendererProfileFingerprints;
  judgedRawDiffPct: number;
  profiles?: readonly RendererPolicyProfile[];
}): RendererProfileDecision {
  const empty = { applied: false as const, profileId: null, exceptions: [] as string[], expiryChecked: {} };
  if (!rendererPolicyProfilesEnabled()) return { ...empty, reason: "profiles_disabled" };
  const profiles = input.profiles ?? rendererPolicyProfiles();
  if (input.clusters.length === 0) return { ...empty, reason: "no_clusters" };
  // Ни один structural кластер не смягчается — ни профилем, ни бюджетом, ни их комбинацией.
  if (input.clusters.some((cluster) => cluster.structural)) return { ...empty, reason: "structural_cluster" };
  // Пиксель без владельца профилем не покрывается по определению: профиль объявлен на класс
  // краски, а у неатрибутированного пикселя класса нет.
  if (input.unknownPixels > 0) return { ...empty, reason: "unknown_pixels" };

  let lastReason: RendererProfileRejection = "scope_mismatch";
  for (const profile of profiles) {
    if (profile.rendererFingerprint === null) { lastReason = "renderer_undeclared"; continue; }
    const expired = profileExpiryReason(profile, input.fingerprints);
    if (expired !== null) { lastReason = expired; continue; }
    if (profile.rendererFingerprint !== input.fingerprints.renderer) { lastReason = "renderer_expired"; continue; }
    if (!input.clusters.every((cluster) =>
      cluster.paintClass === profile.scope.paintClass && withinRegion(cluster.boundsDevicePx, profile.scope.region))) {
      lastReason = "scope_mismatch";
      continue;
    }
    if (input.judgedRawDiffPct > profile.maxResidualPct) { lastReason = "residual_over_budget"; continue; }
    return {
      applied: true,
      profileId: profile.profileId,
      reason: null,
      exceptions: input.clusters.map((cluster) =>
        `renderer-policy:${profile.profileId}:${cluster.ownerElementKey ?? "unattributed"}`
        + `:${cluster.paintClass}:${cluster.rawDiffPct}%`),
      expiryChecked: { ...profile.expiry },
    };
  }
  return { ...empty, reason: lastReason };
}
