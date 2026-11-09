# ADR-0005: Operator capabilities

Status: **FROZEN**

Operators are narrow, policy-checked adapters: filesystem/process, Git, GitHub, Docker, SSH (P0); Playwright browser and search/crawler (P1). Each declares permissions, credentials, timeout, output limit, redaction, idempotency, and audit behavior.

GitHub write actions, browser side effects, remote SSH actions, destructive filesystem/database operations, and production-facing actions are separate capabilities. Least privilege and path/host allowlists are mandatory. Operators report observations; they cannot approve their own work or mutate lifecycle state.

OPEN: credential broker implementation and hosted runner isolation.
