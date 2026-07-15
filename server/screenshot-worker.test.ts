import { describe, expect, test } from "bun:test";
import { buildLaunchArgs, canonicalStringify, matchAllowed, readyToExpected } from "../scripts/screenshot-worker.mjs";

describe("screenshot worker helpers", () => {
  test("egress launch args are exact (port-scoped proxy-bypass + deny-proxy)", () => {
    expect(buildLaunchArgs(41111, "4173")).toEqual([
      "--proxy-server=http://127.0.0.1:41111",
      "--proxy-bypass-list=<-loopback>;127.0.0.1:4173",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--disable-quic",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--force-webrtc-ip-handling-policy",
    ]);
  });

  test("allowlist + canonical hashing mirror the server implementation", () => {
    expect(matchAllowed("/assets/x.js", ["/assets/"])).toBe(true);
    expect(matchAllowed("/evil", ["/assets/"])).toBe(false);
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
  });

  test("prototype readiness comparison includes the immutable instance id",()=>{
    expect(readyToExpected({kind:"prototype",revision:2,prototypeInstanceId:"instance-2",componentManifestHash:"m",builtinCatalogHash:"b",dsMetaVersion:null,rendererBuild:null})).toEqual({kind:"prototype",rev:2,prototypeInstanceId:"instance-2",componentManifestHash:"m",builtinCatalogHash:"b",dsMetaVersion:null,rendererBuild:null});
  });
});
