import { link, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { DefinitionMeta } from "./types";
import type { AtomicLevel } from "../../src/designSystems/types";

const imported = new Map<string, Promise<{ definition: { props: z.ZodType }; default: unknown }>>();

export const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

export async function materializeSource(dataDir:string,id:string,rev:number,source:string):Promise<string> {
  const path=resolve(dataDir,"modules",id,`${rev}-${sha256(source).slice(0,8)}.tsx`);
  await mkdir(dirname(path),{recursive:true});
  if(await Bun.file(path).exists()) {
    if(await Bun.file(path).text()!==source) throw new Error(`Materialized source collision: ${path}`);
    return path;
  }
  const tmp=`${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp,source);
  try { await link(tmp,path); }
  catch(error) { if(!(await Bun.file(path).exists()) || await Bun.file(path).text()!==source) throw error; }
  finally { await rm(tmp,{force:true}); }
  return path;
}

export async function importPublished(id:string,rev:number,path:string) {
  const key=`${id}@${rev}`;
  let promise=imported.get(key);
  if(!promise) {
    promise=import(`${path}?published=${encodeURIComponent(key)}`).then(mod=>{
      if(typeof mod.default!=="function" || !(mod.definition?.props instanceof z.ZodType)) throw new Error("Published component module contract is invalid");
      return mod as {definition:{props:z.ZodType};default:unknown};
    });
    imported.set(key,promise);
  }
  return promise;
}

export function definitionMeta(definition:{events?:string[];slots?:string[];description:string;example?:Record<string,unknown>;atomicLevel?:AtomicLevel;props:z.ZodType}):DefinitionMeta {
  let propsJsonSchema:unknown;
  try { propsJsonSchema=z.toJSONSchema(definition.props); } catch { /* best effort metadata */ }
  return {events:definition.events??[],slots:definition.slots??[],description:definition.description,...(definition.example?{example:definition.example}:{}),...(definition.atomicLevel?{atomicLevel:definition.atomicLevel}:{}),...(propsJsonSchema?{propsJsonSchema}:{})};
}
