# P0 / P1 Roadmap

Status: **FROZEN scope; sequencing details OPEN**

## P0 — thin autonomous kernel

1. PostgreSQL schema for projects, goals, tasks, runs, checkpoints, decisions, approvals, leases, evidence, and audit events.
2. Lifecycle state machine and Task DAG with deterministic transitions.
3. Supervisor tick, leases, retries, backoff, watchdog recovery, progress guard, and bounded budgets.
4. Session Fabric: run context, checkpoint, handoff package, resume, and trace hash.
5. Policy engine for risk/reversibility/authority; Decision Timeout and Safe Continuation.
6. Pi runtime adapter with model capability tier and quality gate hooks.
7. Core operators: filesystem/process, Git, GitHub, Docker, SSH; all allowlisted and auditable.
8. CLI plus local API; no ChatGPT dependency.
9. Evidence-first acceptance: tests, diffs, command results, and reviewer findings are artifacts, not claims.

## P1 — capability adapters and operator breadth

1. Playwright browser operator and search/crawler adapter.
2. ACP and MCP adapters behind the same runtime contracts.
3. Plugin registry and signed/allowlisted plugin loading.
4. Skill packs and method templates (OpenSpec-compatible, engineering review, discovery) without control-flow ownership.
5. Optional memory, knowledge, and code-intelligence plugins.
6. ChatGPT adapter, notifications, overnight report, and approval inbox.
7. Model ladder, evaluation harness, and per-task quality thresholds.

## P2 / DEFERRED

Kafka, Kubernetes, Qdrant, OPA, Temporal, Restate, distributed event mesh, autonomous production deploy, cross-tenant federation, and a mandatory multi-agent council.

## Exit gates

P0 is complete only when a killed/restarted runtime resumes a task from a checkpoint, refuses an unauthorized operator action, records a timed-out decision, and proves acceptance with persisted evidence. P1 requires the same contracts to hold through at least one external operator and one optional plugin.
