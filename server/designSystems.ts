import type { Database } from "bun:sqlite";
import type { ComponentDefinition } from "../src/catalog/normalize";
import { hostPrimitiveDefinitions } from "../src/catalog/hostPrimitives/definitions";
import { designSystems } from "../src/designSystems";
import { z } from "zod";
import type { ThemeContent } from "./designSystemsMeta";
import { ApiError } from "./http";

export interface RegisteredDesignSystem {
  id:string;
  name:string;
  description:string;
  builtinProvider:string|null;
  retired:boolean;
  definitions:Record<string,ComponentDefinition>;
}

/** Portable discovery/hash descriptor derived from the runtime definition source. */
export function catalogDefinitionDescriptor(name:string,definition:ComponentDefinition) {
  return {
    name,
    atomicLevel:definition.atomicLevel,
    layoutNeutral:definition.layoutNeutral??false,
    layout:definition.layout,
    description:definition.description,
    events:definition.events??[],
    slots:definition.slots??[],
    propsJsonSchema:z.toJSONSchema(definition.props,{io:"input"}),
  };
}

export const hostPrimitiveDescriptors=Object.entries(hostPrimitiveDefinitions)
  .map(([name,definition])=>catalogDefinitionDescriptor(name,definition));

type Row={id:string;name:string;description:string;builtin_provider:string|null;retired:number};
function fromRow(row:Row):RegisteredDesignSystem {
  const provider=row.builtin_provider===null?null:designSystems[row.builtin_provider as keyof typeof designSystems];
  return {id:row.id,name:row.name,description:row.description,builtinProvider:row.builtin_provider,retired:row.retired===1,definitions:provider?.definitions??{}};
}

export function listActiveDesignSystems(db:Database):RegisteredDesignSystem[] {
  return (db.query("SELECT id,name,description,builtin_provider,retired FROM design_systems WHERE retired=0 ORDER BY id").all() as Row[]).map(fromRow);
}

export function getIncludingRetired(db:Database,id:string):RegisteredDesignSystem|null {
  const row=db.query("SELECT id,name,description,builtin_provider,retired FROM design_systems WHERE id=?").get(id) as Row|null;
  return row?fromRow(row):null;
}

export function requireActiveDesignSystem(db:Database,id:string,path:(string|number)[]):RegisteredDesignSystem {
  const system=getIncludingRetired(db,id);
  if(!system||system.retired) throw new ApiError(422,"validation_failed",`Unknown or retired design system: ${id}`,{issues:[{path,message:`Unknown or retired design system: ${id}`}]});
  return system;
}

// --- Immutable theme versions (F.1) ---------------------------------------

const emptyTheme = (): ThemeContent => ({ tokens: {}, fonts: [], icons: [] });

/** Latest (highest) theme version number for a system, or null when it has none. */
export function latestDesignSystemMetaVersion(db:Database,systemId:string):number|null {
  const row=db.query("SELECT MAX(version) v FROM design_system_versions WHERE system_id=?").get(systemId) as {v:number|null};
  return row.v;
}

type VersionRow={version:number;tokens_json:string;fonts_json:string;icons_json:string;created_at:string};
function parseVersionRow(row:VersionRow):ThemeContent&{version:number;createdAt:string} {
  return {
    version:row.version,
    tokens:JSON.parse(row.tokens_json) as ThemeContent["tokens"],
    fonts:JSON.parse(row.fonts_json) as ThemeContent["fonts"],
    icons:JSON.parse(row.icons_json) as ThemeContent["icons"],
    createdAt:row.created_at,
  };
}

/** Immutable content of a specific theme version, or null when absent. */
export function getDesignSystemVersion(db:Database,systemId:string,version:number):(ThemeContent&{version:number;createdAt:string})|null {
  const row=db.query("SELECT version,tokens_json,fonts_json,icons_json,created_at FROM design_system_versions WHERE system_id=? AND version=?").get(systemId,version) as VersionRow|null;
  return row?parseVersionRow(row):null;
}

/** Content of the latest theme version; empty theme + null version when the system has none. */
export function getLatestDesignSystemContent(db:Database,systemId:string):ThemeContent&{latestMetaVersion:number|null} {
  const latest=latestDesignSystemMetaVersion(db,systemId);
  if(latest===null) return {...emptyTheme(),latestMetaVersion:null};
  const content=getDesignSystemVersion(db,systemId,latest)!;
  return {tokens:content.tokens,fonts:content.fonts,icons:content.icons,latestMetaVersion:latest};
}

/** Appends an immutable theme version. Caller enforces CAS + validation. */
export function insertDesignSystemVersion(db:Database,systemId:string,version:number,content:ThemeContent,at:string):void {
  db.query("INSERT INTO design_system_versions (system_id,version,tokens_json,fonts_json,icons_json,created_at) VALUES (?,?,?,?,?,?)")
    .run(systemId,version,JSON.stringify(content.tokens),JSON.stringify(content.fonts),JSON.stringify(content.icons),at);
}
