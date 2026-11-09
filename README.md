# Relay Design Baseline

Status: **FROZEN baseline, implementation intentionally not started**

Relay is a small, independently runnable project-autonomy runtime. It accepts a goal, turns it into durable work, executes bounded agent runs through approved operators, verifies evidence, and resumes after interruption. ChatGPT is an optional entry point; the runtime does not depend on it.

This repository is an independent clean-room design. It contains no copied source code or implementation text from prior systems.

This repository freezes the top-level architecture and the first delivery boundary. It does not freeze product naming, UI, model vendors, provider credentials, or production deployment policy.

## Audit decision

The prior direction was mature enough to freeze only after these changes:

- **Keep one owner of control flow:** Lifecycle + Task DAG + Supervisor own state, scheduling, retries, checkpoints, and gates.
- **Make Session Fabric a runtime primitive:** it owns durable run context and handoff; it does not become another workflow engine.
- **Treat ACP/MCP/Plugin/Skill as adapters at different boundaries:** protocol transport, tool transport, extension packaging, and method content respectively.
- **Make 24×7 bounded:** progress budgets, watchdogs, checkpoints, and a progress guard are mandatory; an unbounded agent loop is forbidden.
- **Make human absence local:** safe reversible work may continue with a recorded assumption; irreversible/high-risk actions block only their path.
- **Keep Core small:** PostgreSQL is the durable store; memory, knowledge retrieval, and code intelligence are optional plugins with evidence contracts.
- **Prefer a modular monolith:** TypeScript/Node, PostgreSQL, Pi, Playwright, Git/GitHub, Docker, and SSH. Kafka, Kubernetes, Qdrant, OPA, Temporal, and Restate are explicitly deferred.

## Documents

- [Architecture baseline](ARCHITECTURE_BASELINE.md)
- [P0/P1 roadmap](P0_P1_ROADMAP.md)
- [Domain model](DOMAIN_MODEL.md)
- [Contracts](CONTRACTS.md)
- [ADR index](ADR/README.md)

## Status vocabulary

- **FROZEN**: required boundary for implementation; changes require a new ADR.
- **OPEN**: intentionally unresolved and must be decided with evidence before implementation expands.
- **DEFERRED**: explicitly outside P0/P1; no compatibility promise.
