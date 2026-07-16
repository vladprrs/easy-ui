import type { Database } from "bun:sqlite";
import { hostPrimitiveDefinitions, hostPrimitiveNames } from "../src/catalog/hostPrimitives/definitions";
import { storedPrototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";
import { mergeScreenState } from "../src/prototype/stateOverrides";
import { validateElementProps } from "../src/prototype/validate";

const RENDERABLE_PIN_STATUSES = new Set(["active", "deprecated", "superseded"]);

export interface RevisionRenderError {
  code: "prototype_not_renderable";
  message: string;
  issues: { path: string; message: string }[];
}

export type RevisionClassification =
  | { renderable: true; error: null }
  | { renderable: false; error: RevisionRenderError };

const failed = (issues:RevisionRenderError["issues"]):RevisionClassification => ({
  renderable:false,
  error:{code:"prototype_not_renderable",message:"Prototype revision is not renderable",issues},
});

/**
 * Classifies one immutable revision from its exact document and exact component pins.
 * It deliberately does not consult the prototype's current head or design-system flag.
 */
export function classifyRevision(db:Database,prototypeId:string,rev:number):RevisionClassification {
  const row=db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(prototypeId,rev) as {doc:string}|null;
  if(!row) return failed([{path:"/rev",message:`Prototype revision ${prototypeId} rev ${rev} does not exist`}]);

  let doc:PrototypeDoc;
  try {
    const parsed=storedPrototypeDocSchema.safeParse(JSON.parse(row.doc));
    if(!parsed.success) return failed(parsed.error.issues.map(issue=>({path:`/${issue.path.map(String).join("/")}`,message:issue.message})));
    doc=parsed.data;
  } catch {
    return failed([{path:"/doc",message:"Stored prototype document is not valid JSON"}]);
  }

  const pins=db.query(`SELECT c.name,cp.status
    FROM prototype_revision_components prc
    JOIN components c ON c.id=prc.component_id
    JOIN component_publishes cp ON cp.component_id=prc.component_id AND cp.version=prc.component_version
    WHERE prc.prototype_id=? AND prc.rev=?`).all(prototypeId,rev) as {name:string;status:string}[];
  const pinsByName=new Map(pins.map(pin=>[pin.name,pin]));
  const issues:RevisionRenderError["issues"]=[];

  for(const [screenIndex,screen] of doc.screens.entries()) {
    const state=mergeScreenState(doc.state,screen.stateOverrides);
    for(const [elementId,element] of Object.entries(screen.spec.elements)) {
      const path=`/screens/${screenIndex}/spec/elements/${elementId}`;
      if(hostPrimitiveNames.has(element.type)) {
        const definition=hostPrimitiveDefinitions[element.type as keyof typeof hostPrimitiveDefinitions];
        const result=validateElementProps({definition,props:element.props,state,path:["screens",screenIndex,"spec","elements",elementId,"props"]});
        for(const issue of result.errors) issues.push({path:issue.path,message:`Host ${element.type} props are incompatible: ${issue.message}`});
        continue;
      }
      const pin=pinsByName.get(element.type);
      if(!pin) {
        issues.push({path:`${path}/type`,message:`Component type ${element.type} is neither host-rendered nor pinned`});
      } else if(!RENDERABLE_PIN_STATUSES.has(pin.status)) {
        issues.push({path:`${path}/type`,message:`Pinned component ${element.type} is not renderable (status ${pin.status})`});
      }
    }
  }
  return issues.length?failed(issues):{renderable:true,error:null};
}

export interface MigrationV15Report {
  databaseVersion:number;
  prototypesToArchive:string[];
  shareGrantsToRevoke:string[];
  counts:{prototypesToArchive:number;shareGrantsToRevoke:number};
}

export function migrationV15Report(db:Database):MigrationV15Report {
  const databaseVersion=(db.query("PRAGMA user_version").get() as {user_version:number}).user_version;
  const prototypes=(db.query("SELECT id,head_rev FROM prototypes ORDER BY id").all() as {id:string;head_rev:number}[])
    .filter(row=>!classifyRevision(db,row.id,row.head_rev).renderable).map(row=>row.id);
  const grants=(db.query("SELECT id,prototype_id,rev FROM share_grants WHERE revoked_at IS NULL ORDER BY id").all() as {id:string;prototype_id:string;rev:number}[])
    .filter(row=>!classifyRevision(db,row.prototype_id,row.rev).renderable).map(row=>row.id);
  return {databaseVersion,prototypesToArchive:prototypes,shareGrantsToRevoke:grants,counts:{prototypesToArchive:prototypes.length,shareGrantsToRevoke:grants.length}};
}
