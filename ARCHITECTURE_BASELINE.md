# Architecture Baseline

Status: **FROZEN**

## Product boundary

Relay is an autonomous software-work runtime for projects. Its core promise is durable, evidence-gated progress on an explicit goal. It is not a general-purpose assistant, IDE, browser automation product, vector database, or model-training platform.

### In the core

1. Goal and lifecycle state.
2. Task DAG with dependency, ownership, attempt, and evidence state.
3. Supervisor and bounded execution loop.
4. Session Fabric for resumable runs and deterministic handoffs.
5. Policy evaluation, decision records, checkpoints, audit events, and approval gates.
6. A narrow operator interface and adapters for local process, Git, GitHub, browser, search/crawl, Docker, and SSH.

### Outside the core

ChatGPT/Codex UI, model providers, long-term memory, knowledge indexing, code graph, domain workflows, and vendor-specific protocols are replaceable integrations.

## Layering and non-overlap

```text
Entry points (CLI/API/ChatGPT adapter)
  -> Lifecycle + Supervisor
      -> Task DAG + Policy/Gates
          -> Session Fabric + Run records
              -> Agent runtime (Pi adapter)
                  -> Operators (GitHub, Browser, Search, Crawler, SSH, Docker, FS)
                      -> External systems
```

ACP is an agent-runtime interoperability adapter. MCP is a tool transport adapter. Plugins package adapters and configuration. Skills package instructions, schemas, and checks. None may own lifecycle state or bypass policy gates.

## 24×7 loop

The loop is a durable supervisor tick, not a forever-running model session:

1. claim one ready task with a lease;
2. create/resume a session checkpoint;
3. run a bounded step under policy and budgets;
4. persist outputs, evidence, and next action;
5. verify progress and acceptance criteria;
6. retry, replan, escalate model, defer, or block the path.

Every task has limits for attempts, wall time, token/cost budget, same-error count, and rework count. A watchdog recovers expired leases; a progress guard marks stalled work and prevents blind repetition.

## Decision Timeout / Safe Continuation

A decision has risk, reversibility, expiry, fallback, affected tasks, and rollback metadata. On timeout:

- low-risk/reversible: continue with the recommendation and write an assumption;
- medium-risk/reversible: prototype or branch, do not merge or publish;
- high-risk/irreversible: block only the dependent path;
- always: re-evaluate whether new evidence removes the need for approval.

No timeout may authorize production release, destructive data action, credential exposure, force-push, irreversible migration, or policy weakening.

## P0/P1/P2 audit

- **P0 retained:** durable state, task DAG, supervisor, Session Fabric, policy/gates, audit, recovery, Pi runtime adapter, local/Git/GitHub operators, safe continuation.
- **P1 retained:** browser/search/crawler/SSH/Docker operators, model ladder, plugin/skill packs, optional ChatGPT adapter, memory/knowledge/code-intelligence extension points.
- **P2 reduced:** multi-runtime federation, distributed queues, vector-native memory, autonomous production deployment, complex visual orchestration, and vendor-specific workflow engines remain deferred.

The main omission corrected by this audit is an explicit **progress guard + evidence contract**. The main overreach removed is treating every method or capability as a first-class core subsystem.

## Reliability, security, and operations

PostgreSQL is the source of durable runtime state. Transactions cover claims, leases, state transitions, and audit append. Checkpoints are idempotent and content-addressed where practical. Recovery resumes only from persisted state; notifications never grant authority.

Operators run with an allowlist, scoped credentials, timeouts, output limits, and redacted audit records. Destructive or external side effects require a policy decision and, where configured, human approval. A plugin cannot expand its own permissions. ChatGPT bindings are optional and cannot impersonate a runtime identity.

## OPEN

- exact API transport (HTTP, Unix socket, or both);
- Pi integration surface and fallback runtime;
- default retention and redaction policy;
- deployment packaging and multi-host topology;
- quantitative quality thresholds per task class.
