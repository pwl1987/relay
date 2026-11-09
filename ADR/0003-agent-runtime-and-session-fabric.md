# ADR-0003：Pi first、Runtime/Model 与 Session 分界

状态：**FROZEN（边界 + P0 集成方式）**。集成方式由 OPEN 转为 ACCEPTED：RPC 子进程 + 双层隔离。依据 `p0-00/REPORT.md` §1（2026-11-09 实测，Pi 1.5.0）。

**决定**：Pi 是第一个 AgentRuntime，但 Runtime!=Model。Relay Core 管 Goal/Task/Lease/Gate/Policy；Pi 返回事件/动作提议/结果，不拥有独立工作流状态。P0 的 Session 仅保留 Run Context、Checkpoint、Handoff 和恢复引用；恢复以重建上下文为保证，非模型内部状态原样重启。

**P0 集成方式（实测裁决）**：
1. Worker 以 **RPC 子进程**模式驱动 Pi（`pi --mode rpc`），启动参数强制 `--no-builtin-tools`（或最小白名单），经扩展注入受控作用域工具（`Action Proposal → Policy → Scoped Executor` 的工具侧最小形态，实测 A2）。
2. **每个 Run 使用一次性独立 HOME**：共享 `~/.pi` 与 project trust 状态不得进入 Worker 路径；Pi 会在无 trust 决策时不加载项目级扩展（实测 A3），但被信任过的目录会持久放行，必须以一次性 HOME 隔离该风险。
3. **OS 层容器是安全边界，工具层不是**：Pi 扩展与主进程同权限（官方文档明示可读取凭据）；默认工具在同 UID 下无 FS 边界（实测 A0，模型自拒可被措辞绕过）。Worker 的 Pi 进程必须运行在容器/独立 UID + 仅挂载 Run 工作区 + cap-drop ALL + 无 docker.sock/SSH agent/宿主凭据（实测 A4）。
4. 空工具面（`--no-tools`）是结构性保证，且 RPC 事件流可被机器校验（实测 A1）；Run 级预算/超时由 Core 在 RPC 协议层实施。

ACP 是 Runtime 互操作协议（P1），MCP 是工具调用传输，不得替代授权层。ACP v2 为演进中的草案时不得无 POC 绑定；Agent-to-Agent Session Fabric 的 send/steer/spawn 为 P1 研究，不是首版多 Agent 总线。

**残余风险（转入 P0-01B 合同与验证矩阵）**：模型提供商间的注入鲁棒性差异未穷举（结构性保证不依赖模型行为）；作用域工具的对抗性变体（symlink 逃逸、TOCTOU）由 OS 层兜底。