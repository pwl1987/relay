# 自治、24×7 与权限安全

状态：**FROZEN（规则）**；具体阈值、调度周期、监控方案 OPEN。

## 一、什么叫 24×7

**服务在可用资源和授权内持续推进 Ready Work**；不是承诺永远有进度或无须人类承担生产风险。无模型额度、无网络、服务宕机、无安全 Ready Task 时应安全暂停，保留现场并告警。进程由 OS/Docker restart policy 重启，数据库恢复后可继续；不默认用模型无限自问自答。

单一 Supervisor Tick 依次：扫描到期 Lease→恢复/核查→从依赖 DAG 选 Ready Task→检查 Policy/预算→创建有限 Run→获取 Observation/Checkpoint→核验进度→提交状态。Goal Loop、Project Loop、Maintenance Loop **是三种选题/触发策略，不是三个工作流引擎**。P0 先 Goal Loop，其他按任务/运维需求逐步接入。

## 二、Decision 等级

| 级别 | 系统行为 | 例子 |
| --- | --- | --- |
| D0 | 直接执行受限读取/局部无副作用行为 | 读取仓库、整理证据 |
| D1 | 低风险可逆动作自主选择并审计 | 临时沙箱原型 |
| D2 | 推荐默认方案，**只有既有授权显式覆盖时**才能超时执行 | 受限工作包范围内的可撤销重构 |
| D3 | 必须明确用户/授权人批准 | 额外成本、生产发布、扩权或不可逆操作 |
| D4 | 禁止，直到新授权和安全评审改变策略 | Force Push、越权读密钥、破坏数据 |

风险采用 `risk / reversibility / confidence / blast radius / cost` 加权限与目标环境判断。Agent confidence 不能覆盖 Policy 的最高等级限制。

Decision Timeout 的候选 Fallback：`AUTO_ACCEPT_RECOMMENDATION`（仅先前白名单授权内 D2）、`PROTOTYPE_FIRST`（隔离、不可合并/发布）、`CHOOSE_SAFEST`（可逆且有证据）、`DEFER_AND_CONTINUE`、`BLOCK_ONLY_THIS_PATH`。超时**永不提升权限**；可执行的不相关 Task 继续。Assumption Ledger 记录来源、证据、置信、不确定性、影响、回滚及到期复查。

## 三、失效恢复

每次尝试设置墙钟/Token/成本/失败次数/重复错误与最大返工上限，采用退避和熔断。Guard 识别：连续失败、重复错误、无 Diff/测试/决策变化、Agent/SSH/Browser 失联、CI 长期失败。推荐处置顺序：
`检查状态与副作用 → 有界重试 → 更小任务/重新规划 → 切换 Runtime/Model（若有） → 安全阻塞/升级`。

每次重试必须产生**新信息或不同策略**，否则停下；只换模型不等于解决失败。过期租约使用版本栅栏阻止旧 Worker 继续写入；外部动作返回不明先核验目标状态，不可盲目重放。断开后可能无法恢复模型内部推理，只承诺按 Checkpoint/Handoff **重建**上下文。

## 四、权限和基础设施边界

P0 对 FS/Shell/Git 等仅授权隔离工作区与明确命令；未证明真实 sandbox/OS 权限隔离前，不应运行不受信任仓库的任意脚本。网络出口、敏感文件、环境变量与系统凭据都要单独控制；**提示词及应用层 Allowlist 不能替代 OS 沙箱**。

对 GitHub/SSH/Deploy 使用执行器独占凭据、仓库/主机允许列表、短效授权、输出脱敏、审计；Agent 只提供动作意图。需要审计外部工具提供的 prompt-injection 与能力泄漏风险。不能依赖超时自动批准生产操作。

日志最小化且有保留期；Token、SSH key、连接串不写入 Evidence/Context。审计必须记载是谁、在何授权下、针对什么对象、执行结果与重放核查。时间同步、备份/恢复演练和 DB 可用性是 24×7 前提，但不提前引入重型控制面。