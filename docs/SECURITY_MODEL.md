# Relay 安全模型、权限和故障恢复

状态：**FROZEN（防护原则和拒绝路径） / OPEN（沙箱、凭据实现与现场资源）**。与 [自治与运维](OPERATIONS.md) 互补：本文定义威胁、信任边界、控制措施和失败检查，不重新定义 Lifecycle。

## 1. 保护资产与攻击面

资产：宿主机凭据、GitHub main 历史与仓库权限、本地/VM80 其他项目目录、生产 SSH/数据库数据、用户隐私与模型 API 配额、证据完整性、Relay 自身升级机制。

不可信输入：用户自然语言（可授权但不等于工具命令）、仓库 README/代码注释、网页/搜索结果、Issue/PR 内容、模型输出、插件响应、命令 stdout/stderr。**不可信文本不得作为提升工具权限的凭证**。

主要威胁与控制：

| ID | 失败/攻击路径 | 首版控制 | 失败应如何停 |
| --- | --- | --- | --- |
| T01 Prompt Injection | README/网页命令 Agent 忽略原任务并泄露密钥 | 不可信内容标记+工具边界不依赖提示词；OS 沙箱无 secret | Policy DENIED，留 Evidence |
| T02 Shell 越权 | Pi 默认 Bash/扩展绕开 Relay Executor | 禁止默认危险工具或包装；沙箱文件/网络/进程限制 | 阻断 P0-01B |
| T03 凭据泄漏 | 日志/环境变量/Prompt 暴露 GitHub token | 执行器持有凭据，短效、最小作用域、密钥脱敏 | 停止、轮换、审计 |
| T04 误写 main | 过期 HEAD 的 Agent 覆盖新提交 | 单 Writer + expected SHA + fast-forward，禁止 force | RECONCILE/BLOCK |
| T05 跨项目污染 | 同一 VM80 多 repo 中删除/写错目录 | 单项目独立 Workspace+UID/容器/Allowlist | DENIED 并人工检查 |
| T06 重试重复副作用 | 写入成功回执丢失，重启再写 | Action Intent+幂等键+外部状态核对 | NEEDS_RECONCILE |
| T07 超时越权 | D3 无响应被降级到 D2 | 级别不可由超时降低；只继续无依赖路径 | BLOCK_ONLY_THIS_PATH |
| T08 自我升级破坏 | Relay 覆盖正在运行的自身 DB/Policy | 候选隔离+独立测试+人工 Release Gate+回滚 | 禁止直接 Promote |
| T09 资源耗尽 | Loop 无限失败/大输出/Token 激增 | wall/token/cost/attempt/output 限额+熔断 | PAUSED/BLOCKED |
| T10 伪证据 | Agent 伪造测试绿色/旧截图 | 执行器采集来源+SHA/环境/hash+Reviewer 隔离 | Gate REWORK/BLOCK |
| T11 Web 越权 | 公网暴露无认证管理 UI | 默认监听本地/私网、强认证/访问代理、CSRF/限流 | 无认证不得启用远程写 |
| T12 供应链 | 依赖插件/脚本执行远程代码 | 版本锁定、审计、沙箱与最低权限 | BLOCK 依赖升级 |

## 2. 不可绕过的信任边界

1. **模型/Agent 不可信**：只能提出动作，无任意 shell/文件系统或高权限凭据；Relay 先做 Policy、再由可信执行器执行。
2. **应用层权限不足以防所有逃逸**：如果 Shell 可以调用宿主 Docker socket、读 `~/.ssh` 或任意路径，提示词规则没有安全意义。P0-00 实测操作系统层隔离（容器/UID/mount/net namespace等）；失败则降低可执行工具集。
3. **Server 与 Worker**：Worker 需有最小 DB/文件权限，候选代码区不可直接覆盖 Relay Server 代码或数据库迁移。
4. **审核边界**：Reviewer 与 Coder 不共享同一“结论就是正确”的上下文；外部测试/系统观测为最终基础。
5. **网络边界**：本地模型 API、GitHub、远程 VM80 使用显式目的地/代理策略，默认不允许任意外发。
6. **共享宿主上的资源归属（出口约束栈；RELAY-EGRESS-ISOLATION-07）**：出口栈占用宿主共享的 docker 网络/容器与 iptables 规则面——资源创建时打归属标签 `relay.egress.owner`（iptables 注释携带 `<标记> owner=<token>`），匿名同名资源一律 fail-closed 拒绝（不复用/不覆盖/不删除，零副作用）；清理仅限本执行者创建且仍持有的资源并出具审计报告；测试使用完整独立命名空间（网络/容器/链/标记/端口全派生），与生产默认资源零交集。注意：归属标签是**运维归属标记而非安全认证**（同宿主 root 可伪造）；真正安全边界仍是 OS 层沙箱 + iptables 白名单 + 0600 持钥文件。

## 3. 权限授予与审批

授权对象应包含 `actor, action, capability, scope(paths/hosts/repos), budget, expires_at, expected_remote_state, policy_version`。D0/D1 仅在已授予范围内自动；D2 仅事先明确批准的可逆 Fallback；D3 人工确认；D4 绝不执行。Policy 必须服务端执行，不依赖 UI 隐藏按钮。所有权限拒绝、授予、变更、过期写 AuditEvent。

禁令：`git push --force`、直接删除 GitHub 历史、生产无审批发布、自动放宽沙箱/Policy、拷贝生产密钥到 Agent Context、因超时自动批准外部副作用。

## 4. 秘钥及数据治理

不把 API key、SSH 私钥、数据库密码保存到 Git、Run 文本、Evidence 截图或模型输入。建议凭据位于执行器权限域，由服务启动时读取受限 Secret；后续评估 Broker/短效 Token。日志做字段级脱敏并为每个 Artifact 设置项目范围与清理期限（具体天数 OPEN）。

证据元数据保留原始来源、采集者、SHA/环境、Hash、时间；临时工作目录按可审计的清单清理，不按“目录名像缓存”直接删除用户文件。

## 5. 恢复算法与应急止损

- Lease/Worker 死亡：标记运行不确定；检测动作日志/目标状态；能证明安全再重新派发。
- 数据库不可用：停止新的写执行，拒绝状态推进，恢复后处理 Outbox/失败 Lease。
- 模型/API 断供：预算和健康检查降级，切换 Runtime/Provider 只能按明确白名单，不能自行用更贵未授权付费能力。
- 主机资源耗尽：停止领取任务、限制并发、保留证据/审计；不能清空其他项目缓存“抢空间”。
- 权限或数据泄漏：即时暂停相关 Project，记录事件，轮换凭据，人工审计，禁用自动 Retry。
- 部署回滚：候选版本不可直接覆盖稳定版本；先备份 DB/配置及兼容迁移，失败恢复旧镜像/进程；不可逆迁移需明确审批。

## 6. P0-00 安全门

必须把 T01、T02、T04、T06、T07、T09、T10 当作可复现 Gate 测试，而不是安全说明文字。任一能越权写磁盘/密钥/远端的缺陷判 **BLOCKED**，不得以“模型一般不会这么做”绕过。