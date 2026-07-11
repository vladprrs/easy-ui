import type { Database } from "bun:sqlite";
import type { ComponentDefinition } from "../src/catalog/normalize";
import { designSystems } from "../src/designSystems";
import { ApiError } from "./http";

export interface RegisteredDesignSystem {
  id:string;
  name:string;
  description:string;
  builtinProvider:string|null;
  definitions:Record<string,ComponentDefinition>;
}

type Row={id:string;name:string;description:string;builtin_provider:string|null};
function fromRow(row:Row):RegisteredDesignSystem {
  const provider=row.builtin_provider===null?null:designSystems[row.builtin_provider as keyof typeof designSystems];
  return {id:row.id,name:row.name,description:row.description,builtinProvider:row.builtin_provider,definitions:provider?.definitions??{}};
}

export function listRegisteredDesignSystems(db:Database):RegisteredDesignSystem[] {
  return (db.query("SELECT id,name,description,builtin_provider FROM design_systems ORDER BY id").all() as Row[]).map(fromRow);
}

export function getRegisteredDesignSystem(db:Database,id:string):RegisteredDesignSystem|null {
  const row=db.query("SELECT id,name,description,builtin_provider FROM design_systems WHERE id=?").get(id) as Row|null;
  return row?fromRow(row):null;
}

export function requireRegisteredDesignSystem(db:Database,id:string,path:(string|number)[]):RegisteredDesignSystem {
  const system=getRegisteredDesignSystem(db,id);
  if(!system) throw new ApiError(422,"validation_failed",`Unknown design system: ${id}`,{issues:[{path,message:`Unknown design system: ${id}`}]});
  return system;
}
