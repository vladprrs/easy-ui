# CLAUDE.md

## Workflow: Fable 5 (orchestrator) + Codex gpt-5.6-sol (reviewer & executor)

Every non-trivial task goes through three stages: planning → adversarial plan review → delegated execution. Do not start implementation until the plan has passed review.

### Roles

| Role | Model | Reasoning effort |
|---|---|---|
| Planner & orchestrator | Claude Fable 5 | max |
| Plan reviewer | Codex `gpt-5.6-sol` | max (via Codex config, see note below) |
| Task executor | Codex `gpt-5.6-sol` | `--effort medium` |

### Stage 1 — Planning (Fable 5, max)

1. Work in plan mode (`/plan`) with maximum reasoning effort.
2. Save the finished plan to `docs/plans/YYYY-MM-DD-<topic>.md` — adversarial-review inspects the git working tree, so the plan must exist as a file.

### Stage 2 — Plan review (Codex gpt-5.6-sol, max)

1. Run:
   ```
   /codex:adversarial-review --model gpt-5.6-sol review the plan in docs/plans/<file> — challenge the approach, assumptions, and design choices
   ```
2. Effort note: GPT-5.6 Sol supports `max` reasoning effort, but the codex plugin (v1.0.6) does not accept `max` in its `--effort` flag (allowed: none/minimal/low/medium/high/xhigh), and the review command takes no effort flag at all. Set it in the Codex config instead — `~/.codex/config.toml`:
   ```toml
   model_reasoning_effort = "max"
   ```
   Reviews then run at `max` by default; task runs override it per-call with `--effort medium`.
3. Fable 5 triages the review findings and revises the plan. If the plan changes substantially, re-run the review — iterate until no blocking objections remain.
4. Never silently apply review findings to code — update the plan first.

### Stage 3 — Execution (Fable 5 orchestrates, Codex executes)

1. Fable 5 decomposes the approved plan into self-contained tasks with clear done-criteria.
2. Delegate each task to Codex:
   ```
   /codex:rescue --model gpt-5.6-sol --effort medium <task description>
   ```
3. Fable 5 manages the task flow as orchestrator:
   - dispatches tasks sequentially or in parallel (`--background`) depending on inter-task dependencies;
   - verifies each task's result before dispatching the next;
   - tracks background tasks via `/codex:status` and `/codex:result`, kills stuck ones via `/codex:cancel`;
   - uses `--resume` to continue work in the same Codex thread, `--fresh` for an independent task.
4. If Codex gets stuck or the result is unsatisfactory after one iteration, escalate: re-dispatch with `--effort high` or `xhigh` (or drop the flag entirely to fall back to the config-level `max`).
5. Fable 5 itself handles integration of results, conflict resolution between tasks, and the final verification pass.
