/* global process */
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";

if (process.env.EASY_UI_REACT_FREE_CHILD === "1") {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "react" || specifier.startsWith("react/") || specifier === "react-dom" || specifier.startsWith("react-dom/")) {
        throw new Error(`React entered the server-safe module graph through ${specifier}`);
      }
      return nextResolve(specifier, context);
    },
  });
  await import("../src/prototype/validate.ts");
} else {
  const result = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename], {
    env: { ...process.env, EASY_UI_REACT_FREE_CHILD: "1" },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  console.log("definitions -> validate imports without React");
}
