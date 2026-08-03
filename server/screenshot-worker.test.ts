import { describe, expect, test } from "bun:test";
import { buildLaunchArgs, canonicalStringify, matchAllowed, readyToExpected } from "../scripts/screenshot-worker.mjs";
import { collectGeometry, unionRects } from "../src/capture/geometry.mjs";

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
    expect(readyToExpected({kind:"prototype",revision:2,prototypeInstanceId:"instance-2",componentManifestHash:"m",builtinCatalogHash:"b",designSystem:"shadcn",dsMetaVersion:null,rendererBuild:null})).toEqual({kind:"prototype",rev:2,prototypeInstanceId:"instance-2",componentManifestHash:"m",builtinCatalogHash:"b",designSystem:"shadcn",dsMetaVersion:null,rendererBuild:null});
  });

  // Мульти-поверхностный handshake (multi-surface D14): поверхность обязана назвать резолвнутую
  // ДС снимаемого экрана; отсутствие поля в ready деградирует до `null` и не совпадёт с expected.
  test("prototype readiness carries the resolved design system of the captured screen",()=>{
    expect(readyToExpected({kind:"prototype",revision:1,prototypeInstanceId:"i",componentManifestHash:"m",builtinCatalogHash:"b",designSystem:"yandex-pay",dsMetaVersion:4,rendererBuild:null}))
      .toMatchObject({designSystem:"yandex-pay",dsMetaVersion:4});
    expect(readyToExpected({kind:"prototype",revision:1,prototypeInstanceId:"i",componentManifestHash:"m",builtinCatalogHash:"b",dsMetaVersion:null,rendererBuild:null}))
      .toMatchObject({designSystem:null});
  });

  test("component-draft readiness comparison carries the content-addressed identity",()=>{
    expect(readyToExpected({kind:"component-draft",componentId:"w",rev:3,sourceHash:"s".repeat(64),bundleHash:"b",propsHash:"p",dsMetaVersion:2,rendererBuild:null}))
      .toEqual({kind:"component-draft",componentId:"w",rev:3,sourceHash:"s".repeat(64),bundleHash:"b",propsHash:"p",dsMetaVersion:2,rendererBuild:null});
  });

  test("geometry evaluate function is self-contained and uses the shared union vector", () => {
    expect(collectGeometry.toString()).toContain("rectUnion");
    expect(unionRects([{left:1,top:4,right:5,bottom:8},{left:-2,top:6,right:3,bottom:10}])).toEqual({left:-2,top:4,right:5,bottom:10,width:7,height:6});
  });
});
