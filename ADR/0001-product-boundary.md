# ADR-0001: Product boundary

Status: **FROZEN**

Relay is an independently runnable, evidence-gated autonomy runtime for software projects. It owns goals, work, policy, execution coordination, recovery, and audit. ChatGPT is an optional client.

It does not own a general assistant UI, a model marketplace, a browser product, a vector store, or a domain-specific product workflow. Domain methods are packs consumed by the runtime.

This boundary prevents the prior design from becoming a second operating system around every tool and methodology.
