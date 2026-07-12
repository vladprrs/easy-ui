import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { init, parse } from "es-module-lexer";
import { ApiError } from "../http";
import { sha256 } from "./pipeline";
import type { ComponentCapabilities } from "./types";

export const IMPORT_ABI={
  react:"/api/shims/v1/react.js",
  "react-dom":"/api/shims/v1/react-dom.js",
  "react/jsx-runtime":"/api/shims/v1/react-jsx-runtime.js",
  zod:"/api/shims/v1/zod.js",
  "@json-render/react":"/api/shims/v1/json-render-react.js",
} as const;

export const EASY_UI_RUNTIME_SPECIFIER="easy-ui/runtime";

// ABI v2 map: same specifiers as v1 but served from /api/shims/v2/*, plus easy-ui/runtime.
export const IMPORT_ABI_V2={
  react:"/api/shims/v2/react.js",
  "react-dom":"/api/shims/v2/react-dom.js",
  "react/jsx-runtime":"/api/shims/v2/react-jsx-runtime.js",
  zod:"/api/shims/v2/zod.js",
  "@json-render/react":"/api/shims/v2/json-render-react.js",
  [EASY_UI_RUNTIME_SPECIFIER]:"/api/shims/v2/easy-ui-runtime.js",
} as const;

// Specifiers that may be imported by component source (externalized at build time).
const ALLOWED_SPECIFIERS=[...Object.keys(IMPORT_ABI),EASY_UI_RUNTIME_SPECIFIER];
const finalImportsV1=new Set<string>(Object.values(IMPORT_ABI));
const finalImportsV2=new Set<string>(Object.values(IMPORT_ABI_V2));
const reject=(message:string):never=>{throw new ApiError(422,"validation_failed","Component publish failed",{issues:[{path:["source"],message}]});};

async function lex(source:string) { try { await init; return parse(source)[0]; } catch(error) { return reject(`Could not lex bundle imports: ${error instanceof Error?error.message:String(error)}`); } }

export async function typecheckComponent(sourcePath:string):Promise<void> {
  const dir=await mkdtemp(resolve(tmpdir(),"easy-ui-typecheck-")); const wrapper=resolve(dir,"check.ts");
  const types=resolve(process.cwd(),"server/components/types.ts");
  const runtimeDts=resolve(process.cwd(),"server/shims/easy-ui-runtime.d.ts");
  await Bun.write(wrapper,`import * as component from ${JSON.stringify(sourcePath)};\nimport type { CustomComponentModule } from ${JSON.stringify(types)};\nconst checked = component satisfies CustomComponentModule<any>;\nvoid checked;\n`);
  // tsconfig maps the type-only `easy-ui/runtime` specifier to its .d.ts so ABI v2 sources typecheck.
  const tsconfig={compilerOptions:{noEmit:true,strict:true,skipLibCheck:true,module:"ESNext",moduleResolution:"Bundler",target:"ESNext",jsx:"react-jsx",allowImportingTsExtensions:true,baseUrl:".",paths:{[EASY_UI_RUNTIME_SPECIFIER]:[runtimeDts]}},files:[wrapper]};
  await Bun.write(resolve(dir,"tsconfig.json"),JSON.stringify(tsconfig));
  try {
    const proc=Bun.spawn([resolve(process.cwd(),"node_modules/.bin/tsc"),"-p",dir],{env:{...process.env,NODE_ENV:"production"},stdout:"pipe",stderr:"pipe"});
    const code=await proc.exited; if(code!==0) reject(`Type check failed: ${((await new Response(proc.stdout).text())+(await new Response(proc.stderr).text())).slice(0,4000)}`);
  } finally { await rm(dir,{recursive:true,force:true}); }
}

export async function compileComponent(sourcePath:string,options:{capabilities?:ComponentCapabilities}={}):Promise<{compiledJs:string;bundleHash:string;hostAbiVersion:number}> {
  const previous=process.env.NODE_ENV; process.env.NODE_ENV="production";
  let result:Bun.BuildOutput;
  try { result=await Bun.build({entrypoints:[sourcePath],format:"esm",target:"browser",splitting:false,minify:true,sourcemap:"none",external:ALLOWED_SPECIFIERS,define:{"process.env.NODE_ENV":"\"production\""}}); }
  finally { if(previous===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=previous; }
  if(!result.success) reject(result.logs.map(String).join("\n"));
  if(result.outputs.length!==1) reject(`Expected exactly one JavaScript output, got ${result.outputs.length}`);
  let text=await result.outputs[0]!.text();
  if(text.includes("react/jsx-dev-runtime")) reject("Development JSX runtime is forbidden");
  const imports=await lex(text);
  // ABI = max(runtime import present, declared capabilities). A type-only easy-ui/runtime
  // import is erased by the bundler, so capabilities still force ABI 2 on their own.
  const usesRuntime=imports.some((item)=>item.n===EASY_UI_RUNTIME_SPECIFIER);
  const caps=options.capabilities;
  const hostAbiVersion=(usesRuntime||caps?.typedEvents||caps?.namedSlots)?2:1;
  const map=hostAbiVersion===2?IMPORT_ABI_V2 as Record<string,string>:IMPORT_ABI as Record<string,string>;
  const finalImports=hostAbiVersion===2?finalImportsV2:finalImportsV1;
  const replacements:{s:number;e:number;value:string}[]=[];
  for(const item of imports) {
    if(item.d===-2) continue;
    if(item.n===undefined || item.d>=0) reject("Dynamic or non-literal imports are forbidden");
    const replacement=map[item.n as string];
    if(!replacement) reject(`Import ${JSON.stringify(item.n)} is not allowed`);
    replacements.push({s:item.s,e:item.e,value:replacement!});
  }
  for(const r of replacements.sort((a,b)=>b.s-a.s)) text=text.slice(0,r.s)+r.value+text.slice(r.e);
  for(const item of await lex(text)) if(item.d!==-2 && (item.n===undefined || item.d>=0 || !finalImports.has(item.n as string))) reject(`Final bundle import ${JSON.stringify(item.n)} is not a shim ABI v${hostAbiVersion} URL`);
  return {compiledJs:text,bundleHash:sha256(text),hostAbiVersion};
}
