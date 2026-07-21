import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { init, parse } from "es-module-lexer";
import ts from "typescript";
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
export const EASY_UI_RUNTIME_V3_SPECIFIER="easy-ui/runtime/v3";
export const EASY_UI_RUNTIME_V4_SPECIFIER="easy-ui/runtime/v4";

// ABI v2 map: same specifiers as v1 but served from /api/shims/v2/*, plus easy-ui/runtime.
export const IMPORT_ABI_V2={
  react:"/api/shims/v2/react.js",
  "react-dom":"/api/shims/v2/react-dom.js",
  "react/jsx-runtime":"/api/shims/v2/react-jsx-runtime.js",
  zod:"/api/shims/v2/zod.js",
  "@json-render/react":"/api/shims/v2/json-render-react.js",
  [EASY_UI_RUNTIME_SPECIFIER]:"/api/shims/v2/easy-ui-runtime.js",
} as const;

export const IMPORT_ABI_V3={
  react:"/api/shims/v3/react.js",
  "react-dom":"/api/shims/v3/react-dom.js",
  "react/jsx-runtime":"/api/shims/v3/react-jsx-runtime.js",
  zod:"/api/shims/v3/zod.js",
  "@json-render/react":"/api/shims/v3/json-render-react.js",
  [EASY_UI_RUNTIME_V3_SPECIFIER]:"/api/shims/v3/easy-ui-runtime.js",
} as const;

// ABI v4 map: same standard shims served from /api/shims/v4/*, plus easy-ui/runtime/v4
// (token/space/Icon from v3 + color()).
export const IMPORT_ABI_V4={
  react:"/api/shims/v4/react.js",
  "react-dom":"/api/shims/v4/react-dom.js",
  "react/jsx-runtime":"/api/shims/v4/react-jsx-runtime.js",
  zod:"/api/shims/v4/zod.js",
  "@json-render/react":"/api/shims/v4/json-render-react.js",
  [EASY_UI_RUNTIME_V4_SPECIFIER]:"/api/shims/v4/easy-ui-runtime.js",
} as const;

// Specifiers that may be imported by component source (externalized at build time).
const ALLOWED_SPECIFIERS=[...Object.keys(IMPORT_ABI),EASY_UI_RUNTIME_SPECIFIER,EASY_UI_RUNTIME_V3_SPECIFIER,EASY_UI_RUNTIME_V4_SPECIFIER];
// Exactly one runtime specifier may be value-imported per component (see plan R6).
const RUNTIME_SPECIFIERS=[EASY_UI_RUNTIME_SPECIFIER,EASY_UI_RUNTIME_V3_SPECIFIER,EASY_UI_RUNTIME_V4_SPECIFIER] as const;
const finalImportsV1=new Set<string>(Object.values(IMPORT_ABI));
const finalImportsV2=new Set<string>(Object.values(IMPORT_ABI_V2));
const finalImportsV3=new Set<string>(Object.values(IMPORT_ABI_V3));
const finalImportsV4=new Set<string>(Object.values(IMPORT_ABI_V4));
const reject=(message:string):never=>{throw new ApiError(422,"validation_failed","Component publish failed",{issues:[{path:["source"],message}]});};

async function lex(source:string) { try { await init; return parse(source)[0]; } catch(error) { return reject(`Could not lex bundle imports: ${error instanceof Error?error.message:String(error)}`); } }

function valueRuntimeSpecifiers(path:string,source:string):Set<string> {
  const file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const out=new Set<string>();
  for(const statement of file.statements) {
    if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier=statement.moduleSpecifier.text;
    if(!(RUNTIME_SPECIFIERS as readonly string[]).includes(specifier)) continue;
    const clause=statement.importClause;
    const typeOnly=clause!==undefined&&(clause.isTypeOnly||(
      clause.name===undefined&&clause.namedBindings!==undefined&&ts.isNamedImports(clause.namedBindings)&&
      clause.namedBindings.elements.every((element)=>element.isTypeOnly)
    ));
    if(!typeOnly) out.add(specifier);
  }
  return out;
}

export async function typecheckComponent(sourcePath:string):Promise<void> {
  const dir=await mkdtemp(resolve(tmpdir(),"easy-ui-typecheck-")); const wrapper=resolve(dir,"check.ts");
  const types=resolve(process.cwd(),"server/components/types.ts");
  const runtimeDts=resolve(process.cwd(),"server/shims/easy-ui-runtime.d.ts");
  const runtimeV3Dts=resolve(process.cwd(),"server/shims/easy-ui-runtime-v3.d.ts");
  const runtimeV4Dts=resolve(process.cwd(),"server/shims/easy-ui-runtime-v4.d.ts");
  await Bun.write(wrapper,`import * as component from ${JSON.stringify(sourcePath)};\nimport type { CustomComponentModule } from ${JSON.stringify(types)};\nconst checked = component satisfies CustomComponentModule<any>;\nvoid checked;\n`);
  // tsconfig maps the type-only `easy-ui/runtime` specifier to its .d.ts so ABI v2 sources typecheck.
  const tsconfig={compilerOptions:{noEmit:true,strict:true,skipLibCheck:true,module:"ESNext",moduleResolution:"Bundler",target:"ESNext",jsx:"react-jsx",allowImportingTsExtensions:true,baseUrl:".",paths:{[EASY_UI_RUNTIME_SPECIFIER]:[runtimeDts],[EASY_UI_RUNTIME_V3_SPECIFIER]:[runtimeV3Dts],[EASY_UI_RUNTIME_V4_SPECIFIER]:[runtimeV4Dts]}},files:[wrapper]};
  await Bun.write(resolve(dir,"tsconfig.json"),JSON.stringify(tsconfig));
  try {
    const proc=Bun.spawn([resolve(process.cwd(),"node_modules/.bin/tsc"),"-p",dir],{env:{...process.env,NODE_ENV:"production"},stdout:"pipe",stderr:"pipe"});
    const code=await proc.exited; if(code!==0) reject(`Type check failed: ${((await new Response(proc.stdout).text())+(await new Response(proc.stderr).text())).slice(0,4000)}`);
  } finally { await rm(dir,{recursive:true,force:true}); }
}

export async function compileComponent(sourcePath:string,options:{capabilities?:ComponentCapabilities}={}):Promise<{compiledJs:string;bundleHash:string;hostAbiVersion:number}> {
  const source=await Bun.file(sourcePath).text();
  const runtimeSpecifiers=valueRuntimeSpecifiers(sourcePath,source);
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
  const usesRuntime=runtimeSpecifiers.has(EASY_UI_RUNTIME_SPECIFIER)||imports.some((item)=>item.n===EASY_UI_RUNTIME_SPECIFIER);
  const usesRuntimeV3=runtimeSpecifiers.has(EASY_UI_RUNTIME_V3_SPECIFIER)||imports.some((item)=>item.n===EASY_UI_RUNTIME_V3_SPECIFIER);
  const usesRuntimeV4=runtimeSpecifiers.has(EASY_UI_RUNTIME_V4_SPECIFIER)||imports.some((item)=>item.n===EASY_UI_RUNTIME_V4_SPECIFIER);
  // R6: at most one runtime specifier per component — reject any mixed pair.
  const runtimeUsed=RUNTIME_SPECIFIERS.filter((spec)=>({[EASY_UI_RUNTIME_SPECIFIER]:usesRuntime,[EASY_UI_RUNTIME_V3_SPECIFIER]:usesRuntimeV3,[EASY_UI_RUNTIME_V4_SPECIFIER]:usesRuntimeV4})[spec]);
  if(runtimeUsed.length>1) reject(`A component cannot value-import more than one easy-ui runtime specifier (${runtimeUsed.join(", ")})`);
  const caps=options.capabilities;
  const hostAbiVersion=usesRuntimeV4?4:usesRuntimeV3?3:(usesRuntime||caps?.typedEvents||caps?.namedSlots)?2:1;
  const map=(hostAbiVersion===4?IMPORT_ABI_V4:hostAbiVersion===3?IMPORT_ABI_V3:hostAbiVersion===2?IMPORT_ABI_V2:IMPORT_ABI) as Record<string,string>;
  const finalImports=hostAbiVersion===4?finalImportsV4:hostAbiVersion===3?finalImportsV3:hostAbiVersion===2?finalImportsV2:finalImportsV1;
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
