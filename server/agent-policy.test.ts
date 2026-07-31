// Дрифт-тесты между документацией для агентов и фактическими контрактами:
//
// 1. каждая команда `driver.mjs …` из fenced-блоков документации обязана разбираться настоящим
//    `parseArgs` драйвера — иначе скиллы и политика тихо расходятся с CLI;
// 2. глоссарий канонических ролей (`server/catalog/roles.json`) и его человекочитаемая версия
//    (`docs/canonical-roles.md`) обязаны перечислять одни и те же слаги;
// 3. канон политики авторинга обязан быть процитирован во всех точках входа агента;
// 4. `.claude/skills/author.zip`, если он когда-нибудь вернётся, обязан нести тот же `driver.mjs`,
//    что и репозиторий (архив со старым драйвером учил бы агентов обходить reuse gate).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "../.claude/skills/author/driver.mjs";
import { renderCatalogDts, reuseGateNote, type CatalogManifestSnapshot } from "../scripts/generate-sdk";

const root = resolve(import.meta.dir, "..");
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const POLICY_CANON = "docs/agent-authoring-policy.md";

const skillFiles = readdirSync(resolve(root, ".claude/skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `.claude/skills/${entry.name}/SKILL.md`)
  .filter((relative) => existsSync(resolve(root, relative)));

/** Документы, из которых агент копирует команды. Пустой список команд в файле — законно. */
const DOCUMENTS = [
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  POLICY_CANON,
  "docs/canonical-roles.md",
  "docs/server-api.md",
  "docs/authoring-sdk.md",
  ...skillFiles,
];

/** Разбор строки shell'а с учётом кавычек: аргументы вроде --intent "…" приходят одним токеном. */
function shellTokens(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/.test(character)) { if (started) { tokens.push(current); current = ""; started = false; } continue; }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

const TERMINATORS = new Set(["|", "||", "&&", ";", ">", ">>", "&"]);

export interface DocumentedCommand { file: string; line: number; argv: string[] }

/** Вытаскивает `driver.mjs …` из fenced-блоков; строки, склеенные `\`, собираются в одну. */
export function documentedCommands(markdown: string, file: string): DocumentedCommand[] {
  const lines = markdown.split("\n");
  const commands: DocumentedCommand[] = [];
  let inFence = false;
  let buffer = "";
  let bufferLine = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*```/.test(line)) { inFence = !inFence; buffer = ""; continue; }
    if (!inFence) continue;
    if (buffer === "") bufferLine = index + 1;
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed.endsWith("\\")) { buffer += `${trimmed.slice(0, -1)} `; continue; }
    const logical = `${buffer}${trimmed}`;
    buffer = "";
    const tokens = shellTokens(logical);
    // Только authoring-драйвер: у скилла `deploy` есть собственный несвязанный `driver.mjs`.
    const driverIndex = tokens.findIndex((token) => token === "driver.mjs" || token.endsWith("/author/driver.mjs"));
    if (driverIndex < 0) continue;
    const argv: string[] = [];
    for (const token of tokens.slice(driverIndex + 1)) {
      if (TERMINATORS.has(token) || token.startsWith("#")) break;
      argv.push(token);
    }
    commands.push({ file, line: bufferLine, argv });
  }
  return commands;
}

const allCommands = DOCUMENTS.flatMap((file) => documentedCommands(read(file), file));

describe("driver.mjs commands in agent-facing documentation", () => {
  test("документы вообще содержат команды (иначе тест зелёный по недосмотру)", () => {
    expect(allCommands.length).toBeGreaterThan(20);
    expect(new Set(allCommands.map((command) => command.file)).size).toBeGreaterThan(3);
  });

  test("каждая задокументированная команда разбирается настоящим parseArgs", () => {
    const failures: string[] = [];
    for (const command of allCommands) {
      try {
        parseArgs(command.argv);
      } catch (error) {
        failures.push(`${command.file}:${command.line}: driver.mjs ${command.argv.join(" ")} — ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("детектор находит usage-ошибку (негативный контроль экстрактора)", () => {
    const broken = documentedCommands("```bash\nnode driver.mjs catalog list\n```\n", "fixture");
    expect(broken).toEqual([{ file: "fixture", line: 2, argv: ["catalog", "list"] }]);
    expect(() => parseArgs(broken[0]!.argv)).toThrow(/invalid arguments for catalog list/);
  });

  test("экстрактор понимает переносы строк, кавычки и хвостовые комментарии", () => {
    const parsed = documentedCommands([
      "```bash",
      "node driver.mjs component rating-stars RatingStars src.tsx \\",
      '  --intent "Let a customer rate a product" \\',
      '  --force-new --reason "Approved by the product owner"',
      "node ../author/driver.mjs snap my-flow ./shots   # PNG на каждый экран",
      "```",
    ].join("\n"), "fixture");
    expect(parsed[0]!.argv).toEqual(["component", "rating-stars", "RatingStars", "src.tsx", "--intent", "Let a customer rate a product", "--force-new", "--reason", "Approved by the product owner"]);
    expect(parsed[1]!.argv).toEqual(["snap", "my-flow", "./shots"]);
    for (const command of parsed) expect(() => parseArgs(command.argv)).not.toThrow();
  });

  test("цикл открытия каталога задокументирован именно как list → get", () => {
    const forms = new Set(allCommands
      .filter((command) => command.argv[0] === "catalog")
      .map((command) => (["list", "search", "get"].includes(command.argv[1] ?? "") ? `catalog ${command.argv[1]}` : "catalog dump")));
    expect(forms.has("catalog list")).toBe(true);
    expect(forms.has("catalog get")).toBe(true);
    expect(forms.has("catalog search")).toBe(true);
    // Скиллы больше не отправляют агента за полным дампом каталога.
    const dumps = allCommands.filter((command) => command.argv[0] === "catalog" && !["list", "search", "get"].includes(command.argv[1] ?? ""));
    expect(dumps.filter((command) => command.file.startsWith(".claude/skills/"))).toEqual([]);
  });

  test("создание компонента в документации всегда несёт --intent", () => {
    const creates = allCommands.filter((command) => command.argv[0] === "component" && command.argv.length >= 4 && !command.argv[1]!.startsWith("<"));
    expect(creates.length).toBeGreaterThan(0);
    for (const command of creates) expect(command.argv).toContain("--intent");
  });
});

describe("canonical role glossary", () => {
  const glossary = JSON.parse(read("server/catalog/roles.json")) as {
    roles: { slug: string; ru: string; en: string }[];
    needsTriage?: { pair: string[]; question: string }[];
  };
  const document = read("docs/canonical-roles.md");
  // Тот же слаг-regex, что валидирует canonicalFor при извлечении definition.
  const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  test("слаги валидны, уникальны и описаны на двух языках", () => {
    expect(glossary.roles.length).toBeGreaterThan(0);
    for (const role of glossary.roles) {
      expect(role.slug).toMatch(SLUG);
      expect(role.ru.length).toBeGreaterThan(10);
      expect(role.en.length).toBeGreaterThan(10);
    }
    expect(new Set(glossary.roles.map((role) => role.slug)).size).toBe(glossary.roles.length);
  });

  test("JSON и docs/canonical-roles.md перечисляют один и тот же набор ролей", () => {
    const documented = new Set([...document.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((match) => match[1]!));
    expect([...documented].sort()).toEqual(glossary.roles.map((role) => role.slug).sort());
  });

  test("документ описывает процедуру пополнения и незакрытый TODO по неизвестным слагам", () => {
    expect(document).toContain("## 3. Как пополнять");
    expect(document).toMatch(/TODO/);
    expect(document).toContain("server/catalog/gate.ts");
  });
});

describe("authoring policy canon", () => {
  test("канон существует и содержит терминальный контракт 409", () => {
    const policy = read(POLICY_CANON);
    for (const code of ["component_reuse_required", "canonical_role_conflict", "catalog_changed", "decisionId", "resolution", "--force-new"]) {
      expect(policy).toContain(code);
    }
  });

  test("все точки входа агента ссылаются на канон", () => {
    for (const file of ["CLAUDE.md", "AGENTS.md", ...skillFiles.filter((skill) => /author|yandex-pay|yp-prototype/.test(skill))]) {
      expect(read(file)).toContain(POLICY_CANON);
    }
  });

  test("AGENTS.md самодостаточен для агента, который не читает CLAUDE.md", () => {
    const agents = read("AGENTS.md");
    for (const fragment of ["npm run verify", "~/.bun/bin/bun", "DATA_DIR", "catalog list", "--force-new", "reuseGate"]) {
      expect(agents).toContain(fragment);
    }
  });
});

describe("SDK discovery summary", () => {
  const manifest = (reuseGate?: CatalogManifestSnapshot["reuseGate"]): CatalogManifestSnapshot => ({
    components: [{ id: "demo", name: "Demo", designSystem: "ds", version: 1, description: "demo", events: [], slots: [] }],
    ...(reuseGate === undefined ? {} : { reuseGate }),
  });

  test("фаза гейта и обязательность intent попадают в шапку типов", () => {
    const output = renderCatalogDts(manifest({ mode: "enforce", intentRequired: true, policyVersion: 1 }), "ds");
    expect(output).toContain("// Reuse gate: enforce · intent required for new components · policy v1 (GET /api/capabilities)");
    expect(renderCatalogDts(manifest({ mode: "shadow", intentRequired: false, policyVersion: 1 }), "ds"))
      .toContain("intent optional for new components");
  });

  test("офлайн-снапшот без capabilities не выдумывает фазу", () => {
    expect(reuseGateNote(undefined)).toEqual([]);
    expect(renderCatalogDts(manifest(), "ds")).not.toContain("Reuse gate");
  });
});

describe("author.zip distribution archive", () => {
  const archive = resolve(root, ".claude/skills/author.zip");

  test("архив отсутствует либо несёт байт-идентичный driver.mjs", async () => {
    if (!existsSync(archive)) return; // удалён осознанно (T8): единственный поддерживаемый путь — репозиторий
    const listing = Bun.spawnSync(["unzip", "-p", archive, "author/driver.mjs"]);
    expect(listing.exitCode).toBe(0);
    expect(new TextDecoder().decode(listing.stdout)).toBe(read(".claude/skills/author/driver.mjs"));
  });
});
