# Relay 设计基线

状态：**FROZEN 基线，尚未开始实现**

Relay 是一个小型、可独立运行的项目自治运行时。它接收目标，将目标转化为持久化工作，通过获准的 Operator 执行受边界约束的 Agent 运行，基于证据完成验证，并在中断后恢复。ChatGPT 只是可选入口，运行时不依赖 ChatGPT。

本仓库是独立的 clean-room 设计，不包含从其他系统复制的源代码或实现文本。本仓库冻结顶层架构和首批交付边界，不冻结产品最终名称、界面、模型厂商、Provider 凭据或生产部署策略。

## 审计结论

此前方向只有在完成以下收窄后才适合冻结：

- **只保留一个控制流所有者：** Lifecycle、Task DAG 和 Supervisor 统一负责状态、调度、重试、检查点和质量门禁。
- **将 Session Fabric 定义为运行时原语：** 它负责持久化运行上下文和交接，不再成为另一套工作流引擎。
- **将 ACP、MCP、Plugin、Skill 放在不同适配边界：** 分别承担协议互操作、工具传输、扩展封装和方法内容职责。
- **让 24×7 运行有边界：** 进度预算、看门狗、检查点和进度守卫是强制能力；禁止无界 Agent 循环。
- **让人工缺席只影响局部路径：** 安全且可逆的工作可以带着已记录的假设继续；不可逆或高风险动作只阻塞自己的依赖路径。
- **保持 Core 轻量：** PostgreSQL 负责持久化；Memory、Knowledge Retrieval 和 Code Intelligence 都是带证据契约的可选插件。
- **优先模块化单体：** TypeScript/Node、PostgreSQL、Pi、Playwright、Git/GitHub、Docker 和 SSH。Kafka、Kubernetes、Qdrant、OPA、Temporal、Restate 明确延期。

## 文档

- [架构基线](ARCHITECTURE_BASELINE.md)
- [P0/P1 路线图](P0_P1_ROADMAP.md)
- [领域模型](DOMAIN_MODEL.md)
- [契约](CONTRACTS.md)
- [ADR 索引](ADR/README.md)

## 状态词汇

- **FROZEN**：实现必须遵守的边界；变更需要新增 ADR。
- **OPEN**：有意保留的未决事项；扩展实现前必须用证据决定。
- **DEFERRED**：明确排除在 P0/P1 之外，不提供兼容承诺。
