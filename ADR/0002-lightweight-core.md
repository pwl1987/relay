# ADR-0002：轻量模块化单体 Core

状态：**FROZEN**

使用 TypeScript/Node、PostgreSQL 持久化存储、Pi 初始 Agent Runtime、Playwright Browser Automation，以及 Git/GitHub、Docker、SSH Operator。以明确的 Port 和 Adapter 开始，优先模块化单体。

P0/P1 不要求 Kafka、Kubernetes、Qdrant、OPA、Temporal 或 Restate。只有当经过度量的负载、Recovery、租户隔离或 Policy 需求证明单体不足时，才可引入其中组件，并用新 ADR 定义迁移边界。

OPEN：具体 PostgreSQL Client/Migration Library 与部署打包方式。
