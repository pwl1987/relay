# ADR-0006: Memory, knowledge, and code intelligence

Status: **FROZEN**

These capabilities are plugins, not Core. Core stores the minimum durable facts required for recovery, policy, task state, evidence, and audit. Optional plugins may provide memory, document knowledge, or code intelligence through query/index contracts with provenance, freshness, scope, and deletion behavior.

A plugin result is evidence or context, never authority. No plugin may silently alter a task, policy, permission, or acceptance state. Start with PostgreSQL-backed metadata and ordinary search; introduce embeddings, vector stores, or code graphs only when a measured use case justifies them.

OPEN: retention, indexing cadence, and the first plugin API.
