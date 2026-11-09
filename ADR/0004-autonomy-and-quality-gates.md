# ADR-0004：24×7 Safe Continuation 与证据门

状态：**FROZEN（安全语义）**；数值阈值 OPEN。

**决定**：用持久化 tick/Lease、Watchdog、Progress Guard、预算、退避和停滞熔断实现有限条件下的 24×7 持续推进。Goal/Project/Maintenance 只是不同触发策略。任务失败需先核对现实，再有界重试/重新规划；禁止无界循环及对不确定外部副作用盲重放。

D0–D4 决策等级按风险、可逆性、权限、波及面与成本判定。D2 的自动采用必须先获**有范围的授权**；D3 需要用户明确确认；D4 禁止。超时只能局部阻塞或执行原已授权的可逆 Fallback，不能给生产发布、强推、破坏数据等新增权限。Assumption Ledger 记录系统代选的依据和回滚。

Quality Gate 必须绑定具体任务/ChangeSet/提交和可信 Evidence；Reviewer 与 Coder 分离上下文，模型自报不能接受。适用门禁按风险裁剪，真实浏览器/API/目标环境观察属于必需的 Reality Check。