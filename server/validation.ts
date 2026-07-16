import type { Database } from "bun:sqlite";
import { normalizeDefinitions, type ComponentDefinition } from "../src/catalog/definitions";
import { normalizeEvents } from "../src/catalog/normalize";
import { isAssetId, type PrototypeDoc } from "../src/prototype/schema";
import { importPublished } from "./components/pipeline";
import { requireRegisteredDesignSystem } from "./designSystems";
import { ApiError } from "./http";
import { hostPrimitiveDefinitions, hostPrimitiveNames } from "../src/catalog/hostPrimitives/definitions";

// Walks every element prop looking for {"$asset":"<id>"} directives, returning the referenced ids.
export function collectAssetIds(doc:PrototypeDoc):string[] {
  const ids=new Set<string>();
  const walk=(value:unknown):void => {
    if(Array.isArray(value)) { value.forEach(walk); return; }
    if(typeof value!=="object"||value===null) return;
    const record=value as Record<string,unknown>;
    if(Object.keys(record).length===1&&typeof record.$asset==="string") { if(isAssetId(record.$asset)) ids.add(record.$asset); return; }
    for(const item of Object.values(record)) walk(item);
  };
  for(const screen of doc.screens) for(const element of Object.values(screen.spec.elements)) walk(element.props);
  return [...ids];
}

// Collects and validates asset references in a document before its save transaction. A referenced
// asset that does not exist is a 422 (asset_not_found) so pins never dangle. Returns the ids to pin.
export function collectAndValidateAssetRefs(db:Database,doc:PrototypeDoc):string[] {
  const ids=collectAssetIds(doc);
  const missing=ids.filter(id=>!db.query("SELECT 1 ok FROM assets WHERE id=?").get(id));
  if(missing.length) throw new ApiError(422,"asset_not_found","Prototype references assets that do not exist",{issues:missing.map(id=>({path:["screens"],message:`unknown asset: ${id}`}))});
  return ids;
}

// Scans compiled/source text for /api/assets/asset_<sha256> string references (component publish).
const ASSET_URL_PATTERN=/\/api\/assets\/(asset_[0-9a-f]{64})/g;
export function collectAssetIdsFromSource(source:string):string[] {
  const ids=new Set<string>();
  for(const match of source.matchAll(ASSET_URL_PATTERN)) ids.add(match[1]!);
  return [...ids];
}

export function collectAndValidateComponentAssetRefs(db:Database,source:string):string[] {
  const ids=collectAssetIdsFromSource(source);
  const missing=ids.filter(id=>!db.query("SELECT 1 ok FROM assets WHERE id=?").get(id));
  if(missing.length) throw new ApiError(422,"asset_not_found","Component references assets that do not exist",{issues:missing.map(id=>({path:["source"],message:`unknown asset: ${id}`}))});
  return ids;
}

export type ComponentPin={id:string;name:string;version:number;bundleHash:string;sourcePath:string};
export async function snapshotDefinitions(db:Database,doc:PrototypeDoc,dataDir:string):Promise<{definitions:Record<string,ComponentDefinition>;pins:ComponentPin[]}> {
  const builtin=requireRegisteredDesignSystem(db,doc.designSystem,["designSystem"]).definitions;
  const types=new Set(doc.screens.flatMap(s=>Object.values(s.spec.elements).map(e=>e.type)).filter(t=>!Object.hasOwn(builtin,t)&&!hostPrimitiveNames.has(t)));
  const pins:ComponentPin[]=[]; const custom:Record<string,ComponentDefinition>={};
  for(const name of [...types].sort()) {
    const row=db.query(`SELECT c.id,c.name,cp.version,cp.rev,cp.bundle_hash bundleHash,cr.source
      FROM components c JOIN component_publishes cp ON cp.component_id=c.id AND cp.status='active'
      JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
      WHERE c.name=? AND cr.design_system=? AND c.deleted_at IS NULL ORDER BY cp.version DESC LIMIT 1`).get(name,doc.designSystem) as {id:string;name:string;version:number;rev:number;bundleHash:string;source:string}|null;
    if(!row) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["screens"],message:`Unknown or unpublished component type in design system '${doc.designSystem}': ${name}`}]});
    const {materializeSource}=await import("./components/pipeline"); const path=await materializeSource(dataDir,row.id,row.rev,row.source);
    const mod=await importPublished(row.id,row.rev,path);
    const raw=mod.definition as ComponentDefinition&{events?:unknown};
    const {events,eventPayloadSchemas}=normalizeEvents(raw.events as Parameters<typeof normalizeEvents>[0]);
    custom[name]={...raw,events,...(eventPayloadSchemas?{eventPayloadSchemas}:{})} as ComponentDefinition;
    pins.push({id:row.id,name:row.name,version:row.version,bundleHash:row.bundleHash,sourcePath:path});
  }
  // Transitional B1-B2 order: host fallback first, then live builtins, then custom.
  return {definitions:{...hostPrimitiveDefinitions,...builtin,...normalizeDefinitions(custom)},pins};
}
