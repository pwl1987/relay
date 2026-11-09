# ADR-0002：模块化单体与 P0 削减

状态：**FROZEN**；技术细节 OPEN。

**决定**：Relay 以 TypeScript/Node + PostgreSQL 模块化单体起步；server/worker 是逻辑边界，P0 可同进程，在证明租约/隔离需求后再拆部署。P0 的首个真实路径只有一个单仓、Pi、受限 FS/Shell/Git、状态/审批/质量证据和恢复。CLI/API 最先；Web 只做最小状态/审批。

**理由**：此前 P0 同时承诺 SSH、Docker、Browser、复杂 Session Fabric 与大量实体，难以由单人验证安全与恢复，也会增加隐藏任务调度器。

**排除**：Kubernetes、Kafka、NATS、Redis、OPA、Qdrant、Elasticsearch、Neo4j、Temporal、Restate、OpenBao。Docker 可用于启动数据库/应用，但不要求先做 Docker Agent Operator。跨仓 ChangeSet、通用 Browser/SSH/Deploy、Plugin Marketplace 属 P1+。

**代价/后续**：并行执行、多主机容错与跨仓补偿可能需要再扩；必须以容量/故障证据和新 ADR 决定。