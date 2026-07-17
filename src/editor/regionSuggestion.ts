import { regionEligibility } from "../prototype/regionRules";
import type { PrototypeDoc, RegionKind } from "../prototype/schema";

type Screen = PrototypeDoc["screens"][number];

const statusBarPattern = /status[-_ ]?bar/i;
const headerPattern = /(app[-_ ]?bar|header|top[-_ ]?bar|nav[-_ ]?bar)/i;
const footerPattern = /(footer|tab[-_ ]?bar|bottom[-_ ]?(nav|bar))/i;

/** Conservative editor-only suggestion. The authored marker remains the source of truth. */
export function suggestRegion(screen: Screen, elementKey: string): RegionKind | null {
  if (!regionEligibility(screen).eligible) return null;
  const element = screen.spec.elements[elementKey];
  if (!element || element.region !== undefined) return null;

  const rootChildren = screen.spec.elements[screen.spec.root]?.children ?? [];
  const index = rootChildren.indexOf(elementKey);
  if (index < 0) return null;

  const occupied = new Set(
    Object.values(screen.spec.elements)
      .map((candidate) => candidate.region)
      .filter((region): region is RegionKind => region !== undefined),
  );
  const first = index === 0;
  const last = index === rootChildren.length - 1;

  if (first && statusBarPattern.test(element.type) && !occupied.has("statusBar")) return "statusBar";
  if (first && headerPattern.test(element.type) && !occupied.has("header")) return "header";
  if (last && footerPattern.test(element.type) && !occupied.has("footer")) return "footer";
  return null;
}
