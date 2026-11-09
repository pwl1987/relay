# ADR-0003：Agent Runtime 与 Session Fabric

状态：**FROZEN**

Pi 是第一个 Runtime Adapter。Session Fabric 是围绕有边界 Run 的持久化上下文层，负责 Checkpoint、Handoff、Resume、Trace Hash 和 Recovery Metadata。Lifecycle/Supervisor 仍然是调度与状态转换的唯一所有者。

可以支持 ACP 作为互操作适配器，但必须映射到同一套 Run/Session Contract，不能引入并行 Lifecycle。Session 断开或失败后，必须能够从持久化 Checkpoint 恢复；通知不构成状态转换。

OPEN：其他 Runtime 与 Handoff 序列化格式。
