# ADR-0004：自治、超时与质量门禁

状态：**FROZEN**

24×7 运行必须是带 Supervisor、预算、Lease、Watchdog、Checkpoint、Progress Guard、相同错误上限和升级策略的循环。禁止无界的 `while(true)` 模型循环。

Decision Timeout 只能使用已声明的 Fallback：带着 Assumption 继续、制作不合并的 Prototype、延期，或只阻塞依赖路径。高风险/不可逆动作始终需要规定的 Authority，不能由 Timeout 自动授权。

Quality Gate 依据 Evidence 和 Task 类型阈值工作。模型置信度本身不能通过门禁。只有在 Gate、Review 和升级策略允许时，较弱模型才可承担低风险工作。

OPEN：各类 Task 的默认数值阈值。
