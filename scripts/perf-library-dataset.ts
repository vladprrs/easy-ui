import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../server/db";
import { compileComponent } from "../server/components/compile";
import { extractDefinition } from "../server/components/extract-subprocess";
import { materializeSource } from "../server/components/pipeline";
import type { DefinitionMeta } from "../server/components/types";
import { ComponentRepo } from "../server/repos/components";
import { fingerprintId, fingerprintJson, type Fingerprint } from "../server/visual/fingerprint";

/**
 * Датасет perf-гейта библиотеки (план 2026-07-31 §5).
 *
 * Сидинг идёт **напрямую в БД**, а не через `POST /api/components`: публикация одного компонента —
 * это `extractDefinition` (подпроцесс) + `typecheckComponent` + `compileComponent`, для 120
 * компонентов это неподъёмно. Плюс `components.name` глобально UNIQUE, а `DELETE /api/components/:id`
 * требует `baseRev` и отвечает 409, когда компонент используется, — провалившийся прогон навсегда
 * засорял бы базу. Поэтому шесть шаблонов компилируются один раз и размножаются по id/именам,
 * а весь мусор снимается одной транзакцией по префиксу `perf-library-`.
 *
 * Отсюда же и `--data-dir`: прямой `openDatabase()` работает только на том же хосте, где сервер,
 * поэтому `perf:library` объявлен local-only.
 */

export const PERF_LIBRARY_PREFIX = "perf-library-";

const SYSTEMS = [
  { id: `${PERF_LIBRARY_PREFIX}ds-core`, name: "Perf Library Core", description: "Доминирующая система perf-датасета библиотеки.", fonts: true },
  { id: `${PERF_LIBRARY_PREFIX}ds-fin`, name: "Perf Library Fintech", description: "Вторая система perf-датасета: свои цветовые токены.", fonts: false },
  { id: `${PERF_LIBRARY_PREFIX}ds-lab`, name: "Perf Library Lab", description: "Третья система perf-датасета: минимальная тема.", fonts: false },
] as const;

/** 3 core + 2 fin + 1 lab на каждые шесть записей ⇒ 60/40/20 на 120 компонентов. */
const SYSTEM_CYCLE = [0, 1, 0, 2, 0, 1] as const;

const TOTAL = 120;
const LEVEL_PLAN: { level: DefinitionMeta["atomicLevel"]; count: number }[] = [
  { level: "atom", count: 45 },
  { level: "molecule", count: 35 },
  { level: "organism", count: 35 },
  { level: "template", count: 3 },
  { level: "page", count: 2 },
];

const FONT_FAMILY = "PerfLibrarySans";
const FONT_SOURCE = "public/fonts/YS-Text-Regular.woff2";
const VISUAL_ASSET_NAME = `${PERF_LIBRARY_PREFIX}visual-baseline`;
const FONT_ASSET_NAME = `${PERF_LIBRARY_PREFIX}font.woff2`;

export interface PerfLibraryDatasetOptions { dataDir: string }
export interface PerfLibrarySeedResult {
  components: number; systems: number; prototypes: number; references: number;
  bundles: { name: string; bytes: number; hostAbiVersion: number }[];
}

const now = () => new Date().toISOString();
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const pad = (index: number) => String(index).padStart(3, "0");

// --- Шесть шаблонов -------------------------------------------------------
//
// Разный размер бандла — сознательно: карточки библиотеки грузят их параллельно, и одинаковые
// бандлы дали бы нереалистично ровный трафик. Props везде «оборонительные» (Renderer не применяет
// Zod-дефолты), поэтому все поля опциональные с фолбэком в теле компонента.

const templateSources: Record<string, string> = {
  chip: `import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({ label: z.string().optional(), tone: z.enum(["neutral", "accent"]).optional() }),
  slots: [],
  description: "Перф-фикстура: компактный чип статуса",
  example: { label: "Готово", tone: "accent" },
  examples: { neutral: { label: "Черновик" }, accent: { label: "Готово", tone: "accent" } },
  atomicLevel: "atom",
};

type Props = z.output<typeof definition.props>;

export default function PerfChip({ props }: BaseComponentProps<Props>) {
  const accent = props.tone === "accent";
  return <span style={{ display: "inline-flex", alignItems: "center", borderRadius: 999, padding: "6px 14px", fontSize: 13, background: accent ? "#e6f4ea" : "#eef0f4", color: accent ? "#137333" : "#4a4f57" }}>{props.label ?? "Чип"}</span>;
}
`,
  badge: `import { z } from "zod";
import { color } from "easy-ui/runtime/v4";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({ title: z.string().optional(), amount: z.number().optional() }),
  slots: [],
  description: "Перф-фикстура: бейдж суммы на токенах темы",
  example: { title: "Кэшбэк", amount: 320 },
  examples: { small: { title: "Кэшбэк", amount: 12 }, large: { title: "Кэшбэк", amount: 4200 } },
  atomicLevel: "atom",
};

type Props = z.output<typeof definition.props>;

export default function PerfBadge({ props }: BaseComponentProps<Props>) {
  return <span style={{ display: "inline-flex", flexDirection: "column", gap: 2, borderRadius: 16, padding: "10px 16px", background: color("surface-secondary", "#f2f3f5"), color: color("text-primary", "#12141a") }}>
    <span style={{ fontSize: 12, opacity: 0.7 }}>{props.title ?? "Бейдж"}</span>
    <strong style={{ fontSize: 18 }}>{(props.amount ?? 0).toLocaleString("ru-RU")} ₽</strong>
  </span>;
}
`,
  card: `import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({ title: z.string().optional(), caption: z.string().optional(), items: z.array(z.string()).optional() }),
  slots: [],
  description: "Перф-фикстура: карточка со списком фактов",
  example: { title: "Заказ №4821", caption: "Оплачен картой", items: ["Доставка завтра", "Чек отправлен"] },
  atomicLevel: "molecule",
};

type Props = z.output<typeof definition.props>;

export default function PerfCard({ props }: BaseComponentProps<Props>) {
  const items = props.items ?? [];
  return <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 280, borderRadius: 20, padding: 18, background: "#fff", boxShadow: "0 4px 16px rgba(18,20,26,.08)" }}>
    <strong style={{ fontSize: 16 }}>{props.title ?? "Карточка"}</strong>
    <span style={{ fontSize: 13, color: "#6b7280" }}>{props.caption ?? ""}</span>
    <ul style={{ display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" }}>
      {items.map((item, index) => <li key={index} style={{ display: "flex", gap: 8, fontSize: 13 }}>
        <span aria-hidden="true">•</span><span>{item}</span>
      </li>)}
    </ul>
  </div>;
}
`,
  list: `import { useMemo, useState } from "react";
import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({
    title: z.string().optional(),
    rows: z.array(z.strictObject({ label: z.string(), value: z.string(), tone: z.enum(["plain", "muted"]).optional() })).optional(),
  }),
  events: ["press"],
  slots: [],
  description: "Перф-фикстура: раскрывающийся список операций",
  example: { title: "Операции", rows: [{ label: "Кофе", value: "-320 ₽" }, { label: "Перевод", value: "+1 500 ₽", tone: "muted" }, { label: "Такси", value: "-780 ₽" }] },
  atomicLevel: "molecule",
};

type Props = z.output<typeof definition.props>;

export default function PerfList({ props, emit }: BaseComponentProps<Props>) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => props.rows ?? [], [props.rows]);
  const shown = expanded ? rows : rows.slice(0, 2);
  return <section style={{ display: "flex", flexDirection: "column", gap: 10, width: 300, borderRadius: 20, padding: 18, background: "#fff" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <strong style={{ fontSize: 15 }}>{props.title ?? "Список"}</strong>
      <button type="button" style={{ border: 0, background: "transparent", color: "#5b6cff", fontSize: 13 }} onClick={() => { setExpanded(!expanded); emit("press"); }}>
        {expanded ? "Свернуть" : "Показать все"}
      </button>
    </header>
    {shown.map((row, index) => <div key={index} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: row.tone === "muted" ? "#6b7280" : "#12141a" }}>
      <span>{row.label}</span><span>{row.value}</span>
    </div>)}
  </section>;
}
`,
  panel: `import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({
    heading: z.string().optional(),
    subheading: z.string().optional(),
    metrics: z.array(z.strictObject({ label: z.string(), value: z.string() })).optional(),
    footnote: z.string().optional(),
  }),
  slots: [],
  description: "Перф-фикстура: панель сводки с метриками",
  example: {
    heading: "Сводка за неделю",
    subheading: "12–18 августа",
    metrics: [{ label: "Платежи", value: "48" }, { label: "Возвраты", value: "3" }, { label: "Средний чек", value: "1 240 ₽" }],
    footnote: "Данные обновляются каждый час",
  },
  atomicLevel: "organism",
};

type Props = z.output<typeof definition.props>;

function Metric({ label, value }: { label: string; value: string }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 92, borderRadius: 14, padding: "10px 12px", background: "#f6f7fb" }}>
    <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", color: "#8a8f9a" }}>{label}</span>
    <strong style={{ fontSize: 18 }}>{value}</strong>
  </div>;
}

export default function PerfPanel({ props }: BaseComponentProps<Props>) {
  const metrics = props.metrics ?? [];
  return <section style={{ display: "flex", flexDirection: "column", gap: 14, width: 360, borderRadius: 24, padding: 20, background: "#fff", boxShadow: "0 8px 28px rgba(18,20,26,.10)" }}>
    <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <strong style={{ fontSize: 18 }}>{props.heading ?? "Панель"}</strong>
      <span style={{ fontSize: 13, color: "#6b7280" }}>{props.subheading ?? ""}</span>
    </header>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{metrics.map((metric, index) => <Metric key={index} label={metric.label} value={metric.value} />)}</div>
    <footer style={{ fontSize: 12, color: "#8a8f9a" }}>{props.footnote ?? ""}</footer>
  </section>;
}
`,
  screen: `import { z } from "zod";
import { color, space } from "easy-ui/runtime/v4";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({
    title: z.string().optional(),
    balance: z.string().optional(),
    actions: z.array(z.strictObject({ label: z.string(), hint: z.string().optional() })).optional(),
    operations: z.array(z.strictObject({ label: z.string(), value: z.string(), at: z.string().optional() })).optional(),
    disclaimer: z.string().optional(),
  }),
  slots: [],
  description: "Перф-фикстура: экран кошелька целиком",
  example: {
    title: "Кошелёк",
    balance: "18 420 ₽",
    actions: [{ label: "Пополнить", hint: "без комиссии" }, { label: "Перевести", hint: "по номеру" }, { label: "История" }],
    operations: [
      { label: "Супермаркет", value: "-1 240 ₽", at: "сегодня" },
      { label: "Зарплата", value: "+64 000 ₽", at: "вчера" },
      { label: "Подписка", value: "-299 ₽", at: "12 августа" },
      { label: "Кэшбэк", value: "+320 ₽", at: "11 августа" },
    ],
    disclaimer: "Курс обновляется раз в минуту",
  },
  atomicLevel: "page",
};

type Props = z.output<typeof definition.props>;

function Action({ label, hint }: { label: string; hint?: string }) {
  return <button type="button" style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, border: 0, borderRadius: 18, padding: "12px 10px", background: color("surface-secondary", "#f2f3f5"), color: color("text-primary", "#12141a"), textAlign: "left" }}>
    <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
    {hint ? <span style={{ fontSize: 11, opacity: 0.65 }}>{hint}</span> : null}
  </button>;
}

function Operation({ label, value, at }: { label: string; value: string; at?: string }) {
  return <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid rgba(18,20,26,.06)" }}>
    <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 14 }}>{label}</span>
      {at ? <span style={{ fontSize: 11, color: "#8a8f9a" }}>{at}</span> : null}
    </span>
    <strong style={{ fontSize: 14 }}>{value}</strong>
  </div>;
}

export default function PerfScreen({ props }: BaseComponentProps<Props>) {
  const actions = props.actions ?? [];
  const operations = props.operations ?? [];
  return <div style={{ display: "flex", flexDirection: "column", gap: space("lg"), width: 390, borderRadius: 28, padding: 20, background: color("surface-primary", "#fff") }}>
    <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 13, color: "#8a8f9a" }}>{props.title ?? "Экран"}</span>
      <strong style={{ fontSize: 30, letterSpacing: "-.02em" }}>{props.balance ?? "0 ₽"}</strong>
    </header>
    <div style={{ display: "flex", gap: 8 }}>{actions.map((action, index) => <Action key={index} label={action.label} hint={action.hint} />)}</div>
    <section style={{ display: "flex", flexDirection: "column" }}>
      {operations.map((operation, index) => <Operation key={index} label={operation.label} value={operation.value} at={operation.at} />)}
    </section>
    <footer style={{ fontSize: 11, color: "#8a8f9a" }}>{props.disclaimer ?? ""}</footer>
  </div>;
}
`,
};

interface Template { key: string; source: string; meta: DefinitionMeta; compiledJs: string; bundleHash: string; sourceHash: string; hostAbiVersion: number }

async function buildTemplates(dataDir: string): Promise<Template[]> {
  const templates: Template[] = [];
  for (const [key, source] of Object.entries(templateSources)) {
    const path = await materializeSource(dataDir, `${PERF_LIBRARY_PREFIX}tpl-${key}`, 1, source);
    const extracted = await extractDefinition(path, { smoke: true });
    if (!extracted.ok || !extracted.meta) throw new Error(`perf-library template "${key}" failed extraction: ${extracted.error ?? "unknown"}`);
    const meta = extracted.meta as DefinitionMeta;
    const compiled = await compileComponent(path, { capabilities: meta.capabilities });
    templates.push({ key, source, meta, compiledJs: compiled.compiledJs, bundleHash: compiled.bundleHash, sourceHash: sha256(source), hostAbiVersion: compiled.hostAbiVersion });
  }
  return templates;
}

// --- Темы -----------------------------------------------------------------

const spaceTokens = { "space.none": "0px", "space.xs": "4px", "space.sm": "8px", "space.md": "12px", "space.lg": "16px", "space.xl": "24px", "space.2xl": "32px", "space.3xl": "48px", "space.4xl": "64px" };

function themeTokens(index: number): Record<string, string | number> {
  const hue = 214 + index * 42;
  return {
    ...spaceTokens,
    "color.surface-primary": "#ffffff",
    "color.surface-secondary": index === 0 ? "#f2f3f7" : index === 1 ? "#f1f6f3" : "#f6f2f7",
    "color.surface-overlay": "rgba(255,255,255,.96)",
    "color.surface-inverse": "#12141a",
    "color.text-primary": "#12141a",
    "color.text-secondary": "#6b7280",
    "color.text-inverse": "#ffffff",
    "color.text-accent": `hsl(${hue} 78% 46%)`,
    "color.line-default": "rgba(18,20,26,.08)",
    "color.line-strong": "rgba(18,20,26,.22)",
    "color.accent-default": `hsl(${hue} 78% 46%)`,
    "color.accent-hover": `hsl(${hue} 78% 40%)`,
    "color.accent-muted": `hsl(${hue} 78% 92%)`,
    "color.positive-default": "#137333",
    "color.positive-muted": "#e6f4ea",
    "color.negative-default": "#c5221f",
    "color.negative-muted": "#fce8e6",
    "color.warning-default": "#b06000",
    "color.warning-muted": "#fef7e0",
    "color.control-fill": "#12141a",
    "color.control-text": "#ffffff",
    "radius.sm": "8px",
    "radius.md": "16px",
    "radius.lg": "24px",
    "font.family-text": index === 0 ? `"${FONT_FAMILY}", system-ui, sans-serif` : "system-ui, sans-serif",
    "font.size-body": "14px",
    "font.size-title": "18px",
    "font.weight-regular": 400,
    "font.weight-medium": 500,
    "size.control-height": "44px",
    "size.icon": "20px",
  };
}

// --- Компоненты -----------------------------------------------------------

interface Descriptor {
  index: number; id: string; name: string; designSystem: string; template: number;
  level: NonNullable<DefinitionMeta["atomicLevel"]>;
}

/** Уровни раскладываются перестановкой с шагом 7 (взаимно прост со 120), чтобы ярусы перемешались по системам. */
function descriptors(): Descriptor[] {
  const levels: NonNullable<DefinitionMeta["atomicLevel"]>[] = [];
  for (const { level, count } of LEVEL_PLAN) for (let n = 0; n < count; n += 1) levels.push(level!);
  if (levels.length !== TOTAL) throw new Error(`LEVEL_PLAN must cover ${TOTAL} components, got ${levels.length}`);
  return Array.from({ length: TOTAL }, (_, index) => ({
    index,
    id: `${PERF_LIBRARY_PREFIX}${pad(index)}`,
    name: `PerfLibrary${pad(index)}`,
    designSystem: SYSTEMS[SYSTEM_CYCLE[index % SYSTEM_CYCLE.length]!]!.id,
    template: index % Object.keys(templateSources).length,
    level: levels[(index * 7) % TOTAL]!,
  }));
}

const ROLES = ["payment-button", "status-chip", "operation-list", "wallet-screen", "summary-panel", "amount-badge"];

function entryMeta(descriptor: Descriptor, template: Template): DefinitionMeta {
  const meta: DefinitionMeta = { ...template.meta, atomicLevel: descriptor.level };
  meta.description = `Перф-фикстура ${pad(descriptor.index)} (${descriptor.level}): ${template.meta.description}`;
  if (descriptor.index % 10 === 0) meta.canonicalFor = [ROLES[(descriptor.index / 10) % ROLES.length]!];
  if (descriptor.index % 4 === 0) meta.scope = "section";
  else if (descriptor.index % 4 === 1) meta.scope = "primitive";
  // Смешанные селекторы превью: legacy-`example`, именованный пример и «превью нет вовсе».
  if (descriptor.index % 23 === 5) { delete meta.example; delete meta.examples; }
  else if (descriptor.index % 7 === 2 && template.meta.examples) delete meta.example;
  return meta;
}

const figmaFor = (descriptor: Descriptor): string | null => descriptor.index % 5 === 0
  ? JSON.stringify({ fileKey: `PerfLibrary${pad(descriptor.index)}`, nodeIds: ["1:24", "1:25"], lastSyncedAt: "2026-07-31T00:00:00.000Z" })
  : null;

// --- Сидинг ---------------------------------------------------------------

function ownerId(db: Database): string {
  const row = db.query("SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1").get() as { id: string } | null;
  if (!row) throw new Error("perf-library dataset needs at least one user in the target DATA_DIR (start the server with ADMIN_NAME/ADMIN_PASSWORD first)");
  return row.id;
}

/** Реальные байты шрифта: без них `fontRegistry` зарегистрировал бы `@font-face` на 404, и трафик темы был бы фиктивным. */
function seedFontAsset(db: Database, dataDir: string): string {
  const bytes = readFileSync(resolve(FONT_SOURCE));
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  mkdirSync(resolve(dataDir, "assets"), { recursive: true });
  writeFileSync(resolve(dataDir, "assets", hash), bytes);
  db.query("INSERT OR IGNORE INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,NULL,NULL,?,?)")
    .run(`asset_${hash}`, hash, "font/woff2", bytes.byteLength, FONT_ASSET_NAME, now());
  return `asset_${hash}`;
}

/**
 * Синтетический asset под визуальные эталоны: `visual_references.asset_id` — FK RESTRICT на
 * `assets`, но read-model байты не открывает, поэтому строки достаточно.
 */
function seedVisualAsset(db: Database): string {
  const hash = sha256(VISUAL_ASSET_NAME);
  db.query("INSERT OR IGNORE INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(`asset_${hash}`, hash, "image/png", 4096, 320, 170, VISUAL_ASSET_NAME, now());
  return `asset_${hash}`;
}

function seedSystems(db: Database, owner: string, fontAssetId: string): void {
  const at = now();
  SYSTEMS.forEach((system, index) => {
    db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at,owner_id,retired) VALUES (?,?,?,NULL,?,?,?,0)")
      .run(system.id, system.name, system.description, at, at, owner);
    const fonts = system.fonts ? [{ family: FONT_FAMILY, src: fontAssetId, weight: 400, style: "normal" }] : [];
    db.query("INSERT INTO design_system_versions (system_id,version,tokens_json,fonts_json,icons_json,created_at) VALUES (?,1,?,?,'[]',?)")
      .run(system.id, JSON.stringify(themeTokens(index)), JSON.stringify(fonts), at);
  });
}

function seedComponents(db: Database, repo: ComponentRepo, owner: string, templates: Template[], list: Descriptor[]): void {
  for (const descriptor of list) {
    const template = templates[descriptor.template]!;
    repo.create(descriptor.id, descriptor.name, template.source, descriptor.designSystem, "perf-library dataset", figmaFor(descriptor), owner);
    const staged = repo.stage(descriptor.id, 1, {
      compiledJs: template.compiledJs, bundleHash: template.bundleHash, sourceHash: template.sourceHash,
      meta: entryMeta(descriptor, template),
    }, "perf-library dataset");
    // `stage()` жёстко пишет host_abi_version=1; реальный пайплайн патчит его отдельным UPDATE
    // (server/routes/components.ts:74-75). Без этого read-model рекламировал бы ABI 1 для v4-бандлов.
    if (template.hostAbiVersion !== 1) {
      db.query("UPDATE component_publishes SET host_abi_version=? WHERE component_id=? AND version=?").run(template.hostAbiVersion, descriptor.id, staged.version);
    }
    repo.activate(descriptor.id, staged.version);

    // Смешанные статусы: у части компонентов поверх активной v1 лежит более свежая мёртвая версия.
    const dead = descriptor.index % 8 === 3 ? "deprecated" : descriptor.index % 16 === 9 ? "rejected" : null;
    if (dead) {
      repo.save(descriptor.id, `${template.source}\n// perf-library follow-up revision\n`, descriptor.designSystem, 1, "perf-library dataset");
      const second = repo.stage(descriptor.id, 2, {
        compiledJs: template.compiledJs, bundleHash: template.bundleHash, sourceHash: sha256(`${template.source}2`),
        meta: entryMeta(descriptor, template),
      }, "perf-library dataset");
      db.query("UPDATE component_publishes SET status=? WHERE component_id=? AND version=?").run(dead, descriptor.id, second.version);
    }
  }
}

function seedVisual(db: Database, assetId: string, list: Descriptor[]): number {
  const at = now();
  let created = 0;
  for (const descriptor of list) {
    if (descriptor.index % 3 !== 0) continue;
    const fingerprint: Fingerprint = {
      scope: "component", componentId: descriptor.id, refVersion: 1,
      viewport: { width: 320, height: 170 }, deviceScaleFactor: 1, theme: "light",
    };
    const json = fingerprintJson(fingerprint);
    const id = fingerprintId(json);
    db.query("INSERT INTO visual_references (id,fingerprint_json,asset_id,note,created_at,deleted_at) VALUES (?,?,?,?,?,NULL)")
      .run(id, json, assetId, "perf-library dataset", at);
    db.query("INSERT INTO visual_runs (id,reference_id,reference_asset_id,candidate_asset_id,diff_asset_id,metric,metric_options_json,diff_pixels,total_pixels,diff_percent,status,candidate_meta_json,created_at) VALUES (?,?,?,NULL,NULL,'pixelmatch',NULL,0,54400,0,?,NULL,?)")
      .run(`${PERF_LIBRARY_PREFIX}run-${pad(descriptor.index)}`, id, assetId, descriptor.index % 9 === 6 ? "fail" : "pass", at);
    created += 1;
  }
  return created;
}

/** Использование: восемь прототипов с разными наборами пинов ⇒ разброс `headUsageCount` 0…8. */
function seedPrototypes(db: Database, owner: string, list: Descriptor[]): number {
  const at = now();
  const count = 8;
  for (let k = 0; k < count; k += 1) {
    const id = `${PERF_LIBRARY_PREFIX}proto-${k}`;
    const doc = JSON.stringify({ version: 1, id, name: `Перф-библиотека ${k}`, designSystem: SYSTEMS[0]!.id, device: "mobile", startScreen: "start", state: {}, screens: [] });
    db.query("INSERT INTO prototypes (id,name,description,device,screen_count,head_rev,created_at,updated_at,design_system,instance_id,owner_id,status,kind) VALUES (?,?,?,'mobile',1,1,?,?,?,?,?,'private','product-flow')")
      .run(id, `Перф-библиотека ${k}`, "perf-library dataset", at, at, SYSTEMS[0]!.id, `${id}-instance`, owner);
    db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,message,author,created_at) VALUES (?,1,?,'perf-library',?,NULL,?)")
      .run(id, doc, "perf-library dataset", at);
    for (const descriptor of list) {
      if (descriptor.index % (k + 2) !== 0) continue;
      db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES (?,1,?,1)").run(id, descriptor.id);
    }
  }
  return count;
}

export async function createPerfLibraryDataset(options: PerfLibraryDatasetOptions): Promise<PerfLibrarySeedResult> {
  await cleanupPerfLibraryDataset(options);
  const dataDir = resolve(options.dataDir);
  const templates = await buildTemplates(dataDir);
  const db = openDatabase(resolve(dataDir, "easy-ui.db"));
  try {
    const repo = new ComponentRepo(db);
    const list = descriptors();
    let references = 0, prototypes = 0;
    db.transaction(() => {
      const owner = ownerId(db);
      seedSystems(db, owner, seedFontAsset(db, dataDir));
      seedComponents(db, repo, owner, templates, list);
      references = seedVisual(db, seedVisualAsset(db), list);
      prototypes = seedPrototypes(db, owner, list);
    })();
    return {
      components: list.length, systems: SYSTEMS.length, prototypes, references,
      bundles: templates.map((template) => ({ name: template.key, bytes: new TextEncoder().encode(template.compiledJs).byteLength, hostAbiVersion: template.hostAbiVersion })),
    };
  } finally { db.close(); }
}

/**
 * Порядок обязателен: `prototype_revision_components` держит FK RESTRICT на `component_publishes`,
 * а `visual_runs`/`visual_references` — на `assets`. Всё сносится по префиксу в одной транзакции,
 * поэтому провалившийся прогон не оставляет за собой ни имени, ни пина.
 */
export async function cleanupPerfLibraryDataset(options: PerfLibraryDatasetOptions): Promise<number> {
  const dataDir = resolve(options.dataDir);
  const db = openDatabase(resolve(dataDir, "easy-ui.db"));
  try {
    const like = `${PERF_LIBRARY_PREFIX}%`;
    const refs = `%"componentId":"${PERF_LIBRARY_PREFIX}%`;
    return db.transaction(() => {
      const removed = (db.query("SELECT COUNT(*) n FROM components WHERE id LIKE ?").get(like) as { n: number }).n;
      db.query("DELETE FROM prototype_revision_components WHERE prototype_id LIKE ? OR component_id LIKE ?").run(like, like);
      db.query("DELETE FROM prototype_revisions WHERE prototype_id LIKE ?").run(like);
      db.query("DELETE FROM prototypes WHERE id LIKE ?").run(like);
      db.query("DELETE FROM visual_runs WHERE reference_id IN (SELECT id FROM visual_references WHERE fingerprint_json LIKE ?)").run(refs);
      db.query("DELETE FROM visual_references WHERE fingerprint_json LIKE ?").run(refs);
      db.query("DELETE FROM component_publish_assets WHERE component_id LIKE ?").run(like);
      db.query("DELETE FROM component_publishes WHERE component_id LIKE ?").run(like);
      db.query("DELETE FROM validation_records WHERE resource_id LIKE ?").run(like);
      db.query("DELETE FROM component_revisions WHERE component_id LIKE ?").run(like);
      db.query("DELETE FROM components WHERE id LIKE ?").run(like);
      db.query("DELETE FROM design_system_versions WHERE system_id LIKE ?").run(like);
      db.query("DELETE FROM design_systems WHERE id LIKE ?").run(like);
      for (const row of db.query("SELECT sha256 FROM assets WHERE original_name LIKE ?").all(like) as { sha256: string }[]) {
        rmSync(resolve(dataDir, "assets", row.sha256), { force: true });
      }
      db.query("DELETE FROM assets WHERE original_name LIKE ?").run(like);
      for (const key of Object.keys(templateSources)) {
        rmSync(resolve(dataDir, "modules", `${PERF_LIBRARY_PREFIX}tpl-${key}`), { recursive: true, force: true });
      }
      return removed;
    })();
  } finally { db.close(); }
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (import.meta.main) {
  const action = process.argv[2];
  const dataDir = argument("--data-dir", process.env.DATA_DIR ?? "data")!;
  const options = { dataDir };
  const result = action === "seed" ? await createPerfLibraryDataset(options)
    : action === "cleanup" ? { cleaned: await cleanupPerfLibraryDataset(options) }
      : null;
  if (!result) throw new Error("Usage: bun scripts/perf-library-dataset.ts <seed|cleanup> [--data-dir DIR]");
  console.log(JSON.stringify(result));
}
