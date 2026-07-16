import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", ".claude", ".claude-config", ".codex-home", "server/fixtures", "data", ".e2e-data", ".w0-data", ".w6-data", ".backups"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["scripts/*.ts"] },
      },
    },
  },
  {
    files: ["scripts/*.mjs"],
    languageOptions: { globals: { console: "readonly" } },
  },
);
