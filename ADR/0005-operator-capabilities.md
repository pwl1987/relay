# ADR-0005：Operator 能力

状态：**FROZEN**

Operator 是窄化、经过 Policy 检查的适配器：文件系统/进程、Git、GitHub、Docker、SSH（P0）；Playwright Browser、Search/Crawler（P1）。每个 Operator 都必须声明权限、凭据、超时、输出限制、脱敏、幂等和 Audit 行为。

GitHub 写操作、Browser 副作用、远程 SSH、破坏性文件系统/数据库操作以及生产相关操作都是独立能力。必须使用最小权限、路径 Allowlist 和主机 Allowlist。Operator 只报告 Observation，不能批准自己的工作，也不能修改 Lifecycle 状态。

OPEN：凭据 Broker 实现和托管 Runner 隔离。
