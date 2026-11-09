# 架构基线

状态：**FROZEN**

## 产品边界

Relay 是面向项目的自治软件工作运行时。它的核心承诺是：围绕明确目标，持续产生可恢复、经过证据门禁的进展。它不是通用助手、IDE、浏览器自动化产品、向量数据库或模型训练平台。

### Core 包含

1. Goal 与 Lifecycle 状态。
2. 带有依赖、所有者、尝试次数和证据状态的 Task DAG。
3. Supervisor 与有边界的执行循环。
4. 用于可恢复运行和确定性交接的 Session Fabric。
5. Policy 评估、Decision 记录、Checkpoint、Audit Event 和 Approval Gate。
6. 面向本地进程、Git、GitHub、Browser、Search/Crawler、Docker、SSH 的窄 Operator 接口和适配器。

### Core 不包含

ChatGPT/Codex UI、模型 Provider、长期 Memory、Knowledge Index、Code Graph、领域工作流以及厂商专属协议都属于可替换集成。

## 分层与职责不重叠

```text
入口（CLI/API/ChatGPT 适配器）
  -> Lifecycle + Supervisor
      -> Task DAG + Policy/Gate
          -> Session Fabric + Run 记录
              -> Agent Runtime（Pi 适配器）
                  -> Operator（GitHub、Browser、Search、Crawler、SSH、Docker、FS）
                      -> 外部系统
```

ACP 是 Agent Runtime 互操作适配器。MCP 是工具传输适配器。Plugin 负责适配器和配置的封装。Skill 负责指令、Schema 和检查项。它们都不能拥有 Lifecycle 状态，也不能绕过 Policy Gate。

## 24×7 循环

循环是持久化的 Supervisor Tick，不是永不退出的模型会话：

1. 使用 Lease 领取一个 Ready Task；
2. 创建或恢复 Session Checkpoint；
3. 在 Policy 和预算约束下执行一个有边界的步骤；
4. 持久化输出、证据和下一步动作；
5. 检查进度和验收标准；
6. 重试、重新规划、升级模型、延期或阻塞路径。

每个 Task 都必须设置尝试次数、墙钟时间、Token/Cost 预算、相同错误次数和返工次数上限。Watchdog 负责恢复过期 Lease；Progress Guard 负责识别停滞并阻止盲目重复。

## Decision Timeout / Safe Continuation

每个 Decision 都记录风险、可逆性、过期时间、Fallback、受影响 Task 和回滚信息。超时后的处理规则：

- 低风险且可逆：采用推荐方案继续，并写入 Assumption；
- 中风险且可逆：制作 Prototype 或 Branch，不 Merge、不发布；
- 高风险或不可逆：只阻塞依赖该 Decision 的路径；
- 始终重新评估新证据是否已经消除了人工审批需求。

超时不得授权生产发布、破坏性数据操作、凭据暴露、Force Push、不可逆迁移或放宽安全策略。

## P0/P1/P2 审计

- **P0 保留：** 持久化状态、Task DAG、Supervisor、Session Fabric、Policy/Gate、Audit、Recovery、Pi Runtime 适配器、本地/Git/GitHub Operator、Safe Continuation。
- **P1 保留：** Browser/Search/Crawler/SSH/Docker Operator、模型梯度、Plugin/Skill Pack、可选 ChatGPT 适配器、Memory/Knowledge/Code Intelligence 扩展点。
- **P2 收缩：** 多 Runtime 联邦、分布式队列、向量原生 Memory、自治生产部署、复杂可视化编排和厂商专属工作流引擎延期。

本次审计补上的主要遗漏是明确的 **Progress Guard + Evidence Contract**。本次删减的主要过度设计是：不再把每种方法或能力都当作 Core 一级子系统。

## 可靠性、安全与运维

PostgreSQL 是运行时持久化状态的事实来源。Claim、Lease、状态转换和 Audit Append 使用事务。Checkpoint 应具备幂等性，并在可行时使用内容寻址。Recovery 只能从持久化状态恢复；通知本身不授予权限。

Operator 使用 Allowlist、范围受限的凭据、超时、输出限制和脱敏 Audit 记录。破坏性操作或外部副作用必须经过 Policy Decision，并在配置要求时等待人工审批。Plugin 不能自行扩大权限。ChatGPT 绑定是可选的，不能伪造 Runtime 身份。

## OPEN

- API 传输方式（HTTP、Unix Socket 或两者）；
- Pi 集成面和备用 Runtime；
- 默认保留期和脱敏策略；
- 部署打包方式和多主机拓扑；
- 各类 Task 的量化质量阈值。
