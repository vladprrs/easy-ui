import { link, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { ComponentCapabilities, DefinitionMeta } from "./types";
import { normalizeEvents } from "../../src/catalog/normalize";
import type { AtomicLevel } from "../../src/designSystems/types";

/** Marker prefix on a definitionMeta error signalling a non-serializable event schema (→ 422). */
export const EVENT_SCHEMA_NOT_SERIALIZABLE = "event_schema_not_serializable";

// Register a Bun virtual module so components that `import { token, Icon } from "easy-ui/runtime"`
// evaluate during extraction / importPublished. In the browser the specifier is externalized and
// served from /api/shims/v2/easy-ui-runtime.js; this stub only satisfies server-side evaluation.
try {
  (Bun as unknown as { plugin: (p: { name: string; setup: (b: { module: (s: string, cb: () => { loader: string; exports: unknown }) => void }) => void }) => void }).plugin({
    name: "easy-ui-runtime",
    setup(build) {
      build.module("easy-ui/runtime", () => ({ loader: "object", exports: { token: () => "", Icon: () => null } }));
    },
  });
} catch { /* plugin already registered or unavailable */ }

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

function isJsonSafe(value:unknown):boolean {
  if(value===null) return true;
  const t=typeof value;
  if(t==="string"||t==="boolean") return true;
  if(t==="number") return Number.isFinite(value as number);
  if(Array.isArray(value)) return value.every(isJsonSafe);
  if(t==="object") return Object.values(value as Record<string,unknown>).every(isJsonSafe);
  return false;
}

export function definitionMeta(definition:{events?:readonly string[]|Record<string,z.ZodType>;slots?:string[];capabilities?:ComponentCapabilities;description:string;example?:Record<string,unknown>;atomicLevel?:AtomicLevel;interactive?:boolean;accessibleLabelProps?:string[];urlProps?:string[];props:z.ZodType}):DefinitionMeta {
  let propsJsonSchema:unknown;
  try { propsJsonSchema=z.toJSONSchema(definition.props); } catch { /* best effort metadata */ }
  const {events,eventPayloadSchemas}=normalizeEvents(definition.events as Parameters<typeof normalizeEvents>[0]);
  // Fail-closed: every typed-event schema must serialize to a deterministic, JSON-safe JSON Schema.
  let eventPayloads:Record<string,unknown>|undefined;
  if(eventPayloadSchemas){
    eventPayloads={};
    for(const [name,schema] of Object.entries(eventPayloadSchemas)){
      let jsonSchema:unknown;
      try { jsonSchema=z.toJSONSchema(schema); }
      catch(error){ throw new Error(`${EVENT_SCHEMA_NOT_SERIALIZABLE}: event "${name}" payload schema is not serializable to JSON Schema (${error instanceof Error?error.message:String(error)})`); }
      if(!isJsonSafe(jsonSchema)) throw new Error(`${EVENT_SCHEMA_NOT_SERIALIZABLE}: event "${name}" payload schema did not produce a JSON-safe JSON Schema`);
      eventPayloads[name]=jsonSchema;
    }
  }
  const capabilities=definition.capabilities&&typeof definition.capabilities==="object"?definition.capabilities:undefined;
  return {events,slots:definition.slots??[],description:definition.description,...(eventPayloads?{eventPayloads}:{}),...(capabilities?{capabilities}:{}),...(definition.example?{example:definition.example}:{}),...(definition.atomicLevel?{atomicLevel:definition.atomicLevel}:{}),...(definition.interactive!==undefined?{interactive:definition.interactive}:{}),...(definition.accessibleLabelProps?{accessibleLabelProps:definition.accessibleLabelProps}:{}),...(definition.urlProps?{urlProps:definition.urlProps}:{}),...(propsJsonSchema?{propsJsonSchema}:{})};
}
