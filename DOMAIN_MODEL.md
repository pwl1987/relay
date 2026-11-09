# Domain Model

Status: **FROZEN nouns and invariants; field-level schema OPEN**

- **Project**: bounded source/workspace context and policy profile.
- **Goal**: user-authorized outcome with acceptance criteria and budget.
- **ChangeSet**: proposed change package containing intent, constraints, evidence, and affected projects.
- **Task**: executable unit in a DAG; has state, owner, dependencies, budget, attempts, and evidence.
- **Run**: one bounded execution attempt for a task.
- **Session**: resumable context for a run; stores handoff and checkpoint references.
- **Decision**: an approval or assumption point with risk, reversibility, timeout, fallback, and rollback.
- **Evidence**: immutable reference to a test, diff, command result, review, or external observation.
- **Operator**: capability adapter that performs an external action under policy.
- **Policy**: rules for authority, risk, budget, and required gates.
- **Plugin**: packaged adapter/configuration unit.
- **Skill**: declarative method content (instructions, schemas, checks), never a scheduler.

## State invariants

1. A task cannot become accepted without evidence references.
2. A run cannot mutate a project outside its operator grants.
3. A lease expiry does not imply failure; recovery must inspect the checkpoint.
4. A decision timeout may continue only under its declared fallback.
5. Audit events are append-only and identify actor, authority, target, result, and trace.
6. An external entry point is a client identity, never the source of truth for runtime state.
