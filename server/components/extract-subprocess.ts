import { mkdtemp, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { definitionMeta } from "./pipeline";

const resultSchema=z.strictObject({ok:z.boolean(),meta:z.strictObject({events:z.array(z.string()),slots:z.array(z.string()),description:z.string(),example:z.record(z.string(),z.unknown()).optional(),propsJsonSchema:z.unknown().optional()}).optional(),warnings:z.array(z.string()).default([]),error:z.string().optional()});
export type ExtractResult=z.output<typeof resultSchema>;

async function child(sourcePath:string,resultPath:string,smoke:boolean) {
  let result:unknown;
  try {
    const mod=await import(`${sourcePath}?extract=${crypto.randomUUID()}`);
    if(typeof mod.default!=="function") throw new Error("default export must be a plain function component");
    const d=mod.definition;
    if(!d || typeof d!=="object" || !(d.props instanceof z.ZodType)) throw new Error("definition.props must be a ZodType");
    const metadata=z.strictObject({events:z.array(z.string()).optional(),slots:z.array(z.string()).optional(),description:z.string().min(1),example:z.record(z.string(),z.unknown()).optional(),props:z.instanceof(z.ZodType)}).parse(d);
    if(metadata.example) metadata.props.parse(metadata.example);
    const warnings:string[]=[];
    if(smoke) {
      if(!metadata.example) warnings.push("Render smoke skipped: definition.example is not provided");
      else try { const React=await import("react"); const {renderToString}=await import("react-dom/server"); renderToString(React.createElement(mod.default,metadata.example)); } catch(error) { warnings.push(`Render smoke failed: ${error instanceof Error?error.message:String(error)}`); }
    }
    result={ok:true,meta:definitionMeta(metadata),warnings};
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
