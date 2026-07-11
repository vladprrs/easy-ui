import type { Database } from "bun:sqlite";
import { basename, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";
import { validatePrototypeForSave } from "./routes/prototypes";
import { PrototypeRepo } from "./repos/prototypes";

export async function seedPrototypes(db:Database,dir=resolve("prototypes")):Promise<void> {
  // Seed documents may use builtins from their own design system; custom components are not supported in seeds.
  let files:string[]; try { files=(await readdir(dir)).filter(f=>f.endsWith(".json")).sort(); } catch(error) { console.warn("Seed directory unavailable",error); return; }
  for(const file of files) {
    const fileId=basename(file);
    if(db.query("SELECT 1 ok FROM seed_log WHERE file_id=?").get(fileId)) continue;
    let doc:PrototypeDoc;
    try { const parsed=prototypeDocSchema.parse(await Bun.file(resolve(dir,file)).json()); validatePrototypeForSave(parsed); doc=parsed; }
    catch(error) { console.error(`Skipping invalid seed file ${fileId}`,error); continue; }
    db.transaction(()=>{ new PrototypeRepo(db).create(doc,"Initial seed"); db.query("INSERT INTO seed_log (file_id,seeded_at) VALUES (?,?)").run(fileId,new Date().toISOString()); })();
  }
}
