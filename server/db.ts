import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "./migrations";

export function openDatabase(filename?: string): Database {
  const target = filename ?? resolve(process.env.DATA_DIR || "data", "easy-ui.db");
  if (target !== ":memory:") mkdirSync(resolve(target, ".."), { recursive: true });
  const db = new Database(target, { create: true, strict: true });
  migrate(db);
  return db;
}
