# Contracts

Status: **FROZEN principles; wire schemas OPEN**

## Lifecycle contract

`DISCOVER -> SPECIFY -> PLAN -> EXECUTE -> VERIFY -> DELIVER -> OPERATE` is the canonical vocabulary. Implementations may skip a phase only with a recorded reason and policy decision.

## Task contract

A task declares `id`, `goal_id`, `depends_on`, `owner`, `acceptance`, `risk`, `reversibility`, `budget`, and `allowed_operators`. State changes are monotonic except explicit replan/reopen events.

## Session contract

A checkpoint contains objective, completed work, remaining work, changed artifacts, evidence, failures, decisions, and next action. Handoffs are deterministic, size-bounded, and hashable.

## Operator contract

Every operator exposes capability metadata, input schema, authorization check, timeout, output limit, redaction, idempotency key, and audit result. Operators return observations; they do not advance lifecycle state.

## Quality contract

A quality gate receives task class, model tier, acceptance criteria, and evidence. It returns `PASS`, `REWORK`, `ESCALATE`, or `BLOCK`; free-form model confidence cannot replace evidence.

## Adapter boundaries

- ACP: agent/runtime session interoperability.
- MCP: tool invocation transport.
- Plugin: installation, versioning, and capability packaging.
- Skill: reusable method content and checks.

These adapters may emit events and observations but cannot claim tasks, override policy, or approve their own output.
