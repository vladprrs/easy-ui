import type { Database } from "bun:sqlite";
import type { CatalogRevisionSource } from "../catalogRevision";
import { parseStoredCompositionDoc } from "../repos/compositions";

/** Discovery projection for the latest active composition publication of each id. */
export function activeCompositionRevisionSources(db: Database): CatalogRevisionSource[] {
  const rows = db.query(`SELECT c.id,c.design_system designSystem,p.version,r.doc,r.rev
    FROM compositions c
    JOIN composition_publishes p ON p.composition_id=c.id AND p.status='active'
    JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
    WHERE c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM composition_publishes newer
        WHERE newer.composition_id=p.composition_id AND newer.status='active' AND newer.version>p.version)
    ORDER BY c.design_system,c.id,p.version`).all() as { id: string; designSystem: string; version: number; doc: string; rev: number }[];
  return rows.map((row) => {
    const doc = parseStoredCompositionDoc(row.doc, row.id, row.rev);
    return {
      kind: "composition",
      designSystem: row.designSystem,
      id: row.id,
      version: row.version,
      description: doc.description ?? "",
      ...(doc.version === 2 && doc.atomicLevel !== undefined ? { atomicLevel: doc.atomicLevel } : {}),
      ...(doc.version === 2 && doc.scope !== undefined ? { scope: doc.scope } : {}),
      canonicalFor: doc.version === 2 ? doc.canonicalFor ?? [] : [],
      ...(doc.version === 2 && doc.replacement !== undefined ? { replacement: doc.replacement } : {}),
      meta: {
        propsJsonSchema: { type: "object", properties: Object.fromEntries(Object.entries(doc.params).map(([name, param]) => [name, { type: param.type }])) },
        events: [],
        slots: [...doc.slots],
      },
    } satisfies CatalogRevisionSource;
  });
}
