import { mkdtemp, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { definitionMeta } from "./pipeline";
import { validateExample, validateExamplesByteLimit } from "./exampleValidate";

const atomicLevel=z.enum(["atom","molecule","organism","template","page"]);
const capabilitiesSchema=z.strictObject({typedEvents:z.literal(true).optional(),namedSlots:z.literal(true).optional()});
const resultSchema=z.strictObject({ok:z.boolean(),meta:z.strictObject({events:z.array(z.string()),eventPayloads:z.record(z.string(),z.unknown()).optional(),slots:z.array(z.string()),capabilities:capabilitiesSchema.optional(),description:z.string(),example:z.record(z.string(),z.unknown()).optional(),examples:z.record(z.string(),z.record(z.string(),z.unknown())).optional(),atomicLevel:atomicLevel.optional(),interactive:z.boolean().optional(),accessibleLabelProps:z.array(z.string()).optional(),urlProps:z.array(z.string()).optional(),propsJsonSchema:z.unknown().optional()}).optional(),warnings:z.array(z.string()).default([]),error:z.string().optional()});
export type ExtractResult=z.output<typeof resultSchema>;

async function child(sourcePath:string,resultPath:string,smoke:boolean) {
  let result:unknown;
  try {
    const mod=await import(`${sourcePath}?extract=${crypto.randomUUID()}`);
    if(typeof mod.default!=="function") throw new Error("default export must be a plain function component");
    const d=mod.definition;
    if(!d || typeof d!=="object" || !(d.props instanceof z.ZodType)) throw new Error("definition.props must be a ZodType");
    const eventsSchema=z.union([z.array(z.string()),z.record(z.string(),z.instanceof(z.ZodType))]);
    const metadata=z.strictObject({events:eventsSchema.optional(),slots:z.array(z.string()).optional(),capabilities:capabilitiesSchema.optional(),description:z.string().min(1),example:z.record(z.string(),z.unknown()).optional(),examples:z.unknown().optional(),atomicLevel:atomicLevel.optional(),interactive:z.boolean().optional(),accessibleLabelProps:z.array(z.string()).optional(),urlProps:z.array(z.string()).optional(),props:z.instanceof(z.ZodType)}).parse(d);
    if(metadata.example) metadata.props.parse(metadata.example);
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
      const React=await import("react"); const {renderToString}=await import("react-dom/server");
      const smokeOne=(props:Record<string,unknown>,name?:string)=>{const slots:Record<string,unknown>={default:null};if(metadata.capabilities?.namedSlots)for(const slot of metadata.slots??[])slots[slot]=null;try{renderToString(React.createElement(mod.default,{props,emit:()=>{},on:()=>({emit:()=>{},shouldPreventDefault:false,bound:false}),slots,...(metadata.capabilities?.namedSlots?{children:slots.default}:{})}));}catch(error){warnings.push(`Render smoke failed${name?` for example ${JSON.stringify(name)}`:""}: ${error instanceof Error?error.message:String(error)}`);}};
      if(metadata.example) smokeOne(metadata.example);
      else if(!examples||Object.keys(examples).length===0) warnings.push("Render smoke skipped: definition.example is not provided");
      for(const [name,input] of Object.entries(examples??{})) smokeOne(input,name);
    }
    result={ok:true,meta:definitionMeta({...metadata,examples}),warnings};
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
