/**
 * Backfill архитектурного `scope` по каталогу дизайн-системы (план 2026-07-27, волна 2 §2.2).
 *
 * Правило: atom/molecule → primitive, organism → section, template → shell, page → screen,
 * плюс ручной override-список канонических каркасов (`yp-screen`, `yp-panel`,
 * `yp-app-home-shell`, `yp-scroll-area` → shell). Планирование — чистая функция
 * `planScopeBackfill` (`src/designSystems/scope.ts`), покрытая unit-тестами.
 *
 * **По умолчанию — dry-run**: печатается таблица намерений, ничего не пишется.
 * Запись (PUT ревизии + publish) выполняется только с явным `--apply`.
 *
 *   npx tsx scripts/backfill-component-scope.ts --design-system yandex-pay
 *   npx tsx scripts/backfill-component-scope.ts --design-system yandex-pay --apply
 *
 * Переменные окружения: `EASYUI_API` (по умолчанию http://127.0.0.1:8787/api),
 * `EASYUI_USERNAME` / `EASYUI_PASSWORD` (каталог требует сессии, поэтому нужны и в dry-run).
 * Против прода вручную и осознанно — скрипт не содержит прод-URL по умолчанию.
 */
import { insertDefinitionScope, planScopeBackfill, type ComponentScope, type ScopeBackfillCandidate } from "../src/designSystems/scope";
import type { AtomicLevel } from "../src/designSystems/types";

type Argv = { designSystem: string; api: string; apply: boolean };

export function parseArgs(argv: readonly string[]): Argv {
  const result: Argv = {
    designSystem: "yandex-pay",
    api: process.env.EASYUI_API ?? "http://127.0.0.1:8787/api",
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--apply") result.apply = true;
    else if (arg === "--design-system" || arg === "-d") result.designSystem = argv[++index] ?? result.designSystem;
    else if (arg === "--api") result.api = argv[++index] ?? result.api;
    else if (arg === "--help" || arg === "-h") { printUsage(); process.exit(0); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function printUsage(): void {
  console.log("Usage: backfill-component-scope.ts [--design-system <slug>] [--api <base>] [--apply]");
}

type ManifestComponent = { id: string; name: string; atomicLevel?: AtomicLevel; scope?: ComponentScope };

class Api {
  private cookie: string | undefined;
  constructor(private readonly base: string) {}

  private get origin(): string { return new URL(this.base).origin; }

  /** Каталог требует сессии, поэтому логинимся и в dry-run — если есть креды. */
  async login(required: boolean): Promise<void> {
    const name = process.env.EASYUI_USERNAME, password = process.env.EASYUI_PASSWORD;
    if (!name || !password) {
      if (required) throw new Error("EASYUI_USERNAME and EASYUI_PASSWORD are required");
      return;
    }
    const response = await fetch(`${this.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.origin },
      body: JSON.stringify({ name, password }),
    });
    if (!response.ok) throw new Error(`login failed: HTTP ${response.status} ${await response.text()}`);
    this.cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!this.cookie) throw new Error("login did not return a session cookie");
  }

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.method && init.method !== "GET" ? { origin: this.origin } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${await response.text()}`);
    return await response.json() as T;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const api = new Api(options.api);
  await api.login(options.apply);
  const manifest = await api.request<{ components: ManifestComponent[] }>(
    `/catalog/manifest?designSystem=${encodeURIComponent(options.designSystem)}`,
  );
  const candidates: ScopeBackfillCandidate[] = manifest.components
    .map((component) => ({
      id: component.id,
      name: component.name,
      ...(component.atomicLevel ? { atomicLevel: component.atomicLevel } : {}),
      ...(component.scope ? { currentScope: component.scope } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const plan = planScopeBackfill(candidates);
  console.log(`design system: ${options.designSystem} · components: ${plan.length} · mode: ${options.apply ? "APPLY" : "dry-run"}\n`);
  const row = (cells: readonly string[]) => cells.map((cell, index) => cell.padEnd([10, 30, 14, 12, 12][index]!)).join("");
  console.log(row(["action", "component", "atomicLevel", "scope", "source"]));
  for (const entry of plan) {
    console.log(row([
      entry.action + (entry.conflict ? "!" : ""),
      entry.name,
      entry.atomicLevel ?? "—",
      entry.nextScope ?? entry.currentScope ?? "—",
      entry.source,
    ]));
  }
  const writes = plan.filter((entry) => entry.action === "set");
  console.log(`\nset: ${writes.length} · keep: ${plan.filter((entry) => entry.action === "keep").length} · skip: ${plan.filter((entry) => entry.action === "skip").length}`);
  if (!options.apply) {
    console.log("\nDry-run: nothing was written. Re-run with --apply to save and publish these components.");
    return;
  }

  let applied = 0;
  for (const entry of writes) {
    const draft = await api.request<{ rev: number; source: string }>(`/components/${encodeURIComponent(entry.id)}/source`);
    const rewritten = insertDefinitionScope(draft.source, entry.nextScope!);
    if (!rewritten.ok) { console.log(`skip  ${entry.name}: ${rewritten.reason}`); continue; }
    const saved = await api.request<{ rev: number }>(`/components/${encodeURIComponent(entry.id)}`, {
      method: "PUT",
      body: { source: rewritten.source, baseRev: draft.rev, message: `backfill scope: ${entry.nextScope}` },
    });
    const published = await api.request<{ version: number; warnings?: string[] }>(`/components/${encodeURIComponent(entry.id)}/publish`, {
      method: "POST",
      body: { baseRev: saved.rev, message: `backfill scope: ${entry.nextScope}` },
    });
    applied += 1;
    console.log(`ok    ${entry.name} → scope ${entry.nextScope} (v${published.version})${published.warnings?.length ? ` warnings: ${published.warnings.join("; ")}` : ""}`);
  }
  console.log(`\nApplied ${applied}/${writes.length} components.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
