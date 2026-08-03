import type { APIRequestContext } from "@playwright/test";
import { createFixtureComponent } from "./reuse.fixture";

/**
 * Вторая дизайн-система дуо-фикстуры (план `docs/plans/2026-08-02-multi-surface-flows.md`, W5).
 *
 * `test/fixtures/duo-kso.json` — мульти-поверхностный документ на **двух** ДС: приложение
 * покупателя (primary, `e2e-starter`) и КСО-терминал (вторая поверхность, эта система).
 * Панель второй ДС рендерится через `ScopedThemeSurface`, поэтому её компоненты обязаны
 * красить себя `color()` (чистый `var(--eui-color-*)`, скоупится инлайн-переменными), а не
 * `token()`/`Icon` — те читают глобальный снапшот **primary**-системы (D9(а)). Именно это и
 * проверяет e2e: токен `color.kso-*` этой темы виден только в КСО-панели.
 *
 * Компоненты живут строками здесь, а не в `server/fixtures/`: волна владеет `e2e/**`.
 */

const DEV_API = "/api";

export const KSO_DS_ID = "e2e-kso-ds";
export const KSO_PROTOTYPE_ID = "duo-kso";

export const KSO_IDS = {
  frame: "e2e-kso-frame",
  line: "e2e-kso-line",
  key: "e2e-kso-key",
} as const;

export const KSO_NAMES = {
  frame: "KsoTerminalFrame",
  line: "KsoTerminalLine",
  key: "KsoTerminalKey",
} as const;

/** Токены темы КСО: значения намеренно уникальны — по ним e2e узнаёт тему второй ДС в DOM. */
export const KSO_TOKENS = {
  "color.kso-screen": "rgb(233, 240, 255)",
  "color.kso-ink": "rgb(16, 24, 40)",
  "color.kso-accent": "rgb(0, 128, 255)",
} as const;
export const KSO_ACCENT = KSO_TOKENS["color.kso-accent"];
export const KSO_SCREEN = KSO_TOKENS["color.kso-screen"];

const frameSource = `import { z } from "zod";
import type { ReactNode } from "react";
import type { EasyUIComponentProps } from "easy-ui/runtime";
import { color } from "easy-ui/runtime/v4";

export const definition = {
  props: z.strictObject({ title: z.string().min(1), status: z.string().min(1) }),
  events: [],
  slots: ["default"],
  atomicLevel: "organism" as const,
  // Atomic policy: the bezel owns terminal chrome (status band pinned above a body area on a
  // canvas screen), which composition slots cannot express.
  ownership: { reason: "Owns self-checkout terminal chrome: the status band and body area of a canvas screen" },
  description: "Self-checkout terminal bezel: a titled screen with a status band and a body area",
  example: { title: "Касса самообслуживания", status: "Готова к работе" },
};

type Props = z.output<typeof definition.props>;

export default function KsoTerminalFrame({ props, children }: EasyUIComponentProps<Props> & { children?: ReactNode }) {
  return <section
    data-kso-frame
    style={{ minHeight: "100%", boxSizing: "border-box", padding: 56, display: "flex", flexDirection: "column", gap: 32, backgroundColor: color("kso-screen", "rgb(255, 255, 255)") }}
  >
    <header style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span data-kso-title style={{ fontSize: 44, fontWeight: 700, color: color("kso-ink", "rgb(0, 0, 0)") }}>{props.title}</span>
      <span data-kso-status style={{ fontSize: 26, color: color("kso-accent", "rgb(0, 0, 0)") }}>{props.status}</span>
    </header>
    <div data-kso-body style={{ display: "flex", flexDirection: "column", gap: 20 }}>{children}</div>
  </section>;
}
`;

const lineSource = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";
import { color } from "easy-ui/runtime/v4";

export const definition = {
  props: z.strictObject({ text: z.string().min(1), tone: z.enum(["normal", "muted"]).default("normal") }),
  events: [],
  slots: [],
  atomicLevel: "atom" as const,
  description: "Self-checkout terminal receipt line rendered in the terminal ink colour",
  example: { text: "Кофе с собой — 1 290 ₽", tone: "normal" },
};

type Props = z.output<typeof definition.props>;

export default function KsoTerminalLine({ props }: EasyUIComponentProps<Props>) {
  // Renderer не применяет zod-дефолты: компонент обороняется сам.
  const muted = props.tone === "muted";
  return <span
    data-kso-line
    data-tone={muted ? "muted" : "normal"}
    style={{ fontSize: muted ? 20 : 28, opacity: muted ? 0.65 : 1, color: color("kso-ink", "rgb(0, 0, 0)") }}
  >{props.text}</span>;
}
`;

const keySource = `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";
import { color } from "easy-ui/runtime/v4";

export const definition = {
  props: z.strictObject({ label: z.string().min(1), kind: z.enum(["primary", "secondary"]).default("primary") }),
  events: ["press"],
  slots: [],
  atomicLevel: "atom" as const,
  description: "Self-checkout terminal key: a large touch target painted with the terminal accent",
  example: { label: "Оплатить", kind: "primary" },
};

type Props = z.output<typeof definition.props>;

export default function KsoTerminalKey({ props, emit }: EasyUIComponentProps<Props>) {
  const secondary = props.kind === "secondary";
  return <button
    type="button"
    data-kso-key
    data-kind={secondary ? "secondary" : "primary"}
    onClick={() => emit("press")}
    style={{
      minHeight: 72,
      paddingInline: 32,
      fontSize: 26,
      borderRadius: 12,
      border: "2px solid " + color("kso-accent", "rgb(0, 0, 0)"),
      color: secondary ? color("kso-accent", "rgb(0, 0, 0)") : "rgb(255, 255, 255)",
      backgroundColor: secondary ? "transparent" : color("kso-accent", "rgb(0, 0, 0)"),
    }}
  >{props.label}</button>;
}
`;

const seeds = [
  { id: KSO_IDS.frame, name: KSO_NAMES.frame, source: frameSource, intent: "Кадр экрана кассы самообслуживания со статусной строкой заказа" },
  { id: KSO_IDS.line, name: KSO_NAMES.line, source: lineSource, intent: "Строка чека и пояснения на экране кассы самообслуживания" },
  { id: KSO_IDS.key, name: KSO_NAMES.key, source: keySource, intent: "Крупная клавиша действия на экране кассы самообслуживания" },
] as const;

/**
 * Кандидаты, с которыми компоненты терминала структурно похожи by design: стартовая ДС e2e
 * и её же превью-фикстуры. Список — полный allowlist осознанных дублей этой фикстуры.
 */
const KSO_ALLOWED_CANDIDATE_KEYS = [
  "component:e2e-starter:e2e-button",
  "component:e2e-starter:e2e-text",
  "component:e2e-starter:e2e-stack",
  "component:e2e-starter:e2e-preview-organism",
  "component:e2e-starter:e2e-preview-atom",
  "component:e2e-starter:e2e-preview-icon",
  "component:e2e-starter:e2e-preview-fixed",
  "component:e2e-starter:e2e-preview-broken",
  "component:e2e-starter:e2e-preview-accent",
  "component:e2e-preview-ds:e2e-preview-scoped-accent",
  "component:e2e-custom-ds:e2e-rating-stars",
  ...Object.values(KSO_IDS).map((id) => `component:${KSO_DS_ID}:${id}`),
];

async function expectStatus(step: string, response: { status(): number; text(): Promise<string> }, allowed: number[]): Promise<void> {
  if (allowed.includes(response.status())) return;
  throw new Error(`duo-kso fixture: ${step} failed with HTTP ${response.status()}: ${await response.text()}`);
}

/** PATCH темы — CAS по последней мета-версии, поэтому она читается прямо перед записью. */
async function patchTheme(request: APIRequestContext, api: string, patch: Record<string, unknown>): Promise<void> {
  const summary = await request.get(`${api}/design-systems/${KSO_DS_ID}`);
  await expectStatus(`read design system ${KSO_DS_ID}`, summary, [200]);
  const { latestMetaVersion } = await summary.json() as { latestMetaVersion: number | null };
  const patched = await request.patch(`${api}/design-systems/${KSO_DS_ID}`, { data: { ...patch, baseVersion: latestMetaVersion ?? 0 } });
  await expectStatus(`patch theme ${KSO_DS_ID}`, patched, [200]);
}

/**
 * Дизайн-система терминала с темой и тремя опубликованными компонентами. Идемпотентна:
 * dev-прогон стартует с вычищенного `.e2e-data/dev`, но шаг остаётся перезапускаемым.
 */
export async function ensureKsoDesignSystem(request: APIRequestContext, api = DEV_API): Promise<void> {
  const created = await request.post(`${api}/design-systems`, {
    data: {
      id: KSO_DS_ID,
      name: "E2E KSO Terminal",
      description: "Second design system of the duo-kso multi-surface fixture: the self-checkout terminal.",
    },
  });
  await expectStatus("create kso design system", created, [201, 409]);

  for (const seed of seeds) {
    const existing = await request.get(`${api}/components/${seed.id}`);
    if (existing.status() === 200) {
      const meta = await existing.json() as { headRev: number; publishedVersion: number | null };
      if (meta.publishedVersion !== null) continue;
      const republished = await request.post(`${api}/components/${seed.id}/publish`, { data: { baseRev: meta.headRev } });
      await expectStatus(`publish component ${seed.id}`, republished, [201]);
      continue;
    }
    await expectStatus(`read component ${seed.id}`, existing, [404]);
    const response = await createFixtureComponent(request, api, {
      id: seed.id, name: seed.name, source: seed.source, designSystem: KSO_DS_ID, intent: seed.intent,
    }, {
      reason: "Компоненты терминала КСО живут в отдельной дизайн-системе: дуо-фикстура проверяет per-surface резолв и темизацию",
      allowedCandidateKeys: KSO_ALLOWED_CANDIDATE_KEYS,
    });
    await expectStatus(`create component ${seed.id}`, response, [201]);
    const published = await request.post(`${api}/components/${seed.id}/publish`, { data: { baseRev: 1 } });
    await expectStatus(`publish component ${seed.id}`, published, [201]);
  }

  await patchTheme(request, api, { tokens: KSO_TOKENS });
}
