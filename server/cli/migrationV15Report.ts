import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { migrationV15Report } from "../classify";

function databaseArgument(argv:string[]):string {
  if(argv[0]==="--database") {
    if(!argv[1]||argv.length!==2) throw new Error("Usage: npm run migration:v15:report -- --database <v14.sqlite>");
    return argv[1];
  }
  if(argv.length===1&&argv[0]) return argv[0];
  throw new Error("Usage: npm run migration:v15:report -- <v14.sqlite>");
}

const filename=resolve(databaseArgument(process.argv.slice(2)));
const db=new Database(filename,{readonly:true,strict:true});
try {
  const version=(db.query("PRAGMA user_version").get() as {user_version:number}).user_version;
  if(version!==14) throw new Error(`migration:v15:report requires a v14 database (found v${version})`);
  console.log(JSON.stringify(migrationV15Report(db),null,2));
} finally {
  db.close();
}
