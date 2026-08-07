import { mkdtemp, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { definitionMeta } from "./pipeline";
import { validateExample, validateExamplesByteLimit } from "./exampleValidate";
import type { ComponentDefinition } from "../../src/catalog/normalize";
import { COMPONENT_SCOPES } from "../../src/designSystems/scope";

const atomicLevel=z.enum(["atom","molecule","organism","template","page"]);
// §W9: `runtimeSchemaDefaults` — третья capability каталога; strict-схемы правятся комплектом
// (эта — и для definition в дочернем процессе, и для сериализованной meta).
const capabilitiesSchema=z.strictObject({typedEvents:z.literal(true).optional(),namedSlots:z.literal(true).optional(),runtimeSchemaDefaults:z.literal(true).optional()});
const jsonScalar=z.union([z.string(),z.number(),z.boolean(),z.null()]);
const domain=z.array(jsonScalar);
const flowSchema=z.strictObject({kind:z.literal("flex"),direction:z.union([z.enum(["vertical","horizontal"]),z.strictObject({prop:z.string(),vertical:domain,horizontal:domain,none:domain.optional()})]),wrap:z.strictObject({prop:z.string(),enabled:domain}).optional(),slot:z.string().optional()});
const layoutSchema=z.strictObject({version:z.literal(1),spacing:z.array(z.enum(["gap","padding","paddingX","paddingY"])).optional(),spacer:z.literal(true).optional(),flow:flowSchema.optional()});
const componentScope=z.enum(COMPONENT_SCOPES);
const ownershipSchema=z.strictObject({reason:z.string().min(1).max(500),provenance:z.string().min(1).max(500).optional()});
// Architecture metadata (волна 2 §2.1) — одинаковый набор полей для definition в
// дочернем процессе и для сериализованной meta; strict-схемы правятся комплектом.
const architectureFields={scope:componentScope.optional(),allowedAsRoot:z.boolean().optional(),canonicalFor:z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/,"must be a slug")).max(12).optional(),sourceBounded:z.boolean().optional(),ownership:ownershipSchema.optional(),replacement:z.string().min(1).max(64).optional()};
const metaSchema=z.strictObject({events:z.array(z.string()),eventPayloads:z.record(z.string(),z.unknown()).optional(),slots:z.array(z.string()),capabilities:capabilitiesSchema.optional(),description:z.string(),example:z.record(z.string(),z.unknown()).optional(),examples:z.record(z.string(),z.record(z.string(),z.unknown())).optional(),atomicLevel:atomicLevel.optional(),layoutNeutral:z.literal(true).optional(),layout:layoutSchema.optional(),interactive:z.boolean().optional(),accessibleLabelProps:z.array(z.string()).optional(),urlProps:z.array(z.string()).optional(),propsJsonSchema:z.unknown().optional(),...architectureFields});
const resultSchema=z.strictObject({ok:z.boolean(),meta:metaSchema.optional(),serverOnly:z.strictObject({conformanceProps:z.literal(true).optional()}).optional(),warnings:z.array(z.string()).default([]),error:z.string().optional()});
export type ExtractResult=z.output<typeof resultSchema>;

function hasDeclaredEvents(events:unknown):boolean {
  return Array.isArray(events)?events.length>0:events!==undefined&&events!==null&&typeof events==="object"&&Object.keys(events).length>0;
}

async function validateLayoutMetadata(metadata:{props:z.ZodType;slots?:string[];description:string;layout?:z.output<typeof layoutSchema>;layoutNeutral?:boolean;events?:unknown;interactive?:boolean;atomicLevel?:z.output<typeof atomicLevel>}):Promise<void> {
  if(metadata.layoutNeutral===true) {
    if(!metadata.slots?.includes("default")) throw new Error("definition.layoutNeutral requires an explicitly declared default slot");
    if(!metadata.layout?.spacing?.length) throw new Error("definition.layoutNeutral requires non-empty layout.spacing");
    if(hasDeclaredEvents(metadata.events)) throw new Error("definition.layoutNeutral cannot declare events or event payloads");
    if(metadata.interactive===true) throw new Error("definition.layoutNeutral cannot be interactive");
    if(metadata.atomicLevel!==undefined&&metadata.atomicLevel!=="atom"&&metadata.atomicLevel!=="molecule") throw new Error("definition.layoutNeutral atomicLevel must be atom or molecule when provided");
  }
  if(metadata.layout) {
    const {normalizeDefinitions}=await import("../../src/catalog/normalize");
    normalizeDefinitions({Custom:{props:metadata.props,slots:metadata.slots,description:metadata.description,layout:metadata.layout} as ComponentDefinition});
  }
}

async function assertLayoutNeutralConformance(mod:{default:unknown},metadata:{props:z.ZodType;example?:Record<string,unknown>;conformanceProps?:Record<string,unknown>;slots?:string[]}):Promise<void> {
  let parsed:Record<string,unknown>|undefined;
  const empty=metadata.props.safeParse({});
  if(empty.success) parsed=empty.data as Record<string,unknown>;
  else if(metadata.example!==undefined) {
    const example=metadata.props.safeParse(metadata.example);
    if(!example.success) throw new Error(`definition.example does not match definition.props: ${example.error.message}`);
    parsed=example.data as Record<string,unknown>;
  } else if(metadata.conformanceProps!==undefined) {
    const conformance=metadata.props.safeParse(metadata.conformanceProps);
    if(!conformance.success) throw new Error(`definition.conformanceProps does not match definition.props: ${conformance.error.message}`);
    parsed=conformance.data as Record<string,unknown>;
  } else {
    throw new Error("definition.layoutNeutral with required props needs definition.example or server-only definition.conformanceProps for publish conformance");
  }
  const React=await import("react");
  const {renderToString}=await import("react-dom/server");
  const sentinel=`eui-layout-neutral-${crypto.randomUUID()}`;
  const child=React.createElement("span",{"data-eui-layout-neutral-sentinel":sentinel},sentinel);
  const slots:Record<string,unknown>={default:child};
  for(const slot of metadata.slots??[]) if(slot!=="default") slots[slot]=null;
  let html:string;
  try { html=renderToString(React.createElement(mod.default as never,{props:parsed,emit:()=>{},on:()=>({emit:()=>{},shouldPreventDefault:false,bound:false}),slots,children:child})); }
  catch(error) { throw new Error(`definition.layoutNeutral SSR conformance render failed: ${error instanceof Error?error.message:String(error)}`); }
  if(!html.includes(sentinel)) throw new Error("definition.layoutNeutral SSR conformance failed: component must render its default slot/children");
}

/**
 * Дрейф runtime-дефолтов (план 2026-08-07 §1.6, §W9): имена props, для которых **схема** даёт
 * значение при отсутствии ключа (`.default()`/`.prefault()`/`.catch()`), — то есть ровно те
 * значения, которые хост до этой волны не применял и компонент компенсировал сам (`props.x ?? …`).
 *
 * Считается **по ключу**, а не через `props.safeParse({})`: тот путь (единственный, что был в этом
 * файле до волны, — `assertLayoutNeutralConformance`) отвечает `false` на любом обязательном
 * соседе, и компонент с одним required-полем выглядел бы «без дефолтов вовсе». Для аудита нужен
 * противоположный ответ: какие поля дефолт **объявляют**, независимо от соседей.
 *
 * Порядок — объявления в схеме: warning сравнивают между ревизиями глазами.
 */
function runtimeDefaultDrift(props:z.ZodType):string[] {
  let current:unknown=props;
  for(let depth=0;depth<8;depth+=1) {
    if(current instanceof z.ZodOptional||current instanceof z.ZodNullable||current instanceof z.ZodDefault||current instanceof z.ZodReadonly) { current=current.unwrap(); continue; }
    break;
  }
  if(!(current instanceof z.ZodObject)) return [];
  const names:string[]=[];
  for(const [name,schema] of Object.entries(current.shape as Record<string,unknown>)) {
    if(!(schema instanceof z.ZodType)) continue;
    const parsed=schema.safeParse(undefined);
    if(parsed.success&&parsed.data!==undefined) names.push(name);
  }
  return names;
}

async function child(sourcePath:string,resultPath:string,smoke:boolean) {
  let result:unknown;
  try {
    const mod=await import(`${sourcePath}?extract=${crypto.randomUUID()}`);
    if(typeof mod.default!=="function") throw new Error("default export must be a plain function component");
    const d=mod.definition;
    if(!d || typeof d!=="object" || !(d.props instanceof z.ZodType)) throw new Error("definition.props must be a ZodType");
    const eventsSchema=z.union([z.array(z.string()),z.record(z.string(),z.instanceof(z.ZodType))]);
    const metadata=z.strictObject({events:eventsSchema.optional(),slots:z.array(z.string()).optional(),capabilities:capabilitiesSchema.optional(),description:z.string().min(1),example:z.record(z.string(),z.unknown()).optional(),examples:z.unknown().optional(),conformanceProps:z.record(z.string(),z.unknown()).optional(),atomicLevel:atomicLevel.optional(),layoutNeutral:z.boolean().optional(),layout:layoutSchema.optional(),interactive:z.boolean().optional(),accessibleLabelProps:z.array(z.string()).optional(),urlProps:z.array(z.string()).optional(),props:z.instanceof(z.ZodType),...architectureFields}).parse(d);
    if(metadata.example) metadata.props.parse(metadata.example);
    if(metadata.conformanceProps!==undefined) validateExample(metadata.conformanceProps,"definition.conformanceProps");
    await validateLayoutMetadata(metadata);
    let examples:Record<string,Record<string,unknown>>|undefined;
    if(metadata.examples!==undefined) {
      if(metadata.examples===null||typeof metadata.examples!=="object"||Array.isArray(metadata.examples)) throw new Error("definition.examples must be an object");
      const entries=Object.entries(metadata.examples as Record<string,unknown>);
      if(entries.length>8) throw new Error("definition.examples must contain at most 8 examples");
      examples={};
      for(const [name,input] of entries.sort(([a],[b])=>a.localeCompare(b))) {
        if(name==="default") throw new Error('Example name "default" is reserved');
        if(name.length<1||name.length>32||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid example name ${JSON.stringify(name)}; expected a 1-32 character slug`);
        try { metadata.props.parse(input); } catch(error) { throw new Error(`Example ${JSON.stringify(name)} does not match definition.props: ${error instanceof Error?error.message:String(error)}`); }
        validateExample(input,`Example ${JSON.stringify(name)}`);
        examples[name]=input;
      }
      validateExamplesByteLimit(examples);
    }
    const warnings:string[]=[];
    if(smoke) {
      if(metadata.layoutNeutral===true) await assertLayoutNeutralConformance(mod,metadata);
      else {
        const React=await import("react"); const {renderToString}=await import("react-dom/server");
        const smokeOne=(props:Record<string,unknown>,name?:string)=>{const slots:Record<string,unknown>={default:null};if(metadata.capabilities?.namedSlots)for(const slot of metadata.slots??[])slots[slot]=null;try{renderToString(React.createElement(mod.default,{props,emit:()=>{},on:()=>({emit:()=>{},shouldPreventDefault:false,bound:false}),slots,...(metadata.capabilities?.namedSlots?{children:slots.default}:{})}));}catch(error){warnings.push(`Render smoke failed${name?` for example ${JSON.stringify(name)}`:""}: ${error instanceof Error?error.message:String(error)}`);}};
        if(metadata.example) smokeOne(metadata.example);
        else if(!examples||Object.keys(examples).length===0) warnings.push("Render smoke skipped: definition.example is not provided");
        for(const [name,input] of Object.entries(examples??{})) smokeOne(input,name);
      }
    }
    // W9: сплошной drift-аудит — считается для **каждого** извлечения, а не только под `smoke`:
    // предупреждение обязано быть видно и на validate-префлайте, и на publish, и разовому скрипту
    // `scripts/audit-runtime-defaults.mjs`, который гоняет то же извлечение по корпусу.
    if(metadata.capabilities?.runtimeSchemaDefaults!==true) {
      const drift=runtimeDefaultDrift(metadata.props);
      if(drift.length>0) warnings.push(`runtime_default_drift: definition.props declares defaults the host does not apply (${drift.join(", ")}); either declare capabilities.runtimeSchemaDefaults and drop the duplicating \`??\` fallbacks, or drop the .default() from the schema`);
    }
    result={ok:true,meta:definitionMeta({...metadata,examples}),...(metadata.conformanceProps!==undefined?{serverOnly:{conformanceProps:true}}:{}),warnings};
  } catch(error) { result={ok:false,warnings:[],error:error instanceof Error?error.message:String(error)}; }
  const tmp=`${resultPath}.tmp`;
  await Bun.write(tmp,JSON.stringify(result)); await rename(tmp,resultPath);
}

export async function extractDefinition(sourcePath:string,options:{timeoutMs?:number;smoke?:boolean}={}):Promise<ExtractResult> {
  const dir=await mkdtemp(resolve(tmpdir(),"easy-ui-extract-")); const output=resolve(dir,"result.json");
  const timeoutMs=options.timeoutMs??Number(process.env.COMPONENT_EXTRACT_TIMEOUT_MS||10_000);
  const env:{[key:string]:string|undefined}={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:"production",BUN_INSTALL_CACHE_DIR:resolve(dir,"no-install")};
  const proc=Bun.spawn([process.execPath,import.meta.path,"--child",sourcePath,output,options.smoke?"1":"0"],{cwd:process.cwd(),env,detached:true,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  let timedOut=false; const timer=setTimeout(()=>{timedOut=true; try{process.kill(-proc.pid,"SIGTERM");}catch{proc.kill("SIGTERM");} setTimeout(()=>{try{process.kill(-proc.pid,"SIGKILL");}catch{proc.kill("SIGKILL");}},1000);},timeoutMs);
  try {
    await proc.exited; clearTimeout(timer);
    if(timedOut) return {ok:false,warnings:[],error:`Component evaluation timed out after ${timeoutMs}ms`};
    const file=Bun.file(output); if(!(await file.exists())) return {ok:false,warnings:[],error:"Component evaluator produced no result"};
    if(file.size>1_048_576) return {ok:false,warnings:[],error:"Component evaluator result is too large"};
    return resultSchema.parse(await file.json());
  } finally { clearTimeout(timer); await rm(dir,{recursive:true,force:true}); }
}

if(import.meta.main && process.argv[2]==="--child") await child(process.argv[3]!,process.argv[4]!,process.argv[5]==="1");
