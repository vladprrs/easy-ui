import { componentPageSuite } from "../component-page.shared";

// Keep the stateful preview server's default Library selection on a builtin system while
// this spec publishes its registry-only fixture in parallel with preview.spec.ts.
componentPageSuite({ api: "http://127.0.0.1:4173/api", seed: true, customDsName: "ZZ E2E Custom DS" });
