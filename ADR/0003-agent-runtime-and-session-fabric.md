# ADR-0003: Agent runtime and Session Fabric

Status: **FROZEN**

Pi is the first runtime adapter. Session Fabric is the durable context layer around a bounded run: checkpoint, handoff, resume, trace hash, and recovery metadata. Lifecycle/Supervisor remains the only owner of scheduling and state transitions.

ACP may be supported as an interoperability adapter. It must map into the same run/session contracts and cannot introduce a parallel lifecycle. A failed or disconnected session is recoverable from persisted checkpoints; a notification is not a state transition.

OPEN: additional runtimes and exact handoff serialization.
