import { Database } from "bun:sqlite";
import process from "node:process";

const [filename, prototypeId] = process.argv.slice(2);
if (!filename || !prototypeId) throw new Error("usage: prepare-legacy-db.mjs <database> <prototype-id>");

const db = new Database(filename, { strict: true });
const row = db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=1").get(prototypeId);
if (!row) throw new Error(`prototype revision not found: ${prototypeId}@1`);
const doc = JSON.parse(row.doc);
doc.name = "V15 archived legacy prototype";
doc.screens = [{
  id: "legacy",
  name: "Legacy",
  spec: { root: "legacy-card", elements: { "legacy-card": { type: "Card", props: { title: "Removed builtin" } } } },
}];
doc.startScreen = "legacy";

db.transaction(() => {
  db.query("UPDATE prototype_revisions SET doc=? WHERE prototype_id=? AND rev=1").run(JSON.stringify(doc), prototypeId);
  db.query("UPDATE prototypes SET name=?,status='archived',updated_at=? WHERE id=?").run(doc.name, new Date().toISOString(), prototypeId);
})();
db.close();
