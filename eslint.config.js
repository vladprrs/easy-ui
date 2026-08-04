import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `share` — самодостаточный дистрибутив авторингового скилла (свой driver.mjs и tsx-примеры вне
  // tsconfig проекта). `.*-test-*` — временные каталоги `mkdtemp` серверных тестов: при прерванном
  // прогоне они переживают afterEach и иначе роняют lint материализованными модулями.
  { ignores: ["dist", "node_modules", ".claude", ".claude-config", ".codex-home", "server/fixtures", "data", ".e2e-data", ".measure-data", ".perf-verify", ".w0-data", ".w6-data", ".backups", "work", "share", ".*-test-*"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["scripts/*.ts", "test/fixtures/starter/*.tsx"],
          // Растёт вместе с числом одиночных скриптов вне tsconfig (последний — R1:
          // scripts/check-renderer-pin.ts, 17-й файл при потолке 16).
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 24,
        },
      },
    },
  },
  {
    files: ["scripts/*.mjs"],
    languageOptions: { globals: { console: "readonly" } },
  },
);
