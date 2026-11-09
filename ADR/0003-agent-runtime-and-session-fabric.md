# ADR-0003：Pi first、Runtime/Model 与 Session 分界

状态：**FROZEN（边界）**；**OPEN（SDK/RPC 选择）**。

**决定**：Pi 是第一个 AgentRuntime，但 Runtime!=Model。Relay Core 管 Goal/Task/Lease/Gate/Policy；Pi 返回事件/动作提议/结果，不拥有独立工作流状态。P0 的 Session 仅保留 Run Context、Checkpoint、Handoff 和恢复引用；恢复以重建上下文为保证，非模型内部状态原样重启。

ACP 是 Runtime 互操作协议（P1），MCP 是工具调用传输，不得替代授权层。ACP v2 为演进中的草案时不得无 POC 绑定；Agent-to-Agent Session Fabric 的 send/steer/spawn 为 P1 研究，不是首版多 Agent 总线。

**风险**：同进程 SDK 在未隔离的默认 Shell/FS 工具下可能旁路 Policy；RPC 有进程隔离便利但并不天然等于沙箱。P0-00 对比两者的授权和恢复实测后选择。