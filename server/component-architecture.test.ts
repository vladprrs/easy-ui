import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { catalogManifest } from "./routes/components";

// Волна 2 §2.1/§2.4: архитектурные метаданные definition проходят весь строгий
// конвейер (дочерний extract → definitionMeta → version DTO → catalog manifest),
// а publish-проверки остаются warn-only.

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});
async function setup(){const dir=await mkdtemp(resolve(process.cwd(),".component-arch-test-"));dirs.push(dir);const db=openDatabase(":memory:");return {db,handler:createTestHandler(db,{dataDir:dir})};}
const request=(url:string,method="GET",body?:unknown)=>new Request(`http://test/api${url}`,{method,headers:body?{"content-type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});
function source(fields:string,render=`return <div />`){return `import {z} from "zod";
export const definition={props:z.strictObject({}),description:"Arch component",example:{},${fields}};
export default function ArchComponent(){${render}}`;}

async function publish(id:string,name:string,fields:string,render?:string){
  const {db,handler}=await setup();
  const created=await handler(request("/components","POST",{designSystem:"yandex-pay",id,name,source:source(fields,render),intent:`Renders ${name} within the declared product architecture scope`}));
  if(created.status!==201) throw new Error(`create failed: ${await created.text()}`);
  const published=await handler(request(`/components/${id}/publish`,"POST",{baseRev:1}));
  if(published.status!==201) throw new Error(`publish failed: ${await published.text()}`);
  return {db,handler,result:await published.json() as {warnings:string[]}};
}

describe("component architecture metadata",()=>{
  test("threads scope/ownership/canonicalFor through publish, version DTO and manifest",async()=>{
    const fields=`atomicLevel:"organism" as const,scope:"shell" as const,allowedAsRoot:true,canonicalFor:["ctyp-success-navbar","app-home-shell"],sourceBounded:false,ownership:{reason:"owns the scroll container of the screen",provenance:"figma:12-34"},replacement:"ArchNext"`;
    const {db,handler,result}=await publish("arch-shell","ArchShell",fields);
    // replacement указывает на несуществующий компонент — единственное ожидаемое предупреждение.
    expect(result.warnings).toEqual(["definition.replacement references an unknown component in this design system: ArchNext"]);
    const version=await (await handler(request("/components/arch-shell/versions/1"))).json() as Record<string,unknown>;
    const manifest=catalogManifest(db)[0] as Record<string,unknown>;
    for(const dto of [version,manifest]) expect(dto).toMatchObject({
      scope:"shell",allowedAsRoot:true,canonicalFor:["app-home-shell","ctyp-success-navbar"],sourceBounded:false,
      ownership:{reason:"owns the scroll container of the screen",provenance:"figma:12-34"},replacement:"ArchNext",
    });
    db.close();
  },20000);

  test("publishes unchanged when no architecture metadata is declared",async()=>{
    const {db,result}=await publish("arch-plain","ArchPlain",`atomicLevel:"atom" as const`);
    expect(result.warnings).toEqual([]);
    db.close();
  },20000);

  test("warns for a screen/shell scope without ownership.reason",async()=>{
    const {db,result}=await publish("arch-screen","ArchScreen",`atomicLevel:"page" as const,scope:"screen" as const`);
    expect(result.warnings).toEqual(['Component declares scope "screen" without ownership.reason; document why it owns the whole screen']);
    db.close();
  },20000);

  test("scans screen geometry only when sourceBounded is declared",async()=>{
    const geometry=`return <div className="min-h-screen fixed inset-0" style={{height:"100dvh"}} />`;
    const bounded=await publish("arch-bounded","ArchBounded",`atomicLevel:"organism" as const,scope:"section" as const,sourceBounded:true`,geometry);
    expect(bounded.result.warnings.join(" ")).toContain("min-h-screen, 100dvh, fixed inset-0");
    bounded.db.close();
    // Канонический каркас (yp-screen и родня) законно несёт геометрию экрана и молчит.
    const canonical=await publish("arch-canonical","ArchCanonical",`atomicLevel:"organism" as const,scope:"shell" as const,ownership:{reason:"canonical screen frame"}`,geometry);
    expect(canonical.result.warnings).toEqual([]);
    canonical.db.close();
  },30000);

  test("rejects an invalid scope value at extraction",async()=>{
    const {db,handler}=await setup();
    const response=await handler(request("/components","POST",{designSystem:"yandex-pay",id:"arch-bad",name:"ArchBad",source:source(`atomicLevel:"atom" as const,scope:"page"`),intent:"Validates rejected architecture scope metadata"}));
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("scope");
    db.close();
  },20000);
});
