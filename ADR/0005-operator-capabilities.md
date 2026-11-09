# ADR-0005：Operator Scope 与阶段排序

状态：**FROZEN**；Credential Broker/Sandbox OPEN。

**决定**：所有外部动作均经 `Agent → Action Proposal → Policy → Scoped Executor → Observation`；Agent 不持有宽权限 GitHub/SSH/生产凭据，Operator 不推进 Lifecycle。必须有路径/主机 Allowlist、超时、预算、秘密脱敏、审计、幂等/副作用核对。

**P0**：仅受限 FS/Shell/Git、本地测试/CI、最小 GitHub API 受控读写；Playwright Test 可验证交付，不开放通用浏览能力。需要真实沙箱与隔离验证，不能只靠提示词限制。

**P1**：Playwright Browser Operator、Search/HTTP Crawler、SSH/Docker/Deploy Adapter、外部 CI Provider。P0 的 Docker 运行容器不等于已授权 Agent 操作 Docker 守护进程。

**延期**：任意主机高权限运维、自动生产部署、全能 Operator Registry。