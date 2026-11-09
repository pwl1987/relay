# ADR-0002: Lightweight modular-monolith core

Status: **FROZEN**

Use TypeScript/Node with PostgreSQL as the durable store, Pi as the initial agent runtime, Playwright for browser automation, Git/GitHub, Docker, and SSH for operators. Start as a modular monolith with explicit ports and adapters.

Do not require Kafka, Kubernetes, Qdrant, OPA, Temporal, or Restate for P0/P1. Add one only when measured load, recovery, tenancy, or policy requirements prove the monolith insufficient and a new ADR defines the migration boundary.

OPEN: exact PostgreSQL client/migration library and deployment packaging.
