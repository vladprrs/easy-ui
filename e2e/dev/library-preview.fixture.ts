import { readFile } from "node:fs/promises";
import type { APIRequestContext } from "@playwright/test";
import { STARTER_DS_ID } from "../starter-ds.fixture";
import { createFixtureComponent } from "./reuse.fixture";

/**
 * Фикстуры инлайн-превью библиотеки (план 2026-07-31 §4.3.5, §4.4, §6 «E2E»).
 *
 * Плану нужны сущности, которых в базе нет ни одной: ни одна версия дизайн-системы не несёт
 * иконок и ни один активный бандл не импортирует `Icon`, поэтому критерий «иконка доминирующей
 * системы рендерится» без этих фикстур неисполним. Здесь заводятся: ассет-иконка + версия темы
 * `e2e-starter` с ней, вторая дизайн-система со своим значением того же токена (доказательство
 * per-card перекрытия `:root`), шрифты (семейство, уже объявленное хромом, и новое) и компоненты
 * под каждый сценарий — организм, атом, `position:fixed`, падающий рендер, `color()` в обеих системах.
 *
 * Исходники лежат здесь строками, а не в `server/fixtures/`: волна T7 владеет только `e2e/**`.
 */

const DEV_API = "/api";

/** Доминирующая система библиотеки — та, где записей больше; в dev-базе это `e2e-starter`. */
export const DOMINANT_DS_ID = STARTER_DS_ID;
/** Вторая система: её карточки обязаны получить свои токены, а не токены доминирующей. */
export const PREVIEW_DS_ID = "e2e-preview-ds";

export const PREVIEW_IDS = {
  organism: "e2e-preview-organism",
  atom: "e2e-preview-atom",
  icon: "e2e-preview-icon",
  fixed: "e2e-preview-fixed",
  broken: "e2e-preview-broken",
  accent: "e2e-preview-accent",
  scopedAccent: "e2e-preview-scoped-accent",
} as const;

export const PREVIEW_NAMES = {
  organism: "E2ePreviewOrganism",
  atom: "E2ePreviewAtom",
  icon: "E2ePreviewIcon",
  fixed: "E2ePreviewFixed",
  broken: "E2ePreviewBroken",
  accent: "E2ePreviewAccent",
  scopedAccent: "E2ePreviewScopedAccent",
} as const;

/** Один и тот же токен с разными значениями в двух системах — это и есть проверка scope. */
export const ACCENT_TOKEN = "color.e2e-accent";
export const ACCENT_DOMINANT = "rgb(255, 0, 0)";
export const ACCENT_SCOPED = "rgb(0, 128, 255)";

export const PREVIEW_ICON_NAME = "e2e-spark";
/** Семейство, которого у документа нет — fontRegistry обязан его зарегистрировать. */
export const NOVEL_FONT_FAMILY = "E2E Preview Font";
/** Семейство, которым набран сам хром (`src/styles/index.css`) — регистрировать его нельзя (M-2). */
export const DOCUMENT_FONT_FAMILY = "YS Text";

/** Идентичность записи read-model — пара `(designSystem, id)` (`libraryKey`/`libraryEntryKey`). */
export const previewKey = (designSystem: string, id: string): string => `${designSystem} ${id}`;

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M12 2 15 9l7 3-7 3-3 7-3-7-7-3 7-3z" fill="#e00"/></svg>';

const sources = {
  organism: `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string().min(1) }),
  events: [],
  slots: [],
  atomicLevel: "organism" as const,
  description: "E2E inline-preview organism: a fixed-size block that renders its label",
  example: { label: "Organism preview" },
};

type Props = z.output<typeof definition.props>;

export default function E2ePreviewOrganism({ props }: EasyUIComponentProps<Props>) {
  return <section data-e2e-preview-organism style={{ width: 220, height: 96, background: "#eef2ff", display: "flex", alignItems: "center", justifyContent: "center" }}>{props.label}</section>;
}
`,
  atom: `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string().min(1) }),
  events: [],
  slots: [],
  atomicLevel: "atom" as const,
  description: "E2E inline-preview atom: compact index row target",
  example: { label: "Atom preview" },
};

type Props = z.output<typeof definition.props>;

export default function E2ePreviewAtom({ props }: EasyUIComponentProps<Props>) {
  return <span data-e2e-preview-atom>{props.label}</span>;
}
`,
  icon: `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";
import { Icon } from "easy-ui/runtime/v4";

export const definition = {
  props: z.strictObject({ name: z.string().min(1) }),
  events: [],
  slots: [],
  atomicLevel: "organism" as const,
  description: "E2E inline-preview icon host: resolves an icon through the runtime shim",
  example: { name: "e2e-spark" },
};

type Props = z.output<typeof definition.props>;

export default function E2ePreviewIcon({ props }: EasyUIComponentProps<Props>) {
  return <span data-e2e-preview-icon style={{ display: "inline-flex", padding: 12 }}><Icon name={props.name} size={32} /></span>;
}
`,
  fixed: `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string().min(1) }),
  events: [],
  slots: [],
  atomicLevel: "organism" as const,
  description: "E2E inline-preview viewport-bounded component: a 100vh fixed overlay over its own box",
  example: { label: "Fixed overlay" },
};

type Props = z.output<typeof definition.props>;

export default function E2ePreviewFixed({ props }: EasyUIComponentProps<Props>) {
  return <div data-e2e-preview-fixed-host style={{ width: 200, height: 90, background: "#dff5e1" }}>
    {props.label}
    <div data-e2e-preview-fixed style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh", background: "rgba(255, 0, 0, 0.35)" }} />
  </div>;
}
`,
  broken: `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ label: z.string().min(1) }),
  events: [],
  slots: [],
  atomicLevel: "organism" as const,
  description: "E2E inline-preview component that always throws while rendering",
  example: { label: "Broken preview" },
};

type Props = z.output<typeof definition.props>;

export default function E2ePreviewBroken({ props }: EasyUIComponentProps<Props>) {
  // Бросок в теле, а не вместо возврата: тип компонента обязан остаться ReactNode-совместимым,
  // иначе publish-time typecheck отклонит исходник.
  if (props.label.length >= 0) throw new Error("E2E inline preview render failure: " + props.label);
  return <span data-e2e-preview-broken>{props.label}</span>;
}
`,
} as const;

/** `color()` — чистый `var(--eui-color-*)`, поэтому одно тело работает в обеих системах. */
function accentSource(componentName: string, marker: string): string {
  return `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";
import { color } from "easy-ui/runtime/v4";

export const definition = {
  props: z.strictObject({ label: z.string().min(1) }),
  events: [],
  slots: [],
  atomicLevel: "organism" as const,
  description: "E2E inline-preview accent block: paints itself with the color() token of its own design system",
  example: { label: "Accent" },
};

type Props = z.output<typeof definition.props>;

export default function ${componentName}({ props }: EasyUIComponentProps<Props>) {
  return <div ${marker} style={{ width: 180, height: 80, backgroundColor: color("e2e-accent", "rgb(1, 1, 1)"), display: "flex", alignItems: "center", justifyContent: "center" }}>{props.label}</div>;
}
`;
}

async function expectStatus(step: string, response: { status(): number; text(): Promise<string> }, allowed: number[]): Promise<void> {
  if (allowed.includes(response.status())) return;
  throw new Error(`library-preview fixture: ${step} failed with HTTP ${response.status()}: ${await response.text()}`);
}

const previewIntent = (id: string, name: string) => ({
  [PREVIEW_IDS.organism]: "Summarizes highlighted product content in a library preview card",
  [PREVIEW_IDS.atom]: "Displays compact product metadata in a library preview card",
  [PREVIEW_IDS.icon]: "Displays the shared product icon in a library preview card",
  [PREVIEW_IDS.fixed]: "Shows viewport-bounded product content inside a library preview",
  [PREVIEW_IDS.broken]: "Exercises product preview error isolation for the library",
  [PREVIEW_IDS.accent]: "Displays the dominant design-system accent in a library preview",
  [PREVIEW_IDS.scopedAccent]: "Displays a scoped design-system accent in a library preview",
}[id] ?? `Displays ${name} in a product library preview`);

const previewCandidateKey = (id: string) => `component:${DOMINANT_DS_ID}:${id}`;
const previewCollisionAllowlist = (id: string): string[] => {
  const structurallySimilar = [PREVIEW_IDS.organism, PREVIEW_IDS.fixed, PREVIEW_IDS.broken, PREVIEW_IDS.accent];
  return structurallySimilar.includes(id as typeof structurallySimilar[number])
    ? structurallySimilar.filter((candidateId) => candidateId !== id).map(previewCandidateKey)
    : [];
};

async function publish(request: APIRequestContext, api: string, seed: { id: string; name: string; source: string; designSystem: string }): Promise<void> {
  const existing = await request.get(`${api}/components/${seed.id}`);
  if (existing.status() === 200) {
    // Уже опубликован — фикстура идемпотентна; черновик после сорванного прогона дожимается.
    const meta = await existing.json() as { headRev: number; publishedVersion: number | null };
    if (meta.publishedVersion !== null) return;
    const published = await request.post(`${api}/components/${seed.id}/publish`, { data: { baseRev: meta.headRev } });
    await expectStatus(`publish component ${seed.id}`, published, [201]);
    return;
  }
  await expectStatus(`read component ${seed.id}`, existing, [404]);
  const created = await createFixtureComponent(request, api, {
    id: seed.id, name: seed.name, source: seed.source, designSystem: seed.designSystem, intent: previewIntent(seed.id, seed.name),
  }, {
    reason: "Отдельные preview-фикстуры проверяют разные режимы рендера и изоляции ошибок",
    allowedCandidateKeys: previewCollisionAllowlist(seed.id),
  });
  await expectStatus(`create component ${seed.id}`, created, [201]);
  const published = await request.post(`${api}/components/${seed.id}/publish`, { data: { baseRev: 1 } });
  await expectStatus(`publish component ${seed.id}`, published, [201]);
}

async function uploadAsset(request: APIRequestContext, api: string, file: { name: string; mimeType: string; buffer: Buffer }): Promise<string> {
  const response = await request.post(`${api}/assets`, { multipart: { file } });
  await expectStatus(`upload asset ${file.name}`, response, [200, 201]);
  return (await response.json() as { id: string }).id;
}

/** PATCH темы — CAS по последней мета-версии, поэтому она читается прямо перед записью. */
async function patchTheme(request: APIRequestContext, api: string, systemId: string, patch: Record<string, unknown>): Promise<void> {
  const summary = await request.get(`${api}/design-systems/${systemId}`);
  await expectStatus(`read design system ${systemId}`, summary, [200]);
  const { latestMetaVersion } = await summary.json() as { latestMetaVersion: number | null };
  const patched = await request.patch(`${api}/design-systems/${systemId}`, {
    data: { ...patch, baseVersion: latestMetaVersion ?? 0 },
  });
  await expectStatus(`patch theme ${systemId}`, patched, [200]);
}

/**
 * Провижн фикстур инлайн-превью. Идемпотентен по «тёплой» базе: dev-прогон всегда стартует с
 * вычищенного `.e2e-data/dev`, но шаг остаётся перезапускаемым.
 */
export async function ensureLibraryPreviewFixtures(request: APIRequestContext, api = DEV_API): Promise<void> {
  const already = await request.get(`${api}/components/${PREVIEW_IDS.scopedAccent}`);
  const warm = already.status() === 200;

  if (!warm) {
    const iconAsset = await uploadAsset(request, api, {
      name: "e2e-preview-spark.svg", mimeType: "image/svg+xml", buffer: Buffer.from(ICON_SVG, "utf8"),
    });
    const fontBytes = await readFile("public/fonts/YS-Text-Regular.woff2");
    const fontAsset = await uploadAsset(request, api, {
      name: "e2e-preview-font.woff2", mimeType: "font/woff2", buffer: fontBytes,
    });

    // Доминирующая система: иконка для шима `Icon` + своё значение общего токена.
    await patchTheme(request, api, DOMINANT_DS_ID, {
      tokens: { [ACCENT_TOKEN]: ACCENT_DOMINANT },
      icons: [{ name: PREVIEW_ICON_NAME, assetId: iconAsset }],
    });

    const created = await request.post(`${api}/design-systems`, {
      data: {
        id: PREVIEW_DS_ID,
        name: "E2E Preview DS",
        description: "Second design system for library inline-preview scoping and font-registry e2e checks.",
      },
    });
    await expectStatus("create preview design system", created, [201, 409]);
    // Два шрифта разом: одно семейство документ уже объявляет (регистрировать нельзя — M-2),
    // второго у него нет (регистрация обязана произойти).
    await patchTheme(request, api, PREVIEW_DS_ID, {
      tokens: { [ACCENT_TOKEN]: ACCENT_SCOPED },
      fonts: [
        { family: DOCUMENT_FONT_FAMILY, src: fontAsset, weight: 400, style: "normal" },
        { family: NOVEL_FONT_FAMILY, src: fontAsset, weight: 400, style: "normal" },
      ],
    });
  }

  await publish(request, api, { id: PREVIEW_IDS.organism, name: PREVIEW_NAMES.organism, source: sources.organism, designSystem: DOMINANT_DS_ID });
  await publish(request, api, { id: PREVIEW_IDS.atom, name: PREVIEW_NAMES.atom, source: sources.atom, designSystem: DOMINANT_DS_ID });
  await publish(request, api, { id: PREVIEW_IDS.icon, name: PREVIEW_NAMES.icon, source: sources.icon, designSystem: DOMINANT_DS_ID });
  await publish(request, api, { id: PREVIEW_IDS.fixed, name: PREVIEW_NAMES.fixed, source: sources.fixed, designSystem: DOMINANT_DS_ID });
  await publish(request, api, { id: PREVIEW_IDS.broken, name: PREVIEW_NAMES.broken, source: sources.broken, designSystem: DOMINANT_DS_ID });
  await publish(request, api, { id: PREVIEW_IDS.accent, name: PREVIEW_NAMES.accent, source: accentSource(PREVIEW_NAMES.accent, "data-e2e-preview-accent"), designSystem: DOMINANT_DS_ID });
  await publish(request, api, { id: PREVIEW_IDS.scopedAccent, name: PREVIEW_NAMES.scopedAccent, source: accentSource(PREVIEW_NAMES.scopedAccent, "data-e2e-preview-scoped-accent"), designSystem: PREVIEW_DS_ID });
}
