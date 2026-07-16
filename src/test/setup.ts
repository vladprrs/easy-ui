import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { legacyTestRuntime } from "./legacyCatalog";

globalThis.__EUI_LEGACY_TEST_RUNTIME__ = legacyTestRuntime;

afterEach(cleanup);
