import { expect, test } from "@playwright/test";

// Preview project only (SERVE_DIST + installed chromium). Drives the real async
// job pipeline end to end: enqueue -> poll -> done, with the PNG stored in the
// content-addressed asset registry.

async function pollJob(request: import("@playwright/test").APIRequestContext, jobId: string) {
  for (let i = 0; i < 70; i++) {
    const response = await request.get(`/api/screenshot-jobs/${jobId}`);
    expect(response.status()).toBe(200);
    const job = await response.json() as { status: string; result?: Record<string, unknown>; error?: { message: string } };
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("screenshot job did not settle within 70s");
}

test("captures a prototype screen and stores the PNG as an asset", async ({ request }) => {
  const post = await request.post("/api/prototypes/hello-world/screens/welcome/screenshot", {
    data: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" },
  });
  expect(post.status()).toBe(202);
  const { jobId } = await post.json() as { jobId: string };

  const job = await pollJob(request, jobId);
  expect(job.status, `job error: ${job.error?.message ?? ""}`).toBe("done");
  const result = job.result as { kind:string; imageUrl: string; assetId: string; width: number; height: number; rendererBuild: string; browserVersion: string; componentPins: unknown[] };
  expect(result.kind).toBe("image");
  expect(result.imageUrl).toMatch(/^\/api\/assets\/asset_[0-9a-f]{64}$/);
  expect(result.width).toBeGreaterThan(0);
  expect(result.rendererBuild).toBeTruthy();
  expect(result.browserVersion).toBeTruthy();
  expect(Array.isArray(result.componentPins)).toBe(true);

  const image = await request.get(result.imageUrl);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toContain("image/png");
});

test("geometry probe measures shadcn Stack md gap in CSS pixels without creating an image", async ({ request }) => {
  const source = await request.get("/api/prototypes/hello-world/draft");
  expect(source.status()).toBe(200);
  const draft = await source.json();
  const doc = {
    ...draft.doc,
    id: "geometry-stack-e2e",
    name: "Geometry Stack e2e",
    device: "mobile",
    startScreen: "gap",
    screens: [{
      id: "gap",
      name: "Gap",
      spec: {
        root: "stack",
        elements: {
          stack: { type:"Stack", props:{direction:"vertical",gap:"md"}, children:["one","two"] },
          one: { type:"Text", props:{text:"One"} },
          two: { type:"Text", props:{text:"Two"} },
        },
      },
    }],
  };
  const created = await request.post("/api/prototypes", { data:{doc} });
  expect(created.status(), await created.text()).toBe(201);
  const post = await request.post("/api/prototypes/geometry-stack-e2e/screens/gap/screenshot", {
    data:{probe:"geometry",viewport:{width:390,height:844},deviceScaleFactor:2,theme:"light"},
  });
  expect(post.status()).toBe(202);
  const {jobId}=await post.json() as {jobId:string};
  const job=await pollJob(request,jobId);
  expect(job.status, `job error: ${job.error?.message ?? ""}`).toBe("done");
  type GeometryRect = {key:string;x:number;y:number;width:number;height:number;layoutContext:{display:string;flexDirection:string;flexWrap:string;rowGap:string}|null};
  type GeometryResult = {kind:string;resolvedRev:number;dpr:number;viewport:{width:number;height:number};truncated:boolean;imageUrl?:string;rects:GeometryRect[]};
  const result=job.result as GeometryResult;
  expect(result).toMatchObject({kind:"geometry",resolvedRev:1,dpr:2,viewport:{width:390,height:844},truncated:false});
  expect(result.imageUrl).toBeUndefined();
  const stack=result.rects.find((rect)=>rect.key==="stack")!;
  const one=result.rects.find((rect)=>rect.key==="one")!;
  const two=result.rects.find((rect)=>rect.key==="two")!;
  expect(stack.layoutContext).toMatchObject({display:"flex",flexDirection:"column",flexWrap:"nowrap",rowGap:"12px"});
  expect(two.y-(one.y+one.height)).toBeCloseTo(12,2);
});

test("geometry probe covers repeat instances, Grid, wrap, Overlay and external portal markers", async ({ request }) => {
  const slotSource=`import {z} from "zod";import type {EasyUIComponentProps} from "easy-ui/runtime";export const definition={props:z.strictObject({}),events:[],capabilities:{namedSlots:true} as const,slots:["header","items"],description:"geometry slots",example:{}};export default function GeometrySlotsPanel({slots}:EasyUIComponentProps<Record<string,never>>){return <section><header>{slots.header}</header><main>{slots.items}</main></section>}`;
  const component=await request.post("/api/components",{data:{id:"geometry-slots-e2e",name:"GeometrySlotsPanel",source:slotSource}});
  expect(component.status(),await component.text()).toBe(201);
  const published=await request.post("/api/components/geometry-slots-e2e/publish",{data:{baseRev:1}});
  expect(published.status(),await published.text()).toBe(201);
  const base = await (await request.get("/api/prototypes/hello-world/draft")).json();
  const doc = {
    ...base.doc,
    id:"geometry-matrix-e2e", name:"Geometry matrix e2e", device:"mobile", startScreen:"matrix",
    state:{items:[{id:"a"},{id:"b"}],dialogOpen:true},
    screens:[{id:"matrix",name:"Matrix",spec:{root:"root",elements:{
      root:{type:"Stack",props:{direction:"vertical",gap:"md"},children:["grid","wrap","repeat","slots","dialog","overlay"]},
      grid:{type:"Grid",props:{columns:2,gap:"sm"},children:["grid-a","grid-b"]},
      "grid-a":{type:"Text",props:{text:"A"}}, "grid-b":{type:"Text",props:{text:"B"}},
      wrap:{type:"Stack",props:{direction:"horizontal",gap:"md"},children:["wrap-a","wrap-b"]},
      "wrap-a":{type:"Text",props:{text:"A"}}, "wrap-b":{type:"Text",props:{text:"B"}},
      repeat:{type:"Stack",props:{direction:"vertical",gap:"sm"},repeat:{statePath:"/items",key:"id"},children:["row"]},
      row:{type:"Stack",props:{direction:"vertical",gap:"none"},children:["row-child"]},
      "row-child":{type:"Text",props:{text:"row"}},
      slots:{type:"GeometrySlotsPanel",props:{},children:["slot-header","slot-item"]},
      "slot-header":{type:"Text",props:{text:"Header"},slot:"header"},
      "slot-item":{type:"Text",props:{text:"Item"},slot:"items"},
      dialog:{type:"Dialog",props:{title:"Portal",description:null,openPath:"/dialogOpen"},children:["dialog-child"]},
      "dialog-child":{type:"Text",props:{text:"Portalled"}},
      overlay:{type:"Overlay",props:{placement:"bottom",inset:"md",scrim:false},children:["overlay-child"]},
      "overlay-child":{type:"Text",props:{text:"Overlay"}},
    }}}],
  };
  const created=await request.post("/api/prototypes",{data:{doc}});
  expect(created.status(),await created.text()).toBe(201);
  const queued=await request.post("/api/prototypes/geometry-matrix-e2e/screens/matrix/screenshot",{data:{probe:"geometry",viewport:{width:390,height:844}}});
  expect(queued.status()).toBe(202);
  const job=await pollJob(request,(await queued.json()).jobId);
  expect(job.status,`job error: ${job.error?.message ?? ""}`).toBe("done");
  const result=job.result as {rects:Array<{key:string;instance:number;parentKey?:string;parentInstance?:number;layoutContext:{display:string;flexWrap:string}|null}>};
  expect(result.rects.find((rect)=>rect.key==="grid")?.layoutContext?.display).toBe("grid");
  expect(result.rects.find((rect)=>rect.key==="wrap")?.layoutContext?.flexWrap).toBe("wrap");
  const repeated=result.rects.filter((rect)=>rect.key==="row");
  expect(repeated.map((rect)=>rect.instance)).toEqual([0,1]);
  expect(result.rects.filter((rect)=>rect.key==="row-child").map((rect)=>rect.parentInstance)).toEqual([0,1]);
  expect(result.rects.find((rect)=>rect.key==="slot-header")?.parentKey).toBe("slots");
  expect(result.rects.find((rect)=>rect.key==="slot-item")?.parentKey).toBe("slots");
  expect(result.rects.some((rect)=>rect.key==="overlay-child")).toBe(true);
  expect(result.rects.some((rect)=>rect.key==="dialog-child")).toBe(true);
});

test("rejects out-of-bounds viewports with 422", async ({ request }) => {
  const response = await request.post("/api/prototypes/hello-world/screens/welcome/screenshot", {
    data: { viewport: { width: 5000, height: 844 } },
  });
  expect(response.status()).toBe(422);
});

// Adversarial egress: a malicious bundle attempting external fetch/WS/SW/WebRTC and
// GET/POST to a neighbouring loopback port must be fully blocked. The full network
// scenario is environment-sensitive inside this container; kept as a documented
// placeholder so the intent is recorded and can be enabled where the sandbox allows.
test.fixme("blocks all egress from a malicious component bundle", async () => {
  // Requires publishing a hostile component and a neighbour loopback server; the
  // primary allowlist guarantee is covered by the server-side unit tests.
});
