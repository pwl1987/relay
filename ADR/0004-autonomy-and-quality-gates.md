# ADR-0004: Autonomy, timeout, and quality gates

Status: **FROZEN**

24×7 operation is a supervised, budgeted loop with leases, watchdog, checkpoint, progress guard, same-error limit, and escalation. No unbounded `while(true)` model loop is allowed.

Decision Timeout applies a declared fallback: continue with assumption, prototype without merge, defer, or block only the dependent path. High-risk/irreversible actions always require the configured authority and cannot be authorized by timeout.

Quality gates use evidence and task-class thresholds. Model confidence alone cannot pass. A weaker model may be used for low-risk work only when gates, review, and escalation policy permit it.

OPEN: default numeric thresholds by task class.
