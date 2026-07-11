import type { Database } from "bun:sqlite";
import { normalizeDefinitions, type ComponentDefinition } from "../src/catalog/definitions";
import type { PrototypeDoc } from "../src/prototype/schema";
import { importPublished } from "./components/pipeline";
import { requireRegisteredDesignSystem } from "./designSystems";
import { ApiError } from "./http";

export type ComponentPin={id:string;name:string;version:number;bundleHash:string;sourcePath:string};
export async function snapshotDefinitions(db:Database,doc:PrototypeDoc,dataDir:string):Promise<{definitions:Record<string,ComponentDefinition>;pins:ComponentPin[]}> {
  const builtin=requireRegisteredDesignSystem(db,doc.designSystem,["designSystem"]).definitions;
  const types=new Set(doc.screens.flatMap(s=>Object.values(s.spec.elements).map(e=>e.type)).filter(t=>!Object.hasOwn(builtin,t)));
  const pins:ComponentPin[]=[]; const custom:Record<string,ComponentDefinition>={};
  for(const name of [...types].sort()) {
    const row=db.query(`SELECT c.id,c.name,cp.version,cp.rev,cp.bundle_hash bundleHash,cr.source
      FROM components c JOIN component_publishes cp ON cp.component_id=c.id AND cp.status='active'
      JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
      WHERE c.name=? AND cr.design_system=? AND c.deleted_at IS NULL ORDER BY cp.version DESC LIMIT 1`).get(name,doc.designSystem) as {id:string;name:string;version:number;rev:number;bundleHash:string;source:string}|null;
    if(!row) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["screens"],message:`Unknown or unpublished component type in design system '${doc.designSystem}': ${name}`}]});
    const {materializeSource}=await import("./components/pipeline"); const path=await materializeSource(dataDir,row.id,row.rev,row.source);
    const mod=await importPublished(row.id,row.rev,path); custom[name]=mod.definition as ComponentDefinition;
    pins.push({id:row.id,name:row.name,version:row.version,bundleHash:row.bundleHash,sourcePath:path});
  }
  return {definitions:{...builtin,...normalizeDefinitions(custom)},pins};
}
