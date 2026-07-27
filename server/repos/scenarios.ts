import type { Database } from "bun:sqlite";
import {
  SCENARIOS_PER_PROTOTYPE_LIMIT, scenarioStepsSchema,
  type PrototypeScenario, type ScenarioInput, type ScenarioStep,
} from "../../src/prototype/scenario";
import { ApiError } from "../http";

/**
 * Репозиторий сценариев прототипа (волна 6, миграция v19).
 *
 * Сценарий — плоская запись рядом с прототипом: без ревизий, без CAS и без
 * публикаций. Причина: сценарий описывает намерение автора, а не артефакт сборки;
 * версионируется он вместе с прототипом только в смысле ключей элементов
 * (`stale`-семантика раннера), а не отдельной историей.
 */

const now = () => new Date().toISOString();

type ScenarioRow = {
  prototype_id: string; id: string; name: string; steps_json: string;
  author: string | null; created_at: string; updated_at: string;
};

/** Повреждённые шаги не роняют список: сценарий отдаётся с пустыми шагами и виден в UI. */
export function parseStoredSteps(json: string): ScenarioStep[] {
  try {
    const parsed = scenarioStepsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch { return []; }
}

const toDto = (row: ScenarioRow): PrototypeScenario => ({
  id: row.id,
  prototypeId: row.prototype_id,
  name: row.name,
  steps: parseStoredSteps(row.steps_json),
  author: row.author,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ScenarioRepo {
  constructor(private db: Database) {}

  list(prototypeId: string): PrototypeScenario[] {
    const rows = this.db.query("SELECT * FROM prototype_scenarios WHERE prototype_id=? ORDER BY created_at, id").all(prototypeId) as ScenarioRow[];
    return rows.map(toDto);
  }

  get(prototypeId: string, id: string): PrototypeScenario {
    const row = this.db.query("SELECT * FROM prototype_scenarios WHERE prototype_id=? AND id=?").get(prototypeId, id) as ScenarioRow | null;
    if (!row) throw new ApiError(404, "scenario_not_found", "Scenario not found");
    return toDto(row);
  }

  count(prototypeId: string): number {
    return (this.db.query("SELECT COUNT(*) count FROM prototype_scenarios WHERE prototype_id=?").get(prototypeId) as { count: number }).count;
  }

  create(prototypeId: string, id: string, input: ScenarioInput, author: string | null): PrototypeScenario {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 ok FROM prototype_scenarios WHERE prototype_id=? AND id=?").get(prototypeId, id)) {
        throw new ApiError(409, "already_exists", "Scenario id already exists for this prototype");
      }
      if (this.count(prototypeId) >= SCENARIOS_PER_PROTOTYPE_LIMIT) {
        throw new ApiError(422, "validation_failed", "Scenario limit reached", {
          issues: [{ path: ["scenarios"], message: `at most ${SCENARIOS_PER_PROTOTYPE_LIMIT} scenarios per prototype` }],
        });
      }
      const at = now();
      this.db.query("INSERT INTO prototype_scenarios (prototype_id,id,name,steps_json,author,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(prototypeId, id, input.name, JSON.stringify(input.steps), author, at, at);
      return this.get(prototypeId, id);
    })();
  }

  update(prototypeId: string, id: string, input: ScenarioInput): PrototypeScenario {
    return this.db.transaction(() => {
      this.get(prototypeId, id);
      this.db.query("UPDATE prototype_scenarios SET name=?,steps_json=?,updated_at=? WHERE prototype_id=? AND id=?")
        .run(input.name, JSON.stringify(input.steps), now(), prototypeId, id);
      return this.get(prototypeId, id);
    })();
  }

  delete(prototypeId: string, id: string): void {
    const result = this.db.query("DELETE FROM prototype_scenarios WHERE prototype_id=? AND id=?").run(prototypeId, id);
    if (result.changes === 0) throw new ApiError(404, "scenario_not_found", "Scenario not found");
  }
}
