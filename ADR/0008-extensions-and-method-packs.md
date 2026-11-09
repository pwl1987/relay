# ADR-0008：Skill、Capability、Plugin 与 Method Pack

状态：**FROZEN（语义职责）**；Registry/版本包格式 **OPEN / P1**。

Skill = SOP/方法步骤和检查项；Capability = 抽象功能需求（例如 scm.read_diff）；Plugin/Adapter = 能力实现；MCP/API/CLI/Native = 调用协议/途径。每条 Operator 调用都需执行器授权，Skill 和 Plugin 均不能授予权限或修改 Lifecycle。

OpenSpec、Superpowers、BMAD、Comet 的优点以 Method Pack 引用，可选地用于 Discovery/设计/TDD/Review/Recovery，不作为嵌套 Runtime、任务调度器或强制文件目录规范。

P0 只使用明确需要的内置 Adapter/方法模板；P1 有第二 Provider/Skill 消费需求后再设计 Registry、Schema 和版本兼容。避免抽象先于使用案例。